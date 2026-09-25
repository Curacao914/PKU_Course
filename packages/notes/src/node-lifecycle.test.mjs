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
  normalizedReviewDecision,
  planNodes,
  recordNodeTaskFailure,
  requestNodeRevision,
  saveNodeDraft,
  splitWriteUnit
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

test('the review decision only looks at blocking issues', () => {
  assert.equal(normalizedReviewDecision(approveReport(1)), 'approve')
  assert.equal(normalizedReviewDecision(reviseReport(1)), 'revise', 'blocking 问题必须重写这一段')
  assert.equal(
    normalizedReviewDecision(approveReport(1, { issues: [{ severity: 'suggestion', message: '措辞可更顺' }] })),
    'approve', '建议不触发重写'
  )
  assert.equal(
    normalizedReviewDecision(approveReport(1, { issues: [{ severity: 'important', message: '可补充' }] })),
    'approve', 'important 级问题只记录，不重写'
  )
  // 分数、decision 字段都不再影响判定：模型答 revise 却列不出 blocking 时不该白重写一轮。
  assert.equal(normalizedReviewDecision(approveReport(1, { coverage: 10, decision: 'revise' })), 'approve')
  assert.equal(normalizedReviewDecision({ ...approveReport(1), decision: 'human_review' }), 'approve')
})

test('normalizeReviewReport keeps issues and the reviewed version, without scores', () => {
  const report = normalizeReviewReport({
    decision: 'revise',
    summary: ' x ',
    issues: [{ severity: 'blocking', message: ' 结论写反了 ', nodeId: 'n1', sourceRange: 'L10-L20' }]
  }, 3)
  assert.equal(report.reviewedDraftVersion, 3)
  assert.equal(report.summary, 'x')
  assert.equal(report.issues[0].message, '结论写反了')
  assert.equal(report.issues[0].nodeId, 'n1')
  assert.equal(report.coverage, undefined, '不再生成评分为主的字段')
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

test('an approving review approves the node and records the report', () => {
  let current = lesson([node('n1'), node('n2', { status: 'node_review', draft: '下游正文', versions: [{}] })])
  current = saveNodeDraft(current, 'n1', '上游正文')
  const reviewed = applyNodeReview(current, 'n1', approveReport(1), {})

  assert.equal(reviewed.nodes[0].status, 'node_approved')
  assert.equal(reviewed.nodes[0].reviewDecision, 'approve')
  assert.equal(reviewed.nodes[0].reviewerReports.at(-1).value.summary, '整体可靠')
  assert.equal(reviewed.nodes[1].status, 'node_review', '下游节点状态只由它自己的审查决定')
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

test('node slices follow logical transcript lines, not physical ones', () => {
  // 转写稿每句话之间有一个空行：物理行数是逻辑行的两倍。
  // 大纲的 [Lx] 行号与 assertOutlineCoverage 都按逻辑行算，切片也必须按逻辑行，
  // 否则每个节点拿到的原文会整体偏移约一倍——这曾让模型以为"本节内容材料里没有"。
  const blankSeparated = Array.from({ length: 6 }, (_, index) => `[L${index + 1}] 第 ${index + 1} 句`).join('\n\n')
  const nodes = planNodes({
    lesson: { transcript: blankSeparated, pptText: [] },
    outline: [{ id: 'o1', title: '主题', lineRange: [3, 4], writerBrief: '目标' }],
    courseSpec: { nodeSplitThreshold: 100000, nodeSplitLineThreshold: 100000 }
  })

  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].sourceText, '[L3] 第 3 句\n[L4] 第 4 句', '切片必须落在逻辑行 3-4 上')
})

test('write units group modules without changing the module plan', () => {
  const lesson = { transcript: transcript(40), pptText: [] }
  const outline = [
    { id: 'o1', title: '共犯的成立', lineRange: [1, 13] },
    { id: 'o2', title: '共犯的形态', lineRange: [14, 26] },
    { id: 'o3', title: '罪数判断', lineRange: [27, 40] }
  ]
  const spec = { nodeSplitThreshold: 100000, nodeSplitLineThreshold: 100000 }

  const perModule = planNodes({ lesson, outline, courseSpec: spec })
  assert.equal(perModule.length, 3, '默认每个模块一个写作单元')

  const single = planNodes({ lesson, outline, courseSpec: { ...spec, writeUnits: 1 } })
  assert.equal(single.length, 1, '一次写完 = 一个写作单元')
  assert.deepEqual(single[0].outlineNodeIds, ['o1', 'o2', 'o3'], '模块结构不因为"写几次"而改变')
  assert.equal(single[0].moduleBriefs.length, 3)
  assert.match(single[0].writerBrief.writeContract, /### 模块标题/, '合并写作时必须按模块标题分段')
  assert.ok(single[0].sourceText.includes('第 1 行') && single[0].sourceText.includes('第 40 行'), '整节课的原文都在')
  assert.deepEqual(single[0].lineRange, [1, 40])

  const two = planNodes({ lesson, outline, courseSpec: { ...spec, writeUnits: 2 } })
  assert.equal(two.length, 2)
  assert.deepEqual(two.map(node => node.outlineNodeIds.length), [2, 1], '按顺序连续分组，不跳模块')
})

test('a multi-module write unit can be split so one module is rewritten alone', () => {
  // 「一次写完 8 个模块」省调用，但改一个模块不该重写整节：拆分后只让被点名的模块回到待修订。
  const lesson = {
    transcript: transcript(40),
    pptText: [],
    outline: [
      { id: 'o1', title: '共犯的成立', lineRange: [1, 20] },
      { id: 'o2', title: '罪数判断', lineRange: [21, 40] }
    ],
    nodes: [{
      id: 'u1',
      outlineNodeId: 'o1',
      outlineNodeIds: ['o1', 'o2'],
      moduleBriefs: [{ outlineNodeId: 'o1', title: '共犯的成立' }, { outlineNodeId: 'o2', title: '罪数判断' }],
      status: 'node_approved',
      draft: '### 共犯的成立\n\n共犯需要共同故意。\n\n### 罪数判断\n\n罪数按行为个数判断。',
      versions: [{}],
      reviewerReports: [{}],
      revisionCount: 0,
      revisionRequests: []
    }]
  }

  const split = splitWriteUnit(lesson, 'u1', { keepPending: ['o2'] })
  assert.equal(split.nodes.length, 2, '一个单元拆成两个模块节点')
  const [first, second] = split.nodes
  assert.equal(first.outlineNodeId, 'o1')
  assert.equal(second.outlineNodeId, 'o2')
  assert.equal(first.status, 'node_approved', '没被点名的模块原样放行')
  assert.match(first.approvalReason, /拆分自同一写作单元/)
  assert.equal(second.status, 'node_pending', '被点名的模块回到待处理，由调用方提出修订')
  assert.match(first.draft, /共犯需要共同故意/, '正文按模块正确切分')
  assert.match(second.draft, /罪数按行为个数判断/)
  assert.ok(first.sourceText.includes('第 1 行') && second.sourceText.includes('第 40 行'), '各模块拿到自己那段转录')
})

test('an unchanged revision still counts toward the revision cap', () => {
  let current = lesson([node('n1')])
  current = saveNodeDraft(current, 'n1', '第一版正文')
  const versions = current.nodes[0].versions.length
  current = saveNodeDraft(current, 'n1', '第一版正文', { source: 'revision' })

  assert.equal(current.nodes[0].revisionCount, 1, '原样返回也算完成了一次修订尝试')
  assert.equal(current.nodes[0].versions.length, versions, '内容没变就不追加版本')
})

test('a node review no longer blocks or re-reviews later nodes', () => {
  // 旧实现会让上游的 blocking 问题阻塞下游、并在上游修好后让下游重审一次。
  // 那是反复确认那一类开销，跨节点一致性现在交给终审一次性检查。
  let current = lesson([
    node('n1'),
    node('n2', { status: 'node_approved', draft: '下游正文', versions: [{}] }),
    node('n3', { status: 'node_pending' })
  ])
  current = saveNodeDraft(current, 'n1', '上游正文')
  const reviewed = applyNodeReview(current, 'n1', reviseReport(1), {})

  assert.equal(reviewed.nodes[0].status, 'node_revision_required')
  assert.equal(reviewed.nodes[1].status, 'node_approved', '下游已通过的节点不受上游问题影响')
  assert.notEqual(reviewed.nodes[1].reviewRequired, true, '不再产生"上游改了下游要重审"的额外审查')
  assert.equal(reviewed.nodes[2].status, 'node_pending')
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

test('human approval demands a reason', () => {
  let current = lesson([node('n1'), node('n2', { status: 'node_review', draft: '下游', versions: [{}] })])
  current = saveNodeDraft(current, 'n1', '正文')
  assert.throws(() => approveNodeHuman(current, 'n1', '  ', {}), /必须说明理由/)

  const done = approveNodeHuman(current, 'n1', '转录缺失该段，人工确认放行', {})
  assert.equal(done.nodes[0].status, 'node_approved')
  assert.equal(done.nodes[0].approvalReason, '转录缺失该段，人工确认放行')
  assert.equal(done.nodes[1].status, 'node_review')
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
