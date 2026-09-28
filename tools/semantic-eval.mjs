#!/usr/bin/env node
/**
 * 语义召回实验骨架（Phase 5.2 B1）。
 *
 * 它只做一件事：把"检索单元 → 向量 → 按查询召回"这条管道跑通并**如实报告指标与成本**，
 * 好让"要不要上语义召回"这个决定有数据、有价格，而不是凭感觉。
 *
 * 为什么默认用本地的词面近似而不是真模型：
 *   · 这个仓库的规矩是"花钱的动作要显式点头"（ASR 那边就有 COURSE_ASR_ALLOW_PAID）；
 *   · 管道（切单元、指纹缓存、评测、成本估算）与模型是两件事，先把前者跑通、用 stub 验证，
 *     换成真模型只需要实现一个 embed()；
 *   · stub 的输出**不代表语义效果**，报告里会写明这一点——拿它当"语义检索有效"的证据
 *     是最容易犯的错。
 *
 * 用法：
 *   node tools/semantic-eval.mjs [library.json] [--queries <文件.json>] [--json]
 *   PROVIDER=local-stub（默认，免费）｜dashscope｜openai（需要付费，且必须显式开闸）
 *
 * 单元 = 小节（A3 的 sections：id + 内容指纹）。指纹就是缓存键：重发一篇笔记，
 * 只有改过的小节需要重新向量化。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { splitSections } from '../packages/notes-mcp/src/records.mjs'

const argv = process.argv.slice(2)
const flag = name => argv.includes('--' + name)
const valueOf = (name, fallback = '') => {
  const at = argv.indexOf('--' + name)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const DEFAULT_LIBRARY = path.join(os.homedir(), '.course-worker', 'site', 'library.json')
const libraryFile = path.resolve(argv.find(item => !item.startsWith('--') && item.endsWith('.json')) || process.env.COURSE_LIBRARY || DEFAULT_LIBRARY)

/** 价格表（元 / 100 万 token）。价格只用于估算，真花钱之前仍要看闸门与上限。 */
const PRICES = {
  'local-stub': { label: '本地词面 stub（不产生语义效果）', cnyPerMTok: 0 },
  dashscope: { label: '通义 text-embedding-v3', cnyPerMTok: 0.5 },
  openai: { label: 'OpenAI text-embedding-3-small', cnyPerMTok: 0.15 }
}

/** 中文按 1 token ≈ 1.5 字估算（宁可高估，成本预测保守一点）。 */
const estimateTokens = text => Math.ceil(String(text || '').length / 1.5)

/** 词面近似：字符 2-gram 的哈希向量。只用来验证管道，**不是**语义模型。 */
export function localStubVector (text) {
  const vector = new Array(256).fill(0)
  const clean = String(text || '').replace(/\s+/g, '')
  for (let i = 0; i + 2 <= clean.length; i += 1) {
    const gram = clean.slice(i, i + 2)
    let hash = 0
    for (const char of gram) hash = (hash * 31 + char.codePointAt(0)) >>> 0
    vector[hash % vector.length] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

const cosine = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0)

/** 小节单元：优先用发布库里的 sections（带指纹），老库退回现切。 */
export function buildUnits (records = []) {
  const units = []
  for (const record of records) {
    const sections = Array.isArray(record.sections) && record.sections.length
      ? record.sections
      : splitSections(record.markdown || '').filter(section => section.title).map(section => ({
        id: section.id, title: section.title, level: section.level,
        chars: String(section.ownBody || '').trim().length,
        fingerprint: '',
        body: String(section.ownBody || '').trim()
      }))
    for (const section of sections) {
      const body = section.body !== undefined ? section.body : sectionBodyOf(record.markdown || '', section.id)
      units.push({
        slug: record.slug,
        courseName: record.courseName || '',
        lessonTitle: record.lessonTitle || '',
        sectionId: section.id,
        title: section.title,
        chars: section.chars,
        fingerprint: section.fingerprint || '',
        text: [section.title, body].filter(Boolean).join('\n').trim()
      })
    }
  }
  return units
}

/** 老库（没有 sections.body）时按 id 从正文里取回那一节。 */
function sectionBodyOf (markdown, id) {
  const section = splitSections(markdown).find(item => item.id === id)
  return section ? String(section.ownBody || '').trim() : ''
}

/** 缓存：键 = 文本的 sha256。重跑不花钱，也是"只重算改动内容"的落点。 */
function openCache (file) {
  let data = { items: {} }
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = { items: {} } }
  if (!data.items || typeof data.items !== 'object') data.items = {}
  let dirty = false
  return {
    get (text) { return data.items[createHash('sha256').update(String(text)).digest('hex')] },
    set (text, vector) {
      data.items[createHash('sha256').update(String(text)).digest('hex')] = vector
      dirty = true
    },
    flush () { if (dirty) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)) } },
    get size () { return Object.keys(data.items).length }
  }
}

/**
 * 真模型：阿里云百炼 text-embedding-v3。
 *
 * 三件必须做的事（与 ASR 那套预算纪律一致）：
 *   1. **先算钱再花**：按预估 token 算一次预计花费，超过 COURSE_EMBED_MAX_COST_CNY 就拒绝开跑；
 *   2. 记账用接口返回的 usage.total_tokens（不是自己估的），跑完报实际花费；
 *   3. 按文本哈希缓存：同一段文字第二次不重复花钱，也是"增量只算改动小节"的实现。
 * 分批：一次最多 10 条（v3 的限制），失败按指数退避重试三次。
 */
function createDashScopeEmbedder ({ capCny = 0, cacheFile = '' } = {}) {
  const apiKey = String(process.env.DASHSCOPE_API_KEY || '').trim()
  if (!apiKey) throw new Error('provider=dashscope 需要 DASHSCOPE_API_KEY（服务器上的 ~/.course-worker/env 里有）')
  const model = String(process.env.COURSE_EMBED_MODEL || 'text-embedding-v3')
  const price = PRICES.dashscope
  const cache = cacheFile ? openCache(cacheFile) : null
  const spent = { tokens: 0, calls: 0, hits: 0 }

  const post = async (texts, textType) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: { texts }, parameters: { text_type: textType } })
      })
      if (response.ok) return response.json()
      const detail = await response.text().catch(() => '')
      if (response.status === 429 || response.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
        continue
      }
      throw new Error(`百炼 embedding 返回 ${response.status}：${detail.slice(0, 200)}`)
    }
    throw new Error('百炼 embedding 连续失败三次（限流或服务异常），本次实验中止')
  }

  return {
    provider: 'dashscope',
    label: `${price.label}（model=${model}）`,
    stats: () => ({ ...spent, cacheSize: cache ? cache.size : 0, costCny: spent.tokens * price.cnyPerMTok / 1_000_000 }),
    embed: async (texts, { type = 'document' } = {}) => {
      const vectors = new Array(texts.length).fill(null)
      const missing = []
      texts.forEach((text, index) => {
        const hit = cache?.get(text)
        if (hit) { vectors[index] = hit; spent.hits += 1 } else missing.push({ index, text })
      })
      for (let start = 0; start < missing.length; start += 10) {
        const batch = missing.slice(start, start + 10)
        // 先算钱：按 1 token ≈ 1.5 汉字保守估，超上限就当场拒绝（而不是先花掉再后悔）
        const projected = (spent.tokens + batch.reduce((sum, item) => sum + estimateTokens(item.text), 0)) * price.cnyPerMTok / 1_000_000
        if (capCny > 0 && projected > capCny) {
          throw new Error(`预计花费 ¥${projected.toFixed(4)} 超过上限 ¥${capCny}（COURSE_EMBED_MAX_COST_CNY）：已停止，未发出的批次不花钱`)
        }
        const payload = await post(batch.map(item => item.text), type)
        spent.calls += 1
        spent.tokens += Number(payload?.usage?.total_tokens || batch.reduce((sum, item) => sum + estimateTokens(item.text), 0))
        for (const item of payload?.output?.embeddings || []) {
          const target = batch[Number(item.text_index)]
          if (!target) continue
          vectors[target.index] = item.embedding
          cache?.set(target.text, item.embedding)
        }
      }
      cache?.flush()
      if (vectors.some(vector => !vector)) throw new Error('有文本没有拿到向量（接口返回不完整），本次实验中止')
      return vectors
    }
  }
}

export function makeEmbedder (provider = 'local-stub', { capCny = 0, cacheFile = '' } = {}) {
  if (provider === 'local-stub') {
    return { provider, label: PRICES['local-stub'].label, stats: () => ({ tokens: 0, calls: 0, hits: 0, costCny: 0 }), embed: async texts => texts.map(localStubVector) }
  }
  if (process.env.COURSE_EMBED_ALLOW_PAID !== '1') {
    throw new Error(`provider=${provider} 会产生真实费用：先把 COURSE_EMBED_ALLOW_PAID=1（并设 COURSE_EMBED_MAX_COST_CNY）再跑`)
  }
  if (provider === 'dashscope') return createDashScopeEmbedder({ capCny, cacheFile })
  throw new Error(`provider=${provider} 还没接：实现 embed() 即可（价格表已在 PRICES 里），接口见 docs/13`)
}

export async function runExperiment ({ records = [], queries = [], provider = 'local-stub', limit = 3, capCny = 0, cacheFile = '' } = {}) {
  const units = buildUnits(records)
  const embedder = makeEmbedder(provider, { capCny, cacheFile })
  const vectors = await embedder.embed(units.map(unit => unit.text), { type: 'document' })
  // 查询侧也计时：决策标准里有一条"每查询 <300ms"，光看命中率不够
  const queryStartedAt = Date.now()
  const queryVectors = await embedder.embed(queries.map(query => query.query), { type: 'query' })
  const queryEmbedMs = Date.now() - queryStartedAt
  const searchStartedAt = Date.now()
  const results = []
  for (const [index, query] of queries.entries()) {
    const scored = units
      .map((unit, unitIndex) => ({ unit, score: cosine(queryVectors[index], vectors[unitIndex]) }))
      .sort((left, right) => right.score - left.score)
    // 一节课可能有多节命中：按"课次"去重，保留最高分那一节（与词面检索的口径一致）
    const seen = new Set()
    const ranked = []
    for (const item of scored) {
      if (seen.has(item.unit.slug)) continue
      seen.add(item.unit.slug)
      ranked.push(item)
    }
    const top = ranked.slice(0, limit)
    const expected = (query.expect || []).map(item => String(item))
    results.push({
      query: query.query,
      expect: expected,
      report: query.report === true,
      top1: top[0] ? top[0].unit.slug : null,
      top3: top.map(item => item.unit.slug),
      hit1: Boolean(top[0] && expected.some(item => top[0].unit.slug.includes(item))),
      hit3: top.some(item => expected.some(expect => item.unit.slug.includes(expect)))
    })
  }
  const searchMs = Date.now() - searchStartedAt
  const scored = results.filter(item => !item.report)
  const reported = results.filter(item => item.report)
  const tokens = units.reduce((sum, unit) => sum + estimateTokens(unit.text), 0)
  const queryTokens = queries.reduce((sum, query) => sum + estimateTokens(query.query), 0)
  const price = PRICES[embedder.provider] || PRICES['local-stub']
  return {
    provider: embedder.provider,
    providerLabel: price.label,
    units: units.length,
    notes: records.length,
    queries: queries.length,
    indexTokens: tokens,
    queryTokens,
    indexCostCny: tokens * price.cnyPerMTok / 1_000_000,
    queryCostCny: queryTokens * price.cnyPerMTok / 1_000_000,
    // 实际花了多少：以接口返回的 usage 为准（预算是估的，账单是真的）
    usage: embedder.stats(),
    latency: {
      // 查询向量化是网络往返，检索本身是纯计算：两者要分开看，不然不知道该优化谁
      embedQueriesMs: queryEmbedMs,
      embedPerQueryMs: Math.round(queryEmbedMs / Math.max(1, queries.length)),
      searchAllMs: searchMs,
      searchPerQueryMs: Math.round(searchMs / Math.max(1, queries.length))
    },
    development: {
      total: scored.length,
      top1: scored.filter(item => item.hit1).length,
      top3: scored.filter(item => item.hit3).length
    },
    // 冻结留出集只报告、不调参：一旦拿它选择策略，它就不再是留出集
    frozen: {
      total: reported.length,
      top1: reported.filter(item => item.hit1).length,
      top3: reported.filter(item => item.hit3).length
    },
    results
  }
}

async function main () {
  if (!fs.existsSync(libraryFile)) {
    console.error(`找不到发布库：${libraryFile}`)
    process.exit(2)
  }
  const records = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
  const queryFile = valueOf('queries', path.join(import.meta.dirname, 'fixtures', 'semantic-queries.example.json'))
  const queries = JSON.parse(fs.readFileSync(queryFile, 'utf8'))
  const provider = valueOf('provider', process.env.PROVIDER || 'local-stub')
  // 花费上限：付费 provider 不给上限就不开跑（预算纪律，与 ASR 那套一致）
  const capCny = Number(valueOf('max-cost', process.env.COURSE_EMBED_MAX_COST_CNY || (provider === 'local-stub' ? 0 : '')) || 0)
  if (provider !== 'local-stub' && !(capCny > 0)) {
    console.error(`provider=${provider} 必须给花费上限：--max-cost <元> 或 COURSE_EMBED_MAX_COST_CNY`)
    process.exit(2)
  }
  const cacheFile = valueOf('cache', process.env.COURSE_EMBED_CACHE || path.join(os.homedir(), '.course-worker', `embeddings-cache-${provider}.json`))
  const report = await runExperiment({ records, queries, provider, capCny, cacheFile })
  if (flag('json')) { console.log(JSON.stringify(report, null, 2)); return }
  console.log(`语义召回实验（provider=${report.provider}｜${report.providerLabel}）`)
  console.log(`  单元 ${report.units} 个小节 / ${report.notes} 篇笔记；索引 ${report.indexTokens} token（≈¥${report.indexCostCny.toFixed(4)}），每次查询 ≈¥${report.queryCostCny.toFixed(6)}`)
  console.log(`  开发集：top1 ${report.development.top1}/${report.development.total}，top3 ${report.development.top3}/${report.development.total}`)
  console.log(`  冻结集（只报告、不调参）：top1 ${report.frozen.top1}/${report.frozen.total}，top3 ${report.frozen.top3}/${report.frozen.total}`)
  for (const item of report.results) {
    console.log(`  ${item.report ? '[冻结]' : '[开发]'} ${item.hit3 ? '命中' : '未命中'} ${item.query} → ${item.top3.join(' > ')}`)
  }
  console.log('  预算（索引一次 + 每次查询）：')
  for (const [key, price] of Object.entries(PRICES)) {
    const index = report.indexTokens * price.cnyPerMTok / 1_000_000
    const query = report.queryTokens * price.cnyPerMTok / 1_000_000
    console.log(`    ${key.padEnd(12)} ¥${index.toFixed(4)} / 索引全量；每查询 ¥${query.toFixed(6)}  — ${price.label}`)
  }
  if (report.provider === 'local-stub') {
    console.log('  提醒：local-stub 是词面近似，只验证管道；要判断语义效果必须换成真模型（docs/13 §4）。')
  } else {
    console.log(`  延迟：查询向量化 ${report.latency.embedPerQueryMs}ms/次（网络往返）、本地检索 ${report.latency.searchPerQueryMs}ms/次`)
    console.log(`  实际用量：${report.usage.tokens} token / ${report.usage.calls} 次调用 / 缓存命中 ${report.usage.hits}（缓存 ${report.usage.cacheSize} 条）→ 实际花费 ¥${report.usage.costCny.toFixed(4)}（上限 ¥${capCny}）`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('semantic-eval.mjs')) {
  await main()
}
