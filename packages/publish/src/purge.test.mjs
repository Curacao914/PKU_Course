import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ZONE_ID, cdnTokenFrom, purgeCloudflareCache } from './purge.mjs'

/** 假的 fetch：记下请求，按脚本返回，绝不真的打 Cloudflare。 */
function fakeFetch({ ok = true, status = 200, payload = { success: true, result: { id: DEFAULT_ZONE_ID } }, onCall } = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url, options })
    if (onCall) onCall(url, options)
    return { ok, status, json: async () => payload }
  }
  return { impl, calls }
}

test('a publish purges the CDN so the new pages show up immediately', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: 'cfut_test', fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(result.zoneId, DEFAULT_ZONE_ID)
  assert.equal(calls.length, 1, 'zone id 是固定值，不该为了查它多打一次接口')
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/zones/${DEFAULT_ZONE_ID}/purge_cache`)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.authorization, 'Bearer cfut_test')
  assert.deepEqual(JSON.parse(calls[0].options.body), { purge_everything: true })
})

test('without a token the publish still succeeds, just without purging', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: '', env: {}, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_token')
  assert.equal(calls.length, 0, '没令牌就不该发请求')
})

test('the token comes from the environment, never from the repo', () => {
  assert.equal(cdnTokenFrom({ CLOUDFLARE_PURGE_TOKEN: ' cfut_x ' }), 'cfut_x')
  assert.equal(cdnTokenFrom({}), '')
})

test('a Cloudflare error is reported instead of thrown', async () => {
  const { impl } = fakeFetch({ ok: false, status: 403, payload: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } })
  const result = await purgeCloudflareCache({ token: 'cfut_bad', fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.match(result.errors[0].message, /Authentication error/)

  const boom = await purgeCloudflareCache({ token: 'cfut_x', fetchImpl: async () => { throw new Error('网络断了') } })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /网络断了/)
})

test('an unknown zone is reported rather than guessed', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: 'cfut_x', zoneId: ' ', env: { CLOUDFLARE_ZONE_ID: '' }, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_zone')
  assert.equal(calls.length, 0)
})
