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
  outline: ['string（3—6 条，这一页分了哪几块，供目录/校验用）']
}

export function buildOnepageSource({ markdown = '', courseName = '', lessonTitle = '' } = {}) {
  const text = String(markdown || '').trim()
  if (!text) throw new Error('没有笔记正文，无法生成一页纸')
  return [
    `课程：${courseName}`,
    `课次：${lessonTitle}`,
    `目标篇幅：${ONEPAGE_TARGET_CHARS} 字左右（含表格单元格），绝不能超过 ${ONEPAGE_MAX_CHARS} 字`,
    '',
    '## 笔记全文（这是唯一素材，不得新增其中没有的内容）',
    text
  ].join('\n')
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
    chars,
    hasWall: Boolean(wall),
    blocks: paragraphs.length,
    lists,
    tables,
    // 结构化程度：列表与表格占的行数比例，太低说明写成了一篇小作文
    structured: lists + tables >= 8
  }
}

export async function generateOnepage({ markdown, courseName = '', lessonTitle = '', courseSpec = {}, callModel, modelConfig } = {}) {
  const result = await callModel({
    config: modelConfig,
    role: 'onepage',
    prompt: buildPrompt({
      role: 'onepage',
      promptVersion: courseSpec.promptVersion,
      courseSpec,
      lessonBlueprint: { title: lessonTitle },
      sourceText: buildOnepageSource({ markdown, courseName, lessonTitle }),
      schema: ONEPAGE_SCHEMA
    })
  })
  return { ...validateOnepage(result.parsed), trace: result.trace }
}
