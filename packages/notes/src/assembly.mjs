import { cleanText } from '@course/core'

/**
 * 机械拼装：把已批准节点、接缝数据与元数据合成单课最终笔记。
 *
 * 从 my-blog-front 的 lib/course/workflowState.js（buildFinalNoteMarkdown 及其渲染器）
 * 摘出。这里的原则是"程序负责结构、模型只负责接缝"：
 *
 *   - 节点正文原样进入最终稿，只剥离其内部的 META 标记；
 *   - 模型给的接缝内容不足时由程序补足（课程概览、章节总结、自测、知识连接），
 *     而不是让最终稿出现空白或半截结构；
 *   - 拼装完成后做两项硬校验：**每个已批准节点的正文都必须在最终稿里**、
 *     **不得残留 {{占位符}}**。任何一项不满足就报错，而不是交付一份缺内容的笔记。
 */

const CHINESE_INDEX = '一二三四五六七八九十'

export function spliceString(value, fallback = '') {
  return cleanText(value) || fallback
}

function uniqueStrings(values = []) {
  const seen = new Set()
  return (values || []).map(value => cleanText(value)).filter(value => {
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

/** 取至少 minimum、最多 maximum 条：模型给的不够就用兜底补齐，给多了截断。 */
function ensureCount(values, fallbacks, minimum, maximum) {
  const merged = uniqueStrings([...(Array.isArray(values) ? values : []), ...(fallbacks || [])])
  return merged.slice(0, Math.max(minimum, maximum))
}

export function chineseIndex(index) {
  return CHINESE_INDEX[index] || String(index + 1)
}

export function outlineTopic(outlineNode = {}, fallback = '本节内容') {
  return cleanText(outlineNode.title || fallback)
    .replace(/^[一二三四五六七八九十]+、\s*/, '')
    .replace(/[★☆]+\s*$/, '')
    .trim() || fallback
}

/**
 * 把节点正文里的 Markdown 标题整体降级，保证它永远在章节标题（###）之下。
 *
 * 为什么要在程序里兜：提示词已经要求节点正文不写 Markdown 标题、改用中式层级，
 * 但模型偶尔仍会自带 `# 变量总论`。拼装时若原样插入，成品笔记里就会出现两套层级
 * 并存（一节一个 ### 标题，正文里却冒出 # 和 ##），读者无法判断谁是章节。
 * 降级是确定性的：正文里最浅的标题一律落到 ####，相对层级保持不变。
 */
export function demoteBodyHeadings(markdown = '', floor = 4) {
  const lines = String(markdown ?? '').split('\n')
  const levels = lines
    .map(line => line.match(/^(#{1,6})\s+\S/))
    .filter(Boolean)
    .map(match => match[1].length)
  if (!levels.length) return markdown
  const shift = Math.max(0, floor - Math.min(...levels))
  return lines
    .map(line => {
      const match = line.match(/^(#{1,6})(\s+.*)$/)
      if (!match) return line
      const level = Math.min(6, match[1].length + shift)
      return `${'#'.repeat(level)}${match[2]}`
    })
    .join('\n')
}

/** 去掉节点正文里的 META 标记：它们是给跨课整合用的，不该出现在正文中。 */
export function stripMetaBlock(markdown = '') {
  return demoteBodyHeadings(cleanText(markdown)
    .replace(/<!--\s*META[\s\S]*?-->\s*/gi, '')
    .replace(/META_FOR_NODE:\s*\n[\s\S]*?(?=\n\s*\n|$)/gi, '')
    .trim())
}

export function extractNodeMetadata(node = {}) {
  const values = []
  const draft = String(node.draft || '')
  const matches = draft.matchAll(/^\s*-?\s*(CONCEPT|PROVISION|CASE|PITFALL):\s*(.+?)\s*$/gim)
  for (const match of matches) values.push([match[1].toUpperCase(), cleanText(match[2])])
  ;(node.concepts || []).forEach(value => values.push(['CONCEPT', cleanText(value)]))
  ;(node.statutes || []).forEach(value => values.push(['PROVISION', cleanText(value).replace(/[《》〈〉]/g, '')]))
  ;(node.cases || []).forEach(value => values.push(['CASE', cleanText(value)]))
  return values.filter(([, value]) => value)
}

export function renderMetaBlock(nodes = []) {
  const typeOrder = { CONCEPT: 0, PROVISION: 1, CASE: 2, PITFALL: 3 }
  const seen = new Set()
  const rows = (nodes || [])
    .flatMap(extractNodeMetadata)
    .filter(([type, value]) => {
      const key = `${type}:${value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (typeOrder[a[0]] ?? 9) - (typeOrder[b[0]] ?? 9) || a[1].localeCompare(b[1], 'zh-CN'))
  const lines = rows.map(([type, value]) => `META: ${type}: ${value}`).join('\n')
  return ['<details><summary>📑 笔记元数据（用于跨课整合）</summary>', '<pre><code>', lines, '</code></pre>', '</details>'].join('\n')
}

/**
 * 补足接缝数据。
 *
 * 模型给的内容往往偏短或偏少（尤其大纲章节多时），这里按固定规则补齐：
 * 总结不足 45 字补一段说明、自测题补到 2—4 题、核心问题与学习目标补到 3—5 条、
 * 课程脉络不足 60 字补一段。补齐的内容是**结构性**的，不引入课堂事实。
 */
export function normalizedSpliceData(lesson = {}, value = {}) {
  const outline = lesson.outline || []
  const overview = value.courseOverview || value.course_overview || {}
  const topics = outline.map(node => outlineTopic(node))

  const coreFallbacks = [
    ...topics.slice(0, 3).map(topic => `如何理解${topic}，它在本课论证中发挥什么作用？`),
    `本课各部分如何围绕“${lesson.blueprint?.mainLine || lesson.title}”形成完整的讲授主线？`,
    '本课涉及的概念、规则与案例之间有哪些需要辨析的联系？',
    '如何把本课的核心论证用于解释或分析具体问题？'
  ]
  const abilityFallbacks = [
    ...topics.slice(0, 3).map(topic => `解释${topic}的核心内容及其与本课主线的联系`),
    '复述本课的讲授主线并说明各部分之间的逻辑关系',
    '辨析本课容易混淆的概念、规则或观点',
    '运用本课的核心论证分析一个相关问题'
  ]
  const coreQuestions = ensureCount(overview.coreQuestions || overview.core_questions, coreFallbacks, 3, 5)
  const shouldBeAbleTo = ensureCount(overview.shouldBeAbleTo || overview.should_be_able_to, abilityFallbacks, 3, 5)

  const rawThread = spliceString(overview.lectureThread || overview.lecture_thread, lesson.blueprint?.mainLine || '')
  const fallbackThread = `本课围绕${topics.length ? topics.join('、') : lesson.title}依次展开。各部分按照已确认的大纲衔接，先建立概念和问题意识，再进入规则、论证与课堂材料的具体分析，最后回到本课主线说明各节点之间的关系。`
  const lectureThread = rawThread.length >= 60 ? rawThread : [rawThread, fallbackThread].filter(Boolean).join(' ')

  const incomingSummaries = value.sectionSummaries || value.h1Summaries || value.h1_summaries || {}
  const incomingQuizzes = value.sectionQuizzes || value.h1Quizzes || value.h1_quizzes || {}
  const sectionSummaries = {}
  const sectionQuizzes = {}
  outline.forEach(node => {
    const topic = outlineTopic(node)
    const rawSummary = spliceString(incomingSummaries[node.id], node.rationale || '')
    const fallbackSummary = `本节围绕${topic}展开，承担本课主线中的一个独立论证环节。通过已批准节点中的概念、规则、案例或教师讲授内容，本节说明该问题如何与前后章节衔接，并为后续理解和应用提供基础。`
    sectionSummaries[node.id] = rawSummary.length >= 45 ? rawSummary : [rawSummary, fallbackSummary].filter(Boolean).join(' ')
    sectionQuizzes[node.id] = ensureCount(incomingQuizzes[node.id], [
      `如何用自己的话解释${topic}的核心内容？`,
      `${topic}与本课相邻问题之间有什么区别或联系？`
    ], 2, 4)
  })

  const knowledge = value.knowledgeLink || value.knowledge_link || {}
  const incomingGroundwork = Array.isArray(knowledge.laysGroundworkFor)
    ? knowledge.laysGroundworkFor
    : (Array.isArray(knowledge.lays_groundwork_for) ? knowledge.lays_groundwork_for : [])
  const laysGroundworkFor = incomingGroundwork.length ? incomingGroundwork : topics.slice(0, 3).map(topic => ({
    concept: topic,
    use: '作为后续课程中相关规则、制度或案例分析的理解基础'
  }))

  return {
    courseOverview: { coreQuestions, shouldBeAbleTo, lectureThread },
    sectionSummaries,
    sectionQuizzes,
    knowledgeLink: {
      inheritsFrom: spliceString(knowledge.inheritsFrom || knowledge.inherits_from),
      laysGroundworkFor,
      nextLessonPreview: spliceString(knowledge.nextLessonPreview || knowledge.next_lesson_preview)
    },
    appendix: value.appendix && typeof value.appendix === 'object' ? value.appendix : {}
  }
}

export function renderCourseOverview(value = {}, lesson = {}) {
  const questions = Array.isArray(value.coreQuestions) ? value.coreQuestions.filter(Boolean).slice(0, 6) : []
  const abilities = Array.isArray(value.shouldBeAbleTo) ? value.shouldBeAbleTo.filter(Boolean).slice(0, 7) : []
  const thread = spliceString(value.lectureThread, lesson.blueprint?.mainLine || '')
  const lines = ['## 课程概览', '', '### 本课要回答的核心问题']
  ;(questions.length ? questions : [`如何理解${lesson.title}的核心问题及其展开逻辑？`])
    .forEach((item, index) => lines.push(`${index + 1}. ${item}`))
  lines.push('', '### 本课你应当能够')
  ;(abilities.length ? abilities : ['沿课程主线复述本课的核心概念、规则与案例论证'])
    .forEach(item => lines.push(`- [ ] ${item}`))
  lines.push('', '### 课程脉络')
  lines.push(...String(thread || '本课按照已确认大纲逐节展开。').split('\n').map(line => `> ${line}`))
  return lines.join('\n')
}

export function renderQuiz(items = []) {
  const questions = Array.isArray(items) ? items.filter(Boolean).slice(0, 4) : []
  if (!questions.length) return ''
  return ['> **自测**（合上笔记，能回答吗？）', ...questions.map((item, index) => `> ${index + 1}. ${item}`)].join('\n')
}

export function renderKnowledgeLink(value = {}, lesson = {}) {
  const groundwork = Array.isArray(value.laysGroundworkFor) ? value.laysGroundworkFor.filter(Boolean) : []
  const inferred = (lesson.outline || [])
    .flatMap(node => node.concepts || [])
    .slice(0, 3)
    .map(concept => ({ concept, use: '作为后续相关制度、规则或案例分析的概念基础' }))
  const items = groundwork.length ? groundwork : inferred
  const lines = ['## 知识连接', '']
  const inherited = spliceString(value.inheritsFrom)
  if (inherited) lines.push(`**承接什么**：${inherited}`, '')
  lines.push('**为后续铺垫什么**：')
  ;(items.length ? items : [{ concept: lesson.title, use: '为后续课程中的深化与应用提供基础' }]).forEach(item => {
    if (typeof item === 'string') lines.push(`- ${item}`)
    else lines.push(`- ${spliceString(item.concept, '本课核心内容')} → ${spliceString(item.use, '后续课程中的深化与应用')}`)
  })
  const preview = spliceString(value.nextLessonPreview)
  if (preview) lines.push('', `**下节预告**：${preview}`)
  return lines.join('\n')
}

export function renderAppendix(value = {}) {
  const terms = Array.isArray(value.terms) ? value.terms.filter(Boolean) : []
  const topics = Array.isArray(value.topics) ? value.topics.filter(Boolean) : []
  if (!terms.length && !topics.length) return ''
  const lines = ['## 附录：补充与发散', '', '> 以下内容为课堂补充材料和发散性讨论，不影响课程主线。']
  if (terms.length) {
    lines.push('', '### 术语汇总', '', '| 术语 | 英文/原文 | 定义或说明 |', '|------|----------|-----------|')
    terms.forEach(term => lines.push(
      `| ${spliceString(term.term)} | ${spliceString(term.original)} | ${spliceString(term.definition)} |`
    ))
  }
  topics.forEach(topic => lines.push('', `### ${spliceString(topic.title, '发散话题')}`, '', spliceString(topic.content)))
  return lines.join('\n')
}

export function buildFinalNoteMarkdown({ courseSpec = {}, lesson = {}, spliceData = {} } = {}) {
  const byOutline = new Map((lesson.outline || []).map(item => [item.id, []]))
  const orphan = []
  ;(lesson.nodes || []).forEach(node => {
    if (byOutline.has(node.outlineNodeId)) byOutline.get(node.outlineNodeId).push(node)
    else orphan.push(node)
  })

  const summaries = spliceData.sectionSummaries || {}
  const quizzes = spliceData.sectionQuizzes || {}
  const parts = [
    `# ${lesson.title}`,
    '',
    `> 课程：${courseSpec.courseName || ''}${courseSpec.teacher ? ` · ${courseSpec.teacher}` : ''}`,
    '',
    renderCourseOverview(spliceData.courseOverview || {}, lesson),
    '',
    '***'
  ]

  ;(lesson.outline || []).forEach((outlineNode, index) => {
    const title = outlineTopic(outlineNode)
    parts.push('', `### ${chineseIndex(index)}、${title}`, '')
    const summary = spliceString(summaries[outlineNode.id], outlineNode.rationale || '')
    if (summary) parts.push(summary, '')
    ;(byOutline.get(outlineNode.id) || []).forEach(node => parts.push(stripMetaBlock(node.draft), ''))
    const quiz = renderQuiz(quizzes[outlineNode.id])
    if (quiz) parts.push(quiz, '')
    parts.push('***')
  })

  // 大纲之外仍有正文的节点不能丢：归入「其他」而不是静默消失
  if (orphan.length) {
    parts.push('', '### 其他', '')
    orphan.forEach(node => parts.push(stripMetaBlock(node.draft), ''))
    parts.push('***')
  }

  const appendix = renderAppendix(spliceData.appendix || {})
  if (appendix) parts.push('', appendix, '')
  parts.push('', renderKnowledgeLink(spliceData.knowledgeLink || {}, lesson), '', '***', '', renderMetaBlock(lesson.nodes || []))

  return parts
    .filter((value, index, array) => value !== '' || array[index - 1] !== '')
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/**
 * 拼装单课最终笔记。
 *
 * 前置条件：所有节点都已批准。拼装后做两项硬校验，任何一项不通过就抛错——
 * 宁可失败也不要交付一份缺了节点正文、或还带着 {{占位符}} 的笔记。
 */
export function assembleFinalNote(lesson, spliceData = {}, { courseSpec = {}, trace = null, at } = {}) {
  const nodes = lesson.nodes || []
  if (!nodes.length || nodes.some(node => node.status !== 'node_approved')) {
    throw new Error('拼装前所有节点都必须已批准')
  }
  const normalized = normalizedSpliceData(lesson, spliceData)
  const markdown = buildFinalNoteMarkdown({ courseSpec, lesson, spliceData: normalized })

  const missingBody = nodes.find(node => {
    const body = stripMetaBlock(node.draft)
    return body && !markdown.includes(body)
  })
  if (missingBody) throw new Error(`拼装后的笔记缺少已批准节点正文：${missingBody.id}`)
  if (/\{\{[^}]+\}\}/.test(markdown)) throw new Error('拼装后的笔记仍残留接缝占位符')

  const stamp = (at instanceof Date ? at : new Date(at ?? Date.now())).toISOString()
  const assembly = {
    spliceData: normalized,
    trace,
    assembledAt: stamp,
    nodeVersions: Object.fromEntries(nodes.map(node => [node.id, node.versions?.length || 0]))
  }

  return {
    ...lesson,
    status: 'final_review',
    qualityReport: null,
    finalReviewAttention: null,
    finalNote: { markdown, stale: false, qualityReport: null, updatedAt: stamp, assembly },
    publication: lesson.publication ? { ...lesson.publication, stale: true } : null,
    finalNoteVersions: [
      ...(lesson.finalNoteVersions || []).slice(-19),
      {
        version: (lesson.finalNoteVersions || []).length + 1,
        at: stamp,
        value: markdown,
        source: 'assembly',
        trace,
        summary: '按已批准节点机械拼装，并补入课程概览、章节总结、自测、知识连接、附录与元数据。'
      }
    ],
    updatedAt: stamp
  }
}
