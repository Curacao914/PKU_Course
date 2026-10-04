import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import { buildNoteRecord } from '@course/publish'

import { startSiteServer } from './server.mjs'

/**
 * 私有阅读站 + 长期 MCP 令牌（docs/36）。
 *
 * 这里全部用**桩 control**：站点进程对 private notes / MCP 密钥的每一次读取都要过
 * HMAC 签名的 /v1/* 接口，桩只认签名头里的 owner —— 因此"按 owner 过滤"这件事
 * 是被真实测到的，而不是靠读代码推断。
 */

const KEY = 'test-control-signing-key-at-least-32-bytes'
/** 两个真实的 UUID 形状（parseMcpAccessToken 只认 36 位十六进制与连字符）。 */
const OWNER_A = '69dc54b1-f8ec-4c69-b391-9add6d947751'
const OWNER_B = '11111111-2222-4333-8444-555555555555'
const SECRET_A = 'a'.repeat(43)
const SECRET_B = 'b'.repeat(43)

function noteFixture({ owner, courseName, lessonTitle, lessonDate, body }) {
  const record = buildNoteRecord({
    courseName,
    lessonTitle,
    markdown: body,
    replayKey: courseName + '-' + lessonTitle,
    lessonDate,
    firstPublishedAt: '2026-09-25T00:00:00.000Z'
  })
  const id = 'note-' + record.slug.replace(/[^\w]+/g, '-')
  return {
    id,
    slug: record.slug,
    title: lessonTitle,
    courseName,
    lessonTitle,
    lessonDate,
    replayKey: record.replayKey,
    checksum: 'checksum-' + lessonDate,
    status: 'published',
    updatedAt: '2026-09-25T00:00:00.000Z',
    index: Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'markdown')),
    markdown: body
  }
}

const COURSE_A = '国际刑法学'
const COURSE_B = '商法概论'
const NOTE_A1 = noteFixture({
  owner: OWNER_A,
  courseName: COURSE_A,
  lessonTitle: '第1-2节 国际刑法的概念',
  lessonDate: '2026-09-09',
  body: ['# 第1-2节 国际刑法的概念', '', '## 一、概念界定', '', '国际刑法是规定国际犯罪的实体法与程序法的总和。'.repeat(6), '', '## 二、学科特征', '', '它同时具有国际法与刑法的双重属性。'.repeat(6)].join('\n')
})
const NOTE_A2 = noteFixture({
  owner: OWNER_A,
  courseName: COURSE_A,
  lessonTitle: '第3-4节 管辖与引渡',
  lessonDate: '2026-09-16',
  body: ['# 第3-4节 管辖与引渡', '', '## 一、普遍管辖', '', '普遍管辖针对海盗、种族灭绝等国际罪行。'.repeat(6)].join('\n')
})
const NOTE_B1 = noteFixture({
  owner: OWNER_B,
  courseName: COURSE_B,
  lessonTitle: '第1节 商法总论',
  lessonDate: '2026-09-02',
  body: ['# 第1节 商法总论', '', '## 一、商法的调整对象', '', '商法调整商事关系，与民法是特别法与一般法的关系。'.repeat(6)].join('\n')
})

const TOPIC_A = {
  id: 'topic-a',
  topicId: 'topic-a',
  courseName: COURSE_A,
  title: '国际刑法的概念与管辖',
  summary: '把两节课串成一条线。',
  lessons: [NOTE_A1.slug, NOTE_A2.slug],
  status: 'fresh',
  updatedAt: '2026-09-25T00:00:00.000Z',
  artifact: {
    kind: 'course-topic',
    id: 'topic-a',
    course: COURSE_A,
    title: '国际刑法的概念与管辖',
    summary: '把两节课串成一条线。',
    lessons: [{ slug: NOTE_A1.slug, checksum: 'checksum-2026-09-09' }, { slug: NOTE_A2.slug, checksum: 'checksum-2026-09-16' }],
    nodes: [
      {
        id: 'node-1',
        title: '概念界定',
        summary: '先分清实体法与程序法。',
        relation: 'hierarchy',
        sourceRefs: [{ slug: NOTE_A1.slug, sectionId: '一概念界定', title: '一、概念界定' }],
        children: []
      }
    ]
  }
}

/** 桩 control：只认签名头里的 owner，返回值按 owner 分账。 */
function controlStub({ secrets = {}, inactive = [] } = {}) {
  const notes = { [OWNER_A]: [NOTE_A1, NOTE_A2], [OWNER_B]: [NOTE_B1] }
  const topics = { [OWNER_A]: [TOPIC_A], [OWNER_B]: [] }
  const calls = []
  const store = { ...secrets }
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
  const fetchStub = async (url, options = {}) => {
    const target = new URL(String(url))
    const owner = String(options.headers?.['x-course-owner-id'] || '')
    calls.push({ owner, method: options.method || 'GET', path: target.pathname + target.search })
    if (inactive.includes(owner)) return json({ ok: false, error: 'PROFILE_INACTIVE' }, 403)
    if (target.pathname === '/v1/private/content') {
      return json({ ok: true, notes: notes[owner] || [], topics: topics[owner] || [] })
    }
    if (target.pathname === '/v1/private/note') {
      const id = target.searchParams.get('id')
      const all = [...(notes[owner] || []), ...(topics[owner] || [])]
      const found = all.find(item => item.id === id)
      if (!found) return json({ ok: false, error: 'NOTE_NOT_FOUND' }, 404)
      const markdown = found.markdown || ('# ' + found.title + '\n\n专题正文。')
      return json({ ok: true, note: { id: found.id, title: found.title, body_markdown: markdown, metadata: { index: found.index || {} } } })
    }
    if (target.pathname === '/v1/account/mcp-secret') {
      const secret = store[owner] || ''
      return json({ ok: true, configured: Boolean(secret), secret })
    }
    if (target.pathname === '/v1/account/mcp-token') {
      if ((options.method || 'GET') === 'PUT') {
        const body = JSON.parse(String(options.body || '{}'))
        store[owner] = String(body.secret || '')
        return json({ ok: true, credential: { provider: 'mcp', configured: true } })
      }
      delete store[owner]
      return json({ ok: true })
    }
    return json({ ok: false, error: 'UNKNOWN_ROUTE' }, 404)
  }
  return { fetchStub, calls, secrets: store }
}

function ticket({ sub, role = 'member', next = '/', email = 'member@stu.pku.edu.cn' }) {
  const now = Math.floor(Date.now() / 1000)
  const payload = { v: 1, sub, role, email, next, iat: now, exp: now + 300 }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return body + '.' + createHmac('sha256', KEY).update('course-sso-v1.' + body).digest('base64url')
}

/** 走真实的 SSO 回调换取会话 cookie（不复制会话格式，格式变了这条测试就该红）。 */
async function login(site, ownerId, next = '/') {
  const res = await fetch(site.url + '/_auth/callback?token=' + encodeURIComponent(ticket({ sub: ownerId, next })), { redirect: 'manual' })
  assert.equal(res.status, 302, 'SSO 回调应当 302 回原路径')
  const cookie = String(res.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie.startsWith('lawtech_course_session='), 'SSO 回调必须下发会话 cookie：' + cookie)
  return { cookie, location: res.headers.get('location') }
}

function startPrivateSite(options = {}) {
  const control = controlStub({ secrets: { [OWNER_A]: SECRET_A, [OWNER_B]: SECRET_B }, ...options.control })
  return startSiteServer({
    root: process.cwd(),
    port: 0,
    adminToken: 'test-admin-token',
    admin: true,
    ssoKey: KEY,
    controlUrl: 'http://control.test',
    controlFetch: control.fetchStub,
    contentVisibility: 'private',
    ...options.server
  }).then(site => ({ site, control }))
}

const bearer = (owner, secret) => ({ authorization: 'Bearer cmcp1.' + owner + '.' + secret })

async function getHtml(site, path, cookie) {
  const res = await fetch(site.url + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
  return { res, html: res.headers.get('content-type')?.includes('text/html') ? await res.text() : '' }
}

test('未登录的阅读路径回 SSO 并带原路径；/api/search 明确 401', async () => {
  const { site } = await startPrivateSite()
  try {
    const home = await fetch(site.url + '/', { redirect: 'manual' })
    assert.equal(home.status, 302)
    assert.match(String(home.headers.get('location')), /^https:\/\/desk\.law-tech\.dev\/api\/course\/sso\?next=%2F$/)
    assert.equal(home.headers.get('cache-control'), 'no-store')

    const note = await fetch(site.url + '/' + NOTE_A1.slug + '.html', { redirect: 'manual' })
    assert.equal(note.status, 302)
    assert.match(String(note.headers.get('location')), /next=%2Fnotes%2F/)

    const search = await fetch(site.url + '/api/search?q=%E5%9B%BD%E9%99%85', { redirect: 'manual' })
    assert.equal(search.status, 401)
    assert.equal((await search.json()).error, 'account_session_required')
  } finally {
    await site.close()
  }
})

test('公开模式下管理进程不接管阅读路径（配置漂移不会把整站变成要登录）', async () => {
  const { site } = await startPrivateSite({ server: { contentVisibility: 'public' } })
  try {
    const note = await fetch(site.url + '/' + NOTE_A1.slug + '.html', { redirect: 'manual' })
    assert.notEqual(note.status, 302, '公开模式下不该跳 SSO')
    assert.equal(note.status, 404)

    const search = await fetch(site.url + '/api/search?q=%E5%9B%BD%E9%99%85')
    assert.notEqual(search.status, 401)
  } finally {
    await site.close()
  }
})

test('登录后根目录是阅读站（不是管理壳），含课程、课次与进入管理入口', async () => {
  const { site, control } = await startPrivateSite()
  try {
    const { cookie } = await login(site, OWNER_A)
    const { res, html } = await getHtml(site, '/', cookie)
    assert.equal(res.status, 200)
    assert.match(String(res.headers.get('content-type')), /text\/html/)
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    assert.match(html, /国际刑法学/)
    assert.match(html, /第1-2节 国际刑法的概念/)
    assert.match(html, /href="\/admin"/, '阅读页要能进管理页')
    assert.doesNotMatch(html, /data-act="mcp-token"/, '根目录不该是管理壳')
    assert.doesNotMatch(html, /商法概论/, 'A 的首页不能出现 B 的课程')
    // 每一次读取都必须按 owner 签名：桩只认签名头，出现别的 owner 就是越权
    assert.deepEqual([...new Set(control.calls.map(call => call.owner))], [OWNER_A])
  } finally {
    await site.close()
  }
})

test('note / onepage / topic / course / map / 索引 / 搜索页都能打开', async () => {
  const { site } = await startPrivateSite()
  try {
    const { cookie } = await login(site, OWNER_A)

    const note = await getHtml(site, '/' + NOTE_A1.slug + '.html', cookie)
    assert.equal(note.res.status, 200)
    assert.match(note.html, /国际刑法是规定国际犯罪的实体法/)
    assert.match(note.html, /本课程课次/, '左侧课次导航要在')
    assert.match(note.html, /本页目录/)
    assert.ok(note.html.includes('href="/' + NOTE_A2.slug + '.html"'), '左侧课次指向同一门课的另一节')

    const onepage = await getHtml(site, '/' + NOTE_A1.slug.replace(/^notes\//, 'onepage/') + '.html', cookie)
    assert.equal(onepage.res.status, 200)

    const course = await getHtml(site, '/courses/' + encodeURIComponent('国际刑法学') + '/', cookie)
    assert.equal(course.res.status, 200)
    assert.match(course.html, /第1-2节 国际刑法的概念/)

    for (const path of ['/map/', '/concepts/', '/statutes/', '/cases/', '/search/']) {
      const page = await getHtml(site, path, cookie)
      assert.equal(page.res.status, 200, path + ' 应当能打开')
      assert.match(page.html, /<html/, path + ' 应当是完整页面')
    }

    const topics = await getHtml(site, '/topics/国际刑法学/topic-a.html', cookie)
    assert.equal(topics.res.status, 200)
    for (const tab of ['框架', '提纲', '自测']) assert.match(topics.html, new RegExp(tab))
    assert.match(topics.html, new RegExp('/' + NOTE_A1.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.html#'), '专题出处要能回原笔记')
  } finally {
    await site.close()
  }
})

test('找不到的课次回根目录（不是 500，也不是别人的笔记）', async () => {
  const { site } = await startPrivateSite()
  try {
    const { cookie } = await login(site, OWNER_A)
    const missing = await fetch(site.url + '/notes/国际刑法学/不存在的课.html', { headers: { cookie }, redirect: 'manual' })
    assert.equal(missing.status, 302)
    assert.equal(missing.headers.get('location'), '/')

    // B 的笔记对 A 来说同样"不存在"：即便路径完全正确
    const other = await fetch(site.url + '/' + NOTE_B1.slug + '.html', { headers: { cookie }, redirect: 'manual' })
    assert.equal(other.status, 302)
    assert.equal(other.headers.get('location'), '/')
  } finally {
    await site.close()
  }
})

test('私有检索只搜当前 owner，结果链接回私有笔记页', async () => {
  const { site, control } = await startPrivateSite()
  try {
    const { cookie } = await login(site, OWNER_A)
    const res = await fetch(site.url + '/api/search?q=' + encodeURIComponent('管辖'), { headers: { cookie } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.ok(payload.hits.length >= 1, '应当命中第3-4节的管辖')
    for (const hit of payload.hits) {
      assert.match(hit.url, /^\/notes\//)
      assert.equal(hit.courseName, COURSE_A)
    }
    assert.ok(!JSON.stringify(payload).includes(COURSE_B), '不能出现 B 的课程')
    assert.deepEqual([...new Set(control.calls.map(call => call.owner))], [OWNER_A])
  } finally {
    await site.close()
  }
})

test('私有检索与 /mcp 共用同一本预算：限流与查询长度都拦得住', async () => {
  const { site } = await startPrivateSite({ server: { rateLimit: { windowMs: 60_000, max: 2 }, maxQueryChars: 20 } })
  try {
    const { cookie } = await login(site, OWNER_A)
    const q = 'q=' + encodeURIComponent('管辖')
    assert.equal((await fetch(site.url + '/api/search?' + q, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(site.url + '/api/search?' + q, { headers: { cookie } })).status, 200)
    const blocked = await fetch(site.url + '/api/search?' + q, { headers: { cookie } })
    assert.equal(blocked.status, 429, '第三次必须被同一本账挡住')
    assert.equal(blocked.headers.get('retry-after'), '60')
    assert.equal((await blocked.json()).error, 'rate_limited')

    // 换一个窗口验证长度预算（超长查询不占限流额度）
    const { site: fresh } = await startPrivateSite({ server: { maxQueryChars: 20 } })
    try {
      const { cookie: cookie2 } = await login(fresh, OWNER_A)
      const long = await fetch(fresh.url + '/api/search?q=' + encodeURIComponent('法'.repeat(21)), { headers: { cookie: cookie2 } })
      assert.equal(long.status, 400)
      const payload = await long.json()
      assert.equal(payload.error, 'query_too_long')
      assert.match(payload.message, /21 字，上限 20 字/)
    } finally {
      await fresh.close()
    }
  } finally {
    await site.close()
  }
})

const mcpPost = (site, body, headers = {}) => fetch(site.url + '/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
})

const toolsList = (site, headers) => mcpPost(site, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)
const getCourse = (site, headers, course = COURSE_A) => mcpPost(site, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'get_course', arguments: { course } }
}, headers)

test('长期 MCP 令牌：有效即通，换发/删除立刻失效，跨 owner 与未激活账号都不认', async () => {
  const { site, control } = await startPrivateSite()
  try {
    const tokenA = 'cmcp1.' + OWNER_A + '.' + SECRET_A
    const tokenB = 'cmcp1.' + OWNER_B + '.' + SECRET_B

    // 没令牌 / 乱写 / 旧格式（30 天 HMAC 自包含票据）一律 401
    assert.equal((await toolsList(site)).status, 401)
    assert.equal((await toolsList(site, { authorization: 'Bearer nonsense' })).status, 401)
    assert.equal((await toolsList(site, { authorization: 'Bearer cmcp1.' + OWNER_A + '.short' })).status, 401)
    const now = Math.floor(Date.now() / 1000)
    const legacyBody = Buffer.from(JSON.stringify({ v: 1, sub: OWNER_A, role: 'member', iat: now, exp: now + 86400 })).toString('base64url')
    const legacy = legacyBody + '.' + createHmac('sha256', KEY).update('course-mcp-v1.' + legacyBody).digest('base64url')
    assert.equal((await toolsList(site, { authorization: 'Bearer ' + legacy })).status, 401, '旧的自包含票据不再兼容')

    // 正确令牌：可以列工具、可以按 owner 取课
    assert.equal((await toolsList(site, { authorization: 'Bearer ' + tokenA })).status, 200)
    const course = await getCourse(site, { authorization: 'Bearer ' + tokenA })
    assert.equal(course.status, 200)
    const text = (await course.json()).result.content[0].text
    assert.match(text, new RegExp(COURSE_A))
    assert.doesNotMatch(text, new RegExp(COURSE_B), 'A 的令牌不能看到 B 的课程')

    // 拿 B 的 owner 配 A 的密钥：等于伪造，必须 401
    assert.equal((await toolsList(site, { authorization: 'Bearer cmcp1.' + OWNER_B + '.' + SECRET_A })).status, 401)

    // 换发：旧令牌立刻失效，新令牌可用
    const put = await fetch(site.url + '/api/account/mcp-token', {
      method: 'POST',
      headers: { cookie: (await login(site, OWNER_A)).cookie, 'content-type': 'application/json' },
      body: '{}'
    })
    assert.equal(put.status, 200)
    const issued = (await put.json()).token
    assert.equal(put.headers.get('cache-control'), 'private, no-store')
    assert.match(issued, new RegExp('^cmcp1\\.' + OWNER_A + '\\.'))
    assert.equal((await toolsList(site, { authorization: 'Bearer ' + tokenA })).status, 401, '换发后旧令牌必须失效')
    assert.equal((await toolsList(site, { authorization: 'Bearer ' + issued })).status, 200)

    // 删除：当前令牌立刻失效
    const removed = await fetch(site.url + '/api/account/mcp-token', {
      method: 'DELETE',
      headers: { cookie: (await login(site, OWNER_A)).cookie }
    })
    assert.equal(removed.status, 200)
    assert.equal(control.secrets[OWNER_A], undefined)
    assert.equal((await toolsList(site, { authorization: 'Bearer ' + issued })).status, 401)

    // 未激活账号：control 回 403，站点必须当成"没有这个令牌"
    const inactiveSite = await startPrivateSite({ control: { inactive: [OWNER_B] } })
    try {
      assert.equal((await toolsList(inactiveSite.site, { authorization: 'Bearer ' + tokenB })).status, 401)
    } finally {
      await inactiveSite.site.close()
    }
  } finally {
    await site.close()
  }
})

test('MCP 报的专题页指向阅读站，不是管理页', async () => {
  const { site } = await startPrivateSite()
  try {
    const tokenA = { authorization: 'Bearer cmcp1.' + OWNER_A + '.' + SECRET_A }
    const list = await getCourse(site, tokenA)
    assert.equal(list.status, 200)
    const text = (await list.json()).result.content[0].text
    assert.match(text, /fetchId: topic:topic-a/, 'get_course 要列出专题与它的 fetchId')

    // 真正的页址在 fetch 的结果里（fetchId 才是模型该用的入口）
    const fetched = await mcpPost(site, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'fetch', arguments: { id: 'topic:topic-a' } }
    }, tokenA)
    assert.equal(fetched.status, 200)
    const document = (await fetched.json()).result.structuredContent
    assert.match(document.url, /\/topics\/国际刑法学\/topic-a\.html$/, '专题链接必须落在阅读站，而不是 /admin')
    assert.match(document.text, /专题正文/, '专题正文来自私有库')
  } finally {
    await site.close()
  }
})
