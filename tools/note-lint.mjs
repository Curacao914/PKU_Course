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
  // 结构口径对齐 haoke/newhaoke 的成品格式（用户说那套"读起来舒服"）：
  // 顶部只有「课程概览」一个块（三个固定子节），正文按「一、话题」分节，
  // 小节标题是加粗行而不是标题，末尾是附录与知识连接。
  const structure = {
    课程概览: has(/^##\s*课程概览/m),
    核心问题: has(/^###\s*本课要回答的核心问题/m),
    应当能够: has(/^###\s*本课你应当能够/m),
    课程脉络: has(/^###\s*课程脉络/m),
    分节正文: has(/^###\s*[一二三四五六七八九十]+、/m),
    小节加粗: has(/^\*\*[（(][一二三四五六七八九十]+[）)]/m),
    自测: has(/自测|练习|思考题/),
    知识连接: has(/知识连接/),
    附录: has(/附录/),
    元数据: has(/笔记元数据/)
  }
  const missing = Object.entries(structure).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) add('info', 'structure', `缺少小节：${missing.join('、')}`)

  // 三类就地提示：读到哪儿提醒到哪儿，比攒到文末再列一遍有用
  const cues = {
    老师强调: (markdown.match(/^>\s*老师强调/gm) || []).length,
    易混提醒: (markdown.match(/^>\s*(⚠️\s*)?\*\*易混提醒\*\*/gm) || []).length,
    理解难点: (markdown.match(/^>\s*(💡\s*)?\*\*理解难点\*\*/gm) || []).length
  }
  if (!cues.老师强调 && !cues.易混提醒 && !cues.理解难点) {
    add('warn', 'no-inline-cues', '正文里没有任何「老师强调 / ⚠️ 易混提醒 / 💡 理解难点」引用块：这些提示应当随正文就地出现')
  }

  // 小节标题不该再用四级标题：目录只到「一、话题」这一级才看得出结构
  const bodyHeadings = (markdown.match(/^#{4,6}\s/mg) || []).length
  if (bodyHeadings) add('warn', 'deep-headings', `正文里还有 ${bodyHeadings} 处四级及以下标题：小节标题应当是加粗行`)

  // 6.5) 呈现质量：长段落与标题层级——"读得下去"的两个硬指标
  const paragraphs = markdown.split(/\n\s*\n/).filter(block => !/^[#>|\-*\d]/.test(block.trim()) && block.trim())
  const longParagraphs = paragraphs.filter(block => block.replace(/\s/g, '').length > 300)
  if (longParagraphs.length) {
    add('warn', 'long-paragraphs', `${longParagraphs.length} 个段落超过 300 字（最长 ${Math.max(...longParagraphs.map(p => p.replace(/\s/g, '').length))} 字）：大段文字是长文阅读的主要障碍`)
  }
  const levels = lines.map(text => text.match(/^(#{2,4})\s/)).filter(Boolean).map(match => match[1].length)
  const skipped = levels.some((level, index) => index > 0 && level - levels[index - 1] > 1)
  if (skipped) add('warn', 'heading-skip', '标题层级出现跳级（例如 h2 直接到 h4），目录会失去层次感')
  // 目录只列到 h3 是**有意的**（对齐好课格式）：小节用加粗行承载，不算"目录太浅"


  // 7) 图示与表格
  const diagrams = (markdown.match(MERMAID_BLOCK) || []).length
  if (!diagrams) add('warn', 'no-knowledge-map', '没有任何 Mermaid 图：体系层缺了"知识地图"')

  // 7.1) 知识地图节点数：超过 12 个就从"结构图"退化成"又一份目录"
  const mermaidBlocks = markdown.split(MERMAID_BLOCK).slice(1).map(block => block.split('```')[0])
  const mapNodes = mermaidBlocks
    .flatMap(block => block.split('\n'))
    .filter(line => /-->|\|/.test(line)).length
  if (mapNodes > 12) add('warn', 'map-too-large', `知识地图画了 ${mapNodes} 条连线/节点，超过 12 就比文字更难读`)

  // 7.2) 重点标记通胀：每节超过 3 处教师归属标记等于没有重点。
  // 口径用「老师/教师 + 任意动词」而不是固定几个动词——模型换个说法（"老师以…作比"）
  // 就不该被判成"没有教师立场"。
  const emphasis = (markdown.match(/(老师|教师)[^。；\n]{0,6}(指出|强调|认为|提出|提醒|说明|表示|以|把|总结)/g) || []).length
  if (sectionStarts.length && emphasis / sectionStarts.length > 3) {
    add('warn', 'emphasis-inflation', `平均每节 ${(emphasis / sectionStarts.length).toFixed(1)} 处教师态度标记，重点通胀`)
  }

  // 7.3) 用 emoji 当层级：视觉噪声，且不同渲染器表现不一致
  const emojiHeadings = lines.filter(text => /^#{1,6}\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).length
  if (emojiHeadings) add('warn', 'emoji-headings', `${emojiHeadings} 个标题用 emoji 开头；层级应由标题层级承担`)

  // 7.4) 篇幅：超过 15000 字就该出背诵版（"我的大纲太长"与成绩负相关）
  if (markdown.length > 20000) add('info', 'too-long', `正文 ${markdown.length} 字，建议另出 3000—4000 字背诵版`)
  const tables = lines.filter(text => /^\s*\|.+\|\s*$/.test(text)).length
  const lists = lines.filter(text => /^\s*([-*]|\d+[.)])\s+/.test(text)).length

  // 8) 结论句 / 教师态度标记（可读性信号：笔记该看得出来"老师强调什么"）
  const teacherMarkers = (markdown.match(/(老师|教师)(指出|强调|认为|提出|提醒|说明|表示|以|把|总结)/g) || []).length

  const errors = issues.filter(issue => issue.severity === 'error').length
  const warnings = issues.filter(issue => issue.severity === 'warn').length
  const maxParagraphChars = paragraphs.length ? Math.max(...paragraphs.map(p => p.replace(/\s/g, '').length)) : 0
  return {
    file: path.resolve(file),
    chars: markdown.length,
    sections: sectionStarts.length,
    diagrams,
    maxParagraphChars,
    paragraphs: paragraphs.length,
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
    process.stdout.write(`字数 ${report.chars} · 小节 ${report.sections} · 段落 ${report.paragraphs}（最长 ${report.maxParagraphChars} 字） · 图示 ${report.diagrams} · 表格行 ${report.tableRows} · 列表项 ${report.listItems} · 教师态度标记 ${report.teacherMarkers}\n`)
    process.stdout.write(`结构：${Object.entries(report.structure).map(([key, value]) => `${key}${value ? '✓' : '✗'}`).join(' ')}\n`)
    if (!report.issues.length) process.stdout.write('未发现问题\n')
    for (const issue of report.issues) {
      process.stdout.write(`[${issue.severity}] ${issue.kind}: ${issue.detail}${issue.line ? ` (第 ${issue.line} 行)` : ''}\n`)
    }
    process.stdout.write(`体检分（越低越好）：${report.score}\n`)
  }
}
