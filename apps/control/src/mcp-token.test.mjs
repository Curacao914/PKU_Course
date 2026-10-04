import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createJobTokens, signRequest } from './server/auth.mjs'
import { CREDENTIAL_PROVIDERS } from './store.mjs'

/**
 * MCP 长期令牌的控制面（docs/36 §4、§6）。
 *
 * 令牌本体是 `cmcp1.<owner_uuid>.<secret>`，secret 复用 provider_credentials 按 owner
 * 加密保存，因此这里有两条不能只靠读代码确认的事：
 *   1. mcp 这条凭据只能走专用路由——走通用凭据路由等于让调用方自己挑 secret；
 *   2. 代码里允许的 provider 与数据库 CHECK 约束必须是同一份清单（迁移漏了就写不进去）。
 */

const KEY = 'test-signing-key-with-at-least-32-bytes'
const OWNER = '11111111-2222-4333-8444-555555555555'
const OTHER = '21111111-2222-4333-8444-555555555555'

async function startControl(extraBuilder = () => ({})) {
  const { createControlServer } = await import('./server.mjs')
  const calls = []
  const credentials = new Map()
  const store = {
    profile: async id => ({ id, role: 'member', status: 'active' }),
    autoSyncOwners: async () => [],
    putCredential: async (ownerId, provider, secret) => {
      calls.push({ action: 'put', ownerId, provider, secret })
      credentials.set(ownerId + ':' + provider, secret)
      return { provider, configured: true, last4: String(secret).slice(-4) }
    },
    deleteCredential: async (ownerId, provider) => {
      calls.push({ action: 'delete', ownerId, provider })
      credentials.delete(ownerId + ':' + provider)
    },
    credentials: async ownerId => Object.fromEntries(
      [...credentials.entries()]
        .filter(([key]) => key.startsWith(ownerId + ':'))
        .map(([key, value]) => [key.slice(ownerId.length + 1), value])
    ),
    ...extraBuilder({ calls, credentials })
  }
  const server = createControlServer({ env: { COURSE_CONTROL_SIGNING_KEY: KEY }, store, r2: {}, qr: {}, jobTokens: createJobTokens() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const request = async ({ ownerId = OWNER, method = 'GET', path: target, body = '' } = {}) => {
    const headers = signRequest({ key: KEY, ownerId, method, path: target, body })
    const response = await fetch(base + target, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      redirect: 'manual'
    })
    return { status: response.status, payload: await response.json().catch(() => ({})) }
  }
  return { base, request, calls, credentials, close: () => new Promise(done => server.close(() => done())) }
}

test('MCP 令牌只能走专用路由：通用凭据接口拒绝 provider=mcp', async () => {
  const control = await startControl()
  try {
    const secret = 'a'.repeat(43)
    const put = await control.request({
      method: 'PUT', path: '/v1/account/credential', body: JSON.stringify({ provider: 'mcp', secret })
    })
    assert.equal(put.status, 400)
    assert.equal(put.payload.error, 'USE_MCP_TOKEN_ENDPOINT')
    const removed = await control.request({ method: 'DELETE', path: '/v1/account/credential?provider=mcp' })
    assert.equal(removed.status, 400)
    assert.equal(removed.payload.error, 'USE_MCP_TOKEN_ENDPOINT')
    assert.deepEqual(control.calls, [], '通用路由不该把 mcp 凭据交给 store')
  } finally {
    await control.close()
  }
})

test('专用路由：写入、读取、删除都按签名里的 owner 记账', async () => {
  const control = await startControl()
  try {
    const secret = 'b'.repeat(43)
    const short = await control.request({ method: 'PUT', path: '/v1/account/mcp-token', body: JSON.stringify({ secret: 'too-short' }) })
    assert.equal(short.status, 400)
    assert.equal(short.payload.error, 'MCP_SECRET_INVALID')
    const dotted = await control.request({ method: 'PUT', path: '/v1/account/mcp-token', body: JSON.stringify({ secret: 'x'.repeat(20) + '.' + 'y'.repeat(20) }) })
    assert.equal(dotted.status, 400, 'token 是点分格式，secret 里再出现点会把解析弄歧义')

    const put = await control.request({ method: 'PUT', path: '/v1/account/mcp-token', body: JSON.stringify({ secret }) })
    assert.equal(put.status, 200)
    assert.deepEqual(control.calls.at(-1), { action: 'put', ownerId: OWNER, provider: 'mcp', secret })

    const read = await control.request({ path: '/v1/account/mcp-secret' })
    assert.equal(read.status, 200)
    assert.equal(read.payload.configured, true)
    assert.equal(read.payload.secret, secret)

    // 别人的签名只能动自己的记录：owner 是签名算出来的，不是客户端说了算
    const otherRead = await control.request({ ownerId: OTHER, path: '/v1/account/mcp-secret' })
    assert.equal(otherRead.payload.configured, false)

    const removed = await control.request({ method: 'DELETE', path: '/v1/account/mcp-token' })
    assert.equal(removed.status, 200)
    assert.deepEqual(control.calls.at(-1), { action: 'delete', ownerId: OWNER, provider: 'mcp' })
    const after = await control.request({ path: '/v1/account/mcp-secret' })
    assert.equal(after.payload.configured, false)
    assert.equal(after.payload.secret, '')
  } finally {
    await control.close()
  }
})

test('未签名请求不得读写令牌', async () => {
  const control = await startControl()
  try {
    for (const [method, target] of [['GET', '/v1/account/mcp-secret'], ['PUT', '/v1/account/mcp-token'], ['DELETE', '/v1/account/mcp-token']]) {
      const response = await fetch(control.base + target, { method, redirect: 'manual' })
      assert.equal(response.status, 401, method + ' ' + target + ' 未签名必须 401')
    }
    assert.deepEqual(control.calls, [], '未签名请求根本不该碰到 store')
  } finally {
    await control.close()
  }
})

test('/v1/account/status 要带上 mcp 配置状态（否则界面上删不掉、也看不出已配置）', async () => {
  const control = await startControl(({ credentials }) => ({
    credentialStatus: async ownerId => Object.fromEntries(
      [...credentials.entries()]
        .filter(([key]) => key.startsWith(ownerId + ':'))
        .map(([key]) => [key.slice(ownerId.length + 1), { configured: true, last4: 'abcd', verifiedAt: null, updatedAt: null }])
    ),
    getPkuConnection: async () => null,
    resourceLimits: async () => ({})
  }))
  try {
    const before = await control.request({ path: '/v1/account/status' })
    assert.equal(before.payload.credentials.mcp.configured, false)
    await control.request({ method: 'PUT', path: '/v1/account/mcp-token', body: JSON.stringify({ secret: 'c'.repeat(43) }) })
    const after = await control.request({ path: '/v1/account/status' })
    assert.equal(after.payload.credentials.mcp.configured, true, '配过令牌后界面必须能看出来')
    assert.equal(after.payload.credentials.deepseek.configured, false)
  } finally {
    await control.close()
  }
})

test('迁移里的 CHECK 清单与代码里的 provider 清单必须一致', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'migrations')
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.sql'))
  const sql = files.map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
  const match = sql.match(/provider_credentials_provider_check[\s\S]*?check \(provider = any \(array\[([^\]]+)\]\)\)/)
  assert.ok(match, '迁移里应当有一条把 CHECK 扩成完整清单的语句')
  const inSql = [...match[1].matchAll(/'([^']+)'::text/g)].map(item => item[1]).sort()
  assert.deepEqual(inSql, [...CREDENTIAL_PROVIDERS].sort(), 'SQL 与代码的 provider 清单必须一致')
})
