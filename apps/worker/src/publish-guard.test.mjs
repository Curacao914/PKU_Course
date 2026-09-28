import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { NOTIFY_POLICY, clearPending, pendingNotifications, planNotification, resolveNotifyPolicy } from './notify-outbox.mjs'
import { acquirePublishLock, checkRevisionUnchanged, libraryRevision, publishLockPath } from './publish-guard.mjs'

/**
 * A4：发布的互斥、乐观版本检查与通知 outbox。
 *
 * 三件事各自对应一个真实会出错的形状：
 *   · 两个发布同时跑 → 后写的把先写的记录抹掉（站点上少一整节课，且没有报错）；
 *   · 读库到写库之间库被改过 → 覆盖别人的改动；
 *   · 写完库、还没入队就崩 → 站点上有、微信上没有，而且没有痕迹。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'course-publish-'))

test('发布锁：第二个发布拿不到锁，明确告诉它是谁在跑', () => {
  const dir = tmp()
  const siteRoot = path.join(dir, 'site')
  const lockPath = publishLockPath(siteRoot)
  assert.equal(lockPath, path.join(dir, 'site.publish.lock'), '锁要放在站点目录外面（site 每次发布全量重写）')

  const first = acquirePublishLock({ lockPath, info: { slug: 'notes/甲/第一讲' } })
  assert.equal(first.ok, true)
  const second = acquirePublishLock({ lockPath, info: { slug: 'notes/乙/第二讲' } })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'held')
  assert.equal(second.holder.slug, 'notes/甲/第一讲')
  assert.match(second.message, /另一个发布正在进行中/)

  // 幂等释放；释放之后别人能拿到
  assert.equal(first.release(), true)
  assert.equal(first.release(), false)
  const third = acquirePublishLock({ lockPath })
  assert.equal(third.ok, true)
  third.release()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('发布锁：陈旧锁会被接管（一次崩溃不该永久锁死发布）', () => {
  const dir = tmp()
  const lockPath = publishLockPath(path.join(dir, 'site'))
  const dead = acquirePublishLock({ lockPath, info: { slug: '被杀的进程' } })
  assert.equal(dead.ok, true)
  // 假装它是 20 分钟前留下的
  const old = Date.now() - 20 * 60 * 1000
  fs.utimesSync(lockPath, old / 1000, old / 1000)

  const warnings = []
  const takeover = acquirePublishLock({ lockPath, staleMs: 10 * 60 * 1000, warnings: line => warnings.push(line), info: { slug: '新发布' } })
  assert.equal(takeover.ok, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /接管/)

  // 原持有者后来才来释放：不能把新持有者的锁删掉
  dead.release()
  assert.equal(fs.existsSync(lockPath), true, '旧持有者不得删掉别人的锁')
  takeover.release()
  assert.equal(fs.existsSync(lockPath), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('乐观版本检查：读库到写库之间被改过就中止（而不是覆盖）', () => {
  const dir = tmp()
  const file = path.join(dir, 'library.json')
  fs.writeFileSync(file, JSON.stringify([{ slug: 'a' }]))
  const before = libraryRevision(file)
  assert.equal(before.exists, true)

  // 没被动过：放行
  assert.equal(checkRevisionUnchanged({ file, expected: before.revision }).ok, true)

  // 被另一个发布改过：中止，并给出可操作的话
  fs.writeFileSync(file, JSON.stringify([{ slug: 'a' }, { slug: 'b' }]))
  const stale = checkRevisionUnchanged({ file, expected: before.revision })
  assert.equal(stale.ok, false)
  assert.match(stale.message, /被改过/)
  assert.match(stale.message, /重跑一次/)

  // 第一次发布（库还不存在）不算冲突
  assert.equal(checkRevisionUnchanged({ file: path.join(dir, 'nope.json'), expected: '' }).ok, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('通知策略：--no-notify 会留下来，别被下一次自动重跑推翻', () => {
  assert.deepEqual(resolveNotifyPolicy({ flag: NOTIFY_POLICY.NONE }), { policy: NOTIFY_POLICY.NONE, reason: 'flag' })
  assert.deepEqual(resolveNotifyPolicy({ stored: NOTIFY_POLICY.NONE }), { policy: NOTIFY_POLICY.NONE, reason: 'stored' })
  assert.deepEqual(resolveNotifyPolicy({ flag: NOTIFY_POLICY.CHANGED, stored: NOTIFY_POLICY.NONE }), { policy: NOTIFY_POLICY.CHANGED, reason: 'flag' })
  assert.deepEqual(resolveNotifyPolicy({}), { policy: NOTIFY_POLICY.CHANGED, reason: 'default' })
})

test('通知意图：内容没变/策略禁止/已经通知过，都不该再排队', () => {
  const base = { slug: 'notes/甲/第一讲', checksum: 'abcdef0123456789', bodyText: '正文', objectUrl: 'https://x/y.html' }
  const planned = planNotification({ ...base, changed: true, policy: NOTIFY_POLICY.CHANGED })
  assert.equal(planned.dedupeKey, 'course-note:notes/甲/第一讲:abcdef012345')
  assert.equal(planNotification({ ...base, changed: false, policy: NOTIFY_POLICY.CHANGED }), null)
  assert.equal(planNotification({ ...base, changed: true, policy: NOTIFY_POLICY.NONE }), null)
  assert.equal(planNotification({ ...base, changed: true, policy: NOTIFY_POLICY.CHANGED, alreadyNotified: true }), null)
})

test('outbox 恢复：挂了意图但没入队的记录会被下一次发布看到并补发', () => {
  const records = [
    { slug: 'notes/甲/第一讲', notifyPending: { dedupeKey: 'course-note:notes/甲/第一讲:aaa', bodyText: 'x', objectUrl: 'u' } },
    { slug: 'notes/甲/第二讲' },
    { slug: 'notes/甲/第三讲', notifyPending: { dedupeKey: 'course-note:notes/甲/第三讲:ccc', bodyText: 'y', objectUrl: 'u' } }
  ]
  const pending = pendingNotifications(records)
  assert.deepEqual(pending.map(item => item.slug), ['notes/甲/第一讲', 'notes/甲/第三讲'])
  assert.ok(pending.every(item => item.dedupeKey), '补发靠 dedupeKey 去重')

  const cleared = clearPending(records, ['notes/甲/第一讲'])
  assert.equal(cleared.changed, true)
  assert.equal('notifyPending' in cleared.records[0], false)
  assert.ok(cleared.records[0].notifiedAt, '补发成功要留下时间痕迹')
  assert.equal(pendingNotifications(cleared.records).length, 1)
  assert.equal(clearPending(cleared.records, ['不存在的 slug']).changed, false)
})
