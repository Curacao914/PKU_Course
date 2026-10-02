import assert from 'node:assert/strict'
import test from 'node:test'

import { collectExceptions, formatExceptions } from './reconcile.mjs'

/**
 * C2：无人值守下的"只报异常"。
 *
 * 核心断言是**安静**：没有异常时既没有输出、也没有通知。天天报正常，第四天真出事时没人看。
 */

test('一切正常时完全安静（没有异常、没有告警文案）', () => {
  const report = collectExceptions({ stuckTasks: [], failedDeliveries: [], stuckDeliveries: 0, artifacts: { items: [] }, missingMaterials: [] })
  assert.equal(report.quiet, true)
  assert.equal(report.blocking, false)
  assert.deepEqual(report.exceptions, [])
  assert.equal(formatExceptions(report), '', '没有异常就不该有任何文案')
})

test('阻塞项：卡住的任务、失败的通知、过期的投递、缺课件', () => {
  const report = collectExceptions({
    stuckTasks: [{ courseName: '刑法分论', lessonTitle: '第1节', stage: 'needs_attention' }],
    failedDeliveries: [{ dedupe_key: 'course-note:x:1', last_error: '通道不可用' }],
    stuckDeliveries: 2,
    missingMaterials: [{ courseName: '国际刑法学', lessonTitle: '第3节' }]
  })
  assert.equal(report.quiet, false)
  assert.equal(report.blocking, true)
  assert.equal(report.counts.blocking, 4)
  assert.deepEqual(report.exceptions.map(item => item.code).sort(), ['delivery-failed', 'delivery-stuck', 'materials-missing', 'task-stuck'])
  const text = formatExceptions(report)
  assert.match(text, /需要处理：4 项阻塞/)
  assert.match(text, /刑法分论·第1节（needs_attention）/, '要带上"哪一节、停在哪一步"')
})

test('源修订漂移只提醒，但要明确提示 republish 风险', () => {
  const report = collectExceptions({
    sourceRevisions: {
      items: [
        { status: 'source-state-drift', courseName: '刑事执行法', lessonTitle: '2026-09-21第5-6节' },
        { status: 'unpublished-change', courseName: '商法概论', lessonTitle: '2026-09-20第2-4节' },
        { status: 'fresh', courseName: '国际刑法学', lessonTitle: '2026-09-23第5-6节' }
      ]
    }
  })
  assert.equal(report.blocking, false)
  assert.equal(report.counts.warning, 2)
  assert.deepEqual(report.exceptions.map(item => item.code).sort(), ['source-state-drift', 'source-unpublished'])
  const text = formatExceptions(report)
  assert.match(text, /直接 republish 可能把旧内容覆盖回来/)
  assert.match(text, /尚未发布的修订/)
})

test('semantic index 未绑定或过期要单独提醒；历史 brief 的 unbound 继续保持安静', () => {
  const unbound = collectExceptions({
    artifacts: {
      items: [
        { kind: 'brief', status: 'unbound', courseName: '刑事执行法', lessonTitle: '历史课次' },
        { kind: 'semantic-index', status: 'unbound', courseName: '', lessonTitle: '' }
      ]
    }
  })
  assert.equal(unbound.blocking, false)
  assert.equal(unbound.counts.warning, 1)
  assert.equal(unbound.exceptions[0].code, 'semantic-index-unbound')
  assert.match(unbound.exceptions[0].detail, /course embed/)

  const stale = collectExceptions({
    artifacts: {
      items: [
        { kind: 'semantic-index', status: 'stale', courseName: '', lessonTitle: '' },
        { kind: 'brief', status: 'stale', courseName: '刑法', lessonTitle: '第1节' }
      ]
    }
  })
  assert.equal(stale.counts.warning, 2)
  assert.deepEqual(
    stale.exceptions.map(item => item.code).sort(),
    ['artifact-stale', 'semantic-index-stale']
  )
  assert.equal(stale.exceptions.find(item => item.code === 'artifact-stale').count, 1, 'semantic stale 不应再被通用 artifact-stale 重复计数')
})

test('提醒项：产物过期与余额偏低只提醒，不算阻塞', () => {
  const report = collectExceptions({
    artifacts: { items: [{ status: 'stale', kind: 'brief', courseName: '商法概论', lessonTitle: '第2-4节' }, { status: 'fresh', kind: 'onepage' }] },
    lowBalance: { provider: 'DeepSeek', amount: 3.2 }
  })
  assert.equal(report.blocking, false, '这两项不该让定时任务报失败')
  assert.equal(report.counts.warning, 2)
  assert.deepEqual(report.exceptions.map(item => item.code).sort(), ['artifact-stale', 'balance-low'])
  assert.match(formatExceptions(report), /1 件派生产物与正文不同源/)
})
