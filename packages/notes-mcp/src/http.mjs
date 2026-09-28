import { bindRequestLifecycle, createRequestBudget } from './budget.mjs'
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
 *
 * 请求预算（限流 / 并发 / 墙钟时间 / 查询长度）都在 budget.mjs，这里只做接线：
 *   · 响应 finish 与 close **都**归还槽位，且槽位内部保证只减一次——客户端异常断开
 *     不再永久占住并发名额（以前只挂 finish，漏满之后接口对所有人 503，只能重启）；
 *   · 客户端断开或超出时间预算 → abort 取消信号，检索真的停下来，而不是白算完；
 *   · 超时回 504（JSON-RPC -32001），不让连接挂到后台工作自己跑完。
 * 站点搜索 /api/search 传的是**同一个 budget 实例**：两个入口的账合在一起算。
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
  maxConcurrent = 8,
  /**
   * 与站点搜索共用的预算实例。传进来就是"共用"：/api/search 与 /mcp 的限流、并发、
   * 超时、查询长度都算在同一本账上（站点进程就是这么传的）。传了它，上面那几个
   * 单项参数就不再起作用——账只有一本，避免出现"看起来配了两个上限"的假象。
   */
  budget: sharedBudget = null,
  // 可信代理名单：只有直连方在这个名单里时才会读 X-Forwarded-For（默认谁都不信）
  trustedProxies = [],
  clientIpHeader = '',
  timeoutMs,
  maxQueryChars
} = {}) {
  const budget = sharedBudget || createRequestBudget({
    windowMs: rateLimit?.windowMs,
    max: rateLimit?.max,
    maxConcurrent,
    timeoutMs,
    maxQueryChars,
    trustedProxies,
    clientIpHeader
  })
  const server = createProtocolServer({
    service,
    serverInfo,
    instructions,
    logger: log,
    limits: { maxQueryChars: budget.limits.maxQueryChars }
  })
  const origins = new Set(allowedOrigins.map(item => String(item).toLowerCase()))
  const hosts = new Set(allowedHosts.map(item => String(item).toLowerCase()))

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

    /**
     * 限流与并发闸门：公开只读接口也会被脚本刷，限制成本极低，收益是别被打爆。
     *
     * 归还挂在 bindRequestLifecycle 上：finish（正常结束）与 close（客户端断开、
     * 代理超时、连接被重置）都会归还，槽位内部保证只减一次。
     */
    let slot = null
    let lifecycle = null
    if (method !== 'GET' && method !== 'DELETE') {
      slot = budget.acquire({ key: budget.addressOf(req), label: 'mcp' })
      if (!slot.ok) {
        res.writeHead(slot.status, {
          ...common,
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(slot.retryAfter)
        })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: slot.message } }))
        return true
      }
      lifecycle = bindRequestLifecycle(req, res, slot)
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
      // 客户端中途断开 / 读流出错：对端已经不在了，写什么都没有意义，
      // 更不该把它当成"请求体超限"——那是两种完全不同的事故。
      if (!(error instanceof Error && error.code === 'BODY_TOO_LARGE') || !lifecycle.canWrite()) return true
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

    // 取消信号一直传到检索层：客户端一走（或超时），后台的活就该停，而不是白算完
    const work = server.handleMessage(message, { signal: slot?.signal })
    let response
    try {
      if (lifecycle) {
        const outcome = await lifecycle.race(work)
        if (outcome.kind === 'gone') return true
        if (outcome.kind === 'timeout') {
          log(`[notes-mcp] 超出时间预算 ${budget.limits.timeoutMs}ms：已中止后台检索并回 504`)
          if (!lifecycle.canWrite()) return true
          const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32001,
              message: `检索超时（超过 ${budget.limits.timeoutMs}ms）：已中止本次检索。请缩小范围后重试（例如指定 course，或换更具体的词）。`
            }
          })
          res.writeHead(504, {
            ...common,
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            'retry-after': '1'
          })
          res.end(payload)
          return true
        }
        response = outcome.result
      } else {
        response = await work
      }
    } catch (error) {
      log(`[notes-mcp] 处理消息失败：${error instanceof Error ? error.message : String(error)}`)
      if (lifecycle && !lifecycle.canWrite()) return true
      res.writeHead(500, { ...common, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '服务器内部错误' } }))
      return true
    }

    // 客户端已经走了（连接被重置/被取消）：结果没人要，也不必再写
    if (lifecycle && !lifecycle.canWrite()) return true

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

/**
 * 读取请求体。
 *
 * 三种结束方式要分开：超限（回 413）、客户端断开 / 读流出错（对端没了，不写响应）、
 * 正常读完。以前把"断开"和"超限"混成同一个 reject，断开的客户端会收到一个
 * 莫名其妙的 413，而服务端还以为自己拒绝了一次超限请求。
 */
function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBodyBytes) {
        // 不再读下去，但也不在这里 destroy：先把错误响应发完再断
        const error = new Error(`请求体超过 ${maxBodyBytes} 字节`)
        error.code = 'BODY_TOO_LARGE'
        finish(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')))
    req.on('error', error => finish(error))
    req.on('aborted', () => finish(new Error('客户端中途断开')))
    // close 在请求体完整收到之后也会触发一次：complete 为真就当成正常结束
    req.on('close', () => {
      if (req.complete) finish(null, Buffer.concat(chunks).toString('utf8'))
      else finish(new Error('客户端中途断开'))
    })
  })
}
