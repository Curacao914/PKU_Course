import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createRequestBudget } from './budget.mjs'
import { createMcpHttpHandler } from './http.mjs'
import { normalizeRecord } from './records.mjs'
import { createNotesService } from './service.mjs'

/**
 * MCP HTTP 传输层的"请求预算"测试：异常断开、超时、并发闸门、限流与长度。
 *
 * 这些都是**传输层**的行为，所以：起真的 HTTP 服务器、用真的 fetch（中途 abort 也是真的
 * 断 socket），不 mock。四个形状直接对应线上事故：
 *   1. 客户端中途断开 → 并发名额必须立刻归还（以前只挂 finish，漏满之后所有人 503）；
 *   2. 断开/超时 → 后台检索必须真的被 abort（只减计数不取消 = CPU 白烧）；
 *   3. 归一归还幂等（finish 与 close 都会触发）；
 *   4. 限流不认来路不明的 X-Forwarded-For。
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
    headings: [{ level: 2, text: '一、归因', id: '一-归因' }],
    metadata: { concepts: ['归因'], statutes: [], cases: [], keywords: [] },
    anchors: { concepts: { 归因: '一-归因' }, statutes: {}, cases: {} },
    markdown: ['# 第一课', '', '## 一、归因', '', '归因是把行为归于国家的第一步，之后才谈违反义务与赔偿。'].join('\n')
  }
]

const records = LIBRARY.map(normalizeRecord)

/**
 * 测试用数据源：可以变慢、可以失败，并把"取消信号有没有被 abort"记下来。
 * 记录用 onAbort 观察的是**每个请求各自的 signal**，不是全局标志。
 */
function fakeSource({ delayMs = 0, fail = false, log = () => {} } = {}) {
  // delayMs 放在 state 上：测试可以在中途把它改成 0，用来证明"恢复"的是预算而不是依赖
  const state = { listCalls: 0, aborted: 0, completed: 0, delayMs }
  const source = {
    kind: 'test',
    describe: () => ({ kind: 'test', label: '测试数据源', location: 'memory' }),
    listNotes: async ({ signal } = {}) => {
      state.listCalls += 1
      log('listNotes:' + state.listCalls)
      if (signal) {
        if (signal.aborted) state.aborted += 1
        else signal.addEventListener('abort', () => { state.aborted += 1; log('aborted') })
      }
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs))
      if (fail) throw new Error('数据源爆炸了')
      state.completed += 1
      return records
    },
    readMarkdown: async slug => records.find(record => record.slug === slug)?.markdown || ''
  }
  return { source, state }
}

async function startServer({ service, budget, options = {} }) {
  const handler = createMcpHttpHandler({ service, budget, log: () => {}, ...options })
  const server = http.createServer((req, res) => {
    if (!String(req.url || '').startsWith('/mcp')) { res.writeHead(404); res.end(); return }
    handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

const call = (url, name, args, options = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', ...(options.headers || {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method: 'tools/call', params: { name, arguments: args } }),
  ...(options.signal ? { signal: options.signal } : {})
})

const list = url => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
})

/** 轮询等待条件成立（避免用固定 sleep 写出随机失败的测试）。 */
async function waitFor(predicate, { timeoutMs = 2_000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${label}`)
}

test('客户端中途断开：并发名额立刻归还，后台检索真的被 abort', async () => {
  const budget = createRequestBudget({ maxConcurrent: 1, timeoutMs: 0 })
  // 断开必须发生在后台还在跑的时候：把慢数据源的延迟放大，别让调度抖动吃掉整个窗口
  const { source, state } = fakeSource({ delayMs: 1_000 })
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  try {
    const controller = new AbortController()
    const pending = call(site.url, 'search_notes', { query: '归因' }, { signal: controller.signal }).catch(error => error)
    // 等后台**真的开始**再断开：这样测的是"处理过程中断开"，不是"还没开始就断开"
    await waitFor(() => state.listCalls === 1, { label: '检索开始' })
    assert.equal(budget.stats().inFlight, 1, '处理中应当占着一个并发名额')

    controller.abort()
    await pending

    await waitFor(() => budget.stats().inFlight === 0, { label: '槽位归还' })
    await waitFor(() => state.aborted === 1, { label: '后台收到 abort' })
    assert.equal(budget.stats().clientGone, 1)
    assert.equal(budget.stats().released, 1)

    // 恢复：不需要重启，下一个请求照常（同一个（慢）数据源，但额度是干净的）
    const after = await list(site.url)
    assert.equal(after.status, 200)
    await waitFor(() => budget.stats().inFlight === 0, { label: '第二次归还' })
  } finally {
    await site.close()
  }
})

test('超出时间预算：回 504 + -32001，中止后台检索，槽位归还后照常服务', async () => {
  const budget = createRequestBudget({ maxConcurrent: 2, timeoutMs: 200 })
  const { source, state } = fakeSource({ delayMs: 1_500 })
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  try {
    const started = Date.now()
    const response = await call(site.url, 'search_notes', { query: '归因' })
    assert.equal(response.status, 504)
    assert.equal(response.headers.get('retry-after'), '1')
    const payload = await response.json()
    assert.equal(payload.error.code, -32001)
    assert.match(payload.error.message, /检索超时/)
    // 超时预算的意义就是"到点就回"，而不是等后台把 400ms 跑完
    assert.ok(Date.now() - started < 1_200, '不该等到后台工作自己跑完')

    await waitFor(() => state.aborted === 1, { label: '后台收到 abort' })
    await waitFor(() => budget.stats().inFlight === 0, { label: '槽位归还' })
    assert.equal(budget.stats().timedOut, 1)
    assert.equal(budget.stats().released, 1)

    // 超时不是"坏了"：数据源恢复正常后，下一个请求照样拿到结果（预算不会一直卡着）
    state.delayMs = 0
    const after = await call(site.url, 'search_notes', { query: '归因' })
    assert.equal(after.status, 200)
    await waitFor(() => budget.stats().inFlight === 0, { label: '第二个请求归还' })
    assert.equal(budget.stats().acquired, 2)
    assert.equal(budget.stats().released, 2)
  } finally {
    await site.close()
  }
})

test('并发闸门：满员回 503（带 retry-after），腾出来之后立刻能用', async () => {
  const budget = createRequestBudget({ maxConcurrent: 1, max: 0, timeoutMs: 0 })
  const { source } = fakeSource({ delayMs: 800 })
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  try {
    // 用慢检索占住唯一的槽位（tools/list 太快，来不及观察到"处理中"）
    const first = call(site.url, 'search_notes', { query: '归因' })
    await waitFor(() => budget.stats().inFlight === 1, { label: '占住槽位' })

    const second = await list(site.url)
    assert.equal(second.status, 503)
    assert.equal(second.headers.get('retry-after'), '1')
    const payload = await second.json()
    assert.equal(payload.error.code, -32000)
    assert.match(payload.error.message, /同时处理的请求过多/)
    assert.equal(budget.stats().busy, 1)

    assert.equal((await first).status, 200)
    await waitFor(() => budget.stats().inFlight === 0, { label: '第一个归还' })
    // 被挡过的客户端马上重试就能成功（这就是 retry-after 的语义）
    assert.equal((await list(site.url)).status, 200)
  } finally {
    await site.close()
  }
})

test('归还幂等：finish 与 close 都会触发，账也只减一次', async () => {
  const budget = createRequestBudget({ maxConcurrent: 4, timeoutMs: 0 })
  const { source } = fakeSource()
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  try {
    for (let index = 0; index < 4; index += 1) {
      const response = await list(site.url)
      assert.equal(response.status, 200)
      await response.json()
      await waitFor(() => budget.stats().inFlight === 0, { label: '归还' })
    }
    // close 在正常请求结束后也会触发一次：如果归还不是幂等的，这里会是 8
    assert.equal(budget.stats().acquired, 4)
    assert.equal(budget.stats().released, 4)
  } finally {
    await site.close()
  }
})

test('请求体读到一半就断开：不误报 413，槽位照样归还', async () => {
  const budget = createRequestBudget({ maxConcurrent: 1, timeoutMs: 0 })
  const { source } = fakeSource()
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  const port = new URL(site.url).port
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const status = await new Promise(resolve => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, response => resolve(response.statusCode))
      request.on('error', () => resolve(0))
      // 只写一半就断开：服务端拿到的是 aborted/close，而不是一条完整消息。
      // 以前这条路径会被当成"请求体超限"回 413（把两种事故混成了一种）。
      request.write(body.slice(0, 10))
      setTimeout(() => { request.destroy(); resolve(0) }, 30)
    })
    assert.equal(status, 0, '客户端自己断开，不该收到 413')

    await waitFor(() => budget.stats().inFlight === 0, { label: '断开后归还' })
    assert.equal(budget.stats().acquired, 1)
    assert.equal(budget.stats().released, 1)
    // 名额没被这次断开占住：下一个请求照常（maxConcurrent 只有 1）
    assert.equal((await list(site.url)).status, 200)
  } finally {
    await site.close()
  }
})

test('错误路径同样不漏槽位：坏 JSON、超限请求体、未知工具、内部错误', async () => {
  const budget = createRequestBudget({ maxConcurrent: 3, timeoutMs: 0 })
  const { source } = fakeSource({ fail: true })
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  const port = new URL(site.url).port
  const raw = body => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    request.on('error', reject)
    request.end(body)
  })
  try {
    assert.equal((await raw('{坏 JSON')).status, 400)
    assert.equal((await raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_000_100) }))).status, 413)

    const unknown = await call(site.url, '不存在的工具', {})
    assert.equal((await unknown.json()).error.code, -32602)
    // 数据源抛错 → -32603（内部错误），也是一条出口
    const broken = await call(site.url, 'search_notes', { query: '归因' })
    assert.equal((await broken.json()).error.code, -32603)

    await waitFor(() => budget.stats().inFlight === 0, { label: '全部归还' })
    assert.equal(budget.stats().acquired, budget.stats().released, '每一次取用都必须有一次归还')
    // 服务仍然可用
    assert.equal((await list(site.url)).status, 200)
  } finally {
    await site.close()
  }
})

test('限流不认来路不明的 XFF：直连方不可信时换头也换不掉身份', async () => {
  const budget = createRequestBudget({ max: 2, windowMs: 60_000, maxConcurrent: 4 })
  const { source } = fakeSource()
  const site = await startServer({ service: createNotesService({ source }), budget })
  try {
    const post = value => list(site.url).then(async response => response.status)
    // 每次换一个 XFF：直连方（127.0.0.1）不在可信名单里，所以三个请求是同一个桶
    assert.equal(await fetch(site.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }).then(response => response.status), 200)
    assert.equal(await fetch(site.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '2.2.2.2' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }).then(response => response.status), 200)
    assert.equal(await post(), 429, '伪造的头不该换来新的额度')
    assert.equal(budget.stats().rateLimited, 1)
  } finally {
    await site.close()
  }
})

test('可信代理下按最右不可信跳记账：不同客户端各自有额度，伪造前缀无效', async () => {
  // nginx 在本机：直连方 127.0.0.1 可信，它把真实客户端追加到 XFF 末尾
  const budget = createRequestBudget({ max: 2, windowMs: 60_000, maxConcurrent: 8, trustedProxies: ['127.0.0.1'] })
  const { source } = fakeSource()
  const site = await startServer({ service: createNotesService({ source }), budget })
  const post = value => fetch(site.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(value ? { 'x-forwarded-for': value } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  }).then(response => response.status)
  try {
    assert.equal(await post('203.0.113.9'), 200)
    assert.equal(await post('203.0.113.9'), 200)
    assert.equal(await post('203.0.113.9'), 429, '同一个客户端第三次要被挡住')
    // 另一个客户端有自己的额度
    assert.equal(await post('198.51.100.7'), 200)
    // 客户端在自己那段塞假地址（nginx 追加在后面）：仍然算 203.0.113.9，额度已经用完
    assert.equal(await post('1.1.1.1, 203.0.113.9'), 429)
    assert.equal(budget.stats().rateLimited, 2)
  } finally {
    await site.close()
  }
})

test('查询长度预算：超长查询在解析前被挡住，模型能据此改小重试', async () => {
  const budget = createRequestBudget({ maxQueryChars: 20, maxConcurrent: 4 })
  const { source, state } = fakeSource()
  const service = createNotesService({ source })
  const site = await startServer({ service, budget })
  try {
    const tooLong = await call(site.url, 'search_notes', { query: '法'.repeat(21) })
    const payload = await tooLong.json()
    assert.equal(payload.result.isError, true)
    assert.match(payload.result.content[0].text, /参数不合法：查询过长：21 字，上限 20 字/)
    // 关键：根本没进检索（超长查询会炸出成千上万个 n-gram，那才是成本）
    assert.equal(state.listCalls, 0)

    const ok = await call(site.url, 'search_notes', { query: '法'.repeat(20) })
    const fine = await ok.json()
    assert.equal(fine.result.isError, false)
    assert.equal(state.listCalls, 1)
  } finally {
    await site.close()
  }
})
