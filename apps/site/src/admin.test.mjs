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

/** token 传空串表示"不带凭据"，传字符串表示用该凭据。 */
const call = async (handler, options, { token = TOKEN } = {}) => {
  const req = fakeRequest({ ...options, headers: { ...(options?.headers || {}), ...(token ? { 'x-course-token': token } : {}) } })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, new URL(req.url, 'http://x').pathname, new URL(req.url, 'http://x'), { adminToken: TOKEN })
  return { handled, res, body: res.state.body ? JSON.parse(res.state.body) : null }
}

test('a deck can be uploaded from the browser without any filename convention', async () => {
  // 归属由前端选择器给出（课程 + 课次 + 作用域），所以文件名随便叫什么都行。
  const { handler, scratchRoot } = fixture()
  const deck = Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '第四讲 变量测量水平' }] }))
  const params = new URLSearchParams({ course: '刑法分论', lesson: '第10-12节', scope: 'lesson', name: '老师发的课件（第4讲）.json' })

  const uploaded = await call(handler, {
    method: 'PUT',
    url: `/api/admin/materials?${params.toString()}`,
    body: deck
  })
  assert.equal(uploaded.res.state.status, 200)
  assert.equal(uploaded.body.ok, true)
  assert.equal(uploaded.body.slideCount, 1)
  assert.match(uploaded.body.name, /第4讲/, '中文与括号都要保留')

  const archived = path.join(scratchRoot, 'materials', '刑法分论', '第10-12节')
  assert.ok(fs.existsSync(path.join(archived, uploaded.body.name)), '文件要落到归档目录')
  assert.ok(fs.existsSync(path.join(archived, 'slides', `${uploaded.body.name}.json`)), '解析结果也要存下来')

  // 全课程通用：不需要课次
  const shared = await call(handler, {
    method: 'PUT',
    url: `/api/admin/materials?${new URLSearchParams({ course: '刑法分论', scope: 'course', name: '术语表.json' }).toString()}`,
    body: deck
  })
  assert.equal(shared.body.ok, true)
  assert.ok(fs.existsSync(path.join(scratchRoot, 'materials', '刑法分论', 'course', '术语表.json')))

  // 本课次但没选课次：拒绝
  const missing = await call(handler, {
    method: 'PUT',
    url: `/api/admin/materials?${new URLSearchParams({ course: '刑法分论', name: 'x.json' }).toString()}`,
    body: deck
  })
  assert.equal(missing.res.state.status, 400)
  assert.equal(missing.body.error, 'missing_lesson')

  // 空文件：拒绝
  const empty = await call(handler, {
    method: 'PUT',
    url: `/api/admin/materials?${params.toString()}`,
    body: Buffer.alloc(0)
  })
  assert.equal(empty.res.state.status, 400)
  assert.equal(empty.body.error, 'empty_body')
})

test('uploading requires the admin token', async () => {
  const { handler } = fixture()
  const res = await call(handler, {
    method: 'PUT',
    url: `/api/admin/materials?${new URLSearchParams({ course: 'c', lesson: 'l' }).toString()}`,
    body: Buffer.from('x')
  }, { token: '' })
  assert.equal(res.res.state.status, 401)
})

test('admin actions map to whitelisted CLI argv, never to a shell string', async () => {
  const { handler, calls } = fixture()
  const run = (action, extra) => call(handler, {
    method: 'POST', url: '/api/admin/run',
    body: JSON.stringify(Object.assign({ action }, extra || {}))
  })

  await run('retry', { replayKey: 'replay-1' })
  assert.deepEqual(calls.at(-1).args.slice(1), ['retry', '--replay-key', 'replay-1'])

  await run('prune', { apply: true })
  assert.deepEqual(calls.at(-1).args.slice(1), ['prune', '--apply'])

  await run('notify-retry')
  assert.deepEqual(calls.at(-1).args.slice(1), ['notify', '--retry-failed'])

  // 缺参数要被挡住，而不是拼出一条残缺命令
  const bad = await run('revise', { course: '刑法分论' })
  assert.equal(bad.res.state.status, 400)
  assert.equal(bad.body.error, 'bad_arguments')

  // 不在白名单里的动作一律拒绝
  const unknown = await run('rm-rf')
  assert.equal(unknown.res.state.status, 400)
  assert.equal(unknown.body.error, 'unsupported_action')
})

test('run parameters can be edited from the console and are validated', async () => {
  const { handler, scratchRoot } = fixture()
  const initial = await call(handler, { url: '/api/admin/config' })
  assert.equal(initial.res.state.status, 200)
  assert.ok(initial.body.editable.targetChars, '可改的键要带说明，界面据此生成表单')

  const saved = await call(handler, {
    method: 'PUT', url: '/api/admin/config',
    body: JSON.stringify({ values: { targetChars: '12000', llmCostMode: 'economy', keepMedia: 'true' } })
  })
  assert.equal(saved.res.state.status, 200)
  assert.deepEqual(saved.body.applied.sort(), ['keepMedia', 'llmCostMode', 'targetChars'])

  const onDisk = JSON.parse(fs.readFileSync(path.join(scratchRoot, 'config.json'), 'utf8'))
  assert.equal(onDisk.targetChars, 12000)
  assert.equal(onDisk.keepMedia, true, '布尔值要落成布尔，不是字符串')

  const reread = await call(handler, { url: '/api/admin/config' })
  assert.equal(reread.body.values.targetChars, 12000)

  // 不认识的键、越界的值都要报错而不是静默写入
  const unknown = await call(handler, { method: 'PUT', url: '/api/admin/config', body: JSON.stringify({ values: { apiKey: 'sk-x' } }) })
  assert.equal(unknown.res.state.status, 400)
  assert.match(unknown.body.errors.join(''), /不支持修改 apiKey/, '界面不能写密钥')

  const outOfRange = await call(handler, { method: 'PUT', url: '/api/admin/config', body: JSON.stringify({ values: { targetChars: 999999 } }) })
  assert.equal(outOfRange.res.state.status, 400)
  assert.match(outOfRange.body.errors.join(''), /targetChars/)
})

test('the balance endpoint reports provider state without blocking the status page', async () => {
  const { handler } = fixture({
    runCommand: async args => ({
      code: 0,
      stdout: JSON.stringify({ threshold: 5, balances: [{ provider: 'deepseek', total: 12.15 }, { provider: 'aliyun', configured: false }] }),
      stderr: ''
    })
  })
  const { res, body } = await call(handler, { url: '/api/admin/balance' })
  assert.equal(res.state.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.balances.length, 2)
})

test('a console password can be set, used to log in, and changed', async () => {
  const { handler, scratchRoot } = fixture()

  // 还没设密码时，主令牌可用而密码不可用
  const before = await call(handler, { url: '/api/admin/status' })
  assert.equal(before.body.auth.passwordSet, false)
  assert.equal(before.body.auth.masterTokenSet, true)

  const weak = await call(handler, { method: 'PUT', url: '/api/admin/password', body: JSON.stringify({ password: '12345678' }) })
  assert.equal(weak.res.state.status, 400)
  assert.match(weak.body.message, /太好猜|至少/)

  const set = await call(handler, { method: 'PUT', url: '/api/admin/password', body: JSON.stringify({ password: 'wo-de-mi-ma-2026' }) })
  assert.equal(set.res.state.status, 200)
  assert.equal(set.body.changed, true)

  // 明文不落盘：文件里只有 salt 与 hash
  const onDisk = fs.readFileSync(path.join(scratchRoot, 'admin-password.json'), 'utf8')
  assert.ok(!onDisk.includes('wo-de-mi-ma-2026'), '密码明文绝不能落盘')
  assert.match(onDisk, /"scheme": "scrypt"/)

  // 用新密码登录（而不是主令牌）
  const byPassword = await call(handler, { url: '/api/admin/status' }, { token: 'wo-de-mi-ma-2026' })
  assert.equal(byPassword.res.state.status, 200)
  assert.equal(byPassword.body.auth.passwordSet, true)
  assert.equal(byPassword.body.auth.masterTokenSet, true, '主令牌仍在：它是找回路径')

  // 清除密码后只剩主令牌
  const cleared = await call(handler, { method: 'PUT', url: '/api/admin/password', body: JSON.stringify({ action: 'clear' }) })
  assert.equal(cleared.body.cleared, true)
  assert.equal((await call(handler, { url: '/api/admin/status' })).body.auth.passwordSet, false)

  // 限流放在最后：它按来源 IP 计数，会连带影响同一 IP 的后续请求
  await call(handler, { method: 'PUT', url: '/api/admin/password', body: JSON.stringify({ password: 'wo-de-mi-ma-2026' }) })
  for (let index = 0; index < 5; index += 1) {
    await call(handler, { url: '/api/admin/status' }, { token: 'wrong-password' })
  }
  const throttled = await call(handler, { url: '/api/admin/status' }, { token: 'wo-de-mi-ma-2026' })
  assert.equal(throttled.res.state.status, 429, '错太多次之后连正确凭据也要等窗口过去')
})

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
  assert.equal(body.running, null, '空闲时应显式报告"没有在运行"')
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

  // 运行期间状态里应能看到"正在运行"，用户才知道按钮为什么没反应
  const during = await call(handler, { url: '/api/admin/status' })
  assert.equal(during.body.running.action, 'discover')

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
  assert.match(res.state.body, /管理台/, '无令牌时也要能打开页面输入令牌')
  assert.match(res.state.body, /data-tab="overview"/, '四个区在页面里（概览/课程/笔记/设置）')
  assert.match(res.state.body, /data-tab="courses"/)
  assert.match(res.state.body, /data-tab="notes"/)
  assert.match(res.state.body, /data-tab="settings"/)
  assert.ok(!res.state.body.includes(TOKEN), '页面里不得内嵌令牌')
})

test('non-admin paths are left to the static handler', async () => {
  const { handler } = fixture()
  const req = fakeRequest({ url: '/notes/x.html' })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, '/notes/x.html', new URL('http://x/notes/x.html'), { adminToken: TOKEN })
  assert.equal(handled, false)
})
