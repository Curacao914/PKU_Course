import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 微信机器人的会话状态。
 *
 * 这条通道的规矩：**用户每给机器人发一次消息，平台就给一个 context_token**，
 * 出站消息必须原样带上。没有它，接口照常返回 messageId（看起来成功了），
 * 微信端却收不到。所以"能不能推"这件事是可以判断的，不该靠猜。
 *
 * @returns {{ ok: boolean, lastInboundAt?: string, ageMinutes?: number, source?: string, reason?: string }}
 */
export function wechatSessionState({ stateDir = '', home = '', now = Date.now() } = {}) {
  const explicit = [stateDir, home].filter(Boolean)
  const bases = explicit.length
    ? explicit
    : [path.join(os.homedir(), '.openclaw-candidate'), path.join(os.homedir(), '.openclaw')]
  for (const base of bases) {
    const dir = path.join(base, 'openclaw-weixin', 'accounts')
    if (!fs.existsSync(dir)) continue
    let newest = 0
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.context-tokens.json')) continue
        newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs)
      }
    } catch {
      continue
    }
    if (!newest) return { ok: false, source: dir, reason: '机器人还没收到过你的消息' }
    return {
      ok: true,
      source: dir,
      lastInboundAt: new Date(newest).toISOString(),
      ageMinutes: Math.max(0, Math.round((now - newest) / 60000))
    }
  }
  return { ok: false, reason: '没有找到微信通道状态目录' }
}

/** 会话是否"还算新鲜"：超过这个时间就认为平台已经不再接受这条会话。 */
export const WECHAT_SESSION_MAX_AGE_MINUTES = 12 * 60
