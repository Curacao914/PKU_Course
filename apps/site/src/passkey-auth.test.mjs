import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startSiteServer } from './server.mjs'
import { createEnrollmentCode } from './passkey-auth.mjs'

const OWNER = '550e8400-e29b-41d4-a716-446655440000'
const SIGNING_KEY = 'local-test-signing-key-32-characters-minimum'
const ORIGIN = 'https://course.law-tech.dev'

async function serverFixture(mode, controlFetch = fetch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-passkey-test-'))
  const scratchRoot = path.join(root, 'private')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const site = await startSiteServer({
    root, port: 0, host: '127.0.0.1', admin: true,
    adminToken: 'test-admin-token', scratchRoot, mcp: false,
    ssoKey: SIGNING_KEY, passkeyMode: mode, passkeyOwnerId: OWNER,
    contentVisibility: 'private', controlFetch
  })
  return {
    url: site.url,
    scratchRoot,
    close: async () => {
      await new Promise(resolve => site.server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
async function post(url, payload, origin = ORIGIN) {
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(payload)
  })
  const body = await res.json()
  return { res, body }
}

test('passkey-only mode redirects to local login and ignores old SSO tickets', async t => {
  const s = await serverFixture('passkey')
  t.after(s.close)
  const index = await fetch(s.url + '/', { redirect: 'manual' })
  assert.equal(index.status, 302)
  assert.match(index.headers.get('location'), /^\/login\?next=/)
  const admin = await fetch(s.url + '/admin', { redirect: 'manual' })
  assert.equal(admin.status, 302)
  assert.match(admin.headers.get('location'), /^\/login\?next=/)
  const callback = await fetch(s.url + '/_auth/callback?token=dummy', { redirect: 'manual' })
  assert.equal(callback.status, 303)
  assert.equal(callback.headers.get('location'), '/login')
  const session = await fetch(s.url + '/_auth/session')
  assert.deepEqual(await session.json(), { authenticated: false, role: '', email: '' })
  const login = await fetch(s.url + '/login')
  assert.equal(login.status, 200)
  assert.match(await login.text(), /使用通行密钥登录/)
  assert.match(login.headers.get('cache-control'), /no-store/)
})

test('bootstrap is one-time, secret and origin-bound; invalid WebAuthn cannot enroll', async t => {
  const s = await serverFixture('passkey')
  t.after(s.close)
  const noPasskey = await post(s.url + '/_auth/passkey/login/options', {})
  assert.equal(noPasskey.res.status, 409)
  assert.equal(noPasskey.body.error, 'PASSKEY_NOT_REGISTERED')
  const originBlocked = await post(s.url + '/_auth/passkey/register/options', { code: 'x' }, 'https://evil.example')
  assert.equal(originBlocked.res.status, 403)
  assert.equal(originBlocked.body.error, 'INVALID_ORIGIN')
  const { code } = createEnrollmentCode({ root: s.scratchRoot })
  const bad = await post(s.url + '/_auth/passkey/register/options', { code: 'invalid' })
  assert.equal(bad.res.status, 403)
  const result = await post(s.url + '/_auth/passkey/register/options', { code })
  assert.equal(result.res.status, 200)
  assert.equal(result.body.options.rp.id, 'course.law-tech.dev')
  assert.ok(result.body.options.challenge)
  const invalid = await post(s.url + '/_auth/passkey/register/verify', {
    code, flowId: result.body.flowId, credential: { id: 'fake' }
  })
  assert.equal(invalid.res.status, 400)
  assert.equal(fs.existsSync(path.join(s.scratchRoot, 'passkey-auth', 'credentials.json')), false)
  const replay = await post(s.url + '/_auth/passkey/register/verify', {
    code, flowId: result.body.flowId, credential: { id: 'fake' }
  })
  assert.equal(replay.body.error, 'CHALLENGE_EXPIRED')
  const storedCode = JSON.parse(fs.readFileSync(path.join(s.scratchRoot, 'passkey-auth', 'bootstrap.json')))
  assert.ok(!JSON.stringify(storedCode).includes(code))
  assert.equal(fs.statSync(path.join(s.scratchRoot, 'passkey-auth', 'bootstrap.json')).mode & 0o777, 0o600)
})

test('hybrid allows new passkey enrollment while keeping SSO temporarily unchanged', async t => {
  const s = await serverFixture('hybrid')
  t.after(s.close)
  const index = await fetch(s.url + '/', { redirect: 'manual' })
  assert.equal(index.status, 302)
  assert.match(index.headers.get('location'), /law-tech\.dev\/api\/course\/sso/)
  const login = await fetch(s.url + '/login')
  assert.equal(login.status, 200)
  const preflight = await post(s.url + '/_auth/passkey/login/options', {})
  assert.equal(preflight.res.status, 409)
})

test('bootstrap expiration and owner binding are enforced', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-bootstrap-'))
  try {
    const { code, expiresAt } = createEnrollmentCode({ root, now: () => 1000 })
    assert.equal(expiresAt, new Date(1000 + 20 * 60_000).toISOString())
    assert.equal(typeof code, 'string')
    assert.ok(code.length >= 30)
    const stored = fs.readFileSync(path.join(root, 'passkey-auth', 'bootstrap.json'), 'utf8')
    assert.ok(!stored.includes(code))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('hybrid automatically retires SSO once the first owner passkey is persisted', async t => {
  const s = await serverFixture('hybrid')
  t.after(s.close)
  const dir = path.join(s.scratchRoot, 'passkey-auth')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    v: 1, ownerId: OWNER,
    credentials: [{ id: 'credential-id', publicKey: 'AQAB', counter: 0, transports: [] }]
  }), { mode: 0o600 })
  const index = await fetch(s.url + '/', { redirect: 'manual' })
  assert.match(index.headers.get('location'), /^\/login\?next=/)
  const callback = await fetch(s.url + '/_auth/callback?token=old-sso-token', { redirect: 'manual' })
  assert.equal(callback.status, 303)
  assert.equal(callback.headers.get('location'), '/login')
})

function ownerSession(amr = 'passkey') {
  const iat = Math.floor(Date.now() / 1000)
  const payload = { v: 1, sub: OWNER, role: 'owner', amr, iat, exp: iat + 3600 }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', SIGNING_KEY).update('course-session-v1.' + body).digest('base64url')
  return 'lawtech_course_session=' + body + '.' + signature
}

test('owner can retrieve the same long-lived MCP token under passkey session without rotating', async t => {
  const secret = 'a-reusable-mcp-secret-with-more-than-32-characters'
  const calls = []
  const controlFetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method || 'GET' })
    return new Response(JSON.stringify({ ok: true, configured: true, secret }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }
  const s = await serverFixture('passkey', controlFetch)
  t.after(s.close)
  const noSession = await fetch(s.url + '/api/account/mcp-token')
  assert.equal(noSession.status, 401)
  const legacySession = await fetch(s.url + '/api/account/mcp-token', { headers: { cookie: ownerSession('sso') } })
  assert.equal(legacySession.status, 401)
  for (let i = 0; i < 2; i++) {
    const res = await fetch(s.url + '/api/account/mcp-token', { headers: { cookie: ownerSession() } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('cache-control'), /no-store/)
    assert.deepEqual(await res.json(), {
      ok: true, token: 'cmcp1.' + OWNER + '.' + secret,
      endpoint: '/mcp', persistent: true
    })
  }
  assert.equal(calls.length, 2)
  assert.ok(calls.every(c => c.url.endsWith('/v1/account/mcp-secret') && c.method === 'GET'))
})

test('MCP secret read cannot be used without Passkey OWNER role or when unconfigured', async t => {
  const s = await serverFixture('passkey', async () => new Response(JSON.stringify({ ok: true, configured: false, secret: '' }), {
    status: 200, headers: { 'content-type': 'application/json' }
  }))
  t.after(s.close)
  const absent = await fetch(s.url + '/api/account/mcp-token', { headers: { cookie: ownerSession() } })
  assert.equal(absent.status, 404)
  assert.equal((await absent.json()).error, 'mcp_not_configured')
})
