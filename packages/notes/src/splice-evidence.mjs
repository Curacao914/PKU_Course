import { cleanText } from '@course/core'

import { charCount, sectionProse } from './brief-source.mjs'
import { coversOutline } from './outline-ids.mjs'

/**
 * 接缝层的**依据摘录**。
 *
 * 问题：接缝模型（splicer）既写章节总结、自测题与参考答案，又写概念索引的定义与易混、
 * 案例要旨、方法卡与 ASR 更正——而它此前只看到大纲标题、术语名字和课件页首行，
 * **看不到正文**（当初这么做是为了不让它改写、压缩已批准的节点正文）。
 * 于是这些"解释性"内容只能凭名字编，正是模型最容易编得像那么回事的地方。
 *
 * 做法：从**已批准**的节点正文里抽出"要点句"（规则、要件、判断标准、区分、例外这类
 * 句式，以及老师自己写的小标题），按节点聚合、按预算截断，作为**依据**交给接缝模型。
 * 三条纪律：
 *   1. 摘录是节选，不是正文——每个节点有上限，整课有总预算；
 *   2. 接缝层不得整句照搬摘录（接缝是索引与导航，不是第二份正文）；
 *   3. 摘录里没有依据的内容宁可留空，不许补一个看起来合理的说法。
 * 只给摘录仍然可能被照搬，所以落盘前还有一道机械校验（isVerbatimCopy）。
 */
export const SPLICE_EVIDENCE = { perNode: 600, total: 6000, minSentence: 8 }

/** "要点句"：规则、要件、判断标准、区分、例外这类句子才是索引与自测的依据。 */
const RULE_MARKERS = /(是指|指的是|所谓|构成要件|要件|判断标准|标准是|判断|规则|原则|例外|区分|区别|条件|效力|不得|应当|必须|属于|分为|分类|依据|适用于|定义为)/

/** 老师自己写的小标题（**（一）…**）是这一节的结构，保留下来当骨架。 */
const STRUCTURE_LINE = /^\*\*[^*]{2,60}\*\*$/

function sentences(paragraph = '') {
  return String(paragraph)
    .split(/(?<=[。！？；])/)
    .map(item => item.trim())
    .filter(Boolean)
}

/**
 * 一个节点正文的要点摘录：先取小标题与要点句，不够预算再补各段首句。
 * 全部按原文顺序回填，读起来仍是这一节的推进顺序。
 */
export function nodeEvidence(draft = '', { limit = SPLICE_EVIDENCE.perNode } = {}) {
  const prose = sectionProse(draft)
  if (!prose) return ''
  const paragraphs = prose.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean)
  const picked = []
  const seen = new Set()
  const represented = new Set()
  const take = (index, text) => {
    // 列表符号与引用符号是排版，不是句子内容（"- 议价成本：…" 会读成正文里的破折号）
    const value = String(text || '').replace(/^\s*(?:[-*+]|\d+[.、]|>)\s*/, '').trim()
    if (charCount(value) < SPLICE_EVIDENCE.minSentence) return
    if (seen.has(value)) return
    seen.add(value)
    picked.push(value)
    represented.add(index)
  }

  // 先按原文顺序收小标题与要点句：一段里可能有好几句都是规则/标准，不能只留第一句
  paragraphs.forEach((paragraph, index) => {
    for (const line of paragraph.split('\n').map(item => item.trim()).filter(Boolean)) {
      if (STRUCTURE_LINE.test(line)) take(index, line.replace(/\*\*/g, '').replace(/[★☆]+/g, '').trim())
    }
    for (const sentence of sentences(paragraph)) {
      if (RULE_MARKERS.test(sentence)) take(index, sentence)
    }
  })
  // 预算还有余量时，把没被要点句代表的段落用首句补上：索引表要覆盖到每一节
  paragraphs.forEach((paragraph, index) => {
    if (represented.has(index)) return
    take(index, sentences(paragraph)[0])
  })

  let text = ''
  for (const sentence of picked) {
    const next = text ? `${text} ${sentence}` : sentence
    if (charCount(next) > limit) break
    text = next
  }
  return text
}

/** 每个大纲节点对应哪些已批准节点正文（合并写单元要挂到它覆盖的每一节）。 */
export function draftsByOutline(lesson = {}) {
  const map = new Map((lesson.outline || []).map(node => [node.id, []]))
  for (const node of lesson.nodes || []) {
    for (const outlineNode of lesson.outline || []) {
      if (coversOutline(node, outlineNode.id) && map.has(outlineNode.id)) map.get(outlineNode.id).push(node)
    }
  }
  return map
}

/**
 * 整课的依据摘录：按大纲顺序聚合，总预算封顶。
 * 返回 { byOutlineId, entries, chars, text }——text 直接进接缝模型的补充材料块。
 */
export function spliceEvidence(lesson = {}, { perNode = SPLICE_EVIDENCE.perNode, total = SPLICE_EVIDENCE.total } = {}) {
  const outline = lesson.outline || []
  const drafts = draftsByOutline(lesson)
  const build = cap => {
    const entries = outline.map(node => {
      const parts = (drafts.get(node.id) || [])
        .map(child => nodeEvidence(child.draft, { limit: cap }))
        .filter(Boolean)
      return {
        id: node.id,
        title: cleanText(node.title) || node.id,
        evidence: parts.join(' ').slice(0, cap),
        concepts: (node.concepts || []).map(cleanText).filter(Boolean),
        statutes: (node.statutes || []).map(cleanText).filter(Boolean),
        cases: (node.cases || []).map(cleanText).filter(Boolean)
      }
    })
    const text = renderSpliceEvidence(entries)
    return { byOutlineId: Object.fromEntries(entries.map(entry => [entry.id, entry.evidence])), entries, chars: charCount(text), text }
  }

  // 预算按节数摊，超出总预算就整体下探（下限 120 字），标题与术语永远保留
  let cap = Math.max(120, Math.min(perNode, Math.floor(total / Math.max(1, outline.length))))
  let result = build(cap)
  for (let round = 0; round < 6 && result.chars > total && cap > 120; round += 1) {
    cap = Math.max(120, Math.floor(cap * 0.8))
    result = build(cap)
  }
  return result
}

/** 没有依据的节也要出现：明确告诉模型"这一节没有可引用的规则句"，比让它猜好。 */
function renderSpliceEvidence(entries = []) {
  const lines = [
    '## 依据摘录（来自已批准正文的要点句，只作依据）',
    '用法：章节总结、索引表说明、自测题答案、方法卡必须落在这些句子或课件里真的出现过；',
    '摘录里没有依据的条目宁可留空，不要补一个看起来合理的说法；不得整句照搬摘录充作正文。'
  ]
  for (const entry of entries) {
    lines.push('', `### ${entry.title}`)
    lines.push(entry.evidence ? `- 要点：${entry.evidence}` : '- 要点：（本节没有可直接引用的规则句，只能依据标题与术语）')
    if (entry.concepts.length) lines.push(`- 概念：${entry.concepts.join('、')}`)
    if (entry.statutes.length) lines.push(`- 法条：${entry.statutes.join('、')}`)
    if (entry.cases.length) lines.push(`- 案例：${entry.cases.join('、')}`)
  }
  return lines.join('\n')
}

/** 清理后的本节正文：用来判断"总结段是不是把正文原样搬了一遍"。 */
export function sectionBodyIndex(lesson = {}) {
  const drafts = draftsByOutline(lesson)
  const index = new Map()
  for (const [id, nodes] of drafts) {
    index.set(id, nodes.map(node => sectionProse(node.draft)).filter(Boolean).join('\n'))
  }
  return index
}

/**
 * 逐字照搬判定：接缝层与正文是两条来源，反了就会读成"同一段话说两遍"。
 * 用前若干字做窗口比对，避免因为接缝层在后面多写一句就漏过去。
 */
export function isVerbatimCopy(excerpt = '', body = '', { minChars = 30, window = 40 } = {}) {
  const text = cleanText(String(excerpt)).replace(/\s+/g, '')
  const source = String(body || '').replace(/\s+/g, '')
  if (!text || !source || text.length < minChars) return false
  return source.includes(text.slice(0, window))
}
