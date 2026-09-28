import { findOpenMarkers } from './quality.mjs'

/**
 * 内容指纹：FNV-1a 32 位 → 8 位十六进制。
 *
 * 与 publish（sectionIndex）和 notes-mcp（records.mjs）里那两份是**同一个算法**，
 * 但各包各留一份：这两个包都要能单独复制走（不互相依赖）。改算法要三处一起改。
 */
function fingerprintOf (text = '') {
  const value = String(text ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 章级整合（Phase 5.2 B2 的原型）。
 *
 * 它回答的是单课笔记回答不了的问题：「这一章（几节课）到底在讲什么、概念怎么推进、
 * 争点各节课怎么回答」。产物是**结构化的骨架 + 出处**，不是又一篇长文——
 * 因为长文会与单课笔记重复，而重复的代价是两处不一致。
 *
 * 三条硬规则（B3 的产物边界在这里落成代码）：
 *   1. **每一行都必须有出处**（课次 slug + 小节 id）：`checkIntegrationSources` 会拦下没有出处的行，
 *      没有出处的整合就是"模型自己说的"，读者无法核对；
 *   2. **不做单课笔记已经做过的事**：这里只做跨课次的对照、推进与争点，不重写正文；
 *   3. **待核标记原样继承**（带课次与行号）：单课里不确定的东西，整合里不能变成确定结论。
 *
 * 确定性优先：默认只用规则抽取（不花钱、可复现、可单测）。`--live` 才让模型补连接性文字，
 * 且补出来的每一句仍然要挂出处——挂不上就不写进去。
 */

const str = value => String(value ?? '')
const norm = value => str(value).normalize('NFKC').trim().toLowerCase()

const QUESTION = /[?？]$|^(为什么|如何|怎么|什么|哪些|是否)|(是什么|为什么|怎么办|如何理解)$/

/** 课次选择的成对校验：课程必须存在、课次必须属于这门课，缺一个就报清楚。 */
export function selectLessons (records = [], { course = '', lessons = [] } = {}) {
  const wanted = norm(course)
  if (!wanted) throw new Error('整合需要课程名（course）')
  const inCourse = records.filter(record => norm(record.courseName).includes(wanted) || wanted.includes(norm(record.courseName)))
  if (!inCourse.length) {
    const names = [...new Set(records.map(record => record.courseName).filter(Boolean))]
    throw new Error(`找不到课程「${course}」。现有：${names.join(' / ') || '（发布库是空的）'}`)
  }
  if (!lessons.length) {
    return [...inCourse].sort((left, right) => str(left.lessonDate).localeCompare(str(right.lessonDate)))
  }
  const picked = []
  for (const wanted of lessons) {
    const key = norm(wanted)
    const hit = inCourse.find(record => norm(record.lessonTitle) === key || norm(record.slug) === key || norm(record.slug).endsWith('/' + key))
    if (!hit) {
      throw new Error(`课程「${inCourse[0].courseName}」里找不到课次「${wanted}」。课次有：${inCourse.map(r => r.lessonTitle).join(' / ')}`)
    }
    picked.push(hit)
  }
  return [...new Map(picked.map(record => [record.slug, record])).values()]
    .sort((left, right) => str(left.lessonDate).localeCompare(str(right.lessonDate)))
}

/** 小节表：优先用发布库的 sections（A3），老库退回标题行。 */
function sectionsOf (record = {}) {
  if (Array.isArray(record.sections) && record.sections.length) {
    return record.sections.map(section => ({ id: section.id, title: section.title, level: section.level, fingerprint: section.fingerprint || '' }))
  }
  return (Array.isArray(record.headings) ? record.headings : [])
    .map(head => ({ id: head.id, title: head.text, level: head.level, fingerprint: '' }))
}

export function buildIntegrationPlan ({ records = [], course = '', lessons = [], topic = '', generatedAt = '' } = {}) {
  const picked = selectLessons(records, { course, lessons })
  const parts = picked.map(record => ({
    record,
    sections: sectionsOf(record),
    markers: findOpenMarkers(record.markdown || '').map(marker => ({ ...marker, slug: record.slug, lessonTitle: record.lessonTitle }))
  }))

  // ① 概念对照：同一术语在几节课里出现过（元数据 + 落点锚点）
  const conceptRows = new Map()
  for (const part of parts) {
    const buckets = ['concepts', 'statutes', 'cases']
    for (const bucket of buckets) {
      for (const raw of (part.record.metadata?.[bucket] || [])) {
        const term = str(raw).trim()
        if (!term) continue
        const key = norm(term) + '|' + bucket
        if (!conceptRows.has(key)) conceptRows.set(key, { term, kind: bucket, rows: [] })
        conceptRows.get(key).rows.push({
          slug: part.record.slug,
          lessonTitle: part.record.lessonTitle,
          lessonDate: part.record.lessonDate,
          anchor: part.record.anchors?.[bucket]?.[term] || ''
        })
      }
    }
  }
  const concepts = [...conceptRows.values()]
    // 跨课次出现过的排前面：这才是"整合"的价值所在
    .sort((left, right) => right.rows.length - left.rows.length || left.term.localeCompare(right.term, 'zh'))

  // ② 问题线：小节标题里像问题的那些
  const questions = []
  for (const part of parts) {
    for (const section of part.sections) {
      if (!QUESTION.test(str(section.title).trim())) continue
      questions.push({
        text: str(section.title).trim(),
        slug: part.record.slug,
        lessonTitle: part.record.lessonTitle,
        sectionId: section.id
      })
    }
  }

  // ③ 争点：同一个问题在两节及以上出现（跨课次的重复问法就是"这一章在反复处理的事"）
  const issueMap = new Map()
  for (const question of questions) {
    const key = norm(question.text)
    if (!issueMap.has(key)) issueMap.set(key, { question: question.text, answers: [] })
    issueMap.get(key).answers.push({ slug: question.slug, lessonTitle: question.lessonTitle, anchor: question.sectionId })
  }
  const issues = [...issueMap.values()].filter(issue => issue.answers.length >= 2)

  // ④ 时间线与 ⑤ 待核继承
  const timeline = parts.map(part => ({
    slug: part.record.slug,
    lessonTitle: part.record.lessonTitle,
    lessonDate: part.record.lessonDate,
    theme: part.record.theme || '',
    sections: part.sections.filter(section => Number(section.level) <= 2).map(section => ({ id: section.id, title: section.title }))
  }))
  const openMarkers = parts.flatMap(part => part.markers)

  const plan = {
    kind: 'course-integration',
    version: 1,
    course: picked[0]?.courseName || course,
    topic: str(topic).trim() || '（未指定主题：按课次顺序整合）',
    generatedAt,
    lessons: picked.map(record => ({
      slug: record.slug,
      lessonTitle: record.lessonTitle,
      lessonDate: record.lessonDate,
      checksum: record.checksum || '',
      // 每个课次的正文指纹合起来 = 这份整合"绑"在哪一版内容上（失效判定用）
      contentFingerprint: fingerprintOf(str(record.markdown || ''))
    })),
    concepts,
    questions,
    issues,
    timeline,
    openMarkers
  }
  plan.findings = checkIntegrationSources(plan)
  return plan
}

/**
 * 出处检查：整合里的每一行都必须能指回"哪个课次、哪一节"。
 * 没有出处的行不算通过——那意味着它在替读者做没有依据的断言。
 */
export function checkIntegrationSources (plan = {}) {
  const lessons = new Set((plan.lessons || []).map(item => item.slug))
  const problems = []
  const check = (label, slug, anchor) => {
    if (!slug || !lessons.has(slug)) {
      problems.push({ level: 'error', code: 'missing-source', message: `${label} 没有指向任何课次` })
      return
    }
    if (!anchor) problems.push({ level: 'warn', code: 'missing-anchor', message: `${label} 只说到了课次、没有指到小节` })
  }
  for (const concept of plan.concepts || []) {
    for (const row of concept.rows || []) check(`概念「${concept.term}」`, row.slug, row.anchor)
  }
  for (const question of plan.questions || []) check(`问题「${question.text}」`, question.slug, question.sectionId)
  for (const issue of plan.issues || []) {
    for (const answer of issue.answers || []) check(`争点「${issue.question}」的回答`, answer.slug, answer.anchor)
  }
  for (const marker of plan.openMarkers || []) check('待核标记', marker.slug, true)
  return problems
}

/** 渲染成 Markdown：结构清楚、每行都带出处，读者可以逐条核对。 */
export function renderIntegrationMarkdown (plan = {}) {
  const lines = []
  const range = (plan.lessons || []).map(item => `${item.lessonTitle}（${item.lessonDate}）`).join(' / ')
  lines.push(`# ${plan.course} · ${plan.topic}`, '')
  lines.push(`> 覆盖 ${(plan.lessons || []).length} 节课：${range}`)
  lines.push(`> 生成于 ${plan.generatedAt || '（未记录时间）'}｜内容指纹：${(plan.lessons || []).map(item => `${item.lessonTitle}=${item.contentFingerprint}`).join('、')}`)
  lines.push('> 本页只做**跨课次对照**，不重写单课正文；每一行都给出出处（课次 + 小节）。', '')

  lines.push('## 一、概念对照（跨课次）', '')
  const crossLesson = (plan.concepts || []).filter(item => item.rows.length >= 2)
  const singleLesson = (plan.concepts || []).filter(item => item.rows.length === 1)
  if (crossLesson.length) {
    lines.push('| 概念 | 出现课次 | 落点 |', '|---|---|---|')
    for (const concept of crossLesson) {
      lines.push(`| ${concept.term} | ${concept.rows.map(row => row.lessonTitle).join('、')} | ${concept.rows.map(row => row.anchor || '（未定位）').join('、')} |`)
    }
  } else {
    lines.push('（这几节课之间没有共现的概念——要么主题不同，要么元数据还没抽全）')
  }
  if (singleLesson.length) {
    lines.push('', `只在单节课出现的概念另有 ${singleLesson.length} 个（${singleLesson.slice(0, 12).map(item => item.term).join('、')}${singleLesson.length > 12 ? '…' : ''}）——单课内部的事，交给单课笔记。`)
  }

  lines.push('', '## 二、问题线（这几节课反复处理的问题）', '')
  if ((plan.issues || []).length) {
    for (const issue of plan.issues) {
      lines.push(`- ${issue.question}`)
      for (const answer of issue.answers) lines.push(`  - ${answer.lessonTitle} · ${answer.anchor}`)
    }
  } else {
    lines.push('（没有在两节以上重复出现的问题；下面列出各节课自己提出的问题）')
    for (const question of (plan.questions || []).slice(0, 20)) {
      lines.push(`- ${question.text} — ${question.lessonTitle} · ${question.sectionId}`)
    }
  }

  lines.push('', '## 三、论证推进（时间线）', '')
  for (const lesson of plan.timeline || []) {
    lines.push(`- **${lesson.lessonTitle}**（${lesson.lessonDate}）${lesson.theme ? '：' + lesson.theme : ''}`)
    for (const section of (lesson.sections || []).slice(0, 8)) lines.push(`  - ${section.title}（#${section.id}）`)
  }

  lines.push('', '## 四、待核与不确定（继承自各课次）', '')
  if ((plan.openMarkers || []).length) {
    for (const marker of plan.openMarkers) {
      lines.push(`- [${marker.lessonTitle} 第 ${marker.line} 行] ${marker.text}${marker.hasSource ? '' : '（**没写出处**）'}`)
    }
    lines.push('', '> 这些点在单课笔记里就没有定论，整合里同样不能当结论用。')
  } else {
    lines.push('（各课次都没有待核标记）')
  }

  lines.push('', '## 五、出处索引', '')
  for (const lesson of plan.lessons || []) {
    lines.push(`- ${lesson.lessonTitle}：` + '`' + lesson.slug + '`' + `（内容指纹 ${lesson.contentFingerprint}）`)
  }
  return lines.join('\n') + '\n'
}
