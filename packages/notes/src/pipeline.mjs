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
import { getNextCourseWorkerTask } from './worker-tasks.mjs'

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
  maxSteps = 40,
  at,
  onEvent = () => {}
} = {}) {
  if (!lesson?.transcript) throw new Error('缺少转录稿，无法生成笔记')
  let current = lesson
  const steps = []

  for (let index = 0; index < maxSteps; index += 1) {
    if (TERMINAL_STATUSES.includes(current.status)) {
      return { lesson: current, steps, stopReason: current.status, idleDetail: null }
    }

    const workflow = { status: current.status, courseSpec, lessons: [current] }
    const task = getNextCourseWorkerTask(workflow)
    if (!task || task.type === 'idle') {
      return { lesson: current, steps, stopReason: 'idle', idleDetail: task || null }
    }

    const action = await executeCourseTask(task, { modelConfig, callModel })
    const applied = applyTaskAction(current, action, { courseSpec, autoApproveOutline, at })
    current = applied.lesson
    const step = { index, taskType: task.type, action: action?.type || null, note: applied.note, taskKey: task.taskKey || null }
    steps.push(step)
    onEvent(step)
  }

  return { lesson: current, steps, stopReason: 'max-steps', idleDetail: null }
}
