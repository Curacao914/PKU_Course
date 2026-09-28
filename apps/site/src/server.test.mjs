import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildNoteRecord, writeSite } from '@course/publish'

import { createRequestHandler, resolveInsideRoot, startSiteServer } from './server.mjs'

const NOTE = ['# 第10-12节', '', '## 课程概览', '', '共犯的成立需要共同故意与共同行为。'].join('\n')

function siteDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  const record = buildNoteRecord({
    courseName: '刑法分论',
    teacher: '车浩',
    lessonTitle: '第10-12节',
    markdown: NOTE,
    publishedAt: '2026-09-25T00:00:00.000Z'
  })
  writeSite({ records: [record], outputDir: dir, siteOrigin: 'https://course.law-tech.dev' })
  // 发布库：真实部署里由 course publish 写在站点根，站内搜索与旧链接重定向都读它。
  // 只调 writeSite 的话这里就是空的——所以测试夹具要照实写出来。
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify([record], null, 2))
  return dir
}

test('third-party assets are served from outside the site directory', async () => {
  const root = siteDir()
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'course-assets-'))
  fs.writeFileSync(path.join(assets, 'mermaid.min.js'), 'window.mermaid={}\n')
  const site = await startSiteServer({ root, port: 0, assetsDir: assets })
  try {
    const ok = await fetch(`${site.url}/assets/mermaid.min.js`)
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-type'), /javascript/)
    assert.equal(await ok.text(), 'window.mermaid={}\n')

    assert.equal((await fetch(`${site.url}/assets/nope.js`)).status, 404)
    // 穿越防护由 resolveInsideRoot 负责；HTTP 层测不到，因为 WHATWG URL 在任何
    // 请求进来之前就把 %2e%2e 规范化掉了（等于多了一层防线）。
    assert.equal(resolveInsideRoot(assets, '/../notes.json'), null, '不得穿越出资源目录')
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(assets, { recursive: true, force: true })
  }
})

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

test('站内搜索走服务端：与 MCP 同一套检索，结果带小节与片段', async () => {
  const root = siteDir()
  const site = await startSiteServer({ root, port: 0 })
  try {
    // 正文里才有、元数据里没有的词：能搜到才说明真的查了正文
    const body = await fetch(`${site.url}/api/search?q=${encodeURIComponent('共同行为')}`)
    assert.equal(body.status, 200)
    const payload = await body.json()
    assert.equal(payload.ok, true)
    assert.ok(payload.hits.length >= 1, '正文里的词也要能搜到')
    const hit = payload.hits[0]
    assert.equal(hit.slug, 'notes/刑法分论/第10-12节')
    assert.equal(hit.url, '/notes/刑法分论/第10-12节.html')
    assert.ok(hit.snippets.some(snippet => snippet.includes('共同行为')))

    // 多词查询（旧实现整串匹配必然零命中）
    const multi = await (await fetch(`${site.url}/api/search?q=${encodeURIComponent('共同故意 共同行为')}`)).json()
    assert.ok(multi.hits.length >= 1, '多词查询要能命中')

    // 只有疑问词、解析后一个词都不剩 → 明确报错，而不是把整库都当命中
    const empty = await fetch(`${site.url}/api/search?q=${encodeURIComponent('为什么')}`)
    assert.equal(empty.status, 400)
    assert.equal((await empty.json()).error, 'search_failed')

    // 疑问句里只要有实词就照常检索（拆出的是碎片，命不中就是 0 条，不是错误）
    const sentence = await fetch(`${site.url}/api/search?q=${encodeURIComponent('这一节到底讲了什么呢')}`)
    assert.equal(sentence.status, 200)
    assert.equal((await sentence.json()).ok, true)

    assert.equal((await fetch(`${site.url}/api/search`)).status, 400, '缺 q 时明确报 400')
    assert.equal((await fetch(`${site.url}/api/search?q=x`, { method: 'POST' })).status, 405)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('旧的平铺 md 链接 302 到规范路径；库里没有的不猜', async () => {
  // 路径规则改版前是 /md/<课次>.md，收藏与转发里还留着老地址。
  const root = siteDir()
  const site = await startSiteServer({ root, port: 0 })
  try {
    const old = await fetch(`${site.url}/md/第10-12节.md`, { redirect: 'manual' })
    assert.equal(old.status, 302)
    assert.equal(old.headers.get('location'), '/md/%E5%88%91%E6%B3%95%E5%88%86%E8%AE%BA/%E7%AC%AC10-12%E8%8A%82.md')

    const followed = await fetch(`${site.url}/md/第10-12节.md`)
    assert.equal(followed.status, 200)
    assert.match(followed.headers.get('content-type'), /text\/markdown/)

    // 发布库里没有的课次：不猜、不重定向，老实 404
    const unknown = await fetch(`${site.url}/md/不存在的一节.md`, { redirect: 'manual' })
    assert.equal(unknown.status, 404)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('每个响应都带安全头：CSP 只允许本站与内联，框架禁止嵌入', async () => {
  // 站点全站零依赖、阅读脚本是内联的（没有构建步骤），所以 CSP 里的 'unsafe-inline' 是刻意的；
  // 但它仍然挡住"从外部域加载脚本"这条最常见的注入路径。
  const root = siteDir()
  const site = await startSiteServer({ root, port: 0 })
  try {
    for (const path of ['/', '/notes/刑法分论/第10-12节.html', '/md/刑法分论/第10-12节.md']) {
      const response = await fetch(site.url + path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('x-frame-options'), 'DENY')
      assert.match(response.headers.get('referrer-policy'), /strict-origin/)
      assert.match(response.headers.get('strict-transport-security'), /max-age=\d+/)
      const csp = response.headers.get('content-security-policy')
      assert.match(csp, /default-src 'self'/)
      assert.match(csp, /frame-ancestors 'none'/, '不允许被别的站点嵌进 iframe')
      assert.match(csp, /object-src 'none'/)
      assert.ok(!/https?:\/\//.test(csp), '不放开任何外部来源')
    }
    // 接口与站内检索：不进缓存、不进搜索引擎
    const api = await fetch(site.url + '/api/notes')
    assert.equal(api.headers.get('cache-control'), 'no-store')
    assert.equal(api.headers.get('x-robots-tag'), 'noindex')
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('坏路径编码回 400（不是 500），穿越防护仍然拒得住', async () => {
  const root = siteDir()
  const site = await startSiteServer({ root, port: 0 })
  try {
    // 未完成的百分号编码：decodeURIComponent 会抛，绝不能让它逃逸成 500
    const malformed = await fetch(site.url + '/%E5%95', { redirect: 'manual' })
    assert.equal(malformed.status, 400)
    assert.equal(resolveInsideRoot(root, '/%E5%95'), null, '非法编码在解析层也返回 null 而不是抛错')
    const traversal = await fetch(site.url + '/%2e%2e/%2e%2e/etc/passwd')
    assert.ok([403, 404].includes(traversal.status), '穿越不得放行（实际 ' + traversal.status + '）')
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('公开进程上不存在管理台：/api/admin 明确 404，/admin 把人导向管理台域名', async () => {
  // 公开站点与管理台是两个进程：公开进程里根本没有这些路由（不是「有但不让进」）。
  const root = siteDir()
  const site = await startSiteServer({ root, port: 0, admin: false, adminOrigin: 'https://admin.law-tech.dev' })
  try {
    const api = await fetch(site.url + '/api/admin/status')
    assert.equal(api.status, 404)
    assert.equal((await api.json()).error, 'not_found')

    const page = await fetch(site.url + '/admin', { redirect: 'manual' })
    assert.equal(page.status, 302)
    assert.equal(page.headers.get('location'), 'https://admin.law-tech.dev/admin')
    assert.equal(page.headers.get('cache-control'), 'no-store')

    // 公开内容与 MCP 照常
    assert.equal((await fetch(site.url + '/api/notes')).status, 200)
    assert.equal((await fetch(site.url + '/notes/刑法分论/第10-12节.html')).status, 200)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
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

/**
 * 角色必须显式：systemd 下没写 COURSE_SITE_ROLE 就拒绝启动。
 *
 * 这条不是洁癖：角色缺省成 all 时，公开进程会挂上管理台并加载 PKU/百炼/R2/管理令牌——
 * 一次"单元里忘写 Environment=" 就能把两个进程的隔离全退回去。用 INVOCATION_ID
 * 判断"是不是 systemd 起的"（systemd 给每个单元都会设它）。
 */
test('systemd 下没写角色就拒绝启动；手工跑（非 systemd）才允许退成 all', async () => {
  const serve = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'serve.mjs')
  const spawnServe = env => new Promise((resolve) => {
    const child = spawn(process.execPath, [serve], {
      env: { ...process.env, COURSE_SITE_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const stop = () => { if (!killed) { killed = true; child.kill('SIGTERM') } }
    // 一打印 listening 就收工，别让测试白等超时（这条测试要起三次进程）
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('listening')) stop() })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(stop, 5_000)
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })

  // systemd 启动（有 INVOCATION_ID）且没有角色：必须非零退出，并说清怎么修
  const refused = await spawnServe({ INVOCATION_ID: 'test-invocation', COURSE_SITE_ROLE: '' })
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /COURSE_SITE_ROLE/)
  assert.doesNotMatch(refused.stdout, /listening/)

  // 起得来 = 打印了 listening；退出码可能是 0（收到 SIGTERM 后自己退）或 143
  // （信号处理器还没装上就被杀——测试抢先 kill 时会这样），两者都算"启动成功"。
  const startedFine = (result) => {
    assert.match(result.stdout, /listening/, result.stderr)
    assert.ok([0, 143, null].includes(result.code), '意外的退出码：' + result.code + ' ' + result.stderr)
  }

  // 本地手工跑：允许，但要明确说这是"只适合本机开发"的单进程模式
  const local = await spawnServe({ INVOCATION_ID: '', COURSE_SITE_ROLE: '' })
  startedFine(local)
  assert.match(local.stdout, /只适合本机开发/)

  // 显式 public 角色：正常启动
  const explicit = await spawnServe({ INVOCATION_ID: 'test-invocation', COURSE_SITE_ROLE: 'public' })
  startedFine(explicit)
  assert.match(explicit.stdout, /role=public/)
})

/** 大一点的发布库：用来把"检索确实要花时间"变成可测的事实（384 篇 × 约 7KB 正文）。 */
function budgetSiteDir({ count = 120, repeat = 400 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-budget-'))
  const records = []
  for (let index = 0; index < count; index += 1) {
    records.push(buildNoteRecord({
      courseName: '刑法分论',
      teacher: '车浩',
      lessonTitle: `第${index + 1}节`,
      markdown: [`# 第${index + 1}节`, '', '## 课程概览', '', '这一节讲共同故意与共同行为的认定。'.repeat(repeat)].join('\n'),
      publishedAt: '2026-09-25T00:00:00.000Z'
    }))
  }
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(records))
  return dir
}

const jsonPost = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})
const toolsList = url => jsonPost(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

test('站内搜索与 /mcp 共用同一本预算：一个入口用掉的额度，另一个入口同样算数', async () => {
  // 以前只有 MCP 有闸门，/api/search 一个都没有：同一台机器，绕开 MCP 打搜索一样能打满。
  const root = budgetSiteDir({ count: 3, repeat: 10 })
  const site = await startSiteServer({ root, port: 0, rateLimit: { windowMs: 60_000, max: 2 } })
  try {
    const query = encodeURIComponent('共同行为')
    assert.equal((await fetch(`${site.url}/api/search?q=${query}`)).status, 200)
    assert.equal((await toolsList(`${site.url}/mcp`)).status, 200)

    // 两个入口各一次 = 用掉两次，第三次不管走哪个入口都该被挡
    const blocked = await fetch(`${site.url}/api/search?q=${query}`)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '60')
    const payload = await blocked.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'rate_limited')

    const mcpBlocked = await toolsList(`${site.url}/mcp`)
    assert.equal(mcpBlocked.status, 429, 'MCP 入口同样是同一本账')
    assert.match((await mcpBlocked.json()).error.message, /请求过于频繁/)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('查询长度预算两个入口一致：/api/search 回 400，MCP 回可改参数的 isError', async () => {
  const root = budgetSiteDir({ count: 3, repeat: 10 })
  const site = await startSiteServer({ root, port: 0, maxQueryChars: 20 })
  try {
    const long = '法'.repeat(21)
    const search = await fetch(`${site.url}/api/search?q=${encodeURIComponent(long)}`)
    assert.equal(search.status, 400)
    const payload = await search.json()
    assert.equal(payload.error, 'query_too_long')
    assert.match(payload.message, /21 字，上限 20 字/)

    // MCP 这边走 isError:true 的文本结果：模型读了知道"把查询改短就能重试"
    const mcp = await jsonPost(`${site.url}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: long } }
    })
    const result = await mcp.json()
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /查询过长：21 字，上限 20 字/)

    // 正好到上限：放行（上限是"允许的长度"，不是"必须小于"）
    const atLimit = await fetch(`${site.url}/api/search?q=${encodeURIComponent('法'.repeat(20))}`)
    assert.equal(atLimit.status, 200)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('时间预算：慢检索回 504 并归还名额（连发两次是 504 而不是 503）', async () => {
  const root = budgetSiteDir()
  // 先证明这份库正常能搜：否则 504 说不清是"预算"还是"库坏了"
  const normal = await startSiteServer({ root, port: 0 })
  try {
    const ok = await fetch(`${normal.url}/api/search?q=${encodeURIComponent('共同行为')}&limit=3`)
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).ok, true)
  } finally {
    await normal.close()
  }

  // 1ms 预算 + 1 个并发名额：慢检索必然超时；第二次如果还是 504（而不是 503 busy），
  // 就说明第一次虽然超时了，名额确实已经归还——这正是"异常路径不漏槽位"的验收点。
  const site = await startSiteServer({ root, port: 0, requestTimeoutMs: 1, maxConcurrent: 1 })
  try {
    const first = await fetch(`${site.url}/api/search?q=${encodeURIComponent('共同行为')}`)
    assert.equal(first.status, 504)
    assert.equal(first.headers.get('retry-after'), '1')
    const payload = await first.json()
    assert.equal(payload.error, 'search_timeout')
    assert.match(payload.message, /检索超时/)

    const second = await fetch(`${site.url}/api/search?q=${encodeURIComponent('共同行为')}`)
    assert.equal(second.status, 504, '第二次该是超时（504）；若变成 503 说明名额泄漏了')

    // 进程照常服务别的请求
    assert.equal((await fetch(`${site.url}/healthz`)).status, 200)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('站内搜索中途断开：并发名额立刻归还（下一个请求不会是 503）', async () => {
  const root = budgetSiteDir()
  const site = await startSiteServer({ root, port: 0, maxConcurrent: 1 })
  try {
    const controller = new AbortController()
    const pending = fetch(`${site.url}/api/search?q=${encodeURIComponent('共同行为')}`, { signal: controller.signal })
      .catch(error => error)
    // 等检索真的跑起来再断开（这份库的检索要几十毫秒，20ms 足够进到处理中）
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await pending
    // 服务端收到 close 有一个网络往返的延迟，给它一点点时间
    await new Promise(resolve => setTimeout(resolve, 50))

    // 只有一个并发名额：若断开时没归还，这里必然是 503
    const after = await toolsList(`${site.url}/mcp`)
    assert.equal(after.status, 200)
  } finally {
    await site.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
