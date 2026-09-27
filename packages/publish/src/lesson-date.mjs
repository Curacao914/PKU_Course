/**
 * 课次日期：把"这节课是哪天上的"从"什么时候发布的"里拆出来。
 *
 * 为什么要拆：publishedAt 一个字段原先同时承担四件事——这节课的日期、最新课次排序、
 * 上一讲/下一讲、以及 RSS 的 pubDate。旧课重新发布（改错字、补法条、重排版式）时
 * publishedAt 会被刷新，那一节就窜到首页最上面，变成"最新一课"，连上一讲/下一讲也乱掉。
 *
 * 三个时间从此各管一件事：
 *   lessonDate        这节课实际是哪天上的 —— 站内排序、首页日期列、上一讲/下一讲、MCP 展示
 *   firstPublishedAt  第一次进站的时间     —— RSS 的 pubDate（订阅者关心的"新条目"）
 *   updatedAt         最近一次重新发布/改动 —— 日报的"昨天更新了什么"
 *
 * 解析顺序（先到先得）：显式 --lesson-date → 课次标题里的日期 → 账本里的 starts_at_text
 * → 记录里已有的 lessonDate（重新发布时保持不变）→ firstPublishedAt 的日期（并在输出里标注来源）。
 *
 * 纯函数、零依赖：日期规则能单独测，不必先起一个站点或一条发布流水线。
 */

/** 日期只能来自这三种写法：2026-09-20 / 2026.9.20 / 2026年9月20日（2026-05-27 13:00 也认）。 */
const DATE_IN_TEXT = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/

const pad2 = value => String(value).padStart(2, '0')

/** 校验并拼成 YYYY-MM-DD；2 月 30 日这种不存在的日期返回空串（宁可没有，不要一个假日期）。 */
function isoDate(year, month, day) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return ''
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return ''
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** 从一段文本里找出第一个日期（课次标题、账本的 starts_at_text 都走它）。 */
export function parseDateFromText(text = '') {
  const match = String(text ?? '').match(DATE_IN_TEXT)
  if (!match) return ''
  return isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** 取时间戳的日期部分：2026-09-25T03:00:00.000Z → 2026-09-25。 */
export function dateOnly(value = '') {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return ''
  return isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/**
 * 定下这一节的 lessonDate。
 *
 * 返回 { lessonDate, lessonDateSource }：来源必须落盘（见 buildNoteRecord），
 * 这样"日期是猜的"这件事在记录里看得见，而不是展示时再临时猜一次。
 */
export function resolveLessonDate({
  explicit = '', lessonTitle = '', startsAtText = '', previousLessonDate = '', fallbackAt = ''
} = {}) {
  const candidates = [
    ['explicit', parseDateFromText(explicit)],
    ['title', parseDateFromText(lessonTitle)],
    ['ledger', parseDateFromText(startsAtText)],
    ['previous', dateOnly(previousLessonDate)],
    ['published', dateOnly(fallbackAt)]
  ]
  const hit = candidates.find(candidate => candidate[1])
  return hit ? { lessonDate: hit[1], lessonDateSource: hit[0] } : { lessonDate: '', lessonDateSource: 'none' }
}

/** 展示/排序都从这里取日期：没有 lessonDate 的老记录退回第一次发布的时间。 */
export function lessonDateOf(record = {}) {
  return dateOnly(record?.lessonDate) || dateOnly(record?.firstPublishedAt) || dateOnly(record?.publishedAt) || ''
}

/** 首次进站时间；老记录只有 publishedAt 时它就是首次进站时间。 */
export function firstPublishedAtOf(record = {}) {
  return String(record?.firstPublishedAt || record?.publishedAt || '')
}

/** 最近一次重新发布/改动的时间；老记录退回 publishedAt。 */
export function updatedAtOf(record = {}) {
  return String(record?.updatedAt || record?.firstPublishedAt || record?.publishedAt || '')
}

function compareText(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 课次先后：lessonDate 升序；同一天（比如两节补课）按标题定一个稳定次序，最后用 slug 兜底。 */
export function compareLessonAscending(left = {}, right = {}) {
  return compareText(lessonDateOf(left), lessonDateOf(right)) ||
    compareText(left.lessonTitle, right.lessonTitle) ||
    compareText(left.slug, right.slug)
}

/** 首页/索引用的倒序：最新的一节课在最上面——"最新"指的是 lessonDate，不是发布时间。 */
export function compareLessonDescending(left = {}, right = {}) {
  return compareLessonAscending(right, left)
}

/** RSS 与"新条目"列表用：按首次进站时间倒序（重新发布旧课不该让它跳回订阅器顶部）。 */
export function compareFirstPublishedDescending(left = {}, right = {}) {
  return compareText(firstPublishedAtOf(right), firstPublishedAtOf(left)) ||
    compareLessonDescending(left, right)
}
