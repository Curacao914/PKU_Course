import { CancelledError } from './errors.mjs'
import { fingerprintOf, lessonDateOf, splitSections } from './records.mjs'
import { corpusTerms, fuzzyTerms, normalizeText, queryTerms, requiredUnits } from './query.mjs'

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
// auto 覆盖下"正文已在内存里就直接用来打分"的上限：发布库整库正文都在内存里，
// 但索引查询不该变成"每次都把整库扫一遍"。超过这个量就退回纯索引 + 必要时下沉。
const MEMORY_BODY_CAP = 2_000_000

/** 取片段里被高亮的那一段及其左右 16 字（去空白）——用来判断两个片段是不是同一句话。 */
function coreWindowOf(snippet) {
  // 去掉高亮标记与空白：同一个句子被不同 n-gram 命中时，差别只在「」的位置，
  // 留着标记会让"同一句"看起来不像同一句。取命中点前后各 16 字，切成正文片段。
  const text = String(snippet ?? '').replace(/[「」]/g, '')
  const match = String(snippet ?? '').match(/「([^」]*)」/)
  const at = match ? String(snippet ?? '').indexOf(match[0]) : 0
  const head = String(snippet ?? '').slice(0, at).replace(/[「」\s…]/g, '').length
  const plain = text.replace(/[\s…]/g, '')
  return plain.slice(Math.max(0, head - 16), head + 32)
}

/**
 * 两个片段是不是在讲同一句话：**去掉高亮标记后**找一段共同的 12 字连续文本。
 *
 * 为什么不用"包含"判断：同一个句子被 "共同行为" 和它的碎片 "共同行"/"同行为" 命中时，
 * 高亮位置相差一两个字，谁都不包含谁——按偏移比较会漏掉，按"有没有一段共同长文本"才抓得住。
 */
function snippetsOverlap(left, right) {
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (!shorter) return true
  if (longer.includes(shorter)) return true
  const size = 12
  if (shorter.length < size) return longer.includes(shorter)
  for (let index = 0; index + size <= shorter.length; index += 1) {
    if (longer.includes(shorter.slice(index, index + size))) return true
  }
  return false
}

/**
 * 片段去重。
 *
 * 为什么要它：中文查询会切成 2—4 字 n-gram，"共同行为"会同时命中"共同""同行""行为"
 * 这些碎片——不去重的话同一句话会被高亮三次，三条片段说的是同一件事，读者以为命中了三处。
 * 规则：先看**长词**（信息量大），与已保留片段基本重叠的直接丢掉。
 */
export function dedupeSnippets(candidates = [], limit = MAX_SNIPPETS) {
  const sorted = [...candidates].sort((left, right) => [...String(right.term || '')].length - [...String(left.term || '')].length)
  const kept = []
  for (const item of sorted) {
    const text = String(item.text || '')
    if (!text) continue
    const core = coreWindowOf(text)
    if (kept.some(existing => snippetsOverlap(existing.core, core))) continue
    kept.push({ text, core })
    if (kept.length >= limit) break
  }
  return kept.map(item => item.text)
}

/**
 * 取消检查点。
 *
 * 为什么要有：客户端断开（浏览器取消、代理超时）或超出时间预算时，调用方已经不要结果了，
 * 但检索还会把剩下的课次（远程数据源下还要逐篇下载正文）算完——那是白烧 CPU 与带宽。
 * 同步打分本身不可抢占，所以检查点放在"课次之间"与"远程读取前后"：单条记录的打分有界，
 * 最坏情况是当前这一条算完就退出（search_notes 的耗时因此可预期）。
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancelledError()
}

/**
 * 每处理这么多条记录让出一次事件循环。
 *
 * 为什么必须让：本地发布库的全文检索是**纯同步**循环（markdown 就在记录里，没有 await），
 * 不让出的话它会把整个进程卡住——站点上"一个人搜索"就等于"所有人的页面都慢"，
 * 而且 setTimeout 排不上队，超时预算与取消信号都永远不会生效。让出一次的开销是微秒级，
 * 换来的是：取消/超时真的能打断检索，静态页面也不再被检索堵住。
 */
const YIELD_EVERY = 25
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve))

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
  // 优先用发布时算好的小节索引：它按"同名标题加 -2/-3"去过重，id 与页面上锚点一致，
  // 还带内容指纹（拿到正文时可以核对"这一节还是不是那一节"）。
  const headings = (Array.isArray(record.sections) && record.sections.length ? record.sections : record.headings) || []
  for (const heading of headings) {
    const text = String(heading?.text || '')
    if (!text) continue
    let score = 0
    for (const { term, weight } of terms) {
      if (text.includes(term)) score += weight * Math.min([...term].length, 6)
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { title: text, id: String(heading.id || ''), score, fingerprint: String(heading.fingerprint || '') }
    }
  }
  return best ? { title: best.title, id: best.id, ...(best.fingerprint ? { fingerprint: best.fingerprint } : {}) } : null
}

/**
 * 单条记录打分。
 *
 * terms 来自 queryTerms（含 n-gram），idf 由调用方按**当前搜索范围**算好——
 * 同一节课在不同范围的"稀有度"不同，范围以外不该影响排序。
 */
export function scoreRecord({ record = {}, terms = [], idf = () => 1, markdown = '', includeBody = false } = {}) {
  const matchedTerms = new Set()
  // 元数据侧命中与"最佳小节"命中分开记：长正文里"行为""共同"这种碎片到处都有，
  // 散落在各节的弱命中堆起来会让每节课都"命中"，那就等于没检索。
  const metadataTerms = new Set()
  let sectionTerms = new Set()
  const kindScores = new Map()
  // 片段先收集候选（带命中的词），最后统一去重：不这样的话同一句话会被三个 n-gram 各高亮一次
  const snippetCandidates = []
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
        metadataTerms.add(term)
        fieldScore += spec.weight * weight * idf(term) * Math.min(occurrences.length, 3)
        snippetCandidates.push({ text: snippetAround(fieldText, occurrences[0], term.length), term })
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
  // 一节可以命中多处：**按小节打分**而不是只留最高分那一节。
  // 指纹取自 record.sections（发布时算好的），没有就用本地正文现算——两处算法一致。
  const publishedSections = new Map((record.sections || []).map(item => [String(item.id), item]))
  const sectionHits = []
  if (includeBody && markdown) {
    for (const section of splitSections(markdown)) {
      const bodyText = String(section.ownBody || '')
      if (!bodyText) continue
      let sectionScore = 0
      const sectionTerms = new Set()
      const candidates = []
      for (const { term, weight } of terms) {
        const occurrences = findMatches(bodyText, term)
        if (!occurrences.length) continue
        sectionTerms.add(term)
        sectionScore += BODY_WEIGHT * weight * idf(term) * Math.min(occurrences.length, 3)
        candidates.push({ text: snippetAround(bodyText.replace(/\s+/g, ' '), occurrences[0], term.length), term })
      }
      if (!sectionScore) continue
      // 正文命中按"命中词数"再压一档：散落在一个词上的长小节不该压过标题命中
      sectionScore *= 1 + Math.min(sectionTerms.size, 4) * 0.15
      bodyScore += sectionScore
      sectionTerms.forEach(term => matchedTerms.add(term))
      snippetCandidates.push(...candidates)
      const own = bodyText.trim()
      sectionHits.push({
        id: section.id,
        title: section.title,
        level: section.level,
        score: sectionScore,
        terms: [...sectionTerms],
        snippets: dedupeSnippets(candidates, 2),
        fingerprint: publishedSections.get(String(section.id))?.fingerprint || fingerprintOf(own)
      })
      if (!bestSection || sectionScore > bestSection.score) {
        bestSection = { title: section.title, id: section.id, score: sectionScore, terms: sectionTerms }
      }
    }
    // 高分在前；同分按文档顺序（先出现的先讲）——读者顺着读更自然
    sectionHits.sort((left, right) => right.score - left.score)
  }
  if (bestSection) {
    const best = sectionHits.find(item => item.id === bestSection.id)
    location = {
      title: bestSection.title,
      id: bestSection.id,
      ...(best?.fingerprint ? { fingerprint: best.fingerprint } : {})
    }
    sectionTerms = bestSection.terms
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
    metadataTerms,
    sectionTerms,
    location,
    snippets: dedupeSnippets(snippetCandidates),
    sectionHits,
    bodyScore
  }
}

/**
 * 命中门槛：多词查询不能因为"沾到一个 n-gram"就算命中，否则排序会被噪声淹掉。
 * 至少覆盖 1/3 的词，或者命中了一个足够稀有的词（只在一两节课出现的专名）。
 */
export function isConfidentHit({ matchedTerms = new Set(), metadataTerms, sectionTerms = new Set(), terms = [], idf = () => 1 }) {
  if (!matchedTerms.size) return false
  /**
   * 什么才算"这一节真的在讲这个查询"：
   *   · 元数据命中（标题/主题/关键词/概念/法条/案例/摘要）——写这些字段就是为了概括内容；
   *   · 或者**同一个小节里**至少命中两个词——正文的局部浓度说明这一节在讲它。
   * 只凭"某个碎片在长正文里出现过"不算：那种命中会让每节课都上榜（实测"共同行为"
   * 一度命中 9 篇里的 9 篇，"行为"两个字到处都有）。这层收紧之后只剩真正相关的几篇。
   */
  const strong = new Set(metadataTerms || matchedTerms)
  if (sectionTerms.size >= 2) sectionTerms.forEach(term => strong.add(term))
  if (!strong.size) return false

  // 权重与名字：内容词 = 空格分开的词 / 整段短语（weight > 0.9），碎片是 n-gram（0.9）。
  const weightOf = item => Number(typeof item === 'string' ? 1 : (item?.weight ?? 1))
  const nameOf = item => String(typeof item === 'string' ? item : (item?.term || ''))
  const contentTerms = terms.filter(item => weightOf(item) > 0.9).map(nameOf)

  /**
   * 三档，任何一档成立就算命中（顺序即优先级）：
   *   ① 命中了一个**内容词**——最可靠。以前按"命中词数 / 全部词数（含碎片）"算覆盖率，
   *      查询越长碎片越多、门槛越高："归因 完全不存在的词"里明明命中了"归因"，
   *      却因为其余碎片没命中而被整体否掉。n-gram 是加分项，不能变成硬性门槛。
   *   ② 命中了一个足够稀有的词（只在一两节出现的专名）。
   *   ③ 同一小节里命中一个三字以上的片段（局部浓度）——两三个字的碎片不算：
   *      中文 2-gram 里"共同""行为"到处都有，堆在一起也说明不了什么。
   */
  if (contentTerms.some(term => strong.has(term))) return true
  if ([...strong].some(term => idf(term) >= 0.9)) return true
  return [...strong].some(term => [...String(term)].length >= 3)
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
export async function searchRecords({
  records = [],
  query = '',
  // includeBody 是历史参数，等价于 coverage: 'body'（保留它，老调用方不用改）
  includeBody,
  // 覆盖策略：'auto'（默认）/ 'index' / 'body'——**三个入口共用这一套默认**，
  // 这样同一句话在站点搜索、MCP 专用检索、OpenAI 标准 search 里召回完全一致。
  //   index：只查元数据 + 小节索引，不碰正文（远程数据源下就是零下载）
  //   body ：连正文一起打分（远程数据源会逐篇取正文）
  //   auto ：先用索引（正文若已在内存里就顺带用上），一条都没命中才下沉到正文
  coverage,
  readMarkdown,
  limit = 8,
  // 一节课最多报几处小节命中：不做配额的话，一篇长笔记会靠"到处都沾一点"占满整页结果
  perNoteSections = 2,
  signal
} = {}) {
  throwIfAborted(signal)
  const mode = coverage || (includeBody ? 'body' : 'auto')
  const terms = queryTerms(query)
  if (!terms.length) return { terms: [], fuzzy: [], fuzzyTerms: [], bodyScanned: false, bodySkipped: 0, scanned: records.length, total: 0, hits: [] }

  const haystacks = new Map(records.map(record => [record.slug, metadataHaystack(record)]))
  // df：这个词出现在几节课里。IDF 由它推出来；错别字判断也看它——
  // "语料里根本没有这个词"（df=0）才可能是写错了，而 idf 恒大于 0，用它判断等于永不启用回退。
  const df = term => records.filter(record => haystacks.get(record.slug).includes(term)).length
  const idf = term => Math.log(1 + records.length / (1 + df(term)))

  /**
   * 词一级单元（≤6 字、无空格）要求"真的出现"。对不上时就近邻一次（错别字回退），
   * 近邻也找不到 → 这条查询在语料里就是没有，返回 0 条比返回一堆碎片命中诚实。
   */
  const candidates = corpusTerms(records)
  const unitVariants = new Map()
  for (const unit of requiredUnits(query)) {
    const variants = [unit]
    if (!records.some(record => haystacks.get(record.slug).includes(unit))) {
      const near = fuzzyTerms(unit, candidates)
      if (near.length) variants.push(near[0])
    }
    unitVariants.set(unit, variants)
  }
  const satisfiesRequired = (record, markdown) => {
    if (!unitVariants.size) return true
    const text = `${haystacks.get(record.slug) || ''}\n${normalizeText(markdown || '')}`
    return [...unitVariants.values()].every(variants => variants.some(variant => text.includes(variant)))
  }

  const run = async (activeTerms, { scanBody, useMemoryBody = false }) => {
    const hits = []
    let bodySkipped = 0
    let processed = 0
    for (const record of records) {
      throwIfAborted(signal)
      if (processed > 0 && processed % YIELD_EVERY === 0) {
        await yieldToEventLoop()
        throwIfAborted(signal)
      }
      processed += 1
      let markdown = ''
      if (scanBody || useMemoryBody) {
        markdown = record.markdown === undefined ? '' : record.markdown
        if (record.markdown === undefined && scanBody && readMarkdown) {
          try {
            markdown = await readMarkdown(record.slug, { signal })
          } catch (error) {
            // 取消要往上抛（那是"调用方不要了"），只有"这一篇读不到"才降级跳过
            if (error instanceof CancelledError) throw error
            bodySkipped += 1
            markdown = ''
          }
        }
      }
      if (!satisfiesRequired(record, markdown)) continue
      const scored = scoreRecord({ record, terms: activeTerms, idf, markdown, includeBody: scanBody || useMemoryBody })
      if (!isConfidentHit({
        matchedTerms: scored.matchedTerms,
        metadataTerms: scored.metadataTerms,
        sectionTerms: scored.sectionTerms,
        terms: activeTerms,
        idf
      }) || scored.score <= 0) continue
      hits.push({
        slug: record.slug,
        courseName: record.courseName,
        lessonTitle: record.lessonTitle,
        lessonDate: lessonDateOf(record),
        // 站点搜索页与 MCP 都靠这几个字段判断"要不要点进去"，所以在检索层就给全
        theme: record.theme || '',
        keywords: (record.keywords || []).slice(0, 6),
        kind: scored.kind,
        kinds: scored.kinds,
        location: scored.location,
        snippets: scored.snippets,
        // 一篇里命中的多个小节（去重、按分数、受 perNoteSections 配额限制）。
        // 前端可以显示"命中 3 处"，也可以只锚定第一节；模型则知道该读哪几节。
        sections: (scored.sectionHits || []).slice(0, Math.max(1, perNoteSections)).map(item => ({
          id: item.id,
          title: item.title,
          score: Math.round(item.score * 100) / 100,
          snippets: item.snippets,
          fingerprint: item.fingerprint || ''
        })),
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
  // auto：正文已经在记录里（本地发布库就是这样）且总量可控时，第一遍就顺带用上——
  // 不额外下载、也不额外读盘，召回与"扫正文"完全一样；远程数据源没有正文，就纯索引。
  const memoryBodyChars = records.reduce((sum, record) => sum + String(record.markdown || '').length, 0)
  const useMemoryBody = mode === 'auto' && memoryBodyChars > 0 && memoryBodyChars <= MEMORY_BODY_CAP
  let bodyScanned = mode === 'body' || useMemoryBody
  // escalated = "索引一条都没命中，只好下沉到正文"。与 bodyScanned 分开是有意的：
  // 本地发布库的正文就在内存里，auto 第一遍就会用到它（bodyScanned=true），但那不是
  // "索引答不上来"——页面上那行"本次连正文一起检索"说的是后者，混用会让每句话都提示。
  let escalated = false
  let result = await run(active, { scanBody: mode === 'body', useMemoryBody })
  throwIfAborted(signal)
  // 只有 auto 才下沉：coverage:'index' 是调用方明确要求"别碰正文"（远程数据源下等于零下载），
  // 替它下沉等于违背调用意图；coverage:'body' 本来就一直在正文里找。
  if (!result.hits.length && mode === 'auto') {
    escalated = true
    bodyScanned = true
    result = await run(active, { scanBody: true })
  }
  if (!result.hits.length) {
    throwIfAborted(signal)
    // 错别字回退：只用语料里出现过的词做替换，绝不凭空造词
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
  // 词一级单元的近似替换也要报出来（render 与搜索页会显示"按近似词检索：A→B"）：
  // 猜着匹配却不说，比不命中更糟。
  const unitFuzzy = [...unitVariants.entries()]
    .filter(([, variants]) => variants.length > 1)
    .map(([from, variants]) => ({ from, to: variants[1] }))
  const seenFuzzy = new Set()
  const fuzzyReport = [...unitFuzzy, ...fuzzy].filter(item => {
    const key = `${item.from}→${item.to}`
    if (seenFuzzy.has(key)) return false
    seenFuzzy.add(key)
    return true
  })
  return {
    terms: active.map(item => item.term),
    fuzzy: fuzzyReport,
    fuzzyTerms: fuzzyUsed,
    // 这次实际用到哪一层：调用方（站点页、MCP、render）据此说明"本次检索的范围"
    coverage: bodyScanned ? 'body' : 'index',
    bodyScanned,
    escalated,
    bodySkipped: result.bodySkipped,
    scanned: records.length,
    total: result.hits.length,
    hits: result.hits
  }
}

