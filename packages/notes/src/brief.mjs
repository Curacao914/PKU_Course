import { cleanText } from '@course/core'

import { buildPrompt } from './ai-adapter.mjs'
import { briefSourceChecksum, buildBriefSourceFromFinalNote } from './brief-source.mjs'
import { coversOutline } from './outline-ids.mjs'

// 受控上下文的实现住在 brief-source.mjs（只认成品正文）；这里保留同名入口，老调用方不用改。
export {
  briefSourceChecksum,
  buildBriefSourceFromFinalNote,
  buildBriefSourceFromMarkdown,
  checkBriefBinding,
  assertBriefBinding
} from './brief-source.mjs'

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
  // 首页课次表里那一列用的就是这两个字段：让写简报的这一次调用顺手产出来，
  // 不额外多一次模型调用（简报本来就是读完成品后来总结这节课的）
  theme: 'string（不超过 20 字，说清这节课在讲什么）',
  keywords: ['string（5—6 个，每个 2—10 字，按这节课的讲授顺序排列）'],
  detail: 'string（站内简报页 Markdown）'
}

/** 简报的输入：只给结构与要点，不给全文——简报要的是主线，喂全文既贵又容易写成摘要。 */
export function buildBriefSource(lesson = {}) {
  const splice = lesson.finalNote?.assembly?.spliceData || {}
  const overview = splice.courseOverview || {}
  const sections = (lesson.outline || []).map((outlineNode, index) => {
    // 合并写单元覆盖多个大纲模块：只比 outlineNodeId 会让其余模块的摘要变成空的，
    // 简报于是被第一个模块支配（这正是"摘要像上一课/首课"那个现象的来源）
    const nodes = (lesson.nodes || []).filter(node => coversOutline(node, outlineNode.id))
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

/** 泛词与行政事务：关键词里出现这些等于没说（"商法""考核方式"都不是这节课讲了什么）。 */
const KEYWORD_NOISE = /^(概念|问题|内容|理论|制度|方法|原则|分析|研究|总结|概述|介绍|其他|相关|基本|一般|主要|特点|意义|作用|关系|区别|比较|案例|法条|要点|重点|难点|背景|现状|发展|影响|评价|讨论|思考|复习)$/
const KEYWORD_ADMIN = /教室|地点|课程安排|考核|签到|点名|考试|助教|参考书目|教材|选修|学分|作业|预习|课间|通知|设备|教学网|成绩|分组|自我介绍|课程介绍/

/**
 * 泛词判定：整词就是泛词，或者"去掉里面的泛词后不剩什么"（法律制度、重点内容）。
 * 但"犯罪记录封存制度"这样的真术语要留下——它去掉"制度"还剩五个字。
 */
function isNoisy(term) {
  if (KEYWORD_NOISE.test(term)) return true
  let rest = term
  for (const word of ['概念', '问题', '内容', '理论', '制度', '方法', '原则', '分析', '研究', '总结', '概述', '介绍', '相关', '基本', '一般', '主要', '特点', '意义', '作用', '关系', '区别', '比较', '案例', '法条', '要点', '重点', '难点', '背景', '现状', '发展', '影响', '评价', '讨论', '思考', '复习']) {
    rest = rest.split(word).join('')
  }
  // 剩下不足三个字：这个词自己就是由泛词拼起来的（法律制度 → 只剩"法律"）
  return rest.length < 3
}

/** 主题句：一句话说清这节课在讲什么（首页表格里当整行的"抬头"）。 */
export function cleanTheme(value = '') {
  const text = cleanText(typeof value === 'string' ? value : value?.theme || '')
    .replace(/^[「『"']|[」』"']$/g, '')
    .replace(/[。！!；;，,、]+$/g, '')
    .trim()
  if (text.length < 4 || text.length > 26) return ''
  // "本节内容""课程介绍"这种等于没说
  if (/^(本节|本课|这节|该节)?(内容|介绍|概述|概览|总结|综述)(与|和)?(说明|介绍)?$/.test(text)) return ''
  return text
}

/** 关键词：短、像术语、不是杂项、不是课程名。不合格的直接丢掉，宁可少给几个。 */
export function cleanKeywords(value = [], { courseName = '', limit = 6 } = {}) {
  const course = cleanText(courseName)
  const seen = new Set()
  const out = []
  for (const raw of (Array.isArray(value) ? value : [])) {
    const term = cleanText(typeof raw === 'string' ? raw : raw?.term || raw?.name || '')
      .replace(/^[\s\-·、，,。]+|[\s\-·、，,。]+$/g, '')
    if (term.length < 2 || term.length > 12) continue
    if (/[：:，,。；;、！？\[\]（）()「」《》"'']/.test(term)) continue
    if (isNoisy(term) || KEYWORD_ADMIN.test(term)) continue
    if (course && (term === course || course.includes(term))) continue
    if (seen.has(term)) continue
    seen.add(term)
    out.push(term)
    if (out.length >= limit) break
  }
  return out
}

/** 校验模型输出：简报必须真的有内容，不能是"本课内容十分丰富"。 */
export function validateBrief(value = {}, options = {}) {
  const briefing = cleanText(value.briefing || '')
  if (briefing.length < 60) throw new Error('简报过短，无法判断是否有效')
  const keyPoints = (Array.isArray(value.keyPoints) ? value.keyPoints : [])
    .map(item => cleanText(typeof item === 'string' ? item : item?.text || ''))
    .filter(Boolean)
    .slice(0, 5)
  return {
    briefing,
    keyPoints,
    theme: cleanTheme(value.theme),
    keywords: cleanKeywords(value.keywords, options),
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
      // 上下文只取成品正文：写单元怎么切分与简报无关（详见 brief-source.mjs 的说明）
      sourceText: buildBriefSourceFromFinalNote(lesson.finalNote.markdown, {
        courseName: lesson.courseName || courseSpec.courseName || '',
        lessonTitle: lesson.title || '',
        mainLine: lesson.outlineMainLine || lesson.blueprint?.mainLine || ''
      }),
      schema: BRIEF_SCHEMA
    })
  })
  return {
    ...validateBrief(result.parsed, { courseName: lesson.courseName || courseSpec.courseName || '' }),
    sourceChecksum: briefSourceChecksum(lesson.finalNote.markdown),
    trace: result.trace
  }
}

/**
 * 从**已发布的笔记**重新生成简报（含关键词）。
 *
 * 用途：笔记跑完之后才加上字段（关键词就是这样），而中间状态早就被清理了——
 * 为了一列关键词把整条笔记流水线再跑一遍，那是几十次模型调用。这里只重跑简报这一步：
 * 输入是成品正文的受控切片（概览 + 各节标题与开头 + 术语 + 知识连接），一次调用的事。
 */
export async function generateBriefFromMarkdown({
  markdown, courseName = '', lessonTitle = '', mainLine = '', courseSpec = {}, callModel, modelConfig
} = {}) {
  const text = String(markdown || '')
  if (!text.trim()) throw new Error('没有笔记正文，无法生成简报')
  const result = await callModel({
    config: modelConfig,
    role: 'brief',
    prompt: buildPrompt({
      role: 'brief',
      promptVersion: courseSpec.promptVersion,
      courseSpec,
      lessonBlueprint: { title: lessonTitle, sectionCount: countSections(text) },
      sourceText: buildBriefSourceFromFinalNote(text, { courseName, lessonTitle, mainLine }),
      schema: BRIEF_SCHEMA
    })
  })
  return {
    ...validateBrief(result.parsed, { courseName }),
    // 指纹与身份一起落盘：发布时用来发现"brief.json 与要发的这一篇不同源"
    sourceChecksum: briefSourceChecksum(text),
    sourceChars: text.length,
    trace: result.trace
  }
}

function countSections(markdown = '') {
  return (String(markdown).match(/^#{2,3}\s+/gm) || []).length
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
