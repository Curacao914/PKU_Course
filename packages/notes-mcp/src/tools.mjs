import { renderCourse, renderCourses, renderNote, renderSearch, renderTerms } from './render.mjs'

/**
 * 工具清单。
 *
 * 每个工具都对应"渐进式披露"的一层，description 里明确写出**什么时候该用下一层**——
 * 模型选工具靠的就是这句话。返回一律是紧凑文本（见 render.mjs）。
 *
 * inputSchema 都会放进 tools/list，客户端可能拿它做校验，所以字段说明也要当文档写。
 */

export const TOOL_DEFINITIONS = [
  {
    name: 'list_courses',
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
    title: '跨课次检索（索引 + 可选正文）',
    description:
      '跨课程、跨课次检索：命中课程名、标题、小节标题、theme、keywords、概念、法条、案例、摘要；' +
      'includeBody=true 时再扫正文。返回命中的片段与定位（哪一节），不返回全文——' +
      '只有确定要看细节时才用 get_note 读那一节。默认只查索引（快、省 token）；' +
      '问"正文里讲过但没进关键词的东西"时再打开 includeBody。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, description: '检索词，中文关键词即可（子串匹配，不分大小写）' },
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
  }
]

export function toolDefinitions() {
  return TOOL_DEFINITIONS.map(({ run, ...definition }) => definition)
}

export function findTool(name) {
  return TOOL_DEFINITIONS.find(tool => tool.name === name) || null
}
