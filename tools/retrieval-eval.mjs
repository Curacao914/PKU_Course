#!/usr/bin/env node
/**
 * 检索评测：给"能不能准确找到那一节"一个可重复的数字。
 *
 * 为什么要有它：检索质量是看不见的——改完分词、加完权重，感觉"好像更准了"，
 * 但下一次改动没人知道是进步还是退步。这里固定一组**拟真查询**（跨课程、跨课次，
 * 含自然语言问句、多词组合、错别字），对同一份发布库跑同一个入口，给出命中率。
 *
 * 标准答案不手写、从语料里推：每条查询声明它需要的**词面**（terms），
 * 凡是正文或元数据里真的出现过这些词的课次就是"应当被找到的那几节"。
 * 这样标准答案不会因为实现改了而悄悄失效，也不会因为人的印象而写错。
 *
 * 用法：
 *   node tools/retrieval-eval.mjs [library.json 路径] [--json]
 * 退出码：达到门槛 0，否则 1（门槛见 THRESHOLDS）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { createNotesService } from '@course/notes-mcp'
import { createLocalLibrarySource } from '../packages/notes-mcp/src/sources.mjs'

const DEFAULT_LIBRARY = path.join(process.env.HOME || '', '.course-worker', 'site', 'library.json')

/** 门槛：不追求满分（自然语言问句本来就难），但明显退步要拦住。 */
const THRESHOLDS = { top1: 0.7, top3: 0.9, recall: 0.8 }

/**
 * 查询集。
 *   text    用户/AI 会怎么问
 *   terms   标准答案词面：**全部**出现在某一节里，那一节才算标准答案
 *   anyOf   至少一个出现即算（用于同义/可选表述）
 *   top1    这条的"最好的那一节"（不给就只看前三命中）
 *   note    这条在考什么（写给自己看）
 */
const QUERIES = [
  { text: '罪刑法定主义', terms: ['罪刑法定'], top1: '国际刑法学/2026-09-16', note: '术语：跨课次都有，看排序是否压在真正展开的那一节' },
  { text: '纽伦堡宪章第6条', terms: ['纽伦堡宪章'], top1: '国际刑法学/2026-09-16', note: '法条号 + 专名' },
  { text: '胜者正义', terms: ['胜者正义'], top1: '国际刑法学/2026-09-23', note: '专名，单课次' },
  { text: '前南国际刑事法庭的管辖', terms: ['前南'], note: '专名 + 中文虚词（"的"不该影响）' },
  { text: '为什么审判威廉二世的构想落空了', terms: ['威廉二世'], top1: '国际刑法学/2026-09-16', note: '自然语言问句' },
  { text: '代理成本与有限责任', terms: ['代理成本'], top1: '商法概论/2026-09-20', note: '多词组合（旧实现整串匹配，必然零命中）' },
  { text: '法人人格否认', terms: ['人格否认'], top1: '商法概论/2026-09-20', note: '术语：曾经命中过"看起来对"的课次（语料核对后确认就是这一节在讲）' },
  { text: '交易成本 资产专用性', terms: ['交易成本', '资产专用性'], top1: '商法概论/2026-09-20', note: '多词 + 空格分隔' },
  { text: '有限责任的边界', terms: ['有限责任'], note: '自然短语' },
  { text: '缓刑撤销', terms: ['缓刑'], note: '术语' },
  { text: '如实供述自己罪行', terms: ['如实供述'], top1: '刑事执行法/2026-09-14', note: '法条要件表述' },
  { text: '严与厉 刑罚结构', terms: ['严与厉'], note: '课堂自造术语 + 多词' },
  { text: '以刑制罪', terms: ['以刑制罪'], note: '课堂自造术语，跨课次' },
  { text: '变量测量水平与标准化Z值', terms: ['测量水平', '标准化'], top1: '法律实证分析/2026-09-23', note: '多词 + 拉丁字母' },
  { text: '描述统计', terms: ['描述统计'], top1: '法律实证分析/2026-09-23', note: '术语' },
  { text: '罪刑法定主意', terms: ['罪刑法定'], top1: '国际刑法学/2026-09-16', note: '错别字（主义→主意），旧实现零命中' },
  { text: '灭种公约的蓄意要件', terms: ['灭种公约'], top1: '国际刑法学/2026-09-23', note: '专名 + 要件' },
  { text: '公司为什么存在', terms: ['交易成本'], top1: '商法概论/2026-09-20', note: '自然语言问句（"公司为什么存在"→ 交易成本/企业理论那一节）' },
  { text: '教室安排', terms: ['教室'], note: '事务性内容：能找到，但不该压过讲授内容' }
]

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const file = path.resolve(argv.find(item => !item.startsWith('--')) || process.env.COURSE_LIBRARY || DEFAULT_LIBRARY)

const norm = value => String(value || '').toLowerCase().replace(/\s+/g, '')

/** 一条记录里所有可检索的文字（正文 + 元数据 + 标题），用来推标准答案。 */
function haystack(record) {
  return norm([
    record.lessonTitle, record.theme, (record.keywords || []).join(' '),
    record.summary, record.brief?.briefing, record.markdown,
    (record.headings || []).map(head => head.text).join(' '),
    (record.metadata?.concepts || []).join(' '),
    (record.metadata?.statutes || []).join(' '),
    (record.metadata?.cases || []).join(' ')
  ].filter(Boolean).join('\n'))
}

const records = JSON.parse(fs.readFileSync(file, 'utf8'))
const service = createNotesService({
  source: createLocalLibrarySource({ file }),
  siteOrigin: 'https://course.law-tech.dev'
})

const rows = []
const evalErrors = []
for (const query of QUERIES) {
  const truth = records
    .filter(record => {
      const text = haystack(record)
      const all = (query.terms || []).every(term => text.includes(norm(term)))
      const any = (query.anyOf || []).some(term => text.includes(norm(term)))
      return query.terms?.length ? all : any
    })
    .map(record => record.slug)
  const result = await service.searchNotes({ query: query.text, includeBody: true, limit: 5 })
  const found = result.hits.map(hit => hit.slug)
  // top1 优先按"最好的那一节"判（多节都命中时，谁排第一是有对错的）；没给就用是否落在标准答案里
  const top1 = query.top1
    ? String(found[0] || '').startsWith(`notes/${query.top1}`)
    : (found[0] ? truth.includes(found[0]) : false)
  /**
   * 评测集自己也要被检查：手写的"最好的那一节"必须真的包含这条查询的词面。
   * 这一条救过一次事故——我把"法人人格否认"的答案写成商法第 2 讲，而语料里它只出现在
   * 第 3 讲；当时的"未命中"其实是评测集错了，不是检索错了。
   */
  const expectedSupported = !query.top1 || truth.some(slug => slug.startsWith(`notes/${query.top1}`))
  if (!expectedSupported) {
    evalErrors.push(`${query.text}：期望的 top1（${query.top1}）在语料里并不包含 ${(query.terms || query.anyOf || []).join('、')}——评测集写错了`)
  }
  const inTop3 = found.slice(0, 3).filter(slug => truth.includes(slug))
  rows.push({
    text: query.text,
    note: query.note,
    truth: truth.length,
    top1,
    top3: inTop3.length > 0 && truth.length > 0,
    recall: truth.length ? inTop3.length / Math.min(truth.length, 3) : (found.length === 0 ? 1 : 0),
    hits: found.slice(0, 3).map(slug => slug.replace('notes/', '')),
    expected: truth.map(slug => slug.replace('notes/', ''))
  })
}

const rate = key => rows.reduce((sum, row) => sum + (row[key] ? 1 : 0), 0) / rows.length
const recall = rows.reduce((sum, row) => sum + row.recall, 0) / rows.length

if (asJson) {
  console.log(JSON.stringify({ file, total: rows.length, top1: rate('top1'), top3: rate('top3'), recall, rows }, null, 2))
} else {
  console.log(`发布库：${file}`)
  console.log(`查询数：${rows.length}（含自然语言、多词、错别字）\n`)
  for (const row of rows) {
    const verdict = row.top1 ? '命中@1' : row.top3 ? '命中@3' : '未命中'
    console.log(`${verdict.padEnd(6)} ${row.text.padEnd(20)} → ${(row.hits[0] || '（无命中）').slice(0, 34)}`)
    if (!row.top3) console.log(`        应当命中：${row.expected.join(' / ') || '（无）'}`)
  }
  console.log('')
  if (evalErrors.length) {
    console.log('评测集自身的问题：')
    for (const item of evalErrors) console.log(`  · ${item}`)
    console.log('')
  }
  console.log(`命中第一：${(rate('top1') * 100).toFixed(0)}%（门槛 ${THRESHOLDS.top1 * 100}%）`)
  console.log(`前三命中：${(rate('top3') * 100).toFixed(0)}%（门槛 ${THRESHOLDS.top3 * 100}%）`)
  console.log(`覆盖率　：${(recall * 100).toFixed(0)}%（门槛 ${THRESHOLDS.recall * 100}%）`)
}

const ok = rate('top1') >= THRESHOLDS.top1 && rate('top3') >= THRESHOLDS.top3 && recall >= THRESHOLDS.recall
process.exit(ok ? 0 : 1)
