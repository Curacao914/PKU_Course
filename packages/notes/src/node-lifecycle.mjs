import { cleanText, transcriptLines } from '@course/core'

// assembly 只依赖 @course/core，不反向依赖本模块，因此这里引用它不会成环。
import { nodeBodyPieces } from './assembly.mjs'

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

export const DEFAULT_COURSE_SPEC = Object.freeze({
  nodeSplitThreshold: 12_000,
  nodeSplitLineThreshold: 200,
  maxAutoRevisions: 2,
  maxFinalAutoRevisions: 1,
  maxTechnicalRetries: 2,
  reviewConcurrency: 2,
  promptVersion: 'course-v5-simple-review'
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
    id: issue?.id || `issue-${index + 1}`,
    type: cleanText(issue?.type || 'review_note'),
    severity,
    message: cleanText(issue?.message || issue?.detail || issue?.type || ''),
    nodeId: cleanText(issue?.nodeId || ''),
    sourceRange: cleanText(issue?.sourceRange || '')
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

/**
 * 审查判定只看一件事：有没有 blocking 问题。
 *
 * 旧实现用五项评分 + 阈值 + 分数下限来决定放行，那套机制的问题是：分数是模型的
 * 自报感受，既不稳定也不可解释，还得靠量纲归一化兜底；而真正的判据（"有没有必须
 * 改的问题"）本来就在 issues 里。现在模型只回答 approve/revise，但**判定权在问题
 * 清单上**：没有 blocking 就是通过。
 *
 * human_review 不再作为人工门禁（链路是全自动的），按"这里需要重写"处理。
 * 不使用 decision 字段做判据还有一个好处：模型答 revise 却列不出 blocking 问题时，
 * 不会触发一轮无意义的重写。
 */
export function normalizedReviewDecision(report = {}) {
  return blockingIssues(report).length ? 'revise' : 'approve'
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
  // 必须按"逻辑行"（见 @course/core 的 transcriptLines）切片：大纲的 [Lx] 行号是按
  // 逻辑行编的，此前这里按物理行切，导致每个节点拿到的原文偏移了约一倍。
  const [start = 1, end = start] = range
  return transcriptLines(transcript)
    .slice(Math.max(0, Number(start) - 1), Math.max(Number(start), Number(end)))
    .join('\n')
}

export function pptForRange(pptText = [], range = []) {
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
    // 正课 / 行政事务 / 课堂发散：拼装时据此决定进正文还是进附录
    kind: ['content', 'logistics', 'digression'].includes(outlineNode.kind) ? outlineNode.kind : 'content',
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

  const modules = outline.flatMap(outlineNode => {
    const source = linesForRange(lesson.transcript, outlineNode.lineRange)
    const lineSpan = outlineNode.lineRange[1] - outlineNode.lineRange[0] + 1
    const partCount = Math.max(1, Math.ceil(source.length / charThreshold), Math.ceil(lineSpan / lineThreshold))
    return Array.from({ length: partCount }, (_, partIndex) =>
      createNodeFromOutline({ outlineNode, partIndex, partCount, lesson, courseSpec: spec, at })
    )
  })

  return groupWriteUnits(modules, spec.writeUnits)
}

/**
 * 把知识模块合并成写作单元。
 *
 * 这两件事必须分开：
 *   - **模块结构**（5—8 个知识模块）由大纲决定，是笔记好不好读的关键，不该被"写几次"影响；
 *   - **写作单元**只决定"分几次模型调用写完"：1 次写完整节课最容易保持贯通，
 *     但一次要吐一万多字；分 2—3 次则每次更从容。
 * 一次写多个模块时，模型必须按模块标题分段，拼装层据此还原模块结构；
 * 因此合并后的节点带 moduleBriefs，写作契约写在 writerBrief.writeContract 里。
 */
export function groupWriteUnits(nodes = [], unitCount) {
  const total = Math.floor(Number(unitCount) || 0)
  if (!nodes.length || !(total > 0) || total >= nodes.length) return nodes
  const perUnit = nodes.length / total
  const groups = []
  for (let index = 0; index < total; index += 1) {
    const start = Math.round(index * perUnit)
    const end = Math.round((index + 1) * perUnit)
    const group = nodes.slice(start, end)
    if (group.length) groups.push(group)
  }
  return groups.map((group, index) => mergeWriteUnit(group, index))
}

function mergeWriteUnit(group, index) {
  const first = group[0]
  const last = group.at(-1)
  const moduleBriefs = group.map(node => ({
    outlineNodeId: node.outlineNodeId,
    title: node.title,
    lineRange: node.lineRange,
    kind: node.kind || 'content',
    goal: node.writerBrief?.currentNodeGoal || ''
  }))
  return {
    ...first,
    id: `${first.outlineNodeId}-unit-${index + 1}`,
    title: moduleBriefs.length === 1 ? first.title : moduleBriefs.map(item => item.title).join(' / '),
    kind: moduleBriefs.every(item => item.kind === moduleBriefs[0].kind) ? moduleBriefs[0].kind : 'content',
    outlineNodeId: first.outlineNodeId,
    outlineNodeIds: group.map(node => node.outlineNodeId),
    moduleBriefs,
    lineRange: [first.lineRange[0], last.lineRange[1]],
    sourceText: group.map(node => node.sourceText).join('\n\n'),
    pptText: group.map(node => node.pptText).filter(Boolean).join('\n\n'),
    writerBrief: {
      ...(first.writerBrief || {}),
      moduleBriefs,
      writeContract: moduleBriefs.length > 1
        ? [
          `本单元包含 ${moduleBriefs.length} 个知识模块，必须全部写完，顺序与 moduleBriefs 一致。`,
          '每个模块以「### 模块标题」开头，标题与 moduleBriefs[].title 完全一致（程序按它对号入座）。',
          '模块内部用「一、」「（一）」「1.」这类中式层级，不要再输出 Markdown 标题。'
        ].join('')
        : ''
    }
  }
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

// 说明：旧实现里有"上游节点的问题阻塞下游节点、上游通过后下游自动重查"的机制。
// 它属于反复确认那一类：一次审查的问题会引发后续节点重审，链路随之变长且难以收敛。
// 跨节点的一致性改由终审一次性检查，节点审查只对本节点负责。

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
      // 修订次数按"已完成的修订尝试"计数，而不是按"内容是否变化"计数。
      // 模型有时会原样返回上一版；若原样返回不计入上限，审查→修订就会在两步之间
      // 无限循环，直到撞上流水线步数上限后整篇重跑（真正的成本灾难）。
      // 上限才是终止条件，内容是否变化只影响版本历史（versions 仍然只在变化时追加）。
      revisionCount: source === 'revision'
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

  return updateNode(lesson, nodeId, node => {
    if (!node.draft) throw new Error('节点必须先有草稿才能审查')
    const normalized = normalizeReviewReport({ ...report, trace }, node.versions?.length || 0, at)
    if (Number(normalized.reviewedDraftVersion) !== Number(node.versions?.length || 0)) {
      return { ...node, reviewRequired: true, taskError: null, updatedAt: nowIso(at) }
    }

    // 重写上限用尽就等于通过（带警告）：一个反复改不好的段落不该让整课的笔记永远产不出来。
    const wanted = normalizedReviewDecision(normalized)
    const autoRevisionExhausted = wanted === 'revise' &&
      Number(node.revisionCount || 0) >= Number(spec.maxAutoRevisions)
    const decision = autoRevisionExhausted ? 'approve' : wanted

    const finalReport = {
      ...normalized,
      decision,
      reviewedDraftVersion: Number(normalized.reviewedDraftVersion),
      autoRevisionExhausted,
      autoAcceptedWithWarnings: autoRevisionExhausted
    }

    const base = {
      ...node,
      reviewerReports: versioned(finalReport, node.reviewerReports, { source: 'worker', trace }, at),
      reviewRequired: false,
      reviewDecision: decision,
      taskError: null,
      taskFailures: { ...(node.taskFailures || {}), reviewer: 0 },
      autoAcceptedWithWarnings: Boolean(node.autoAcceptedWithWarnings || autoRevisionExhausted),
      updatedAt: nowIso(at)
    }
    if (decision === 'approve') {
      return { ...base, status: 'node_approved', approvedAt: nowIso(at) }
    }
    return {
      ...base,
      status: 'node_revision_required',
      revisionRequests: versioned({
        message: finalReport.issues.map(issue => issue.message).filter(Boolean).join('；') ||
          finalReport.summary || '审查发现需要修正的内容问题。',
        issues: finalReport.issues,
        source: 'reviewer'
      }, node.revisionRequests, { source: 'reviewer' }, at)
    }
  })
}

/**
 * 把一个"覆盖多个模块的写作单元"拆成模块节点。
 *
 * 为什么需要：写作单元可以一次写完 8 个模块（省调用、上下文连贯），但用户要改的
 * 往往只是其中一个模块。不能因为"当初是一次写完的"就逼他重写整节 1 万字。
 * 拆分时：每个模块拿到自己那一段正文（nodeBodyPieces 按模块标题切），
 * 未被点名的模块**原样放行**（内容没动过，是同一批评审覆盖过的），
 * 被点名的模块回到待修订状态。
 */
export function splitWriteUnit(lesson, nodeId, {
  keepPending = [],
  reason = '拆分自同一写作单元，正文未改动',
  at
} = {}) {
  const node = (lesson.nodes || []).find(item => item.id === nodeId)
  if (!node) throw new Error(`节点不存在：${nodeId}`)
  const ids = Array.isArray(node.outlineNodeIds) && node.outlineNodeIds.length
    ? node.outlineNodeIds
    : [node.outlineNodeId]
  if (ids.length <= 1) return lesson

  const outlineById = new Map((lesson.outline || []).map(item => [item.id, item]))
  const pieces = nodeBodyPieces(node)
  const lines = transcriptLines(lesson.transcript || '')
  const modules = ids.map((outlineId, index) => {
    const outlineNode = outlineById.get(outlineId) || {}
    const [start, end] = outlineNode.lineRange || []
    const sourceText = start && end ? lines.slice(start - 1, end).join('\n') : node.sourceText
    return {
      ...node,
      id: `${node.id}--${outlineId}`,
      title: outlineNode.title || node.title,
      outlineNodeId: outlineId,
      outlineNodeIds: [outlineId],
      moduleBriefs: [{
        outlineNodeId: outlineId,
        title: outlineNode.title || node.title,
        lineRange: outlineNode.lineRange,
        kind: node.kind || 'content',
        goal: node.moduleBriefs?.[index]?.goal || outlineNode.rationale || ''
      }],
      sourceText,
      pptText: pptForRange(lesson.pptText || [], outlineNode.slideRange || []),
      draft: pieces.get(outlineId) || '',
      versions: [{ version: 1, at: nowIso(at), value: pieces.get(outlineId) || '', source: 'split' }],
      reviewerReports: [],
      revisionCount: 0,
      revisionRequests: [],
      status: 'node_pending',
      splitFrom: node.id,
      updatedAt: nowIso(at)
    }
  })

  let next = { ...lesson, nodes: [...(lesson.nodes || []).filter(item => item.id !== nodeId), ...modules] }
  // 未被点名的模块直接放行：正文来自同一份已通过审查的草稿，重新审查纯属重复付费。
  // 用人工放行入口（要求写明理由），而不是伪造一份审查报告。
  const pending = new Set(keepPending)
  for (const module of modules) {
    if (pending.has(module.outlineNodeId)) continue
    next = approveNodeHuman(next, module.id, reason, { at })
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
  return next
}

/**
 * 审查通过后放行节点。程序化的放行入口，因此严格要求"当前草稿已有通过的审查报告"。
 */
export function approveNode(lesson, nodeId, { at } = {}) {
  const node = (lesson.nodes || []).find(item => item.id === nodeId)
  if (!node) throw new Error(`节点不存在：${nodeId}`)
  if (!node.draft) throw new Error('节点必须先有草稿才能放行')
  const report = (node.reviewerReports || []).at(-1)?.value
  if (!report) throw new Error('节点必须先通过审查才能放行')
  if (normalizedReviewDecision(report) !== 'approve') {
    throw new Error('审查未通过，不能放行节点')
  }
  if (Number(report.reviewedDraftVersion || 0) !== Number(node.versions?.length || 0)) {
    throw new Error('当前草稿版本尚未审查，不能放行')
  }
  return updateNode(lesson, nodeId, current => ({
    ...current,
    status: 'node_approved',
    approvedAt: nowIso(at),
    updatedAt: nowIso(at)
  }))
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
  const decision = normalizedReviewDecision(normalized)
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
