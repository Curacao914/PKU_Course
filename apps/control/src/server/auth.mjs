import crypto from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function unauthorized() { return Object.assign(new Error('UNAUTHORIZED'), { status: 401 }) }
function equal(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}
function assertKey(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32) throw new Error('Control signing key must contain at least 32 bytes')
}
function canonical({ timestamp, nonce, method, path, ownerId, body = '' }) {
  return [timestamp, nonce, method.toUpperCase(), path, ownerId, crypto.createHash('sha256').update(body).digest('hex')].join('\n')
}
export function signRequest({ key, timestamp = Date.now(), nonce = crypto.randomBytes(16).toString('hex'), ...request }) {
  assertKey(key)
  return {
    'x-course-timestamp': String(timestamp),
    'x-course-nonce': nonce,
    'x-course-owner-id': request.ownerId,
    'x-course-signature': crypto.createHmac('sha256', key).update(canonical({ ...request, timestamp, nonce })).digest('hex')
  }
}
export function createRequestVerifier({ key, now = Date.now, windowMs = 60_000, maxNonces = 10000 }) {
  assertKey(key)
  const seen = new Map()
  return ({ headers, method, path, body = '' }) => {
    const timestamp = headers['x-course-timestamp']; const nonce = headers['x-course-nonce']
    const ownerId = headers['x-course-owner-id']; const signature = headers['x-course-signature']
    const stamp = now()
    if (!/^\d{1,16}$/.test(timestamp || '') || Math.abs(stamp - Number(timestamp)) > windowMs ||
      !/^[0-9a-f]{32}$/.test(nonce || '') || !UUID.test(ownerId || '') || !/^[0-9a-f]{64}$/.test(signature || '')) throw unauthorized()
    const expected = signRequest({ key, timestamp, nonce, ownerId, method, path, body })['x-course-signature']
    if (!equal(signature, expected)) throw unauthorized()
    for (const [n, expires] of seen) if (expires < stamp) seen.delete(n)
    if (seen.has(nonce) || seen.size >= maxNonces) throw unauthorized()
    seen.set(nonce, Number(timestamp) + windowMs)
    return ownerId
  }
}

// Ephemeral key and active-token registry deliberately do not survive control restart.
export function createJobTokens({ now = Date.now, ttlMs = 60 * 60 * 1000 } = {}) {
  const key = crypto.randomBytes(32)
  const active = new Map()
  return {
    issue({ ownerId, jobId, scope = 'private-note:write' }) {
      const claims = { ownerId, jobId, scope, expiresAt: now() + ttlMs, nonce: crypto.randomBytes(16).toString('hex') }
      const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
      const token = encoded + '.' + crypto.createHmac('sha256', key).update(encoded).digest('base64url')
      active.set(jobId, token)
      return token
    },
    verify(token, { ownerId, jobId, scope }) {
      if (typeof token !== 'string' || token.length > 2048) throw unauthorized()
      const [encoded, signature, extra] = token.split('.')
      if (!encoded || extra || !equal(signature, crypto.createHmac('sha256', key).update(encoded).digest('base64url'))) throw unauthorized()
      let claims
      try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString()) } catch { throw unauthorized() }
      if (claims.ownerId !== ownerId || claims.jobId !== jobId || claims.scope !== scope ||
        !Number.isFinite(claims.expiresAt) || claims.expiresAt <= now() || !equal(active.get(jobId), token)) throw unauthorized()
      return claims
    },
    revoke(jobId) { active.delete(jobId) }
  }
}
