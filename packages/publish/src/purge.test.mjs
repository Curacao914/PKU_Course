import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ZONE_ID, PURGE_BATCH_SIZE, cacheUrlsFor, cdnTokenFrom, purgeCloudflareCache } from './purge.mjs'

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

const ORIGIN = 'https://course.law-tech.dev'

test('定向清理：只清这次真的写过的页面，不再清空整个 zone', async () => {
  const { impl, calls } = fakeFetch()
  const urls = cacheUrlsFor(['notes/商法概论/2026-09-13第2-4节.html', 'md/商法概论/2026-09-13第2-4节.md'], ORIGIN)
  const result = await purgeCloudflareCache({ token: 'cfut_test', urls, fetchImpl: impl })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1, 'zone id 是固定值，不该为了查它多打一次接口')
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/zones/${DEFAULT_ZONE_ID}/purge_cache`)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.authorization, 'Bearer cfut_test')
  const body = JSON.parse(calls[0].options.body)
  assert.ok(Array.isArray(body.files), '定向清理用的是 files，不是 purge_everything')
  assert.equal('purge_everything' in body, false, 'law-tech.dev 上还有别的服务，不能顺手全清')
  assert.ok(body.files.includes(`${ORIGIN}/notes/商法概论/2026-09-13第2-4节.html`))
  assert.equal(result.purged, body.files.length)
})

test('干净链接与 .html 是两个缓存键，都要清；index.html 还要清目录形式', () => {
  const urls = cacheUrlsFor(['notes/刑法分论/第10-12节.html', 'search/index.html', 'index.html'], ORIGIN)
  assert.ok(urls.includes(`${ORIGIN}/notes/刑法分论/第10-12节.html`))
  assert.ok(urls.includes(`${ORIGIN}/notes/刑法分论/第10-12节`), '干净链接是另一个键')
  assert.ok(urls.includes(`${ORIGIN}/search/`))
  assert.ok(urls.includes(`${ORIGIN}/search/index.html`))
  assert.ok(urls.includes(`${ORIGIN}/`), '首页的目录形式')
  assert.ok(urls.includes(`${ORIGIN}/index.html`))
  assert.deepEqual(cacheUrlsFor([], ORIGIN), [])
  assert.deepEqual(cacheUrlsFor(['/leading-slash.html'], ''), ['/leading-slash.html', '/leading-slash'])
})

test('一次超过 30 个 URL 会分批（Cloudflare 单次上限）', async () => {
  const { impl, calls } = fakeFetch()
  const files = Array.from({ length: 40 }, (_, index) => `notes/课/${index}.html`)
  const urls = cacheUrlsFor(files, ORIGIN)
  assert.ok(urls.length > PURGE_BATCH_SIZE)
  const result = await purgeCloudflareCache({ token: 'cfut_test', urls, fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(calls.length, Math.ceil(urls.length / PURGE_BATCH_SIZE))
  for (const call of calls) {
    const body = JSON.parse(call.options.body)
    assert.ok(body.files.length <= PURGE_BATCH_SIZE)
  }
  assert.equal(result.purged, urls.length)
})

test('purge_everything 只在显式要求时才用', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: 'cfut_test', everything: true, fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(calls[0].options.body), { purge_everything: true })
})

test('没有 URL 可清时什么都不做，也不会误清整站', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: 'cfut_test', fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_urls')
  assert.equal(calls.length, 0)
})

test('without a token the publish still succeeds, just without purging', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: '', env: {}, urls: ['https://x/a'], fetchImpl: impl })
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
  const result = await purgeCloudflareCache({ token: 'cfut_bad', urls: ['https://x/a'], fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.match(result.errors[0].message, /Authentication error/)

  const boom = await purgeCloudflareCache({ token: 'cfut_x', urls: ['https://x/a'], fetchImpl: async () => { throw new Error('网络断了') } })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /网络断了/)
})

test('an unknown zone is reported rather than guessed', async () => {
  const { impl, calls } = fakeFetch()
  const result = await purgeCloudflareCache({ token: 'cfut_x', zoneId: ' ', urls: ['https://x/a'], env: { CLOUDFLARE_ZONE_ID: '' }, fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_zone')
  assert.equal(calls.length, 0)
})
