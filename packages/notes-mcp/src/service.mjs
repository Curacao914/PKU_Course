import { ResourceNotFoundError, ToolError } from './errors.mjs'
import { clip, extractHeadings, findSection, lessonDateOf, splitSections } from './records.mjs'
import { searchRecords } from './search.mjs'
import { COURSES_URI, courseUri, noteUri, parseResourceUri, termsUri } from './uris.mjs'

/**
 * 分层查询的全部逻辑。
 *
 * 设计原则只有一条：**每一层只回它该回的粒度**。
 *   list_courses → 课程名 + 课次数 + 最新时间 + theme/keywords 汇总
 *   get_course   → 该课每节的标题/时间/时长/theme/keywords/摘要（不含正文）
 *   search_notes → 跨课次命中的片段与位置（定位到小节）
 *   get_note     → 到这一步才给正文，且可以只给一节、可以限字数
 *
 * 这样 AI 在第一层看到的是几百字，而不是把几十万字笔记塞进上下文。
 */

export const DEFAULT_NOTE_MAX_CHARS = 12_000
export const NOTE_MAX_CHARS_LIMIT = 200_000

// 课次顺序按上课日期（老记录退回发布日期的日期部分），同一天按课次标题稳定排序
const byLessonAsc = (left, right) =>
  lessonDateOf(left).localeCompare(lessonDateOf(right)) || String(left.lessonTitle).localeCompare(String(right.lessonTitle))
const norm = value => String(value ?? '').normalize('NFKC').trim().toLowerCase()
const collapse = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const uniqueCount = values => new Set(values.map(norm).filter(Boolean)).size

/** 词频汇总：按出现次数排，同次数按首次出现顺序（保住课程自己的讲述顺序）。 */
function topTerms(values, limit) {
  const counter = new Map()
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (!text) continue
    const key = norm(text)
    if (!counter.has(key)) counter.set(key, { text, count: 0, first: counter.size })
    counter.get(key).count += 1
  }
  return [...counter.values()]
    .sort((left, right) => right.count - left.count || left.first - right.first)
    .slice(0, limit)
    .map(item => item.text)
}

function isoOrUndefined(value) {
  const date = new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 课程名解析：先全等，再唯一包含；歧义或找不到时把候选列出来，让模型自己改。 */
function resolveCourse(records, course) {
  const wanted = norm(course)
  const names = [...new Set(records.map(record => record.courseName).filter(Boolean))]
  if (!wanted) throw new ToolError('需要课程名（course）。')
  const exact = names.find(name => norm(name) === wanted)
  if (exact) return exact
  const partial = names.filter(name => norm(name).includes(wanted) || wanted.includes(norm(name)))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) throw new ToolError(`课程「${course}」不唯一，可能是：${partial.join(' / ')}。请给完整课程名。`)
  throw new ToolError(`找不到课程「${course}」。现有课程：${names.join(' / ') || '（发布库是空的）'}`)
}

export function createNotesService({ source, siteOrigin = '' } = {}) {
  if (!source) throw new Error('createNotesService 需要 source（createSource 的产物）')
  // canonical URL：AI 引用来源时要给用户能直接点开的地址
  const origin = String(siteOrigin || 'https://course.law-tech.dev').replace(/\/+$/, '')
  const noteUrl = slug => `${origin}/${String(slug).replace(/^\/+/, '')}.html`
  const onePageUrl = slug => `${origin}/${String(slug).replace(/^notes\//, 'onepage/')}.html`
  /**
   * 取记录列表。context.signal 来自 HTTP 层的请求预算：客户端断开或超出时间预算时会 abort，
   * 远程数据源据此断掉正在飞的请求（本地库是读一次文件，不受影响）。
   */
  const listNotes = context => source.listNotes({ signal: context?.signal })

  /** 第一层：课程总览。 */
  async function listCourses({ query = '', limit = 50 } = {}, context = {}) {
    const records = await listNotes(context)
    const groups = new Map()
    for (const record of records) {
      if (!record.courseName) continue
      if (!groups.has(record.courseName)) groups.set(record.courseName, [])
      groups.get(record.courseName).push(record)
    }
    const wanted = norm(query)
    const courses = []
    for (const [courseName, list] of groups) {
      const sorted = [...list].sort(byLessonAsc)
      const latest = sorted[sorted.length - 1]
      const teacher = [...sorted].reverse().find(record => record.teacher)?.teacher || ''
      if (wanted && !(norm(courseName).includes(wanted) || norm(teacher).includes(wanted))) continue
      courses.push({
        courseName,
        teacher,
        lessonCount: sorted.length,
        latestLessonDate: lessonDateOf(latest),
        latestLessonTitle: latest?.lessonTitle || '',
        themes: [...sorted].reverse().filter(record => record.theme).slice(0, 3)
          .map(record => ({ lessonTitle: record.lessonTitle, theme: record.theme })),
        keywords: topTerms(sorted.flatMap(record => [...record.keywords, ...record.metadata.keywords]), 8),
        termCounts: {
          concepts: uniqueCount(sorted.flatMap(record => record.metadata.concepts)),
          statutes: uniqueCount(sorted.flatMap(record => record.metadata.statutes)),
          cases: uniqueCount(sorted.flatMap(record => record.metadata.cases))
        }
      })
    }
    courses.sort((left, right) =>
      String(right.latestLessonDate).localeCompare(String(left.latestLessonDate)) ||
      left.courseName.localeCompare(right.courseName, 'zh'))
    return {
      total: courses.length,
      lessonTotal: records.filter(record => record.courseName).length,
      query: String(query || ''),
      limit,
      courses: courses.slice(0, limit)
    }
  }

  /** 第二层：一门课的课次清单（不含正文）。 */
  async function getCourse({
    course = '',
    limit = 100,
    order = 'asc',
    includeOutline = false,
    // 目录分页：**不再静默截断**——截断了就报总数与被截断这件事，调用方自己决定要不要翻页
    outlineLimit = 60,
    outlineOffset = 0
  } = {}, context = {}) {
    const records = await listNotes(context)
    const courseName = resolveCourse(records, course)
    const list = records.filter(record => record.courseName === courseName).sort(byLessonAsc)
    const teacher = [...list].reverse().find(record => record.teacher)?.teacher || ''
    const ordered = order === 'desc' ? [...list].reverse() : list
    const lessons = ordered.slice(0, limit).map(record => ({
      slug: record.slug,
      lessonTitle: record.lessonTitle,
      lessonDate: lessonDateOf(record),
      readMinutes: record.readMinutes,
      theme: record.theme,
      keywords: record.keywords.slice(0, 6),
      summary: clip(record.summary || record.brief?.briefing || '', 180),
      ...(includeOutline ? { outline: outlineOf(record, outlineLimit, outlineOffset) } : {})
    }))
    return { courseName, teacher, lessonCount: list.length, returned: lessons.length, order, limit, lessons }
  }

  /** 跨课次/跨课程检索：返回片段 + 定位，不返回全文。 */
  /**
   * 跨课次/跨课程检索。
   *
   * 查询解析（多词、自然语言、错别字）与打分（字段权重 × IDF）都在 search.mjs，
   * 这里只负责：取数据、限定范围、把结果按 limit 收口。
   */
  /**
   * 跨课次/跨课程检索。
   *
   * 覆盖策略只有一处默认（search.mjs 的 coverage='auto'）：**站点搜索、MCP 专用检索、
   * OpenAI 标准 search 三个入口共用它**，所以同一句话在哪里问都得到同一批结果。
   * includeBody 仍然保留（true = coverage:'body'），老调用方不受影响。
   */
  async function searchNotes({ query = '', course = '', includeBody, coverage, perNoteSections = 2, limit = 8 } = {}, context = {}) {
    const text = String(query || '').trim()
    if (!text) throw new ToolError('search_notes 需要非空的 query。')
    const records = await listNotes(context)
    const scoped = course ? records.filter(record => record.courseName === resolveCourse(records, course)) : records
    const found = await searchRecords({
      records: scoped,
      query: text,
      includeBody: includeBody === undefined ? undefined : Boolean(includeBody),
      ...(coverage ? { coverage } : {}),
      perNoteSections,
      readMarkdown: (slug, options) => source.readMarkdown(slug, options),
      // 取消信号：客户端断开或超时后，检索在下一个检查点就退出，不再白算
      signal: context?.signal
    })
    // 全是疑问词与虚词的查询（"为什么是这样的呢"）解析后一个词都不剩：
    // 与其把整库都当命中，不如让调用方知道这条查询本身没带信息
    if (!found.terms.length) {
      throw new ToolError(`查询「${text}」里没有可检索的词：去掉疑问词与虚词之后为空，请给出具体的术语、法条或人名。`)
    }
    return {
      query: text,
      course: course ? scoped[0]?.courseName || String(course) : '',
      // includeBody = "调用方有没有要求连正文一起查"（保持原语义，不随覆盖策略漂移）；
      // 实际用到哪一层看 coverage / escalated
      includeBody: Boolean(includeBody),
      ...found,
      limit,
      hits: found.hits.slice(0, limit)
    }
  }

  /** 第三层：取正文；section 截一节，maxChars 限长度（默认只给 12000 字，够读一节）。 */
  async function getNote({
    slug = '',
    course = '',
    lesson = '',
    section = '',
    maxChars,
    // 小节清单也分页：以前固定只给前 40 条，之后的模型就再也看不到（也就读不到）
    sectionsLimit = 200,
    sectionsOffset = 0
  } = {}, context = {}) {
    const records = await listNotes(context)
    let record = null
    const wantedSlug = String(slug || '').trim().replace(/^\/+|\/+$/g, '')
    if (wantedSlug) {
      record = records.find(item => item.slug === wantedSlug) || null
      if (!record) throw new ToolError(`找不到 slug=${wantedSlug} 的笔记。先用 list_courses / get_course 取准确 slug。`)
    } else if (String(course || '').trim() && String(lesson || '').trim()) {
      const courseName = resolveCourse(records, course)
      const inCourse = records.filter(item => item.courseName === courseName).sort(byLessonAsc)
      const wantedLesson = norm(lesson)
      const exact = inCourse.filter(item => norm(item.lessonTitle) === wantedLesson)
      const partial = exact.length ? exact : inCourse.filter(item =>
        norm(item.lessonTitle).includes(wantedLesson) || wantedLesson.includes(norm(item.lessonTitle)))
      if (!partial.length) {
        throw new ToolError(`课程「${courseName}」里找不到课次「${lesson}」。课次有：${inCourse.map(item => item.lessonTitle).join(' / ')}`)
      }
      if (partial.length > 1) {
        throw new ToolError(`课次「${lesson}」不唯一：${partial.map(item => item.lessonTitle).join(' / ')}。请写完整标题或用 slug。`)
      }
      record = partial[0]
    } else {
      throw new ToolError('get_note 需要 slug，或者同时给 course 与 lesson。')
    }

    const full = await source.readMarkdown(record.slug, { signal: context?.signal })
    const headings = extractHeadings(full)
    let body = full
    let sectionInfo = null
    const wantedSection = String(section || '').trim()
    if (wantedSection) {
      const found = findSection(full, wantedSection)
      if (!found) {
        throw new ToolError(`在 ${record.slug} 里找不到小节「${section}」。可用小节：${headings.map(head => head.text).slice(0, 20).join(' / ') || '（这篇没有标题）'}`)
      }
      body = found.body
      sectionInfo = { title: found.title, id: found.id, level: found.level }
    }

    const limit = clampMaxChars(maxChars)
    const truncated = body.length > limit
    return {
      slug: record.slug,
      courseName: record.courseName,
      teacher: record.teacher,
      lessonTitle: record.lessonTitle,
      lessonDate: lessonDateOf(record),
      readMinutes: record.readMinutes,
      theme: record.theme,
      keywords: record.keywords,
      section: sectionInfo,
      markdown: truncated ? body.slice(0, limit) : body,
      totalChars: full.length,
      sectionChars: body.length,
      returnedChars: Math.min(body.length, limit),
      maxChars: limit,
      truncated,
      ...sectionsOf(headings, sectionsLimit, sectionsOffset)
    }
  }

  /**
   * OpenAI 标准知识接口之一：search(query) → { results: [{ id, title, url }] }。
   *
   * 与 course 专用的 search_notes 的关系：**同一套检索、同一套召回策略**，只是输出换成标准格式。
   *
   * 这里曾经有一层「命中少于 3 条再下沉到正文查一遍」的历史 gate。它与 searchRecords 里
   * 「索引没命中就自动扫正文」的规则叠在一起，会让同一个问题在两个入口得到不同结果：
   * 标准接口一旦召回 3 条以上就永远不再扫正文，专用接口则会。现在规则只有一处
   * （在 searchRecords 里），两个入口的召回完全一致。
   *
   * id 用 slug（命中到小节时给 slug#小节），稳定且能直接喂给 fetch。
   */
  async function searchKnowledge({ query = '', limit = 8 } = {}, context = {}) {
    const text = String(query || '').trim()
    if (!text) throw new ToolError('search 需要 query。')
    const records = await listNotes(context)
    const bySlug = new Map(records.map(record => [record.slug, record]))
    const found = await searchNotes({ query: text, limit: Math.max(limit * 2, 8) }, context)
    const hits = found.hits || []
    const results = hits.slice(0, limit).map(hit => {
      const record = bySlug.get(hit.slug)
      const course = hit.courseName || record?.courseName || ''
      const lesson = hit.lessonTitle || record?.lessonTitle || ''
      // 命中落在某一节时，id 直接给到那一节（slug#锚点 id）：调用方不必先读整篇再自己找，
      // fetch 本来就支持这种 id；没定位到小节时退回整篇 slug。
      //
      // 这里用**页面上的锚点 id**而不是小节标题：站点 /api/search 返回的 anchor 也是它，
      // 三个入口给出的是同一处（标题只作展示，改标题不该让 id 失效——id 由 findSection 兜底解析）。
      const section = hit.location?.title || ''
      const anchorId = hit.location?.id || ''
      return {
        id: anchorId ? `${hit.slug}#${encodeURIComponent(anchorId)}` : hit.slug,
        title: [course, lesson, section].filter(Boolean).join(' · '),
        url: noteUrl(hit.slug)
      }
    })
    return { query: text, scanned: found.scanned || records.length, results }
  }

  /**
   * OpenAI 标准知识接口之二：fetch(id) → { id, title, text, url, metadata }。
   *
   * id 支持两种：笔记 slug（整篇），或 slug#小节标题/标题 id（只取那一节）——
   * 后者让调用方能在不读整篇的前提下拿到相关段落。
   */
  async function fetchDocument({ id = '' } = {}, context = {}) {
    const raw = String(id || '').trim()
    if (!raw) throw new ToolError('fetch 需要 id（来自 search 的 results[].id）。')
    const [slugPart, sectionPart = ''] = raw.split('#')
    const section = sectionPart ? decodeURIComponent(sectionPart) : ''
    const note = await getNote({ slug: slugPart, section, maxChars: NOTE_MAX_CHARS_LIMIT }, context)
    const text = note.markdown || ''
    return {
      id: raw,
      title: section
        ? `${note.courseName} · ${note.lessonTitle} · ${note.section?.title || section}`
        : `${note.courseName} · ${note.lessonTitle}`,
      text,
      url: noteUrl(note.slug),
      metadata: {
        course: note.courseName || '',
        lesson: note.lessonTitle || '',
        date: lessonDateOf(note),
        section: note.section?.title || section || '',
        slug: note.slug,
        theme: note.theme || '',
        keywords: note.keywords || [],
        readMinutes: note.readMinutes || 0,
        totalChars: note.totalChars || text.length,
        onePageUrl: onePageUrl(note.slug)
      }
    }
  }

  /** 加分项：一门课的概念 / 法条 / 案例清单，带出现次数与落点。 */
  async function listTerms({ course = '', kind = 'all', limit = 50 } = {}, context = {}) {
    const records = await listNotes(context)
    const courseName = resolveCourse(records, course)
    const scoped = records.filter(record => record.courseName === courseName).sort(byLessonAsc)
    const buckets = {}
    for (const bucket of ['concepts', 'statutes', 'cases', 'keywords']) {
      const terms = new Map()
      for (const record of scoped) {
        const values = bucket === 'keywords'
          ? [...record.keywords, ...record.metadata.keywords]
          : record.metadata[bucket]
        for (const value of values) {
          const term = String(value ?? '').trim()
          if (!term) continue
          if (!terms.has(term)) terms.set(term, { term, count: 0, notes: [] })
          const entry = terms.get(term)
          entry.count += 1
          const anchor = record.anchors?.[bucket]?.[term] || ''
          if (!entry.notes.some(note => note.slug === record.slug)) {
            entry.notes.push({ slug: record.slug, lessonTitle: record.lessonTitle, anchor })
          }
        }
      }
      buckets[bucket] = [...terms.values()]
        .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term, 'zh'))
        .slice(0, limit)
    }
    return {
      courseName,
      teacher: [...scoped].reverse().find(record => record.teacher)?.teacher || '',
      lessonCount: scoped.length,
      kind,
      buckets: kind === 'all' ? buckets : { [kind]: buckets[kind] || [] }
    }
  }

  /** 支持 resources 的客户端直接读：把上面几层包成资源。 */
  async function listResources(context = {}) {
    const records = await listNotes(context)
    const groups = new Map()
    for (const record of records) {
      if (!record.courseName) continue
      if (!groups.has(record.courseName)) groups.set(record.courseName, [])
      groups.get(record.courseName).push(record)
    }
    // 顶层资源也给时间戳：客户端据此判断"要不要重新拉"，缺了它这一条就永远是"不知道新旧"
    const latestChange = isoOrUndefined(
      records.map(record => record.updatedAt || record.firstPublishedAt).filter(Boolean).sort().at(-1)
    )
    const resources = [{
      uri: COURSES_URI,
      name: 'courses',
      title: '课程列表（第一层）',
      description: '所有课程、课次数、最新课次时间、主题与关键词汇总',
      mimeType: 'application/json',
      annotations: { ...(latestChange ? { lastModified: latestChange } : {}), audience: ['assistant', 'user'], priority: 0.9 }
    }]
    for (const [courseName, list] of groups) {
      const sorted = [...list].sort(byLessonAsc)
      // 资源时间戳问的是"这份内容最近有没有变"，所以用 updatedAt（退回首次进站时间）
    const lastModified = isoOrUndefined(sorted[sorted.length - 1]?.updatedAt) ?? isoOrUndefined(sorted[sorted.length - 1]?.firstPublishedAt)
      resources.push({
        uri: courseUri(courseName),
        name: `${courseName} 课次清单`,
        title: `${courseName} · 课次清单`,
        description: `${sorted.length} 课次：标题、时间、theme、keywords、摘要`,
        mimeType: 'application/json',
        annotations: { ...(lastModified ? { lastModified } : {}), audience: ['assistant'], priority: 0.7 }
      })
      resources.push({
        uri: termsUri(courseName),
        name: `${courseName} 术语清单`,
        title: `${courseName} · 概念/法条/案例`,
        description: '该课程出现过的概念、法条、案例与关键词（含落点锚点）',
        mimeType: 'application/json',
        annotations: { ...(lastModified ? { lastModified } : {}), audience: ['assistant'], priority: 0.5 }
      })
    }
    for (const record of records) {
      const lastModified = isoOrUndefined(record.updatedAt) ?? isoOrUndefined(record.firstPublishedAt)
      resources.push({
        uri: noteUri(record.slug),
        name: record.slug,
        title: `${record.courseName} · ${record.lessonTitle}`,
        description: record.theme || clip(record.summary, 80),
        mimeType: 'text/markdown',
        annotations: { ...(lastModified ? { lastModified } : {}), audience: ['assistant'], priority: 0.6 }
      })
    }
    return resources
  }

  async function readResource(uri, context = {}) {
    const target = parseResourceUri(uri)
    if (!target) throw new ResourceNotFoundError(uri)
    const json = value => `${JSON.stringify(value, null, 2)}\n`
    try {
      if (target.kind === 'courses') {
        return { uri, mimeType: 'application/json', text: json(await listCourses({ limit: 200 })) }
      }
      if (target.kind === 'course') {
        return { uri, mimeType: 'application/json', text: json(await getCourse({ course: target.value, limit: 500, includeOutline: true })) }
      }
      if (target.kind === 'terms') {
        return { uri, mimeType: 'application/json', text: json(await listTerms({ course: target.value, limit: 200 })) }
      }
      const note = await getNote({ slug: target.value, maxChars: NOTE_MAX_CHARS_LIMIT })
      return { uri, mimeType: 'text/markdown', text: note.markdown }
    } catch (error) {
      // 资源读不到要走 -32002（规范给的码），而不是 tools/call 那套 isError
      if (error instanceof ToolError) throw new ResourceNotFoundError(uri, error.message)
      throw error
    }
  }

  function resourceTemplates() {
    return [
      {
        uriTemplate: 'notes://course/{course}',
        name: '课程课次清单',
        title: '某门课的课次清单（第二层）',
        description: 'course 用课程名（整段 URL 编码），返回 JSON',
        mimeType: 'application/json'
      },
      {
        uriTemplate: 'notes://terms/{course}',
        name: '课程术语清单',
        title: '某门课的概念/法条/案例清单',
        description: 'course 用课程名（整段 URL 编码），返回 JSON',
        mimeType: 'application/json'
      },
      {
        uriTemplate: 'notes://note/{slug}',
        name: '笔记全文',
        title: '一篇笔记的整篇 Markdown',
        description: 'slug 形如 notes/课程/课次，整段 URL 编码（斜杠编码成 %2F），返回 text/markdown',
        mimeType: 'text/markdown'
      }
    ]
  }

  return {
    describe: source.describe,
    listCourses,
    getCourse,
    searchNotes,
    getNote,
    listTerms,
    searchKnowledge,
    fetchDocument,
    listResources,
    readResource,
    resourceTemplates
  }
}

const pageLimit = (value, fallback, max) => {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.max(1, Math.min(Math.trunc(num), max))
}

/**
 * 一节的目录项：优先用发布库里的**全量小节索引**（含内容指纹与字数），
 * 老库没有它时退回 headings。分页参数生效，并明确报告"总数 / 返回几项 / 是否被截断"——
 * 静默截断会让调用方以为"这篇就这么多小节"，然后就永远读不到后面的。
 */
function outlineOf(record = {}, limit = 60, offset = 0) {
  const source = (Array.isArray(record.sections) && record.sections.length ? record.sections : record.headings) || []
  const size = pageLimit(limit, 60, 500)
  const from = Math.max(0, Math.trunc(Number(offset) || 0))
  const items = source.slice(from, from + size).map(head => ({
    level: head.level,
    text: head.title || head.text || '',
    id: head.id,
    ...(head.chars === undefined ? {} : { chars: head.chars }),
    ...(head.fingerprint ? { fingerprint: head.fingerprint } : {})
  }))
  return {
    items,
    total: source.length,
    returned: items.length,
    offset: from,
    limit: size,
    truncated: from + items.length < source.length
  }
}

/** get_note 里的小节清单（兼容旧字段名 text）。 */
function sectionsOf(headings = [], limit = 200, offset = 0) {
  const size = pageLimit(limit, 200, 1000)
  const from = Math.max(0, Math.trunc(Number(offset) || 0))
  const items = headings.slice(from, from + size).map(head => ({ level: head.level, text: head.text, id: head.id }))
  return {
    sections: items,
    sectionsTotal: headings.length,
    sectionsTruncated: from + items.length < headings.length
  }
}

/** maxChars：缺省 12000；工具层上限 6 万，资源层可以放到 20 万（整篇）。 */
function clampMaxChars(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_NOTE_MAX_CHARS
  return Math.max(200, Math.min(Math.trunc(num), NOTE_MAX_CHARS_LIMIT))
}
