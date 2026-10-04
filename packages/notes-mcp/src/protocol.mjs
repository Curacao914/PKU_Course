import { DEFAULT_MAX_QUERY_CHARS, queryLengthProblem } from './budget.mjs'
import { CancelledError, ProtocolError, ResourceNotFoundError, ToolError } from './errors.mjs'
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
 *
 * 两件与"请求预算"有关的事也放在这一层，因为两个传输（stdio / HTTP）都要一致：
 *   · limits.maxQueryChars —— 查询串长度上限。超长查询（有人拿整篇文章来搜）会炸出
 *     成千上万个 n-gram，是纯 CPU 成本，入口就该挡住并告诉调用方上限；
 *   · context.signal —— 取消信号。HTTP 层客户端断开或超时时 abort 它，工具把它透传给
 *     service，检索在课次之间退出。stdio 没有取消语义，传空对象即可。
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
  '这是北大法学课程笔记的只读检索服务。单课笔记是事实源；一页纸、知识地图、索引和专题类内容用于压缩、导航与复习，发生冲突时回到单课笔记核实。',
  '请按问题走最短路径，不要机械地每次从第一层开始，也不要一次拉整门课全文：',
  '1) 不知道有哪些课或课程名不确定 → list_courses；用户已经点名课程时跳过。',
  '2) 已知课程 → get_course(course)；它同时返回课次摘要和当前专题。若问题是阶段/专题复习，优先把 topics[].fetchId 交给 fetch 读专题 Markdown；若要核实具体论证，再回原笔记。只有需要课次目录时才 includeOutline。',
  '3) 想一次看清某课有哪些概念/法条/案例 → list_terms(course)，比逐个关键词搜索更省。',
  '4) 跨课次定位某概念、法条、案例或一句话 → search_notes(query)；默认自动先查索引，只有确需穷尽正文时才 includeBody=true。',
  '5) 需要具体论证或原文依据 → get_note；优先传 section 只取命中小节，只有问题确实覆盖整节时才读取整篇或提高 maxChars。',
  '6) 已知具体课次时可直接 get_note(course+lesson)，不必先 list_courses/get_course。',
  '单节快速复习优先利用一页纸；中观/宏观复习优先利用 theme、摘要、list_terms、知识地图或专题类视图缩小范围，再回 get_note(section) 核实。',
  '回答跨课次、跨课程问题时标明课程、课次以及能确定的小节；返回里有 slug/canonical URL 时保留可点击出处。',
  'OpenAI 标准知识接口 search(query) / fetch(id) 与专用检索共用同一召回逻辑；fetch 也接受 get_course 返回的 topic:<id>。能用课程专用工具时优先使用上面的分层路径。',
  '支持 resources 的客户端可直接读 notes://courses、notes://course/<课程名>、notes://terms/<课程名>、notes://note/<slug>。',
  '当前内容按账号私有；不要访问公开 llms.txt 或静态 Markdown 作为旁路。需要课次、专题或出处时，继续使用本 MCP 返回的课程、topic、slug、section 与 fetchId。'
].join('\n')

const NOTIFICATION = Symbol('notification')

export function createProtocolServer({ service, serverInfo = SERVER_INFO, instructions = INSTRUCTIONS, logger = () => {}, limits = {} } = {}) {
  if (!service) throw new Error('createProtocolServer 需要 service')
  const maxQueryChars = Number(limits.maxQueryChars) > 0 ? Math.trunc(Number(limits.maxQueryChars)) : DEFAULT_MAX_QUERY_CHARS

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

  async function callTool(params, context = {}) {
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
    /**
     * 长度预算：与 /api/search 共用同一个上限（都来自同一个 budget 实例）。
     * 走 isError:true 而不是协议错误——这是"参数太长"，模型改小就能重试。
     */
    if (typeof checked.value.query === 'string') {
      const problem = queryLengthProblem(checked.value.query, maxQueryChars)
      if (problem) return { content: [{ type: 'text', text: `参数不合法：${problem}` }], isError: true }
    }
    try {
      const result = await tool.run(service, checked.value, context)
      // 工具可以返回"已经成形的结果"（标准 search/fetch 需要同时给出 content 与
      // structuredContent），其余工具返回纯文本即可。
      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return { ...result, isError: false }
      }
      return { content: [{ type: 'text', text: result }], isError: false }
    } catch (error) {
      if (error instanceof ToolError) return { content: [{ type: 'text', text: error.message }], isError: true }
      throw error
    }
  }

  async function readResource(params, context = {}) {
    const uri = typeof params?.uri === 'string' ? params.uri.trim() : ''
    if (!uri) throw new ProtocolError(-32602, 'resources/read 缺少 uri')
    return { contents: [await service.readResource(uri, context)] }
  }

  async function dispatch(method, params, context = {}) {
    switch (method) {
      case 'initialize':
        return initializeResult(params)
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: toolDefinitions() }
      case 'tools/call':
        return callTool(params, context)
      case 'resources/list':
        return { resources: await service.listResources(context) }
      case 'resources/templates/list':
        return { resourceTemplates: service.resourceTemplates() }
      case 'resources/read':
        return readResource(params, context)
      default:
        // 通知没有 id，回不了错误：认识的静默处理，不认识的直接忽略（规范如此）
        if (method.startsWith('notifications/')) return NOTIFICATION
        throw new ProtocolError(-32601, `未知方法：${method}`, { method })
    }
  }

  async function handleMessage(message, context = {}) {
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
      const result = await dispatch(method, params, context)
      if (result === NOTIFICATION) return null
      return hasId ? ok(id, result) : null
    } catch (error) {
      if (!hasId) {
        logger(`[notes-mcp] 通知 ${method} 处理失败（无 id，无法回报）：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      // 取消（客户端断开/超时）走实现定义的服务端错误码 -32001：客户端据此知道
      // "不是我的请求写错了，也不是服务器崩了"，重试原样发一次即可
      if (error instanceof CancelledError) return fail(id, -32001, error.message)
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
