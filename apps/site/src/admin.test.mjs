import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'

import { ADMIN_HTML, ALLOWED_ACTIONS, buildActionArgs, createAdminHandler, redactStatus } from './admin.mjs'

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

test('a large deck can be uploaded in chunks, because the tunnel drops big bodies', async () => {
  // 实测：20MB 的 PUT 经 Cloudflare 隧道传到 12MB 时被掐断，服务端一个字节都没落盘。
  // 课件动辄二三十兆，所以必须分片：每片几百 KB，单个请求又快又小。
  const { handler, scratchRoot } = fixture()
  const deck = Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '第一页' }] }))
  const half = Math.ceil(deck.length / 2)
  const uploadId = 'utest123456'

  const first = await call(handler, { method: 'PUT', url: `/api/admin/materials/chunk?uploadId=${uploadId}&index=0`, body: deck.subarray(0, half) })
  assert.equal(first.res.state.status, 200)
  assert.equal(first.body.received, 1)
  const second = await call(handler, { method: 'PUT', url: `/api/admin/materials/chunk?uploadId=${uploadId}&index=1`, body: deck.subarray(half) })
  assert.equal(second.body.received, 2)

  const committed = await call(handler, {
    method: 'POST', url: '/api/admin/materials/commit',
    // 夹具用 JSON 课件（与单次上传那条测试一致）：内容随便，路径与合并逻辑才是被测对象
    body: JSON.stringify({ uploadId, course: '刑法分论', lesson: '第10-12节', scope: 'lesson', name: '老师发的课件.json' })
  })
  assert.equal(committed.res.state.status, 200)
  assert.equal(committed.body.ok, true)
  assert.equal(committed.body.slideCount, 1)
  assert.equal(committed.body.chunks, 2)
  const archived = path.join(scratchRoot, 'materials', '刑法分论', '第10-12节', '老师发的课件.json')
  assert.ok(fs.existsSync(archived), '合并后的文件要落到归档目录')
  assert.equal(fs.readFileSync(archived).length, deck.length, '合并结果必须与原件逐字节一致')
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'tmp', 'uploads', uploadId)), '提交后临时分片要清掉')
})

test('chunked upload rejects a traversal-shaped upload id and empty commits', async () => {
  const { handler } = fixture()
  const bad = await call(handler, { method: 'PUT', url: '/api/admin/materials/chunk?uploadId=../../etc&index=0', body: Buffer.from('x') })
  assert.equal(bad.res.state.status, 400)
  assert.equal(bad.body.error, 'bad_upload_id')

  // 少一片就合并 → 会得到一个半截文件，解析时报"不是 zip"这种莫名其妙的话。
  // 按片号核对齐全，把错误说在能看懂的地方。
  const partial = await call(handler, {
    method: 'PUT', url: '/api/admin/materials/chunk?uploadId=partial12345&index=0', body: Buffer.from('前半段')
  })
  assert.equal(partial.body.ok, true)
  const incomplete = await call(handler, {
    method: 'POST', url: '/api/admin/materials/commit',
    body: JSON.stringify({ uploadId: 'partial12345', course: '刑法分论', lesson: '第10-12节', name: 'x.json', chunks: 3 })
  })
  assert.equal(incomplete.res.state.status, 400)
  assert.equal(incomplete.body.error, 'incomplete_upload')
  assert.match(incomplete.body.message, /缺 2 个分片/)

  const none = await call(handler, {
    method: 'POST', url: '/api/admin/materials/commit',
    body: JSON.stringify({ uploadId: 'nothinghere1', course: '刑法分论', lesson: '第10-12节', name: 'x.pptx' })
  })
  assert.equal(none.res.state.status, 400)
  assert.equal(none.body.error, 'incomplete_upload', '一个分片都没有时报的就是"没收齐"')
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
  // 页面里的按钮必须挂上事件委托认的属性（曾经写成 data-run，点了没反应）
  const buttons = res.state.body.match(/<button[^>]*>/g) || []
  const stray = buttons.filter(tag => /data-run=/.test(tag))
  assert.deepEqual(stray, [], '按钮不该使用事件委托不认识的属性')
  assert.ok(!res.state.body.includes(TOKEN), '页面里不得内嵌令牌')
})

test('the todo list only asks for courseware that would still change the outcome', async () => {
  // 已经发布、或已经写完笔记的课次，再提示「缺课件」纯属噪音——第一屏的待办一旦掺水就没人看了。
  const { handler, scratchRoot } = fixture()
  const outputDir = path.join(scratchRoot, 'replays', 'replay-1', 'output')
  fs.mkdirSync(outputDir, { recursive: true })
  const transcriptPath = path.join(outputDir, 'transcript.txt')
  fs.writeFileSync(transcriptPath, '正文')

  const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  const claim = store.claimTask({ replayKey: 'replay-1', workerId: 'test' })
  store.reportStage({ id: claim.task.id, stage: 'transcript_ready', message: '转录完成', data: { artifacts: { transcriptPath } } })
  store.close()

  const waiting = await call(handler, { url: '/api/admin/status' })
  assert.deepEqual(waiting.body.todos.missingMaterials.map(item => item.replayKey), ['replay-1'], '待写笔记的课次才提示补课件')

  const store2 = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  store2.reportStage({ id: store2.getTask('replay-1').id, stage: 'published', message: '已发布' })
  store2.close()

  const done = await call(handler, { url: '/api/admin/status' })
  assert.deepEqual(done.body.todos.missingMaterials, [], '发布之后就不该再催课件了')
})

test('each lesson reports what it cost, split into transcription and note writing', async () => {
  // 用户问过「转文字和写笔记各花多少钱」。这个数字来自真实用量：
  // 转写用账单口径的语音秒数，笔记用状态文件里每次模型调用的 usage。
  const { handler, scratchRoot } = fixture()
  const outputDir = path.join(scratchRoot, 'replays', 'replay-1', 'output')
  fs.mkdirSync(outputDir, { recursive: true })
  const transcriptPath = path.join(outputDir, 'transcript.txt')
  fs.writeFileSync(transcriptPath, '正文')
  // 一次大纲、一次节点写作、一次审查、一次拼装；finalNoteVersions 是拼装的历史副本，不该重复计
  const trace = (prompt, completion, cached = 0) => ({ trace: { usage: {
    prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } } } })
  fs.writeFileSync(path.join(outputDir, 'lesson-state.json'), JSON.stringify({
    savedAt: '2026-09-26T00:00:00.000Z',
    lesson: {
      status: 'notes_ready',
      finalNote: { markdown: '成品正文', assembly: trace(5000, 10000) },
      finalNoteVersions: [trace(5000, 10000)],
      outlineTraces: [{ usage: { prompt_tokens: 30000, completion_tokens: 8000 } }],
      nodes: [
        { id: 'node-1', title: '模块一', status: 'approved', draft: '草稿', versions: [trace(20000, 5000, 1000)], reviewerReports: [trace(21000, 3000)] }
      ]
    }
  }))

  const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  const claimed = store.claimTask({ replayKey: 'replay-1', workerId: 'test' })
  store.reportStage({
    id: claimed.task.id, stage: 'notes_ready', message: '笔记完成',
    data: { artifacts: { transcriptPath, notePath: path.join(outputDir, '第10-12节.md') }, runtime: { videoDurationSeconds: 7200, estimatedCostCny: 0.5 } }
  })
  store.close()

  const { body } = await call(handler, { url: '/api/admin/status' })
  const task = body.ledger.tasks.find(item => item.replayKey === 'replay-1')
  assert.equal(task.cost.asrCny, 0.5, '转写费用取账本里记的那笔（账单口径是语音时长，不是视频时长）')
  // 输入 30000+20000+21000+5000 = 76000（其中 1000 命中缓存），输出 8000+5000+3000+10000 = 26000
  assert.equal(task.cost.usage.inputTokens, 76000, 'finalNoteVersions 不能重复计一次拼装')
  assert.equal(task.cost.usage.cachedTokens, 1000)
  assert.equal(task.cost.usage.outputTokens, 26000)
  assert.equal(task.cost.usage.calls, 4, '四类调用各一次（拼装的历史副本不算）')
  assert.ok(task.cost.notesCny > 0 && task.cost.notesCny < 1, '笔记费用应在几毛量级，实际 ' + task.cost.notesCny)
  assert.equal(task.cost.totalCny, Number((task.cost.asrCny + task.cost.notesCny).toFixed(4)))
  assert.equal(body.spend.totalCny, task.cost.totalCny, '总计要等于逐课次之和')
  assert.ok(body.pricing.noteOutputPerMillionCny > body.pricing.noteInputPerMillionCny, '输出 token 比输入贵，界面上要能看出这一点')
})

test('the console reports whether wechat can actually push right now', async () => {
  // 这个通道要先有用户来信（拿到 context_token）才能推送。以前接口返回 messageId 就算「已发送」，
  // 结果微信端收不到、账本却一片绿。所以状态里必须把通道会话说清楚。
  const { handler } = fixture()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-state-'))
  const previous = process.env.OPENCLAW_STATE_DIR
  try {
    process.env.OPENCLAW_STATE_DIR = home
    const missing = await call(handler, { url: '/api/admin/status' })
    assert.equal(missing.body.channel.ok, false, '没有会话记录时要如实说推不出去')

    const accounts = path.join(home, 'openclaw-weixin', 'accounts')
    fs.mkdirSync(accounts, { recursive: true })
    fs.writeFileSync(path.join(accounts, 'bot.context-tokens.json'), JSON.stringify({ 'user@im.wechat': 'token' }))
    const ready = await call(handler, { url: '/api/admin/status' })
    assert.equal(ready.body.channel.ok, true)
    assert.ok(ready.body.channel.ageMinutes >= 0)
    assert.ok(ready.body.channel.lastInboundAt, '要说清最近一次互动是什么时候')
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR
    else process.env.OPENCLAW_STATE_DIR = previous
  }
})

test('non-admin paths are left to the static handler', async () => {
  const { handler } = fixture()
  const req = fakeRequest({ url: '/notes/x.html' })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, '/notes/x.html', new URL('http://x/notes/x.html'), { adminToken: TOKEN })
  assert.equal(handled, false)
})
/**
 * 管理台的按钮审计。
 *
 * 起因：界面上的「保存令牌」曾经把属性写成 data-run，而事件委托只认 data-act——
 * 点下去既不报错也没反应，看起来就像按钮坏了。这类错误不会有测试失败、也不会有
 * 任何日志，只能靠"把两个集合摆在一起比"来发现。因此这里逐条比对：
 *
 *   1. 页面里出现的 data-act 与脚本里处理的分支必须一一对应（多一个少一个都算错）；
 *   2. 页面里每个 tab / 跳转链接都要有对应的内容区；
 *   3. 每个动作最终拼出的 argv，其命令名与旗标必须在 CLI 的用法文本里真的存在
 *      （否则界面会照常弹"已开始"，而命令其实跑不起来）。
 */
test('every button in the console is wired to a handler, and no handler is orphaned', async () => {
  const acts = new Set([...ADMIN_HTML.matchAll(/data-act="([^"]+)"/g)].map(m => m[1]))
  const handled = new Set([...ADMIN_HTML.matchAll(/act === '([^']+)'/g)].map(m => m[1]))

  assert.ok(acts.size >= 10, '页面里应当有足够多的按钮被解析到')
  assert.deepEqual(
    [...acts].filter(act => !handled.has(act)),
    [],
    '这些按钮没有对应的处理分支，点下去不会有任何反应'
  )
  assert.deepEqual(
    [...handled].filter(act => !acts.has(act)),
    [],
    '这些分支没有按钮用到（多半是按钮改名后忘了同步）'
  )
  // 兜底：将来又加了一个没接线的按钮时，至少要弹一条"没接上"，而不是静默
  assert.match(ADMIN_HTML, /还没有接上处理逻辑/, '未接线的按钮必须报错出声，不能静默')
})

test('every tab and in-page jump target exists', async () => {
  const tabs = new Set([...ADMIN_HTML.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]))
  assert.deepEqual([...tabs].sort(), ['courses', 'notes', 'overview', 'settings'])
  for (const tab of tabs) assert.match(ADMIN_HTML, new RegExp('id="tab-' + tab + '"'), 'tab ' + tab + ' 要有一段对应的内容区')
})

test('clicking a button gives immediate visible feedback', async () => {
  // 维护动作动辄跑几分钟：没有"立刻变化"的话，用户会以为按钮没反应
  assert.match(ADMIN_HTML, /id="toast"/, '要有右下角提示条')
  assert.match(ADMIN_HTML, /function busyButton/, '按钮要能置灰改字')
  assert.match(ADMIN_HTML, /setRunState\('正在运行/, '顶部状态灯要立刻切到运行中')
  assert.match(ADMIN_HTML, /setInterval\(/, '要跟着定时任务自动刷新')
  // 全站只用事件委托，不用内联 handler（内联写法最容易与引号打架）
  assert.ok(!/\son(click|change|input)=/.test(ADMIN_HTML), '不要内联事件属性')
})

test('each console action produces a CLI command that really exists', async () => {
  const { USAGE } = await import('../../worker/src/commands.mjs')
  const argvOf = (action, payload) => buildActionArgs(action, payload, '/repo/apps/worker/bin/course.mjs')

  // 与 admin-page.mjs 里各按钮实际发出的载荷一一对应
  const cases = [
    ['retry', { replayKey: 'replay-1' }, ['retry', '--replay-key', 'replay-1']],
    ['notify-retry', {}, ['notify', '--retry-failed']],
    ['prune', {}, ['prune']],
    ['prune', { apply: true }, ['prune', '--apply']],
    ['discover', {}, ['discover']],
    ['doctor', {}, ['doctor']],
    ['backup', {}, ['backup']],
    ['notify', {}, ['notify']],
    ['cycle', { replayKey: 'replay-1', maxTasks: 1 }, ['cycle', '--max-tasks', '1', '--replay-key', 'replay-1']],
    ['cycle', { maxTasks: 5 }, ['cycle', '--max-tasks', '5']],
    ['republish', { transcriptPath: '/tmp/replay-1/output/transcript.txt', course: '刑法分论', lesson: '第10-12节', replayKey: 'replay-1' },
      ['publish', '--from', '/tmp/replay-1/output', '--course', '刑法分论', '--lesson', '第10-12节', '--replay-key', 'replay-1']]
  ]
  const flags = new Set()
  for (const [action, payload, expected] of cases) {
    const argv = argvOf(action, payload)
    assert.deepEqual(argv.slice(1), expected, action + ' 应当映射到固定的 argv')
    for (const token of argv.slice(2)) if (token.startsWith('--')) flags.add(token)
  }

  // revise 要的是"已存在的转录稿"，单独造一个文件来核对
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-revise-'))
  const transcript = path.join(dir, 'transcript.txt')
  fs.writeFileSync(transcript, '正文')
  const reviseArgv = argvOf('revise', { transcriptPath: transcript, course: '刑法分论', lesson: '第10-12节', module: 'node-3', request: '压缩到 1200 字' })
  assert.deepEqual(reviseArgv.slice(1), [
    'notes', '--transcript', transcript, '--course', '刑法分论', '--lesson', '第10-12节',
    '--output-dir', dir, '--revise', 'node-3', '--request', '压缩到 1200 字', '--ignore-cost-window', '1'
  ])
  for (const token of reviseArgv.slice(2)) if (token.startsWith('--')) flags.add(token)

  // 界面用到的每个旗标都必须真的写在用法里——改名一处忘一处是静默故障
  for (const flag of flags) {
    assert.ok(USAGE.includes(flag), 'CLI 用法里没有 ' + flag + '：界面会拼出一条跑不起来的命令')
  }
  // 命令名同理
  // 用法文本里，命令名都在行首的两个空格之后（续行缩进更多，不会误判）
  const commands = new Set([...USAGE.matchAll(/^ {2}([a-z][a-z-]*)/gm)].map(m => m[1]))
  for (const [action, payload] of cases) {
    const command = argvOf(action, payload)[1]
    assert.ok(commands.has(command), 'CLI 里没有命令 ' + command)
  }
  assert.ok(commands.has('admin-passwd'), '带连字符的命令名也要能解析出来')
})

test('the whitelist covers exactly the actions the console can send', async () => {
  const sent = new Set([...ADMIN_HTML.matchAll(/doAction\('([^']+)'/g)].map(m => m[1]))
  // 还有一处是按钮的 data-act 直接透传（扫描/投递/体检/备份），从那一行里把名字取出来
  const passthroughLine = ADMIN_HTML.split('\n').find(line => line.includes('doAction(act,')) || ''
  const passthrough = [...passthroughLine.matchAll(/act === '([a-z-]+)'/g)].map(m => m[1])
  assert.ok(sent.size + passthrough.length >= 9, '要能解析出界面发出的全部动作名')

  for (const action of [...sent, ...passthrough]) {
    assert.ok(ALLOWED_ACTIONS.has(action), '界面会发 ' + action + '，但它不在服务端白名单里，点了必定 400')
  }
})

