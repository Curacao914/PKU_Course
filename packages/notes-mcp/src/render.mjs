/**
 * 给模型看的文本渲染。
 *
 * 全部是紧凑的纯文本（不用 JSON 包一层）：模型的上下文里每个字符都是有成本的，
 * 而结构化数据已经由 resources 那条路提供（resources/read 返回 JSON）。
 * 约定：先给 theme/keywords/摘要，正文永远最后、且写明截断情况。
 */

import { lessonDateOf } from './records.mjs'

const line = (...parts) => parts.filter(part => part !== undefined && part !== null && part !== '').join('｜')

export function renderCourses(data) {
  const head = data.query
    ? `课程：按「${data.query}」筛选出 ${data.total} 门 / 全部 ${data.lessonTotal} 个课次`
    : `课程 ${data.total} 门 / 课次 ${data.lessonTotal} 个`
  const lines = [head]
  for (const course of data.courses) {
    lines.push(`- ${line(
      course.courseName,
      course.lessonCount ? `${course.lessonCount} 课次` : '0 课次',
      course.latestLessonDate ? `最新 ${course.latestLessonDate}${course.latestLessonTitle ? `（${course.latestLessonTitle}）` : ''}` : '',
      course.teacher ? `教师 ${course.teacher}` : ''
    )}`)
    if (course.themes.length) {
      lines.push(`  theme：${course.themes.map(item => item.theme).join('；')}`)
    }
    if (course.keywords.length) lines.push(`  keywords：${course.keywords.join('、')}`)
    const counts = course.termCounts
    if (counts && (counts.concepts || counts.statutes || counts.cases)) {
      lines.push(`  术语：概念 ${counts.concepts} / 法条 ${counts.statutes} / 案例 ${counts.cases}`)
    }
  }
  if (!data.courses.length) lines.push('（没有匹配的课程）')
  if (data.total > data.courses.length) lines.push(`（还有 ${data.total - data.courses.length} 门未显示，用 limit 调整）`)
  lines.push('', '下一步：get_course(course="课程名") 看课次清单；search_notes(query="关键词") 跨课检索。')
  return lines.join('\n')
}

export function renderCourse(data) {
  const lines = [line(
    data.courseName,
    `${data.lessonCount} 课次`,
    data.topicCount ? `${data.topicCount} 专题` : '',
    data.teacher ? `教师 ${data.teacher}` : '',
    data.order === 'desc' ? '倒序' : '正序'
  )]
  if (data.topics?.length) {
    lines.push('', `专题（${data.topics.length}）`)
    for (const topic of data.topics) {
      lines.push(`- ${topic.title}`)
      lines.push(`  fetchId: ${topic.fetchId}`)
      if (topic.lessons?.length) lines.push(`  覆盖课次：${topic.lessons.length} 节`)
      if (topic.summary) lines.push(`  摘要：${topic.summary}`)
    }
    lines.push('  用 fetch(topic:<id>) 读取专题 Markdown；需要核实具体依据时再回原笔记。', '')
  }
  for (const lesson of data.lessons) {
    lines.push(`- ${lesson.lessonTitle}`)
    lines.push(`  slug: ${line(lesson.slug, lessonDateOf(lesson), lesson.readMinutes ? `${lesson.readMinutes} 分钟` : '')}`)
    if (lesson.theme) lines.push(`  theme：${lesson.theme}`)
    if (lesson.keywords.length) lines.push(`  keywords：${lesson.keywords.join('、')}`)
    if (lesson.summary) lines.push(`  摘要：${lesson.summary}`)
    // outline 可以是数组（老形状）或分页对象 { items, total, truncated, ... }（新形状）。
    // 被截断时必须说出来：否则模型以为"这篇就这么多小节"，后面那些永远读不到。
    const outline = Array.isArray(lesson.outline) ? { items: lesson.outline, total: lesson.outline.length, truncated: false } : lesson.outline
    if (outline?.items?.length) {
      lines.push(`  小节（${outline.returned ?? outline.items.length}/${outline.total ?? outline.items.length}）：${outline.items.map(head => head.text).join(' / ')}`)
      if (outline.truncated) lines.push(`  （还有 ${outline.total - (outline.offset || 0) - outline.items.length} 节没显示：用 outlineOffset 继续翻）`)
    }
  }
  if (!data.lessons.length) lines.push('（这门课还没有已发布的课次）')
  if (data.lessonCount > data.lessons.length) lines.push(`（还有 ${data.lessonCount - data.lessons.length} 节未显示，用 limit 调整）`)
  lines.push('', '下一步：get_note(slug="…") 读全文；get_note(slug="…", section="小节标题") 只读一节；list_terms(course="…") 看概念/法条/案例。')
  return lines.join('\n')
}

export function renderSearch(data) {
  // 说清"这次是怎么找到的"：只查了索引、还是连正文一起扫了、有没有走错别字回退。
  // 模型据此判断结果有多可信——把猜着匹配的结果说成精确命中，比不命中更糟。
  const scope = data.includeBody ? '索引 + 正文' : data.bodyScanned ? '索引 + 自动扫正文' : '索引'
  const lines = [`查询「${data.query}」命中 ${data.total} 处（scope：${scope}；扫描 ${data.scanned} 篇）`]
  // 语义回退：字面零命中、这几条是按"意思"找的。必须说清楚——模型据此判断可信度，
  // 不能把"猜着找的"和"字面对上的"混在一起报。
  if (data.semantic?.used) {
    lines.push('（字面检索没有命中；以下结果按**语义近似**召回，相似度见每条末尾——请按"意思相近"而不是"原文出现"来使用）')
  }
  if (data.fuzzy?.length) {
    lines.push(`（查询里有语料中不存在的词，已按近似词检索：${data.fuzzy.map(item => `${item.from}→${item.to}`).join('、')}）`)
  }
  if (data.terms?.length) lines.push(`（实际检索词：${data.terms.slice(0, 8).join('、')}）`)
  data.hits.forEach((hit, index) => {
    lines.push(`${index + 1}. [${hit.kinds.join('+')}] ${hit.courseName} · ${hit.lessonTitle}`)
    lines.push(`   slug: ${line(hit.slug, lessonDateOf(hit))}`)
    if (hit.location?.title || hit.location?.id) {
      lines.push(`   位置：${line(hit.location.title, hit.location.id ? `#${hit.location.id}` : '')}`)
    }
    if (hit.semantic) lines.push(`   相似度：${hit.similarity}（按语义近似召回）`)
    for (const snippet of hit.snippets) lines.push(`   片段：${snippet}`)
  })
  if (!data.hits.length) {
    lines.push('没有命中。可以换更具体的术语/法条/人名（疑问句与虚词会被去掉），用 course="课程名" 限定范围，或 includeBody=true 连正文一起找。')
  }
  if (data.bodySkipped) lines.push(`（${data.bodySkipped} 篇正文没取到，已跳过；本地发布库不受影响）`)
  lines.push('', '下一步：get_note(slug="…") 读命中的那一节全文。')
  return lines.join('\n')
}

export function renderNote(data) {
  const lines = [
    `${data.courseName} · ${data.lessonTitle}`,
    line(
      `slug：${data.slug}`,
      lessonDateOf(data),
      data.readMinutes ? `${data.readMinutes} 分钟` : '',
      data.teacher ? `教师 ${data.teacher}` : ''
    )
  ]
  if (data.theme) lines.push(`theme：${data.theme}`)
  if (data.keywords.length) lines.push(`keywords：${data.keywords.join('、')}`)
  if (data.sections.length) lines.push(`小节（共 ${data.sections.length} 节）：${data.sections.map(head => head.text).slice(0, 12).join(' / ')}`)
  if (data.section) {
    lines.push(`—— 小节「${data.section.title}」（${data.sectionChars} 字 / 全文 ${data.totalChars} 字）——`)
  } else {
    lines.push(`—— 正文${data.truncated ? `（前 ${data.returnedChars} 字 / 共 ${data.totalChars} 字）` : `（${data.totalChars} 字）`} ——`)
  }
  lines.push(data.markdown)
  if (data.truncated) {
    lines.push('', `[已截断：只给了前 ${data.returnedChars} / ${data.sectionChars} 字。可用 section="小节标题" 读某一节，或把 maxChars 提高到最多 60000。]`)
  }
  return lines.join('\n')
}

export function renderTerms(data) {
  const counts = Object.values(data.buckets).map(items => items.length)
  const lines = [line(data.courseName, `${data.lessonCount} 课次`, data.teacher ? `教师 ${data.teacher}` : '')]
  const labels = { concepts: '概念', statutes: '法条', cases: '案例', keywords: '关键词' }
  for (const [bucket, items] of Object.entries(data.buckets)) {
    lines.push(`${labels[bucket] || bucket}（${items.length}）`)
    for (const item of items) {
      const refs = item.notes.slice(0, 4).map(note => `${note.lessonTitle}${note.anchor ? ` #${note.anchor}` : ''}`).join('；')
      lines.push(`- ${item.term} ×${item.count}（${refs}）`)
    }
  }
  if (!counts.some(count => count > 0)) lines.push('（这门课还没有术语记录）')
  lines.push('', '下一步：get_note(slug="…", section="…") 到锚点所在的小节细读。')
  return lines.join('\n')
}
