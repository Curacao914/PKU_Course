import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openLedger } from './ledger.mjs'
import { MIGRATIONS } from './schema.mjs'

const REPLAY = {
  replay_key: 'replay-abc',
  course_key: 'course-1',
  course_name: '刑法分论',
  title: '2026-05-27第10-12节',
  starts_at_text: '2026-05-27 13:00',
  teacher: '车浩'
}

function ledger() {
  return openLedger(':memory:')
}

test('discoverReplays is idempotent and never resets progress', () => {
  const db = ledger()
  // created 报出"新增了哪几条"：发现新课要据此提醒用户上传课件，光有计数不够用
  assert.deepEqual(db.discoverReplays([REPLAY]), {
    inserted: 1,
    existing: 0,
    created: [{ replayKey: 'replay-abc', courseName: '刑法分论', title: '2026-05-27第10-12节' }]
  })
  assert.deepEqual(db.discoverReplays([REPLAY]), { inserted: 0, existing: 1, created: [] })

  const task = db.getTask('replay-abc')
  db.reportStage({ id: task.id, stage: 'downloaded', message: '媒体就绪' })
  db.discoverReplays([{ ...REPLAY, title: '标题变了' }])

  const after = db.getTask('replay-abc')
  assert.equal(after.stage, 'downloaded', '重复发现不得把阶段退回')
  assert.equal(after.title, '标题变了', '展示字段应当刷新')
  assert.equal(db.listTasks().length, 1)
  db.close()
})

test('a partial rediscovery fills gaps instead of wiping stored fields', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  // 只带部分字段的重复登记（例如另一次扫描只返回了课程名）
  db.discoverReplays([{ replay_key: 'replay-abc', course_key: 'course-1', course_name: '刑法分论（新）' }])

  const task = db.getTask('replay-abc')
  assert.equal(task.course_name, '刑法分论（新）', '新值应当覆盖')
  assert.equal(task.title, REPLAY.title, '未提供的字段不得被清空')
  assert.equal(task.teacher, REPLAY.teacher)
  assert.equal(task.starts_at_text, REPLAY.starts_at_text)
  db.close()
})

test('discoverReplays rejects incomplete records', () => {
  const db = ledger()
  assert.throws(() => db.discoverReplays([{ replay_key: 'x' }]), /需要 replay_key 与 course_key/)
  db.close()
})

test('claimNext leases a task, hides it from other workers, then expires', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const t0 = '2026-09-25T00:00:00.000Z'

  const first = db.claimNext({ workerId: 'w1', leaseSeconds: 60, now: t0 })
  assert.equal(first.replay_key, 'replay-abc')
  assert.equal(first.claimed_by, 'w1')
  assert.equal(first.attempts, 1)

  assert.equal(db.claimNext({ workerId: 'w2', leaseSeconds: 60, now: t0 }), null, '租约内不得被抢')

  const later = '2026-09-25T00:02:00.000Z'
  const second = db.claimNext({ workerId: 'w2', leaseSeconds: 60, now: later })
  assert.equal(second.claimed_by, 'w2', '租约过期后应可重新领取')
  assert.equal(second.attempts, 2)
  db.close()
})

test('claimNext requires a worker id and returns null when nothing is actionable', () => {
  const db = ledger()
  assert.throws(() => db.claimNext({}), /需要 workerId/)
  assert.equal(db.claimNext({ workerId: 'w1' }), null)
  db.close()
})

test('claimTask targets one replay and explains every refusal', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const t0 = '2026-09-25T00:00:00.000Z'

  assert.equal(db.claimTask({ replayKey: 'nope', workerId: 'w1' }).reason, 'not_found')

  const ok = db.claimTask({ replayKey: 'replay-abc', workerId: 'w1', now: t0 })
  assert.equal(ok.claimed, true)
  assert.equal(ok.task.claimed_by, 'w1')

  assert.equal(db.claimTask({ replayKey: 'replay-abc', workerId: 'w2', now: t0 }).reason, 'leased')

  const task = ok.task
  db.reportStage({ id: task.id, stage: 'downloaded', nextAttemptAt: '2026-09-25T00:05:00.000Z' })
  assert.equal(
    db.claimTask({ replayKey: 'replay-abc', workerId: 'w1', now: '2026-09-25T00:01:00.000Z' }).reason,
    'backoff'
  )
  assert.equal(
    db.claimTask({ replayKey: 'replay-abc', workerId: 'w1', now: '2026-09-25T00:06:00.000Z' }).claimed,
    true
  )

  db.reportStage({ id: task.id, stage: 'completed' })
  assert.equal(db.claimTask({ replayKey: 'replay-abc', workerId: 'w1' }).reason, 'terminal:completed')
  db.close()
})

test('the same worker may renew its own lease instead of being locked out', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const t0 = '2026-09-25T00:00:00.000Z'

  const first = db.claimTask({ replayKey: 'replay-abc', workerId: 'w1', now: t0 })
  assert.equal(first.claimed, true)

  // 编排循环会先领取，再调用内部还会领取一次的阶段命令
  const again = db.claimTask({ replayKey: 'replay-abc', workerId: 'w1', now: t0 })
  assert.equal(again.claimed, true, '同一 worker 重复领取应视为续租')
  assert.equal(again.task.claimed_by, 'w1')

  // 但仍然挡住别人
  assert.equal(db.claimTask({ replayKey: 'replay-abc', workerId: 'w2', now: t0 }).reason, 'leased')
  db.close()
})

test('heartbeat only extends the lease held by the same worker', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.claimNext({ workerId: 'w1', leaseSeconds: 60, now: '2026-09-25T00:00:00.000Z' })
  assert.equal(db.heartbeat({ id: task.id, workerId: 'w1', leaseSeconds: 600, now: '2026-09-25T00:00:30.000Z' }), true)
  assert.equal(db.heartbeat({ id: task.id, workerId: 'w2', leaseSeconds: 600 }), false)

  const extended = db.getTask('replay-abc')
  assert.equal(extended.lease_expires_at, '2026-09-25T00:10:30.000Z')
  db.close()
})

test('reportStage releases the lease, records an event and merges artifacts', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.claimNext({ workerId: 'w1' })
  const updated = db.reportStage({
    id: task.id,
    stage: 'transcript_ready',
    message: '转录完成',
    data: { artifacts: { transcriptPath: '/x/raw-transcript.md' }, runtime: { durationSeconds: 10785.6 } }
  })

  assert.equal(updated.stage, 'transcript_ready')
  assert.equal(updated.claimed_by, '', '提交后应释放租约')
  assert.equal(updated.lease_expires_at, null)
  assert.equal(updated.artifacts.transcriptPath, '/x/raw-transcript.md')
  assert.equal(updated.runtime.durationSeconds, 10785.6)

  const events = db.events(task.id)
  assert.equal(events.length, 1)
  assert.equal(events[0].stage, 'transcript_ready')
  assert.equal(events[0].message, '转录完成')

  // 阶段推进后可以立刻被重新领取
  assert.equal(db.claimNext({ workerId: 'w2' }).stage, 'transcript_ready')
  db.close()
})

test('terminal stages are never claimed again and errors survive', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.claimNext({ workerId: 'w1' })
  db.reportStage({ id: task.id, stage: 'needs_attention', error: 'AUTH_EXPIRED' })
  assert.equal(db.claimNext({ workerId: 'w1' }), null)

  const stored = db.getTask('replay-abc')
  assert.equal(stored.last_error, 'AUTH_EXPIRED')
  assert.equal(db.countTasks().find(row => row.stage === 'needs_attention').n, 1)
  db.close()
})

test('a published task is no longer claimed by the worker', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.claimNext({ workerId: 'w1' })
  db.reportStage({ id: task.id, stage: 'published' })
  assert.equal(db.claimNext({ workerId: 'w1' }), null, '发布完成后不应再被领取')
  assert.equal(db.getTask('replay-abc').stage, 'published', '阶段本身保留，只是不再可领取')
  db.close()
})

test('rejected stages and unknown tasks fail loudly', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.getTask('replay-abc')
  assert.throws(() => db.reportStage({ id: task.id, stage: 'made-up' }), /未知阶段/)
  assert.throws(() => db.reportStage({ id: 999, stage: 'queued' }), /任务不存在/)
  db.close()
})

test('a failed stage can be retried after next_attempt_at passes', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.claimNext({ workerId: 'w1', now: '2026-09-25T00:00:00.000Z' })
  db.reportStage({
    id: task.id,
    stage: 'downloading',
    error: 'upstream 503',
    nextAttemptAt: '2026-09-25T00:05:00.000Z'
  })
  assert.equal(db.claimNext({ workerId: 'w1', now: '2026-09-25T00:01:00.000Z' }), null, '退避期内不应重试')
  assert.equal(db.claimNext({ workerId: 'w1', now: '2026-09-25T00:06:00.000Z' }).stage, 'downloading')
  db.close()
})

test('a successful stage advance clears the consecutive-failure counter', () => {
  // attempts 的语义是"当前阶段连续失败了几次"，不是"一生失败过几次"。
  // 否则一节在欠费期失败多次、之后正常跑通的课，会被"连续失败到上限就停下"的闸门误判。
  const db = ledger()
  db.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-1', course_name: '刑事执行法', title: '第5-6节' }])
  const task = db.claimTask({ replayKey: 'replay-1', workerId: 'w1' }).task
  db.reportStage({ id: task.id, stage: 'downloaded', error: 'Arrearage' })
  const claimed = db.claimTask({ replayKey: 'replay-1', workerId: 'w1' })
  assert.equal(claimed.task.attempts, 2, '连续失败要累计')

  db.reportStage({ id: task.id, stage: 'transcript_ready', message: '转录完成' })
  assert.equal(db.getTask('replay-1').attempts, 0, '成功之后清零，下一阶段从零开始数')
})

test('a failed task can be reset back into the queue', () => {
  // needs_attention 之后必须有回来的路：只把阶段改成"等人处理"而没有恢复手段，
  // 等于把课次永久钉死，比继续重试更糟。
  const db = ledger()
  db.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-1', course_name: '刑法分论', title: '第1-2节' }])
  const task = db.claimTask({ replayKey: 'replay-1', workerId: 'w1' }).task
  db.reportStage({ id: task.id, stage: 'needs_attention', error: '连续失败 5 次' })
  assert.equal(db.getTask('replay-1').stage, 'needs_attention')

  const reset = db.resetTask({ replayKey: 'replay-1', stage: 'transcript_ready' })
  assert.equal(reset.stage, 'transcript_ready')
  assert.equal(reset.attempts, 0, '失败计数归零')
  assert.equal(reset.last_error, '')
  assert.equal(db.claimTask({ replayKey: 'replay-1', workerId: 'w2' }).claimed, true, '重置后能重新领取')

  assert.throws(() => db.resetTask({ replayKey: 'nope' }), /任务不存在/)
  assert.throws(() => db.resetTask({}), /需要 replayKey/)
  assert.throws(() => db.resetTask({ replayKey: 'replay-1', stage: '不存在的阶段' }), /阶段/)
})

test('failed deliveries can be revived instead of disappearing silently', () => {
  const db = ledger()
  const queued = db.enqueueDelivery({ dedupeKey: 'k1', purpose: 'course-note', bodyText: 'x', objectUrl: '/n.html' })
  assert.equal(queued.inserted, true)
  const claimed = db.claimDelivery({ workerId: 'relay' })
  db.ackDelivery({ id: claimed.id, status: 'failed', error: '网关不通' })
  assert.deepEqual(db.countDeliveries(), { failed: 1 })

  const failed = db.listDeliveries({ status: 'failed' })
  assert.equal(failed.length, 1)
  assert.equal(failed[0].last_error, '网关不通')

  const revived = db.reviveFailedDeliveries()
  assert.equal(revived.revived, 1)
  assert.equal(db.claimDelivery({ workerId: 'relay' }).dedupe_key, 'k1', '重发后能重新领取')
  assert.equal(db.listDeliveries({ status: 'failed' }).length, 0)
})

test('deliveries dedupe by key and follow pending → claimed → sent', () => {
  const db = ledger()
  const first = db.enqueueDelivery({
    dedupeKey: 'course-brief:job-1:lesson-1',
    purpose: 'course-brief',
    bodyText: '刑法分论 第10-12节 笔记已更新',
    objectUrl: 'https://course.law-tech.dev/notes/xingfa/lesson-10',
    scheduledFor: '2026-09-25T00:00:00.000Z'
  })
  assert.equal(first.inserted, true)

  const duplicate = db.enqueueDelivery({
    dedupeKey: 'course-brief:job-1:lesson-1',
    purpose: 'course-brief',
    bodyText: '换一段文案也不该产生第二条',
    scheduledFor: '2026-09-25T00:00:00.000Z'
  })
  assert.equal(duplicate.inserted, false)
  assert.equal(duplicate.delivery.body_text, '刑法分论 第10-12节 笔记已更新')

  assert.equal(db.claimDelivery({ workerId: 'relay-1', now: '2026-09-24T23:59:00.000Z' }), null, '未到时间不领取')
  const claimed = db.claimDelivery({ workerId: 'relay-1', now: '2026-09-25T00:00:01.000Z' })
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.attempts, 1)
  assert.equal(db.claimDelivery({ workerId: 'relay-2', now: '2026-09-25T00:00:02.000Z' }), null, '已被领取')

  assert.equal(db.ackDelivery({ id: claimed.id, status: 'sent', externalId: 'wx-1', now: '2026-09-25T00:00:03.000Z' }), true)
  assert.equal(db.claimDelivery({ workerId: 'relay-1', now: '2026-09-25T00:01:00.000Z' }), null, '已发送不再领取')
  db.close()
})

test('delivery enqueue validates its inputs', () => {
  const db = ledger()
  assert.throws(() => db.enqueueDelivery({ dedupeKey: 'a', purpose: 'b' }), /dedupeKey、purpose 与 bodyText/)
  db.close()
})

test('同一 worker 再次领取 = 续租，不算新的一次尝试（否则一次失败会被记成好几次）', () => {
  // 真实链路里每一步都会走到这里：编排循环先 claimNext() 领一次，
  // 随后各阶段子命令内部再 claimForRun() 领一次。每次都 attempts+=1 的话，
  // 一次真正的失败会被记成两三次，"连续失败到上限就停下"的闸门于是提前触发。
  const db = ledger()
  db.discoverReplays([REPLAY])
  const claimed = db.claimNext({ workerId: 'w1', leaseSeconds: 900, now: '2026-09-25T00:00:00.000Z' })
  assert.equal(claimed.attempts, 1, '第一次领取算一次尝试')

  const again = db.claimTask({ replayKey: REPLAY.replay_key, workerId: 'w1', leaseSeconds: 900, now: '2026-09-25T00:00:05.000Z' })
  assert.equal(again.claimed, true)
  assert.equal(again.reason, 'renewed', '同一 worker 的有效租约是续租')
  assert.equal(again.task.attempts, 1, '续租不得再累加 attempts')

  // 别的 worker 在同一时间仍然领不走
  const other = db.claimTask({ replayKey: REPLAY.replay_key, workerId: 'w2', leaseSeconds: 900, now: '2026-09-25T00:00:06.000Z' })
  assert.equal(other.claimed, false)
  assert.equal(other.reason, 'leased')

  // 租约过期之后：算新的一次尝试
  const afterExpiry = db.claimTask({ replayKey: REPLAY.replay_key, workerId: 'w1', leaseSeconds: 900, now: '2026-09-25T01:00:00.000Z' })
  assert.equal(afterExpiry.claimed, true)
  assert.equal(afterExpiry.reason, 'claimed')
  assert.equal(afterExpiry.task.attempts, 2, '租约过期后重新领取才算新的一次')
  db.close()
})

test('连续失败计数：一次失败只 +1（cycle 领一次 + 子命令续租，不重复计）', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const task = db.claimNext({ workerId: 'w1', now: '2026-09-25T00:00:00.000Z' })
  // 模拟 download 子命令内部再领一次（claimForRun 的路径），然后失败
  db.claimTask({ replayKey: REPLAY.replay_key, workerId: 'w1', now: '2026-09-25T00:00:01.000Z' })
  db.reportStage({ id: task.id, stage: 'downloading', error: '教学网登录失败', now: '2026-09-25T00:00:02.000Z' })
  assert.equal(db.getTask(REPLAY.replay_key).attempts, 1, '一次真实失败只能增加一次')

  // 第二轮：失败后任务仍停在可执行的 downloading 阶段（真实链路就是这样重试的），
  // 再领一次、子命令续租、再失败 → 2
  db.claimNext({ workerId: 'w1', now: '2026-09-25T00:11:00.000Z' })
  db.claimTask({ replayKey: REPLAY.replay_key, workerId: 'w1', now: '2026-09-25T00:11:01.000Z' })
  db.reportStage({ id: task.id, stage: 'downloading', error: '教学网登录失败', now: '2026-09-25T00:11:02.000Z' })
  assert.equal(db.getTask(REPLAY.replay_key).attempts, 2, '两次失败 = 2，不是 4')

  // 成功一次就清零（语义：当前阶段连续失败次数）
  db.reportStage({ id: task.id, stage: 'downloaded', now: '2026-09-25T00:12:00.000Z' })
  assert.equal(db.getTask(REPLAY.replay_key).attempts, 0)
  db.close()
})

test('投递租约：领取后进程挂掉，租约过期会被重新领取（通知不会静默消失）', () => {
  const db = ledger()
  db.enqueueDelivery({ dedupeKey: 'note:1', purpose: 'course-note', bodyText: '正文', scheduledFor: '2026-09-25T00:00:00.000Z' })

  const first = db.claimDelivery({ workerId: 'w1', leaseSeconds: 600, now: '2026-09-25T00:00:00.000Z' })
  assert.equal(first.status, 'claimed')
  assert.equal(first.attempts, 1)
  assert.ok(first.lease_expires_at, '领取时要写租约到期时间')

  // 租约内别人领不到，也不算卡住
  assert.equal(db.claimDelivery({ workerId: 'w2', now: '2026-09-25T00:05:00.000Z' }), null)
  assert.equal(db.countStuckDeliveries({ now: '2026-09-25T00:05:00.000Z' }), 0)

  // 租约过期：同一条被重新领取，attempts 继续累加（不会无限重发）
  const again = db.claimDelivery({ workerId: 'w2', now: '2026-09-25T00:11:00.000Z' })
  assert.equal(again.id, first.id)
  assert.equal(again.attempts, 2)

  // 记录结果时释放租约：这条投递就此结束，不再出现在任何队列里
  db.ackDelivery({ id: again.id, status: 'sent', now: '2026-09-25T00:11:05.000Z' })
  const settled = db.findDelivery('note:1')
  assert.equal(settled.status, 'sent')
  assert.equal(settled.lease_expires_at, null)
  assert.equal(db.claimDelivery({ workerId: 'w3', now: '2026-09-26T00:00:00.000Z' }), null, '已发送的不该再被领取')
  db.close()
})

test('卡住的投递能被看见：claimed 且租约过期就计数', () => {
  const db = ledger()
  db.enqueueDelivery({ dedupeKey: 'note:2', purpose: 'course-note', bodyText: '正文', scheduledFor: '2026-09-25T00:00:00.000Z' })
  db.claimDelivery({ workerId: 'w1', leaseSeconds: 60, now: '2026-09-25T00:00:00.000Z' })
  assert.equal(db.countStuckDeliveries({ now: '2026-09-25T00:00:30.000Z' }), 0)
  assert.equal(db.countStuckDeliveries({ now: '2026-09-25T00:02:00.000Z' }), 1, '管理台据此回答：是不是有通知发丢了')
  db.close()
})

test('账本迁移：老库打开时自动补上投递租约列，且可重复打开', () => {
  // 老库的形状：deliveries 里没有 lease_expires_at（CREATE TABLE IF NOT EXISTS 不会补列）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-ledger-migrate-'))
  const file = path.join(dir, 'ledger.sqlite')
  const raw = new DatabaseSync(file)
  raw.exec(`CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL,
    body_text TEXT NOT NULL, object_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, external_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
    scheduled_for TEXT NOT NULL, claimed_at TEXT, claimed_by TEXT NOT NULL DEFAULT '', sent_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  raw.close()

  const migrated = openLedger(file)
  const columns = migrated.db.prepare('PRAGMA table_info(deliveries)').all().map(row => row.name)
  assert.ok(columns.includes('lease_expires_at'), '打开老库时补列：投递租约')
  assert.ok(columns.includes('claim_token'), '打开老库时补列：认领令牌')
  // 版本号必须等于**最后一条**迁移的版本（每加一条迁移就 +1，migrate 用 version > user_version 判断）
  const version = Number(migrated.db.prepare('PRAGMA user_version').get().user_version)
  assert.equal(version, MIGRATIONS.at(-1).version)
  migrated.close()

  const reopened = openLedger(file)
  assert.equal(Number(reopened.db.prepare('PRAGMA user_version').get().user_version), version, '重复打开是幂等的')
  reopened.close()
})

test('busy_timeout 已设置：worker、站点、CLI 同时写账本时不至于直接报 SQLITE_BUSY', () => {
  const db = ledger()
  assert.equal(db.db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
  db.close()
})

test('a file-backed ledger survives reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-ledger-'))
  const file = path.join(dir, 'nested', 'ledger.sqlite')
  const first = openLedger(file)
  first.discoverReplays([REPLAY])
  const task = first.claimNext({ workerId: 'w1' })
  first.reportStage({ id: task.id, stage: 'published' })
  first.close()

  const second = openLedger(file)
  assert.equal(second.getTask('replay-abc').stage, 'published')
  assert.equal(second.events(task.id).length, 1)
  second.close()
})
test('投递认领令牌：租约过期被重新领取后，旧领取者的 ack/retry 不再生效', () => {
  const ledger = openLedger(':memory:')
  const { delivery } = ledger.enqueueDelivery({
    dedupeKey: 'course-note:x:1', purpose: 'course-note', bodyText: '正文', objectUrl: 'https://x/1.html',
    now: '2026-09-25T00:00:00.000Z'
  })

  // A 领取（租约 60 秒）
  const a = ledger.claimDelivery({ workerId: 'A', leaseSeconds: 60, now: '2026-09-25T00:00:10.000Z' })
  assert.ok(a.claim_token, '领取时必须给出认领令牌')

  // 租约过期后 B 重新领取 → 令牌换人
  const b = ledger.claimDelivery({ workerId: 'B', leaseSeconds: 60, now: '2026-09-25T00:05:00.000Z' })
  assert.equal(b.id, a.id)
  assert.notEqual(b.claim_token, a.claim_token, '重新领取必须换令牌')

  // A 醒过来 ack：令牌已过期 → 不写、返回 false（否则会把 B 的结果覆盖掉）
  assert.equal(ledger.ackDelivery({ id: a.id, status: 'sent', externalId: 'A 的', now: '2026-09-25T00:05:01.000Z', token: a.claim_token }), false)
  assert.equal(ledger.findDelivery('course-note:x:1').status, 'claimed', 'A 的 ack 不该改状态')
  assert.equal(ledger.retryDelivery({ id: a.id, error: 'A 的失败', now: '2026-09-25T00:05:02.000Z', token: a.claim_token }), false)

  // B 用当前令牌 ack：成功
  assert.equal(ledger.ackDelivery({ id: b.id, status: 'sent', externalId: 'B 的', now: '2026-09-25T00:05:03.000Z', token: b.claim_token }), true)
  const final = ledger.findDelivery('course-note:x:1')
  assert.equal(final.status, 'sent')
  assert.equal(final.external_id, 'B 的')
  ledger.close()
})

test('长任务续租：阶段上报顺手续租，且只续自己领的那条', () => {
  const db = ledger()
  db.discoverReplays([REPLAY])
  const claimed = db.claimNext({ workerId: 'W', leaseSeconds: 600, now: '2026-09-25T00:00:00.000Z' })
  const before = claimed.lease_expires_at

  // 跑了半小时之后续租：期限必须往后推（否则长任务会被别人抢走重跑，模型调两次、钱付两次）
  assert.equal(db.renewTaskLease({ id: claimed.id, workerId: 'W', leaseSeconds: 1800, now: '2026-09-25T00:30:00.000Z' }), true)
  const after = db.getTask(claimed.replay_key).lease_expires_at
  assert.ok(new Date(after) > new Date(before), `租约要往后推：${before} → ${after}`)

  // 别人来续：不许替别人延长期限
  assert.equal(db.renewTaskLease({ id: claimed.id, workerId: 'X', leaseSeconds: 99999, now: '2026-09-25T02:00:00.000Z' }), false)
  assert.equal(db.getTask(claimed.replay_key).lease_expires_at, after, '不是自己的任务就不续租')

  // 没传 workerId 也不续（避免"谁都能延长"）
  assert.equal(db.renewTaskLease({ id: claimed.id, now: '2026-09-25T03:00:00.000Z' }), false)

  // 阶段上报即交还租约（既有语义，别在这里偷偷续租——那会让下一个阶段领不到）
  db.reportStage({ id: claimed.id, stage: 'notes_ready', message: '写完', now: '2026-09-25T04:00:00.000Z' })
  assert.equal(db.getTask(claimed.replay_key).lease_expires_at, null)
  db.close()
})


test('Blackboard JVM rotation relinks OWNER replay without resetting artifacts or task events', () => {
  const db = ledger()
  const old = { ...REPLAY, replay_key: 'replay-jvm-old', course_key: 'course-jvm-old' }
  db.discoverReplays([old])
  const before = db.getTask(old.replay_key)
  db.reportStage({ id: before.id, stage: 'transcript_ready',
    data: { artifacts: { mediaPath: '/legacy/replays/replay-jvm-old/media.mp4',
      transcriptPath: '/legacy/replays/replay-jvm-old/transcript.md' } } })
  const rotated = { ...old, replay_key: 'replay-pk-stable', course_key: 'course-pk-stable' }
  const discovery = db.discoverReplays([rotated])
  assert.equal(discovery.inserted, 0)
  assert.equal(discovery.existing, 1)
  assert.deepEqual(discovery.relinked.map(item => item.replayKey), [old.replay_key])
  const after = db.getTask(old.replay_key)
  assert.equal(after.id, before.id)
  assert.equal(after.stage, 'transcript_ready')
  assert.equal(after.source_replay_key, rotated.replay_key)
  assert.equal(after.course_key, rotated.course_key)
  assert.match(after.artifacts.transcriptPath, /replay-jvm-old/)
  assert.equal(db.getTask(rotated.replay_key), null)
  assert.equal(db.listTasks().length, 1)
  assert.equal(db.discoverReplays([rotated]).existing, 1)
  assert.equal(db.listTasks().length, 1)
  db.close()
})

test('legacy replay mapping never crosses MEMBER/OWNER scopes', () => {
  const db = ledger()
  const a = '11111111-2222-4333-8444-555555555555'
  const b = '22222222-3333-4444-8555-666666666666'
  const old = { ...REPLAY, replay_key: 'replay-old-scope', course_key: 'course-old-scope' }
  db.discoverReplays([old])
  db.discoverReplays([old], { ownerId: a, resourceClass: 'member' })
  db.discoverReplays([old], { ownerId: b, resourceClass: 'member' })
  const next = { ...old, replay_key: 'replay-new-scope', course_key: 'course-new-scope' }
  db.discoverReplays([next], { ownerId: a, resourceClass: 'member' })
  assert.equal(db.getTask(a + '::replay-old-scope').source_replay_key, next.replay_key)
  assert.equal(db.getTask(b + '::replay-old-scope').source_replay_key, old.replay_key)
  assert.equal(db.getTask('replay-old-scope').source_replay_key, old.replay_key)
  assert.deepEqual(db.courseKeyAliases({ ownerId: a, resourceClass: 'member', courseName: old.course_name }), [next.course_key])
  db.close()
})

test('ambiguous historic course replay identities fail closed and roll back', () => {
  const db = ledger()
  db.discoverReplays([{ ...REPLAY, replay_key: 'replay-old-1', course_key: 'course-legacy-1' }])
  db.discoverReplays([{ ...REPLAY, replay_key: 'replay-old-2', course_key: 'course-legacy-2' }])
  assert.throws(() => db.discoverReplays([{ ...REPLAY,
    replay_key: 'replay-new', course_key: 'course-stable' }]), /身份存在歧义/)
  assert.equal(db.getTask('replay-new'), null)
  assert.equal(db.listTasks().length, 2)
  db.close()
})

test('incomplete recording metadata is never used for identity reattachment', () => {
  const db = ledger()
  db.discoverReplays([{ ...REPLAY, replay_key: 'replay-old-empty-teacher', teacher: '' }])
  const result = db.discoverReplays([{ ...REPLAY, replay_key: 'replay-new-empty-teacher',
    course_key: 'course-stable', teacher: '' }])
  assert.equal(result.inserted, 1)
  assert.equal(result.existing, 0)
  db.close()
})
