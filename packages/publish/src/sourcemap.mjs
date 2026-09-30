import { markdownChecksum } from './derived.mjs'
import { blockIdOf, plainBlockText, sectionTexts } from './markdown.mjs'

/**
 * 一页纸 → 原文的来源映射。
 *
 * 要解决的问题很具体：读者在一页纸上看到一个概念区分、规则或表格结论，想知道**依据在哪**，
 * 现在只能自己回整篇笔记里找。来源映射给出的就是这一跳，以及跳回来时回到原处。
 *
 * 几条纪律（都来自任务书）：
 *   · 复用现状：小节 id、URL 生成、指纹口径都用既有的，不另建一套知识库；
 *     映射只是 onepage.json 里一个轻量结构。
 *   · URL 由程序拼，模型只许从**给定的**小节 id 里挑（选了不存在的 = 这条映射作废）。
 *   · "小节存在"只证明链接有效，**不证明它支撑这个要点**：所以每条映射都要带一小段
 *     源文摘录，发布前逐字核对"这段摘录确实在这一节里"。
 *   · 核对不过就丢掉这条映射，退回"查看整篇笔记"——**绝不生成看着精确的错误链接**；
 *     未定位不阻塞阅读，也不阻塞其它笔记发布。
 *   · 指纹沿用规范化口径（markdownChecksum / 块指纹），不混用原始字节 hash。
 */
export const SOURCE_MAP_VERSION = 1
/** 摘录最短长度：短于它的"重合"多半是套话（"共同犯罪"这种词到处都是），不能当证据。 */
export const QUOTE_MIN_CHARS = 8
/** 免费路径认定"唯一对应"所需的最短逐字重合长度。 */
export const OVERLAP_MIN_CHARS = 12

const normalize = value => String(value ?? '').replace(/\s+/g, '')

/**
 * 块的类型：决定它在页面上长什么样，也决定要不要给它配来源入口。
 *
 * 这里有个踩过的坑：**"标题 + 内容"要算有内容的块**，不能算纯标题。
 * 一页纸常用这种写法（`### 一、课程定位\n- 范围：…`，标题与列表之间没有空行）——
 * 早先只看首行，整块被当成 heading 排除在映射之外，于是那种页面一条「看原文」都配不上
 * （真实课次：刑事执行法 09-07 全篇 6 块皆如此 → 0/6；样板课 09-21 有 8 块如此）。
 */
function blockKind(text) {
  const lines = String(text).split('\n')
  const first = lines[0].trim()
  const rest = lines.slice(1).join('\n').trim()
  if (/^#{1,6}\s/.test(first)) return rest ? 'section' : 'heading'
  if (/^\|/.test(first)) return 'table'
  if (/^\s*([-*]|\d+[.、)])\s/.test(first)) return 'list'
  if (/^\s*>/.test(first)) return 'quote'
  return 'text'
}

/**
 * 一页纸的块序列——**渲染与映射用的是同一份切法**（onepage.mjs 调它来包 data-ob）。
 *
 * 按空行切；相邻的表格/列表块合并：模型偶尔会在表格行之间空一行，切开会让同一个问题
 * 变成两条独立映射，读者看到两个"看原文"，反而更乱。
 */
export function onepageBlocks(markdown) {
  const parts = String(markdown ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  const merged = []
  for (const raw of parts) {
    const text = raw.replace(/\s+$/, '').trim()
    if (!text) continue
    const kind = blockKind(text)
    const last = merged[merged.length - 1]
    if (last && last.kind === kind && (kind === 'table' || kind === 'list')) {
      last.text += '\n' + text
      continue
    }
    merged.push({ kind, text })
  }
  const used = new Map()
  return merged.map(block => {
    const base = blockIdOf(block.text)
    const seen = (used.get(base) || 0) + 1
    used.set(base, seen)
    return { id: seen === 1 ? base : `${base}-${seen}`, kind: block.kind, text: block.text }
  })
}

/** 一节正文里的句子（长句优先），用来给弱匹配档挑一句"确实在这一节里"的原话。 */
function sortedSentences(body) {
  return normalize(body)
    .split(/[。；;！!？?]/)
    .filter(sentence => sentence.length >= QUOTE_MIN_CHARS)
    .sort((left, right) => right.length - left.length)
}

/** 摘录是否**逐字**在这一节里（忽略空白与换行：Markdown 的折行不是内容差异）。 */
export function quoteInSection(quote, body) {
  const needle = normalize(quote)
  if (needle.length < QUOTE_MIN_CHARS) return false
  return normalize(body).includes(needle)
}

/**
 * 把模型给的"块提示"解析成真正的块 ID。
 *
 * 模型看到的是 Markdown，不可能知道我们自己按内容算出来的 ob-xxxx；所以它给的是一小段
 * **块内原文**，程序在块序列里找唯一一个以它开头（或整段包含它）的块。
 * 找不到、或者撞上不止一块，这条就作废——宁可少一条映射，也不许指错块。
 */
export function resolveSourceMapEntries(entries = [], onepageMarkdown = '') {
  const blocks = onepageBlocks(onepageMarkdown)
  const resolved = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const hint = normalize(entry?.block || entry?.blockHint || '')
    if (!hint) continue
    const matched = blocks.filter(block => {
      const flat = normalize(plainBlockText(block.text))
      return flat.startsWith(hint) || flat.includes(hint)
    })
    if (matched.length !== 1) continue
    resolved.push({ ...entry, block: matched[0].id })
  }
  return resolved
}

/**
 * 发布前核对一份映射。
 *
 * 三种情况分开：
 *   · 版本对不上（正文或一页纸改过）→ **整份不用**，所有块退回整篇入口；
 *   · 单条对不上（块没了、小节没了、摘录不在那一节）→ 丢掉这一条，其余照用；
 *   · 全对 → 原样返回，附每个块的块类型（页面据此决定入口样式）。
 */
export function verifySourceMap(sourceMap, { slug = '', noteMarkdown = '', onepageMarkdown = '', sections = null } = {}) {
  const problems = []
  const raw = sourceMap && typeof sourceMap === 'object' ? sourceMap : null
  const blocks = onepageBlocks(onepageMarkdown)
  const empty = { ok: false, bound: false, problems, entries: [], located: 0, dropped: 0, total: blocks.length }
  if (!raw) return { ...empty, problems: ['没有来源映射'] }

  // 只在**拿到了那份正文**时比指纹：渲染一侧手里只有发布库（没有正文），
  // 那里只做"块还在不在、小节还在不在"的轻核对，不该因为比不了就把整份判成失效。
  if (raw.note && raw.note.slug && slug && raw.note.slug !== slug) problems.push('映射记的是另一篇笔记')
  if (noteMarkdown && raw.note && raw.note.checksum && raw.note.checksum !== markdownChecksum(noteMarkdown)) {
    problems.push('源正文改过，映射已失效')
  }
  if (onepageMarkdown && raw.onepageChecksum && raw.onepageChecksum !== markdownChecksum(onepageMarkdown)) {
    problems.push('一页纸改过，映射已失效')
  }
  const stale = problems.length > 0

  const blockById = new Map(blocks.map(block => [block.id, block]))
  const sectionList = Array.isArray(sections) && sections.length ? sections : sectionTexts(noteMarkdown)
  const sectionById = new Map(sectionList.map(section => [section.id, section]))
  const entries = []
  let dropped = 0

  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    if (stale) { dropped += 1; continue }
    const block = blockById.get(String(entry?.block || ''))
    if (!block) { dropped += 1; problems.push(`块 ${entry?.block || '(空)'} 在现在的一页纸里找不到`); continue }
    const picked = []
    for (const link of Array.isArray(entry.sections) ? entry.sections : []) {
      const id = String(link?.id || '')
      const section = sectionById.get(id)
      if (!section) { problems.push(`小节「${id}」在源文里不存在`); continue }
      const quote = String(link?.quote || '')
      // 只有已知正文的调用方（有 body 的 sections 或直接给了 noteMarkdown）才做逐字核对
      if (section.body !== undefined && !quoteInSection(quote, section.body)) {
        problems.push(`摘录不在小节「${section.title || id}」里`)
        continue
      }
      picked.push({
        id,
        title: section.title || String(link?.title || ''),
        quote,
        // 这一条是怎么定下来的：逐字引用（quote）还是块里点了节名（title）
        match: String(link?.match || 'quote'),
        excerpt: String(link?.excerpt || quote).replace(/\s+/g, ' ').slice(0, 80)
      })
    }
    if (!picked.length) { dropped += 1; continue }
    entries.push({ block: block.id, label: String(entry?.label || '').slice(0, 40), kind: block.kind, sections: picked.slice(0, 4) })
  }

  return { ok: entries.length > 0, bound: !stale, problems, entries, located: entries.length, dropped, total: blocks.length }
}

/**
 * 免费路径：给**已经发布**的一页纸补映射。
 *
 * 只认一种情况——一页纸的某个块里，有一句话在某一节正文里**逐字出现**，而且这一节明显
 * 领先其它候选。这条规矩很保守，换来的是"标了看原文的地方，点过去真能看到那句话"。
 * 概括改写、模型归纳出来的说法一律不猜：宁可不定位，也不生成看着精确的错误链接。
 */
export function buildSourceMap({ slug = '', noteMarkdown = '', onepageMarkdown = '', minOverlap = OVERLAP_MIN_CHARS, maxSections = 3 } = {}) {
  const sections = sectionTexts(noteMarkdown)
    .map(section => ({ ...section, flat: normalize(section.body) }))
    .filter(section => section.flat.length >= minOverlap)
  const blocks = onepageBlocks(onepageMarkdown).filter(block => block.kind !== 'heading')
  const entries = []
  const problems = []

  for (const block of blocks) {
    // 先去掉 Markdown 记号（列表的 "-"、粗体的 "*"）再切句子：否则"- 减刑要经过…"整句
    // 带着那个短横线，在正文里永远找不到——一条本来能确定的映射就这么没了
    const sentences = normalize(plainBlockText(block.text))
      .split(/[。；;！!？?，,、：:（）()【】《》"'`]+/)
      .filter(sentence => sentence.length >= minOverlap)
    // 注意：这里**不能**因为"没有够长的句子"就跳过整块——第二档（块里点了节名）还要用这一块
    const scored = sections.map(section => {
      const hits = sentences.filter(sentence => section.flat.includes(sentence))
      const longest = hits.reduce((max, sentence) => Math.max(max, sentence.length), 0)
      return { section, hits, longest }
    }).filter(item => item.longest >= minOverlap)
      .sort((left, right) => (right.longest - left.longest) || (right.hits.length - left.hits.length))

    const winner = scored[0]
    const runnerUp = scored[1]
    // "唯一"的判定：领先者要比第二名明显长一截，否则宁可不定（两节都像 = 说明分不清）
    const ambiguous = runnerUp && runnerUp.longest >= Math.max(minOverlap, winner.longest - 4)
    let pick = null
    if (winner && !ambiguous) {
      const quote = winner.hits.reduce((best, sentence) => (sentence.length > best.length ? sentence : best), '')
      pick = { section: winner.section, match: 'quote', quote: quote.slice(0, 60) }
    } else {
      /**
       * 第二档：块里**原样出现了某一节的标题**（≥4 字）而且只有一个这样的节。
       *
       * 比逐字引用弱，但同样是可核对的：块自己点了这一节的名字。摘录仍然取那一节正文里的
       * 原话（发布前照旧逐字核对"摘录确实在这一节里"），所以链接不会是死链，也不会指到
       * 一节根本不含这段内容的别处。两档在数据里分开记（match），覆盖率也分开报。
       */
      const flatBlock = normalize(plainBlockText(block.text))
      const titled = sections.filter(section => {
        const title = normalize(section.title)
        // 4 个字起：中文小节标题常常就是四字（"抽样框架""变量测量"）。
        // 再短（"假释""共犯"）就太容易撞上了，宁可不定。
        return title.length >= 4 && flatBlock.includes(title)
      })
      if (titled.length === 1) {
        const body = sortedSentences(titled[0].body)[0] || normalize(titled[0].body).slice(0, 40)
        if (body && body.length >= QUOTE_MIN_CHARS) pick = { section: titled[0], match: 'title', quote: body.slice(0, 60) }
      }
    }
    if (!pick) continue
    entries.push({
      block: block.id,
      label: plainBlockText(block.text).slice(0, 40),
      note: slug,
      match: pick.match,
      sections: [{ id: pick.section.id, title: pick.section.title, quote: pick.quote, match: pick.match }],
      score: { overlap: winner ? winner.longest : 0, hits: winner ? winner.hits.length : 0, runnerUp: runnerUp ? runnerUp.longest : 0 }
    })
    if (entries.length >= 200) break
  }

  // 一个块最多 3 个来源：真综合了多节时给出列表，不随意挑一节代表全部
  const byBlock = new Map()
  for (const entry of entries.slice().sort((left, right) => right.score.overlap - left.score.overlap)) {
    const list = byBlock.get(entry.block) || []
    if (list.length >= maxSections) continue
    list.push(entry)
    byBlock.set(entry.block, list)
  }
  const merged = [...byBlock.entries()].map(([block, list]) => ({
    block,
    label: list[0].label,
    sections: list.map(item => item.sections[0])
  }))

  return {
    version: SOURCE_MAP_VERSION,
    note: { slug, checksum: markdownChecksum(noteMarkdown) },
    onepageChecksum: markdownChecksum(onepageMarkdown),
    generatedBy: 'lexical-overlap',
    entries: merged,
    problems
  }
}

/** 覆盖率：定位到几块、总共几块。**覆盖率与正确率分开报**，不合成一个数。 */
export function sourceMapStats(verified = {}) {
  const total = Number(verified.total || 0)
  const located = Number(verified.located || 0)
  const linkedSections = (verified.entries || []).reduce((sum, entry) => sum + entry.sections.length, 0)
  // 两档分开报：逐字引用（quote）与块里点了节名（title）——证据强度不一样，不许合成一个数
  const byMatch = {}
  for (const entry of verified.entries || []) {
    for (const section of entry.sections || []) {
      const key = section.match || 'quote'
      byMatch[key] = (byMatch[key] || 0) + 1
    }
  }
  return { total, located, unmapped: Math.max(0, total - located), linkedSections, byMatch }
}
