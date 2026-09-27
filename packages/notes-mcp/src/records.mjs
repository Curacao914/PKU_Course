/**
 * 发布库记录的形状，以及几件围绕 Markdown 的小事。
 *
 * 为什么不 import @course/publish 里的 slugify / extractHeadings：
 * 这个包要能单独复制到任何一台机器上跑（客户端挂 MCP 时只给它一条命令），
 * 依赖越少越好；两边规则保持一致（改一边记得改另一边）。
 */

/** 与 publish 的同名函数一致：标题 → 锚点 id。 */
export function slugify(value, fallback = 'section') {
  const slug = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || fallback
}

/** 从 Markdown 抽标题（1—6 级；publish 的目录只用 2—4 级，这里要能按任意小节截取）。 */
export function extractHeadings(markdown = '') {
  const headings = []
  for (const line of String(markdown ?? '').split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match) headings.push({ level: match[1].length, text: match[2].trim(), id: slugify(match[2]) })
  }
  return headings
}

/**
 * 按标题把正文切段。
 *
 * 每段的范围是「本级标题 → 下一个同级或更高级标题之前」，这样 get_note 的 section
 * 截出来才是完整的一节，而不是切到文档末尾。返回的 body 含标题行本身——
 * 模型拿到片段时应该看得到小节标题，否则不知道自己在读哪一节。
 */
export function splitSections(markdown = '') {
  const lines = String(markdown ?? '').split('\n')
  const heads = []
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match) heads.push({ level: match[1].length, title: match[2].trim(), id: slugify(match[2]), line: index })
  })
  return heads.map((head, index) => {
    let end = lines.length
    for (let next = index + 1; next < heads.length; next += 1) {
      if (heads[next].level <= head.level) { end = heads[next].line; break }
    }
    // ownBody 是不含子小节的那部分正文：检索定位必须用它，否则 h1 段会吞掉整篇，
    // 每一处命中都会"定位"到文章标题上。
    const child = heads.slice(index + 1).find(item => item.line < end)
    const ownEnd = child ? child.line : end
    return {
      ...head,
      end,
      body: lines.slice(head.line, end).join('\n').trimEnd(),
      ownBody: lines.slice(head.line + 1, ownEnd).join('\n').trimEnd()
    }
  })
}

/**
 * 按「标题文本或 id」找一节。
 *
 * 匹配顺序：id 全等 → 标题全等 → 标题包含。包含匹配按文档顺序取第一条，
 * 不猜语义——猜错比找不到更糟，找不到时上游会把全部小节列给模型自己挑。
 */
export function findSection(markdown = '', needle = '') {
  const target = String(needle ?? '').trim()
  if (!target) return null
  const sections = splitSections(markdown).filter(section => section.title)
  const key = target.normalize('NFKC').toLowerCase()
  const byId = sections.find(section => section.id === target || section.id === key)
  if (byId) return byId
  const exact = sections.find(section => section.title.normalize('NFKC').toLowerCase() === key)
  if (exact) return exact
  return sections.find(section => section.title.normalize('NFKC').toLowerCase().includes(key)) || null
}

/** 截断到 limit 字，尾巴加省略号（给模型看的摘要用）。 */
export function clip(value, limit = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 站点的 Markdown 文件名 = slug 的最后一段（publish 就是这么写的）。 */
export function noteFileName(slug) {
  return String(slug ?? '').split('/').filter(Boolean).pop() || 'note'
}

const str = value => String(value ?? '').trim()
const strings = value => {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    const text = str(item)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * 展示与排序用的课次日期（YYYY-MM-DD）。
 *
 * 发布库自 Phase 1 起有 lessonDate（这节课哪天上的）；老库没有它，退回发布日期的日期部分。
 * 展示与排序只认这一处，免得"MCP 里显示的是发布日期、站点上显示的是课次日期"这种分裂。
 */
export function lessonDateOf(record = {}) {
  return str(record.lessonDate) || str(record.publishedAt).slice(0, 10)
}

/**
 * 把一条发布库记录补成固定形状。
 *
 * 字段全给默认值（而不是留 undefined）：站点索引（远程数据源）本来就不含 markdown，
 * 老记录也可能缺 theme/keywords，缺字段不该让调用方到处写 ?? 。
 */
export function normalizeRecord(raw = {}) {
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
  const brief = raw.brief && typeof raw.brief === 'object' ? raw.brief : null
  const headings = (Array.isArray(raw.headings) ? raw.headings : [])
    .filter(head => head && str(head.text))
    .map(head => ({ level: Number(head.level) || 2, text: str(head.text), id: str(head.id) || slugify(head.text) }))
  return {
    slug: str(raw.slug),
    courseName: str(raw.courseName),
    teacher: str(raw.teacher),
    lessonTitle: str(raw.lessonTitle),
    replayKey: str(raw.replayKey),
    /**
     * 三个时间（发布库自 Phase 1 起就是这个形状）：
     *   lessonDate        这节课是哪天上的 —— 展示与排序都用它
     *   firstPublishedAt  第一次进站的时间 —— 订阅/资源时间戳用它
     *   updatedAt         最近一次改动
     * publishedAt 保留成"首次进站时间"的别名：老发布库只有它，调用方不必到处写兼容分支。
     */
    lessonDate: str(raw.lessonDate),
    firstPublishedAt: str(raw.firstPublishedAt) || str(raw.publishedAt),
    updatedAt: str(raw.updatedAt) || str(raw.firstPublishedAt) || str(raw.publishedAt),
    publishedAt: str(raw.publishedAt) || str(raw.firstPublishedAt),
    readMinutes: Number(raw.readMinutes) || 0,
    summary: str(raw.summary),
    brief: brief ? { briefing: str(brief.briefing), keyPoints: strings(brief.keyPoints) } : null,
    theme: str(raw.theme),
    keywords: strings(raw.keywords),
    keywordsSource: str(raw.keywordsSource),
    headings,
    metadata: {
      concepts: strings(metadata.concepts),
      statutes: strings(metadata.statutes),
      cases: strings(metadata.cases),
      keywords: strings(metadata.keywords)
    },
    anchors: raw.anchors && typeof raw.anchors === 'object' ? raw.anchors : {},
    checksum: str(raw.checksum),
    ...(typeof raw.markdown === 'string' ? { markdown: raw.markdown } : {})
  }
}
