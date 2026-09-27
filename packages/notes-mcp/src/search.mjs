import { lessonDateOf, splitSections } from './records.mjs'
import { corpusTerms, fuzzyTerms, normalizeText, queryTerms } from './query.mjs'

/**
 * 词面检索的打分：一个词值多少钱 = 字段权重 × 词本身的权重 × 这个词在语料里有多稀有（IDF）。
 *
 * 为什么要有 IDF：中文 2-gram 里"资本""成本"这种词到处都是，而"资产专用性""以刑制罪"
 * 只在一节课出现。只看"命中次数"会让泛词把专名压下去——线上真出现过"法人人格否认"
 * 命中了另一节课。IDF 让"只有这一节在讲的词"起决定作用。
 *
 * 字段权重延续旧实现的直觉：标题/主题/关键词 > 概念/法条/案例 > 摘要 > 正文。
 * 同一个词出现在标题里，更可能是"这一节就在讲它"。
 */
export const FIELD_SPECS = [
  { kind: '标题', weight: 12, values: record => [record.lessonTitle, ...record.headings.map(head => head.text)] },
  { kind: '主题', weight: 10, values: record => [record.theme] },
  { kind: '关键词', weight: 9, values: record => [...record.keywords, ...record.metadata.keywords] },
  { kind: '概念', weight: 8, bucket: 'concepts', values: record => record.metadata.concepts },
  { kind: '法条', weight: 8, bucket: 'statutes', values: record => record.metadata.statutes },
  { kind: '案例', weight: 8, bucket: 'cases', values: record => record.metadata.cases },
  { kind: '摘要', weight: 4, values: record => [record.summary, record.brief?.briefing, ...(record.brief?.keyPoints || [])] },
  { kind: '课程', weight: 3, values: record => [record.courseName, record.teacher] }
]
const BODY_WEIGHT = 2
const MAX_SNIPPETS = 3
const SNIPPET_RADIUS = 56

/** 元数据侧的全部文字（不含正文）：IDF 与"是否命中"都以它为底。 */
export function metadataHaystack(record = {}) {
  return normalizeText(FIELD_SPECS.flatMap(spec => spec.values(record)).flat().filter(Boolean).join('\n'))
}

/** 大小写无关的命中位置（最多 8 处：同一个词刷屏没有意义）。 */
export function findMatches(text, needle) {
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
export function snippetAround(text, at, length, radius = SNIPPET_RADIUS) {
  const source = String(text ?? '')
  const start = Math.max(0, Math.min(at, source.length))
  const end = Math.min(source.length, start + Math.max(1, length))
  const before = source.slice(Math.max(0, start - radius), start)
  const hit = source.slice(start, end)
  const after = source.slice(end, Math.min(source.length, end + radius))
  return `${start > radius ? '…' : ''}${before}「${hit}」${after}${end + radius < source.length ? '…' : ''}`
}

/**
 * 用标题定位小节：命中的是关键词/概念时（没有术语锚点），也能指出"对应哪一节"。
 *
 * 靠的是发布时就算好的 headings（含锚点 id），不必读正文——远程数据源因此不会为了
 * "给个位置"而逐篇下载 Markdown。命中词最多的那一节就是答案；一个都没命中就返回 null。
 */
export function locateByHeading(record = {}, terms = []) {
  let best = null
  for (const heading of record.headings || []) {
    const text = String(heading?.text || '')
    if (!text) continue
    let score = 0
    for (const { term, weight } of terms) {
      if (text.includes(term)) score += weight * Math.min([...term].length, 6)
    }
    if (score > 0 && (!best || score > best.score)) best = { title: text, id: String(heading.id || ''), score }
  }
  return best ? { title: best.title, id: best.id } : null
}

/**
 * 单条记录打分。
 *
 * terms 来自 queryTerms（含 n-gram），idf 由调用方按**当前搜索范围**算好——
 * 同一节课在不同范围的"稀有度"不同，范围以外不该影响排序。
 */
export function scoreRecord({ record = {}, terms = [], idf = () => 1, markdown = '', includeBody = false } = {}) {
  const matchedTerms = new Set()
  const kindScores = new Map()
  const snippets = []
  let location = null

  for (const spec of FIELD_SPECS) {
    for (const value of spec.values(record)) {
      const fieldText = String(value ?? '')
      if (!fieldText) continue
      let fieldScore = 0
      for (const { term, weight } of terms) {
        const occurrences = findMatches(fieldText, term)
        if (!occurrences.length) continue
        matchedTerms.add(term)
        fieldScore += spec.weight * weight * idf(term) * Math.min(occurrences.length, 3)
        if (snippets.length < MAX_SNIPPETS) {
          const at = occurrences[0]
          snippets.push(snippetAround(fieldText, at, term.length))
        }
      }
      if (!fieldScore) continue
      kindScores.set(spec.kind, (kindScores.get(spec.kind) || 0) + fieldScore)
      // 术语桶（概念/法条/案例）带锚点：命中的是"某一节"，位置比整篇更有用
      if (spec.bucket && !location) {
        const id = record?.anchors?.[spec.bucket]?.[String(value).trim()]
        if (id) {
          const heading = record.headings.find(item => item.id === id)
          location = { title: heading?.text || '', id }
        }
      }
    }
  }

  let bodyScore = 0
  let bestSection = null
  if (includeBody && markdown) {
    for (const section of splitSections(markdown)) {
      const bodyText = String(section.ownBody || '')
      if (!bodyText) continue
      let sectionScore = 0
      const sectionTerms = new Set()
      for (const { term, weight } of terms) {
        const occurrences = findMatches(bodyText, term)
        if (!occurrences.length) continue
        sectionTerms.add(term)
        sectionScore += BODY_WEIGHT * weight * idf(term) * Math.min(occurrences.length, 3)
        if (snippets.length < MAX_SNIPPETS) snippets.push(snippetAround(bodyText.replace(/\s+/g, ' '), occurrences[0], term.length))
      }
      if (!sectionScore) continue
      // 正文命中按"命中词数"再压一档：散落在一个词上的长小节不该压过标题命中
      sectionScore *= 1 + Math.min(sectionTerms.size, 4) * 0.15
      bodyScore += sectionScore
      sectionTerms.forEach(term => matchedTerms.add(term))
      if (!bestSection || sectionScore > bestSection.score) {
        bestSection = { title: section.title, id: section.id, score: sectionScore }
      }
    }
  }
  if (bestSection) {
    location = { title: bestSection.title, id: bestSection.id }
  } else if (!location) {
    // 只命中关键词/概念时：用标题定位，别让调用方自己去猜是哪一节
    location = locateByHeading(record, terms.filter(item => matchedTerms.has(item.term)))
  }

  const kinds = [...kindScores.entries()].sort((left, right) => right[1] - left[1]).map(([kind]) => kind)
  if (bodyScore > 0) kinds.push('正文')
  return {
    score: [...kindScores.values()].reduce((sum, value) => sum + value, 0) + bodyScore,
    kinds,
    kind: kinds[0] || '正文',
    matchedTerms,
    location,
    snippets: [...new Set(snippets)].slice(0, MAX_SNIPPETS),
    bodyScore
  }
}

/**
 * 命中门槛：多词查询不能因为"沾到一个 n-gram"就算命中，否则排序会被噪声淹掉。
 * 至少覆盖 1/3 的词，或者命中了一个足够稀有的词（只在一两节课出现的专名）。
 */
export function isConfidentHit({ matchedTerms, terms, idf = () => 1 }) {
  if (!matchedTerms.size) return false
  const substantive = terms.filter(item => idf(item.term) >= 0.9)
  if (substantive.some(item => matchedTerms.has(item.term))) return true
  return matchedTerms.size >= Math.max(1, Math.ceil(terms.length / 3))
}

/**
 * 一次检索的完整流程：解析查询 → 元数据打分 → （必要时）扫正文 → 排序 → 零命中时错别字回退。
 *
 * 两条与旧实现不同的行为，都是"宁可多找一步，不要答不上来"：
 *   · includeBody=false 但元数据一条都没命中时，**自动再扫一遍正文**并把 bodyScanned 标出来。
 *     内容类问题（"为什么企业会存在"）在标题里根本没有对应的词，只查元数据必然空手而归；
 *   · 一条都没命中时，用语料里真实出现过的词做编辑距离 1 的回退（主义↔主意），
 *     并把 fuzzy 与替换后的词一起返回——模型应当知道这次是"猜着匹配"的。
 */
export async function searchRecords({ records = [], query = '', includeBody = false, readMarkdown, limit = 8 } = {}) {
  const terms = queryTerms(query)
  if (!terms.length) return { terms: [], fuzzy: [], fuzzyTerms: [], bodyScanned: false, bodySkipped: 0, scanned: records.length, total: 0, hits: [] }

  const haystacks = new Map(records.map(record => [record.slug, metadataHaystack(record)]))
  // df：这个词出现在几节课里。IDF 由它推出来；错别字判断也看它——
  // "语料里根本没有这个词"（df=0）才可能是写错了，而 idf 恒大于 0，用它判断等于永不启用回退。
  const df = term => records.filter(record => haystacks.get(record.slug).includes(term)).length
  const idf = term => Math.log(1 + records.length / (1 + df(term)))

  const run = async (activeTerms, { scanBody }) => {
    const hits = []
    let bodySkipped = 0
    for (const record of records) {
      let markdown = ''
      if (scanBody) {
        markdown = record.markdown === undefined ? '' : record.markdown
        if (record.markdown === undefined && readMarkdown) {
          try {
            markdown = await readMarkdown(record.slug)
          } catch {
            bodySkipped += 1
            markdown = ''
          }
        }
      }
      const scored = scoreRecord({ record, terms: activeTerms, idf, markdown, includeBody: scanBody })
      if (!isConfidentHit({ matchedTerms: scored.matchedTerms, terms: activeTerms, idf }) || scored.score <= 0) continue
      hits.push({
        slug: record.slug,
        courseName: record.courseName,
        lessonTitle: record.lessonTitle,
        lessonDate: lessonDateOf(record),
        kind: scored.kind,
        kinds: scored.kinds,
        location: scored.location,
        snippets: scored.snippets,
        score: Math.round(scored.score * 100) / 100
      })
    }
    hits.sort((left, right) =>
      right.score - left.score ||
      String(right.lessonDate).localeCompare(String(left.lessonDate)) ||
      String(left.slug).localeCompare(String(right.slug)))
    return { hits, bodySkipped }
  }

  let active = terms
  let fuzzy = []
  let fuzzyUsed = []
  let bodyScanned = includeBody
  let result = await run(active, { scanBody: includeBody })
  if (!result.hits.length && !includeBody) {
    bodyScanned = true
    result = await run(active, { scanBody: true })
  }
  if (!result.hits.length) {
    // 错别字回退：只用语料里出现过的词做替换，绝不凭空造词
    const candidates = corpusTerms(records)
    const replaced = new Map()
    for (const item of terms) {
      if (df(item.term) > 0) continue // 语料里本来就有这个词：不是错别字问题
      const variants = fuzzyTerms(item.term, candidates)
      if (!variants.length) continue
      replaced.set(item.term, variants[0])
    }
    if (replaced.size) {
      fuzzy = [...replaced.entries()].map(([from, to]) => ({ from, to }))
      const variants = new Set(replaced.values())
      active = [...terms.filter(item => !replaced.has(item.term)), ...[...variants].map(term => ({ term, weight: 1 }))]
      fuzzyUsed = [...variants]
      if (!bodyScanned) bodyScanned = true
      result = await run(active, { scanBody: true })
    }
  }
  return {
    terms: active.map(item => item.term),
    fuzzy,
    fuzzyTerms: fuzzyUsed,
    bodyScanned,
    bodySkipped: result.bodySkipped,
    scanned: records.length,
    total: result.hits.length,
    hits: result.hits
  }
}

