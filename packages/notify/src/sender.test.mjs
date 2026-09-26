import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { openLedger } from '@course/store'

import {
  absoluteObjectUrl,
  buildDeliveryMessage,
  chooseChannel,
  createFallbackSender,
  createResilientSender,
  createWechatSender,
  deliveryLinkLabel,
  plainTextForChannel,
  runDeliveryCycle
} from './sender.mjs'
import { WECHAT_SESSION_MAX_AGE_MINUTES, wechatSessionState } from './session.mjs'

const NOTE_URL = 'https://course.law-tech.dev/notes/刑法分论/第10-12节.html'

/** 假 spawn：记录 argv，按脚本返回退出码与输出。 */
function fakeSpawn(script = () => ({ code: 0, stdout: '{"messageId":"wx-1"}', stderr: '' })) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const result = script(args)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      if (result.stdout) child.stdout.emit('data', result.stdout)
      if (result.stderr) child.stderr.emit('data', result.stderr)
      child.emit('close', result.code)
    })
    return child
  }
  return { spawnImpl, calls }
}

test('object urls become absolute against the site origin', () => {
  assert.equal(absoluteObjectUrl('notes/a/b.html'), 'https://course.law-tech.dev/notes/a/b.html')
  assert.equal(absoluteObjectUrl('/notes/a.html'), 'https://course.law-tech.dev/notes/a.html')
  assert.equal(absoluteObjectUrl('https://other.example/x'), 'https://other.example/x')
  assert.equal(absoluteObjectUrl(''), '')
  assert.equal(absoluteObjectUrl('notes/a.html', 'https://x.test/'), 'https://x.test/notes/a.html')
})

test('the message appends one link line and never duplicates it', () => {
  const withLink = buildDeliveryMessage({ purpose: 'course-note', body_text: '刑法分论 · 第10-12节\n摘要若干。', object_url: NOTE_URL })
  assert.match(withLink, /摘要若干。\n\n\[打开课程笔记\]\(https:/)
  assert.equal(withLink.split('打开课程笔记').length - 1, 1)

  const already = buildDeliveryMessage({ purpose: 'course-note', body_text: `见 ${NOTE_URL}`, object_url: NOTE_URL })
  assert.equal(already, `见 ${NOTE_URL}`, '正文已含完整地址时不再追加')

  const byPath = buildDeliveryMessage({ purpose: 'course-note', body_text: '见 /notes/刑法分论/第10-12节.html', object_url: NOTE_URL })
  assert.equal(byPath, '见 /notes/刑法分论/第10-12节.html', '正文已含路径时也不再追加')

  assert.equal(buildDeliveryMessage({ body_text: '只有正文' }), '只有正文')
  assert.equal(buildDeliveryMessage({ purpose: 'course-brief', body_text: 'x', object_url: 'n.html' }).includes('打开课程简报'), true)
  assert.equal(deliveryLinkLabel('unknown'), '打开课程笔记')
})

test('the sender spawns openclaw with the exact channel and target', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => ({ code: 0, stdout: '{"messageId":"wx-42"}', stderr: '' }))
  const sender = createWechatSender({ openclawBin: '/usr/local/bin/openclaw', target: 'wxid_target', spawnImpl })
  const result = await sender.send('一条通知')

  assert.equal(result.externalId, 'wx-42')
  assert.equal(calls[0].command, '/usr/local/bin/openclaw')
  assert.equal(calls[0].options.env.OPENCLAW_HOME, undefined, '未配置时不注入 HOME')
  assert.deepEqual(calls[0].args, [
    'message', 'send', '--channel', 'openclaw-weixin', '--target', 'wxid_target', '--message', '一条通知', '--json'
  ])
})

test('both OPENCLAW_HOME and OPENCLAW_STATE_DIR are injected', async () => {
  // 只设 HOME 时 CLI 会报 Unknown channel: openclaw-weixin（已实测对照）
  const { spawnImpl, calls } = fakeSpawn()
  await createWechatSender({
    target: 'wxid', spawnImpl, openclawHome: '/home/ubuntu/.openclaw-candidate'
  }).send('x')
  assert.equal(calls[0].options.env.OPENCLAW_HOME, '/home/ubuntu/.openclaw-candidate')
  assert.equal(calls[0].options.env.OPENCLAW_STATE_DIR, '/home/ubuntu/.openclaw-candidate', 'STATE_DIR 应跟随 HOME')

  const explicit = fakeSpawn()
  await createWechatSender({
    target: 'wxid', spawnImpl: explicit.spawnImpl,
    openclawHome: '/h1', openclawStateDir: '/s1'
  }).send('x')
  assert.equal(explicit.calls[0].options.env.OPENCLAW_STATE_DIR, '/s1', '显式 STATE_DIR 优先')
})

test('a failing send surfaces the stderr instead of pretending success', async () => {
  const { spawnImpl } = fakeSpawn(() => ({ code: 1, stdout: '', stderr: 'Unknown channel: openclaw-weixin' }))
  const sender = createWechatSender({ target: 'wxid', spawnImpl })
  await assert.rejects(() => sender.send('x'), /Unknown channel: openclaw-weixin/)
})

test('a sender without a target refuses to be constructed', () => {
  assert.throws(() => createWechatSender({ target: '' }), /缺少推送目标/)
})

test('probe reports clearly and never sends a real message', async () => {
  const okSpawn = fakeSpawn(() => ({ code: 0, stdout: '{"dryRun":true}', stderr: '' }))
  const ok = await createWechatSender({ target: 'wxid', spawnImpl: okSpawn.spawnImpl }).probe()
  assert.equal(ok.ok, true)
  assert.ok(okSpawn.calls[0].args.includes('--dry-run'), '探测必须带 dry-run')

  const badSpawn = fakeSpawn(() => ({ code: 1, stdout: '', stderr: 'target not paired' }))
  const bad = await createWechatSender({ target: 'wxid', spawnImpl: badSpawn.spawnImpl }).probe()
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /target not paired/)
})

function seededLedger() {
  const store = openLedger(':memory:')
  store.enqueueDelivery({
    dedupeKey: 'course-note:notes/刑法分论/第10-12节',
    purpose: 'course-note',
    bodyText: '刑法分论 · 第10-12节\n共犯的成立需要共同故意与共同行为。',
    objectUrl: NOTE_URL,
    scheduledFor: '2026-09-25T00:00:00.000Z'
  })
  return store
}

test('a cycle claims, sends and acknowledges with the external id', async () => {
  const store = seededLedger()
  const { spawnImpl, calls } = fakeSpawn(() => ({ code: 0, stdout: '{"messageId":"wx-7"}', stderr: '' }))
  const sender = createWechatSender({ target: 'wxid', spawnImpl })
  const summary = await runDeliveryCycle({ store, sender, at: '2026-09-25T00:00:01.000Z' })

  assert.deepEqual({ sent: summary.sent, failed: summary.failed, retried: summary.retried }, { sent: 1, failed: 0, retried: 0 })
  assert.match(calls[0].args[calls[0].args.indexOf('--message') + 1], /打开课程笔记/)

  assert.equal(store.claimDelivery({ workerId: 'w', now: '2026-09-25T00:01:00.000Z' }), null, '已发送的不再领取')
  assert.equal(summary.results[0].externalId, 'wx-7')
  store.close()
})

test('a failed send is retried with backoff, then given up on', async () => {
  const store = seededLedger()
  const { spawnImpl } = fakeSpawn(() => ({ code: 1, stdout: '', stderr: '通道暂时不可用' }))
  const sender = createWechatSender({ target: 'wxid', spawnImpl })

  const first = await runDeliveryCycle({ store, sender, at: '2026-09-25T00:00:01.000Z', retryDelayMs: 60_000 })
  assert.equal(first.retried, 1)
  const back = store.claimDelivery({ workerId: 'w', now: '2026-09-25T00:00:30.000Z' })
  assert.equal(back, null, '退避期内不应重试')

  const second = await runDeliveryCycle({ store, sender, at: '2026-09-25T00:02:00.000Z', retryDelayMs: 60_000 })
  assert.equal(second.retried, 1)
  const third = await runDeliveryCycle({ store, sender, at: '2026-09-25T00:04:00.000Z', maxAttempts: 3 })
  assert.equal(third.failed, 1, '超过上限后标记失败，不再无限重试')
  assert.equal(store.claimDelivery({ workerId: 'w', now: '2026-09-25T09:00:00.000Z' }), null)

  const row = store.db.prepare('SELECT status, last_error FROM deliveries').get()
  assert.equal(row.status, 'failed')
  assert.match(row.last_error, /通道暂时不可用/)
  store.close()
})

test('a cycle with nothing pending does nothing', async () => {
  const store = openLedger(':memory:')
  const { spawnImpl, calls } = fakeSpawn()
  const sender = createWechatSender({ target: 'wxid', spawnImpl })
  const summary = await runDeliveryCycle({ store, sender })
  assert.deepEqual(summary.results, [])
  assert.equal(calls.length, 0, '没有待发消息时不应调用 openclaw')
  store.close()
})

test('an expired wechat session is detected from the channel state', async () => {
  // 这条通道的规矩：用户每来一次消息，平台给一个 context_token，出站必须带上。
  // 没有它接口也返回成功、消息却到不了微信——所以「能不能推」必须能判断，不能靠猜。
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-state-'))

  const missing = wechatSessionState({ stateDir: home })
  assert.equal(missing.ok, false, '没有会话记录时不能假装能推')

  const accounts = path.join(home, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  fs.writeFileSync(path.join(accounts, 'bot.context-tokens.json'), '{}')
  const fresh = wechatSessionState({ stateDir: home, now: Date.now() })
  assert.equal(fresh.ok, true)
  assert.ok(fresh.ageMinutes <= 1)
  assert.ok(fresh.ageMinutes < WECHAT_SESSION_MAX_AGE_MINUTES)

  const stale = wechatSessionState({ stateDir: home, now: Date.now() + 48 * 60 * 60 * 1000 })
  assert.ok(stale.ageMinutes > WECHAT_SESSION_MAX_AGE_MINUTES, '两天前的会话要判为过期')
})

test('the fallback channel is used when the wechat session is stale', async () => {
  const sent = []
  const fetchImpl = async (url, options = {}) => {
    sent.push({ url, body: options.body })
    return { ok: true, status: 200, text: async () => '{"errcode":0}' }
  }
  const fallback = createFallbackSender({ kind: 'wecom', url: 'https://qyapi.example/webhook', fetchImpl })
  assert.equal(fallback.configured, true)

  const primaryCalls = []
  const primary = { send: async () => { primaryCalls.push('primary'); return { externalId: 'wx-1' } } }
  const sender = createResilientSender({
    primary,
    fallback,
    primaryUsable: async () => false,   // 会话过期
    onFallback: () => {}
  })
  const result = await sender.send('【新课】1 节\n\n[打开管理台传课件](https://course.law-tech.dev/admin)')
  assert.equal(result.channel, 'wecom')
  assert.deepEqual(primaryCalls, [], '会话不可用时就不要再往微信发一次——那会留下假的成功记录')
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /msgtype/, '企业微信要的是 msgtype/text 结构')
  assert.match(sent[0].body, /打开管理台传课件 https:\/\/course\.law-tech\.dev\/admin/, 'Markdown 链接要展成纯文本')
})

test('a healthy wechat session still goes through the primary channel', async () => {
  const posts = []
  const fallback = createFallbackSender({ kind: 'wecom', url: 'https://qyapi.example/webhook', fetchImpl: async (u, o) => { posts.push(u); return { ok: true, status: 200, text: async () => '{}' } } })
  const sender = createResilientSender({ primary: { send: async () => ({ externalId: 'wx-9' }) }, fallback, primaryUsable: async () => true })
  const result = await sender.send('正文')
  assert.equal(result.channel, 'wechat')
  assert.equal(result.externalId, 'wx-9')
  assert.deepEqual(posts, [], '主通道正常时不该碰备用通道')
})

test('a failing primary falls back instead of losing the message', async () => {
  const posts = []
  const fallback = createFallbackSender({ kind: 'generic', url: 'https://example.test/hook', fetchImpl: async (u, o) => { posts.push(o.body); return { ok: true, status: 200, text: async () => 'ok' } } })
  const reasons = []
  const sender = createResilientSender({
    primary: { send: async () => { throw new Error('openclaw 退出码 1') } },
    fallback,
    primaryUsable: async () => true,
    onFallback: reason => reasons.push(reason)
  })
  const result = await sender.send('正文')
  assert.equal(result.channel, 'generic')
  assert.equal(posts.length, 1)
  assert.match(reasons[0], /主通道发送失败/)
})

test('channel choice is explicit and testable', () => {
  const fallback = { configured: true }
  assert.equal(chooseChannel({ primaryUsable: true, fallback }).channel, 'primary')
  assert.equal(chooseChannel({ primaryUsable: false, fallback }).channel, 'fallback')
  assert.equal(chooseChannel({ primaryUsable: false, fallback: null }).channel, 'primary', '没有备用就只能试主通道')
  assert.equal(chooseChannel({ primaryUsable: false, fallback: { configured: false } }).channel, 'primary', '备用没配好等于没有')
  assert.equal(plainTextForChannel('[看笔记](https://x.test/a)'), '看笔记 https://x.test/a')
})

test('the cycle refuses to run without a ledger or sender', async () => {
  await assert.rejects(() => runDeliveryCycle({ sender: {} }), /需要一个账本/)
  await assert.rejects(() => runDeliveryCycle({ store: {} }), /需要一个发送器/)
})
