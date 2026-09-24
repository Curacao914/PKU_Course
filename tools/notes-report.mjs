#!/usr/bin/env node
/**
 * 单课笔记运行报告：把 lesson-state.json 变成一份可核对的账。
 *
 *   用法：node tools/notes-report.mjs <lesson-state.json 或所在目录>
 *         [--price-in <元/百万 token>] [--price-out <元/百万 token>]
 *
 * 用途有两个：
 *   1. 验收时确认"这一步到底跑了什么、花了多少"——模型调用次数、token、
 *      每个节点的重写次数、审查结论，全部来自落盘的状态，不靠推测；
 *   2. 切片粒度对比实验的度量口径：同一节课在细切/粗切/不切三种配置下，
 *      用同一份脚本比调用次数、token、成品长度与逐节点审查结果。
 *
 * 价格不写死在代码里：模型价格会变，写死就会变成过期的假数字。
 * 不传 --price-* 时只报 token，不报钱。
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const equals = name.indexOf('=')
      if (equals >= 0) {
        options[name.slice(0, equals)] = name.slice(equals + 1)
        continue
      }
      options[name] = argv[index + 1]
      index += 1
      continue
    }
    positional.push(token)
  }
  return { options, positional }
}

const { options, positional } = parseArgs(process.argv.slice(2))
const target = positional[0]
if (!target) {
  console.error('用法：node tools/notes-report.mjs <lesson-state.json 或所在目录> [--price-in <元/百万>] [--price-out <元/百万>]')
  process.exit(2)
}
const statePath = fs.statSync(target).isDirectory() ? path.join(target, 'lesson-state.json') : target
if (!fs.existsSync(statePath)) {
  console.error(`找不到状态文件：${statePath}`)
  process.exit(2)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const lesson = state.lesson || {}
const nodes = lesson.nodes || []

const traces = []
const collect = (value, where) => {
  if (!value || typeof value !== 'object') return
  if (value.trace?.role) traces.push({ ...value.trace, where })
}
for (const node of nodes) {
  for (const version of node.versions || []) collect(version, `node:${node.id}`)
  for (const report of node.reviewerReports || []) collect(report, `node:${node.id}`)
}
for (const version of lesson.finalNoteVersions || []) collect(version, 'final-note')
for (const report of lesson.finalReviewReports || []) collect(report, 'final-review')
for (const trace of lesson.outlineTraces || []) if (trace?.role) traces.push({ ...trace, where: 'outline' })

const byRole = new Map()
for (const trace of traces) {
  const entry = byRole.get(trace.role) || { role: trace.role, calls: 0, promptTokens: 0, completionTokens: 0, promptChars: 0, completionChars: 0 }
  entry.calls += 1
  entry.promptTokens += Number(trace.usage?.prompt_tokens || 0)
  entry.completionTokens += Number(trace.usage?.completion_tokens || 0)
  entry.promptChars += Number(trace.promptChars || 0)
  entry.completionChars += Number(trace.completionChars || 0)
  byRole.set(trace.role, entry)
}

const sum = key => [...byRole.values()].reduce((total, entry) => total + entry[key], 0)
const priceIn = Number(options['price-in'] || 0)
const priceOut = Number(options['price-out'] || 0)
const cost = priceIn || priceOut
  ? (sum('promptTokens') / 1e6) * priceIn + (sum('completionTokens') / 1e6) * priceOut
  : null

const nodeRows = nodes.map(node => {
  const report = (node.reviewerReports || []).at(-1)?.value || {}
  const blocking = (report.issues || []).filter(issue => issue.severity === 'blocking').length
  return {
    id: node.id,
    title: node.title,
    lines: Array.isArray(node.lineRange) ? `${node.lineRange[0]}-${node.lineRange[1]}` : '',
    chars: String(node.draft || '').length,
    versions: (node.versions || []).length,
    revisions: Number(node.revisionCount || 0),
    status: node.status,
    decision: node.reviewDecision || report.decision || '',
    blocking,
    autoAccepted: Boolean(node.autoAcceptedWithWarnings)
  }
})

const output = {
  statePath,
  savedAt: state.savedAt || null,
  lastStep: state.step || null,
  lesson: {
    key: lesson.key,
    title: lesson.title,
    status: lesson.status,
    completed: lesson.status === 'completed',
    nodeCount: nodes.length,
    transcriptChars: String(lesson.transcript || '').length,
    transcriptLines: String(lesson.transcript || '').split('\n').length,
    finalNoteChars: String(lesson.finalNote?.markdown || '').length,
    finalRevisionCount: Number(lesson.finalRevisionCount || 0)
  },
  model: {
    calls: traces.length,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    promptChars: sum('promptChars'),
    completionChars: sum('completionChars'),
    byRole: [...byRole.values()].sort((left, right) => right.calls - left.calls),
    estimatedCost: cost == null ? null : Number(cost.toFixed(4)),
    priceUsed: cost == null ? null : { inPerMillion: priceIn, outPerMillion: priceOut }
  },
  reviews: {
    approved: nodeRows.filter(row => row.status === 'node_approved' && row.blocking === 0).length,
    approvedWithWarnings: nodeRows.filter(row => row.autoAccepted).length,
    rewritten: nodeRows.filter(row => row.revisions > 0).length,
    totalRevisions: nodeRows.reduce((total, row) => total + row.revisions, 0)
  },
  nodes: nodeRows
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
