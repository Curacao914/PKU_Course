import { createHash } from 'node:crypto'

import { cleanText } from '@course/core'

/**
 * 简报的受控上下文：只来自**最终成品正文**，与写单元怎么切分无关。
 *
 * 为什么必须改成从成品正文派生：以前简报读的是各写单元的草稿摘要，而写单元是流水线
 * 内部的划分方式（一节可能并进多个大纲模块，一个模块也可能被拆开），于是"这节课讲了
 * 什么"取决于内部怎么切；更糟的是 brief.json 与笔记同目录，同一个 --from 目录里放过
 * 几节课的简报时谁最后写谁生效，几节课就共用同一段简报——发布库里"同课程的摘要像
 * 上一课/首课"就是这么来的。成品正文是唯一有权威的表述，简报从它派生，重跑、改版、
 * 只补关键词都不可能再串课。
 *
 * 预算 4k—8k 字：喂全文既贵又容易写成摘要，给太少又写不出主线。每节取开头 300—500 字
 * （默认 420），小节多时按比例下探但不低于 120 字，并且永远保留全部小节标题——
 * 标题本身就是这节课的骨架。
 */
export const BRIEF_SOURCE_BUDGET = { total: 8000, sectionPreferred: 420, sectionMax: 500, sectionMin: 120 }

const DETAILS_BLOCK = /<details[\s\S]*?<\/details>/gi
const META_LINE = /^\s*META:\s*([A-Z]+):\s*(.+?)\s*$/
const OVERVIEW_TITLE = /^(课程概览|本课概览|概览|概述)$/
const LINK_TITLE = /^(知识连接|与前后课次的关系|承上启下|承前启后)$/
const APPENDIX_TITLE = /^附录/
const TERM_KIND = { CONCEPT: '概念', CASE: '案例', PROVISION: '法条', STATUTE: '法条' }

export function charCount(text = '') {
  return [...String(text)].length
}

/**
 * 把成品正文切成「前言 + 各节（含节内小标题）」。
 *
 * 只认 ## 与 ###：一级标题是课次名，前言里那行「> 课程：… · 转录 L…」是身份信息，
 * 一并留下来（--course 没传时用它兜底，也用来发现"课程名是空的"这种残缺正文）。
 */
export function parseFinalNote(markdown = '') {
  const preamble = []
  const sections = []
  let section = null
  let sub = null
  for (const line of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    const h3 = line.match(/^###\s+(.+?)\s*$/)
    if (h2) {
      section = { title: h2[1], body: [], subs: [] }
      sections.push(section)
      sub = null
      continue
    }
    if (h3 && section) {
      sub = { title: h3[1], body: [] }
      section.subs.push(sub)
      continue
    }
    if (sub) sub.body.push(line)
    else if (section) section.body.push(line)
    else preamble.push(line)
  }
  return { preamble: preamble.join('\n'), sections }
}

/** 折叠块（知识地图、参考答案、META 清单）是装置不是内容，分隔线也是：清掉再给模型。 */
export function stripNoteDecorations(text = '') {
  return String(text)
    .replace(DETAILS_BLOCK, '')
    .replace(/^\s*META:.*$/gm, '')
    .replace(/^\s*\*{3,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 一节的正文本体：取到「自测」为止——自测是提问，不是这节课讲授了什么。 */
export function sectionProse(body = '') {
  const text = stripNoteDecorations(Array.isArray(body) ? body.join('\n') : body)
  const cut = text.search(/\*\*自测\*\*|自测（/)
  return (cut > 0 ? text.slice(0, cut) : text).trim()
}

function bullets(lines = []) {
  return lines
    .map(line => line.trim())
    .filter(line => /^([-*]|\d+\.)\s+/.test(line))
    .map(line => line.replace(/^([-*]|\d+\.)\s+/, '').replace(/^\[[ x]\]\s*/, '').trim())
    .filter(Boolean)
}

/** 概览块：核心问题、应当能够、课程脉络——简报那段话的主线就架在这三样上。 */
export function overviewFromSections(sections = []) {
  const overview = sections.find(section => OVERVIEW_TITLE.test(section.title))
  const out = { coreQuestions: [], shouldBeAbleTo: [], lectureThread: '' }
  if (!overview) return out
  for (const sub of [{ title: '', body: overview.body }, ...(overview.subs || [])]) {
    const body = stripNoteDecorations(sub.body.join('\n'))
    if (/核心问题|要回答的问题/.test(sub.title)) out.coreQuestions.push(...bullets(body.split('\n')))
    else if (/应当能够|学习目标/.test(sub.title)) out.shouldBeAbleTo.push(...bullets(body.split('\n')))
    else if (/脉络|主线/.test(sub.title)) out.lectureThread = body.replace(/^>\s?/gm, '').replace(/\s*\n+\s*/g, ' ').trim()
  }
  return out
}

/** 知识连接块：承接、铺垫、下节——简报要交代这节课在课程里的位置。 */
export function knowledgeLinkFromSections(sections = []) {
  const block = sections.find(section => LINK_TITLE.test(section.title))
  return block ? stripNoteDecorations(block.body.join('\n')) : ''
}

/**
 * 笔记自带的那份术语清单（正文末尾用于跨课整合的 META 行）。
 * 它只用来给模型「点名」：这一节涉及哪些概念、法条、案例——关键词那一列靠它不跑偏。
 */
export function termsFromMarkdown(markdown = '') {
  const buckets = { CONCEPT: [], CASE: [], PROVISION: [] }
  for (const line of String(markdown || '').split('\n')) {
    const meta = line.match(META_LINE)
    if (!meta) continue
    const kind = TERM_KIND[meta[1]] === '法条' ? 'PROVISION' : meta[1]
    if (!buckets[kind]) continue
    const term = cleanText(meta[2])
    if (term && !buckets[kind].includes(term)) buckets[kind].push(term)
  }
  return buckets
}

/** 术语「凡尔赛条约（相关条款）」在正文里按主干词匹配：括号里的是注解，不算词。 */
export function termStem(term = '') {
  return cleanText(String(term).split(/[（(]/)[0])
}

/** 小节标题去掉中文章序（「三、纽伦堡审判」→「纽伦堡审判」）：清单里本来就编号，别写两遍。 */
export function sectionTitleOf(title = '') {
  return cleanText(String(title).replace(/^[（(]?(?:[一二三四五六七八九十百]+|\d{1,2})[）)、.．]\s*/, ''))
}

/**
 * 按正文出现位置把术语分给各节：同一概念通常只在某一节展开，归错节比不归更糟——
 * 所以只认正文里真的出现过的主干词。
 */
export function assignTerms(prose = '', terms = {}) {
  const pick = kind => (terms[kind] || []).filter(term => {
    const stem = termStem(term)
    return stem.length >= 2 && prose.includes(stem)
  })
  return { concepts: pick('CONCEPT'), cases: pick('CASE'), provisions: pick('PROVISION') }
}

/** 截到句读处：宁可少一句，也不要半句话——模型看见半句就会替它补完。 */
export function clipAtSentence(text = '', limit = 0) {
  if (limit <= 0) return ''
  if (charCount(text) <= limit) return text
  const window = [...text].slice(0, limit + 40).join('')
  const cut = Math.max(
    window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('？'), window.lastIndexOf('！'), window.lastIndexOf('\n')
  )
  const body = cut >= limit * 0.5 ? window.slice(0, cut + 1) : [...text].slice(0, limit).join('')
  return body.trim()
}

/** 前言里的身份信息：课程名、教师、转录行号——正文残缺（课程名空着）时靠它兜底。 */
export function identityFromPreamble(preamble = '') {
  const line = String(preamble).split('\n').find(item => /课程：/.test(item)) || ''
  const parts = line.replace(/^>\s*/, '').split('·').map(item => item.trim()).filter(Boolean)
  const courseName = (parts.find(item => item.startsWith('课程：')) || '').replace('课程：', '').trim()
  const provenance = parts.find(item => /转录/.test(item)) || ''
  const teacher = parts.find(item => item !== parts[0] && !/转录/.test(item)) || ''
  return { courseName, teacher, provenance }
}

/**
 * 受控上下文：课程身份 + 概览（核心问题/应当能够/脉络）+ 各节标题与开头 + 每节的
 * 概念/案例/法条 + 知识连接 + 元数据。全部来自成品正文，不看写单元。
 */
export function buildBriefSourceFromFinalNote(markdown = '', {
  courseName = '',
  lessonTitle = '',
  mainLine = '',
  budget = BRIEF_SOURCE_BUDGET.total,
  sectionChars = BRIEF_SOURCE_BUDGET.sectionPreferred
} = {}) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n')
  if (!text.trim()) throw new Error('简报上下文只能来自成品正文，但正文是空的')
  const { preamble, sections } = parseFinalNote(text)
  const identity = identityFromPreamble(preamble)
  const overview = overviewFromSections(sections)
  const link = knowledgeLinkFromSections(sections)
  const terms = termsFromMarkdown(text)
  const isContent = section =>
    !OVERVIEW_TITLE.test(section.title) && !LINK_TITLE.test(section.title) && !APPENDIX_TITLE.test(section.title)
  const content = sections
    .filter(isContent)
    .map(section => {
      const prose = sectionProse(section.body)
      return { title: section.title, prose, ...assignTerms(prose, terms) }
    })
    .filter(section => section.prose || section.concepts.length || section.cases.length)
  const appendix = sections.filter(section => APPENDIX_TITLE.test(section.title))
  // 案例名、法条名常常不在正文里逐字出现（"尼加拉瓜案"在正文里写作"该案"）：归不了节，
  // 也不能丢——它们是关键词那一列最好的来源，单独列一行，不硬塞进某一节
  const assigned = new Set(content.flatMap(section => [...section.concepts, ...section.cases, ...section.provisions]))
  const leftovers = ['CONCEPT', 'CASE', 'PROVISION']
    .map(kind => ({ kind, terms: (terms[kind] || []).filter(term => !assigned.has(term)) }))
    .filter(group => group.terms.length)

  const head = [
    `课程：${courseName || identity.courseName || ''}`,
    `课次：${lessonTitle || ''}`,
    `主线：${mainLine || overview.lectureThread || ''}`,
    '',
    '## 课程概览（来自成品正文）',
    `核心问题：${overview.coreQuestions.join('；')}`,
    `应当能够：${overview.shouldBeAbleTo.join('；')}`,
    `课程脉络：${overview.lectureThread}`,
    ''
  ].join('\n')
  const tail = [
    '',
    '## 知识连接',
    link || '（正文未记录）',
    '',
    '## 元数据',
    `小节数：${content.length}；正文长度：${charCount(text)} 字；转录：${identity.provenance || '未标注'}`
  ].join('\n')
  const termLines = leftovers.length
    ? [
        '',
        '## 其他术语（笔记元数据里列出、正文未逐字出现的）',
        ...leftovers.map(group => `- ${TERM_KIND[group.kind]}：${group.terms.map(termStem).join('、')}`)
      ].join('\n')
    : ''
  const appendixLines = appendix.length
    ? [
        '',
        '## 附录小节（只列标题）',
        ...appendix.flatMap(section => [
          `- ${section.title}`,
          ...(section.subs || []).map(sub => `  - ${sub.title}`)
        ])
      ].join('\n')
    : ''

  const compose = cap => {
    const body = content.map((section, index) => {
      const lines = [`${index + 1}. ${sectionTitleOf(section.title) || section.title}`]
      const excerpt = clipAtSentence(section.prose, cap).replace(/\n+/g, ' ')
      if (excerpt) lines.push(`   开头：${excerpt}`)
      const terms = kind => section[kind].map(termStem).filter(Boolean).join('、')
      if (section.concepts.length) lines.push(`   概念：${terms('concepts')}`)
      if (section.cases.length) lines.push(`   案例：${terms('cases')}`)
      if (section.provisions.length) lines.push(`   法条：${terms('provisions')}`)
      return lines.join('\n')
    })
    return [head, '## 各节标题与开头', body.join('\n'), termLines, appendixLines, tail].filter(Boolean).join('\n')
  }

  // 预算按节数摊：节多则每节少几句，但永不越过 500 字，也永不把标题挤掉
  const fixed = charCount(head) + charCount(tail) + charCount(termLines) + charCount(appendixLines)
  const room = Math.max(0, budget - fixed)
  let cap = Math.min(
    BRIEF_SOURCE_BUDGET.sectionMax,
    sectionChars,
    Math.max(BRIEF_SOURCE_BUDGET.sectionMin, Math.floor(room / Math.max(1, content.length)))
  )
  let source = compose(cap)
  for (let round = 0; round < 6 && charCount(source) > budget && cap > BRIEF_SOURCE_BUDGET.sectionMin; round += 1) {
    cap = Math.max(BRIEF_SOURCE_BUDGET.sectionMin, Math.floor(cap * 0.8))
    source = compose(cap)
  }
  // 极端情况（几十个小节的长课）：只留标题与术语，也不越过预算
  if (charCount(source) > budget) source = compose(0)
  return source
}

/** 兼容入口：老调用方（course brief 等）走同一份实现，避免两条路径各写一套规则。 */
export function buildBriefSourceFromMarkdown(markdown = '', options = {}) {
  return buildBriefSourceFromFinalNote(markdown, options)
}

/** 受控上下文的指纹：简报与它要发布的那篇正文绑在一起，串课当场就能发现。 */
export function briefSourceChecksum(markdown = '') {
  return createHash('sha256').update(String(markdown || '').replace(/\r\n?/g, '\n').trimEnd()).digest('hex')
}

/**
 * 校验简报与笔记同源。
 *
 * 目录是共享的：同一个 --from 目录里放过几节课的 brief.json 时，谁最后写谁生效，
 * 结果是几节课共用一段简报。绑定字段（course/lesson/sourceChecksum）任一不符就报错——
 * 宁可发布失败，也不要发一篇串课的简报出去。
 */
export function checkBriefBinding(brief = {}, { course = '', lesson = '', markdown = '' } = {}) {
  const problems = []
  if (course && brief.course && brief.course !== course) {
    problems.push(`课程不符（简报是 ${brief.course}，要发布的是 ${course}）`)
  }
  if (lesson && brief.lesson && brief.lesson !== lesson) {
    problems.push(`课次不符（简报是 ${brief.lesson}，要发布的是 ${lesson}）`)
  }
  if (markdown && brief.sourceChecksum && brief.sourceChecksum !== briefSourceChecksum(markdown)) {
    problems.push('简报的来源指纹与要发布的笔记正文不符')
  }
  const bound = Boolean(brief.course && brief.lesson && brief.sourceChecksum)
  return { ok: problems.length === 0, bound, problems }
}

export function assertBriefBinding(brief = {}, options = {}) {
  const check = checkBriefBinding(brief, options)
  if (!check.ok) throw new Error(`简报与笔记不同源：${check.problems.join('；')}`)
  return check
}
