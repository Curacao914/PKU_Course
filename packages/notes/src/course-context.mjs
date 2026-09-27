import { cleanText } from '@course/core'

/**
 * 跨课次上下文包：**同一门课此前讲到哪里**。
 *
 * 为什么需要它：流水线原本只看得到本节课的转录与课件。"这节课承接上一节什么"这件事，
 * 只能靠模型从本节课的开场白里猜——猜不到时就重复讲授上一节的内容，或者把教师
 * 一句"上节课我们讲过"当成全部依据（真实成品里出现过"承接上节关于公司设立的讲述"
 * 这种没有具体内容的空话）。另一头，把上一节的**完整正文**塞进提示词是行不通的：
 * 一篇一两万字，既贵又会把本节课的材料挤掉。
 *
 * 做法：用**已经发布的成品笔记**（发布库）提炼出受控摘要——课次顺序、主题、关键词、
 * 概念/法条/案例、小节标题、一段摘要。它们本来就是写笔记时算好的，不需要多花一次模型调用。
 * 只取**本节课之前**的课次（按课次日期），最近的几节详写、更早的压成一行。
 *
 * 三条纪律（与简报的受控上下文一致）：
 *   1. 这是"此前讲到哪"的依据，不是本节课的内容，也不得照搬进笔记；
 *   2. 摘要里没有的东西不许变成承接关系——宁可只写"上一节讲的是 X"这种确切事实；
 *   3. 有预算：默认 2600 字上下，超了就压缩更早的课次，绝不把整篇文章塞进来。
 */
export const COURSE_CONTEXT_BUDGET = { total: 2600, recentLessons: 3, summaryChars: 220, sectionTitles: 8 }

/** 课次日期：优先 lessonDate，其次标题里的日期，最后首次进站时间。 */
export function lessonDateOfRecord(record = {}) {
  const explicit = String(record.lessonDate || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit
  const fromTitle = String(record.lessonTitle || '').match(/(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})/)
  if (fromTitle) {
    const [, year, month, day] = fromTitle
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return String(record.firstPublishedAt || record.updatedAt || '').slice(0, 10)
}

const list = (values = [], limit = 6) =>
  values.map(value => cleanText(value)).filter(Boolean).slice(0, limit)

/** 小节标题：只要话题那一级（h2），三级以下太多、也不是"讲到哪"的粒度。 */
function sectionTitles(record = {}, limit = COURSE_CONTEXT_BUDGET.sectionTitles) {
  return (record.headings || [])
    .filter(head => Number(head.level) === 2)
    .map(head => cleanText(head.text))
    .filter(text => text && !/^(课程概览|知识连接|附录)/.test(text))
    .slice(0, limit)
}

function detailedLines(record = {}) {
  const lines = [`### ${record.lessonTitle}（${lessonDateOfRecord(record) || '日期未知'}）`]
  if (record.theme) lines.push(`主题：${cleanText(record.theme)}`)
  const keywords = list(record.keywords, 6)
  if (keywords.length) lines.push(`关键词：${keywords.join('、')}`)
  const concepts = list(record.metadata?.concepts, 8)
  if (concepts.length) lines.push(`概念：${concepts.join('、')}`)
  const statutes = list(record.metadata?.statutes, 4)
  if (statutes.length) lines.push(`法条：${statutes.join('、')}`)
  const cases = list(record.metadata?.cases, 3)
  if (cases.length) lines.push(`案例：${cases.join('、')}`)
  const titles = sectionTitles(record)
  if (titles.length) lines.push(`小节：${titles.join(' / ')}`)
  const summary = cleanText(record.summary || record.brief?.briefing || '').slice(0, COURSE_CONTEXT_BUDGET.summaryChars)
  if (summary) lines.push(`摘要：${summary}`)
  return lines.join('\n')
}

function briefLine(record = {}) {
  const keywords = list(record.keywords, 4).join('、')
  return `- ${lessonDateOfRecord(record) || '日期未知'}｜${record.lessonTitle}${record.theme ? `｜${cleanText(record.theme)}` : ''}${keywords ? `｜${keywords}` : ''}`
}

/**
 * 生成上下文包。没有"更早的课次"时返回空文本（第一讲就是这样，调用方据此不加这一块）。
 */
export function buildCourseContext({
  records = [],
  courseName = '',
  lessonTitle = '',
  lessonDate = '',
  budget = COURSE_CONTEXT_BUDGET.total
} = {}) {
  const sameCourse = records.filter(record => record?.courseName && record.courseName === courseName)
  if (!sameCourse.length) return { text: '', chars: 0, lessonCount: 0, previous: null }

  const ordered = [...sameCourse].sort((left, right) =>
    lessonDateOfRecord(left).localeCompare(lessonDateOfRecord(right)) ||
    String(left.lessonTitle).localeCompare(String(right.lessonTitle)))
  const currentDate = lessonDate || ordered.find(record => record.lessonTitle === lessonTitle)?.lessonDate || ''
  const earlier = ordered.filter(record => {
    if (record.lessonTitle === lessonTitle && record.courseName === courseName) return false
    if (!currentDate) return true
    const date = lessonDateOfRecord(record)
    return date ? date < currentDate : true
  })
  if (!earlier.length) return { text: '', chars: 0, lessonCount: 0, previous: null }

  const recent = earlier.slice(-COURSE_CONTEXT_BUDGET.recentLessons)
  const older = earlier.slice(0, Math.max(0, earlier.length - COURSE_CONTEXT_BUDGET.recentLessons))
  const head = [
    `## 课程进行到哪里了（${courseName}，此前的成品笔记摘要）`,
    '用法：判断本节课承接什么、哪些内容已经讲过（不要重复讲授、也不要照抄这里的话）。',
    '这里没有的内容，不要当成"上节讲过"——宁可只写确切的那一点。'
  ].join('\n')

  const compose = ({ detailCount, summaryChars }) => {
    const parts = [head]
    if (older.length) {
      parts.push('', '## 更早的课次', ...older.map(briefLine))
    }
    const detailed = recent.slice(-detailCount)
    const skipped = recent.slice(0, Math.max(0, recent.length - detailCount))
    if (skipped.length) parts.push('', '## 稍早的课次', ...skipped.map(briefLine))
    parts.push('', '## 最近的课次', ...detailed.map(record => detailedLines({
      ...record,
      summary: String(record.summary || record.brief?.briefing || '').slice(0, summaryChars)
    })))
    return parts.join('\n')
  }

  let text = compose({ detailCount: recent.length, summaryChars: COURSE_CONTEXT_BUDGET.summaryChars })
  // 超预算就一层层往下压：先缩短摘要，再把"稍早"的最近课次降成一行
  for (const step of [
    { detailCount: 2, summaryChars: 160 },
    { detailCount: 1, summaryChars: 220 },
    { detailCount: 1, summaryChars: 140 }
  ]) {
    if (text.length <= budget) break
    text = compose(step)
  }
  if (text.length > budget) {
    // 最后一招：全部压成一行行（仍然给出顺序与主题，只是没有细节）
    text = [head, '', '## 课程进行到哪里了', ...earlier.map(briefLine)].join('\n')
  }
  return {
    text,
    chars: text.length,
    lessonCount: earlier.length,
    previous: earlier[earlier.length - 1] || null
  }
}
