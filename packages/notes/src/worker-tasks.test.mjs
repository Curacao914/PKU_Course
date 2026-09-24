import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getNextCourseWorkerTask,
  getNextCourseWorkerTasks,
  workerStatusPatch
} from './worker-tasks.mjs'

const node = (id, over = {}) => ({
  id,
  title: `节点 ${id}`,
  status: 'node_pending',
  versions: [],
  reviewerReports: [],
  ...over
})

function workflow(over = {}) {
  return {
    status: 'node_pending',
    courseSpec: { courseName: '刑法分论', maxAutoRevisions: 2 },
    lessons: [{
      key: 'lesson-1',
      order: 1,
      title: '第10-12节',
      status: 'node_pending',
      blueprint: { transcriptLineCount: 100 },
      outline: { nodes: [] },
      nodes: [node('n1')],
      versions: [],
      ...over.lesson
    }],
    ...over
  }
}

test('a paused, cancelled or failed workflow yields an idle task with a reason', () => {
  assert.deepEqual(getNextCourseWorkerTasks({ paused: true }), [{ type: 'idle', reason: 'paused' }])
  assert.deepEqual(getNextCourseWorkerTasks({ cancelled: true }), [{ type: 'idle', reason: 'cancelled' }])
  assert.deepEqual(getNextCourseWorkerTasks({ status: 'failed' }), [{ type: 'idle', reason: 'failed' }])
  assert.deepEqual(
    getNextCourseWorkerTasks(workflow({ lesson: { status: 'completed' } })),
    [{ type: 'idle', reason: 'completed' }]
  )
})

test('the writer picks the first pending node and carries neighbour context', () => {
  const wf = workflow({
    lesson: {
      status: 'node_pending',
      nodes: [
        node('n1', { status: 'node_approved', draft: '上游已完成的正文' }),
        node('n2')
      ]
    }
  })
  const tasks = getNextCourseWorkerTasks(wf, { reviewConcurrency: 0, totalConcurrency: 1 })
  const writer = tasks.find(task => task.type === 'write-node')
  assert.ok(writer, '应派发写节点任务')
  assert.equal(writer.node.id, 'n2')
  assert.match(writer.taskKey, /^write:lesson-1:n2:1:attempt-1$/)
  assert.equal(writer.node.writerBrief.previousNodeSummary, '上游已完成的正文')
  assert.equal(writer.lessonKey, 'lesson-1')
})

test('a node is not written while an upstream node is unfinished', () => {
  const wf = workflow({
    lesson: {
      status: 'node_pending',
      nodes: [
        node('n1', { status: 'node_review', draft: '' }),
        node('n2')
      ]
    }
  })
  const tasks = getNextCourseWorkerTasks(wf, { reviewConcurrency: 0, totalConcurrency: 1 })
  assert.equal(tasks.some(task => task.type === 'write-node'), false, '上游未完成时不得开写下游')
})

test('review tasks respect the concurrency budget and skip blocked nodes', () => {
  const wf = workflow({
    lesson: {
      status: 'node_review',
      nodes: [
        node('n1', { status: 'node_review', draft: '草稿1', versions: [{}] }),
        node('n2', { status: 'node_review', draft: '草稿2', versions: [{}] }),
        node('n3', { status: 'node_review', draft: '草稿3', versions: [{}], blockedByNodeIds: ['n1'] })
      ]
    }
  })
  const tasks = getNextCourseWorkerTasks(wf, { reviewConcurrency: 2, totalConcurrency: 2 })
  const reviews = tasks.filter(task => task.type === 'review-node')
  assert.equal(reviews.length, 2)
  assert.deepEqual(reviews.map(task => task.node.id), ['n1', 'n2'])
  assert.ok(!reviews.some(task => task.node.id === 'n3'), '被阻塞的节点不应派发审查')
})

test('revisions stop at the configured cap unless a human asked for one', () => {
  const capped = workflow({
    courseSpec: { maxAutoRevisions: 2 },
    lesson: {
      status: 'node_revision_required',
      nodes: [node('n1', { status: 'node_revision_required', revisionCount: 2, draft: '草稿' })]
    }
  })
  assert.equal(getNextCourseWorkerTask(capped).type, 'idle')

  const manual = workflow({
    courseSpec: { maxAutoRevisions: 2 },
    lesson: {
      status: 'node_revision_required',
      nodes: [node('n1', { status: 'node_revision_required', revisionCount: 9, manualRevisionRequested: true, draft: '草稿' })]
    }
  })
  assert.equal(getNextCourseWorkerTask(manual).type, 'revise-node')
})

test('a blocking revision preempts the writer, a local one does not', () => {
  const blocking = workflow({
    lesson: {
      status: 'node_revision_required',
      nodes: [
        node('n1', { status: 'node_revision_required', blocksDownstream: true, draft: '草稿', revisionCount: 0 }),
        node('n2')
      ]
    }
  })
  const blockingTasks = getNextCourseWorkerTasks(blocking, { reviewConcurrency: 0, totalConcurrency: 2 })
  assert.equal(blockingTasks[0].type, 'revise-node', '影响后文的修订应最优先')

  const local = workflow({
    lesson: {
      status: 'node_pending',
      nodes: [node('n1', { status: 'node_revision_required', draft: '草稿', revisionCount: 0 })]
    }
  })
  const localTasks = getNextCourseWorkerTasks(local, { reviewConcurrency: 0, totalConcurrency: 2 })
  assert.deepEqual(localTasks.map(task => task.type), ['revise-node'])
})

/** 单阶段状态下，顶层与课次的状态是一致的（否则会先命中节点分支） */
const atStatus = (status, lessonOver = {}) =>
  workflow({ status, lesson: { status, nodes: [], ...lessonOver } })

test('single-stage statuses map to their task type', () => {
  const cases = [
    ['preflight_required', 'idle'],
    ['outline_pending', 'generate-outline'],
    ['outline_review', 'idle'],
    ['outline_approved', 'plan-nodes'],
    ['assembly_pending', 'assemble'],
    ['final_revision_required', 'revise-final-note'],
    ['note_removed', 'idle'],
    ['node_human_review', 'idle']
  ]
  for (const [status, expected] of cases) {
    const task = getNextCourseWorkerTask(atStatus(status))
    assert.equal(task.type, expected, `${status} → ${expected}，实际 ${task.type}`)
  }
})

test('final review only runs when no current report exists', () => {
  const fresh = atStatus('final_review', {
    finalNote: { markdown: '拼装后的正文' },
    finalNoteVersions: [{}],
    finalReviewReports: []
  })
  assert.equal(getNextCourseWorkerTask(fresh).type, 'final-review')

  const alreadyReviewed = atStatus('final_review', {
    finalNote: { markdown: '拼装后的正文' },
    finalNoteVersions: [{}],
    finalReviewReports: [{ value: { reviewedDraftVersion: 1 } }]
  })
  assert.equal(getNextCourseWorkerTask(alreadyReviewed).type, 'reconcile-final-review', '已有对应版本的审查报告应直接对账')

  const staleReport = atStatus('final_review', {
    finalNote: { markdown: '拼装后的正文' },
    finalNoteVersions: [{}, {}],
    finalReviewReports: [{ value: { reviewedDraftVersion: 1 } }]
  })
  assert.equal(getNextCourseWorkerTask(staleReport).type, 'final-review', '报告对应的是旧版本，应重审')
})

test('a failed node surfaces as a retry wait rather than a silent idle', () => {
  const wf = workflow({
    lesson: { status: 'node_review', nodes: [node('n1', { status: 'node_failed' })] }
  })
  const task = getNextCourseWorkerTask(wf)
  assert.equal(task.type, 'idle')
  assert.equal(task.reason, 'waiting-node-retry')
  assert.equal(task.nodeId, 'n1')
})

test('lessons are processed in order and workerStatusPatch stamps the time', () => {
  const wf = {
    status: 'node_pending',
    courseSpec: { maxAutoRevisions: 2 },
    lessons: [
      { key: 'later', order: 3, status: 'completed' },
      { key: 'first', order: 1, status: 'node_pending', nodes: [node('a')] }
    ]
  }
  assert.equal(getNextCourseWorkerTask(wf).lessonKey, 'first')

  const patch = workerStatusPatch({ online: false, message: '维护中' })
  assert.equal(patch.status, 'offline')
  assert.equal(patch.message, '维护中')
  assert.ok(!Number.isNaN(Date.parse(patch.lastSeenAt)))
})
