import assert from 'node:assert/strict'
import test from 'node:test'

import { applyTaskAction, createInitialLesson, runLessonNotes } from './pipeline.mjs'

const transcript = (lines) => Array.from({ length: lines }, (_, i) => `第 ${i + 1} 行课堂内容`).join('\n')

const OUTLINE = {
  mainLine: '从甲的成立条件讲到乙的判断',
  outline: [
    { id: 'o1', title: '一、甲', lineRange: [1, 20], rationale: '先讲甲' },
    { id: 'o2', title: '二、乙', lineRange: [21, 40], rationale: '再讲乙' }
  ]
}

const SPLICE = {
  courseOverview: { coreQuestions: ['甲如何成立？'], shouldBeAbleTo: ['解释甲'], lectureThread: '短' },
  sectionSummaries: { o1: '短', o2: '短' },
  sectionQuizzes: { o1: [], o2: [] },
  knowledgeLink: { inheritsFrom: '上一课', laysGroundworkFor: [], nextLessonPreview: '下一课' },
  appendix: { terms: [] }
}

const PASS = {
  decision: 'approve',
  coverage: 90, grounding: 90, logic: 90, detail: 90, sourceCoverage: 90,
  summary: '通过',
  issues: []
}

/** 按角色分发的假模型；每个角色可以给一个值或一个函数。 */
function scriptedModel(handlers = {}) {
  const calls = []
  const counters = { writer: 0, revision: 0, reviewer: 0 }
  const defaults = {
    outline: () => OUTLINE,
    writer: () => ({ markdown: `第 ${++counters.writer} 个节点的正文，包含充分论证。` }),
    revision: () => ({ markdown: `修订后的正文 ${++counters.revision}。` }),
    finalRevision: () => ({ markdown: '# 整篇修订后的笔记\n\n第一节与第二节的术语已统一。' }),
    reviewer: () => PASS,
    finalReview: () => PASS,
    splicer: () => SPLICE
  }
  const callModel = async ({ role, prompt, config }) => {
    calls.push({ role, prompt, config })
    const handler = handlers[role] ?? defaults[role]
    if (!handler) throw new Error(`没有为角色 ${role} 准备响应`)
    const parsed = typeof handler === 'function' ? handler({ role, prompt, calls, counters }) : handler
    return { parsed, trace: { role, model: 'fake-model' } }
  }
  return { callModel, calls, counters }
}

const lesson = () => createInitialLesson({
  key: 'lesson-1',
  title: '第10-12节',
  transcript: transcript(40),
  blueprint: { mainLine: '从甲的成立条件讲到乙的判断' }
})

test('a clean run drives the lesson from transcript to a completed note', async () => {
  const { callModel, calls } = scriptedModel()
  const result = await runLessonNotes({ lesson: lesson(), courseSpec: {}, callModel, modelConfig: { apiKey: 'sk' } })

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.lesson.status, 'completed')
  assert.equal(result.lesson.nodes.length, 2)
  assert.deepEqual(result.lesson.nodes.map(n => n.status), ['node_approved', 'node_approved'])

  // 步骤顺序：大纲 → 切分 → 写两节 → 审两节 → 拼装 → 终审
  assert.deepEqual(result.steps.map(s => s.taskType), [
    'generate-outline', 'plan-nodes', 'write-node', 'write-node',
    'review-node', 'review-node', 'assemble', 'final-review'
  ])
  assert.deepEqual(calls.map(c => c.role), ['outline', 'writer', 'writer', 'reviewer', 'reviewer', 'splicer', 'finalReview'])

  const markdown = result.lesson.finalNote.markdown
  assert.ok(markdown.includes('第 1 个节点的正文'), '两节正文都必须在最终稿里')
  assert.ok(markdown.includes('第 2 个节点的正文'))
  assert.ok(!/\{\{[^}]+\}\}/.test(markdown), '不得残留占位符')
  assert.equal(result.lesson.qualityReport.decision, 'approve')
  assert.equal(result.lesson.finalNoteVersions.length, 1)
})

test('manual mode stops at the outline gate instead of auto-approving', async () => {
  const { callModel } = scriptedModel()
  const result = await runLessonNotes({
    lesson: lesson(),
    callModel,
    modelConfig: {},
    autoApproveOutline: false
  })
  assert.equal(result.stopReason, 'idle')
  assert.equal(result.idleDetail.reason, 'waiting-outline-approval')
  assert.equal(result.lesson.status, 'outline_review')
  assert.equal(result.lesson.nodes.length, 0, '未确认大纲前不应切分节点')
  assert.equal(result.lesson.outline.length, 2)
})

test('a revising review sends the node through one revision before approval', async () => {
  const reviewed = new Set()
  const { callModel, counters } = scriptedModel({
    reviewer: () => {
      counters.reviewer += 1
      if (counters.reviewer === 1) {
        return { ...PASS, decision: 'revise', coverage: 80, summary: '需要补充法条', issues: [{ severity: 'blocking', message: '缺少法条依据' }] }
      }
      return PASS
    }
  })

  const result = await runLessonNotes({ lesson: lesson(), callModel, modelConfig: {} })
  assert.equal(result.stopReason, 'completed')
  assert.equal(counters.revision, 1, '应恰好触发一次节点修订')
  assert.equal(result.lesson.nodes[0].revisionCount, 1)
  assert.ok(result.steps.some(step => step.taskType === 'revise-node'))
  assert.equal(result.lesson.nodes.every(n => n.status === 'node_approved'), true)
})

test('a draft based on an older version is refused rather than overwriting', () => {
  const base = lesson()
  base.nodes = [{ id: 'n1', versions: [{}, {}], draft: '当前第二版', status: 'node_review' }]
  const stale = applyTaskAction(base, {
    type: 'save-node-draft-worker', nodeId: 'n1', markdown: '基于第一版的结果', basedDraftVersion: 1
  }, {})
  assert.equal(stale.skipped, true)
  assert.equal(stale.note, 'skipped-stale-draft')
  assert.equal(stale.lesson.nodes[0].draft, '当前第二版', '过期结果不得覆盖当前草稿')

  const fresh = applyTaskAction(base, {
    type: 'save-node-draft-worker', nodeId: 'n1', markdown: '基于第二版的结果', basedDraftVersion: 2
  }, {})
  assert.equal(fresh.lesson.nodes[0].draft, '基于第二版的结果')
  assert.equal(fresh.lesson.nodes[0].versions.length, 3)
})

test('a final review that names a node routes the lesson back to that node', async () => {
  let finalReviews = 0
  const { callModel } = scriptedModel({
    finalReview: () => {
      finalReviews += 1
      if (finalReviews === 1) {
        return {
          ...PASS,
          decision: 'revise',
          summary: '第一节与第二节对同一术语的用法不一致',
          issues: [{ severity: 'blocking', message: '第一节的术语与第二节冲突', nodeId: 'o1-node-1' }]
        }
      }
      return PASS
    }
  })

  const result = await runLessonNotes({ lesson: lesson(), callModel, modelConfig: {} })
  assert.equal(result.stopReason, 'completed')
  assert.equal(finalReviews, 2, '应当重新终审一次')
  const steps = result.steps.map(step => step.taskType)
  assert.ok(steps.includes('revise-node'), '应把被点名的节点退回修订')
  assert.ok(steps.lastIndexOf('assemble') > steps.indexOf('final-review'), '修订后需要重新拼装')
  assert.equal(result.lesson.status, 'completed')
})

test('an unmappable final review consumes the whole-note revision budget then passes with warnings', async () => {
  let finalReviews = 0
  const { callModel } = scriptedModel({
    finalReview: () => {
      finalReviews += 1
      if (finalReviews === 1) {
        return { ...PASS, decision: 'revise', summary: '整体结构需要调整', issues: [{ severity: 'blocking', message: '跨节点重复较多' }] }
      }
      return { ...PASS, decision: 'revise', summary: '仍有重复', issues: [{ severity: 'blocking', message: '仍然重复' }] }
    }
  })

  const result = await runLessonNotes({ lesson: lesson(), callModel, modelConfig: {} })
  // 第一次退回整篇修订，第二次超出 maxFinalAutoRevisions 后带警告放行
  assert.ok(result.steps.some(step => step.taskType === 'revise-final-note'))
  assert.equal(result.lesson.status, 'completed')
  assert.equal(result.lesson.qualityReport.autoAcceptedWithWarnings, true)
  assert.equal(result.lesson.finalRevisionCount, 1)
})

test('the loop stops at maxSteps instead of running forever', async () => {
  const { callModel } = scriptedModel({ reviewer: () => ({ ...PASS, decision: 'revise', issues: [{ severity: 'important', message: '继续改' }] }) })
  const result = await runLessonNotes({ lesson: lesson(), callModel, modelConfig: {}, maxSteps: 5 })
  assert.equal(result.stopReason, 'max-steps')
  assert.equal(result.steps.length, 5)
})

test('the pipeline refuses a lesson without a transcript', async () => {
  await assert.rejects(
    () => runLessonNotes({ lesson: createInitialLesson({ key: 'k', title: 't', transcript: '' }) }),
    /缺少转录稿/
  )
})

test('unsupported actions fail loudly rather than being ignored', () => {
  assert.throws(() => applyTaskAction(lesson(), { type: 'teleport' }, {}), /无法应用的动作类型：teleport/)
  assert.equal(applyTaskAction(lesson(), null, {}).note, 'no-action')
})
