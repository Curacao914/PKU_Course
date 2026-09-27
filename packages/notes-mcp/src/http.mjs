import { createProtocolServer } from './protocol.mjs'

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
  path: mountPath = '/mcp'
} = {}) {
  const server = createProtocolServer({ service, serverInfo, instructions, logger: log })

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

    if (method === 'OPTIONS') {
      res.writeHead(204, common)
      res.end()
      return true
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
