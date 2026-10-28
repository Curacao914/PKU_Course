import { ProxyAgent } from 'undici'

/**
 * Explicitly opt acquisition into a temporary HTTP CONNECT proxy.
 *
 * Only the loopback endpoint is accepted: a remote proxy or an embedded
 * credential would make browser sessions and course replay URLs available
 * outside the user's trusted devices.
 *
 * This setting must NEVER be applied to the whole worker's global dispatcher:
 * ASR, LLMs, Supabase, and website traffic must remain on their existing route.
 */
export function resolveAcquisitionProxy(env = process.env) {
  const value = String(env.COURSE_ACQUISITION_HTTP_PROXY || '').trim()
  if (!value) return ''
  let url
  try { url = new URL(value) } catch { throw new Error('课程采集代理地址不是有效 URL') }
  if (url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || !url.port ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('课程采集代理仅允许无认证的 HTTP 回环地址和明确端口')
  }
  return url.origin
}

let cachedProxy = ''
let cachedDispatcher = null

export function acquisitionDispatcher(env = process.env) {
  const target = resolveAcquisitionProxy(env)
  if (!target) return undefined
  if (cachedDispatcher && cachedProxy === target) return cachedDispatcher
  // An Agent does not modify the process-global fetch dispatcher.
  // No direct-network fallback is permitted if the tunnel is offline.
  cachedProxy = target
  cachedDispatcher = new ProxyAgent(target)
  return cachedDispatcher
}
