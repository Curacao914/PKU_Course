#!/usr/bin/env node
/**
 * 冻结的 holdout 检索评测：**只用来报告，不用来调参**。
 *
 * 为什么单独建一个：开发集（tools/retrieval-eval.mjs 的 19 条）在改检索的过程中被反复看过，
 * 它上面的 100% 只能说明"我把自己看过的题做对了"，不能说明检索会做没见过的题。
 * 这里的查询**冻结**：写进来之后不再为了让它变绿而改检索；要调参请另建新集合。
 *
 * 这些查询是"人会怎么问"，而正确答案是语义上的（哪一节在回答这个问题），
 * 与查询里的字面能不能对上无关——所以它恰好能暴露纯词面检索的边界。
 *
 * 用法：
 *   node tools/retrieval-holdout.mjs [library.json 路径]
 * 退出码恒为 0：这是一份报告，不是闸门（闸门在开发集上）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { createNotesService } from '@course/notes-mcp'
import { createLocalLibrarySource } from '../packages/notes-mcp/src/sources.mjs'

const DEFAULT_LIBRARY = path.join(process.env.HOME || '', '.course-worker', 'site', 'library.json')

/**
 * 冻结集合（2026-09-28 定稿，之后不增删、不因结果难看而调整）。
 *   text   人真实会问的一句话
 *   expect 语义上应当回答这个问题的课次（人工判断，不看检索结果）
 */
const HOLDOUT = [
  {
    text: '统计分析为什么要先确定分析对象的层级',
    expect: ['法律实证分析'],
    note: '"分析对象的层级"= 分析单元/个体层次；查询里没有"分析单元"这几个字'
  },
  {
    text: '轻罪前科为什么应该封存',
    expect: ['刑事执行法/2026-09-14第5-6节'],
    note: '笔记里的说法是"轻微犯罪记录封存制度"：字面不同，语义相同'
  },
  {
    text: '自然人为什么会成为国际刑法责任主体',
    expect: ['国际刑法学/2026-09-16第10-12节', '国际刑法学/2026-09-09第10-12节'],
    note: '"自然人成为责任主体" = 个人刑事责任的确立'
  },
  {
    text: '刑罚过重会不会让法官改变罪名的解释',
    expect: ['刑事执行法/2026-09-21第5-6节', '刑事执行法/2026-09-07第5-6节'],
    note: '对应"以刑制罪"：刑罚后果反过来影响定罪与解释'
  }
]

const file = path.resolve(process.argv[2] || process.env.COURSE_LIBRARY || DEFAULT_LIBRARY)
const records = JSON.parse(fs.readFileSync(file, 'utf8'))
const service = createNotesService({
  source: createLocalLibrarySource({ file }),
  siteOrigin: 'https://course.law-tech.dev'
})

const matches = (slug, expected) => {
  const value = String(slug).replace(/^notes\//, '')
  return expected.some(item => value === item || value.startsWith(item))
}

let top1 = 0
let top3 = 0
console.log(`发布库：${file}（${records.length} 篇）`)
console.log('冻结 holdout（不用于调参）：\n')
for (const item of HOLDOUT) {
  const result = await service.searchNotes({ query: item.text, includeBody: true, limit: 5 })
  const slugs = result.hits.map(hit => hit.slug)
  const first = slugs[0] && matches(slugs[0], item.expect)
  const within3 = slugs.slice(0, 3).some(slug => matches(slug, item.expect))
  if (first) top1 += 1
  if (within3) top3 += 1
  console.log(`${within3 ? (first ? '命中@1' : '命中@3') : '未命中'}  ${item.text}`)
  console.log(`        期望：${item.expect.join(' / ')}`)
  console.log(`        实际：${slugs.slice(0, 3).map(slug => slug.replace(/^notes\//, '')).join(' > ') || '（无命中）'}`)
  console.log(`        说明：${item.note}`)
  console.log('')
}
console.log(`lexical holdout：命中第一 ${top1}/${HOLDOUT.length}，前三 ${top3}/${HOLDOUT.length}`)
console.log('结论按这份报告说：词面检索能做的是"字面对上"；上面未命中的那些是语义等价但字面不同，')
console.log('本轮不做同义词表、不默认开 embedding —— 需要时另做 section embedding + 低置信语义回退实验。')
