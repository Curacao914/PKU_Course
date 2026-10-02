import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ToolError } from './errors.mjs'
import { createFixtureService, LIBRARY_PATH, readLibrary, startFakeSite } from './fixtures/fixture.mjs'
import { createLocalLibrarySource, createRemoteSiteSource, createSource, markdownPathOf, normalizeOrigin } from './sources.mjs'

function tempLibrary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-mcp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'library.json')
  fs.copyFileSync(LIBRARY_PATH, file)
  return file
}

test('本地发布库：读记录、读正文、来源可描述', async () => {
  const source = createLocalLibrarySource({ file: LIBRARY_PATH })
  const records = await source.listNotes()
  assert.equal(records.length, 6)
  assert.equal(source.describe().kind, 'local')
  const first = records.find(record => record.slug === 'notes/国际法学/第一课-国家责任的构成')
  assert.match(first.markdown, /有效控制/)
  assert.equal(await source.readMarkdown(first.slug), first.markdown)
  await assert.rejects(() => source.readMarkdown('notes/不存在/第一课'), ToolError)
})

test('本地发布库：revision 绑定原始 library 字节，并随原子发布后的新文件即时变化', async t => {
  const file = tempLibrary(t)
  const source = createLocalLibrarySource({ file })
  await source.listNotes()
  const first = source.revision()
  assert.match(first, /^[0-9a-f]{64}$/)

  const records = readLibrary()
  records.push({ ...records[0], slug: 'notes/国际法学/revision-测试', lessonTitle: 'revision 测试' })
  fs.writeFileSync(file, JSON.stringify(records, null, 2))
  await source.listNotes()
  const second = source.revision()
  assert.notEqual(second, first, 'library 文件内容变化后 revision 必须同步变化，不需要重启进程')
})

test('本地发布库：按 mtime/size 变化即时重读，不是进程启动时读死', async t => {
  const file = tempLibrary(t)
  const source = createLocalLibrarySource({ file })
  assert.equal((await source.listNotes()).length, 6)

  const records = readLibrary()
  records.push({ ...records[0], slug: 'notes/国际法学/新增-测试课次', lessonTitle: '新增 测试课次' })
  fs.writeFileSync(file, JSON.stringify(records, null, 2))
  assert.equal((await source.listNotes()).length, 7)
  assert.equal((await source.listNotes()).find(record => record.slug === 'notes/国际法学/新增-测试课次').lessonTitle, '新增 测试课次')
})

test('本地发布库：文件缺失/坏 JSON/结构不对都给可操作的报错', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-mcp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const missing = createLocalLibrarySource({ file: path.join(dir, 'nope.json') })
  await assert.rejects(() => missing.listNotes(), error => {
    assert.ok(error instanceof ToolError)
    assert.match(error.message, /COURSE_LIBRARY/)
    return true
  })

  const broken = path.join(dir, 'broken.json')
  fs.writeFileSync(broken, '{ not json')
  await assert.rejects(() => createLocalLibrarySource({ file: broken }).listNotes(), /不是合法 JSON/)

  const notArray = path.join(dir, 'object.json')
  fs.writeFileSync(notArray, '{"a":1}')
  await assert.rejects(() => createLocalLibrarySource({ file: notArray }).listNotes(), /记录数组/)
})

test('远程站点：索引不含正文，正文按 /md/<课程>/<课次>.md 取', async t => {
  const site = await startFakeSite()
  t.after(() => site.close())
  const source = createRemoteSiteSource({ origin: site.origin, ttlMs: 0 })
  const records = await source.listNotes()
  assert.equal(records.length, 6)
  assert.equal('markdown' in records[0], false)
  assert.equal(records[0].courseName, '国际法学')
  const markdown = await source.readMarkdown('notes/国际法学/第一课-国家责任的构成')
  assert.match(markdown, /^# 国际法学/)
  assert.ok(site.requests.includes('/api/notes'))
  // 与 publish 写出的文件同一条路径（markdown-path.mjs）：带课程，不是只有课次那一段
  assert.equal(decodeURIComponent(markdownPathOf('notes/国际法学/第一课-国家责任的构成')),
    '/md/国际法学/第一课-国家责任的构成.md')
  assert.ok(site.requests.includes(markdownPathOf('notes/国际法学/第一课-国家责任的构成')),
    '请求的正是这条路径：' + site.requests.join(', '))
})

test('远程站点：TTL 内复用缓存，ttl=0 时每次都重新取', async t => {
  const site = await startFakeSite()
  t.after(() => site.close())

  const cached = createRemoteSiteSource({ origin: site.origin, ttlMs: 60_000 })
  await cached.listNotes()
  await cached.listNotes()
  await cached.readMarkdown('notes/刑法总论/第一课-罪刑法定')
  await cached.readMarkdown('notes/刑法总论/第一课-罪刑法定')
  assert.equal(site.requests.filter(url => url === '/api/notes').length, 1)
  assert.equal(site.requests.filter(url => url.startsWith('/md/')).length, 1)

  const fresh = createRemoteSiteSource({ origin: site.origin, ttlMs: 0 })
  await fresh.listNotes()
  await fresh.listNotes()
  assert.equal(site.requests.filter(url => url === '/api/notes').length, 3)
})

test('远程站点：404 与网络失败都指向可操作的出路', async t => {
  const site = await startFakeSite()
  t.after(() => site.close())
  const source = createRemoteSiteSource({ origin: site.origin, ttlMs: 0 })
  await assert.rejects(() => source.readMarkdown('notes/不存在/第一课'), /返回 404/)

  const dead = createRemoteSiteSource({ origin: 'http://127.0.0.1:1', ttlMs: 0 })
  await assert.rejects(() => dead.listNotes(), error => {
    assert.match(error.message, /COURSE_LIBRARY/)
    return true
  })
})

test('createSource：本地优先；没配本地才走远程（默认站点）', () => {
  assert.equal(createSource({ library: LIBRARY_PATH }).kind, 'local')
  assert.equal(createSource({}).kind, 'remote')
  assert.equal(createSource({ origin: 'https://example.com/' }).describe().location, 'https://example.com')
  assert.equal(normalizeOrigin(''), 'https://course.law-tech.dev')
  assert.equal(createFixtureService().describe().kind, 'local')
})
