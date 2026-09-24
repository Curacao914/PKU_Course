import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildNoteRecord, writeSite } from '@course/publish'

import { createRequestHandler, resolveInsideRoot, startSiteServer } from './server.mjs'

const NOTE = ['# 第10-12节', '', '## 课程概览', '', '共犯的成立需要共同故意与共同行为。'].join('\n')

function siteDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  writeSite({
    records: [buildNoteRecord({
      courseName: '刑法分论',
      teacher: '车浩',
      lessonTitle: '第10-12节',
      markdown: NOTE,
      publishedAt: '2026-09-25T00:00:00.000Z'
    })],
    outputDir: dir,
    siteOrigin: 'https://course.law-tech.dev'
  })
  return dir
}

test('resolveInsideRoot refuses paths that escape the site root', () => {
  const root = '/srv/course/site'
  assert.equal(resolveInsideRoot(root, '/notes/a.html'), '/srv/course/site/notes/a.html')
  assert.equal(resolveInsideRoot(root, '/'), root)
  assert.equal(resolveInsideRoot(root, '/../../etc/passwd'), null)
  assert.equal(resolveInsideRoot(root, '/notes/../../secret'), null)
  assert.equal(resolveInsideRoot(root, '/%2e%2e/%2e%2e/etc/passwd'), null, '编码后的穿越同样要挡')
})

test('the site server serves the index, note pages and the notes api', async () => {
  const root = siteDir()
  const site = await startSiteServer({ root, port: 0 })
  try {
    const health = await fetch(`${site.url}/healthz`)
    assert.equal(health.status, 200)
    const healthBody = await health.json()
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.notes, 1)

    const index = await fetch(`${site.url}/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type'), /text\/html/)
    assert.match(await index.text(), /课程笔记/)

    const note = await fetch(`${site.url}/notes/刑法分论/第10-12节.html`)
    assert.equal(note.status, 200)
    assert.match(await note.text(), /共犯的成立需要共同故意与共同行为/)

    // 不带扩展名的干净链接同样可用
    const clean = await fetch(`${site.url}/notes/刑法分论/第10-12节`)
    assert.equal(clean.status, 200)

    const api = await fetch(`${site.url}/api/notes`)
    const payload = await api.json()
    assert.equal(payload.count, 1)
    assert.equal(payload.notes[0].slug, 'notes/刑法分论/第10-12节')

    assert.equal((await fetch(`${site.url}/nope`)).status, 404)
    assert.equal((await fetch(`${site.url}/favicon.ico`)).status, 204)
    assert.equal((await fetch(`${site.url}/healthz`, { method: 'POST' })).status, 405)
  } finally {
    await site.close()
  }
})

test('admin endpoints fail closed when no token is configured', async () => {
  const site = await startSiteServer({ root: siteDir(), port: 0 })
  try {
    const response = await fetch(`${site.url}/api/admin/ping`)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'admin_token_unconfigured')
  } finally {
    await site.close()
  }
})

test('admin endpoints require the configured token', async () => {
  const site = await startSiteServer({ root: siteDir(), port: 0, adminToken: 'secret-token' })
  try {
    assert.equal((await fetch(`${site.url}/api/admin/ping`)).status, 401)
    assert.equal((await fetch(`${site.url}/api/admin/ping`, { headers: { 'x-course-token': 'wrong' } })).status, 401)

    // 令牌正确即通过鉴权；/ping 不是真实路由，因此得到的是 404 而不是 401
    const ok = await fetch(`${site.url}/api/admin/ping`, { headers: { authorization: 'Bearer secret-token' } })
    assert.equal(ok.status, 404)
    assert.equal((await ok.json()).error, 'unknown_admin_route')

    const status = await fetch(`${site.url}/api/admin/status`, { headers: { 'x-course-token': 'secret-token' } })
    assert.equal(status.status, 200)
    assert.ok('ledger' in (await status.json()))
  } finally {
    await site.close()
  }
})

test('a broken index is reported as unavailable rather than an empty site', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  fs.writeFileSync(path.join(root, 'notes.json'), '{ broken')
  const site = await startSiteServer({ root, port: 0 })
  try {
    assert.equal((await fetch(`${site.url}/healthz`)).status, 503)
    assert.equal((await fetch(`${site.url}/api/notes`)).status, 503)
  } finally {
    await site.close()
  }
})

test('the request handler is usable directly without a socket', () => {
  const handler = createRequestHandler({ root: siteDir() })
  assert.equal(typeof handler, 'function')
})
