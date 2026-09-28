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
function localStubVector (text) {
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

export function makeEmbedder (provider = 'local-stub') {
  if (provider === 'local-stub') {
    return { provider, label: PRICES['local-stub'].label, embed: async texts => texts.map(localStubVector) }
  }
  if (process.env.COURSE_EMBED_ALLOW_PAID !== '1') {
    throw new Error(`provider=${provider} 会产生真实费用：先把 COURSE_EMBED_ALLOW_PAID=1（并设 COURSE_EMBED_MAX_COST_CNY）再跑`)
  }
  throw new Error(`provider=${provider} 还没接：实现 embed() 即可（价格表已在 PRICES 里），接口见 docs/13`)
}

export async function runExperiment ({ records = [], queries = [], provider = 'local-stub', limit = 3 } = {}) {
  const units = buildUnits(records)
  const embedder = makeEmbedder(provider)
  const vectors = await embedder.embed(units.map(unit => unit.text))
  const queryVectors = await embedder.embed(queries.map(query => query.query))
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
  const report = await runExperiment({ records, queries, provider })
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
  console.log('  提醒：local-stub 是词面近似，只验证管道；要判断语义效果必须换成真模型（docs/13 §4）。')
}

if (process.argv[1] && process.argv[1].endsWith('semantic-eval.mjs')) {
  await main()
}
