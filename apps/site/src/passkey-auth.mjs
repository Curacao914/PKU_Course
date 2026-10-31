import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server'

const CHALLENGE_TTL_MS = 5 * 60_000
const BOOTSTRAP_TTL_MS = 20 * 60_000
const MAX_BODY_BYTES = 64 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex')
const equal = (a, b) => {
  const lhs = Buffer.from(String(a || ''))
  const rhs = Buffer.from(String(b || ''))
  return lhs.length > 0 && lhs.length === rhs.length && crypto.timingSafeEqual(lhs, rhs)
}

function authDir(root) { return path.join(root || path.join(os.homedir(), '.course-worker'), 'passkey-auth') }
function ensureDir(root) {
  const dir = authDir(root)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const tmp = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, filename)
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}
function readJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) }
  catch (err) {
    if (err?.code === 'ENOENT') return fallback
    throw err
  }
}
export function createEnrollmentCode({ root, now = Date.now } = {}) {
  const dir = ensureDir(root)
  const code = crypto.randomBytes(24).toString('base64url')
  writeJsonAtomic(path.join(dir, 'bootstrap.json'), {
    v: 1, hash: digest(code), expiresAt: now() + BOOTSTRAP_TTL_MS
  })
  return { code, expiresAt: new Date(now() + BOOTSTRAP_TTL_MS).toISOString() }
}

function json(res, status, payload, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra
  })
  res.end(JSON.stringify(payload))
}
function redirect(res, location, extra = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...extra })
  res.end()
}
async function readBody(req) {
  let total = 0
  const parts = []
  for await (const part of req) {
    total += part.length
    if (total > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
function makeError(status, code) { return Object.assign(new Error(code), { status }) }
function safeNext(value) {
  const raw = String(value || '')
  if (!/^\/(?!\/)/.test(raw) || /[\\\u0000-\u0020\u007f]/.test(raw)) return '/'
  try {
    const decoded = decodeURIComponent(raw)
    return /^\/(?!\/)/.test(decoded) && !/[\\\u0000-\u0020\u007f]/.test(decoded) ? raw : '/'
  } catch { return '/' }
}

export function createPasskeyAuth({
  root, ownerId, rpID = 'course.law-tech.dev', origin = 'https://course.law-tech.dev',
  sessionCookie, now = Date.now
} = {}) {
  if (!uuid.test(ownerId || '')) throw new Error('COURSE_ACCOUNT_OWNER_ID 必须配置为有效 UUID')
  if (typeof sessionCookie !== 'function') throw new Error('missing session cookie signer')
  const dir = authDir(root)
  const credentialsFile = path.join(dir, 'credentials.json')
  const bootstrapFile = path.join(dir, 'bootstrap.json')
  const challenges = new Map()
  const attempts = new Map()

  function credentials() {
    const data = readJson(credentialsFile, { v: 1, ownerId, credentials: [] })
    if (data.v !== 1 || data.ownerId !== ownerId || !Array.isArray(data.credentials)) {
      throw new Error('Passkey owner mismatch or invalid credential store')
    }
    return data
  }
  function enrollmentAllowed(code) {
    const bootstrap = readJson(bootstrapFile, null)
    return bootstrap?.v === 1 && bootstrap.expiresAt > now() &&
      equal(bootstrap.hash, digest(code))
  }
  function rateLimit(req) {
    const ip = String(req.socket?.remoteAddress || '')
    const key = ip.slice(0, 100)
    const current = attempts.get(key) || []
    const recent = current.filter(time => time > now() - 15 * 60_000)
    if (recent.length >= 30) throw makeError(429, 'TOO_MANY_ATTEMPTS')
    recent.push(now())
    attempts.set(key, recent)
    if (attempts.size > 500) attempts.clear()
  }
  function makeChallenge(type, challenge, proof = '') {
    for (const [id, entry] of challenges) {
      if (entry.expiresAt < now()) challenges.delete(id)
    }
    if (challenges.size >= 500) throw makeError(429, 'BUSY')
    const flowId = crypto.randomBytes(18).toString('base64url')
    challenges.set(flowId, { type, challenge, proof, expiresAt: now() + CHALLENGE_TTL_MS })
    return flowId
  }
  function consumeChallenge(id, type) {
    const entry = challenges.get(String(id || ''))
    challenges.delete(String(id || ''))
    if (!entry || entry.type !== type || entry.expiresAt < now()) throw makeError(400, 'CHALLENGE_EXPIRED')
    return entry
  }
  function checkRequestOrigin(req) {
    if (req.headers.origin !== origin) throw makeError(403, 'INVALID_ORIGIN')
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      throw makeError(415, 'JSON_REQUIRED')
    }
  }
  function setSession(res) {
    const time = Math.floor(now() / 1000)
    const session = {
      v: 1, sub: ownerId, role: 'owner', email: '', amr: 'passkey',
      iat: time, exp: time + 14 * 86400
    }
    return sessionCookie(session, 14 * 86400)
  }
  async function api(req, res, name) {
    checkRequestOrigin(req)
    rateLimit(req)
    const body = await readBody(req)
    if (name === 'register/options') {
      if (!enrollmentAllowed(body.code)) throw makeError(403, 'INVALID_ENROLLMENT_CODE')
      const saved = credentials()
      const opts = await generateRegistrationOptions({
        rpName: '课程笔记', rpID,
        userID: new TextEncoder().encode(ownerId),
        userName: 'course-owner', userDisplayName: '课程主人',
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: saved.credentials.map(c => ({ id: c.id, transports: c.transports || [] }))
      })
      const flowId = makeChallenge('register', opts.challenge, digest(body.code))
      json(res, 200, { ok: true, flowId, options: opts })
      return
    }
    if (name === 'register/verify') {
      const current = consumeChallenge(body.flowId, 'register')
      if (!equal(current.proof, digest(body.code)) || !enrollmentAllowed(body.code)) {
        throw makeError(403, 'INVALID_ENROLLMENT_CODE')
      }
      const result = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: current.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true
      })
      if (!result.verified || !result.registrationInfo?.credential) throw makeError(403, 'INVALID_PASSKEY')
      const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo
      const saved = credentials()
      if (saved.credentials.some(c => c.id === credential.id)) throw makeError(409, 'PASSKEY_EXISTS')
      saved.credentials.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        deviceType: credentialDeviceType, backedUp: credentialBackedUp,
        enrolledAt: new Date(now()).toISOString()
      })
      writeJsonAtomic(credentialsFile, saved)
      fs.unlinkSync(bootstrapFile)
      json(res, 200, { ok: true }, { 'set-cookie': setSession(res) })
      return
    }
    if (name === 'login/options') {
      const saved = credentials()
      if (!saved.credentials.length) throw makeError(409, 'PASSKEY_NOT_REGISTERED')
      const opts = await generateAuthenticationOptions({
        rpID, userVerification: 'required',
        allowCredentials: saved.credentials.map(c => ({ id: c.id, transports: c.transports || [] }))
      })
      json(res, 200, { ok: true, flowId: makeChallenge('login', opts.challenge), options: opts })
      return
    }
    if (name === 'login/verify') {
      const current = consumeChallenge(body.flowId, 'login')
      const saved = credentials()
      const found = saved.credentials.find(c => c.id === body.credential?.id)
      if (!found) throw makeError(403, 'UNKNOWN_PASSKEY')
      const result = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: current.challenge, expectedOrigin: origin, expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: found.id,
          publicKey: new Uint8Array(Buffer.from(found.publicKey, 'base64url')),
          counter: found.counter,
          transports: found.transports || []
        }
      })
      if (!result.verified) throw makeError(403, 'INVALID_PASSKEY')
      found.counter = result.authenticationInfo.newCounter
      writeJsonAtomic(credentialsFile, saved)
      json(res, 200, { ok: true }, { 'set-cookie': setSession(res) })
      return
    }
    throw makeError(404, 'NOT_FOUND')
  }
  return {
    credentialCount: () => credentials().credentials.length,
    async handle(req, res, pathname, url, session) {
      if (pathname === '/login' && (req.method === 'GET' || req.method === 'HEAD')) {
        const { PASSKEY_LOGIN_HTML } = await import('./passkey-page.mjs')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        })
        res.end(req.method === 'HEAD' ? '' : PASSKEY_LOGIN_HTML)
        return true
      }
      if (pathname === '/_auth/passkey/logout' && req.method === 'POST') {
        if (req.headers.origin !== origin) { json(res, 403, { ok: false }); return true }
        redirect(res, '/login', {
          'set-cookie': 'lawtech_course_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
        })
        return true
      }
      const prefix = '/_auth/passkey/'
      if (!pathname.startsWith(prefix)) return false
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
        return true
      }
      try { await api(req, res, pathname.slice(prefix.length)) }
      catch (error) {
        const status = Number(error?.status) || 400
        json(res, status, { ok: false, error: String(error?.message || 'PASSKEY_FAILED') })
      }
      return true
    },
    loginLocation(next = '/') { return '/login?next=' + encodeURIComponent(safeNext(next)) }
  }
}
