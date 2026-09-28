/**
 * 发布完让 Cloudflare 边缘立刻丢掉缓存。
 *
 * 站点 HTML 在边缘上有一天的 TTL（缓存规则里定的），这是好事：读者在国内，
 * 走边缘比回源快得多，笔记页又不常变。但"改版 / 发新笔记之后要等一天才看到"
 * 就不合理了——所以发布成功后主动清一次，其余时间继续吃边缘缓存。
 *
 * 这里是"调用外部接口"的一层薄封装：失败一律不抛错。缓存没清掉顶多让读者晚一点
 * 看到新内容，绝不该让一次已经写好的发布失败。
 */

/** law-tech.dev 的 zone id：固定值，免得为了查它还要给令牌 Zone:Read 权限。 */
export const DEFAULT_ZONE_ID = 'd6a902cf29c624192d326a2abae68e74'

/** 令牌只从环境变量读：与其它凭据一样放在 ~/.course-worker/env（0600）。 */
export function cdnTokenFrom(env = process.env) {
  return String(env.CLOUDFLARE_PURGE_TOKEN || '').trim()
}

/** Cloudflare 单次 purge 最多 30 个 URL（超过会被拒），所以按批发。 */
export const PURGE_BATCH_SIZE = 30

/**
 * 站点文件 → 需要清的缓存 URL。
 *
 * 两个容易漏的点：
 *   1. **同一条路径有几种写法，边缘按 URL 分别缓存**。干净链接 /notes/课程/课次 与
 *      /notes/课程/课次.html 是两个键；/search/ 与 /search/index.html 也是。
 *      只清一种，读者换个写法进来还是旧页面。
 *   2. 只清**这次真的写过**的文件：purge_everything 会把整个 zone 清空，
 *      而 law-tech.dev 上还有别的服务——为了发一篇笔记把别人的缓存也踢掉是不礼貌的。
 */
export function cacheUrlsFor(files = [], origin = '') {
  const base = String(origin || '').replace(/\/+$/, '')
  const urls = new Set()
  for (const raw of files) {
    const file = String(raw || '').replace(/^\/+/, '')
    if (!file) continue
    if (file.endsWith('index.html')) {
      const dir = file.slice(0, -'index.html'.length) // '' | 'search/'
      urls.add(`${base}/${dir}`)
      urls.add(`${base}/${file}`)
      continue
    }
    urls.add(`${base}/${file}`)
    if (file.endsWith('.html')) urls.add(`${base}/${file.slice(0, -'.html'.length)}`)
  }
  return [...urls]
}

export async function purgeCloudflareCache({
  token,
  zoneId,
  urls = null,
  // 只有"我就是要清空整个 zone"时才用它：默认按 URL 定向清
  everything = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  env = process.env
} = {}) {
  const key = String(token || cdnTokenFrom(env)).trim()
  if (!key) return { ok: false, skipped: 'no_token' }
  if (typeof fetchImpl !== 'function') return { ok: false, skipped: 'no_fetch' }
  const list = Array.isArray(urls) ? urls.filter(Boolean) : []
  if (!everything && !list.length) return { ok: false, skipped: 'no_urls' }

  // zone id 是固定值：不按名字去查，就不必给令牌额外开 Zone:Read 权限
  const id = String(zoneId || env.CLOUDFLARE_ZONE_ID || DEFAULT_ZONE_ID).trim()
  if (!id) return { ok: false, skipped: 'no_zone' }

  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${id}/purge_cache`
  const batches = everything ? [{ purge_everything: true }] : []
  if (!everything) {
    for (let index = 0; index < list.length; index += PURGE_BATCH_SIZE) {
      batches.push({ files: list.slice(index, index + PURGE_BATCH_SIZE) })
    }
  }

  let purged = 0
  for (const body of batches) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.success === false) {
        return { ok: false, zoneId: id, status: response.status, errors: payload.errors || [], purged }
      }
      purged += body.files ? body.files.length : 0
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), purged }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: true, zoneId: id, purged, batches: batches.length, everything }
}
