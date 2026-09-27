import { renderCourse, renderCourses, renderNote, renderSearch, renderTerms } from './render.mjs'

/**
 * 工具清单。
 *
 * 每个工具都对应"渐进式披露"的一层，description 里明确写出**什么时候该用下一层**——
 * 模型选工具靠的就是这句话。返回一律是紧凑文本（见 render.mjs）。
 *
 * inputSchema 都会放进 tools/list，客户端可能拿它做校验，所以字段说明也要当文档写。
 */

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
})

/** 只读工具的统一标注：这个服务器不提供任何修改/删除能力（MCP 与 OpenAI 都要求声明）。 */
function readOnly(definition) {
  return { annotations: { ...READ_ONLY }, ...definition, annotations: { ...READ_ONLY } }
}

export const TOOL_DEFINITIONS = [
  {
    name: 'list_courses',
    annotations: READ_ONLY,
    title: '课程列表（第一层）',
    description:
      '第一层：列出所有课程及其课次数量、最新课次时间、主题（theme）与关键词（keywords）汇总。' +
      '回答"我有哪些课 / 某门课讲到哪了"时先调用它；锁定课程后再用 get_course 看课次，不要一上来就读全文。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选：按课程名或教师名过滤（子串匹配）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: '最多返回多少门课程，默认 50' }
      }
    },
    run: (service, args) => service.listCourses(args).then(renderCourses)
  },
  {
    name: 'get_course',
    annotations: READ_ONLY,
    title: '某门课的课次清单（第二层）',
    description:
      '第二层：给一门课，返回每一节的 lessonTitle、发布时间、阅读时长、theme、keywords 与摘要（不含正文）。' +
      '用来决定"要不要读某一节"；需要正文时再用 get_note，需要跨课次找某个概念时用 search_notes。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        course: { type: 'string', minLength: 1, description: '课程名，如"国际法学"；可用部分名称，歧义时会返回候选' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: '最多返回多少节，默认 100' },
        order: { type: 'string', enum: ['asc', 'desc'], default: 'asc', description: '按发布时间排序，asc=从早到晚（默认），desc=最近优先' },
        includeOutline: { type: 'boolean', default: false, description: '是否带上每节的小节标题（便于之后按 section 取正文）' }
      },
      required: ['course']
    },
    run: (service, args) => service.getCourse(args).then(renderCourse)
  },
  {
    name: 'search_notes',
    annotations: READ_ONLY,
    title: '跨课次检索（索引 + 可选正文）',
    description:
      '跨课程、跨课次检索：命中课程名、标题、小节标题、theme、keywords、概念、法条、案例、摘要；' +
      'includeBody=true 时再扫正文。返回命中的片段与定位（哪一节），不返回全文——' +
      '只有确定要看细节时才用 get_note 读那一节。' +
      '查询可以是术语，也可以是**一整句话**或几个词（"交易成本 资产专用性""为什么企业会存在"）——' +
      '会先去掉疑问词与虚词再切词，命中按"词有多稀有"加权，专名比泛词更管用；' +
      '一个词写错（主义↔主意）时会在语料里找近似词并在结果里说明。' +
      '默认只查索引（快、省 token）；索引一条都没命中时会自动再扫一遍正文，并在结果里标出 bodyScanned。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, description: '检索词或一句话（可分多次给词，如"交易成本 资产专用性"；疑问词与"的/和"这类虚词会被自动去掉）' },
        course: { type: 'string', description: '可选：只在这一门课里检索' },
        includeBody: { type: 'boolean', default: false, description: '是否连正文一起检索；远程数据源会逐篇下载 Markdown，本地发布库免费' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 8, description: '最多返回多少条命中，默认 8' }
      },
      required: ['query']
    },
    run: (service, args) => service.searchNotes(args).then(renderSearch)
  },
  {
    name: 'get_note',
    annotations: READ_ONLY,
    title: '读笔记正文（第三层）',
    description:
      '第三层：按 slug（或 course + lesson）取整篇 Markdown。默认只返回前 12000 字，避免把上下文灌满；' +
      '用 section="小节标题" 只取某一节，用 maxChars 调整上限（最大 60000）。' +
      '返回内容自带小节清单，截断时会提示还能怎么取。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: '笔记 slug，形如 notes/课程/课次（list_courses / get_course / search_notes 都会给）' },
        course: { type: 'string', description: '课程名；与 lesson 一起使用时可以替代 slug' },
        lesson: { type: 'string', description: '课次标题，如"第一课 国家责任的构成"' },
        section: { type: 'string', description: '可选：只取某一节（按小节标题或标题 id 匹配）' },
        maxChars: { type: 'integer', minimum: 200, maximum: 60000, description: '返回正文的字符上限，默认 12000' }
      }
    },
    run: (service, args) => service.getNote(args).then(renderNote)
  },
  {
    name: 'list_terms',
    annotations: READ_ONLY,
    title: '某门课的概念/法条/案例清单',
    description:
      '给一门课，按出现次数列出概念、法条、案例、关键词，并给出落点（课次 + 小节锚点）。' +
      '复习型问题（"这门课讲过哪些案例/法条"）用它能一次看全，不必逐节读全文。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        course: { type: 'string', minLength: 1, description: '课程名' },
        kind: { type: 'string', enum: ['all', 'concepts', 'statutes', 'cases', 'keywords'], default: 'all', description: '只看某一类时指定，默认全部' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: '每类最多返回多少个词，默认 50' }
      },
      required: ['course']
    },
    run: (service, args) => service.listTerms(args).then(renderTerms)
  },
  {
    name: 'search',
    title: '知识检索（OpenAI 标准）',
    description:
      'OpenAI 标准知识检索接口：输入一个 query，返回 { results: [{ id, title, url }] }。' +
      '与 course 专用的 search_notes 是同一套检索（多词、自然语言问句、错别字都能用），只是输出格式不同——' +
      '需要按课程/课次分层浏览时用 list_courses / get_course，标准接口给不支持自定义工具的客户端用。' +
      '命中定位到小节时，id 形如 slug#小节，可直接传给 fetch 只取那一节；否则 id 是整篇 slug。',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, description: '检索词或一句话；多词用空格分开即可' }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'url'],
            properties: {
              id: { type: 'string', description: '稳定标识，可直接传给 fetch；形如 slug 或 slug#小节' },
              title: { type: 'string' },
              url: { type: 'string', description: '用户可直接打开的 canonical URL' }
            }
          }
        }
      }
    },
    // OpenAI 规范要求：**恰好一个** type=text 的 content，其 text 是 JSON 字符串
    run: (service, args) => service.searchKnowledge({ query: args.query, limit: args.limit }).then(payload => ({
      content: [{ type: 'text', text: JSON.stringify({ results: payload.results }) }],
      structuredContent: { results: payload.results }
    }))
  },
  {
    name: 'fetch',
    title: '取文档（OpenAI 标准）',
    description:
      'OpenAI 标准取文档接口：输入 search 返回的 id，返回 { id, title, text, url, metadata }。' +
      'id 也支持 "slug#小节标题" 的形式，只取那一节——比整篇更省上下文。',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, description: '来自 search 的 results[].id（笔记 slug，或 slug#小节）' }
      },
      required: ['id']
    },
    outputSchema: {
      type: 'object',
      required: ['id', 'title', 'text', 'url'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        metadata: { type: 'object' }
      }
    },
    run: (service, args) => service.fetchDocument({ id: args.id }).then(document => ({
      content: [{ type: 'text', text: JSON.stringify(document) }],
      structuredContent: document
    }))
  }
].map(readOnly)

export function toolDefinitions() {
  return TOOL_DEFINITIONS.map(({ run, ...definition }) => definition)
}

export function findTool(name) {
  return TOOL_DEFINITIONS.find(tool => tool.name === name) || null
}
