import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeCourseTask,
  findOutlineCoverageGaps,
  mergeAndCoverOutline,
  numberTranscript,
  splicePlaceholderContext,
  transcriptLines,
  validateMarkdown,
  validateOutline,
  validateReview,
  validateSpliceData
} from './task-runner.mjs'

const transcript = (lines) => Array.from({ length: lines }, (_, i) => `第 ${i + 1} 行`).join('\n')

/** 假模型：按调用顺序返回预设结果，并记录收到的提示词 */
function fakeModel(replies) {
  const calls = []
  const queue = Array.isArray(replies) ? [...replies] : [replies]
  const callModel = async ({ role, prompt, config }) => {
    calls.push({ role, prompt, config })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return next
  }
  return { callModel, calls }
}

const modelReply = (parsed, trace = { model: 'm', role: 'x' }) => ({ parsed, trace })

test('numberTranscript stamps absolute line numbers', () => {
  assert.equal(numberTranscript('甲\n乙\n丙'), '[L1] 甲\n[L2] 乙\n[L3] 丙')
  assert.equal(numberTranscript('甲\n乙\n丙', [2, 3]), '[L2] 乙\n[L3] 丙')
  // 只做整体裁剪与去空行，不逐行 trim——逐行改写会破坏转录的原始缩进语义
  assert.equal(numberTranscript('  甲 \n\n 乙 '), '[L1] 甲 \n[L2]  乙', '跳过空行，但不逐行裁剪')
  assert.equal(numberTranscript('甲\n\n\n乙'), '[L1] 甲\n[L2] 乙')
  assert.deepEqual(transcriptLines('甲\n\n乙'), ['甲', '乙'])
})

test('findOutlineCoverageGaps reports leading, internal and trailing gaps', () => {
  assert.deepEqual(findOutlineCoverageGaps([{ lineRange: [1, 100] }], 100), [])
  assert.deepEqual(findOutlineCoverageGaps([], 50), [[1, 50]])
  assert.deepEqual(findOutlineCoverageGaps([{ lineRange: [10, 50] }], 50), [[1, 9]])
  assert.deepEqual(
    findOutlineCoverageGaps([{ lineRange: [1, 40] }, { lineRange: [51, 80] }], 100),
    [[41, 50], [81, 100]]
  )
  assert.deepEqual(findOutlineCoverageGaps([{ lineRange: [1, 100] }], 0), [], '未知行数时不猜缺口')
})

test('mergeAndCoverOutline sorts by line and fills gaps with explicit placeholders', () => {
  const { outline, fallbackGaps } = mergeAndCoverOutline(
    [{ id: 'b', title: '后半', lineRange: [51, 100] }, { id: 'a', title: '前半', lineRange: [1, 40] }],
    100
  )
  assert.deepEqual(fallbackGaps, [[41, 50]])
  // 兜底节点按行号插在原节点之间，而不是堆在末尾
  assert.deepEqual(outline.map(node => node.id), ['a', 'outline-coverage-41-50', 'b'])
  const filler = outline[1]
  assert.match(filler.title, /待确认内容（第 41—50 行）/)
  assert.deepEqual(filler.keySignals, ['coverage-repair'])
  assert.equal(findOutlineCoverageGaps(outline, 100).length, 0, '补齐后不应再有缺口')
})

test('validateOutline and validateMarkdown reject malformed model output', () => {
  assert.throws(() => validateOutline(null), /大纲生成结果格式无效/)
  assert.throws(() => validateOutline({ mainLine: 'x', outline: [] }), /格式无效/)
  assert.throws(() => validateOutline({ mainLine: 'x', outline: [{ title: 'a' }] }), /第 1 个节点格式无效/)
  assert.deepEqual(validateOutline({ mainLine: '主线', outline: [{ title: 'a', lineRange: [1, 2] }] }).mainLine, '主线')

  assert.throws(() => validateMarkdown({ markdown: '   ' }), /正文生成结果为空/)
  assert.equal(validateMarkdown({ markdown: '正文' }).markdown, '正文')
})

test('validateReview keeps the issue list and drops empty issues', () => {
  const review = validateReview({
    decision: 'approve',
    // 模型仍可能沿用旧格式回传分数：校验层不再解释它们，也不再因为量纲报错。
    coverage: 999,
    summary: ' 还行 ',
    issues: [{ severity: 'weird', message: '  ' }, { severity: 'blocking', message: ' 结论写反了 ' }]
  })
  assert.equal(review.summary, '还行')
  assert.equal(review.issues.length, 1, '空消息的问题被丢弃')
  assert.equal(review.issues[0].severity, 'blocking')
  assert.equal(review.issues[0].message, '结论写反了')
  assert.throws(() => validateReview({ decision: 'maybe' }), /审查结果无效/)
})

test('validateSpliceData accepts both naming conventions', () => {
  const camel = validateSpliceData({
    courseOverview: { coreQuestions: ['为什么'], shouldBeAbleTo: ['能区分'], lectureThread: '主线' },
    sectionSummaries: { o1: '总结' },
    knowledgeLink: { inheritsFrom: '上一课', laysGroundworkFor: [{ concept: 'x', use: 'y' }] }
  })
  assert.deepEqual(camel.courseOverview.coreQuestions, ['为什么'])
  assert.equal(camel.sectionSummaries.o1, '总结')

  const snake = validateSpliceData({
    course_overview: { core_questions: ['为什么'], should_be_able_to: ['能区分'], lecture_thread: '主线' },
    h1_summaries: { o1: '总结' },
    knowledge_link: { inherits_from: '上一课', lays_groundwork_for: ['x'] }
  })
  assert.deepEqual(snake.courseOverview.coreQuestions, ['为什么'])
  assert.equal(snake.sectionSummaries.o1, '总结')
  assert.equal(snake.knowledgeLink.inheritsFrom, '上一课')
  assert.throws(() => validateSpliceData([]), /接缝数据格式无效/)
})

test('the splice context never contains approved node prose', () => {
  const context = splicePlaceholderContext({
    title: '第10-12节',
    outline: [{ id: 'o1', title: '共犯' }, { id: 'o2', title: '罪数' }],
    nodes: [
      { id: 'o1-node-1', outlineNodeId: 'o1', title: '共犯 · 1/1', draft: '这一段是已审查通过的正文，绝不能被接缝模型改写' }
    ]
  })
  assert.match(context, /\{\{COURSE_OVERVIEW\}\}/)
  assert.match(context, /\{\{H1_SUMMARY:o1\}\}/)
  assert.match(context, /\{\{H1_QUIZ:o2\}\}/)
  assert.match(context, /第0–1|已批准节点：共犯 · 1\/1/)
  assert.ok(!context.includes('绝不能被接缝模型改写'), '接缝上下文不得包含节点正文')
})

test('executeCourseTask passes through the non-model steps', async () => {
  assert.equal(await executeCourseTask({ type: 'idle' }), null)
  assert.deepEqual(
    await executeCourseTask({ type: 'plan-nodes', lessonKey: 'L1', taskKey: 'k' }),
    { type: 'plan-nodes', lessonKey: 'L1', taskKey: 'k' }
  )
  assert.deepEqual(
    await executeCourseTask({ type: 'reconcile-final-review', lessonKey: 'L1', qualityReport: { decision: 'approve' } }),
    { type: 'complete-final-review', lessonKey: 'L1', qualityReport: { decision: 'approve' }, taskKey: undefined }
  )
})

test('generate-outline numbers the transcript and repairs coverage gaps', async () => {
  const lesson = { title: '第10-12节', transcript: transcript(100), pptText: [], supplements: [] }
  const { callModel, calls } = fakeModel([
    modelReply({ mainLine: '主线', outline: [{ title: '开头', lineRange: [1, 40] }] }),
    modelReply({ mainLine: '主线', outline: [{ title: '补：41-100', lineRange: [41, 100], rationale: '补缺口' }] })
  ])

  const action = await executeCourseTask(
    { type: 'generate-outline', lessonKey: 'L1', taskKey: 'k', lesson, courseSpec: { promptVersion: 'v-test' } },
    { callModel, modelConfig: { apiKey: 'sk' } }
  )

  assert.equal(action.type, 'save-outline')
  assert.equal(action.outline.length, 2)
  assert.equal(findOutlineCoverageGaps(action.outline, 100).length, 0, '修复后必须无缺口')
  assert.equal(action.trace.coverageRepair.initialGaps.length, 1)
  assert.equal(action.trace.coverageRepair.modelRepairNodeCount, 1)
  assert.deepEqual(calls.map(call => call.role), ['outline', 'outlineRepair'])
  assert.match(calls[0].prompt.user, /\[L100\] 第 100 行/, '大纲提示词里的转录必须带绝对行号')
})

test('a failing coverage repair still yields a complete outline via placeholders', async () => {
  const lesson = { title: 'T', transcript: transcript(100), pptText: [], supplements: [] }
  const { callModel } = fakeModel([
    modelReply({ mainLine: '主线', outline: [{ title: '开头', lineRange: [1, 40] }] }),
    new Error('模型不可用')
  ])

  const action = await executeCourseTask(
    { type: 'generate-outline', lessonKey: 'L1', lesson: { ...lesson }, courseSpec: {} },
    { callModel, modelConfig: {} }
  )
  assert.equal(findOutlineCoverageGaps(action.outline, 100).length, 0, '修复失败也必须补齐覆盖')
  assert.equal(action.trace.coverageRepair.modelRepairNodeCount, 0)
  assert.deepEqual(action.trace.coverageRepair.fallbackGaps, [[41, 100]])
  assert.match(action.outline.at(-1).title, /待确认内容/)
})

test('write-node and revise-node select the right role and stamp the base version', async () => {
  const node = {
    id: 'n1', title: '共犯', draft: '', versions: [{}], sourceText: '[L1] 材料', pptText: '',
    writerBrief: { currentNodeGoal: '讲清共犯', previousNodeSummary: '前面讲了什么', nextNodeTarget: '后面要讲什么' },
    revisionRequests: [{ value: { message: '补上法条依据' } }],
    reviewerReports: []
  }

  const write = fakeModel(modelReply({ markdown: '正文一' }))
  const writeAction = await executeCourseTask(
    { type: 'write-node', lessonKey: 'L1', node, taskKey: 'k' },
    { callModel: write.callModel, modelConfig: {} }
  )
  assert.equal(writeAction.type, 'save-node-draft-worker')
  assert.equal(writeAction.source, 'writer')
  assert.equal(writeAction.markdown, '正文一')
  assert.equal(writeAction.basedDraftVersion, 1, '必须记录基于哪一版起草')
  assert.equal(write.calls[0].role, 'writer')

  const revise = fakeModel(modelReply({ markdown: '正文二' }))
  const reviseAction = await executeCourseTask(
    { type: 'revise-node', lessonKey: 'L1', node, taskKey: 'k' },
    { callModel: revise.callModel, modelConfig: {} }
  )
  assert.equal(reviseAction.source, 'revision')
  assert.equal(revise.calls[0].role, 'revision')
  assert.match(revise.calls[0].prompt.user, /补上法条依据/, '修订提示词应带上修订要求')
})

test('review-node stamps the reviewed draft version', async () => {
  const node = {
    id: 'n1', title: '共犯', draft: '正文', versions: [{}, {}], sourceText: '[L1] 材料', pptText: '',
    writerBrief: {}, consistencyRequests: [], reviewerReports: []
  }
  const { callModel, calls } = fakeModel(modelReply({
    decision: 'revise',
    summary: '需要补充',
    issues: [{ severity: 'blocking', message: '缺少法条' }]
  }))

  const action = await executeCourseTask(
    { type: 'review-node', lessonKey: 'L1', node, taskKey: 'k' },
    { callModel, modelConfig: {} }
  )
  assert.equal(action.type, 'save-node-review')
  assert.equal(action.reviewerReport.decision, 'revise')
  assert.equal(action.reviewerReport.reviewedDraftVersion, 2, '必须记录审查的是第几版')
  assert.equal(calls[0].role, 'reviewer')
  assert.match(calls[0].prompt.user, /当前草稿|正文/, '审查提示词应包含当前草稿')
})

test('assemble asks the splicer only for seams and validates its shape', async () => {
  const lesson = {
    title: '第10-12节',
    blueprint: { mainLine: '主线' },
    outline: [{ id: 'o1', title: '共犯' }],
    nodes: [{
      id: 'o1-node-1', outlineNodeId: 'o1', title: '共犯 · 1/1', lineRange: [1, 40], versions: [{}],
      draft: '这段已审查通过的正文绝不能被接缝模型看到'
    }]
  }
  const { callModel, calls } = fakeModel(modelReply({
    courseOverview: { coreQuestions: ['为什么'], shouldBeAbleTo: ['能区分'], lectureThread: '主线' },
    sectionSummaries: { o1: '本章总结' },
    sectionQuizzes: { o1: ['自测题'] },
    knowledgeLink: { inheritsFrom: '上一课', laysGroundworkFor: [], nextLessonPreview: '下一课' },
    appendix: { terms: [] }
  }))

  const action = await executeCourseTask(
    { type: 'assemble', lessonKey: 'L1', lesson, taskKey: 'k' },
    { callModel, modelConfig: {} }
  )
  assert.equal(action.type, 'assemble')
  assert.equal(action.spliceData.sectionSummaries.o1, '本章总结')
  assert.equal(calls[0].role, 'splicer')
  assert.ok(!calls[0].prompt.user.includes('绝不能被接缝模型看到'), '接缝模型的输入里不应出现节点正文')
  assert.match(calls[0].prompt.user, /已批准节点：共犯 · 1\/1/)
})

test('final-review hands the assembled note and node index to the reviewer', async () => {
  const lesson = {
    title: '第10-12节',
    blueprint: { mainLine: '主线' },
    nodes: [{
      id: 'n1', title: '共犯', lineRange: [1, 40], versions: [{}], reviewDecision: 'approve',
      reviewerReports: [{ value: { decision: 'approve', summary: '通过', issues: [] } }]
    }],
    finalNote: { markdown: '# 拼装后的完整笔记' }
  }
  const { callModel, calls } = fakeModel(modelReply({
    decision: 'approve', summary: '整体可靠', issues: []
  }))

  const action = await executeCourseTask(
    { type: 'final-review', lessonKey: 'L1', lesson, taskKey: 'k' },
    { callModel, modelConfig: {} }
  )
  assert.equal(action.type, 'complete-final-review')
  assert.equal(action.qualityReport.decision, 'approve')
  assert.equal(calls[0].role, 'finalReview')
  assert.ok(calls[0].prompt.user.includes('拼装后的完整笔记'), '终审必须看到完整稿')
  assert.match(calls[0].prompt.user, /\[n1\] 共犯/)
})

test('revise-final-note carries the user request and existing note', async () => {
  const lesson = {
    title: 'T',
    finalNote: { markdown: '# 原稿' },
    finalRevisionRequests: [{ value: { message: '把第二段拆开' } }]
  }
  const { callModel, calls } = fakeModel(modelReply({ markdown: '# 新稿' }))
  const action = await executeCourseTask(
    { type: 'revise-final-note', lessonKey: 'L1', lesson, taskKey: 'k' },
    { callModel, modelConfig: {} }
  )
  assert.equal(action.type, 'save-final-note-revision')
  assert.equal(action.markdown, '# 新稿')
  assert.equal(calls[0].role, 'finalRevision')
  assert.match(calls[0].prompt.user, /把第二段拆开/)
})

test('an unsupported task type fails loudly', async () => {
  await assert.rejects(() => executeCourseTask({ type: 'dance' }, {}), /不支持的课程处理步骤：dance/)
})
