import { cleanText } from '@course/core'

import { buildPrompt } from './ai-adapter.mjs'

/**
 * 课程简报：给"要不要细读"用的一段话。
 *
 * 推送消息里只放简报，不放笔记正文的截断——截断出来的往往是半句话，读者无法判断
 * 这节课讲了什么。简报要回答的是"这节课在讲什么、主线是什么、最该记住什么"。
 *
 * 旧流程里 brief 这个角色一直存在（提示词在 ai-adapter 里躺了很久），但没有任何任务
 * 调用它；这里是它第一次被接上：读的是**已经通过终审的成品笔记**的结构与要点，
 * 所以简报与笔记不会互相矛盾。
 */

export const BRIEF_SCHEMA = {
  briefing: 'string（150—300 字的中文说明）',
  keyPoints: ['string（不超过 40 字，共 3 条）'],
  detail: 'string（站内简报页 Markdown）'
}

/** 简报的输入：只给结构与要点，不给全文——简报要的是主线，喂全文既贵又容易写成摘要。 */
export function buildBriefSource(lesson = {}) {
  const splice = lesson.finalNote?.assembly?.spliceData || {}
  const overview = splice.courseOverview || {}
  const sections = (lesson.outline || []).map((outlineNode, index) => {
    const nodes = (lesson.nodes || []).filter(node => node.outlineNodeId === outlineNode.id)
    const digest = nodes
      .map(node => cleanText(node.draft || '').replace(/\s+/g, ' ').slice(0, 220))
      .filter(Boolean)
      .join(' / ')
    return `${index + 1}. ${outlineNode.title}（转录 L${(outlineNode.lineRange || []).join('-L')}）${digest ? `\n   摘要：${digest}` : ''}`
  })

  return [
    `课次：${lesson.title || ''}`,
    `主线：${lesson.outlineMainLine || lesson.blueprint?.mainLine || ''}`,
    '',
    '## 课程概览（来自笔记）',
    `核心问题：${(overview.coreQuestions || []).join('；')}`,
    `应当能够：${(overview.shouldBeAbleTo || []).join('；')}`,
    `课程脉络：${overview.lectureThread || ''}`,
    '',
    '## 各节标题与摘要',
    ...sections,
    '',
    '## 与前后课次的关系',
    `承接：${splice.knowledgeLink?.inheritsFrom || ''}`,
    `铺垫：${(splice.knowledgeLink?.laysGroundworkFor || []).map(item => item?.concept || item).join('；')}`,
    `下节：${splice.knowledgeLink?.nextLessonPreview || ''}`,
    '',
    '## 附录话题',
    ...(splice.appendix?.topics || []).map(topic => `- ${topic.title || ''}`)
  ].join('\n')
}

/** 校验模型输出：简报必须真的有内容，不能是"本课内容十分丰富"。 */
export function validateBrief(value = {}) {
  const briefing = cleanText(value.briefing || '')
  if (briefing.length < 60) throw new Error('简报过短，无法判断是否有效')
  const keyPoints = (Array.isArray(value.keyPoints) ? value.keyPoints : [])
    .map(item => cleanText(typeof item === 'string' ? item : item?.text || ''))
    .filter(Boolean)
    .slice(0, 5)
  return {
    briefing,
    keyPoints,
    detail: cleanText(value.detail || value.markdown || ''),
    words: briefing.length
  }
}

export async function generateBrief({ lesson, courseSpec = {}, callModel, modelConfig } = {}) {
  if (!lesson?.finalNote?.markdown) throw new Error('简报只能基于已完成的笔记生成')
  const result = await callModel({
    config: modelConfig,
    role: 'brief',
    prompt: buildPrompt({
      role: 'brief',
      promptVersion: courseSpec.promptVersion,
      courseSpec,
      lessonBlueprint: {
        title: lesson.title,
        sectionCount: (lesson.outline || []).length
      },
      sourceText: buildBriefSource(lesson),
      schema: BRIEF_SCHEMA
    })
  })
  return { ...validateBrief(result.parsed), trace: result.trace }
}

/** 推送消息正文：一段说明 + 三行要点；链接由投递层追加。 */
export function renderBriefMessage({ courseName = '', lessonTitle = '', brief = {} } = {}) {
  const points = (brief.keyPoints || []).map(point => `· ${point}`).join('\n')
  return [
    `【${courseName}】${lessonTitle}`,
    '',
    cleanText(brief.briefing || ''),
    points ? `\n${points}` : ''
  ].filter(Boolean).join('\n')
}
