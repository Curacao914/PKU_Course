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

/**
 * 扫一遍 Markdown 的标题行。**extractHeadings 与 splitSections 共用这一份实现**——
 * 以前两处各写一遍正则，改一处忘一处就会让"目录里的小节"与"能取到正文的小节"对不上。
 *
 * 两个必须处理的坑：
 *   1. **代码围栏里的不算标题**。笔记里有大量 ```bash / ``` 块，块里的 "# 注释"
 *      会被当成一级标题：小节凭空多出几个、锚点被假节点抢走、按 section 取正文取到半截。
 *   2. **id 必须唯一**。两节同名（每个模块下都有"课程概览"）时旧实现给出同一个 id，
 *      页面上的锚点只能落到第一处——检索说"在第二节"、点进去跳到第一节。
 *      重复的加 -2/-3；同时把原始 slug 与标题记进 aliases，findSection 仍然按标题找得到。
 *      （第一处的 id 不变，所以线上已有的锚点不会被这次改动打断。）
 */
function scanHeadings(lines) {
  const heads = []
  const used = new Map()
  let fence = ''
  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = ''
      return
    }
    if (fence) return
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!match) return
    // 闭合式 ATX（"## 标题 ##"）要去掉尾部的井号
    const title = match[2].trim().replace(/\s+#+\s*$/, '').trim()
    if (!title) return
    const base = slugify(title)
    const seen = (used.get(base) || 0) + 1
    used.set(base, seen)
    heads.push({
      level: match[1].length,
      title,
      id: seen === 1 ? base : `${base}-${seen}`,
      aliases: seen === 1 ? [base, title] : [base, title, `${base}-${seen}`],
      line: index
    })
  })
  return heads
}

/** 从 Markdown 抽标题（1—6 级；publish 的目录只用 2—4 级，这里要能按任意小节截取）。 */
export function extractHeadings(markdown = '') {
  return scanHeadings(String(markdown ?? '').split('\n')).map(({ level, title, id }) => ({ level, text: title, id }))
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
  const heads = scanHeadings(lines)
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
  // 先按 id（含重复标题的 -2/-3 后缀），再按别名（原始 slug 与标题）——
  // 别名让"课程概览"这种重复标题仍然能找到第一节，而 `课程概览-2` 精确命中第二节。
  const byId = sections.find(section => section.id === target || section.id === key)
  if (byId) return byId
  const byAlias = sections.find(section =>
    (section.aliases || []).some(alias => String(alias).normalize('NFKC').toLowerCase() === key))
  if (byAlias) return byAlias
  const exact = sections.find(section => section.title.normalize('NFKC').toLowerCase() === key)
  if (exact) return exact
  return sections.find(section => section.title.normalize('NFKC').toLowerCase().includes(key)) || null
}

/** 内容指纹：FNV-1a 32 位 → 8 位十六进制（够短、够稳，用来判断"这段正文还是不是那段"）。 */
export function fingerprintOf(text = '') {
  const value = String(text ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 全量小节索引：每一节的 id / 标题 / 层级 / 字数 / **内容指纹**。
 *
 * 为什么要有它：检索与"取正文"必须指到同一处。索引里带指纹，就能在拿到正文后确认
 * "这一节还是索引里那一节"（发布后小节被改过、或索引过期时，指纹对不上就重新定位），
 * 而不是拿一个过期的 id 去锚定读者。索引不含正文，所以放进公开索引也不会把整库正文
 * 塞进 /api/notes。
 */
export function sectionIndex(markdown = '') {
  return splitSections(markdown).filter(section => section.title).map(section => ({
    id: section.id,
    title: section.title,
    level: section.level,
    aliases: section.aliases || [],
    // trim 后计算：publish 侧（sectionIndex）也是这么算的，两边必须给出同一个指纹，
    // 否则"索引里的这一节"与"正文里的这一节"永远对不上。
    chars: String(section.ownBody || '').trim().length,
    fingerprint: fingerprintOf(String(section.ownBody || '').trim())
  }))
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
