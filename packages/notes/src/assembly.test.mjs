import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assembleFinalNote,
  buildFinalNoteMarkdown,
  chineseIndex,
  demoteBodyHeadings,
  extractNodeMetadata,
  findMetaCommentary,
  normalizedSpliceData,
  outlineTopic,
  renderMetaBlock,
  renderTimeline,
  stripMetaBlock
} from './assembly.mjs'

const approvedNode = (id, outlineNodeId, draft, over = {}) => ({
  id,
  outlineNodeId,
  title: `节点 ${id}`,
  status: 'node_approved',
  draft,
  versions: [{}],
  concepts: [],
  statutes: [],
  cases: [],
  ...over
})

function lessonFixture() {
  return {
    key: 'lesson-1',
    title: '第10-12节 共犯与罪数',
    blueprint: { mainLine: '从共犯的成立条件讲到罪数判断' },
    outline: [
      { id: 'o1', title: '一、共犯的成立条件', concepts: ['共同故意'] },
      { id: 'o2', title: '二、罪数判断', rationale: '把前面的结论用到罪数问题上' }
    ],
    nodes: [
      approvedNode('n1', 'o1', '共犯的成立需要共同故意与共同行为。'),
      approvedNode('n2', 'o2', '罪数的判断以行为个数与法益侵害为基础。')
    ],
    finalNoteVersions: []
  }
}

const goodSpliceData = () => ({
  courseOverview: {
    coreQuestions: ['共犯如何成立？', '罪数如何判断？', '两者的关系是什么？'],
    shouldBeAbleTo: ['解释共犯成立条件', '辨析罪数判断标准', '用本课论证分析案例'],
    lectureThread: '本课先说明共犯的成立条件，再讨论罪数判断，最后回到主线上把两者联系起来。这句话故意写得比较长以便通过六十字的门槛要求。'
  },
  sectionSummaries: {
    o1: '本节承担本课的第一个论证环节，先确立共犯的成立条件，为后文罪数判断提供前置概念，并在全课主线中起到铺垫作用。',
    o2: '本节完成本课的第二段论证，把共犯的结论用于罪数判断，并在全课主线中收束前面的讨论。'
  },
  sectionQuizzes: {
    o1: [
      { question: '请写出共犯成立的要件，并说明每个要件的判断标准。', answer: '共同故意（意思联络）与共同行为；判断标准是各行为人之间是否存在相互利用、补充的意思联络。' },
      { question: '共同故意与共同行为是什么关系？', answer: '两者是并列要件：缺少任一都不成立共犯，故意的判断先于行为分担的判断。' }
    ],
    o2: [
      { question: '罪数判断的标准是什么？', answer: '以行为个数与法益侵害个数为基础，结合构成要件评价。' }
    ]
  },
  knowledgeLink: { inheritsFrom: '上一课讲过的构成要件', laysGroundworkFor: [{ concept: '共犯', use: '后续罪名分析' }], nextLessonPreview: '下一课讲未遂' },
  appendix: { terms: [{ term: '共犯', original: 'joint crime', definition: '二人以上共同故意犯罪' }] }
})

test('stripMetaBlock removes both metadata styles', () => {
  const draft = '正文第一段\n\n<!-- META\nCONCEPT: 共犯\n-->\n\n正文第二段'
  assert.equal(stripMetaBlock(draft), '正文第一段\n\n正文第二段')
  const nodeStyle = '正文\n\nMETA_FOR_NODE:\nCONCEPT: 共犯\n\n后续内容'
  const stripped = stripMetaBlock(nodeStyle)
  assert.ok(!stripped.includes('CONCEPT: 共犯'), '元数据必须被剥掉')
  assert.match(stripped, /^正文/)
  assert.match(stripped, /后续内容$/)
})

test('body headings are demoted below the section level', () => {
  // 模型偶尔会在节点正文里自带 # / ## 标题；原样拼进去成品笔记就会出现两套层级。
  const demoted = demoteBodyHeadings('# 变量总论\n\n## 定性变量\n\n正文\n\n### 补充\n\n更多正文')
  assert.match(demoted, /^#### 变量总论/m, '最浅的标题落到 ####')
  assert.match(demoted, /^##### 定性变量/m, '相对层级保持不变')
  assert.match(demoted, /^###### 补充/m)
  assert.equal(demoteBodyHeadings('没有标题的正文'), '没有标题的正文')
})

test('extractNodeMetadata merges draft markers and node fields', () => {
  const rows = extractNodeMetadata(approvedNode('n1', 'o1', '- CONCEPT: 共犯\nPITFALL: 别把共犯当共同犯罪人', {
    concepts: ['共犯', '共犯'],
    statutes: ['《刑法》第25条'],
    cases: ['某某案']
  }))
  assert.deepEqual(rows, [
    ['CONCEPT', '共犯'],
    ['PITFALL', '别把共犯当共同犯罪人'],
    ['CONCEPT', '共犯'],
    ['CONCEPT', '共犯'],
    ['PROVISION', '刑法第25条'],
    ['CASE', '某某案']
  ])
})

test('renderMetaBlock dedupes, orders by type and renders a details block', () => {
  const block = renderMetaBlock([
    approvedNode('n1', 'o1', '', { cases: ['乙案'], statutes: ['刑法第25条'], concepts: ['共犯'] }),
    approvedNode('n2', 'o2', '', { concepts: ['共犯', '罪数'], cases: ['乙案'] })
  ])
  const lines = block.split('\n').filter(line => line.startsWith('META:'))
  assert.deepEqual(lines, ['META: CONCEPT: 共犯', 'META: CONCEPT: 罪数', 'META: PROVISION: 刑法第25条', 'META: CASE: 乙案'])
  assert.match(block, /<details><summary>📑 笔记元数据/)
})

test('outlineTopic and chineseIndex shape the section headings', () => {
  assert.equal(outlineTopic({ title: '一、共犯的成立条件' }), '共犯的成立条件')
  assert.equal(outlineTopic({ title: '罪数判断 ★' }), '罪数判断')
  assert.equal(outlineTopic({}, '本节内容'), '本节内容')
  assert.equal(chineseIndex(0), '一')
  assert.equal(chineseIndex(9), '十')
  assert.equal(chineseIndex(10), '11')
})

test('normalizedSpliceData tops up thin model output without inventing facts', () => {
  const lesson = lessonFixture()
  const normalized = normalizedSpliceData(lesson, {
    courseOverview: { coreQuestions: ['只有一个问题'], lectureThread: '太短' },
    sectionSummaries: { o1: '太短' },
    sectionQuizzes: { o1: [] }
  })
  assert.ok(normalized.courseOverview.coreQuestions.length >= 3, '核心问题补到至少 3 条')
  assert.ok(normalized.courseOverview.shouldBeAbleTo.length >= 3)
  assert.ok(normalized.courseOverview.lectureThread.length >= 60, '课程脉络补到 60 字以上')
  assert.ok(normalized.sectionSummaries.o1.length >= 45, '章节总结补到 45 字以上')
  assert.ok(normalized.sectionSummaries.o2.length >= 45, '模型没给的章节也要有总结')
  assert.equal(normalized.sectionQuizzes.o1.length, 3, '自测补到至少 3 题')
  assert.equal(normalized.sectionQuizzes.o2.length, 3)
  assert.ok(normalized.sectionQuizzes.o2[0].question.includes('规则或构成要件'), '兜底题型优先"写出规则/要件"')
  assert.ok(normalized.knowledgeLink.laysGroundworkFor.length >= 1, '由大纲概念推断知识连接')
  // 补齐的是结构，不是课堂事实
  assert.ok(!normalized.sectionSummaries.o1.includes('判决'), '补齐内容不得引入具体案情')
})

test('buildFinalNoteMarkdown assembles sections in outline order', () => {
  const lesson = lessonFixture()
  const markdown = buildFinalNoteMarkdown({
    courseSpec: { courseName: '刑法分论', teacher: '车浩' },
    lesson,
    spliceData: normalizedSpliceData(lesson, goodSpliceData())
  })

  assert.match(markdown, /^# 第10-12节 共犯与罪数/)
  assert.match(markdown, /> 课程：刑法分论 · 车浩/)
  // 分层：先体系（位置/地图/线索/问题/目标），再分节正文，最后检索层
  assert.match(markdown, /## 本课在课程中的位置/)
  assert.match(markdown, /## 知识地图/)
  assert.match(markdown, /```mermaid/)
  assert.match(markdown, /flowchart TD/, '没有模型图源时由程序生成结构图')
  assert.match(markdown, /## 体系线索/)
  assert.match(markdown, /## 核心问题/)
  assert.match(markdown, /## 学习目标/)
  assert.match(markdown, /## 复习层/)
  assert.match(markdown, /### 一、共犯的成立条件/)
  assert.match(markdown, /### 二、罪数判断/)
  assert.ok(markdown.includes('共犯的成立需要共同故意与共同行为。'), '节点正文必须逐字进入')
  assert.ok(markdown.indexOf('共犯的成立需要') < markdown.indexOf('罪数的判断以行为个数'), '章节顺序与大纲一致')
  assert.match(markdown, /\*\*自测\*\*（合上笔记，先自己写出来，再看答案）/, '自测在节末，且提示先自答')
  assert.match(markdown, /<details><summary>参考答案<\/summary>/, '答案必须折叠：先回忆再看答案，检索才成立')
  assert.ok(markdown.indexOf('## 本课在课程中的位置') < markdown.indexOf('### 一、共犯的成立条件'), '体系层必须在正文之前')
  assert.ok(markdown.indexOf('### 一、共犯的成立条件') < markdown.indexOf('## 复习层'), '检索层必须在正文之后')
  assert.match(markdown, /## 知识连接/)
  assert.match(markdown, /## 附录：补充与发散/)
  // 元数据来自**节点**字段与正文标记，不是大纲条目
  assert.match(markdown, /📑 笔记元数据/)
  assert.ok(!/\{\{[^}]+\}\}/.test(markdown), '不得残留占位符')
})

test('the timeline table keeps every section traceable to its classroom position', () => {
  // 笔记按体系展开之后，"这段是第几分钟讲的"这条线索不能丢：回听原音、核对老师原话都靠它。
  const lesson = {
    title: '第10-12节',
    transcript: ['[00:00:10 – 00:00:20] 第一句', '', '[00:35:02 – 00:35:20] 第二句'].join('\n'),
    outline: [
      { id: 'o1', title: '一、共犯', lineRange: [1, 1] },
      { id: 'o2', title: '二、罪数', lineRange: [2, 2] }
    ]
  }
  const table = renderTimeline(lesson)
  assert.match(table, /时间轴与体系对照/)
  assert.match(table, /00:00:10/)
  assert.match(table, /00:35:02/)
  assert.match(table, /L2–L2/)
  assert.match(table, /一、共犯/, '章节序号沿用中式层级')
})

test('meta commentary in a finished note is counted rather than silently shipped', () => {
  const hits = findMetaCommentary('正文没问题\n\n## 本节点小结\n\n写作目标：说明变量\n\n待补写')
  assert.equal(hits.length, 3)
  assert.equal(hits[0].phrase, '本节点')
  assert.deepEqual(findMetaCommentary('正常的课堂内容，讨论共犯的成立条件。'), [])
})

test('logistics and digression sections are routed to the appendix', () => {
  // 旧手工流程的明确规则：课堂管理、通知、闲聊一律进附录。它们打断主线，但也不该丢。
  const lesson = {
    title: '第10-12节',
    transcript: '[00:00:10 – 00:00:20] 第一句',
    blueprint: { mainLine: '主线' },
    outline: [
      { id: 'o1', title: '一、共犯', lineRange: [1, 1], kind: 'content' },
      { id: 'o2', title: '课间通知与助教安排', lineRange: [2, 2], kind: 'logistics' }
    ],
    nodes: [
      approvedNode('n1', 'o1', '共犯的成立需要共同故意。', { kind: 'content' }),
      approvedNode('n2', 'o2', '老师介绍了两位助教的分工。', { kind: 'logistics' })
    ]
  }
  const markdown = buildFinalNoteMarkdown({
    courseSpec: { courseName: '刑法分论' },
    lesson,
    spliceData: normalizedSpliceData(lesson, {})
  })

  const appendixAt = markdown.indexOf('## 附录：课堂事务与发散')
  assert.ok(appendixAt > 0, '事务小节必须进附录')
  assert.ok(markdown.indexOf('老师介绍了两位助教的分工。') > appendixAt, '事务正文只出现在附录里')
  assert.ok(markdown.indexOf('共犯的成立需要共同故意。') < appendixAt, '正课正文仍在正文区')
  assert.ok(markdown.indexOf('### 二、课间通知') === -1, '事务小节不占正文的中式序号')
})

test('a single write unit covering several modules still renders as separate sections', () => {
  // "不切"指的是分几次模型调用写完，不是把整节课压成一个小节：
  // 模型按模块标题分段，拼装层据此还原成多个小节。
  const lesson = {
    title: '第10-12节',
    transcript: '[00:00:10 – 00:00:20] 第一句',
    blueprint: { mainLine: '主线' },
    outline: [
      { id: 'o1', title: '共犯的成立', lineRange: [1, 1] },
      { id: 'o2', title: '罪数判断', lineRange: [1, 1] }
    ],
    nodes: [{
      id: 'u1',
      outlineNodeId: 'o1',
      outlineNodeIds: ['o1', 'o2'],
      moduleBriefs: [{ outlineNodeId: 'o1', title: '共犯的成立' }, { outlineNodeId: 'o2', title: '罪数判断' }],
      status: 'node_approved',
      draft: '### 共犯的成立\n\n共犯需要共同故意。\n\n### 罪数判断\n\n罪数按行为个数判断。',
      versions: [{}],
      concepts: [], statutes: [], cases: []
    }]
  }
  const markdown = buildFinalNoteMarkdown({
    courseSpec: { courseName: '刑法分论' },
    lesson,
    spliceData: normalizedSpliceData(lesson, {})
  })

  assert.match(markdown, /^### 一、共犯的成立$/m, '第一个模块按中式序号渲染')
  assert.match(markdown, /^### 二、罪数判断$/m, '第二个模块同样独立成节')
  assert.ok(markdown.indexOf('共犯需要共同故意。') < markdown.indexOf('罪数按行为个数判断。'), '模块顺序不变')
  assert.ok(!/^### 共犯的成立$/m.test(markdown), '模型自带的标题不再重复出现')

  const assembled = assembleFinalNote(lesson, {}, {})
  assert.ok(assembled.finalNote.markdown.includes('罪数按行为个数判断。'), '完整性校验按模块片段逐个确认')
})

test('nodes outside the outline still reach the final note', () => {
  const lesson = lessonFixture()
  lesson.nodes.push(approvedNode('n9', 'missing-outline-node', '这段正文没有对应的大纲条目。'))
  const markdown = buildFinalNoteMarkdown({
    courseSpec: { courseName: 'c' },
    lesson,
    spliceData: normalizedSpliceData(lesson, goodSpliceData())
  })
  assert.match(markdown, /### 其他/)
  assert.ok(markdown.includes('这段正文没有对应的大纲条目。'))
})

test('assembleFinalNote refuses to run before every node is approved', () => {
  const lesson = lessonFixture()
  lesson.nodes[1].status = 'node_review'
  assert.throws(() => assembleFinalNote(lesson, {}), /所有节点都必须已批准/)

  const empty = { ...lessonFixture(), nodes: [] }
  assert.throws(() => assembleFinalNote(empty, {}), /所有节点都必须已批准/)
})

test('assembleFinalNote produces a versioned note and checks body integrity', () => {
  const lesson = lessonFixture()
  const assembled = assembleFinalNote(lesson, goodSpliceData(), {
    courseSpec: { courseName: '刑法分论', teacher: '车浩' },
    at: '2026-09-25T00:00:00.000Z'
  })

  assert.equal(assembled.status, 'final_review')
  assert.equal(assembled.finalNote.markdown.includes('共犯的成立需要共同故意与共同行为。'), true)
  assert.equal(assembled.finalNoteVersions.length, 1)
  assert.equal(assembled.finalNoteVersions[0].source, 'assembly')
  assert.equal(assembled.finalNoteVersions[0].at, '2026-09-25T00:00:00.000Z')
  assert.deepEqual(assembled.finalNote.assembly.nodeVersions, { n1: 1, n2: 1 })
  assert.equal(assembled.finalNote.stale, false)
  assert.equal(assembled.qualityReport, null, '新拼装的稿子尚未经过终审')
})

test('assembly refuses a note that still contains splice placeholders', () => {
  const lesson = lessonFixture()
  // 真实场景：模型把接缝占位符写进了节点正文，拼装后必须拦住
  lesson.nodes[0].draft = '正文里混进了 {{H1_SUMMARY:o1}} 这样的占位符。'
  assert.throws(
    () => assembleFinalNote(lesson, goodSpliceData(), { courseSpec: {} }),
    /仍残留接缝占位符/
  )
})

test('metadata rows reach the final note through node fields', () => {
  const lesson = lessonFixture()
  lesson.nodes[0].concepts = ['共同故意']
  lesson.nodes[0].statutes = ['《刑法》第25条']
  const markdown = buildFinalNoteMarkdown({
    courseSpec: { courseName: '刑法分论' },
    lesson,
    spliceData: normalizedSpliceData(lesson, goodSpliceData())
  })
  assert.match(markdown, /META: CONCEPT: 共同故意/)
  assert.match(markdown, /META: PROVISION: 刑法第25条/)
})

test('a draft that is nothing but metadata counts as an empty body', () => {
  // 继承语义：完整性校验只针对"有实际正文"的节点。整段都是元数据的草稿
  // 剥离后为空，因此不会被判为"正文丢失"。这里如实断言，避免以后被误认为 bug。
  const lesson = lessonFixture()
  lesson.nodes[0].draft = '<!-- META\nCONCEPT: x\n-->'
  const assembled = assembleFinalNote(lesson, goodSpliceData(), { courseSpec: {} })
  assert.ok(!assembled.finalNote.markdown.includes('<!-- META'), '原始标记不会进入正文')
  assert.match(assembled.finalNote.markdown, /META: CONCEPT: x/, '但元数据仍被收集到末尾的元数据块')
})

test('a stale publication is marked on reassembly', () => {
  const lesson = { ...lessonFixture(), publication: { slug: 'notes/x/lesson-1', status: 'published' } }
  const assembled = assembleFinalNote(lesson, goodSpliceData(), { courseSpec: {} })
  assert.equal(assembled.publication.stale, true, '重新拼装后已发布版本应标记为过期')
  assert.equal(assembled.publication.slug, 'notes/x/lesson-1')
})
