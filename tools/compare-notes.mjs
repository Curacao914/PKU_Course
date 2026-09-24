#!/usr/bin/env node
/**
 * 笔记运行并排对比：把多份 lesson-state.json 放在一张表里。
 *
 *   用法：node tools/compare-notes.mjs <状态文件或目录> [<状态文件或目录> ...]
 *         [--price-in <元/百万>] [--price-out <元/百万>]
 *
 * 用于切片粒度实验：同一节课在「细切 / 粗切 / 不切」三种配置下，模型调用次数、
 * token、成品长度、重写次数、审查通过的差异一眼可见。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const priceFlags = []
const targets = []
for (let index = 0; index < args.length; index += 1) {
  const token = args[index]
  if (token === '--price-in' || token === '--price-out') {
    priceFlags.push(token, args[index + 1])
    index += 1
    continue
  }
  targets.push(token)
}
if (!targets.length) {
  console.error('用法：node tools/compare-notes.mjs <状态文件或目录> [...] [--price-in <元/百万>] [--price-out <元/百万>]')
  process.exit(2)
}

const reportScript = path.join(path.dirname(new URL(import.meta.url).pathname), 'notes-report.mjs')
const rows = targets.map(target => {
  const resolved = fs.statSync(target).isDirectory() ? path.join(target, 'lesson-state.json') : target
  const text = execFileSync(process.execPath, [reportScript, resolved, ...priceFlags], { encoding: 'utf8' })
  return { target: resolved, report: JSON.parse(text) }
})

const header = ['运行', '节点', '模型调用', 'prompt tok', 'completion tok', '成品字数', '重写节点', '重写次数', '费用', '状态']
const table = rows.map(({ target, report }) => [
  path.basename(path.dirname(path.dirname(target))) || target,
  String(report.lesson.nodeCount),
  String(report.model.calls),
  String(report.model.promptTokens),
  String(report.model.completionTokens),
  String(report.lesson.finalNoteChars),
  String(report.reviews.rewritten),
  String(report.reviews.totalRevisions),
  report.model.estimatedCost == null ? '-' : String(report.model.estimatedCost),
  report.lesson.status
])

const widths = header.map((cell, index) => Math.max(cell.length, ...table.map(row => row[index].length)))
const line = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ')
process.stdout.write(`${line(header)}\n${widths.map(width => '-'.repeat(width)).join('  ')}\n`)
for (const row of table) process.stdout.write(`${line(row)}\n`)

process.stdout.write('\n按角色调用次数：\n')
for (const { target, report } of rows) {
  const label = target.replace(process.env.HOME || '', '~')
  const roles = report.model.byRole.map(entry => `${entry.role}=${entry.calls}`).join(' ')
  process.stdout.write(`  ${label}\n    ${roles}\n`)
}
