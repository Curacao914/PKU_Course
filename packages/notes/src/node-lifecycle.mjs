import { cleanText } from '@course/core'

/**
 * 节点生命周期：从大纲切分节点，到每个节点通过审查。
 *
 * 从 my-blog-main 的 lib/course/workflowState.js（1244 行）摘出真正决定质量的
 * 四件事，做成不可变的纯函数：大纲覆盖校验、超长节点确定性切分、审查判定、
 * 节点状态迁移与下游阻塞传播。原文件里与之混在一起的是面向 Web 工作台的
 * 步骤条、进度百分比与人工审批门禁，那些属于界面，不属于流水线。
 *
 * 语义与原实现保持一致，包括几处不容易看出来的规则：
 *   - 分数下限是 max(45, 阈值 - 20)，不是阈值本身；
 *   - 审查报告必须对应当前草稿版本，否则视为未审查；
 *   - 自动修订次数用尽后是"带警告放行"，而不是永久卡住；
 *   - 只有 blocking 或需人工且 impact=downstream 的问题才阻塞后文节点。
 */

export const REVIEW_SCORE_KEYS = ['coverage', 'grounding', 'logic', 'detail', 'sourceCoverage']

export const DEFAULT_COURSE_SPEC = Object.freeze({
  nodeSplitThreshold: 12_000,
  nodeSplitLineThreshold: 200,
  qualityThreshold: 75,
  maxAutoRevisions: 2,
  maxFinalAutoRevisions: 1,
  maxTechnicalRetries: 2,
  reviewConcurrency: 2,
  promptVersion: 'course-controlled-v4-pipeline'
})

const VERSION_CAP = 20

function nowIso(at) {
  return (at instanceof Date ? at : new Date(at ?? Date.now())).toISOString()
}

/** 版本数组封顶，避免无限增长（原实现保留最近 20 版）。 */
function versioned(value, previous = [], metadata = {}, at) {
  return [...(previous || []).slice(-(VERSION_CAP - 1)), {
    version: (previous || []).length + 1,
    at: nowIso(at),
    value,
    ...metadata
  }]
}

/**
 * 审查分数的量纲归一化：五项都在 0—10 之间时视为十分制并放大到百分制。
 * 模型经常给十分制，旧实现在执行器里做这件事；这里收进生命周期内，
 * 保证判定逻辑不会因为量纲而误判。
 */
export function normalizeReviewScores(value = {}) {
  const scores = REVIEW_SCORE_KEYS.map(key => Number(value[key]))
  const tenPoint = scores.every(score => Number.isFinite(score) && score >= 0 && score <= 10)
  REVIEW_SCORE_KEYS.forEach((key, index) => {
    const score = scores[index]
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`审查分数 ${key} 无效`)
    value[key] = Math.round(tenPoint ? score * 10 : score)
  })
  return value
}

export function scoresMeetThreshold(report = {}, threshold = DEFAULT_COURSE_SPEC.qualityThreshold) {
  const floor = Math.max(45, Number(threshold || DEFAULT_COURSE_SPEC.qualityThreshold) - 20)
  return REVIEW_SCORE_KEYS.every(key => Number(report[key] || 0) >= floor)
}

export function normalizeIssue(issue, index = 0) {
  if (typeof issue === 'string') {
    return {
      id: `issue-${index + 1}`,
      type: 'review_note',
      severity: 'important',
      message: cleanText(issue),
      impact: 'local',
      requiresHuman: false
    }
  }
  const rawSeverity = cleanText(issue?.severity || '').toLowerCase()
  const severity = ['blocking', 'high'].includes(rawSeverity) ? 'blocking'
    : ['suggestion', 'low'].includes(rawSeverity) ? 'suggestion' : 'important'
  return {
    ...issue,
    id: issue?.id || `issue-${index + 1}`,
    type: cleanText(issue?.type || 'review_note'),
    severity,
    message: cleanText(issue?.message || issue?.detail || issue?.type || ''),
    impact: issue?.impact === 'downstream' ? 'downstream' : 'local',
    requiresHuman: Boolean(issue?.requiresHuman)
  }
}

export function normalizeReviewReport(report = {}, draftVersion = 0, at) {
  const requestedDecision = ['approve', 'revise', 'human_review'].includes(report.decision)
    ? report.decision
    : 'human_review'
  const issues = (Array.isArray(report.issues) ? report.issues : [])
    .map(normalizeIssue)
    .filter(issue => issue.message)
  return {
    ...report,
    ...normalizeReviewScores({
      coverage: Number(report.coverage ?? 0),
      grounding: Number(report.grounding ?? 0),
      logic: Number(report.logic ?? 0),
      detail: Number(report.detail ?? 0),
      sourceCoverage: Number(report.sourceCoverage ?? 0)
    }),
    summary: cleanText(report.summary || ''),
    issues,
    requestedDecision,
    decision: requestedDecision,
    // 注意：报告未给出 reviewedDraftVersion（或给 0）时按"审查的就是当前草稿"处理。
    // 沿用原实现语义——模型常常不回填版本号，若严格要求就会把有效审查误判为过期。
    // 代价是显式传 0 也会被当成当前版本；草稿版本从 1 起，因此 0 只可能表示"未提供"。
    reviewedDraftVersion: Number(report.reviewedDraftVersion || draftVersion),
    checkedAt: report.checkedAt || nowIso(at)
  }
}

const blockingIssues = report => (report.issues || []).filter(issue => issue.severity === 'blocking')
const humanIssues = report => (report.issues || []).filter(issue => issue.requiresHuman)
const issuesAffectDownstream = report =>
  (report.issues || []).some(issue => (issue.severity === 'blocking' || issue.requiresHuman) && issue.impact === 'downstream')

export function normalizedReviewDecision(report = {}, threshold = DEFAULT_COURSE_SPEC.qualityThreshold) {
  const contentNeedsWork =
    report.requestedDecision === 'human_review' ||
    report.decision === 'human_review' ||
    humanIssues(report).length > 0 ||
    blockingIssues(report).length > 0
  if (contentNeedsWork) return 'revise'
  if (!scoresMeetThreshold(report, threshold)) return 'revise'
  return 'approve'
}

// ---------------------------------------------------------------- 大纲与切分

/**
 * 大纲必须连续覆盖整段转录：从第 1 行开始、不留缺口、不留尾巴。
 * 这是"笔记不能漏讲"的硬约束，因此宁可报错也不要静默接受。
 */
export function assertOutlineCoverage(outline = [], lineCount) {
  if (!outline.length) throw new Error('大纲为空')
  const total = Number(lineCount || 0)
  const ranges = outline.map((node, index) => {
    const range = Array.isArray(node.lineRange) ? node.lineRange : null
    if (!range || range.length < 2) throw new Error(`大纲节点 ${index + 1} 缺少 lineRange`)
    const [start, end] = range.map(Number)
    if (start < 1 || end < start || (total && end > total)) {
      throw new Error(`大纲节点 ${index + 1} 的行范围超出转录`)
    }
    return [start, end]
  })

  if (ranges[0][0] !== 1) throw new Error('大纲必须从转录第 1 行开始')
  let coveredUntil = 0
  ranges.forEach(([start, end]) => {
    if (start > coveredUntil + 1) {
      throw new Error(`大纲遗漏了转录第 ${coveredUntil + 1}-${start - 1} 行`)
    }
    coveredUntil = Math.max(coveredUntil, end)
  })
  if (total && coveredUntil < total) {
    throw new Error(`大纲遗漏了转录第 ${coveredUntil + 1}-${total} 行`)
  }
  return outline
}

function linesForRange(transcript, range = []) {
  const [start = 1, end = start] = range
  return cleanText(transcript)
    .split('\n')
    .slice(Math.max(0, Number(start) - 1), Math.max(Number(start), Number(end)))
    .join('\n')
}

function pptForRange(pptText = [], range = []) {
  const [start = 1, end = start] = range
  return (pptText || [])
    .flatMap(deck => deck.slides?.length ? deck.slides : [{ slideNumber: 1, text: deck.markdown }])
    .filter(slide => Number(slide.slideNumber || 1) >= Number(start) && Number(slide.slideNumber || 1) <= Number(end))
    .map(slide => `第 ${slide.slideNumber || 1} 页\n${slide.text || ''}`)
    .join('\n\n')
}

export function createNodeFromOutline({ outlineNode, partIndex = 0, partCount = 1, lesson = {}, courseSpec = {}, at } = {}) {
  const suffix = partCount > 1 ? ` · ${partIndex + 1}/${partCount}` : ''
  const [rangeStart, rangeEnd] = outlineNode.lineRange
  const lineSpan = rangeEnd - rangeStart + 1
  const partStart = rangeStart + Math.floor((lineSpan * partIndex) / partCount)
  const partEnd = partIndex === partCount - 1
    ? rangeEnd
    : rangeStart + Math.floor((lineSpan * (partIndex + 1)) / partCount) - 1
  const safeEnd = Math.max(partStart, partEnd)

  return {
    id: `${outlineNode.id}-node-${partIndex + 1}`,
    outlineNodeId: outlineNode.id,
    title: `${outlineNode.title}${suffix}`,
    status: 'node_pending',
    lineRange: [partStart, safeEnd],
    slideRange: outlineNode.slideRange,
    importance: outlineNode.importance,
    concepts: outlineNode.concepts || [],
    statutes: outlineNode.statutes || [],
    cases: outlineNode.cases || [],
    writerBrief: {
      courseSpec,
      lessonBlueprintSummary: lesson.blueprint?.mainLine || '',
      currentNodeGoal: outlineNode.writerBrief || outlineNode.rationale || '',
      previousNodeSummary: '',
      nextNodeTarget: '',
      coverageTable: lesson.blueprint?.coverageTable || []
    },
    sourceText: linesForRange(lesson.transcript, [partStart, safeEnd]),
    pptText: pptForRange(lesson.pptText, outlineNode.slideRange),
    draft: '',
    versions: [],
    reviewerReports: [],
    revisionRequests: [],
    revisionCount: 0,
    reviewRequired: false,
    reviewDecision: null,
    stale: false,
    splitFrom: partCount > 1 ? outlineNode.id : null,
    taskFailures: { writer: 0, reviewer: 0, revision: 0 },
    taskError: null,
    humanReviewRequired: false,
    manualRevisionRequested: false,
    blockedByNodeIds: [],
    blocksDownstream: false,
    consistencyRequests: [],
    createdAt: nowIso(at),
    updatedAt: nowIso(at)
  }
}

/**
 * 把大纲节点切成可写节点。
 *
 * 切分是确定性的：按字符数与行数双阈值算出份数，再按行均分，
 * 因此同一份大纲每次切出的边界完全一致——这是断点续跑的前提。
 */
export function planNodes({ lesson = {}, outline = [], courseSpec = {}, at } = {}) {
  const spec = { ...DEFAULT_COURSE_SPEC, ...courseSpec }
  const charThreshold = Math.max(500, Number(spec.nodeSplitThreshold))
  const lineThreshold = Math.max(20, Number(spec.nodeSplitLineThreshold))

  return outline.flatMap(outlineNode => {
    const source = linesForRange(lesson.transcript, outlineNode.lineRange)
    const lineSpan = outlineNode.lineRange[1] - outlineNode.lineRange[0] + 1
    const partCount = Math.max(1, Math.ceil(source.length / charThreshold), Math.ceil(lineSpan / lineThreshold))
    return Array.from({ length: partCount }, (_, partIndex) =>
      createNodeFromOutline({ outlineNode, partIndex, partCount, lesson, courseSpec: spec, at })
    )
  })
}

/** 课次状态由节点状态推导，优先级与原实现一致。 */
export function deriveLessonStatus(nodes = []) {
  if (!nodes.length) return 'node_pending'
  if (nodes.every(node => node.status === 'node_approved')) return 'assembly_pending'
  if (nodes.some(node => node.status === 'node_revision_required')) return 'node_revision_required'
  if (nodes.some(node => node.status === 'node_pending')) return 'node_pending'
  if (nodes.some(node => node.status === 'node_review')) return 'node_review'
  if (nodes.some(node => ['node_human_review', 'node_failed'].includes(node.status))) return 'node_human_review'
  return 'node_review'
}

// ---------------------------------------------------------------- 节点迁移

function updateNode(lesson, nodeId, updater) {
  let found = false
  const nodes = (lesson.nodes || []).map(node => {
    if (node.id !== nodeId) return node
    found = true
    return updater(node)
  })
  if (!found) throw new Error(`节点不存在：${nodeId}`)
  return { ...lesson, nodes, status: deriveLessonStatus(nodes), updatedAt: nowIso() }
}

/** 上游节点通过后，解除它对后文的阻塞。 */
function releaseDownstreamBlocks(nodes, sourceNodeId, at) {
  return nodes.map(node => {
    const blockers = (node.blockedByNodeIds || []).filter(id => id !== sourceNodeId)
    if (blockers.length === (node.blockedByNodeIds || []).length) return node
    return {
      ...node,
      blockedByNodeIds: blockers,
      status: blockers.length || !node.draft ? node.status : 'node_review',
      reviewRequired: blockers.length ? node.reviewRequired : true,
      reviewDecision: blockers.length ? node.reviewDecision : null,
      updatedAt: nowIso(at)
    }
  })
}

/**
 * 保存草稿。草稿有实际变化才追加版本；修订来源会累加修订次数并清空该通道的失败计数。
 */
export function saveNodeDraft(lesson, nodeId, markdown, { source = 'writer', trace = null, at } = {}) {
  const draft = cleanText(markdown)
  if (!draft) throw new Error('节点正文不能为空')
  return updateNode(lesson, nodeId, node => {
    const changed = draft !== node.draft
    return {
      ...node,
      status: 'node_review',
      draft,
      versions: changed ? versioned(draft, node.versions, { source, trace }, at) : node.versions,
      reviewRequired: changed || !node.reviewerReports?.length,
      reviewDecision: changed ? null : node.reviewDecision,
      revisionCount: source === 'revision' && changed
        ? Number(node.revisionCount || 0) + 1
        : Number(node.revisionCount || 0),
      taskFailures: source === 'revision'
        ? { ...(node.taskFailures || {}), revision: 0 }
        : source === 'writer' ? { ...(node.taskFailures || {}), writer: 0 } : node.taskFailures,
      humanReviewRequired: false,
      manualRevisionRequested: source === 'revision' ? false : Boolean(node.manualRevisionRequested),
      taskError: null,
      stale: false,
      updatedAt: nowIso(at)
    }
  })
}

/**
 * 应用一次审查。
 *
 * 三条容易忽略的规则：
 *   1. 报告必须对应当前草稿版本，否则只标记"待审查"，不产生判定；
 *   2. 自动修订次数用尽后带警告放行，避免坏节点永久卡住整条流水线；
 *   3. 只有 blocking/需人工 且 impact=downstream 的问题才阻塞后文节点。
 */
export function applyNodeReview(lesson, nodeId, report = {}, { courseSpec = {}, trace = null, at } = {}) {
  const spec = { ...DEFAULT_COURSE_SPEC, ...courseSpec }
  const threshold = Number(spec.qualityThreshold)
  let applied = null

  const targetIndex = (lesson.nodes || []).findIndex(node => node.id === nodeId)
  let next = updateNode(lesson, nodeId, node => {
    if (!node.draft) throw new Error('节点必须先有草稿才能审查')
    const normalized = normalizeReviewReport({ ...report, trace }, node.versions?.length || 0, at)
    if (Number(normalized.reviewedDraftVersion) !== Number(node.versions?.length || 0)) {
      return { ...node, reviewRequired: true, taskError: null, updatedAt: nowIso(at) }
    }
    let decision = normalizedReviewDecision(normalized, threshold)
    const autoRevisionExhausted = decision === 'revise' &&
      Number(node.revisionCount || 0) >= Number(spec.maxAutoRevisions)
    if (autoRevisionExhausted) decision = 'approve'

    const finalReport = {
      ...normalized,
      decision,
      reviewedDraftVersion: Number(normalized.reviewedDraftVersion),
      autoRevisionExhausted,
      autoAcceptedWithWarnings: autoRevisionExhausted
    }
    applied = { decision, autoRevisionExhausted, downstreamImpact: decision === 'revise' && issuesAffectDownstream(finalReport) }

    const base = {
      ...node,
      reviewerReports: versioned(finalReport, node.reviewerReports, { source: 'worker', trace }, at),
      reviewRequired: false,
      reviewDecision: decision,
      taskError: null,
      taskFailures: { ...(node.taskFailures || {}), reviewer: 0 },
      blocksDownstream: applied.downstreamImpact,
      autoAcceptedWithWarnings: Boolean(node.autoAcceptedWithWarnings || autoRevisionExhausted),
      updatedAt: nowIso(at)
    }
    if (decision === 'approve') {
      return { ...base, status: 'node_approved', approvedAt: nowIso(at), humanReviewRequired: false, blocksDownstream: false }
    }
    return {
      ...base,
      status: 'node_revision_required',
      humanReviewRequired: false,
      revisionRequests: versioned({
        message: finalReport.issues.map(issue => issue.message).filter(Boolean).join('；') ||
          finalReport.summary || '审查发现需要修正的内容问题。',
        issues: finalReport.issues,
        source: 'reviewer'
      }, node.revisionRequests, { source: 'reviewer' }, at)
    }
  })

  if (applied?.decision === 'approve') {
    const nodes = releaseDownstreamBlocks(next.nodes, nodeId, at)
    next = { ...next, nodes, status: deriveLessonStatus(nodes) }
  } else if (applied?.downstreamImpact && targetIndex >= 0) {
    const message = '上游节点存在可能影响后文的实质问题；上游通过后，本节点会自动重新检查一致性。'
    const nodes = next.nodes.map((node, index) => {
      if (index <= targetIndex) return node
      if (!node.draft || ['node_revision_required', 'node_human_review', 'node_failed'].includes(node.status)) return node
      return {
        ...node,
        status: 'node_review',
        reviewRequired: true,
        reviewDecision: null,
        approvedAt: null,
        blockedByNodeIds: [...new Set([...(node.blockedByNodeIds || []), nodeId])],
        consistencyRequests: [...(node.consistencyRequests || []).slice(-9), { sourceNodeId: nodeId, message, at: nowIso(at) }],
        updatedAt: nowIso(at)
      }
    })
    next = { ...next, nodes, status: deriveLessonStatus(nodes) }
  }
  return next
}

export function requestNodeRevision(lesson, nodeId, request = '', { at } = {}) {
  const message = cleanText(typeof request === 'string' ? request : request?.message || '')
  if (!message) throw new Error('修订要求不能为空')
  return updateNode(lesson, nodeId, node => ({
    ...node,
    status: 'node_revision_required',
    revisionRequests: versioned({ message, source: 'user' }, node.revisionRequests, { source: 'user' }, at),
    reviewDecision: 'revise',
    humanReviewRequired: false,
    manualRevisionRequested: true,
    taskError: null,
    updatedAt: nowIso(at)
  }))
}

/** 人工放行：不要求审查通过，但必须给出理由。 */
export function approveNodeHuman(lesson, nodeId, reason = '', { at } = {}) {
  const note = cleanText(reason)
  if (!note) throw new Error('人工放行必须说明理由')
  const next = updateNode(lesson, nodeId, node => ({
    ...node,
    status: 'node_approved',
    approvedAt: nowIso(at),
    blocksDownstream: false,
    humanReviewRequired: false,
    approvalReason: note,
    updatedAt: nowIso(at)
  }))
  const nodes = releaseDownstreamBlocks(next.nodes, nodeId, at)
  return { ...next, nodes, status: deriveLessonStatus(nodes) }
}

/**
 * 审查通过后放行节点。程序化的放行入口，因此严格要求"当前草稿已有通过的审查报告"。
 */
export function approveNode(lesson, nodeId, { courseSpec = {}, at } = {}) {
  const spec = { ...DEFAULT_COURSE_SPEC, ...courseSpec }
  const node = (lesson.nodes || []).find(item => item.id === nodeId)
  if (!node) throw new Error(`节点不存在：${nodeId}`)
  if (!node.draft) throw new Error('节点必须先有草稿才能放行')
  const report = (node.reviewerReports || []).at(-1)?.value
  if (!report) throw new Error('节点必须先通过审查才能放行')
  if (normalizedReviewDecision(report, Number(spec.qualityThreshold)) !== 'approve') {
    throw new Error('审查未通过，不能放行节点')
  }
  if (Number(report.reviewedDraftVersion || 0) !== Number(node.versions?.length || 0)) {
    throw new Error('当前草稿版本尚未审查，不能放行')
  }
  const next = updateNode(lesson, nodeId, current => ({
    ...current,
    status: 'node_approved',
    approvedAt: nowIso(at),
    blocksDownstream: false,
    updatedAt: nowIso(at)
  }))
  const nodes = releaseDownstreamBlocks(next.nodes, nodeId, at)
  return { ...next, nodes, status: deriveLessonStatus(nodes) }
}

const issueMessage = issue => typeof issue === 'string'
  ? issue
  : cleanText(issue?.message || issue?.detail || issue?.type || '')

/** 终审问题能定位到哪些真实节点。定位不到时不能凭空挑一个节点改。 */
export function issueNodeIds(issues = [], lesson = {}) {
  const known = new Set((lesson.nodes || []).map(node => node.id))
  return [...new Set((issues || [])
    .map(issue => (typeof issue === 'object' ? issue.nodeId : ''))
    .filter(id => known.has(id)))]
}

/**
 * 应用终审结果。
 *
 * 四条出口，按"能定位到节点 → 有整体修订预算 → 预算耗尽带警告放行"的顺序判断：
 *   1. 问题能定位到节点，且相关节点还有修订额度 → 把这些节点退回修订；
 *   2. 问题定位不到节点（整体结构、跨节点重复）→ 走整篇修订，受 maxFinalAutoRevisions 约束；
 *   3. 两种修订预算都用尽 → **带警告放行**，并把 autoRevisionExhausted 记进质量报告。
 *      这是有意的：一个反复修不好的问题不应让整门课永远停在终审。
 *   4. 终审通过 → 课次完成。
 */
export function applyFinalReview(lesson, report = {}, { courseSpec = {}, at } = {}) {
  const spec = { ...DEFAULT_COURSE_SPEC, ...courseSpec }
  if (!lesson.finalNote?.markdown) throw new Error('必须先拼装出完整笔记才能终审')

  const normalized = normalizeReviewReport(report, lesson.finalNoteVersions?.length || 0, at)
  const decision = normalizedReviewDecision(normalized, Number(spec.qualityThreshold))
  const qualityReport = { ...normalized, decision, assembledNodeCount: lesson.nodes?.length || 0 }
  const stamp = nowIso(at)

  const finish = (finalReport) => ({
    ...lesson,
    status: 'completed',
    completedAt: stamp,
    finalReviewAttention: null,
    finalNote: { ...lesson.finalNote, qualityReport: finalReport, stale: false, updatedAt: stamp },
    finalReviewReports: versioned(finalReport, lesson.finalReviewReports, { source: 'worker' }, at),
    qualityReport: finalReport,
    updatedAt: stamp
  })

  if (decision !== 'revise') return finish(qualityReport)

  const requests = qualityReport.issues.map(issueMessage).filter(Boolean)
  const targetIds = issueNodeIds(qualityReport.issues, lesson)

  if (!targetIds.length) {
    const completedRevisions = Number(lesson.finalRevisionCount || 0)
    const maxRevisions = Math.max(0, Number(spec.maxFinalAutoRevisions))
    if (completedRevisions >= maxRevisions) {
      return finish({ ...qualityReport, decision: 'approve', unmappedIssues: true, autoRevisionExhausted: true, autoAcceptedWithWarnings: true })
    }
    return {
      ...lesson,
      status: 'final_revision_required',
      finalReviewAttention: null,
      finalNote: { ...lesson.finalNote, stale: true, qualityReport },
      finalReviewReports: versioned(qualityReport, lesson.finalReviewReports, { source: 'worker' }, at),
      finalRevisionRequests: versioned({
        message: requests.join('；') || qualityReport.summary || '最终检查要求修正整体结构、跨节点重复或术语一致性。',
        issues: qualityReport.issues,
        source: 'final-review'
      }, lesson.finalRevisionRequests, { source: 'final-review' }, at),
      qualityReport,
      updatedAt: stamp
    }
  }

  const maxNodeRevisions = Math.max(0, Number(spec.maxAutoRevisions))
  const eligibleTargetIds = targetIds.filter(id => {
    const node = (lesson.nodes || []).find(item => item.id === id)
    return node && Number(node.revisionCount || 0) < maxNodeRevisions
  })
  const exhaustedTargetIds = targetIds.filter(id => !eligibleTargetIds.includes(id))

  if (!eligibleTargetIds.length) {
    return finish({
      ...qualityReport,
      decision: 'approve',
      autoRevisionExhausted: true,
      autoAcceptedWithWarnings: true,
      exhaustedNodeIds: exhaustedTargetIds
    })
  }

  const reviewForRevision = { ...qualityReport, skippedExhaustedNodeIds: exhaustedTargetIds }
  const nodes = (lesson.nodes || []).map(node => {
    if (!eligibleTargetIds.includes(node.id)) return node
    return {
      ...node,
      status: 'node_revision_required',
      reviewDecision: 'revise',
      revisionRequests: versioned({
        message: requests.join('；') || '最终检查要求重新核对本节点。',
        source: 'final-review'
      }, node.revisionRequests, { source: 'final-review' }, at),
      updatedAt: stamp
    }
  })

  return {
    ...lesson,
    status: 'node_revision_required',
    nodes,
    finalReviewAttention: null,
    finalNote: { ...lesson.finalNote, stale: true, qualityReport: reviewForRevision },
    finalReviewReports: versioned(reviewForRevision, lesson.finalReviewReports, { source: 'worker' }, at),
    qualityReport: reviewForRevision,
    updatedAt: stamp
  }
}

/** 整篇修订完成后回到终审，并累加整篇修订次数。 */
export function saveFinalNoteRevision(lesson, markdown, { trace = null, at } = {}) {
  const next = cleanText(markdown)
  if (!next) throw new Error('修订后的笔记不能为空')
  const stamp = nowIso(at)
  return {
    ...lesson,
    status: 'final_review',
    finalNote: { ...lesson.finalNote, markdown: next, stale: true, updatedAt: stamp },
    finalNoteVersions: versioned(next, lesson.finalNoteVersions, { source: 'final-revision', trace }, at),
    finalRevisionCount: Number(lesson.finalRevisionCount || 0) + 1,
    updatedAt: stamp
  }
}

/** 记录一次技术性失败（网络、超时、格式），用于退避重试而不改动内容状态。 */
export function recordNodeTaskFailure(lesson, nodeId, { taskType = 'writer', error = '', retryable = true, at } = {}) {
  return updateNode(lesson, nodeId, node => ({
    ...node,
    taskFailures: { ...(node.taskFailures || {}), [taskType]: Number(node.taskFailures?.[taskType] || 0) + 1 },
    taskError: { message: cleanText(error), retryable: Boolean(retryable), at: nowIso(at) },
    updatedAt: nowIso(at)
  }))
}
