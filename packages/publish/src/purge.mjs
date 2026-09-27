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

export async function purgeCloudflareCache({
  token,
  zoneId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  env = process.env
} = {}) {
  const key = String(token || cdnTokenFrom(env)).trim()
  if (!key) return { ok: false, skipped: 'no_token' }
  if (typeof fetchImpl !== 'function') return { ok: false, skipped: 'no_fetch' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  try {
    // zone id 是固定值：不按名字去查，就不必给令牌额外开 Zone:Read 权限
    const id = String(zoneId || env.CLOUDFLARE_ZONE_ID || DEFAULT_ZONE_ID).trim()
    if (!id) return { ok: false, skipped: 'no_zone' }
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${id}/purge_cache`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ purge_everything: true }),
      signal: controller.signal
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.success === false) {
      return { ok: false, zoneId: id, status: response.status, errors: payload.errors || [] }
    }
    return { ok: true, zoneId: id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
