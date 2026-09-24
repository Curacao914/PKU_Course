import { assembleFinalNote } from './assembly.mjs'
import {
  applyFinalReview,
  applyNodeReview,
  deriveLessonStatus,
  planNodes,
  saveFinalNoteRevision,
  saveNodeDraft
} from './node-lifecycle.mjs'
import { executeCourseTask } from './task-runner.mjs'
import { getNextCourseWorkerTasks } from './worker-tasks.mjs'

/**
 * 单课笔记流水线的编排循环：领任务 → 调模型 → 应用动作 → 再领任务。
 *
 * 这一层不自己判断"下一步做什么"（那是 worker-tasks 的职责），也不自己改状态
 * （那是 node-lifecycle 的职责）。它只负责把两者接起来，并把每一步记下来，
 * 这样一次失败可以精确定位到是哪一步、哪个角色、用了哪个版本。
 *
 * 与原系统的差异：大纲确认这一步在自动化链路里没有人工介入，因此默认自动确认
 * （对应旧系统的 COURSE_AUTO_APPROVE_OUTLINE=1）。设为 false 时流水线会停在
 * outline_review，等待人工确认后再继续——手动模式与自动模式共用同一段代码。
 */

const TERMINAL_STATUSES = ['completed', 'failed', 'needs_attention']

/**
 * 步数上限默认不设。
 *
 * 旧实现把 maxSteps 当成质量保险丝，实际效果是：几节课里只要有几个节点需要重写，
 * 就会撞上限——而撞上限的代价不是"少写一点"，是整篇笔记不产出、账本退回上一阶段、
 * 下一轮从头再跑一遍，钱和时间双倍付。真正的终止条件是状态机本身（每个节点最多重写
 * 两次、终审的修订预算、空闲即停），步数上限只该用在调试期。因此默认不设，
 * 需要时用 --max-steps 显式给一个值。
 */
export const DEFAULT_NOTES_MAX_STEPS = Number.POSITIVE_INFINITY

/** 连续多少个批次全部失败就停：这是真死循环（网络/凭据全挂）的兜底，不是质量闸门。 */
const MAX_CONSECUTIVE_FAILED_BATCHES = 3

export function createInitialLesson({
  key, order = 1, title, transcript, sourceMap = [], pptText = [], supplements = [], blueprint = {}
}) {
  return {
    key,
    order,
    title,
    status: 'outline_pending',
    transcript,
    sourceMap,
    pptText,
    supplements,
    blueprint,
    outline: [],
    nodes: [],
    finalNote: null,
    finalNoteVersions: [],
    finalReviewReports: [],
    finalRevisionRequests: [],
    finalRevisionCount: 0,
    qualityReport: null,
    publication: null
  }
}

/**
 * 把一个动作应用到课次上。
 *
 * 唯一需要"拒绝执行"的情况是过期草稿：模型基于第 N 版起草，而当前已经是第 N+1 版。
 * 这时写入会覆盖更晚的结果，因此跳过并如实记录，而不是硬写进去。
 */
export function applyTaskAction(lesson, action, { courseSpec = {}, autoApproveOutline = true, at } = {}) {
  if (!action) return { lesson, note: 'no-action' }

  switch (action.type) {
    case 'plan-nodes': {
      const nodes = planNodes({ lesson, outline: lesson.outline, courseSpec, at })
      return {
        lesson: { ...lesson, nodes, status: deriveLessonStatus(nodes), updatedAt: new Date(at ?? Date.now()).toISOString() },
        note: `planned-${nodes.length}-nodes`
      }
    }
    case 'save-outline': {
      const status = autoApproveOutline ? 'outline_approved' : 'outline_review'
      return {
        lesson: {
          ...lesson,
          outline: action.outline,
          blueprint: { ...(lesson.blueprint || {}), mainLine: action.mainLine || '' },
          outlineMainLine: action.mainLine || '',
          outlineTraces: [...(lesson.outlineTraces || []).slice(-9), action.trace || null],
          status,
          updatedAt: new Date(at ?? Date.now()).toISOString()
        },
        note: autoApproveOutline ? 'outline-approved' : 'outline-awaiting-approval'
      }
    }
    case 'save-node-draft-worker': {
      const node = (lesson.nodes || []).find(item => item.id === action.nodeId)
      if (!node) throw new Error(`节点不存在：${action.nodeId}`)
      const currentVersion = Number(node.versions?.length || 0)
      if (Number(action.basedDraftVersion ?? currentVersion) !== currentVersion) {
        return { lesson, note: 'skipped-stale-draft', skipped: true }
      }
      return {
        lesson: saveNodeDraft(lesson, action.nodeId, action.markdown, { source: action.source || 'writer', trace: action.trace, at }),
        note: `draft-${action.source || 'writer'}`
      }
    }
    case 'save-node-review': {
      return {
        lesson: applyNodeReview(lesson, action.nodeId, action.reviewerReport || {}, { courseSpec, trace: action.trace, at }),
        note: `review-${action.reviewerReport?.decision || 'unknown'}`
      }
    }
    case 'assemble': {
      return {
        lesson: assembleFinalNote(lesson, action.spliceData || {}, { courseSpec, trace: action.trace, at }),
        note: 'assembled'
      }
    }
    case 'complete-final-review': {
      return {
        lesson: applyFinalReview(lesson, action.qualityReport || {}, { courseSpec, at }),
        note: `final-review-${action.qualityReport?.decision || 'unknown'}`
      }
    }
    case 'save-final-note-revision': {
      return {
        lesson: saveFinalNoteRevision(lesson, action.markdown, { trace: action.trace, at }),
        note: 'final-note-revised'
      }
    }
    default:
      throw new Error(`无法应用的动作类型：${action.type}`)
  }
}

/**
 * 把一节课从当前状态推进到完成（或停在该停的地方）。
 *
 * @returns {{ lesson, steps, stopReason, idleDetail }}
 */
export async function runLessonNotes({
  lesson,
  courseSpec = {},
  modelConfig,
  callModel,
  autoApproveOutline = true,
  maxSteps = DEFAULT_NOTES_MAX_STEPS,
  reviewConcurrency = 2,
  totalConcurrency = 3,
  at,
  onEvent = () => {},
  // 每应用完一步就回调一次，供调用方把课次状态落盘：模型调用很贵，
  // 只有把中间状态留下来，崩了才能续跑，事后也才有评审报告可查。
  onState = () => {}
} = {}) {
  if (!lesson?.transcript) throw new Error('缺少转录稿，无法生成笔记')
  const maxTaskFailures = Math.max(1, Number(courseSpec.maxTechnicalRetries || 2))
  let current = lesson
  const steps = []
  const failures = new Map()
  let used = 0
  let consecutiveFailedBatches = 0

  while (used < maxSteps) {
    if (TERMINAL_STATUSES.includes(current.status)) {
      return { lesson: current, steps, stopReason: current.status, idleDetail: null }
    }

    const workflow = { status: current.status, courseSpec, lessons: [current] }
    // 一批最多三个任务：写一个节点 + 改一个节点 + 审两个节点（彼此独立，可并发）。
    const batch = getNextCourseWorkerTasks(workflow, { reviewConcurrency, totalConcurrency }) || []
    const tasks = batch.filter(task => task && task.type !== 'idle')
    if (!tasks.length) {
      return { lesson: current, steps, stopReason: 'idle', idleDetail: batch[0] || null }
    }

    const results = await Promise.all(tasks.map(async task => {
      try {
        return { task, action: await executeCourseTask(task, { modelConfig, callModel }) }
      } catch (error) {
        return { task, error: error instanceof Error ? error.message : String(error) }
      }
    }))

    // 应用顺序固定：先落内容的，后做判定的（同批里审查的节点与写作/修订的节点互不重叠，
    // 顺序只影响可读性；万一重叠，applyTaskAction 里的过期草稿保护会拒绝写入）。
    const rank = { 'write-node': 0, 'revise-node': 1, 'review-node': 2, assemble: 3, 'final-review': 4 }
    results.sort((left, right) => (rank[left.task.type] ?? 9) - (rank[right.task.type] ?? 9))

    let batchFailed = 0
    for (const { task, action, error } of results) {
      used += 1
      if (error) {
        batchFailed += 1
        const count = Number(failures.get(task.taskKey) || 0) + 1
        failures.set(task.taskKey, count)
        const step = { index: steps.length, taskType: task.type, action: null, note: 'failed', taskKey: task.taskKey || null, error }
        steps.push(step)
        onEvent(step)
        // 同一个任务连续失败到上限就整轮停下：这通常意味着凭据、配额或网络出了系统性问题，
        // 继续重试只会重复烧钱。状态已经落盘，修好之后可以 --resume 续跑。
        if (count > maxTaskFailures) {
          return { lesson: current, steps, stopReason: 'task-failures', idleDetail: { taskKey: task.taskKey, error, taskType: task.type } }
        }
        continue
      }
      failures.delete(task.taskKey)
      const applied = applyTaskAction(current, action, { courseSpec, autoApproveOutline, at })
      current = applied.lesson
      const step = { index: steps.length, taskType: task.type, action: action?.type || null, note: applied.note, taskKey: task.taskKey || null }
      steps.push(step)
      onEvent(step)
      onState(current, step)
    }

    // 偶发单点失败不该拖垮整轮，但"连续整批全挂"是实现层面的系统性故障
    // （凭据、配额、网络），此时停下并如实报错，比继续重复烧钱更负责。
    consecutiveFailedBatches = batchFailed === results.length && results.length > 0 ? consecutiveFailedBatches + 1 : 0
    if (consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES) {
      return {
        lesson: current,
        steps,
        stopReason: 'task-failures',
        idleDetail: { error: results[0]?.error || '连续多批任务全部失败', taskType: results[0]?.task?.type || null }
      }
    }
  }

  return { lesson: current, steps, stopReason: 'max-steps', idleDetail: null }
}
