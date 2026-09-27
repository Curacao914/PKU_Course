import { ResourceNotFoundError, ToolError } from './errors.mjs'
import { clip, extractHeadings, findSection, lessonDateOf, splitSections } from './records.mjs'
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

/** 大小写无关的全部命中位置（最多 8 处，避免超长正文里同一个词刷屏）。 */
function findMatches(text, needle) {
  const haystack = String(text ?? '')
  const wanted = String(needle ?? '')
  if (!wanted) return []
  const lowered = haystack.toLowerCase()
  const target = wanted.toLowerCase()
  const out = []
  let from = 0
  while (out.length < 8) {
    const at = lowered.indexOf(target, from)
    if (at < 0) break
    out.push(at)
    from = at + Math.max(1, target.length)
  }
  return out
}

/** 命中点前后各取一段，保证片段本身自足（模型不该为了看懂片段再去读全文）。 */
function snippetAround(text, at, length, radius = 56) {
  const source = String(text ?? '')
  const start = Math.max(0, Math.min(at, source.length))
  const end = Math.min(source.length, start + Math.max(1, length))
  const before = source.slice(Math.max(0, start - radius), start)
  const hit = source.slice(start, end)
  const after = source.slice(end, Math.min(source.length, end + radius))
  return `${start > radius ? '…' : ''}${before}「${hit}」${after}${end + radius < source.length ? '…' : ''}`
}

/** 术语锚点 → 小节标题（发布时算好的 anchors 就是为「点进正文某一节」准备的）。 */
function anchorLocation(record, bucket, term) {
  const id = record?.anchors?.[bucket]?.[term]
  if (!id) return null
  const heading = record.headings.find(item => item.id === id)
  return { title: heading?.text || '', id }
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

/** 检索字段与权重：标题/主题/关键词最重，正文最轻——同一个词出现在标题里更可能是"这节在讲它"。 */
const FIELD_SPECS = [
  { kind: '标题', weight: 12, values: record => [record.lessonTitle, ...record.headings.map(head => head.text)] },
  { kind: '主题', weight: 10, values: record => [record.theme] },
  { kind: '关键词', weight: 9, values: record => [...record.keywords, ...record.metadata.keywords] },
  { kind: '概念', weight: 8, bucket: 'concepts', values: record => record.metadata.concepts },
  { kind: '法条', weight: 8, bucket: 'statutes', values: record => record.metadata.statutes },
  { kind: '案例', weight: 8, bucket: 'cases', values: record => record.metadata.cases },
  { kind: '摘要', weight: 4, values: record => [record.summary, record.brief?.briefing, ...(record.brief?.keyPoints || [])] },
  { kind: '课程', weight: 3, values: record => [record.courseName, record.teacher] }
]

export function createNotesService({ source, siteOrigin = '' } = {}) {
  if (!source) throw new Error('createNotesService 需要 source（createSource 的产物）')
  // canonical URL：AI 引用来源时要给用户能直接点开的地址
  const origin = String(siteOrigin || 'https://course.law-tech.dev').replace(/\/+$/, '')
  const noteUrl = slug => `${origin}/${String(slug).replace(/^\/+/, '')}.html`
  const onePageUrl = slug => `${origin}/${String(slug).replace(/^notes\//, 'onepage/')}.html`

  /** 第一层：课程总览。 */
  async function listCourses({ query = '', limit = 50 } = {}) {
    const records = await source.listNotes()
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
  async function getCourse({ course = '', limit = 100, order = 'asc', includeOutline = false } = {}) {
    const records = await source.listNotes()
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
      ...(includeOutline
        ? { outline: record.headings.slice(0, 16).map(head => ({ level: head.level, text: head.text, id: head.id })) }
        : {})
    }))
    return { courseName, teacher, lessonCount: list.length, returned: lessons.length, order, limit, lessons }
  }

  /** 跨课次/跨课程检索：返回片段 + 定位，不返回全文。 */
  async function searchNotes({ query = '', course = '', includeBody = false, limit = 8 } = {}) {
    const text = String(query || '').trim()
    if (!text) throw new ToolError('search_notes 需要非空的 query。')
    const records = await source.listNotes()
    const scoped = course ? records.filter(record => record.courseName === resolveCourse(records, course)) : records
    const needle = norm(text)
    const hits = []
    let bodySkipped = 0

    for (const record of scoped) {
      const matched = []
      for (const spec of FIELD_SPECS) {
        for (const value of spec.values(record)) {
          const fieldText = collapse(value)
          const occurrences = findMatches(fieldText, needle)
          if (!occurrences.length) continue
          matched.push({
            kind: spec.kind,
            weight: spec.weight,
            count: occurrences.length,
            location: spec.bucket ? anchorLocation(record, spec.bucket, String(value).trim()) : null,
            snippets: occurrences.slice(0, 2).map(at => snippetAround(fieldText, at, needle.length))
          })
        }
      }
      if (includeBody) {
        let markdown = record.markdown
        if (markdown === undefined) {
          try {
            markdown = await source.readMarkdown(record.slug)
          } catch {
            bodySkipped += 1
            markdown = ''
          }
        }
        for (const section of splitSections(markdown)) {
          const bodyText = collapse(section.ownBody)
          const occurrences = findMatches(bodyText, needle)
          if (!occurrences.length) continue
          matched.push({
            kind: '正文',
            weight: 2,
            count: occurrences.length,
            location: { title: section.title, id: section.id },
            snippets: occurrences.slice(0, 2).map(at => snippetAround(bodyText, at, needle.length))
          })
        }
      }
      if (!matched.length) continue
      const best = [...matched].sort((left, right) => right.weight - left.weight || right.count - left.count)[0]
      hits.push({
        slug: record.slug,
        courseName: record.courseName,
        lessonTitle: record.lessonTitle,
        lessonDate: lessonDateOf(record),
        kind: best.kind,
        kinds: [...new Set(matched.map(item => item.kind))],
        location: matched.map(item => item.location).find(Boolean) || null,
        snippets: [...new Set(matched.flatMap(item => item.snippets))].slice(0, 3),
        score: matched.reduce((sum, item) => sum + item.weight * Math.min(item.count, 3), 0)
      })
    }

    hits.sort((left, right) => right.score - left.score || String(right.lessonDate).localeCompare(String(left.lessonDate)))
    return {
      query: text,
      course: course ? scoped[0]?.courseName || String(course) : '',
      includeBody: Boolean(includeBody),
      scanned: scoped.length,
      bodySkipped,
      total: hits.length,
      limit,
      hits: hits.slice(0, limit)
    }
  }

  /** 第三层：取正文；section 截一节，maxChars 限长度（默认只给 12000 字，够读一节）。 */
  async function getNote({ slug = '', course = '', lesson = '', section = '', maxChars } = {}) {
    const records = await source.listNotes()
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

    const full = await source.readMarkdown(record.slug)
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
      sections: headings.map(head => ({ level: head.level, text: head.text, id: head.id })).slice(0, 40)
    }
  }

  /**
   * OpenAI 标准知识接口之一：search(query) → { results: [{ id, title, url }] }。
   *
   * 与 course 专用的 search_notes 的关系：**复用同一套检索**，只是输出换成标准格式。
   * 先查索引；索引命中太少时就下沉到正文再查一次（标准接口的调用方只会给一个 query，
   * 不会像模型那样自己决定要不要 includeBody）。
   *
   * id 用 slug，稳定且能直接喂给 fetch。
   */
  async function searchKnowledge({ query = '', limit = 8 } = {}) {
    const text = String(query || '').trim()
    if (!text) throw new ToolError('search 需要 query。')
    const records = await source.listNotes()
    const bySlug = new Map(records.map(record => [record.slug, record]))
    const first = await searchNotes({ query: text, limit: Math.max(limit * 2, 8) })
    let hits = first.hits || []
    if (hits.length < 3) {
      // 索引里没写到的内容（正文细节）再扫一遍正文；远程数据源会逐篇下载，代价可接受
      const deep = await searchNotes({ query: text, includeBody: true, limit: Math.max(limit * 2, 8) })
      const seen = new Set(hits.map(hit => hit.slug))
      hits = [...hits, ...(deep.hits || []).filter(hit => !seen.has(hit.slug))]
    }
    const results = hits.slice(0, limit).map(hit => {
      const record = bySlug.get(hit.slug)
      const course = hit.courseName || record?.courseName || ''
      const lesson = hit.lessonTitle || record?.lessonTitle || ''
      return {
        id: hit.slug,
        title: course ? `${course} · ${lesson}` : lesson,
        url: noteUrl(hit.slug)
      }
    })
    return { query: text, scanned: first.scanned || records.length, results }
  }

  /**
   * OpenAI 标准知识接口之二：fetch(id) → { id, title, text, url, metadata }。
   *
   * id 支持两种：笔记 slug（整篇），或 slug#小节标题/标题 id（只取那一节）——
   * 后者让调用方能在不读整篇的前提下拿到相关段落。
   */
  async function fetchDocument({ id = '' } = {}) {
    const raw = String(id || '').trim()
    if (!raw) throw new ToolError('fetch 需要 id（来自 search 的 results[].id）。')
    const [slugPart, sectionPart = ''] = raw.split('#')
    const section = sectionPart ? decodeURIComponent(sectionPart) : ''
    const note = await getNote({ slug: slugPart, section, maxChars: NOTE_MAX_CHARS_LIMIT })
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
  async function listTerms({ course = '', kind = 'all', limit = 50 } = {}) {
    const records = await source.listNotes()
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
  async function listResources() {
    const records = await source.listNotes()
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

  async function readResource(uri) {
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

/** maxChars：缺省 12000；工具层上限 6 万，资源层可以放到 20 万（整篇）。 */
function clampMaxChars(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_NOTE_MAX_CHARS
  return Math.max(200, Math.min(Math.trunc(num), NOTE_MAX_CHARS_LIMIT))
}
