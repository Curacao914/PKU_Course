import { cleanText } from '@course/core'

import { outlineIdsOf } from './outline-ids.mjs'

/**
 * 正文层级与"合并写单元 → 各知识模块"的还原：**只有这一处实现**。
 *
 * 为什么单独一个模块：拼装（把正文按模块分节）、接缝依据（按模块给要点摘录）、
 * 逐字照搬校验（拿本节正文比对）都要把同一个写单元的正文还原到模块这一级。
 * 各写一份的话，三处对"这一节到底是哪几段"的理解迟早会分叉，
 * 而分叉的后果是正文、依据、校验各说各话。
 */

/** 去掉节点正文里的 META 标记：它们是给跨课整合用的，不该出现在正文中。 */
export function stripRawMeta(markdown = '') {
  return cleanText(String(markdown)
    .replace(/<!--\s*META[\s\S]*?-->\s*/gi, '')
    .replace(/META_FOR_NODE:\s*\n[\s\S]*?(?=\n\s*\n|$)/gi, '')
    .trim())
}

/** 四级及以下标题拍成加粗行（正文里再深的一层靠加粗与「1.」编号承担）。 */
export function boldBodyHeadings(markdown = '') {
  return String(markdown ?? '').split('\n').map(line => {
    const match = line.match(/^(#{4,6})\s+(.+?)\s*#*\s*$/)
    return match ? `**${match[2]}**` : line
  }).join('\n')
}

/** 把标题整体平移，使最浅的一级正好落在 floor 上（可升可降，但不越过 h1/h6）。 */
export function shiftBodyHeadings(markdown = '', floor = 3) {
  const lines = String(markdown ?? '').split('\n')
  const levels = lines.map(line => line.match(/^(#{1,6})\s+\S/)).filter(Boolean).map(match => match[1].length)
  if (!levels.length) return markdown
  const shift = floor - Math.min(...levels)
  if (!shift) return markdown
  return lines.map(line => {
    const match = line.match(/^(#{1,6})(\s+.*)$/)
    if (!match) return line
    const level = Math.min(6, Math.max(1, match[1].length + shift))
    return `${'#'.repeat(level)}${match[2]}`
  }).join('\n')
}

/**
 * 正文层级：**话题是 h2、小节是 h3**，不再往下分。
 *
 * 用户看过两种排法：haoke 那种（话题 h3、小节用加粗行）读起来也顺，但他明确要
 * 「两级标题、第二级缩进」的目录——那就必须让小节真的是标题，而不是加粗文字，
 * 否则左栏目录只剩一级。四级及以下一律降级/拍平，目录就两级，扫一眼看得出结构。
 */
export function normalizeBodyHeadings(markdown = '') {
  // 先把最浅的一级对齐到 h3（**允许负位移**：模型常把小节写成 h4，也要提上来），
  // 再把剩下的 h4+ 拍成加粗行——目录就两级，正文再深靠加粗与编号承担。
  return boldBodyHeadings(shiftBodyHeadings(markdown, 3))
}

/** 标题比较用的归一：去掉井号、中式序号与空白，只留文字。 */
export function headingKey(value = '') {
  return String(value || '')
    .replace(/^#+\s*/, '')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．]\s*/, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * 把一个写作节点的正文还原成它覆盖的知识模块。
 *
 * 写作单元可以合并多个模块（一次调用写完整节课），但成品笔记仍要按模块分节，
 * 所以这里按模型输出的「### 模块标题」把它拆回去。
 * 契约没被遵守时**不能丢内容**：整段正文都算作第一个模块的正文，其余模块留空，
 * 由装配结果里的 moduleSplit 记录这件事（宁可有警告，也不要少几段）。
 */
export function nodeBodyPieces(node = {}) {
  const body = stripRawMeta(node.draft || '')
  const ids = outlineIdsOf(node).filter(Boolean)
  const pieces = new Map(ids.map(id => [id, '']))
  if (!ids.length || !body) return pieces

  if (ids.length === 1) {
    pieces.set(ids[0], normalizeBodyHeadings(body))
    return pieces
  }

  const briefs = node.moduleBriefs || []
  const buckets = new Map(ids.map(id => [id, []]))
  let current = ids[0]
  let matched = false
  for (const line of body.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(\S.*)$/)
    if (heading) {
      const label = headingKey(heading[2])
      const brief = briefs.find(item => {
        const candidate = headingKey(item.title)
        return candidate && (label === candidate || label.includes(candidate) || candidate.includes(label))
      })
      if (brief) {
        current = brief.outlineNodeId
        matched = true
        continue // 标题由程序重新渲染，不重复保留
      }
    }
    buckets.get(current)?.push(line)
  }

  if (!matched) {
    pieces.set(ids[0], normalizeBodyHeadings(body))
    return pieces
  }
  for (const id of ids) pieces.set(id, normalizeBodyHeadings(buckets.get(id).join('\n').trim()))
  return pieces
}
