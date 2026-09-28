import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIntegrationPlan, checkIntegrationSources, renderIntegrationMarkdown, selectLessons } from './integration.mjs'

/**
 * B2：章级整合原型。
 *
 * 原型要证明的是**结构**：跨课次的概念对照、反复出现的问题、待核继承、每行都有出处，
 * 而不是"又写了一篇长文"。所以断言都对着结构去，并且专门验"没有出处就拦下来"。
 */

const lesson = (title, date, concepts, markdown, anchors = {}, sections = []) => ({
  slug: `notes/刑事执行法/${title}`,
  courseName: '刑事执行法',
  lessonTitle: title,
  lessonDate: date,
  checksum: `sum-${title}`,
  markdown,
  // 真实发布库里 headings/sections 都有（A3 之后连指纹也有）——夹具照实给，
  // 不给的话"问题线"就抽不出来，测的就不是真实形状了。
  headings: sections.map(section => ({ level: section.level || 2, text: section.title, id: section.id })),
  sections,
  metadata: { concepts, statutes: [], cases: [], keywords: [] },
  anchors: { concepts: anchors, statutes: {}, cases: {} }
})

const RECORDS = [
  lesson('2026-09-07第5-6节', '2026-09-07', ['罪刑均衡', '以刑制罪'], [
    '## 一、罪刑均衡的提出', '',
    '罪刑均衡要求刑罚与罪行相当。', '',
    '## 二、以刑制罪是什么？', '',
    '刑罚的后果会反过来影响定罪。', '',
    '待核：第 3 段转录不清（09-07）。'
  ].join('\n'), { 罪刑均衡: '一-罪刑均衡的提出', 以刑制罪: '二-以刑制罪是什么' }, [
    { id: '一-罪刑均衡的提出', title: '一、罪刑均衡的提出', level: 2 },
    { id: '二-以刑制罪是什么', title: '二、以刑制罪是什么？', level: 2 }
  ]),
  lesson('2026-09-14第5-6节', '2026-09-14', ['罪刑均衡', '以刑制罪', '缓刑撤销'], [
    '## 一、罪刑均衡的展开', '',
    '均衡还要看执行阶段。', '',
    '## 二、以刑制罪是什么？', '',
    '同一问题在执行阶段再问一次。'
  ].join('\n'), { 罪刑均衡: '一-罪刑均衡的展开', 以刑制罪: '二-以刑制罪是什么', 缓刑撤销: '二-以刑制罪是什么' }, [
    { id: '一-罪刑均衡的展开', title: '一、罪刑均衡的展开', level: 2 },
    { id: '二-以刑制罪是什么', title: '二、以刑制罪是什么？', level: 2 }
  ]),
  lesson('2026-09-21第5-6节', '2026-09-21', ['以刑制罪'], [
    '## 一、司法论上的以刑制罪', '',
    '许霆案里可以看到刑罚后果影响解释。'
  ].join('\n'), { 以刑制罪: '一-司法论上的以刑制罪' }, [
    { id: '一-司法论上的以刑制罪', title: '一、司法论上的以刑制罪', level: 2 }
  ])
]

test('选课次：按日期排序、去重；课程或课次找不到时说清有什么', () => {
  const picked = selectLessons(RECORDS, { course: '刑事执行法' })
  assert.deepEqual(picked.map(item => item.lessonDate), ['2026-09-07', '2026-09-14', '2026-09-21'])
  const two = selectLessons(RECORDS, { course: '刑事执行法', lessons: ['2026-09-21第5-6节', '2026-09-07第5-6节'] })
  assert.deepEqual(two.map(item => item.lessonDate), ['2026-09-07', '2026-09-21'], '还是会按课次顺序排')
  assert.throws(() => selectLessons(RECORDS, { course: '不存在的课' }), /找不到课程/)
  assert.throws(() => selectLessons(RECORDS, { course: '刑事执行法', lessons: ['无此课次'] }), /找不到课次/)
})

test('整合：跨课次概念排前面、反复出现的问题进争点、待核原样继承', () => {
  const plan = buildIntegrationPlan({ records: RECORDS, course: '刑事执行法', topic: '罪刑均衡与以刑制罪', generatedAt: '2026-09-28T00:00:00.000Z' })
  assert.equal(plan.course, '刑事执行法')
  assert.equal(plan.lessons.length, 3)
  assert.ok(plan.lessons.every(item => item.contentFingerprint && item.checksum), '每个课次都要绑内容指纹与 checksum（失效判定用）')

  const cross = plan.concepts.filter(item => item.rows.length >= 2).map(item => item.term)
  assert.deepEqual(cross.sort(), ['以刑制罪', '罪刑均衡'], '跨课次的概念排在最前')
  assert.equal(plan.concepts[0].term, '以刑制罪', '三节都有的排第一')
  assert.equal(plan.concepts[0].rows.length, 3)

  assert.equal(plan.issues.length, 1, '同一个问题在两节课出现 → 争点')
  assert.match(plan.issues[0].question, /以刑制罪是什么/)
  assert.equal(plan.issues[0].answers.length, 2)

  assert.equal(plan.openMarkers.length, 1)
  assert.match(plan.openMarkers[0].text, /待核/)
  assert.equal(plan.openMarkers[0].slug, 'notes/刑事执行法/2026-09-07第5-6节', '待核要带课次')
  assert.equal(plan.openMarkers[0].hasSource, true)
})

test('出处检查：没有出处的行会被拦下来（整合不许替读者做无依据的断言）', () => {
  const plan = buildIntegrationPlan({ records: RECORDS, course: '刑事执行法' })
  assert.equal(checkIntegrationSources(plan).length, 0, '正常整合的每一行都有出处')

  const broken = structuredClone(plan)
  broken.concepts[0].rows[0].slug = 'notes/别的课/x'
  assert.ok(checkIntegrationSources(broken).some(item => item.code === 'missing-source'))
  const anchorless = structuredClone(plan)
  anchorless.concepts[0].rows[0].anchor = ''
  assert.ok(checkIntegrationSources(anchorless).some(item => item.code === 'missing-anchor'))
})

test('渲染：结构齐全、每行带出处、待核明说要小心', () => {
  const markdown = renderIntegrationMarkdown(buildIntegrationPlan({ records: RECORDS, course: '刑事执行法', topic: '罪刑均衡与以刑制罪', generatedAt: '2026-09-28T00:00:00.000Z' }))
  for (const heading of ['## 一、概念对照', '## 二、问题线', '## 三、论证推进', '## 四、待核与不确定', '## 五、出处索引']) {
    assert.ok(markdown.includes(heading), '缺少 ' + heading)
  }
  assert.match(markdown, /本页只做\*\*跨课次对照\*\*/)
  assert.match(markdown, /内容指纹：/)
  assert.match(markdown, /这些点在单课笔记里就没有定论/)
})
