import { SUPPORTED_PROTOCOL_VERSIONS, createProtocolServer } from './protocol.mjs'

/**
 * Streamable HTTP 传输：把同一个协议服务器挂到 `POST /mcp` 上。
 *
 * 为什么要有它：stdio 版必须由客户端在本机拉起 Node 进程——"长期在线、脱离用户电脑、
 * ChatGPT/Claude 网页版直接连"就只能靠 HTTP。两种传输共用同一套 service 与 protocol，
 * 工具行为不会出现两套。
 *
 * 实现取舍（都写在规范允许的范围内）：
 *   - **不用会话**：服务器无状态，任何一次 POST 都自带完整 JSON-RPC。规范允许不返回
 *     Mcp-Session-Id；这样客户端重连、多实例、重启都不需要重新握手。
 *   - **只回 application/json**：POST 的响应可以是 JSON，也可以是 SSE；JSON 对
 *     CDN/nginx/Cloudflare 最友好（SSE 容易被中间层缓冲）。我们的工具都是请求-响应式，
 *     没有服务端主动推送，用不到 SSE。
 *   - GET 返回 405：规范允许服务器不提供服务端 SSE 流。DELETE 返回 204（无状态，无需终止）。
 *   - 通知（没有 id 的消息）按规范回 202 Accepted、无响应体。
 */
export function createMcpHttpHandler({
  service,
  serverInfo,
  instructions,
  log = () => {},
  maxBodyBytes = 1_000_000,
  path: mountPath = '/mcp',
  // 安全边界（都是"存在才校验"，不打断正常客户端）：
  //   allowedOrigins  浏览器发来的 Origin 必须在这个名单里（防跨站调用）
  //   allowedHosts    Host 头必须在这个名单里（防 DNS rebinding）
  //   rateLimit       每 IP 每窗口的请求上限；maxConcurrent 同时处理的请求数上限
  allowedOrigins = [],
  allowedHosts = [],
  rateLimit = { windowMs: 60_000, max: 120 },
  maxConcurrent = 8
} = {}) {
  const server = createProtocolServer({ service, serverInfo, instructions, logger: log })
  const origins = new Set(allowedOrigins.map(item => String(item).toLowerCase()))
  const hosts = new Set(allowedHosts.map(item => String(item).toLowerCase()))
  const buckets = new Map()
  let inFlight = 0

  /** 轻量限流：内存里的滑动窗口。公开只读接口也会被脚本刷——限制成本极低，收益是别被打爆。 */
  function allow(ip, now = Date.now()) {
    if (!rateLimit || !rateLimit.max) return true
    const windowMs = Number(rateLimit.windowMs) || 60_000
    const entry = buckets.get(ip) || { start: now, count: 0 }
    if (now - entry.start >= windowMs) { entry.start = now; entry.count = 0 }
    entry.count += 1
    buckets.set(ip, entry)
    // 顺手清理过期桶，避免长期运行后 Map 无限增长
    if (buckets.size > 5000) {
      for (const [key, value] of buckets) if (now - value.start >= windowMs) buckets.delete(key)
    }
    return entry.count <= Number(rateLimit.max)
  }

  return async function handleMcpHttp(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    const common = {
      'cache-control': 'no-store',
      // 公开只读内容：允许任意来源的 MCP 客户端直连
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization',
      'access-control-expose-headers': 'mcp-protocol-version'
    }

    // Origin 只在校验名单非空、且客户端**确实带了** Origin 时检查：
    // 无 Origin 的 CLI / ChatGPT / Inspector 客户端照常使用（它们不是浏览器，没有 CSRF 面）。
    const origin = String(req.headers.origin || '').trim().toLowerCase()
    if (origins.size && origin && !origins.has(origin)) {
      res.writeHead(403, { ...common, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '来源不被允许' } }))
      return true
    }
    // Host：防 DNS rebinding（把域名解析到本机，再从浏览器里打我们的本地端口）。
    // 比对时去掉端口：同一个名字在不同部署里端口不同（3000/3100/3101），
    // 端口不该影响"这是不是我们的域名"这个判断。
    const host = String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '')
    if (hosts.size && host && !hosts.has(host)) {
      res.writeHead(403, { ...common, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Host 不被允许' } }))
      return true
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, common)
      res.end()
      return true
    }

    // 限流与并发闸门：公开只读接口也会被脚本刷，限制成本极低，收益是别被打爆。
    // 计数在响应 finish 时归还（POST 分支有多个 return 出口，逐处减容易漏）。
    if (method !== 'GET' && method !== 'DELETE') {
      const ip = String(req.socket?.remoteAddress || 'unknown')
      if (!allow(ip)) {
        res.writeHead(429, { ...common, 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '请求过于频繁，请稍后再试' } }))
        return true
      }
      if (inFlight >= maxConcurrent) {
        res.writeHead(503, { ...common, 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '并发请求过多，请稍后再试' } }))
        return true
      }
      inFlight += 1
      res.once('finish', () => { inFlight = Math.max(0, inFlight - 1) })
    }

    if (method === 'GET') {
      // 没有服务端主动推送：明确回 405，而不是挂着一个永远不说话的 SSE 连接
      res.writeHead(405, { ...common, 'content-type': 'application/json; charset=utf-8', allow: 'POST, DELETE, OPTIONS' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: '这个服务器不提供服务端 SSE 流；请用 POST 发送 JSON-RPC。' }
      }))
      return true
    }

    if (method === 'DELETE') {
      // 无状态服务器：没有会话可终止。按规范回 204 即可。
      res.writeHead(204, common)
      res.end()
      return true
    }

    if (method !== 'POST') {
      res.writeHead(405, { ...common, allow: 'POST, DELETE, OPTIONS' })
      res.end()
      return true
    }

    /**
     * 协议版本头：2025-06-18 起，客户端在 initialize 之后的每个请求都要带
     * mcp-protocol-version；服务器收到**不支持**的版本必须回 400，而不是硬着头皮解析。
     * 不带这个头时按规范当 2025-03-26 处理（老客户端没有这个头），继续走。
     */
    const declaredVersion = String(req.headers['mcp-protocol-version'] || '').trim()
    if (declaredVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(declaredVersion)) {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `不支持的协议版本 ${declaredVersion}；本服务器支持：${SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}`
        }
      })
      res.writeHead(400, {
        ...common,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload)
      })
      res.end(payload)
      return true
    }

    let raw
    try {
      raw = await readBody(req, maxBodyBytes)
    } catch (error) {
      // 先把 413 发出去，再断开——顺序反了客户端只会看到 socket hang up
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: error instanceof Error ? error.message : String(error) }
      })
      res.writeHead(413, {
        ...common,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        connection: 'close'
      })
      res.end(payload)
      res.once('finish', () => req.destroy?.())
      return true
    }

    let message
    try {
      message = JSON.parse(raw)
    } catch {
      res.writeHead(400, { ...common, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }))
      return true
    }

    // 通知（例如 notifications/initialized）：不产生响应体
    const isNotification = Array.isArray(message)
      ? message.every(item => item && item.id === undefined)
      : Boolean(message) && message.id === undefined

    let response
    try {
      response = await server.handleMessage(message)
    } catch (error) {
      log(`[notes-mcp] 处理消息失败：${error instanceof Error ? error.message : String(error)}`)
      res.writeHead(500, { ...common, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '服务器内部错误' } }))
      return true
    }

    if (!response && isNotification) {
      res.writeHead(202, common)
      res.end()
      return true
    }

    const payload = JSON.stringify(response ?? { jsonrpc: '2.0', id: null, result: {} })
    res.writeHead(200, {
      ...common,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      // 客户端按规范会看这个头做版本协商
      'mcp-protocol-version': response?.result?.protocolVersion || '2025-06-18'
    })
    res.end(payload)
    return true
  }
}

/** 读取请求体：超限直接断开，避免一个坏客户端把内存吃光。 */
function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBodyBytes) {
        // 不再读下去，但也不在这里 destroy：先把错误响应发完再断
        reject(new Error(`请求体超过 ${maxBodyBytes} 字节`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
