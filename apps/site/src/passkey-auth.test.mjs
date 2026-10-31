import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startSiteServer } from './server.mjs'
import { createEnrollmentCode } from './passkey-auth.mjs'

const OWNER = '550e8400-e29b-41d4-a716-446655440000'
const SIGNING_KEY = 'local-test-signing-key-32-characters-minimum'
const ORIGIN = 'https://course.law-tech.dev'

async function serverFixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-passkey-test-'))
  const scratchRoot = path.join(root, 'private')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const site = await startSiteServer({
    root, port: 0, host: '127.0.0.1', admin: true,
    adminToken: 'test-admin-token', scratchRoot, mcp: false,
    ssoKey: SIGNING_KEY, passkeyMode: mode, passkeyOwnerId: OWNER,
    contentVisibility: 'private'
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
  assert.match(index.headers.get('location'), /desk\.law-tech\.dev\/api\/course\/sso/)
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
