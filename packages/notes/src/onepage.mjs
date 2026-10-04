import { cleanText } from '@course/core'

import { buildPrompt } from './ai-adapter.mjs'

/**
 * 一页纸摘要：把一节课压进一张 A4。
 *
 * 与简报的区别：简报是"要不要细读"的判断依据（一段话 + 三条要点），
 * 一页纸是"复习时只看这一页"的完整骨架——体系、要点、对照，都要在，但一个字也不多。
 *
 * 排版约束写进提示词（而不是事后裁剪）：模型一次就按 A4 的容量来写，
 * 页面那边再做一次自动缩放兜底（见 reader 的一页纸脚本），两头都不许出现截断。
 */

/** 目标字数：A4 三栏、约 10.5px 的字号，两千字上下是"塞满但不挤"的位置。 */
export const ONEPAGE_TARGET_CHARS = 1800
/** 硬上限：超过这个数，页面再怎么缩也放不下，必须让模型重写。 */
export const ONEPAGE_MAX_CHARS = 2600

export const ONEPAGE_SCHEMA = {
  title: 'string（不超过 20 字，这一页的标题，可以是本课主题）',
  markdown: 'string（一张 A4 能放下的复习页 Markdown：短句、列表、表格；不要长段落）',
  outline: ['string（3—6 条，这一页分了哪几块，供目录/校验用）'],
  // 来源映射：让读者能回到"这句话的依据在哪一节"。
  // 只允许从**给定的小节清单**里挑 id；链接由程序拼，模型不许自己写地址。
  sourceMap: [{
    block: 'string（这一条对应 markdown 里的哪一块：给出该块**开头的 8—20 个字**，程序据此定位）',
    label: 'string（这一块在讲什么，不超过 20 字）',
    sections: [{
      id: 'string（必须逐个字符照抄"可用小节清单"里的 id，不许自己编）',
      title: 'string（该小节标题，照抄清单）',
      quote: 'string（该小节正文里**逐字出现**的一小段话，12—60 字，原样照抄，不许改写）'
    }]
  }]
}

/**
 * 来源映射（**按课次一次调用**）的契约。
 *
 * 为什么要有模型这一档：一页纸是概括改写，与正文逐字重合很少，纯词法路径只能定位很小一部分
 * （真实课次实测 1/22）。让模型读一遍"带小节 id 的笔记 + 一页纸"，为每块挑来源，
 * 覆盖率才上得去。**一次调用覆盖整节课**，不是每个要点各调一次。
 *
 * 两条硬约束写在提示词里，回来还要程序核对：
 *   · 小节 id 只能从给定清单里挑（编的会被丢掉）；
 *   · 摘录必须**逐字**抄自那一节正文（发布链路会逐字比对，抄错或改写的一律作废）。
 */
export const SOURCE_MAP_SCHEMA = {
  entries: [{
    block: 'string（这一条对应一页纸里的哪一块：给出该块**开头的 10—20 个字**，程序据此定位）',
    label: 'string（这一块在讲什么，不超过 20 字）',
    sections: [{
      id: 'string（必须逐字照抄"可用小节清单"里的 id）',
      quote: 'string（该小节正文里**逐字出现**的一段话，15—60 字，原样照抄，不许改写、不许拼接）'
    }]
  }]
}

export function buildSourceMapSource({ courseName = '', lessonTitle = '', noteMarkdown = '', onepageMarkdown = '', sections = [], blocks = null } = {}) {
  return [
    `课程：${courseName}`,
    `课次：${lessonTitle}`,
    '',
    '## 可用小节清单（sections[].id 只能从这里挑，逐字照抄）',
    ...sections.map(section => `- ${section.id}｜${section.title}`),
    '',
    '## 这一页纸',
    String(onepageMarkdown || '').trim(),
    // 分批时只列这一批要标的块：一次回答几十块，输出容易被截断，回包就废了（实测踩到）
    ...(Array.isArray(blocks) && blocks.length
      ? [
        '',
        `## 本次只要标注这 ${blocks.length} 块（其余块已经标好，不要重复）`,
        ...blocks.map(block => `- ${block.label}`)
      ]
      : []),
    '',
    '## 笔记全文（摘录只能从这些正文里逐字复制）',
    String(noteMarkdown || '').trim()
  ].join('\n')
}

/**
 * 来源映射草稿的形状校验（**只校验形状**）。
 *
 * 为什么不在这一步核对"小节真的存在、摘录真的在那一节里"：那要正文与小节切法，
 * 而它们都在发布侧（@course/publish）。职责分开——模型契约在 notes，
 * 块 ID 解析、指纹与逐字核对在 publish，最后在发布链路里合成。
 */
export function normalizeSourceMapDraft(value) {
  return (Array.isArray(value) ? value : []).map(entry => ({
    block: cleanText(entry?.block || entry?.blockHint || '').slice(0, 60),
    label: cleanText(entry?.label || '').slice(0, 40),
    sections: (Array.isArray(entry?.sections) ? entry.sections : []).map(link => ({
      id: cleanText(link?.id || ''),
      title: cleanText(link?.title || '').slice(0, 80),
      quote: cleanText(link?.quote || link?.excerpt || '').slice(0, 120)
    })).filter(link => link.id && link.quote)
  })).filter(entry => entry.block && entry.sections.length).slice(0, 60)
}

export function buildOnepageSource({ markdown = '', courseName = '', lessonTitle = '', budgetNote = '', sections = [] } = {}) {
  const text = String(markdown || '').trim()
  if (!text) throw new Error('没有笔记正文，无法生成一页纸')
  return [
    `课程：${courseName}`,
    `课次：${lessonTitle}`,
    `目标篇幅：${ONEPAGE_TARGET_CHARS} 字左右（含表格单元格），绝不能超过 ${ONEPAGE_MAX_CHARS} 字`,
    budgetNote ? `上一版被退回的原因：${budgetNote}` : '',
    sections.length
      ? [
        '',
        '## 可用小节清单（sourceMap.sections[].id 只能从这里挑，逐字照抄）',
        ...sections.map(section => `- ${section.id}｜${section.title}`)
      ].join('\n')
      : '',
    '',
    '## 笔记全文（这是唯一素材，不得新增其中没有的内容）',
    text
  ].filter(Boolean).join('\n')
}

/** 校验：必须有内容、必须在字数上限内、不能整段堆文字。 */
export function validateOnepage(value = {}) {
  const markdown = cleanText(value.markdown || value.text || '')
  if (markdown.length < 400) throw new Error('一页纸过短，可能没写出来')
  const chars = markdown.replace(/\s/g, '').length
  if (chars > ONEPAGE_MAX_CHARS) {
    throw new Error(`一页纸 ${chars} 字，超过一张 A4 的上限 ${ONEPAGE_MAX_CHARS} 字（宁可少写要点，也不要在页面上被截断）`)
  }
  // 长段落是一页纸的天敌：连续 180 字没有换行/列表/表格，就要求重写
  const wall = markdown.split(/\n\s*\n/).find(block => !/^[\s]*([-*|#>]|\d+[.、])/m.test(block) && block.replace(/\s/g, '').length > 180)
  const paragraphs = markdown.split(/\n\s*\n/).filter(block => block.trim())
  const lists = (markdown.match(/^\s*([-*]|\d+[.、])\s/gm) || []).length
  const tables = (markdown.match(/^\s*\|/gm) || []).length
  return {
    title: cleanText(value.title || '').slice(0, 30),
    markdown,
    outline: (Array.isArray(value.outline) ? value.outline : []).map(item => cleanText(item)).filter(Boolean).slice(0, 8),
    // 来源映射草稿要一路带出去：schema → validateOnepage → onepage.json → 发布 → 页面。
    // 这一层漏掉它，页面上就永远不会有"看原文"（审计提醒过的正是这种"新增字段被丢掉"）。
    sourceMap: normalizeSourceMapDraft(value.sourceMap),
    chars,
    hasWall: Boolean(wall),
    blocks: paragraphs.length,
    lists,
    tables,
    // 结构化程度：列表与表格占的行数比例，太低说明写成了一篇小作文
    structured: lists + tables >= 8
  }
}

/**
 * 生成一页纸；超字数就带着"上一版多少字"再要一次。
 *
 * 实测模型第一次经常会写到 2800—3000 字（大概是"舍不得删"），退回一次基本就压下来了。
 * 最多压缩两次：第二次仍超时，再给一次更严格的“只保留骨架”指令。
 * 正常首轮/第二轮合格就立即返回，不会平白增加模型调用。
 */
export async function generateOnepage({
  markdown, courseName = '', lessonTitle = '', courseSpec = {}, callModel, modelConfig, retries = 2,
  // 可用小节清单（id + 标题）：来源映射只许从这里挑，模型不许自己编 id
  sections = []
} = {}) {
  let budgetNote = ''
  let lastError = null
  let sourceMapRetried = false
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await callModel({
      config: modelConfig,
      role: 'onepage',
      prompt: buildPrompt({
        role: 'onepage',
        promptVersion: courseSpec.promptVersion,
        courseSpec,
        lessonBlueprint: { title: lessonTitle },
        sourceText: buildOnepageSource({ markdown, courseName, lessonTitle, budgetNote, sections }),
        schema: ONEPAGE_SCHEMA
      })
    })
    try {
      const validated = validateOnepage(result.parsed)
      // 有可用小节时，sourceMap 是一页纸“看原文”的必要组成。模型偶尔会把它整段漏掉：
      // 内容本身合格也先额外提醒并重试一次；若下一次仍为空，则保留一页纸正文，交给
      // sourcemap 补全链路处理，避免为了映射失败把整份一页纸一起丢掉。
      if (sections.length && !validated.sourceMap.length && !sourceMapRetried && attempt < retries) {
        sourceMapRetried = true
        budgetNote = '上一版一页纸正文已合格，但 sourceMap 为空。正文可以沿用同样的压缩程度；这一次必须为主要内容块补 sourceMap，并且 sections[].id 只能从给定小节清单逐字选择。'
        continue
      }
      return { ...validated, trace: result.trace, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      const chars = String(result.parsed?.markdown || '').replace(/\s/g, '').length
      budgetNote = attempt >= 1
        ? `上一版仍有 ${chars} 字。现在必须压到 1800—2200 字：只保留章节骨架、定义/规则、最关键的辨析和结论；删除绝大多数例子、背景、重复说明与次要案例。宁可少覆盖，也绝不能超过 ${ONEPAGE_MAX_CHARS} 字。`
        : `写了 ${chars} 字，超过一张 A4 的上限 ${ONEPAGE_MAX_CHARS} 字。请删到 ${ONEPAGE_TARGET_CHARS} 字以内：只留体系与最核心的知识点，例子细节、重复解释、次要案例全部删掉。`
    }
  }
  throw lastError
}
