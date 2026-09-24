#!/usr/bin/env node
/**
 * 笔记体检：对成品笔记做程序化检查，输出可比较的质量向量。
 *
 *   用法：node tools/note-lint.mjs <笔记.md> [<笔记.md> ...] [--json]
 *
 * 为什么需要它：切片粒度对比实验要有客观判据，不能只凭"读起来感觉如何"。
 * 这里查的都是**机器能确证**的问题：元话语、正文里的时间戳、层级冲突、
 * 空节、结构缺件、重复段、图示与表格数量。语义质量（有没有编造、讲得对不对）
 * 机器判不了，那一项只能靠人读或靠独立模型审查，本工具不假装能判。
 *
 * 每个问题给 severity：error（明确不该出现）/ warn（大概率是缺陷）/ info（供参考）
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const files = args.filter(arg => !arg.startsWith('--'))
if (!files.length) {
  console.error('用法：node tools/note-lint.mjs <笔记.md> [...] [--json]')
  process.exit(2)
}

// 模型爱写的元话语：这些是"对写作过程的描述"，不是笔记内容。
// 来源：旧手工流程的产物里没有这些（见 docs/05 调研），是自动流水线引入的噪声。
const META_PHRASES = [
  '本节点', '本节点小结', '写作目标', '对应缺口', '待补写', '尚未完成', '待确认补充',
  '占位', 'TODO', '待补充', '本节小结（含未完成项）', '材料状态与节点完成状态'
]
const TIMESTAMP = /\[\d{2}:\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}:\d{2}\]/g
const MERMAID_BLOCK = /```mermaid/g

function analyze(file) {
  const markdown = fs.readFileSync(file, 'utf8')
  const lines = markdown.split('\n')
  const issues = []
  const add = (severity, kind, detail, line = null) => issues.push({ severity, kind, detail, line })

  // 1) 元话语
  const metaHits = []
  lines.forEach((text, index) => {
    for (const phrase of META_PHRASES) {
      if (text.includes(phrase)) metaHits.push({ line: index + 1, phrase, text: text.trim().slice(0, 80) })
    }
  })
  if (metaHits.length) {
    add('error', 'meta-commentary', `出现 ${metaHits.length} 处"写作过程"的话（本节点/写作目标/待补写…），成品笔记不该有`, metaHits[0].line)
  }

  // 2) 正文里的时间戳（旧流程明确要求不写入正文）
  const stamps = markdown.match(TIMESTAMP) || []
  if (stamps.length) add('warn', 'timestamps-in-body', `正文出现 ${stamps.length} 处时间戳（旧流程明确要求不写入正文）`)

  // 3) 层级：拼装后正文里不该再出现一级/二级标题（节点自带标题会造成两套层级并存）
  const h1 = lines.map((text, index) => [text, index + 1]).filter(([text]) => /^#\s+\S/.test(text))
  const h2 = lines.map((text, index) => [text, index + 1]).filter(([text]) => /^##\s+\S/.test(text))
  if (h1.length > 1) add('error', 'heading-collision', `出现 ${h1.length} 个一级标题（应只有课程标题一个）`, h1[1][1])

  // 4) 重复标题
  const titles = lines.filter(text => /^#{2,4}\s+\S/.test(text)).map(text => text.replace(/^#+\s+/, '').trim())
  const seen = new Map()
  for (const title of titles) seen.set(title, (seen.get(title) || 0) + 1)
  const dup = [...seen.entries()].filter(([, count]) => count > 1)
  if (dup.length) add('warn', 'duplicate-headings', `${dup.length} 个标题重复出现：${dup.slice(0, 3).map(([t, c]) => `${t}×${c}`).join('、')}`)

  // 5) 空节 / 极短节
  const sectionStarts = lines.map((text, index) => ({ text, index })).filter(({ text }) => /^#{2,3}\s+\S/.test(text))
  const shortSections = []
  sectionStarts.forEach((section, index) => {
    const next = sectionStarts[index + 1]?.index ?? lines.length
    const body = lines.slice(section.index + 1, next).join('').replace(/\s/g, '')
    if (body.length < 200) shortSections.push({ title: section.text.trim().slice(0, 40), chars: body.length, line: section.index + 1 })
  })
  if (shortSections.length) add('warn', 'thin-sections', `${shortSections.length} 个小节正文不足 200 字`, shortSections[0].line)

  // 6) 结构缺件
  const has = pattern => pattern.test(markdown)
  const structure = {
    课程概览: has(/课程概览/),
    核心问题: has(/核心问题|要回答的问题/),
    学习目标: has(/应当能够|学习目标/),
    自测: has(/自测|练习|思考题/),
    知识连接: has(/知识连接|课程关联|与其他/),
    附录: has(/附录/),
    元数据: has(/笔记元数据/)
  }
  const missing = Object.entries(structure).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) add('info', 'structure', `缺少小节：${missing.join('、')}`)

  // 7) 图示与表格
  const diagrams = (markdown.match(MERMAID_BLOCK) || []).length
  const tables = lines.filter(text => /^\s*\|.+\|\s*$/.test(text)).length
  const lists = lines.filter(text => /^\s*([-*]|\d+[.)])\s+/.test(text)).length

  // 8) 结论句 / 教师态度标记（可读性信号：笔记该看得出来"老师强调什么"）
  const teacherMarkers = (markdown.match(/老师(指出|强调|认为|提出|提醒)/g) || []).length

  const errors = issues.filter(issue => issue.severity === 'error').length
  const warnings = issues.filter(issue => issue.severity === 'warn').length
  return {
    file: path.resolve(file),
    chars: markdown.length,
    sections: sectionStarts.length,
    diagrams,
    tableRows: tables,
    listItems: lists,
    teacherMarkers,
    structure,
    metaHits: metaHits.slice(0, 8),
    shortSections: shortSections.slice(0, 8),
    issues,
    score: errors * 10 + warnings * 3 + missing.length
  }
}

const reports = files.map(analyze)
if (asJson) {
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
} else {
  for (const report of reports) {
    process.stdout.write(`\n=== ${path.basename(report.file)} ===\n`)
    process.stdout.write(`字数 ${report.chars} · 小节 ${report.sections} · 图示 ${report.diagrams} · 表格行 ${report.tableRows} · 列表项 ${report.listItems} · 教师态度标记 ${report.teacherMarkers}\n`)
    process.stdout.write(`结构：${Object.entries(report.structure).map(([key, value]) => `${key}${value ? '✓' : '✗'}`).join(' ')}\n`)
    if (!report.issues.length) process.stdout.write('未发现问题\n')
    for (const issue of report.issues) {
      process.stdout.write(`[${issue.severity}] ${issue.kind}: ${issue.detail}${issue.line ? ` (第 ${issue.line} 行)` : ''}\n`)
    }
    process.stdout.write(`体检分（越低越好）：${report.score}\n`)
  }
}
