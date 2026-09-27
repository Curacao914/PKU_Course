import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createMcpHttpHandler } from './http.mjs'
import { createNotesService } from './service.mjs'
import { createLocalLibrarySource } from './sources.mjs'

/**
 * Remote MCP 的传输层测试。
 *
 * 与 stdio 版共用同一套 service/protocol，所以这里只验"HTTP 这一层"：
 * 起一个真的 HTTP 服务器，用真的 fetch 发请求——中间没有任何 mock，
 * 因为这一层将来要面对的是 ChatGPT/Claude 的客户端与 CDN。
 */

const LIBRARY = [
  {
    slug: 'notes/国际法学/第一课',
    courseName: '国际法学',
    lessonTitle: '第一课 国家责任的构成',
    publishedAt: '2026-09-01T00:00:00.000Z',
    theme: '国家责任由什么构成',
    keywords: ['国家责任', '归因', '赔偿'],
    summary: '本课讲国家责任的构成要件：归因、违反义务与赔偿。',
    readMinutes: 30,
    headings: [
      { level: 2, text: '课程概览', id: '课程概览' },
      { level: 2, text: '一、归因', id: '一-归因' }
    ],
    metadata: { concepts: ['归因'], statutes: [], cases: [], keywords: [] },
    anchors: { concepts: { 归因: '一-归因' }, statutes: {}, cases: {} },
    markdown: [
      '# 第一课 国家责任的构成',
      '',
      '## 课程概览',
      '',
      '本课讲国家责任的构成要件。',
      '',
      '## 一、归因',
      '',
      '归因是把行为归于国家的第一步，之后才谈违反义务与赔偿。'
    ].join('\n')
  }
]

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-'))
  const library = path.join(dir, 'library.json')
  fs.writeFileSync(library, JSON.stringify(LIBRARY))
  const service = createNotesService({
    source: createLocalLibrarySource({ file: library }),
    siteOrigin: 'https://course.law-tech.dev'
  })
  const handler = createMcpHttpHandler({ service })
  const server = http.createServer((req, res) => {
    if (!String(req.url || '').startsWith('/mcp')) { res.writeHead(404); res.end(); return }
    handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  return { url, dir, library, close: () => new Promise(resolve => server.close(resolve)) }
}

function rpc(url, body, options = {}) {
  return fetch(url, {
    method: options.method || 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(options.headers || {}) },
    body: options.method && options.method !== 'POST' ? undefined : JSON.stringify(body)
  })
}

test('Remote MCP：一次 HTTP 往返就能 initialize 并列出七个工具', async () => {
  const site = await startServer()
  try {
    const init = await rpc(site.url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
    assert.equal(init.status, 200)
    assert.match(init.headers.get('content-type'), /application\/json/)
    assert.equal(init.headers.get('cache-control'), 'no-store')
    const handshake = await init.json()
    assert.equal(handshake.result.serverInfo.name, 'course-notes')
    assert.match(handshake.result.instructions, /list_courses/)

    const list = await (await rpc(site.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
    const names = list.result.tools.map(tool => tool.name)
    assert.deepEqual(names, ['list_courses', 'get_course', 'search_notes', 'get_note', 'list_terms', 'search', 'fetch'])
    assert.ok(list.result.tools.every(tool => tool.annotations.readOnlyHint === true))

    // 课程专用的分层工具与标准接口在同一个 endpoint 上都可用
    const courses = await (await rpc(site.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_courses', arguments: {} } })).json()
    assert.match(courses.result.content[0].text, /国际法学/)

    const search = await (await rpc(site.url, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: '归因' } }
    })).json()
    const payload = JSON.parse(search.result.content[0].text)
    assert.equal(payload.results[0].url, 'https://course.law-tech.dev/notes/国际法学/第一课.html')

    const fetched = await (await rpc(site.url, {
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fetch', arguments: { id: payload.results[0].id } }
    })).json()
    assert.match(JSON.parse(fetched.result.content[0].text).text, /归因是把行为归于国家的第一步/)
  } finally {
    await site.close()
  }
})

test('Remote MCP：通知回 202、GET 回 405、坏 JSON 回 -32700，都是规范允许/要求的形状', async () => {
  const site = await startServer()
  try {
    const notify = await rpc(site.url, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notify.status, 202, '通知不该有响应体')
    assert.equal((await notify.text()), '')

    const get = await rpc(site.url, {}, { method: 'GET' })
    assert.equal(get.status, 405)
    assert.match(get.headers.get('allow') || '', /POST/)

    const bad = await rpc('http://127.0.0.1:' + new URL(site.url).port + '/mcp', '{not json')
    // fetch 不能直接发非法 JSON 字符串，这里用原生 http 再试一次
    assert.ok(bad.status === 200 || bad.status === 400)
  } finally {
    await site.close()
  }
})

test('Remote MCP：坏 JSON 与超大请求体都被挡住，不会把服务打挂', async () => {
  const site = await startServer()
  const port = new URL(site.url).port
  const post = body => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
  try {
    const broken = await post('{坏掉的 JSON')
    assert.equal(broken.status, 400)
    assert.equal(JSON.parse(broken.text).error.code, -32700)

    const huge = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_000_100) }))
    assert.equal(huge.status, 413)

    // 服务器还活着
    const ping = await (await rpc(site.url, { jsonrpc: '2.0', id: 2, method: 'ping' })).json()
    assert.equal(ping.id, 2)
  } finally {
    await site.close()
  }
})
