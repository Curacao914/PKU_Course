import { cleanText } from '@course/core'

import { buildPrompt } from './ai-adapter.mjs'
import { checkTopicSources, normalizeTopicArtifact } from './topic.mjs'

export const TOPIC_PLAN_SCHEMA = {
  topics: [{
    title: 'string（专题名，8—24 字，按知识体系命名，不按日期或“第几讲”命名）',
    summary: 'string（1—2 句，说明这一专题统摄什么问题）',
    lessons: ['string（只能逐字照抄提供的课次 slug；一个课次可服务于多个专题）']
  }]
}

export const TOPIC_ARTIFACT_SCHEMA = {
  title: 'string（专题标题，保持与计划一致）',
  summary: 'string（1—2 句，复习时先读这一句）',
  nodes: [{
    title: 'string（短标签；一级节点通常 3—8 个）',
    relation: 'hierarchy | parallel | condition | sequence | exception | contrast',
    note: 'string（可选；只写必要解释，避免长段落）',
    sourceRefs: [{
      slug: 'string（逐字照抄可用课次 slug）',
      sectionId: 'string（逐字照抄该课次可用小节 id）',
      title: 'string（可选，小节标题）'
    }],
    children: ['递归使用同样结构；建议最多 3 层']
  }]
}

function list(values = [], limit = 10) {
  return values.map(value => cleanText(value)).filter(Boolean).slice(0, limit)
}

function orderedCourseRecords(records = [], course = '') {
  return records
    .filter(record => String(record?.courseName || '') === String(course || ''))
    .sort((a, b) =>
      String(a.lessonDate || '').localeCompare(String(b.lessonDate || '')) ||
      String(a.lessonTitle || '').localeCompare(String(b.lessonTitle || ''), 'zh-CN', { numeric: true }))
}

function sectionList(record = {}) {
  return (Array.isArray(record.sections) ? record.sections : [])
    .map(section => ({ id: cleanText(section.id), title: cleanText(section.title) }))
    .filter(section => section.id && section.title)
}

export function buildTopicPlanningSource({ records = [], course = '' } = {}) {
  const picked = orderedCourseRecords(records, course)
  if (!picked.length) throw new Error(`找不到课程「${course}」的已发布笔记`)
  const chunks = [
    `课程：${course}`,
    `已发布课次：${picked.length} 节`,
    '',
    '目标：按知识体系划分阶段性专题。专题是“几节课合起来形成什么制度/问题结构”，不是按日期切段，也不是总复习长文。',
    '约束：每个 slug 必须来自下面清单；所有课次至少被一个专题覆盖；允许某课次同时属于两个专题；避免只有一个泛词的空专题。',
    ''
  ]
  for (const record of picked) {
    chunks.push(`## ${record.lessonTitle}｜slug=${record.slug}`)
    if (record.lessonDate) chunks.push(`日期：${record.lessonDate}`)
    if (record.theme) chunks.push(`主题：${cleanText(record.theme)}`)
    if (record.keywords?.length) chunks.push(`关键词：${list(record.keywords, 8).join('、')}`)
    const concepts = list(record.metadata?.concepts, 10)
    const statutes = list(record.metadata?.statutes, 6)
    const cases = list(record.metadata?.cases, 5)
    if (concepts.length) chunks.push(`概念：${concepts.join('、')}`)
    if (statutes.length) chunks.push(`法条：${statutes.join('、')}`)
    if (cases.length) chunks.push(`案例：${cases.join('、')}`)
    const sections = sectionList(record).slice(0, 12)
    if (sections.length) chunks.push(`小节：${sections.map(item => item.title).join(' / ')}`)
    const summary = cleanText(record.summary || record.brief?.briefing || '').slice(0, 320)
    if (summary) chunks.push(`摘要：${summary}`)
    chunks.push('')
  }
  return chunks.join('\n')
}

export function normalizeTopicPlan(value = {}, { records = [], course = '' } = {}) {
  const available = orderedCourseRecords(records, course)
  const allowed = new Set(available.map(record => String(record.slug || '')))
  const topics = (Array.isArray(value.topics) ? value.topics : []).map((item, index) => {
    const title = cleanText(item?.title || '').slice(0, 40)
    const summary = cleanText(item?.summary || '').slice(0, 240)
    const lessons = [...new Set((Array.isArray(item?.lessons) ? item.lessons : [])
      .map(slug => String(slug || '').trim()).filter(Boolean))]
    if (!title) throw new Error(`专题计划第 ${index + 1} 项缺标题`)
    if (!lessons.length) throw new Error(`专题「${title}」没有覆盖课次`)
    for (const slug of lessons) {
      if (!allowed.has(slug)) throw new Error(`专题「${title}」引用了不存在的课次 slug：${slug}`)
    }
    return { id: `${course}::${title}`, course, title, ...(summary ? { summary } : {}), lessons, enabled: true }
  })
  if (!topics.length) throw new Error('模型没有给出任何专题')
  if (topics.length > 10) throw new Error(`模型给了 ${topics.length} 个专题，过细；最多 10 个`)
  const titleSet = new Set()
  for (const topic of topics) {
    if (titleSet.has(topic.title)) throw new Error(`专题标题重复：${topic.title}`)
    titleSet.add(topic.title)
  }
  const covered = new Set(topics.flatMap(topic => topic.lessons))
  const missing = available.map(record => record.slug).filter(slug => !covered.has(slug))
  if (missing.length) throw new Error(`专题计划没有覆盖全部课次：${missing.join('、')}`)
  return topics
}

export async function planCourseTopics({
  records = [], course = '', callModel, modelConfig = null, courseSpec = {}
} = {}) {
  if (typeof callModel !== 'function') throw new Error('planCourseTopics 需要 callModel')
  const result = await callModel({
    config: modelConfig,
    role: 'topicPlan',
    prompt: buildPrompt({
      role: 'topicPlan',
      promptVersion: courseSpec.promptVersion,
      courseSpec: { ...courseSpec, courseName: course },
      sourceText: buildTopicPlanningSource({ records, course }),
      schema: TOPIC_PLAN_SCHEMA
    })
  })
  return {
    topics: normalizeTopicPlan(result.parsed, { records, course }),
    trace: result.trace
  }
}

function topicRecords(records, definition) {
  const bySlug = new Map(records.map(record => [String(record.slug || ''), record]))
  return definition.lessons.map(slug => {
    const record = bySlug.get(String(slug))
    if (!record) throw new Error(`专题「${definition.title}」找不到课次 ${slug}`)
    return record
  })
}

export function buildTopicArtifactSource({ records = [], definition = {}, retryNote = '' } = {}) {
  const picked = topicRecords(records, definition)
  const chunks = [
    `课程：${definition.course}`,
    `专题：${definition.title}`,
    definition.summary ? `专题说明：${definition.summary}` : '',
    retryNote ? `上一版被退回：${retryNote}` : '',
    '',
    '任务：把这些课次重组为“复习用知识框架”。不要按课次顺序复述。先识别分类、条件、例外、并列制度、判断路径和对照关系，再组织成最多 3 层的节点树。',
    '一级节点通常 3—8 个；节点标题尽量短；note 只放理解这个节点不可缺的解释。',
    '每个承载具体知识的叶节点必须至少有一个 sourceRefs；slug 和 sectionId 只能从各课次的“可用小节”逐字选择。',
    ''
  ].filter(Boolean)
  for (const record of picked) {
    chunks.push(`# 课次：${record.lessonTitle}｜slug=${record.slug}`)
    if (record.theme) chunks.push(`主题：${cleanText(record.theme)}`)
    chunks.push('可用小节：')
    for (const section of sectionList(record)) chunks.push(`- ${section.id}｜${section.title}`)
    chunks.push('', '笔记正文：', String(record.markdown || '').trim(), '')
  }
  return chunks.join('\n')
}

function attachLessonBindings(artifact, records, definition, generatedAt = '') {
  const bySlug = new Map(records.map(record => [String(record.slug || ''), record]))
  return {
    ...artifact,
    id: definition.id,
    course: definition.course,
    title: definition.title,
    summary: artifact.summary || definition.summary || '',
    generatedAt,
    lessons: definition.lessons.map(slug => {
      const record = bySlug.get(String(slug)) || {}
      return {
        slug,
        lessonTitle: record.lessonTitle || '',
        lessonDate: record.lessonDate || '',
        checksum: record.checksum || '',
        contentFingerprint: record.contentFingerprint || ''
      }
    })
  }
}

export async function generateTopicArtifact({
  records = [], definition = {}, callModel, modelConfig = null, courseSpec = {}, generatedAt = '', retries = 1
} = {}) {
  if (typeof callModel !== 'function') throw new Error('generateTopicArtifact 需要 callModel')
  let retryNote = ''
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await callModel({
      config: modelConfig,
      role: 'topic',
      prompt: buildPrompt({
        role: 'topic',
        promptVersion: courseSpec.promptVersion,
        courseSpec: { ...courseSpec, courseName: definition.course },
        sourceText: buildTopicArtifactSource({ records, definition, retryNote }),
        schema: TOPIC_ARTIFACT_SCHEMA
      })
    })
    try {
      const normalized = normalizeTopicArtifact(attachLessonBindings({
        title: definition.title,
        summary: result.parsed?.summary || definition.summary || '',
        nodes: result.parsed?.nodes || []
      }, records, definition, generatedAt))
      const problems = checkTopicSources(normalized, records)
      const blocking = problems.filter(item => item.level === 'error')
      if (blocking.length) throw new Error(blocking.slice(0, 5).map(item => item.message).join('；'))
      return { artifact: normalized, trace: result.trace, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      retryNote = `结构或出处校验失败：${error instanceof Error ? error.message : String(error)}。请保留正确内容，只修正节点结构和 sourceRefs；不要编造 slug/sectionId。`
    }
  }
  throw lastError
}
