import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'

import {
  ADMIN_HTML,
  ALLOWED_ACTIONS,
  buildActionArgs,
  contentReleaseReport,
  createAdminHandler,
  redactStatus
} from './admin.mjs'

const TOKEN = 'test-admin-token'

function pythonAvailable() {
  return spawnSync('python3', ['-c', 'import sys;print(sys.version)'], { encoding: 'utf8' }).status === 0
}

function fixture({ runCommand, spawnOcr, now } = {}) {
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
    spawnOcr,
    // 时钟可注入：会话"多久没互动"要能用固定时间断言，不能跟着挂钟走
    ...(now ? { now } : {}),
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

/** 造一份"整页是图"的 pptx：文字抽不出来，但有一张够大的图。 */
function writeImageDeck(target) {
  const script = `
import os, struct, sys, zipfile, zlib
target = sys.argv[1]
def chunk(kind, data):
    body = kind + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
width, height = 500, 300
raw = b''.join(b'\\x00' + os.urandom(width * 3) for _ in range(height))
png = (b'\\x89PNG\\r\\n\\x1a\\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 1)) + chunk(b'IEND', b''))
ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
slide = f'<?xml version="1.0"?><p:sld {ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'
with zipfile.ZipFile(target, 'w') as zf:
    zf.writestr('ppt/slides/slide1.xml', slide)
    zf.writestr('ppt/slides/_rels/slide1.xml.rels', rels)
    zf.writestr('ppt/media/image1.png', png)
`
  execFileSync('python3', ['-c', script, target], { stdio: 'pipe' })
}

test('a deck with images queues OCR by itself — nothing to click', { skip: pythonAvailable() ? false : '未安装 python3' }, async () => {
  const spawned = []
  const { handler, scratchRoot } = fixture({
    // 用当前进程的 pid 冒充"识别进程还活着"，这样同一课次的第二次上传不会重复排队
    spawnOcr: ({ args }) => { spawned.push(args); return { pid: process.pid } }
  })
  const deckPath = path.join(scratchRoot, '封面课件.pptx')
  writeImageDeck(deckPath)
  const bytes = fs.readFileSync(deckPath)
  const params = new URLSearchParams({ course: '刑法分论', lesson: '第10-12节', scope: 'lesson', name: '封面课件.pptx' })

  const uploaded = await call(handler, { method: 'PUT', url: `/api/admin/materials?${params.toString()}`, body: bytes })
  assert.equal(uploaded.res.state.status, 200)
  assert.equal(uploaded.body.imageCount, 1, '要数出课件里有一张够大的图')
  assert.equal(uploaded.body.ocrPending, 1)
  assert.equal(uploaded.body.ocr.queued, 1, '上传后应当自动排队识别，不用点按钮')
  assert.deepEqual(spawned[0].slice(1), ['materials', '--ocr', '--course', '刑法分论', '--lesson', '第10-12节'])

  // 同一课次正在识别时不要重复起进程
  const again = await call(handler, { method: 'PUT', url: `/api/admin/materials?${params.toString()}`, body: bytes })
  assert.equal(again.body.ocr.queued, 0)
  assert.equal(again.body.ocr.reason, 'already_running')
  assert.equal(spawned.length, 1, '同一课次只跑一个识别进程')

  // 界面能从快照里看到"正在后台识别"
  const state = await call(handler, { url: '/api/admin/status' })
  const task = state.body.ledger.tasks.find(item => item.replayKey === 'replay-1')
  assert.equal(task.ocrRunning, true)
  assert.equal(task.materials[0].ocrPending, 1)

  // 纯文字课件不该排队：没有图就没有识别这件事
  const plain = Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '只有文字' }] }))
  const plainUpload = await call(handler, {
    method: 'PUT',
    url: `/api/admin/materials?${new URLSearchParams({ course: '刑法分论', lesson: '第10-12节', scope: 'lesson', name: '纯文字.json' }).toString()}`,
    body: plain
  })
  assert.equal(plainUpload.body.ocr.queued, 0)
  assert.equal(plainUpload.body.ocr.reason, 'no_images')
  assert.equal(spawned.length, 1)
})

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

test('tags live on the server so the filter rail survives a refresh', async () => {
  const { handler } = fixture()
  const empty = await call(handler, { url: '/api/admin/tags' })
  assert.deepEqual(empty.body.order, [])

  const saved = await call(handler, {
    method: 'PUT', url: '/api/admin/tags',
    body: JSON.stringify({ order: ['研二上', '考试重点'], courses: { 商法概论: ['研二上'] }, lessons: { 'replay-1': ['重点'] } })
  })
  assert.equal(saved.res.state.status, 200)
  // 用到的标签自动进顺序表（否则筛选栏里筛不到它），未被用到的不受影响
  assert.deepEqual(saved.body.order, ['研二上', '考试重点', '重点'])
  assert.deepEqual(saved.body.courses['商法概论'], ['研二上'])
  assert.deepEqual(saved.body.lessons['replay-1'], ['重点'])

  // 重排顺序（界面里拖动标签）只改 order，不动归属
  const reordered = await call(handler, {
    method: 'PUT', url: '/api/admin/tags',
    body: JSON.stringify({ order: ['考试重点', '研二上', '重点'], courses: { 商法概论: ['研二上'] }, lessons: { 'replay-1': ['重点'] } })
  })
  assert.deepEqual(reordered.body.order, ['考试重点', '研二上', '重点'], '顺序按界面拖动的结果保存')
  assert.deepEqual(reordered.body.courses['商法概论'], ['研二上'], '重排不该丢归属')

  // 新标签自动进入顺序表；状态接口里也带着标签，界面不用再多请求一次
  const withNew = await call(handler, {
    method: 'PUT', url: '/api/admin/tags',
    body: JSON.stringify({ order: ['考试重点'], courses: { 商法概论: ['考试重点', '待补课件'] } })
  })
  assert.ok(withNew.body.order.includes('待补课件'), '未登记过的标签要自动补进顺序表')
  const status = await call(handler, { url: '/api/admin/status' })
  assert.deepEqual(status.body.tags.order, withNew.body.order)
})

test('storage usage is reported by category, not as a wall of filenames', async () => {
  const { handler, scratchRoot } = fixture()
  fs.mkdirSync(path.join(scratchRoot, 'replays', 'a'), { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, 'replays', 'a', 'transcript.md'), 'x'.repeat(5000))
  fs.mkdirSync(path.join(scratchRoot, 'materials', 'c', 'l'), { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, 'materials', 'c', 'l', 'deck.pptx'), Buffer.alloc(20000))

  const { body } = await call(handler, { url: '/api/admin/storage' })
  assert.equal(body.ok, true)
  const replays = body.categories.find(item => item.key === 'replays')
  const materials = body.categories.find(item => item.key === 'materials')
  assert.ok(replays.bytes >= 5000, '回放产物要算进去')
  assert.ok(materials.bytes >= 20000, '课件要算进去')
  assert.ok(body.totalBytes >= 25000)
  assert.ok(body.categories.every(item => typeof item.hint === 'string' && item.hint.length > 0), '每一类都要有一句人话说明')
  assert.ok(!JSON.stringify(body).includes('transcript.md'), '不要贴文件名，按类别汇总')
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

  await run('rebuild-content')
  assert.deepEqual(calls.at(-1).args.slice(1), ['publish', '--rebuild'])

  await run('rollback-content')
  assert.deepEqual(calls.at(-1).args.slice(1), ['publish', '--rollback-site', '--yes'])

  await run('rebuild-integration', { id: '刑法::总论' })
  assert.deepEqual(calls.at(-1).args.slice(1), ['integrate', '--configured', '--id', '刑法::总论'])

  // 缺参数要被挡住，而不是拼出一条残缺命令
  const bad = await run('revise', { course: '刑法分论' })
  assert.equal(bad.res.state.status, 400)
  assert.equal(bad.body.error, 'bad_arguments')

  // 不在白名单里的动作一律拒绝
  const unknown = await run('rm-rf')
  assert.equal(unknown.res.state.status, 400)
  assert.equal(unknown.body.error, 'unsupported_action')
})

test('content release report recognizes atomic mode and keeps rollback candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-content-release-'))
  const site = path.join(root, 'site')
  const releases = site + '.releases'
  fs.mkdirSync(releases, { recursive: true })
  const first = path.join(releases, 'legacy-20261001')
  const second = path.join(releases, 'release-20261002')
  for (const dir of [first, second]) {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([{ slug: 'notes/a' }]))
  }
  fs.symlinkSync(path.relative(path.dirname(site), second), site, 'dir')

  const report = contentReleaseReport(site)
  assert.equal(report.mode, 'atomic')
  assert.equal(report.current, 'release-20261002')
  assert.equal(report.canRollback, true)
  assert.equal(report.releases.find(item => item.current).notes, 1)
})

test('integration definitions can be managed from the admin API and report fresh/stale/missing', async () => {
  const { handler, dir, scratchRoot } = fixture()
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([{
    slug: 'notes/刑法分论/第10-12节',
    courseName: '刑法分论',
    lessonTitle: '第10-12节',
    checksum: 'sum-1',
    markdown: '# 正文'
  }]))

  const saved = await call(handler, {
    method: 'PUT',
    url: '/api/admin/integrations',
    body: JSON.stringify({
      definition: {
        id: 'criminal-general',
        course: '刑法分论',
        topic: '总论框架',
        lessons: ['第10-12节']
      }
    })
  })
  assert.equal(saved.res.state.status, 200)
  assert.equal(saved.body.content.integrations.items[0].status, 'missing', '定义存在但产物没生成时要明确报缺失')
  const manifest = JSON.parse(fs.readFileSync(path.join(scratchRoot, 'integration-manifest.json'), 'utf8'))
  assert.equal(manifest.integrations[0].id, 'criminal-general')

  const integrationDir = path.join(scratchRoot, 'integrations')
  fs.mkdirSync(integrationDir, { recursive: true })
  fs.writeFileSync(path.join(integrationDir, 'criminal.json'), JSON.stringify({
    kind: 'course-integration',
    integrationId: 'criminal-general',
    course: '刑法分论',
    topic: '总论框架',
    generatedAt: '2026-10-02T00:00:00.000Z',
    lessons: [{
      slug: 'notes/刑法分论/第10-12节',
      lessonTitle: '第10-12节',
      checksum: 'sum-1',
      contentFingerprint: 'abc'
    }]
  }))
  fs.writeFileSync(path.join(integrationDir, 'criminal.md'), '# 整合\n')

  const fresh = await call(handler, { url: '/api/admin/content' })
  assert.equal(fresh.body.integrations.items[0].status, 'fresh')

  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([{
    slug: 'notes/刑法分论/第10-12节',
    courseName: '刑法分论',
    lessonTitle: '第10-12节',
    checksum: 'sum-2',
    markdown: '# 修订'
  }]))
  const stale = await call(handler, { url: '/api/admin/content' })
  assert.equal(stale.body.integrations.items[0].status, 'stale')
  assert.deepEqual(stale.body.integrations.items[0].staleLessons, ['第10-12节'])

  const removed = await call(handler, { method: 'DELETE', url: '/api/admin/integrations?id=criminal-general' })
  assert.equal(removed.res.state.status, 200)
  assert.equal(removed.body.content.integrations.items.length, 0)
  assert.ok(!fs.existsSync(path.join(integrationDir, 'criminal.json')), '删定义时同一 identity 的整合 JSON 一起清掉')
  assert.ok(!fs.existsSync(path.join(integrationDir, 'criminal.md')), 'Markdown 产物也一起清掉')
})


test('topic definitions are separate from legacy integrations and report fresh/stale/missing', async () => {
  const { handler, dir, scratchRoot } = fixture()
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([{
    slug: 'notes/国际刑法学/第2讲',
    courseName: '国际刑法学',
    lessonTitle: '第2讲',
    checksum: 'sum-topic-1',
    markdown: '## 胜者正义\\n\\n正文',
    sections: [{ id: '胜者正义', title: '胜者正义' }]
  }]))

  const saved = await call(handler, {
    method: 'PUT',
    url: '/api/admin/topics',
    body: JSON.stringify({
      definition: {
        id: 'intl-trial',
        course: '国际刑法学',
        title: '国际刑事审判',
        lessons: ['notes/国际刑法学/第2讲']
      }
    })
  })
  assert.equal(saved.res.state.status, 200)
  assert.equal(saved.body.content.topics.items[0].status, 'missing')
  assert.equal(saved.body.content.integrations.items.length, 0, '新专题不应写进旧章级整合清单')

  const manifest = JSON.parse(fs.readFileSync(path.join(scratchRoot, 'topic-manifest.json'), 'utf8'))
  assert.equal(manifest.topics[0].id, 'intl-trial')

  const topicDir = path.join(scratchRoot, 'topics')
  fs.mkdirSync(topicDir, { recursive: true })
  fs.writeFileSync(path.join(topicDir, 'intl.json'), JSON.stringify({
    kind: 'course-topic',
    version: 1,
    id: 'intl-trial',
    course: '国际刑法学',
    title: '国际刑事审判',
    generatedAt: '2026-10-04T00:00:00.000Z',
    lessons: [{
      slug: 'notes/国际刑法学/第2讲',
      lessonTitle: '第2讲',
      checksum: 'sum-topic-1'
    }],
    nodes: [{ id: 'n1', title: '胜者正义', relation: 'hierarchy', sourceRefs: [{ slug: 'notes/国际刑法学/第2讲', sectionId: '胜者正义' }], children: [] }]
  }))

  const fresh = await call(handler, { url: '/api/admin/content' })
  assert.equal(fresh.body.topics.items[0].status, 'fresh')

  const adjusted = await call(handler, {
    method: 'PUT',
    url: '/api/admin/topics',
    body: JSON.stringify({
      definition: {
        id: 'intl-trial',
        course: '国际刑法学',
        title: '国际刑事审判与正当性',
        lessons: ['notes/国际刑法学/第2讲']
      }
    })
  })
  assert.equal(adjusted.body.content.topics.items[0].status, 'stale', '人工调整专题定义后旧产物必须标待更新')
  assert.equal(adjusted.body.content.topics.items[0].definitionChanged, true)

  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([{
    slug: 'notes/国际刑法学/第2讲',
    courseName: '国际刑法学',
    lessonTitle: '第2讲',
    checksum: 'sum-topic-2',
    markdown: '## 胜者正义\\n\\n修订'
  }]))
  const stale = await call(handler, { url: '/api/admin/content' })
  assert.equal(stale.body.topics.items[0].status, 'stale')
  assert.deepEqual(stale.body.topics.items[0].staleLessons, ['第2讲'])

  const removed = await call(handler, { method: 'DELETE', url: '/api/admin/topics?id=intl-trial' })
  assert.equal(removed.res.state.status, 200)
  assert.equal(removed.body.content.topics.items.length, 0)
  assert.ok(!fs.existsSync(path.join(topicDir, 'intl.json')))
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

test('legacy console passwords no longer authenticate browser API access', async () => {
  const { handler, scratchRoot } = fixture()

  const retired = await call(handler, { method: 'PUT', url: '/api/admin/password', body: JSON.stringify({ password: 'wo-de-mi-ma-2026' }) })
  assert.ok([404, 410].includes(retired.res.state.status), '旧 Course 密码接口必须退役')
  assert.equal(fs.existsSync(path.join(scratchRoot, 'admin-password.json')), false, '退役接口不得再创建密码文件')

  const byPassword = await call(handler, { url: '/api/admin/status' }, { token: 'wo-de-mi-ma-2026' })
  assert.equal(byPassword.res.state.status, 401, '统一登录后旧 Course 密码不得继续作为浏览器凭据')

  const byMaster = await call(handler, { url: '/api/admin/status' }, { token: TOKEN })
  assert.equal(byMaster.res.state.status, 200, '服务器主令牌只保留为内部应急路径')
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

/** 等一个 job 跑完（C2：长动作不再挂着请求等，前端按 jobId 轮询）。 */
async function waitJob (handler, jobId, tries = 50) {
  for (let index = 0; index < tries; index += 1) {
    const { body } = await call(handler, { url: '/api/admin/job?id=' + encodeURIComponent(jobId) })
    if (body.status && body.status !== 'running') return body
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job 一直没有结束：' + jobId)
}

test('最近任务：状态保留，但实现边界不塞进前端', async () => {
  const { handler } = fixture()
  const before = await call(handler, { url: '/api/admin/status' })
  assert.deepEqual(before.body.recentJobs, [], '这一版服务还没跑过命令时，最近任务是空的')

  const started = await call(handler, {
    method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'doctor' })
  })
  assert.equal(started.res.state.status, 202)
  await waitJob(handler, started.body.jobId)

  const after = await call(handler, { url: '/api/admin/status' })
  const job = after.body.recentJobs.find(item => item.id === started.body.jobId)
  assert.ok(job, '跑完的任务要出现在最近任务里')
  assert.equal(job.status, 'done')
  assert.equal(job.exitCode, 0)
  assert.equal(job.action, 'doctor')
  assert.ok(job.finishedAt, '完成时间要给出，页面上要显示什么时候跑的')

  assert.match(ADMIN_HTML, /<span class="ttl">运行状态<\/span>/)
  assert.match(ADMIN_HTML, /\.run-console\{max-height:320px;overflow:auto/)
  assert.match(ADMIN_HTML, /id="recentJobs"/)
  assert.doesNotMatch(ADMIN_HTML, /进程内快照，服务重启后这里就空了/)
  assert.doesNotMatch(ADMIN_HTML, /已确认的课程阶段在账本里/)
})

test('概览先给四个状态汇总，点状态才展开紧凑清单', () => {
  assert.match(ADMIN_HTML, /class="grid four"/)
  assert.match(ADMIN_HTML, /data-value="published"[\s\S]{0,120}<small>已发布<\/small>/)
  assert.match(ADMIN_HTML, /data-value="active"[\s\S]{0,120}<small>进行中<\/small>/)
  assert.match(ADMIN_HTML, /data-value="attention"[\s\S]{0,120}<small>待处理<\/small>/)
  assert.match(ADMIN_HTML, /data-value="queued"[\s\S]{0,120}<small>排队中<\/small>/)
  assert.match(ADMIN_HTML, /class="status-expand"/)
  assert.doesNotMatch(ADMIN_HTML, /件待处理/, '不再把待处理清单做成概览第一张巨型卡片')
})

test('课程管理内嵌专题维护，不再要求跳到“管理专题整合”页面', () => {
  assert.match(ADMIN_HTML, /data-fold="courseIntegration"/)
  assert.match(ADMIN_HTML, /function courseIntegrationHtml/)
  assert.match(ADMIN_HTML, /data-act="save-integration"/)
  assert.doesNotMatch(ADMIN_HTML, /管理专题整合/)
  assert.doesNotMatch(ADMIN_HTML, /把同一课程的多节课组织成持续更新的专题笔记/)
})

test('管理台只呈现产品概念，不把原型和实现说明端给用户', () => {
  assert.match(ADMIN_HTML, /高级维护/)
  assert.match(ADMIN_HTML, /公开站点/)
  assert.match(ADMIN_HTML, /专题整合/)
  assert.match(ADMIN_HTML, />继续处理待办</)
  assert.match(ADMIN_HTML, />扫描录播</)
  assert.match(ADMIN_HTML, />发送待发通知</)
  assert.match(ADMIN_HTML, />运行检查</)
  assert.match(ADMIN_HTML, />检查可清理内容</)
  assert.match(ADMIN_HTML, />清理可清理原件</)
  assert.match(ADMIN_HTML, /'course-note': '课程笔记'/)
  assert.match(ADMIN_HTML, /sent: '已发送'/)

  assert.doesNotMatch(ADMIN_HTML, /<span class="meta">规划中<\/span>/)
  assert.doesNotMatch(ADMIN_HTML, /已有原型（控制台未接线）/)
  assert.doesNotMatch(ADMIN_HTML, /命令行可用/)
  assert.doesNotMatch(ADMIN_HTML, /章节范围由你确认一次/)
  assert.doesNotMatch(ADMIN_HTML, /还没有长期章节定义/)
  assert.doesNotMatch(ADMIN_HTML, /从当前阶段继续跑到发布/)
  assert.doesNotMatch(ADMIN_HTML, /清掉失败状态与退避时间/)
  assert.doesNotMatch(ADMIN_HTML, /原子重建站点/)
  assert.doesNotMatch(ADMIN_HTML, />跑一轮完整链路</)
  assert.doesNotMatch(ADMIN_HTML, />投递通知</)
  assert.doesNotMatch(ADMIN_HTML, />备份账本</)
  assert.doesNotMatch(ADMIN_HTML, />清理预演</)
  assert.doesNotMatch(ADMIN_HTML, /跟随环境变量/)
  assert.doesNotMatch(ADMIN_HTML, /esc\(c\.path \|\| ''\)/, '配置文件路径不应直接出现在设置正文里')
})

test('run 立刻返回 jobId，结果由 job 接口查（不再挂着一个请求等几分钟）', async () => {
  const { handler, calls } = fixture()
  const { res, body } = await call(handler, {
    method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'cycle', maxTasks: 3 })
  })
  assert.equal(res.state.status, 202, '长动作应当是 202 + jobId，而不是等它跑完再回 200')
  assert.equal(body.ok, true)
  assert.ok(body.jobId, '必须给出 jobId')
  assert.equal(body.poll, '/api/admin/job?id=' + body.jobId)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['/repo/apps/worker/bin/course.mjs', 'cycle', '--max-tasks', '3'])

  const finished = await waitJob(handler, body.jobId)
  assert.equal(finished.status, 'done')
  assert.equal(finished.exitCode, 0)
  assert.equal(finished.action, 'cycle')

  // 未知 id 要说清"进程内只保留最近 20 个"，而不是含糊的 500
  const missing = await call(handler, { url: '/api/admin/job?id=不存在的' })
  assert.equal(missing.res.state.status, 404)
  assert.equal(missing.body.error, 'job_not_found')
})

test('run rejects unsupported actions and unknown routes', async () => {
  const { handler } = fixture()
  const bad = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'rm-rf' }) })
  assert.equal(bad.res.state.status, 400)
  assert.equal(bad.body.error, 'unsupported_action')

  const unknown = await call(handler, { url: '/api/admin/nope' })
  assert.equal(unknown.res.state.status, 404)
})

test('a second run queues behind the active job and starts automatically', async () => {
  let releases = []
  const { handler } = fixture({
    runCommand: () => new Promise(resolve => { releases.push(() => resolve({ code: 0, stdout: '{}', stderr: '' })) })
  })

  const first = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'discover', course: 'A', lesson: '第一讲' }) })
  assert.equal(first.res.state.status, 202)
  assert.equal(first.body.status, 'running')

  const second = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'doctor' }) })
  assert.equal(second.res.state.status, 202)
  assert.equal(second.body.status, 'queued')
  assert.equal(second.body.queuePosition, 1)

  const during = await call(handler, { url: '/api/admin/status' })
  assert.equal(during.body.running.action, 'discover')
  assert.equal(during.body.running.meta.course, 'A')
  assert.equal(during.body.queue.length, 1)
  assert.equal(during.body.queue[0].id, second.body.jobId)
  assert.equal(during.body.queue[0].queuePosition, 1)

  releases.shift()()
  const doneFirst = await waitJob(handler, first.body.jobId)
  assert.equal(doneFirst.status, 'done')

  for (let i = 0; i < 20 && releases.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(releases.length, 1, '第一项完成后第二项应自动开始')
  const runningSecond = await call(handler, { url: '/api/admin/job?id=' + encodeURIComponent(second.body.jobId) })
  assert.equal(runningSecond.body.status, 'running')

  releases.shift()()
  const doneSecond = await waitJob(handler, second.body.jobId)
  assert.equal(doneSecond.status, 'done')
})

test('a failing run is reported as not ok rather than swallowed', async () => {
  const { handler } = fixture({
    runCommand: async () => ({ code: 1, stdout: JSON.stringify({ errors: [{ step: 'discover', message: 'AUTH_EXPIRED' }] }), stderr: 'boom' })
  })
  const { res, body } = await call(handler, { method: 'POST', url: '/api/admin/run', body: JSON.stringify({ action: 'discover' }) })
  assert.equal(res.state.status, 202)
  const finished = await waitJob(handler, body.jobId)
  assert.equal(finished.status, 'failed', '失败要如实报成 failed，不能吞掉')
  assert.equal(finished.exitCode, 1)
  assert.match(finished.stderr, /boom/)
  assert.match(JSON.stringify(finished.result), /AUTH_EXPIRED/)
})

test('the console page redirects unauthenticated browsers to law-tech SSO', async () => {
  const { handler } = fixture()
  const req = fakeRequest({ url: '/admin' })
  const res = fakeResponse()
  const handled = await handler.handle(req, res, '/admin', new URL('http://x/admin'), { adminToken: TOKEN })
  assert.equal(handled, true)
  assert.equal(res.state.status, 302)
  assert.match(res.state.headers.location, /^https:\/\/desk\.law-tech\.dev\/api\/course\/sso\?next=/)
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

test('推送通道把"已过期（超过 12 小时）"直接写出来，并给一句可执行提示', async () => {
  // 用户的原话是"那个『最近互动 23 小时前』我得自己算"——所以判断结论由服务端给出，
  // 界面只负责显示，不要求人做减法。时钟固定，年龄才是确定的。
  const fixed = new Date('2026-09-28T12:00:00Z')
  const { handler } = fixture({ now: () => fixed.getTime() })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-state-'))
  const previous = process.env.OPENCLAW_STATE_DIR
  try {
    process.env.OPENCLAW_STATE_DIR = home
    const accounts = path.join(home, 'openclaw-weixin', 'accounts')
    fs.mkdirSync(accounts, { recursive: true })
    const tokens = path.join(accounts, 'bot.context-tokens.json')
    fs.writeFileSync(tokens, JSON.stringify({ 'user@im.wechat': 'token' }))

    const old = new Date(fixed.getTime() - 23 * 3600 * 1000)
    fs.utimesSync(tokens, old, old)
    const expired = await call(handler, { url: '/api/admin/status' })
    assert.equal(expired.body.channel.ok, true)
    assert.equal(expired.body.channel.fresh, false)
    assert.equal(expired.body.channel.expired, true, '23 小时 > 12 小时，要判为已过期')
    assert.equal(expired.body.channel.limitHours, 12)
    assert.equal(expired.body.channel.ageText, '23 小时前')
    assert.equal(expired.body.channel.summary, '已过期（超过 12 小时）：最近互动 23 小时前')
    assert.match(expired.body.channel.hint, /给微信机器人发一条消息/, '要给出可执行的动作')
    // 自动激活做不到，这一点也要露出来（依据在 apps/worker/src/wechat.mjs 与 deploy/README.md）
    assert.equal(expired.body.channel.activation.supported, false)
    assert.match(expired.body.channel.activation.reason, /没有可自动重建会话的入口/)

    const freshAt = new Date(fixed.getTime() - 3600 * 1000)
    fs.utimesSync(tokens, freshAt, freshAt)
    const fresh = await call(handler, { url: '/api/admin/status' })
    assert.equal(fresh.body.channel.expired, false)
    assert.equal(fresh.body.channel.summary, '最近互动 1 小时前')
    assert.equal(fresh.body.channel.hint, '', '没过期就不要给恢复会话的提示')
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR
    else process.env.OPENCLAW_STATE_DIR = previous
  }
})

test('过期这件事在界面上写清楚了（不是只丢一个"23 小时前"）', async () => {
  // 服务端给结论、界面显示结论：卡片上要能直接看到"已过期"和恢复办法
  assert.match(ADMIN_HTML, /微信机器人 ' \+ \(c\.fresh \? '可用' : '已过期'\)/, '通道卡片要直接写"已过期"')
  assert.match(ADMIN_HTML, /esc\(summary\)/, '把服务端那句结论（含阈值）原样显示出来')
  assert.match(ADMIN_HTML, /esc\(c\.hint \|\| '需要重新扫码\/重新登录 OpenClaw'\)/, '过期时要给一句可执行提示')
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
/** 把页面里每一段内联脚本切出来：整页白屏这种故障只有解析一遍才挡得住。 */
function inlineScriptsOf(html) {
  const scripts = []
  let at = 0
  for (;;) {
    const start = html.indexOf('<script', at)
    if (start < 0) break
    const open = html.indexOf('>', start) + 1
    const end = html.indexOf('</script>', open)
    if (end < 0) break
    scripts.push(html.slice(open, end))
    at = end + 9
  }
  return scripts
}

test('the console inline script actually parses', async () => {
  // 这一条是被真事逼出来的：模板字符串里一个没转义的换行会变成字符串里的真实换行，
  // 整段脚本语法错误——页面白屏，而单元测试全绿（因为测试只检查字符串，不解析它）。
  // 与 site.test.mjs 同一套做法：逐段切出来解析，将来再加一段也照样挡得住。
  const scripts = inlineScriptsOf(ADMIN_HTML)
  assert.ok(scripts.length >= 1, '页面里要有内联脚本')
  scripts.forEach((script, index) => {
    assert.doesNotThrow(() => new Function(script), '管理台第 ' + (index + 1) + ' 段内联脚本语法错误（整页会白屏）')
  })

  // 图标是拼字符串拼出来的：写错名字不会报错，只会画出一个空方块，
  // 所以把"用到的图标"和"定义过的图标"对一遍
  const defined = new Set([...ADMIN_HTML.matchAll(/^\s{4}([a-z]+): '<(?:path|rect|circle)/gm)].map(match => match[1]))
  const used = new Set([...ADMIN_HTML.matchAll(/icon\('([a-z]+)'\)/g)].map(match => match[1]))
  assert.ok(defined.size >= 8, '图标表里应当有足够多的图标')
  assert.deepEqual([...used].filter(name => !defined.has(name)), [], '这些图标没有定义，画出来是空的')
})

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
  assert.deepEqual([...tabs].sort(), ['content', 'courses', 'overview', 'settings'])
  for (const tab of tabs) assert.match(ADMIN_HTML, new RegExp('id="tab-' + tab + '"'), 'tab ' + tab + ' 要有一段对应的内容区')
})

test('clicking a button gives immediate visible feedback', async () => {
  // 长动作提交后立刻释放按钮；真正的运行/排队状态统一由任务中心展示。
  assert.match(ADMIN_HTML, /id="toast"/, '要有轻量提示条')
  assert.match(ADMIN_HTML, /function busyButton/, '按钮要能置灰改字')
  assert.match(ADMIN_HTML, /busyButton\(btn, '提交中…'\)/, '提交阶段要立刻给按钮反馈')
  assert.match(ADMIN_HTML, /status\.queue \|\| \[\]/, '任务中心要读取服务端排队状态')
  assert.match(ADMIN_HTML, /setInterval\(/, '任务中心要自动刷新')
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
    ['rebuild-content', {}, ['publish', '--rebuild']],
    ['rollback-content', {}, ['publish', '--rollback-site', '--yes']],
    ['rebuild-integration', { id: '刑法::总论' }, ['integrate', '--configured', '--id', '刑法::总论']],
    ['rebuild-integrations', {}, ['integrate', '--configured']],
    // 课次行里的「立即跑这一节」：显式点击＝"我就是要跑"，所以带上 --require-materials 0
    // （整轮那个按钮不带：它做的事与定时任务一样，缺课件就该跳过）
    ['cycle', { replayKey: 'replay-1', maxTasks: 1 },
      ['cycle', '--max-tasks', '1', '--replay-key', 'replay-1', '--require-materials', '0']],
    ['cycle', { maxTasks: 5 }, ['cycle', '--max-tasks', '5']],
    ['refresh-note', { replayKey: 'replay-1' }, ['refresh-note', '--replay-key', 'replay-1']]
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

/** 课件归档的夹具：手写 meta.json 与解析结果，免得为了两页文字去依赖 python。 */
function writeDeck(scratchRoot, { course = '刑法分论', lesson = '第10-12节', name, slideCount = 1, images = 0 }) {
  const dir = path.join(scratchRoot, 'materials', course, lesson)
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
  const parsedPath = path.join(dir, 'slides', `${name}.json`)
  fs.writeFileSync(path.join(dir, name), 'fake')
  fs.writeFileSync(parsedPath, JSON.stringify({
    slideCount,
    slides: Array.from({ length: slideCount }, (_, index) => ({ slideNumber: index + 1, text: `第 ${index + 1} 页` })),
    images: Array.from({ length: images }, () => ({ path: 'ppt/media/image1.png', needsOcr: true })),
    ocr: { pending: images }
  }, null, 2))
  const metaPath = path.join(dir, 'meta.json')
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { materials: [] }
  meta.materials = [...(meta.materials || []).filter(item => item.name !== name), {
    name,
    scope: 'lesson',
    course,
    lesson,
    replayKey: 'replay-1',
    appliesTo: [],
    bytes: 4,
    checksum: 'fixture',
    slideCount,
    imageCount: images,
    ocrPending: images,
    ocr: { pending: images },
    parsedPath,
    addedAt: '2026-09-25T10:00:00.000Z'
  }]
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  return { dir, parsedPath, metaPath }
}

test('a courseware file can be deleted from the console and leaves nothing behind', async () => {
  const { handler, scratchRoot } = fixture()
  const deck = Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '第一页' }] }))
  const params = new URLSearchParams({ course: '刑法分论', lesson: '第10-12节', scope: 'lesson', name: '待删课件.json' })
  const uploaded = await call(handler, { method: 'PUT', url: `/api/admin/materials?${params.toString()}`, body: deck })
  assert.equal(uploaded.body.ok, true)
  const dir = path.join(scratchRoot, 'materials', '刑法分论', '第10-12节')
  assert.ok(fs.existsSync(path.join(dir, '待删课件.json')))
  assert.ok(fs.existsSync(path.join(dir, 'slides', '待删课件.json.json')), '解析结果也要在')

  const removed = await call(handler, { method: 'DELETE', url: `/api/admin/materials?${params.toString()}` })
  assert.equal(removed.res.state.status, 200)
  assert.equal(removed.body.ok, true)
  assert.equal(removed.body.remaining, 0)
  assert.ok(!fs.existsSync(path.join(dir, '待删课件.json')), '原件要删掉')
  assert.ok(!fs.existsSync(path.join(dir, 'slides', '待删课件.json.json')), '解析结果要删掉')
  assert.ok(!fs.existsSync(path.join(dir, 'meta.json')), '一份课件都不剩时不该留着 meta.json')
  assert.ok(!fs.existsSync(dir), '课次目录空了就一并收掉，不留空壳')
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'materials', '刑法分论')), '课程目录空了也一样')

  const status = await call(handler, { url: '/api/admin/status' })
  assert.deepEqual(status.body.ledger.tasks[0].materials, [], '列表里不能剩一条指向不存在文件的记录')

  // 不在归档里的名字：明确拒绝，而不是"看起来删了其实什么也没发生"
  const missing = await call(handler, { method: 'DELETE', url: `/api/admin/materials?${params.toString()}` })
  assert.equal(missing.res.state.status, 404)
  assert.equal(missing.body.error, 'material_not_found')
})

test('deleting one deck keeps the others listed', async () => {
  const { handler, scratchRoot } = fixture()
  writeDeck(scratchRoot, { name: '留下的课件.pptx', slideCount: 3 })
  const { metaPath } = writeDeck(scratchRoot, { name: '要删的课件.pptx', slideCount: 2 })

  const params = new URLSearchParams({ course: '刑法分论', lesson: '第10-12节', scope: 'lesson', name: '要删的课件.pptx' })
  const removed = await call(handler, { method: 'DELETE', url: `/api/admin/materials?${params.toString()}` })
  assert.equal(removed.body.remaining, 1)
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  assert.deepEqual(meta.materials.map(item => item.name), ['留下的课件.pptx'])
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'materials', '刑法分论', '第10-12节', '要删的课件.pptx')))

  const status = await call(handler, { url: '/api/admin/status' })
  assert.deepEqual(status.body.ledger.tasks[0].materials.map(item => item.name), ['留下的课件.pptx'])
})

test('an abandoned chunked upload is cleaned up when the user cancels', async () => {
  const { handler, scratchRoot } = fixture()
  const chunked = await call(handler, {
    method: 'PUT', url: '/api/admin/materials/chunk?uploadId=cancel123456&index=0', body: Buffer.from('前半段')
  })
  assert.equal(chunked.body.ok, true)
  const dir = path.join(scratchRoot, 'tmp', 'uploads', 'cancel123456')
  assert.ok(fs.existsSync(dir))

  const canceled = await call(handler, { method: 'DELETE', url: '/api/admin/materials/chunk?uploadId=cancel123456' })
  assert.equal(canceled.body.canceled, true)
  assert.ok(!fs.existsSync(dir), '取消之后分片不该留在磁盘上')

  const bad = await call(handler, { method: 'DELETE', url: '/api/admin/materials/chunk?uploadId=../etc' })
  assert.equal(bad.res.state.status, 400)
})

test('the console shows how far background OCR has got', async () => {
  const { handler, scratchRoot } = fixture()
  writeDeck(scratchRoot, { name: '图片版课件.pptx', slideCount: 1, images: 2 })

  // 识别进程写的进度快照 + 排队时定下的分母
  const progressPath = path.join(scratchRoot, 'ocr', 'job.progress.json')
  fs.mkdirSync(path.dirname(progressPath), { recursive: true })
  fs.writeFileSync(progressPath, JSON.stringify({
    records: [{ name: '图片版课件.pptx', status: 'running', images: 4, completed: 1, pending: 3 }]
  }))
  const job = {
    course: '刑法分论', lesson: '第10-12节', pid: process.pid,
    startedAt: '2026-09-25T10:02:00.000Z',
    logPath: path.join(scratchRoot, 'ocr', 'job.log'),
    progressPath,
    plan: { materials: 1, images: 4 }
  }
  const ocrStatePath = path.join(scratchRoot, 'ocr-state.json')
  fs.writeFileSync(ocrStatePath, JSON.stringify([job]))

  const running = await call(handler, { url: '/api/admin/status' })
  const task = running.body.ledger.tasks[0]
  assert.equal(task.ocrRunning, true)
  assert.deepEqual(task.ocr, {
    running: true, total: 4, done: 1, percent: 25,
    current: '图片版课件.pptx', currentImages: 4, currentDone: 1, materials: 1, startedAt: job.startedAt
  })
  assert.deepEqual(running.body.ocrJobs, [{
    courseName: '刑法分论', lesson: '第10-12节',
    running: true, total: 4, done: 1, percent: 25,
    current: '图片版课件.pptx', currentImages: 4, currentDone: 1, materials: 1, startedAt: job.startedAt
  }], '切到别的课程以后，底部运行面板仍要能看到这份 OCR 的进度')

  // 进程没了就不该再报"正在识别"：死条目顺手清掉，免得进度条永远停在那
  fs.writeFileSync(ocrStatePath, JSON.stringify([{ ...job, pid: 1_073_741_824 }]))
  const done = await call(handler, { url: '/api/admin/status' })
  assert.equal(done.body.ledger.tasks[0].ocrRunning, false)
  assert.equal(done.body.ledger.tasks[0].ocr, null)
  assert.deepEqual(JSON.parse(fs.readFileSync(ocrStatePath, 'utf8')), [], '死进程的条目要清掉')
})

test('a long deck can be read past the first screen', async () => {
  const { handler, scratchRoot } = fixture()
  writeDeck(scratchRoot, { name: '长课件.pptx', slideCount: 12 })
  const params = new URLSearchParams({ course: '刑法分论', lesson: '第10-12节', name: '长课件.pptx', pages: '8' })

  const first = await call(handler, { url: `/api/admin/material?${params.toString()}` })
  assert.equal(first.body.pages.length, 8)
  assert.equal(first.body.slideCount, 12)
  assert.equal(first.body.hasMore, true, '还有 4 页没给：界面要能继续加载')

  const more = await call(handler, { url: `/api/admin/material?${params.toString()}&offset=8` })
  assert.equal(more.body.pages.length, 4)
  assert.equal(more.body.pages[0].slideNumber, 9)
  assert.equal(more.body.hasMore, false)
})

test('课件区与课次操作保持简洁，技术说明不回到前端', async () => {
  assert.match(ADMIN_HTML, /class="dropzone"/, '课件区要有虚线拖放区')
  assert.match(ADMIN_HTML, /拖到这里、点按选择，或粘贴文件/, '虚线框本身就是上传入口')
  assert.match(ADMIN_HTML, /data-drop="/, '拖放区要知道自己属于哪节课')
  assert.match(ADMIN_HTML, /addEventListener\('paste'/, '页面级粘贴要认剪贴板里的文件')
  assert.match(ADMIN_HTML, /act === 'cancel-upload'/, '上传要能取消')
  assert.match(ADMIN_HTML, /act === 'delete-material'/, '已上传的课件要能删')
  assert.match(ADMIN_HTML, /method: 'DELETE'/, '删除走 DELETE')
  assert.match(ADMIN_HTML, /data-act="load-more"/, '预览要能继续加载')
  assert.match(ADMIN_HTML, /当前显示到第/, '要说清当前显示到第几页')
  assert.match(ADMIN_HTML, /图片识别 ' \+ Number\(info\.done/, '课次详情只低调显示 OCR done/total')
  assert.match(ADMIN_HTML, /id="ocrJobs"/, '跨课程 OCR 进度集中在运行状态里')
  assert.ok(!/>上传课件</.test(ADMIN_HTML), '不再重复放一个上传课件按钮')
  assert.ok(!/重新识别图片文字/.test(ADMIN_HTML), 'OCR 恢复动作缩成次级“补识别”')
  assert.match(ADMIN_HTML, /补识别/)

  assert.match(ADMIN_HTML, /discovered: '排队中'/)
  assert.match(ADMIN_HTML, /downloaded: '待转写'/)
  assert.match(ADMIN_HTML, /transcript_ready: '待写笔记'/)
  assert.match(ADMIN_HTML, /needs_attention: '需处理'/)
  assert.match(ADMIN_HTML, /class="errbox"><pre>' \+ esc\(String\(task\.lastError\)\)/, 'last_error 要给原文，不截断')
  assert.match(ADMIN_HTML, />重试</)
  assert.match(ADMIN_HTML, />继续处理</)
  assert.match(ADMIN_HTML, />更新笔记</)
  assert.match(ADMIN_HTML, />查看笔记</)
  assert.doesNotMatch(ADMIN_HTML, /立即跑这一节|清除失败、重新排队|从当前阶段继续跑到发布|清掉失败状态与退避时间/)

  // 已发布笔记只留“更新笔记 + 查看笔记”；重新发布不再作为独立用户动作。
  assert.doesNotMatch(ADMIN_HTML, /data-act="republish"/)
  assert.match(ADMIN_HTML, /<a class="act"[^>]+>查看笔记<\/a>/)

  // 设置改成与课程区一致的分栏：没有折叠块，分类是 button 且带 aria-current。
  assert.match(ADMIN_HTML, /data-act="pick-pane"/)
  assert.match(ADMIN_HTML, /aria-current/)
  assert.ok(!/settings:/.test(ADMIN_HTML), '设置区的折叠键已经删干净')
})


test('OWNER admin status excludes misclassified MEMBER rows sharing a lesson title', async () => {
  const { handler, scratchRoot } = fixture()
  const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  try {
    const memberId = '11111111-2222-4333-8444-555555555555'
    store.discoverReplays([{
      replay_key: 'replay-foreign-old', course_key: 'course-legacy-jvm',
      course_name: '刑法分论', title: '第10-12节', resource_class: 'owner'
    }], { ownerId: memberId, resourceClass: 'owner' })
    store.discoverReplays([{
      replay_key: 'replay-foreign-member', course_key: 'course-member',
      course_name: '刑法分论', title: '第10-12节'
    }], { ownerId: memberId, resourceClass: 'member' })
    assert.equal(store.listTasks({ limit: 60 }).length, 3, '生产共享账本确实存在三行同名课次')
  } finally { store.close() }
  const { res, body } = await call(handler, { url: '/api/admin/status' })
  assert.equal(res.state.status, 200)
  assert.deepEqual(body.ledger.tasks.map(task => task.replayKey), ['replay-1'],
    'OWNER 管理台不可展示其他账户或错标为 owner 的历史任务')
  assert.deepEqual(body.ledger.stages, [{ stage: 'discovered', n: 1 }],
    '课程计数也不能把共享账本中的成员行计入')
  assert.equal(body.ledger.tasks.length, 1)
})

test('OWNER admin run rejects retry and refresh-note for foreign or misclassified tasks', async () => {
  const { handler, scratchRoot } = fixture()
  const memberId = '11111111-2222-4333-8444-555555555555'
  const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  const legacyKey = memberId + '::replay-misclassified'
  const memberKey = memberId + '::replay-member'
  try {
    store.discoverReplays([{ replay_key: 'replay-misclassified', course_key: 'course-old',
      course_name: '刑法分论', title: '第10-12节' }], { ownerId: memberId, resourceClass: 'owner' })
    store.discoverReplays([{ replay_key: 'replay-member', course_key: 'course-current',
      course_name: '刑法分论', title: '第10-12节' }], { ownerId: memberId, resourceClass: 'member' })
  } finally { store.close() }
  for (const replayKey of [legacyKey, memberKey, 'replay-not-exists']) {
    for (const action of ['retry', 'refresh-note']) {
      const result = await call(handler, { method: 'POST', url: '/api/admin/run',
        body: JSON.stringify({ action, replayKey }) })
      assert.equal(result.res.state.status, 404, action + ' cannot queue ' + replayKey)
      assert.equal(result.body.error, 'task_not_found')
    }
  }
  const owner = await call(handler, { method: 'POST', url: '/api/admin/run',
    body: JSON.stringify({ action: 'retry', replayKey: 'replay-1' }) })
  assert.equal(owner.res.state.status, 202, 'valid OWNER retry must still be accepted')
  const unchanged = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  try {
    for (const key of [legacyKey, memberKey]) {
      assert.equal(unchanged.getTask(key).attempts, 0, 'foreign task must not be claimed')
      assert.equal(unchanged.getTask(key).stage, 'discovered', 'foreign stage must not change')
    }
  } finally { unchanged.close() }
})

test('dashboard renders status before slow optional requests and coalesces overlapping loads', async () => {
  // Extract the exact inline browser loader to exercise async ordering without a browser.
  const start = ADMIN_HTML.indexOf('var loadInFlight = null')
  const end = ADMIN_HTML.indexOf('function isDirty () {', start)
  assert.ok(start > 0 && end > start, 'dashboard loader should be present in the served HTML')
  const source = ADMIN_HTML.slice(start, end)
  const requests = []
  const release = {}
  const state = { status: null, content: null, config: null, account: null,
    tab: 'overview', balance: {}, contentDraft: {}, configDraft: {} }
  const counts = { render: 0, content: 0, settings: 0, runState: 0 }
  const fetch = async url => {
    requests.push(url)
    if (url === '/api/admin/status') return { ok: true, json: async () => ({ ok: true, ledger: { tasks: [] } }) }
    return new Promise(resolve => { release[url] = resolve })
  }
  const load = Function('fetch', 'state', 'render', 'renderRunState', 'renderContent',
    'renderSettings', 'isDirty', 'refreshBalance', 'headers', 'card', 'esc',
    '$', 'setRunState', 'window', source + '\nreturn load')(
    fetch, state, () => { counts.render++ }, () => { counts.runState++ },
    () => { counts.content++ }, () => { counts.settings++ }, () => false,
    () => {}, () => ({}), value => value, String, () => ({}),
    () => {}, { location: { assign() {} } }
  )
  const first = load()
  const second = load({ quiet: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(counts.render, 1, 'status should populate the dashboard before slower requests finish')
  assert.equal(state.status.ok, true)
  assert.equal(requests.filter(url => url === '/api/admin/status').length, 1, 'interval refresh must not overlap')
  assert.equal(requests.includes('/api/admin/content'), true)
  assert.equal(requests.includes('/api/admin/config'), true)
  assert.equal(requests.includes('/api/account/status'), true)
  assert.deepEqual(await Promise.all([first, second]), [true, true],
    'slow optional requests must not hold the core status load open')
  await load({ quiet: true })
  assert.equal(requests.filter(url => url === '/api/admin/status').length, 2,
    'polling must continue while optional requests are still pending')
  assert.equal(requests.filter(url => url === '/api/admin/content').length, 1,
    'pending content requests must be deduplicated')
  state.tab = 'content'
  release['/api/admin/content']({ ok: true, json: async () => ({ ok: true, topics: { items: [] } }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(counts.content, 1, 'late content should update only its active panel')
  assert.equal(counts.render, 2, 'late optional data must not redraw the whole dashboard')
  release['/api/admin/config']({ ok: true, json: async () => ({ editable: {}, values: {} }) })
  release['/api/account/status']({ ok: true, json: async () => ({ ok: true }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.account.ok, true)
  assert.ok(state.config)
})

test('auxiliary render exception does not strand loader or stop future content refresh', async () => {
  const start = ADMIN_HTML.indexOf('var loadInFlight = null')
  const end = ADMIN_HTML.indexOf('function isDirty () {', start)
  assert.ok(start > 0 && end > start)
  const source = ADMIN_HTML.slice(start, end)
  const warnings = []
  let contentRequests = 0
  let contentRenderAttempts = 0
  const state = { status: { ok: true }, content: null, config: null, account: null,
    tab: 'content', balance: {}, contentDraft: {}, configDraft: {} }
  const fetch = async url => {
    if (url === '/api/admin/content') {
      contentRequests++
      return { ok: true, json: async () => ({ ok: true, topics: { items: [] } }) }
    }
    if (url === '/api/admin/status') return { ok: true, json: async () => ({ ok: true }) }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const load = Function('fetch', 'state', 'render', 'renderRunState', 'renderContent',
    'renderSettings', 'isDirty', 'refreshBalance', 'headers', 'card', 'esc',
    '$', 'setRunState', 'window', 'console', source + '\nreturn load')(
    fetch, state, () => {}, () => {},
    () => {
      contentRenderAttempts++
      if (contentRenderAttempts === 1) throw new Error('injected panel render failure')
    },
    () => {}, () => false, () => {}, () => ({}), value => value,
    String, () => ({}), () => {}, { location: { assign() {} } },
    { warn: (...args) => warnings.push(args) }
  )
  assert.equal(await load(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(contentRequests, 1)
  assert.equal(contentRenderAttempts, 1)
  assert.equal(warnings.length, 1, 'render error must be handled instead of leaving a rejected promise')
  assert.match(String(warnings[0][1]?.message), /injected panel render failure/)
  assert.equal(await load(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(contentRequests, 2, 'after rejection the next refresh should issue another content request')
  assert.equal(contentRenderAttempts, 2, 'the recovered panel should render successfully')
  assert.equal(warnings.length, 1)
})
