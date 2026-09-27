import assert from 'node:assert/strict'
import test from 'node:test'

import { COURSE_CONTEXT_BUDGET, buildCourseContext, lessonDateOfRecord } from './course-context.mjs'

const record = (over = {}) => ({
  slug: `notes/刑法总论/${over.lessonTitle || '第1讲'}`,
  courseName: '刑法总论',
  lessonTitle: '第1讲',
  lessonDate: '2026-09-07',
  theme: '罪刑法定与构成要件',
  keywords: ['罪刑法定', '构成要件', '违法性'],
  summary: '本节讲罪刑法定原则与构成要件的关系。',
  headings: [
    { level: 2, text: '一、罪刑法定' },
    { level: 2, text: '二、构成要件' },
    { level: 3, text: '（一）客观构成要件' },
    { level: 2, text: '知识连接' }
  ],
  metadata: { concepts: ['罪刑法定', '构成要件'], statutes: ['刑法第3条'], cases: ['某案'], keywords: [] },
  ...over
})

const LIBRARY = [
  record({ lessonTitle: '第3讲', lessonDate: '2026-09-21', theme: '罪刑均衡', summary: '本节讲罪刑均衡。' }),
  record({ lessonTitle: '第1讲', lessonDate: '2026-09-07' }),
  record({ lessonTitle: '第2讲', lessonDate: '2026-09-14', theme: '违法性', summary: '本节讲违法性。' }),
  record({ courseName: '民法总论', lessonTitle: '第1讲', lessonDate: '2026-09-01' })
]

test('上下文按课次日期排序，只取本节课之前的课次', () => {
  const context = buildCourseContext({ records: LIBRARY, courseName: '刑法总论', lessonTitle: '第3讲', lessonDate: '2026-09-21' })
  assert.equal(context.lessonCount, 2, '第 1、2 讲在前，第 3 讲自身不算')
  assert.equal(context.previous.lessonTitle, '第2讲')
  assert.ok(!context.text.includes('罪刑均衡'), '本节课自己的内容不该出现在"此前讲到哪"里')
  assert.ok(!context.text.includes('民法总论'), '别的课程不进上下文')
  assert.ok(context.text.indexOf('第1讲') < context.text.indexOf('第2讲'), '按日期从早到晚')
})

test('最近的课次详写（主题/关键词/概念/法条/案例/小节/摘要），更早的压成一行', () => {
  const many = [1, 2, 3, 4, 5].map(index => record({
    lessonTitle: `第${index}讲`,
    lessonDate: `2026-09-0${index}`,
    theme: `主题${index}`,
    summary: `摘要${index}。`
  }))
  const context = buildCourseContext({ records: many, courseName: '刑法总论', lessonTitle: '第6讲', lessonDate: '2026-09-06' })
  assert.equal(context.lessonCount, 5)
  assert.match(context.text, /## 更早的课次/)
  assert.match(context.text, /## 最近的课次/)
  assert.match(context.text, /### 第5讲（2026-09-05）/)
  assert.match(context.text, /概念：罪刑法定、构成要件/)
  assert.match(context.text, /法条：刑法第3条/)
  assert.ok(context.text.includes('小节：一、罪刑法定 / 二、构成要件'), '只要话题那一级，且不列"知识连接"这类装置')
  assert.ok(!context.text.includes('（一）客观构成要件'), '三级标题不是"讲到哪"的粒度')
})

test('第一讲没有"此前"：返回空文本，调用方据此不加这一块', () => {
  const first = buildCourseContext({ records: LIBRARY, courseName: '刑法总论', lessonTitle: '第1讲', lessonDate: '2026-09-07' })
  assert.deepEqual(first, { text: '', chars: 0, lessonCount: 0, previous: null })
  // 课程名对不上（新课程、发布库里还没有它）同样是空
  assert.equal(buildCourseContext({ records: LIBRARY, courseName: '国际公法', lessonTitle: '第1讲' }).text, '')
})

test('有预算：课次再多也不超过上限', () => {
  const many = Array.from({ length: 12 }, (_, index) => record({
    lessonTitle: `第${index + 1}讲`,
    lessonDate: `2026-09-${String(index + 1).padStart(2, '0')}`,
    summary: '这是一段很长的摘要，用来把上下文顶到预算上限附近。'.repeat(6)
  }))
  const context = buildCourseContext({ records: many, courseName: '刑法总论', lessonTitle: '第13讲', lessonDate: '2026-09-13' })
  assert.ok(context.chars <= COURSE_CONTEXT_BUDGET.total, `预算内（实际 ${context.chars}）`)
  assert.equal(context.lessonCount, 12)
  assert.match(context.text, /第12讲/, '压缩之后仍要知道最近讲到哪')
})

test('课次日期：lessonDate 优先，标题里的日期兜底，都没有就用进站日期', () => {
  assert.equal(lessonDateOfRecord({ lessonDate: '2026-09-07', lessonTitle: '第10-12节' }), '2026-09-07')
  assert.equal(lessonDateOfRecord({ lessonTitle: '2026年9月7日第5-6节' }), '2026-09-07')
  assert.equal(lessonDateOfRecord({ lessonTitle: '2026-9-7' }), '2026-09-07')
  assert.equal(lessonDateOfRecord({ lessonTitle: '第10-12节', firstPublishedAt: '2026-09-25T10:00:00.000Z' }), '2026-09-25')
})

test('不编造：摘要里没有的东西不会出现在上下文里', () => {
  const bare = [record({ lessonTitle: '第1讲', lessonDate: '2026-09-07', theme: '', keywords: [], summary: '', metadata: { concepts: [], statutes: [], cases: [], keywords: [] }, headings: [] })]
  const context = buildCourseContext({ records: bare, courseName: '刑法总论', lessonTitle: '第2讲', lessonDate: '2026-09-14' })
  assert.match(context.text, /### 第1讲（2026-09-07）/)
  assert.ok(!context.text.includes('主题：'), '没有主题就不写这一行')
  assert.ok(!context.text.includes('概念：'), '没有概念就不写这一行')
  assert.match(context.text, /不得当成"上节讲过"|不要当成"上节讲过"/, '纪律写在上下文里')
})
