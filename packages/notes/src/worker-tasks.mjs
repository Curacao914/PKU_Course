/**
 * 从课程工作流状态推导"下一步该做什么"。
 *
 * 从 my-blog-main 的 lib/course/workerTasks.js 原样摘出——它是纯函数，
 * 输入完整 workflow 对象、输出任务数组，没有任何 IO 依赖。
 * 后台 worker 因此不需要理解状态机全貌，只要按这里给出的任务执行即可。
 *
 * 任务类型：generate-outline / plan-nodes / write-node / review-node / revise-node /
 * assemble / revise-final-note / final-review / reconcile-final-review / idle。
 */
const orderedLessons = workflow => [...(workflow.lessons || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
const latestReview = node => (node.reviewerReports || []).at(-1)?.value || null

function nodeWithNeighborContext(lesson, node) {
  const nodes = lesson.nodes || []
  const index = nodes.findIndex(item => item.id === node.id)
  const previous = index > 0 ? nodes[index - 1] : null
  const next = index >= 0 && index < nodes.length - 1 ? nodes[index + 1] : null
  const previousDraft = String(previous?.draft || '').trim()

  // 全课结构表：让撰写者知道"我正在写整条线的哪一环"。
  // 旧实现只给"上一节点末尾 1600 字"，撰写者看不到全课分工，写出来自然段段割裂。
  // 结构表只有标题与分工，没有别节正文，既省 token 又不会诱导重复。
  const outline = Array.isArray(lesson.outline) ? lesson.outline : []
  const structure = outline.map((item, position) => {
    const child = nodes.find(candidate => candidate.outlineNodeId === item.id)
    return {
      order: position + 1,
      outlineNodeId: item.id,
      title: item.title,
      kind: item.kind || 'content',
      lineRange: item.lineRange,
      goal: child?.writerBrief?.currentNodeGoal || item.rationale || '',
      isCurrent: item.id === node.outlineNodeId
    }
  })

  return {
    ...node,
    writerBrief: {
      ...(node.writerBrief || {}),
      previousNodeSummary: previousDraft ? previousDraft.slice(-800) : previous?.title || '',
      nextNodeTarget: next?.writerBrief?.currentNodeGoal || next?.title || '',
      lessonStructure: structure,
      lessonStructureRule: 'lessonStructure 是本课全部小节及其分工。写正文时不要重复别节内容；开头用一两句说明本节与上一节的关系（写关系，例如"因此/与之相对/在此基础上"，不要写"接下来我们讲"这类顺序词）。'
    }
  }
}

function taskAttempt(node, lane) {
  return Number(node?.taskFailures?.[lane] || 0) + 1
}

function revisionTask(workflow, lesson) {
  const max = Number(workflow.courseSpec?.maxAutoRevisions || 2)
  const revision = (lesson.nodes || []).find(node =>
    ['node_revision_required', 'node_human_review'].includes(node.status)
  )
  if (!revision) return null
  const completedRevisions = Number(revision.revisionCount || 0)
  if (completedRevisions >= max && !revision.manualRevisionRequested) return null
  return {
    type: 'revise-node',
    taskKey: `revise:${lesson.key}:${revision.id}:request-${revision.revisionRequests?.length || 0}:draft-${revision.versions?.length || 0}:attempt-${taskAttempt(revision, 'revision')}`,
    lessonKey: lesson.key,
    node: nodeWithNeighborContext(lesson, revision),
    courseSpec: workflow.courseSpec,
    lessonBlueprint: lesson.blueprint,
    outline: lesson.outline
  }
}

function writerTask(workflow, lesson) {
  const pending = (lesson.nodes || []).find(node => node.status === 'node_pending')
  if (!pending) return null
  const pendingIndex = (lesson.nodes || []).findIndex(node => node.id === pending.id)
  const unresolvedUpstream = (lesson.nodes || []).slice(0, pendingIndex).find(node =>
    (node.blocksDownstream && node.status !== 'node_approved') || !String(node.draft || '').trim()
  )
  if (unresolvedUpstream) return null
  return {
    type: 'write-node',
    taskKey: `write:${lesson.key}:${pending.id}:${(pending.versions || []).length + 1}:attempt-${taskAttempt(pending, 'writer')}`,
    lessonKey: lesson.key,
    node: nodeWithNeighborContext(lesson, pending),
    courseSpec: workflow.courseSpec,
    lessonBlueprint: lesson.blueprint,
    outline: lesson.outline
  }
}

function reviewTasks(workflow, lesson, limit = 2) {
  return (lesson.nodes || [])
    .filter(node => node.status === 'node_review' && !(node.blockedByNodeIds || []).length && (node.reviewRequired || !latestReview(node)))
    .slice(0, Math.max(0, Number(limit || 0)))
    .map(node => ({
      type: 'review-node',
      taskKey: `review:${lesson.key}:${node.id}:draft-${node.versions?.length || 0}:report-${(node.reviewerReports || []).length + 1}:attempt-${taskAttempt(node, 'reviewer')}`,
      lessonKey: lesson.key,
      node: nodeWithNeighborContext(lesson, node),
      courseSpec: workflow.courseSpec,
      lessonBlueprint: lesson.blueprint,
      outline: lesson.outline
    }))
}

function nodeTaskBatch(workflow, lesson, { reviewConcurrency = 2, totalConcurrency = 3 } = {}) {
  const tasks = []
  const total = Math.max(1, Number(totalConcurrency || 3))
  const revision = revisionTask(workflow, lesson)
  const writer = writerTask(workflow, lesson)

  // 影响后文的修订仍然优先；纯局部修订可与下一个独立节点并行。
  if (revision?.node?.blocksDownstream) {
    tasks.push(revision)
  } else {
    if (writer) tasks.push(writer)
    if (revision && tasks.length < total) tasks.push(revision)
  }
  if (!tasks.length && revision) tasks.push(revision)

  const remaining = Math.max(0, total - tasks.length)
  tasks.push(...reviewTasks(workflow, lesson, Math.min(reviewConcurrency, remaining)))
  return tasks
}

function currentFinalReviewReport(lesson) {
  const report = (lesson.finalReviewReports || []).at(-1)?.value || lesson.qualityReport || lesson.finalNote?.qualityReport || null
  if (!report) return null
  if (report.reviewedDraftVersion === undefined || report.reviewedDraftVersion === null) return null
  return Number(report.reviewedDraftVersion) === Number(lesson.finalNoteVersions?.length || 0)
    ? report
    : null
}

function finalReviewIsCurrent(lesson) {
  return Boolean(currentFinalReviewReport(lesson))
}

function finalReviewTask(workflow, lesson) {
  if (!String(lesson.finalNote?.markdown || '').trim() || finalReviewIsCurrent(lesson)) return null
  return {
    type: 'final-review',
    taskKey: `final-review:${lesson.key}:version-${lesson.finalNoteVersions?.length || 0}:report-${(lesson.finalReviewReports || []).length + 1}`,
    lessonKey: lesson.key,
    courseSpec: workflow.courseSpec,
    lesson: {
      key: lesson.key,
      title: lesson.title,
      blueprint: lesson.blueprint,
      nodes: lesson.nodes,
      finalNote: lesson.finalNote
    }
  }
}

function oneStageTask(workflow, lesson) {
  if (lesson.status === 'preflight_required' || workflow.status === 'preflight_required') return { type: 'idle', reason: 'waiting-preflight', lessonKey: lesson.key }
  if (['preflight_approved', 'outline_pending', 'outline_generating'].includes(lesson.status) || ['preflight_approved', 'outline_pending', 'outline_generating'].includes(workflow.status)) return {
    type: 'generate-outline', taskKey: `outline:${lesson.key}:${(lesson.outlineVersions || []).length + 1}`, lessonKey: lesson.key, courseSpec: workflow.courseSpec,
    lesson: { key: lesson.key, title: lesson.title, transcript: lesson.transcript, sourceMap: lesson.sourceMap, pptText: lesson.pptText, supplements: lesson.supplements }
  }
  if (lesson.status === 'outline_review' || workflow.status === 'outline_review') return { type: 'idle', reason: 'waiting-outline-approval', lessonKey: lesson.key }
  if (['outline_approved', 'node_planning'].includes(lesson.status) || ['outline_approved', 'node_planning'].includes(workflow.status)) return { type: 'plan-nodes', taskKey: `plan:${lesson.key}:${(lesson.outlineVersions || []).length}`, lessonKey: lesson.key }
  if (lesson.status === 'assembly_pending' || workflow.status === 'assembly_pending') return {
    type: 'assemble',
    taskKey: `assemble:${lesson.key}:${(lesson.finalNoteVersions || []).length + 1}`,
    lessonKey: lesson.key,
    courseSpec: workflow.courseSpec,
    lesson: { key: lesson.key, title: lesson.title, blueprint: lesson.blueprint, outline: lesson.outline, transcript: lesson.transcript, nodes: lesson.nodes }
  }
  if (lesson.status === 'final_revision_required' || workflow.status === 'final_revision_required') {
    return {
      type: 'revise-final-note',
      taskKey: `revise-final:${lesson.key}:request-${lesson.finalRevisionRequests?.length || 0}:version-${lesson.finalNoteVersions?.length || 0}`,
      lessonKey: lesson.key,
      courseSpec: workflow.courseSpec,
      lesson: {
        key: lesson.key,
        title: lesson.title,
        blueprint: lesson.blueprint,
        finalNote: lesson.finalNote,
        finalRevisionRequests: lesson.finalRevisionRequests || []
      }
    }
  }
  if (lesson.status === 'final_review' || workflow.status === 'final_review') {
    const currentReport = currentFinalReviewReport(lesson)
    if (currentReport) {
      return {
        type: 'reconcile-final-review',
        taskKey: `reconcile-final-review:${lesson.key}:version-${lesson.finalNoteVersions?.length || 0}:report-${lesson.finalReviewReports?.length || 0}`,
        lessonKey: lesson.key,
        qualityReport: currentReport
      }
    }
    return finalReviewTask(workflow, lesson)
  }
  if (lesson.status === 'final_review_human' || workflow.status === 'final_review_human') {
    const currentReport = currentFinalReviewReport(lesson)
    if (currentReport) {
      return {
        type: 'reconcile-final-review',
        taskKey: `reconcile-final-review:${lesson.key}:version-${lesson.finalNoteVersions?.length || 0}:report-${lesson.finalReviewReports?.length || 0}`,
        lessonKey: lesson.key,
        qualityReport: currentReport
      }
    }
    const migrationTask = finalReviewTask(workflow, lesson)
    if (migrationTask) return migrationTask
    return { type: 'idle', reason: 'waiting-final-human-review', lessonKey: lesson.key }
  }
  if (lesson.status === 'note_removed' || workflow.status === 'note_removed') return { type: 'idle', reason: 'waiting-note-regeneration', lessonKey: lesson.key }
  if (lesson.status === 'node_human_review' || workflow.status === 'node_human_review') return { type: 'idle', reason: 'waiting-node-human-review', lessonKey: lesson.key }
  return null
}

export function getNextCourseWorkerTasks(workflow, options = {}) {
  if (!workflow || workflow.cancelled || workflow.status === 'cancelled') return [{ type: 'idle', reason: 'cancelled' }]
  if (workflow.paused || workflow.status === 'paused') return [{ type: 'idle', reason: 'paused' }]
  if (workflow.status === 'failed') return [{ type: 'idle', reason: 'failed' }]
  const lesson = orderedLessons(workflow).find(item => item.status !== 'completed')
  if (!lesson) return [{ type: 'idle', reason: 'completed' }]

  if (['node_pending', 'node_generating', 'node_review', 'node_revision_required', 'node_human_review'].includes(lesson.status) || ['node_pending', 'node_generating', 'node_review', 'node_revision_required', 'node_human_review'].includes(workflow.status)) {
    const tasks = nodeTaskBatch(workflow, lesson, options)
    if (tasks.length) return tasks
    const attention = (lesson.nodes || []).find(node => node.status === 'node_failed')
    if (attention) return [{ type: 'idle', reason: 'waiting-node-retry', lessonKey: lesson.key, nodeId: attention.id }]
  }

  const task = oneStageTask(workflow, lesson)
  return [task || { type: 'idle', reason: lesson.status || workflow.status || 'no-pending-step', lessonKey: lesson.key }]
}

export function getNextCourseWorkerTask(workflow) {
  return getNextCourseWorkerTasks(workflow, { reviewConcurrency: 1, totalConcurrency: 1 })[0]
}

export function workerStatusPatch({ online = true, message = '' } = {}) {
  return { status: online ? 'online' : 'offline', lastSeenAt: new Date().toISOString(), message }
}
