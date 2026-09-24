import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_COURSE_SPEC,
  applyNodeReview,
  approveNode,
  approveNodeHuman,
  assertOutlineCoverage,
  deriveLessonStatus,
  normalizeReviewReport,
  normalizeReviewScores,
  normalizedReviewDecision,
  planNodes,
  recordNodeTaskFailure,
  requestNodeRevision,
  saveNodeDraft,
  scoresMeetThreshold
} from './node-lifecycle.mjs'

const node = (id, over = {}) => ({
  id,
  title: id,
  status: 'node_pending',
  draft: '',
  versions: [],
  reviewerReports: [],
  revisionRequests: [],
  revisionCount: 0,
  blockedByNodeIds: [],
  taskFailures: { writer: 0, reviewer: 0, revision: 0 },
  ...over
})

const lesson = (nodes) => ({ key: 'lesson-1', nodes, status: 'node_pending' })

const approveReport = (version, over = {}) => ({
  decision: 'approve',
  coverage: 90, grounding: 90, logic: 90, detail: 90, sourceCoverage: 90,
  reviewedDraftVersion: version,
  issues: [],
  summary: '整体可靠',
  ...over
})

const reviseReport = (version, over = {}) => ({
  decision: 'revise',
  coverage: 90, grounding: 90, logic: 90, detail: 90, sourceCoverage: 90,
  reviewedDraftVersion: version,
  issues: [{ severity: 'blocking', message: '第二段把教师观点写反了' }],
  summary: '需要修正',
  ...over
})

const transcript = (lines) => Array.from({ length: lines }, (_, i) => `[L${i + 1}] 第 ${i + 1} 行`).join('\n')

test('assertOutlineCoverage enforces full, gapless coverage', () => {
  const outline = [
    { id: 'o1', lineRange: [1, 40] },
    { id: 'o2', lineRange: [41, 100] }
  ]
  assert.equal(assertOutlineCoverage(outline, 100), outline)

  assert.throws(() => assertOutlineCoverage([], 100), /大纲为空/)
  assert.throws(() => assertOutlineCoverage([{ id: 'o1', lineRange: [2, 100] }], 100), /必须从转录第 1 行开始/)
  assert.throws(
    () => assertOutlineCoverage([{ id: 'o1', lineRange: [1, 40] }, { id: 'o2', lineRange: [51, 100] }], 100),
    /遗漏了转录第 41-50 行/
  )
  assert.throws(
    () => assertOutlineCoverage([{ id: 'o1', lineRange: [1, 80] }], 100),
    /遗漏了转录第 81-100 行/
  )
  assert.throws(() => assertOutlineCoverage([{ id: 'o1', lineRange: [1, 200] }], 100), /超出转录/)
  assert.throws(() => assertOutlineCoverage([{ id: 'o1' }], 100), /缺少 lineRange/)
})

test('planNodes keeps a small outline node whole and slices its sources', () => {
  const plan = planNodes({
    lesson: { transcript: transcript(50), pptText: [] },
    outline: [{ id: 'o1', title: '绪论', lineRange: [1, 50], slideRange: [1, 3], concepts: ['刑法'] }],
    courseSpec: {}
  })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].id, 'o1-node-1')
  assert.equal(plan[0].title, '绪论')
  assert.equal(plan[0].status, 'node_pending')
  assert.match(plan[0].sourceText, /^\[L1\] 第 1 行/)
  assert.match(plan[0].sourceText, /\[L50\] 第 50 行$/)
  assert.deepEqual(plan[0].concepts, ['刑法'])
})

test('planNodes splits oversized nodes deterministically and without gaps', () => {
  const outline = [{ id: 'o1', title: '长章节', lineRange: [1, 1000], slideRange: [1, 2] }]
  const spec = { nodeSplitLineThreshold: 200, nodeSplitThreshold: 12_000 }
  const parts = planNodes({ lesson: { transcript: transcript(1000) }, outline, courseSpec: spec })

  assert.equal(parts.length, 5, '1000 行 / 200 行阈值 = 5 份')
  assert.deepEqual(parts.map(p => p.lineRange), [
    [1, 200], [201, 400], [401, 600], [601, 800], [801, 1000]
  ])
  assert.deepEqual(parts.map(p => p.title), [
    '长章节 · 1/5', '长章节 · 2/5', '长章节 · 3/5', '长章节 · 4/5', '长章节 · 5/5'
  ])
  assert.ok(parts.every(p => p.splitFrom === 'o1'))

  // 确定性：同样输入必须切出完全一样的边界
  assert.deepEqual(
    planNodes({ lesson: { transcript: transcript(1000) }, outline, courseSpec: spec }).map(p => p.lineRange),
    parts.map(p => p.lineRange)
  )

  // 拼接后覆盖原范围且不重叠
  const ranges = parts.map(p => p.lineRange)
  assert.equal(ranges[0][0], 1)
  assert.equal(ranges.at(-1)[1], 1000)
  ranges.slice(1).forEach((range, index) => assert.equal(range[0], ranges[index][1] + 1))
})

test('planNodes also splits on the character threshold', () => {
  const long = Array.from({ length: 40 }, (_, i) => `[L${i + 1}] ${'字'.repeat(500)}`).join('\n')
  const parts = planNodes({
    lesson: { transcript: long },
    outline: [{ id: 'o1', title: 'T', lineRange: [1, 40] }],
    courseSpec: { nodeSplitThreshold: 5000, nodeSplitLineThreshold: 10_000 }
  })
  assert.ok(parts.length > 1, '字符数超过阈值也应切分')
  assert.equal(parts[0].lineRange[0], 1)
  assert.equal(parts.at(-1).lineRange[1], 40)
})

test('planNodes attaches slide text for the node slide range', () => {
  const plan = planNodes({
    lesson: {
      transcript: transcript(10),
      pptText: [{ slides: [{ slideNumber: 1, text: '第一页' }, { slideNumber: 2, text: '第二页' }, { slideNumber: 9, text: '第九页' }] }]
    },
    outline: [{ id: 'o1', title: 'T', lineRange: [1, 10], slideRange: [1, 2] }],
    courseSpec: {}
  })
  assert.match(plan[0].pptText, /第 1 页\n第一页/)
  assert.match(plan[0].pptText, /第 2 页\n第二页/)
  assert.ok(!plan[0].pptText.includes('第九页'))
})

test('deriveLessonStatus follows the original precedence', () => {
  assert.equal(deriveLessonStatus([]), 'node_pending')
  assert.equal(deriveLessonStatus([node('a', { status: 'node_approved' })]), 'assembly_pending')
  assert.equal(deriveLessonStatus([node('a', { status: 'node_approved' }), node('b', { status: 'node_revision_required' })]), 'node_revision_required')
  assert.equal(deriveLessonStatus([node('a', { status: 'node_review' }), node('b', { status: 'node_pending' })]), 'node_pending')
  assert.equal(deriveLessonStatus([node('a', { status: 'node_review' })]), 'node_review')
  assert.equal(deriveLessonStatus([node('a', { status: 'node_failed' })]), 'node_human_review')
})

test('review scores normalize from both scales and reject nonsense', () => {
  assert.deepEqual(
    normalizeReviewScores({ coverage: 8, grounding: 9, logic: 7, detail: 8, sourceCoverage: 9 }),
    { coverage: 80, grounding: 90, logic: 70, detail: 80, sourceCoverage: 90 },
    '五项都在 0—10 时按十分制放大'
  )
  assert.deepEqual(
    normalizeReviewScores({ coverage: 80, grounding: 55, logic: 700 / 10, detail: 100, sourceCoverage: 60 }),
    { coverage: 80, grounding: 55, logic: 70, detail: 100, sourceCoverage: 60 },
    '出现大于 10 的分值时按百分制处理'
  )
  assert.throws(() => normalizeReviewScores({ coverage: 120, grounding: 1, logic: 1, detail: 1, sourceCoverage: 1 }), /审查分数 coverage 无效/)
  assert.throws(() => normalizeReviewScores({ coverage: -1, grounding: 1, logic: 1, detail: 1, sourceCoverage: 1 }), /无效/)
})

test('the pass floor is the threshold minus 20, not the threshold itself', () => {
  const borderline = { coverage: 55, grounding: 55, logic: 55, detail: 55, sourceCoverage: 55 }
  assert.equal(scoresMeetThreshold(borderline, 75), true, '75 - 20 = 55 是下限')
  assert.equal(scoresMeetThreshold({ ...borderline, detail: 54 }, 75), false)
  assert.equal(scoresMeetThreshold({ ...borderline, detail: 45 }, 60), true, '下限不低于 45')
  assert.equal(scoresMeetThreshold({ coverage: 0, grounding: 90, logic: 90, detail: 90, sourceCoverage: 90 }, 75), false)
})

test('the review decision prioritises content problems over scores', () => {
  assert.equal(normalizedReviewDecision(approveReport(1), 75), 'approve')
  assert.equal(normalizedReviewDecision(reviseReport(1), 75), 'revise', 'blocking 问题必须修订')
  assert.equal(
    normalizedReviewDecision(approveReport(1, { issues: [{ severity: 'suggestion', message: '措辞可更顺' }] }), 75),
    'approve', 'suggestion 不应触发重写'
  )
  assert.equal(
    normalizedReviewDecision(approveReport(1, { issues: [{ severity: 'important', message: '可补充', requiresHuman: true }] }), 75),
    'revise', '需人工判断的问题同样必须先修订'
  )
  assert.equal(
    normalizedReviewDecision({ ...approveReport(1), decision: 'human_review' }, 75),
    'revise'
  )
  assert.equal(
    normalizedReviewDecision(approveReport(1, { coverage: 50 }), 75),
    'revise', '分数低于下限也要修订'
  )
})

test('normalizeReviewReport defaults an unspecified decision to human_review', () => {
  const report = normalizeReviewReport({ coverage: 8, grounding: 8, logic: 8, detail: 8, sourceCoverage: 8, summary: ' x ' }, 3)
  assert.equal(report.decision, 'human_review', '模型没给明确结论时应交给人，而不是默认放行')
  assert.equal(report.coverage, 80)
  assert.equal(report.reviewedDraftVersion, 3)
  assert.equal(report.summary, 'x')
})

test('a review for a different draft version does not produce a decision', () => {
  let current = lesson([node('n1')])
  current = saveNodeDraft(current, 'n1', '第一版正文')
  current = saveNodeDraft(current, 'n1', '第二版正文', { source: 'revision' })
  // 报告声明审查的是第 1 版，而当前已是第 2 版
  const stale = applyNodeReview(current, 'n1', approveReport(1), {})
  const target = stale.nodes[0]
  assert.equal(target.status, 'node_review')
  assert.equal(target.reviewDecision, null)
  assert.equal(target.reviewRequired, true, '版本对不上时应重新标记为待审查')
  assert.equal(target.reviewerReports.length, 0)
})

test('an approving review approves the node and releases its downstream blocks', () => {
  let current = lesson([node('n1'), node('n2', { status: 'node_review', draft: '下游正文', blockedByNodeIds: ['n1'], versions: [{}] })])
  current = saveNodeDraft(current, 'n1', '上游正文')
  const reviewed = applyNodeReview(current, 'n1', approveReport(1), {})

  assert.equal(reviewed.nodes[0].status, 'node_approved')
  assert.equal(reviewed.nodes[0].reviewDecision, 'approve')
  assert.equal(reviewed.nodes[0].reviewerReports.at(-1).value.coverage, 90)
  const downstream = reviewed.nodes[1]
  assert.deepEqual(downstream.blockedByNodeIds, [], '上游通过后应解除阻塞')
  assert.equal(downstream.reviewRequired, true, '被阻塞期间内容可能过时，需重新检查一致性')
})

test('a revising review requests a revision and keeps the node out of approval', () => {
  let current = lesson([node('n1')])
  current = saveNodeDraft(current, 'n1', '第一版正文')
  const reviewed = applyNodeReview(current, 'n1', reviseReport(1), {})

  const target = reviewed.nodes[0]
  assert.equal(target.status, 'node_revision_required')
  assert.equal(target.reviewDecision, 'revise')
  assert.match(target.revisionRequests.at(-1).value.message, /把教师观点写反了/)
  assert.equal(reviewed.status, 'node_revision_required')
})

test('exhausted auto revisions let a node through with warnings instead of stalling', () => {
  let current = lesson([node('n1', { revisionCount: DEFAULT_COURSE_SPEC.maxAutoRevisions })])
  current = saveNodeDraft(current, 'n1', '第三版正文')
  const reviewed = applyNodeReview(current, 'n1', reviseReport(1), {})

  const target = reviewed.nodes[0]
  assert.equal(target.status, 'node_approved', '修订次数用尽后带警告放行')
  assert.equal(target.autoAcceptedWithWarnings, true)
  assert.equal(target.reviewerReports.at(-1).value.autoRevisionExhausted, true)
})

test('downstream-impacting problems block later nodes and record why', () => {
  let current = lesson([
    node('n1'),
    node('n2', { status: 'node_approved', draft: '下游正文', versions: [{}] }),
    node('n3', { status: 'node_pending' })
  ])
  current = saveNodeDraft(current, 'n1', '上游正文')
  const reviewed = applyNodeReview(current, 'n1', reviseReport(1, {
    issues: [{ severity: 'blocking', message: '结论写反了', impact: 'downstream' }]
  }), {})

  const later = reviewed.nodes[1]
  assert.deepEqual(later.blockedByNodeIds, ['n1'])
  assert.equal(later.status, 'node_review', '已有正文的下游节点要重新检查一致性')
  assert.equal(later.approvedAt, null)
  assert.match(later.consistencyRequests.at(-1).message, /上游节点存在可能影响后文的实质问题/)
  assert.equal(reviewed.nodes[2].status, 'node_pending', '没有正文的下游节点保持等待')

  const localOnly = applyNodeReview(current, 'n1', reviseReport(1), {})
  assert.deepEqual(localOnly.nodes[1].blockedByNodeIds, [], '仅本地影响的问题不应阻塞后文')
})

test('saveNodeDraft versions only real changes and tracks revision attempts per lane', () => {
  let current = lesson([node('n1')])
  current = saveNodeDraft(current, 'n1', '第一版', { source: 'writer' })
  assert.equal(current.nodes[0].versions.length, 1)
  assert.equal(current.nodes[0].revisionCount, 0)

  current = saveNodeDraft(current, 'n1', '第一版', { source: 'writer' })
  assert.equal(current.nodes[0].versions.length, 1, '内容未变不应产生新版本')

  current = saveNodeDraft(current, 'n1', '第二版', { source: 'revision' })
  assert.equal(current.nodes[0].versions.length, 2)
  assert.equal(current.nodes[0].revisionCount, 1)
  assert.equal(current.nodes[0].version || current.nodes[0].versions.at(-1).version, 2)

  assert.throws(() => saveNodeDraft(current, 'n1', '   ', {}), /节点正文不能为空/)
  assert.throws(() => saveNodeDraft(current, 'missing', '正文', {}), /节点不存在/)
})

test('the manual flag and lane failure counters behave per source', () => {
  let current = lesson([node('n1', {
    draft: '第一版',
    versions: [{ version: 1 }],
    manualRevisionRequested: true,
    taskFailures: { writer: 2, reviewer: 0, revision: 3 }
  })])
  current = saveNodeDraft(current, 'n1', '第一版改', { source: 'revision' })
  assert.equal(current.nodes[0].manualRevisionRequested, false, '修订完成后清除人工修订标记')
  assert.equal(current.nodes[0].taskFailures.revision, 0, '修订通道的失败计数清零')
  assert.equal(current.nodes[0].taskFailures.writer, 2, '其它通道的失败计数不受影响')

  // 写作来源只清写作通道，且不改动人工修订标记
  let manual = lesson([node('n1', { manualRevisionRequested: true, taskFailures: { writer: 2, reviewer: 1, revision: 3 } })])
  manual = saveNodeDraft(manual, 'n1', '新的写作稿', { source: 'writer' })
  assert.equal(manual.nodes[0].manualRevisionRequested, true)
  assert.equal(manual.nodes[0].taskFailures.writer, 0)
  assert.equal(manual.nodes[0].taskFailures.reviewer, 1)
})

test('approveNode refuses to approve without a passing, current review', () => {
  let current = lesson([node('n1')])
  current = saveNodeDraft(current, 'n1', '正文')
  assert.throws(() => approveNode(current, 'n1', {}), /必须先通过审查才能放行/)

  const revised = applyNodeReview(current, 'n1', reviseReport(1), {})
  assert.throws(() => approveNode(revised, 'n1', {}), /审查未通过/)

  const approved = applyNodeReview(current, 'n1', approveReport(1), {})
  const done = approveNode(approved, 'n1', {})
  assert.equal(done.nodes[0].status, 'node_approved')
  assert.equal(done.status, 'assembly_pending')
})

test('human approval demands a reason and release downstream work', () => {
  let current = lesson([node('n1'), node('n2', { status: 'node_review', draft: '下游', blockedByNodeIds: ['n1'], versions: [{}] })])
  current = saveNodeDraft(current, 'n1', '正文')
  assert.throws(() => approveNodeHuman(current, 'n1', '  ', {}), /必须说明理由/)

  const done = approveNodeHuman(current, 'n1', '转录缺失该段，人工确认放行', {})
  assert.equal(done.nodes[0].status, 'node_approved')
  assert.equal(done.nodes[0].approvalReason, '转录缺失该段，人工确认放行')
  assert.deepEqual(done.nodes[1].blockedByNodeIds, [])
})

test('requestNodeRevision needs a message and marks the node manual', () => {
  const current = lesson([node('n1', { draft: '正文', versions: [{}], status: 'node_review' })])
  assert.throws(() => requestNodeRevision(current, 'n1', '   ', {}), /修订要求不能为空/)
  const next = requestNodeRevision(current, 'n1', '把第一段的结论补上来源', {})
  assert.equal(next.nodes[0].status, 'node_revision_required')
  assert.equal(next.nodes[0].manualRevisionRequested, true)
  assert.match(next.nodes[0].revisionRequests.at(-1).value.message, /补上来源/)
})

test('technical failures are counted per lane without touching content state', () => {
  const current = lesson([node('n1', { status: 'node_review', draft: '正文', versions: [{}] })])
  const next = recordNodeTaskFailure(current, 'n1', { taskType: 'reviewer', error: 'ECONNRESET', retryable: true })
  assert.equal(next.nodes[0].taskFailures.reviewer, 1)
  assert.equal(next.nodes[0].status, 'node_review', '技术失败不应改动内容状态')
  assert.equal(next.nodes[0].taskError.message, 'ECONNRESET')
  assert.equal(next.nodes[0].taskError.retryable, true)
})
