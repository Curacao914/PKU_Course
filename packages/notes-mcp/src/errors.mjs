/**
 * 三类错误分开，是因为它们在 MCP 里要走不同的出口（见 docs/12）：
 *
 *   ToolError             → tools/call 的 isError:true 文本结果，模型读了能自己改参数重试；
 *   ProtocolError         → JSON-RPC error 对象，表示请求结构本身不对（未知工具、参数不是对象）；
 *   ResourceNotFoundError → resources/read 的 -32002，规范里为「资源不存在」留的码。
 *
 * 混成一个 Error 的后果是：模型把「课程名打错了」当成协议故障，或者客户端把
 * 「参数缺了」当成服务崩溃——两者都不该发生。
 */

export class ToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolError'
  }
}

export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/**
 * 请求被取消（客户端断开，或超出墙钟预算）。
 *
 * 单独一类的原因：它既不是"参数写错了"（ToolError，模型能改），也不是"服务崩了"
 * （-32603）。HTTP 层用它决定回什么码（超时回 504），以及"客户端已经走了就别再写响应"。
 */
export class CancelledError extends Error {
  constructor(message = '请求已取消（客户端断开或超出时间预算）。') {
    super(message)
    this.name = 'CancelledError'
  }
}

export class ResourceNotFoundError extends Error {
  constructor(uri, message) {
    super(message || `找不到资源：${uri}`)
    this.name = 'ResourceNotFoundError'
    this.uri = uri
  }
}
