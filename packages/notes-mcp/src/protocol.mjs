import { ProtocolError, ResourceNotFoundError, ToolError } from './errors.mjs'
import { findTool, toolDefinitions } from './tools.mjs'
import { validateArguments } from './validate.mjs'

/**
 * MCP 的 JSON-RPC 层（初始化那套生命周期，即规范里的 "initialization-based versions"）。
 *
 * 支持协议版本：2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05。
 * 没有实现 2026-07-28 起的"无 initialize、元数据放 _meta"的新纪元：那种客户端会先用
 * server/discover 探测，本服务器对它回 -32601（未知方法），客户端按规范回落到
 * initialize——这正是规范为老服务器留的路（见 docs/12 §2）。所以不装懂新纪元反而更稳。
 *
 * 事件循环里不做并发：stdio 是单连接，顺序处理既能保证响应顺序，也让测试可复现。
 */

export const SERVER_INFO = {
  name: 'course-notes',
  title: '课程笔记（course.law-tech.dev）',
  version: '0.1.0'
}

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const PREFERRED_PROTOCOL_VERSION = '2025-11-25'

/** 客户端会把这段 instructions 放进系统提示——分层顺序写在这里最省事。 */
export const INSTRUCTIONS = [
  '这是北大法学课程笔记的检索服务，数据来自 course.law-tech.dev。请按层取用，不要一次拉全文：',
  '1) list_courses —— 先看有哪些课（课次数、最新时间、theme、keywords）；',
  '2) get_course(course) —— 锁定课程后看每一节的 theme/keywords/摘要，决定读哪一节；',
  '3) search_notes(query, includeBody?) —— 跨课程/跨课次找某个概念、法条、案例时用，返回片段与定位；',
  '4) get_note(slug, section?, maxChars?) —— 只在这一步读正文，优先带 section 只读相关小节。',
  '支持 resources 的客户端也可以直接读 notes://courses、notes://course/<课程名>、notes://note/<slug>。'
].join('\n')

const NOTIFICATION = Symbol('notification')

export function createProtocolServer({ service, serverInfo = SERVER_INFO, instructions = INSTRUCTIONS, logger = () => {} } = {}) {
  if (!service) throw new Error('createProtocolServer 需要 service')

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message, data) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  })

  function initializeResult(params) {
    const requested = String(params?.protocolVersion ?? '').trim()
    return {
      // 规范：支持客户端请求的版本就必须原样回；不支持则回自己最新的（客户端不支持就断开）
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PREFERRED_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        resources: {}
      },
      serverInfo,
      instructions
    }
  }

  async function callTool(params) {
    const name = typeof params?.name === 'string' ? params.name.trim() : ''
    if (!name) throw new ProtocolError(-32602, 'tools/call 缺少 name')
    const tool = findTool(name)
    // 未知工具按规范算协议错误（例子里就是 -32602 "Unknown tool: …"）
    if (!tool) throw new ProtocolError(-32602, `Unknown tool: ${name}`)
    const rawArguments = params.arguments === undefined || params.arguments === null ? {} : params.arguments
    if (typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
      throw new ProtocolError(-32602, 'tools/call 的 arguments 必须是对象')
    }
    const checked = validateArguments(tool.inputSchema, rawArguments)
    if (!checked.ok) {
      // 参数问题走 isError:true：规范希望把这类错误喂给模型，让它改参数重试
      return { content: [{ type: 'text', text: `参数不合法：${checked.errors.join('；')}` }], isError: true }
    }
    try {
      const text = await tool.run(service, checked.value)
      return { content: [{ type: 'text', text }], isError: false }
    } catch (error) {
      if (error instanceof ToolError) return { content: [{ type: 'text', text: error.message }], isError: true }
      throw error
    }
  }

  async function readResource(params) {
    const uri = typeof params?.uri === 'string' ? params.uri.trim() : ''
    if (!uri) throw new ProtocolError(-32602, 'resources/read 缺少 uri')
    return { contents: [await service.readResource(uri)] }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return initializeResult(params)
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: toolDefinitions() }
      case 'tools/call':
        return callTool(params)
      case 'resources/list':
        return { resources: await service.listResources() }
      case 'resources/templates/list':
        return { resourceTemplates: service.resourceTemplates() }
      case 'resources/read':
        return readResource(params)
      default:
        // 通知没有 id，回不了错误：认识的静默处理，不认识的直接忽略（规范如此）
        if (method.startsWith('notifications/')) return NOTIFICATION
        throw new ProtocolError(-32601, `未知方法：${method}`, { method })
    }
  }

  async function handleMessage(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      // MCP 不支持 JSON-RPC 批量（batch）：数组一律按非法请求处理
      return fail(null, -32600, Array.isArray(message) ? 'MCP 不支持批量请求' : '请求必须是 JSON-RPC 对象')
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null && message.id !== undefined
    const id = hasId ? message.id : null
    if (message.jsonrpc !== '2.0') {
      return hasId ? fail(id, -32600, 'jsonrpc 必须是 "2.0"') : null
    }
    const method = typeof message.method === 'string' ? message.method : ''
    if (!method) return hasId ? fail(id, -32600, '缺少 method 字段') : null
    const params = message.params && typeof message.params === 'object' ? message.params : {}

    try {
      const result = await dispatch(method, params)
      if (result === NOTIFICATION) return null
      return hasId ? ok(id, result) : null
    } catch (error) {
      if (!hasId) {
        logger(`[notes-mcp] 通知 ${method} 处理失败（无 id，无法回报）：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      if (error instanceof ProtocolError) return fail(id, error.code, error.message, error.data)
      if (error instanceof ResourceNotFoundError) return fail(id, -32002, error.message, { uri: error.uri })
      if (error instanceof ToolError) return fail(id, -32602, error.message)
      const reason = error instanceof Error ? error.message : String(error)
      logger(`[notes-mcp] ${method} 内部错误：${reason}`)
      return fail(id, -32603, `内部错误：${reason}`)
    }
  }

  return { handleMessage, toolDefinitions }
}
