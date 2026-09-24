import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'

import { createAdminHandler, redactStatus } from './admin.mjs'

const TOKEN = 'test-admin-token'

function fixture({ runCommand } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-admin-'))
  const scratchRoot = path.join(dir, 'scratch')
  fs.mkdirSync(scratchRoot, { recursive: true })

  const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  store.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '第10-12节' }])
  store.enqueueDelivery({
    dedupeKey: 'course-note:x', purpose: 'course-note', bodyText: '正文', objectUrl: '/n.html',
    scheduledFor: '2026-01-01T00:00:00.000Z'
  })
  store.close()

  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ siteName: '课程笔记', generatedAt: 'x', count: 0, notes: [] }))

  const calls = []
  const handler = createAdminHandler({
    root: dir,
    scratchRoot,
    workerPath: '/repo/apps/worker/bin/course.mjs',
    workerEnv: { COURSE_WORKER_SCRATCH_DIR: scratchRoot },
    runCommand: runCommand || (async (args, options) => {
      calls.push({ args, options })
      return { code: 0, stdout: JSON.stringify({ ok: true, args: args.slice(1) }), stderr: '' }
    })
  })
  return { handler, dir, scratchRoot, calls }
}

/** 极小的请求/响应替身，够这个处理器用。 */
function fakeRequest({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const listeners = {}
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: headers['x-test-ip'] || '127.0.0.1' },
    on(event, fn) {
      listeners[event] = fn
      // 依次补上 body 与结束事件，让读取请求体的逻辑能正常走完
      if (event === 'data' && body) setImmediate(() => fn(Buffer.from(body)))
      if (event === 'end') setImmediate(() => setImmediate(fn))
      return this
    },
    destroy() {}
  }
}

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(chunk) { state.body = chunk ? String(chunk) : '' },
    json() { return JSON.parse(state.body) }
  }
}

const call = async (handler, options, { token = TOKEN } = {}) => {
  const req = fakeRequest({ ...options, headers: { ...(options?.headers || {}), ...(token ? { 'x-course-token': token } : {}) } })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, new URL(req.url, 'http://x').pathname, new URL(req.url, 'http://x'), { adminToken: TOKEN })
  return { handled, res, body: res.state.body ? JSON.parse(res.state.body) : null }
}

test('the admin API fails closed without a configured token', async () => {
  const { handler } = fixture()
  const req = fakeRequest({ url: '/api/admin/status' })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, '/api/admin/status', new URL('http://x/api/admin/status'), { adminToken: '' })
  assert.equal(handled, true)
  assert.equal(res.state.status, 503)
  assert.equal(res.state.body && JSON.parse(res.state.body).error, 'admin_token_unconfigured')
})

test('a wrong token is rejected and repeated failures are throttled', async () => {
  const { handler } = fixture()
  for (let index = 0; index < 5; index += 1) {
    const { res } = await call(handler, { url: '/api/admin/status' }, { token: 'wrong' })
    assert.equal(res.state.status, 401)
  }
  const { res } = await call(handler, { url: '/api/admin/status' }, { token: 'wrong' })
  assert.equal(res.state.status, 429, '连续失败后应被限流')

  // 正确令牌同样被限流（窗口期内的保护优先）
  const blocked = await call(handler, { url: '/api/admin/status' }, { token: TOKEN })
  assert.equal(blocked.res.state.status, 429)
})

test('status reports the ledger and site without leaking any secret', async () => {
  const { handler } = fixture()
  const { res, body } = await call(handler, { url: '/api/admin/status' })
  assert.equal(res.state.status, 200)
  assert.equal(body.ledger.stages.find(row => row.stage === 'discovered').n, 1)
  assert.equal(body.ledger.tasks[0].replayKey, 'replay-1')
  assert.equal(body.ledger.deliveries[0].status, 'pending')
  assert.equal(body.site.count, 0)
  assert.equal(res.state.headers['cache-control'], 'no-store')
})

test('redactStatus collapses anything secret-looking to set/missing', () => {
  const redacted = redactStatus({
    credentials: { PKU_PASSWORD: 'real-secret', DASHSCOPE_API_KEY: 'sk-123' },
    nested: [{ token: 'abc' }, { note: '普通文本' }],
    courseName: '刑法分论'
  })
  assert.equal(redacted.credentials.PKU_PASSWORD, 'set')
  assert.equal(redacted.credentials.DASHSCOPE_API_KEY, 'set')
  assert.equal(redacted.nested[0].token, 'set')
  assert.equal(redacted.nested[1].note, '普通文本')
  // 普通标识不能被当成密钥抹掉
  assert.equal(redactStatus({ replayKey: 'replay-abc', dedupeKey: 'course-note:x', taskKey: 'k' }).replayKey, 'replay-abc')
  assert.equal(redactStatus({ dedupeKey: 'course-note:x' }).dedupeKey, 'course-note:x')

  // 布尔状态不得被改写：名字里带 credential 的布尔字段表示"是否已配置"，
  // 被改写成 'set' 会把「没配」显示成「配好了」
  const ready = redactStatus({ ready: { pkuCredentials: false, asrCredentials: true, ffmpeg: true } })
  assert.equal(ready.ready.pkuCredentials, false)
  assert.equal(ready.ready.asrCredentials, true)
  assert.equal(ready.ready.ffmpeg, true)
  // 而真正的字符串密钥仍然要被收起
  assert.equal(redactStatus({ COURSE_AI_API_KEY: 'sk-real' }).COURSE_AI_API_KEY, 'set')
  assert.equal(redactStatus({ COURSE_AI_API_KEY: '' }).COURSE_AI_API_KEY, 'missing')
  assert.equal(redacted.courseName, '刑法分论')
  assert.ok(!JSON.stringify(redacted).includes('real-secret'))
  assert.ok(!JSON.stringify(redacted).includes('sk-123'))
})

test('run spawns the same CLI entry the timer uses', async () => {
  const { handler, calls } = fixture()
  const { res, body } = await call(handler, {
    method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'cycle', maxTasks: 3 })
  })
  assert.equal(res.state.status, 200)
  assert.equal(body.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['/repo/apps/worker/bin/course.mjs', 'cycle', '--max-tasks', '3'])
})

test('run rejects unsupported actions and unknown routes', async () => {
  const { handler } = fixture()
  const bad = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'rm-rf' }) })
  assert.equal(bad.res.state.status, 400)
  assert.equal(bad.body.error, 'unsupported_action')

  const unknown = await call(handler, { url: '/api/admin/nope' })
  assert.equal(unknown.res.state.status, 404)
})

test('a second run is refused while one is in flight', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { handler } = fixture({
    runCommand: async () => { await gate; return { code: 0, stdout: '{}', stderr: '' } }
  })

  const first = call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'discover' }) })
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'discover' }) })
  assert.equal(second.res.state.status, 409)
  assert.equal(second.body.error, 'already_running')

  release()
  const done = await first
  assert.equal(done.res.state.status, 200)
})

test('a failing run is reported as not ok rather than swallowed', async () => {
  const { handler } = fixture({
    runCommand: async () => ({ code: 1, stdout: JSON.stringify({ errors: [{ step: 'discover', message: 'AUTH_EXPIRED' }] }), stderr: 'boom' })
  })
  const { res, body } = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'discover' }) })
  assert.equal(res.state.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.exitCode, 1)
  assert.match(body.stderr, /boom/)
})

test('the console page is served without a token so the user can enter one', async () => {
  const { handler } = fixture()
  const req = fakeRequest({ url: '/admin' })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, '/admin', new URL('http://x/admin'), { adminToken: TOKEN })
  assert.equal(handled, true)
  assert.equal(res.state.status, 200)
  assert.match(res.state.headers['content-type'], /text\/html/)
  assert.match(res.state.body, /课程闭环控制台/)
  assert.ok(!res.state.body.includes(TOKEN), '页面里不得内嵌令牌')
})

test('non-admin paths are left to the static handler', async () => {
  const { handler } = fixture()
  const req = fakeRequest({ url: '/notes/x.html' })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, '/notes/x.html', new URL('http://x/notes/x.html'), { adminToken: TOKEN })
  assert.equal(handled, false)
})
