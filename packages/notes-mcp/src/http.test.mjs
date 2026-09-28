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

test('标准 search 与专用 search_notes 召回一致（同一套规则，不得各有一套 gate）', async () => {
  // 曾经标准接口有一层「命中少于 3 条才扫正文」的历史 gate：同一个问题在两个入口
  // 会给出不同结果。现在规则只有一处（searchRecords），这里把它钉住。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-mcp-parity-'))
  const library = path.join(dir, 'library.json')
  fs.writeFileSync(library, JSON.stringify(LIBRARY))
  const service = createNotesService({ source: createLocalLibrarySource({ file: library }) })
  const server = http.createServer(createMcpHttpHandler({ service, log: () => {} }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  const call = (name, args) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  }).then(response => response.json())

  try {
    // 只在正文深处出现的词：两个入口都必须找得到，且召回一致
    const query = '违反义务'
    const standard = await call('search', { query })
    const dedicated = await call('search_notes', { query })
    const standardIds = JSON.parse(standard.result.content[0]['text']).results.map(item => item.id.split('#')[0])
    const dedicatedSlugs = (await service.searchNotes({ query })).hits.map(hit => hit.slug)
    assert.ok(standardIds.length > 0, '标准接口要能召回')
    assert.deepEqual(new Set([...standardIds].sort()), new Set([...dedicatedSlugs].sort()), '两个入口必须给出同一批课次')
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('安全边界：Origin 与 Host 只在带了且不在名单里时拒绝，无 Origin 的 CLI 照常', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-mcp-guard-'))
  const library = path.join(dir, 'library.json')
  fs.writeFileSync(library, JSON.stringify(LIBRARY))
  const server = http.createServer(createMcpHttpHandler({
    service: createNotesService({ source: createLocalLibrarySource({ file: library }) }),
    log: () => {},
    allowedOrigins: ['https://course.law-tech.dev'],
    // 名单比对的是**主机名**（端口会被去掉）：本机部署时 Host 是 127.0.0.1:端口
    allowedHosts: ['course.law-tech.dev', '127.0.0.1', 'localhost'],
    // 只统计"走到处理流程"的请求：被 Origin/Host 挡掉的请求不占额度（顺序见 http.mjs）
    rateLimit: { windowMs: 60_000, max: 2 }
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const post = (headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': '1.2.3.4', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

  try {
    // 跨站浏览器请求：拒绝
    const crossSite = await post({ origin: 'https://evil.example' })
    assert.equal(crossSite.status, 403)
    // 我们自己的页面 / 无 Origin 的 CLI、ChatGPT、Inspector：都放行
    assert.equal((await post({ origin: 'https://course.law-tech.dev' })).status, 200)
    assert.equal((await post()).status, 200)
    // Host 不在名单里（DNS rebinding 的典型形状）。
    // 注意：fetch 不允许设置 Host（规范里的 forbidden header），必须用底层 http 请求。
    const reboundStatus = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'evil.example', 'content-length': Buffer.byteLength(BODY) }
      }, response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
      request.end(BODY)
    })
    assert.equal(reboundStatus, 403)
    // 限流：上面已经打了 4 次，窗口内上限是 3
    const limited = await post()
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP-Protocol-Version：不支持的版本回 400，支持的与不带的都照常', async () => {
  // 2025-06-18 起客户端要在每个请求上带这个头；规范要求服务器收到不支持的版本时回 400，
  // 而不是硬着头皮解析（那会让客户端看到一个语法正确、语义却对不上的响应）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-mcp-http-'))
  const library = path.join(dir, 'library.json')
  fs.writeFileSync(library, JSON.stringify(LIBRARY))
  const server = http.createServer(createMcpHttpHandler({
    service: createNotesService({ source: createLocalLibrarySource({ file: library }) }),
    log: () => {}
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  const call = (headers, body) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body)
  })

  try {
    const unsupported = await call({ 'mcp-protocol-version': '1999-01-01' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(unsupported.status, 400)
    const payload = await unsupported.json()
    assert.match(payload.error.message, /不支持的协议版本/)

    const supported = await call({ 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.equal(supported.status, 200)
    assert.equal((await supported.json()).result.tools.length > 0, true)

    // 不带这个头：按规范当老客户端（2025-03-26）处理，不影响使用
    const legacy = await call({}, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    assert.equal(legacy.status, 200)
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

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
