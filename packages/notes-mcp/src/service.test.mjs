import assert from 'node:assert/strict'
import test from 'node:test'

import { ResourceNotFoundError, ToolError } from './errors.mjs'
import { createFixtureService } from './fixtures/fixture.mjs'
import { COURSES_URI, courseUri, noteUri, termsUri } from './uris.mjs'

const service = createFixtureService()
const NOTE_ONE = 'notes/国际法学/第一课-国家责任的构成'

test('list_courses：课程名 + 课次数 + 最新时间 + theme/keywords 汇总（第一层）', async () => {
  const data = await service.listCourses()
  assert.equal(data.total, 3)
  assert.equal(data.lessonTotal, 6)
  assert.deepEqual(data.courses.map(course => course.courseName), ['国际法学', '刑法总论', '民法总论'])
  const intl = data.courses[0]
  assert.equal(intl.lessonCount, 3)
  // 展示的是"这节课哪天上的"（lessonDate），不是"什么时候发布的"（publishedAt）
  assert.equal(intl.latestLessonDate, '2026-03-08')
  assert.equal('latestPublishedAt' in intl, false, '发布日期不再出现在课次清单里')
  assert.equal(intl.latestLessonTitle, '第三课 国际法院的管辖')
  assert.equal(intl.teacher, '张老师')
  assert.deepEqual(intl.themes.map(item => item.theme), ['管辖与可受理性的两道门', '反措施的可逆性与相称性', '国家责任的三层结构'])
  assert.ok(intl.keywords.includes('反措施'))
  assert.ok(intl.keywords.length <= 8)
  assert.deepEqual(intl.termCounts, { concepts: 10, statutes: 4, cases: 2 })
  // 列表本身不含正文——这是"不把笔记灌进上下文"的关键
  assert.equal(JSON.stringify(data).includes('有效控制'), false)
})

test('老发布库（没有 lessonDate）退回发布日期的日期部分，不会显示空白', async () => {
  // 线上真出现过：发布库换成三个时间字段之后，MCP 这边没跟着透传，日期整列变成空白。
  const course = await service.getCourse({ course: '国际法学' })
  const legacy = course.lessons.find(lesson => lesson.lessonTitle === '第一课 国家责任的构成')
  assert.equal(legacy.lessonDate, '2026-02-20', '老记录用 publishedAt 的日期部分')
  const modern = course.lessons.find(lesson => lesson.lessonTitle === '第三课 国际法院的管辖')
  assert.equal(modern.lessonDate, '2026-03-08', '新记录用课次日期')
  const note = await service.getNote({ slug: 'notes/国际法学/第一课-国家责任的构成' })
  assert.equal(note.lessonDate, '2026-02-20')
})

test('资源清单带 lastModified（客户端据此判断要不要重拉）', async () => {
  const list = await service.listResources()
  const courses = list.find(item => item.uri === COURSES_URI)
  assert.ok(courses.annotations.lastModified, '顶层资源也要有时间戳')
  const course = list.find(item => String(item.uri).startsWith('notes://course/'))
  assert.equal(course.annotations.lastModified, '2026-03-20T09:00:00.000Z', '用最近一次改动时间')
})

test('list_courses：按课程名或教师名过滤，并给 limit 上限', async () => {
  assert.equal((await service.listCourses({ query: '刑' })).total, 1)
  assert.equal((await service.listCourses({ query: '张老师' })).courses[0].courseName, '国际法学')
  const limited = await service.listCourses({ limit: 2 })
  assert.equal(limited.total, 3)
  assert.equal(limited.courses.length, 2)
})

test('get_course：课次清单含 theme/keywords/摘要，不含正文', async () => {
  const data = await service.getCourse({ course: '国际法学' })
  assert.equal(data.lessonCount, 3)
  assert.deepEqual(data.lessons.map(lesson => lesson.lessonTitle), [
    '第一课 国家责任的构成', '第二课 反措施与解除不法性', '第三课 国际法院的管辖'
  ])
  const first = data.lessons[0]
  assert.equal(first.slug, NOTE_ONE)
  assert.equal(first.readMinutes, 18)
  assert.equal(first.theme, '国家责任的三层结构')
  assert.ok(first.keywords.includes('归因'))
  assert.match(first.summary, /初级规则/)
  assert.equal(JSON.stringify(data).includes('有效控制'), false)

  const desc = await service.getCourse({ course: '国际法学', order: 'desc', limit: 1 })
  assert.equal(desc.lessons[0].lessonTitle, '第三课 国际法院的管辖')
  assert.equal(desc.returned, 1)

  const withOutline = await service.getCourse({ course: '刑法总论', includeOutline: true })
  // outline 现在是分页对象：不静默截断，总数/返回数/是否截断都报出来
  const outline = withOutline.lessons[0].outline
  assert.ok(outline.items.some(head => head.text === '一、法律主义'))
  assert.equal(outline.total, outline.items.length)
  assert.equal(outline.truncated, false)
  assert.ok(outline.items[0].id, '目录项要带锚点 id，模型才能按 section 去取正文')
})

test('get_course：课程名部分匹配、歧义与找不到都给候选', async () => {
  const partial = await service.getCourse({ course: '国际法' })
  assert.equal(partial.courseName, '国际法学')
  await assert.rejects(() => service.getCourse({ course: '法' }), error => {
    assert.ok(error instanceof ToolError)
    assert.match(error.message, /不唯一/)
    assert.match(error.message, /国际法学/)
    return true
  })
  await assert.rejects(() => service.getCourse({ course: '不存在的课' }), /现有课程/)
})

test('search_notes：索引命中给出片段与定位（哪一节）', async () => {
  const data = await service.searchNotes({ query: '归因' })
  assert.ok(data.total >= 1)
  const hit = data.hits[0]
  assert.equal(hit.slug, NOTE_ONE)
  assert.equal(hit.location.title, '二、归因')
  assert.equal(hit.location.id, '二-归因')
  assert.ok(hit.snippets.some(snippet => snippet.includes('归因')))
  assert.equal(data.includeBody, false)

  const cases = await service.searchNotes({ query: '尼加拉瓜案' })
  assert.equal(cases.hits[0].location.title, '二、归因')
  assert.ok(cases.hits[0].kinds.includes('案例'))

  const scoped = await service.searchNotes({ query: '反措施', course: '刑法总论' })
  assert.equal(scoped.total, 0)
  assert.equal(scoped.hits.length, 0)
})

test('search_notes：元数据没命中时自动扫正文（并说明扫过），命中能定位到小节', async () => {
  // 内容类问题在标题/关键词里根本没有对应的词：只查元数据必然空手，所以默认也会再扫一遍正文，
  // 并把 bodyScanned 标出来——调用方应当知道这次结果是从正文里找到的。
  const auto = await service.searchNotes({ query: '有效控制' })
  assert.equal(auto.total, 1)
  assert.equal(auto.bodyScanned, true, '自动扫过正文要说出来')
  assert.equal(auto.hits[0].slug, NOTE_ONE)
  assert.equal(auto.hits[0].kind, '正文')
  assert.equal(auto.hits[0].location.title, '二、归因')
  assert.ok(auto.hits[0].snippets.some(snippet => snippet.includes('有效控制')))
  assert.equal(auto.bodySkipped, 0)

  const withBody = await service.searchNotes({ query: '有效控制', includeBody: true })
  assert.equal(withBody.total, 1)
  assert.equal(withBody.hits[0].slug, NOTE_ONE)

  // 元数据命中时**不必下沉**（escalated=false）：正文就在本地库里，auto 会顺带用上，
  // 所以 bodyScanned 是 true；"索引答不上来才去翻正文"这件事由 escalated 表达。
  const metadata = await service.searchNotes({ query: '归因' })
  assert.equal(metadata.escalated, false)
  assert.equal(metadata.coverage, 'body')
  // 显式只查索引：不碰正文
  const indexOnly = await service.searchNotes({ query: '归因', coverage: 'index' })
  assert.equal(indexOnly.bodyScanned, false)
  assert.equal(indexOnly.coverage, 'index')
})

test('search_notes：空查询报错，limit 截断但保留 total', async () => {
  await assert.rejects(() => service.searchNotes({ query: '   ' }), ToolError)
  // 只有疑问词的查询：解析之后一个词都不剩，直接报错，而不是把整库都当命中
  await assert.rejects(() => service.searchNotes({ query: '为什么' }), ToolError)
  const data = await service.searchNotes({ query: '归因', includeBody: true, limit: 2 })
  assert.ok(data.total >= 1)
  assert.equal(data.hits.length, Math.min(2, data.total))
})

test('get_note：按 slug、按课程+课次两种取法都能拿到全文', async () => {
  const bySlug = await service.getNote({ slug: NOTE_ONE })
  assert.match(bySlug.markdown, /^# 国际法学/)
  assert.equal(bySlug.totalChars, bySlug.markdown.length)
  assert.equal(bySlug.truncated, false)
  assert.equal(bySlug.section, null)
  assert.ok(bySlug.sections.length >= 5)

  const byLesson = await service.getNote({ course: '国际法学', lesson: '国家责任的构成' })
  assert.equal(byLesson.slug, NOTE_ONE)

  await assert.rejects(() => service.getNote({ slug: 'notes/不存在/第一课' }), /找不到 slug/)
  await assert.rejects(() => service.getNote({}), /需要 slug/)
  await assert.rejects(() => service.getNote({ course: '国际法学', lesson: '第' }), /不唯一/)
  await assert.rejects(() => service.getNote({ course: '国际法学', lesson: '第九课' }), /课次有/)
})

test('get_note：section 截取一节，不越界到下一节', async () => {
  const data = await service.getNote({ slug: NOTE_ONE, section: '归因' })
  assert.deepEqual(data.section, { title: '二、归因', id: '二-归因', level: 2 })
  assert.match(data.markdown, /^## 二、归因/)
  assert.match(data.markdown, /有效控制/)
  assert.equal(data.markdown.includes('## 三、反措施'), false)
  assert.equal(data.markdown.includes('## 一、国家责任的构成要素'), false)
  assert.ok(data.sectionChars < data.totalChars)

  const byId = await service.getNote({ slug: NOTE_ONE, section: '三-反措施' })
  assert.equal(byId.section.title, '三、反措施')

  await assert.rejects(() => service.getNote({ slug: NOTE_ONE, section: '不存在的节' }), /可用小节/)
})

test('get_note：maxChars 截断并给出可操作的提示，下限 200', async () => {
  const data = await service.getNote({ slug: NOTE_ONE, maxChars: 200 })
  assert.equal(data.truncated, true)
  assert.equal(data.markdown.length, 200)
  assert.equal(data.returnedChars, 200)
  assert.equal(data.maxChars, 200)

  const floored = await service.getNote({ slug: NOTE_ONE, maxChars: 50 })
  assert.equal(floored.maxChars, 200)

  const whole = await service.getNote({ slug: NOTE_ONE, maxChars: 999_999 })
  assert.equal(whole.truncated, false)
  assert.equal(whole.maxChars, 200_000)
})

test('list_terms：按出现次数汇总概念/法条/案例，并带落点', async () => {
  const data = await service.listTerms({ course: '国际法学' })
  assert.equal(data.courseName, '国际法学')
  assert.ok(data.buckets.concepts.some(item => item.term === '反措施'))
  const statute = data.buckets.statutes.find(item => item.term === '《国家责任条款》第22条')
  assert.equal(statute.count, 2)
  assert.equal(statute.notes.length, 2)
  assert.ok(statute.notes.some(note => note.anchor === '三-反措施'))

  const onlyCases = await service.listTerms({ course: '国际法学', kind: 'cases' })
  assert.deepEqual(Object.keys(onlyCases.buckets), ['cases'])
  assert.ok(onlyCases.buckets.cases.some(item => item.term === '尼加拉瓜案'))
})

test('resources：列表含课程/术语/笔记资源，读出来是 JSON 或 Markdown', async () => {
  const resources = await service.listResources()
  assert.equal(resources[0].uri, COURSES_URI)
  assert.ok(resources.some(item => item.uri === courseUri('国际法学')))
  assert.ok(resources.some(item => item.uri === termsUri('国际法学')))
  assert.ok(resources.some(item => item.uri === noteUri(NOTE_ONE) && item.mimeType === 'text/markdown'))
  assert.equal(resources.filter(item => item.mimeType === 'text/markdown').length, 6)

  const courses = await service.readResource(COURSES_URI)
  assert.equal(courses.mimeType, 'application/json')
  assert.equal(JSON.parse(courses.text).total, 3)

  const course = await service.readResource(courseUri('刑法总论'))
  assert.equal(JSON.parse(course.text).lessons.length, 2)

  const note = await service.readResource(noteUri(NOTE_ONE))
  assert.equal(note.mimeType, 'text/markdown')
  assert.match(note.text, /^# 国际法学/)

  // 客户端没编码也能读（手输 URI 的场景）
  const raw = await service.readResource('notes://note/notes/国际法学/第一课-国家责任的构成')
  assert.match(raw.text, /^# 国际法学/)

  await assert.rejects(() => service.readResource('notes://nope'), ResourceNotFoundError)
  await assert.rejects(() => service.readResource('notes://course/不存在的课'), error => {
    assert.ok(error instanceof ResourceNotFoundError)
    assert.equal(error.uri, 'notes://course/不存在的课')
    return true
  })

  const templates = service.resourceTemplates()
  assert.deepEqual(templates.map(item => item.uriTemplate), [
    'notes://course/{course}', 'notes://terms/{course}', 'notes://note/{slug}'
  ])
})

test('远程数据源上同样的分层也成立（正文按需下载）', async t => {
  const { startFakeSite } = await import('./fixtures/fixture.mjs')
  const site = await startFakeSite()
  t.after(() => site.close())
  const remote = (await import('./service.mjs')).createNotesService({
    source: (await import('./sources.mjs')).createSource({ origin: site.origin, ttlSeconds: 0 })
  })
  const courses = await remote.listCourses()
  assert.equal(courses.total, 3)
  assert.equal(site.requests.filter(url => url.startsWith('/md/')).length, 0, '列课程不该下载正文')

  const note = await remote.getNote({ slug: NOTE_ONE })
  assert.match(note.markdown, /^# 国际法学/)
  assert.equal(site.requests.filter(url => url.startsWith('/md/')).length, 1)
})
