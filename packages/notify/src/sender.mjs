import { spawn } from 'node:child_process'

/**
 * 微信推送：把账本里的待发消息交给本机的 OpenClaw 通道发出去。
 *
 * 复用旧 relay 的发送机制（`openclaw message send --channel openclaw-weixin`），
 * 唯一改动是**队列来源**：旧实现每 30 秒轮询 Vercel 上的三个接口
 * （prepare / claim / ack），而 relay 与 Gateway 本来就同机，跨公网取队列纯属多余。
 * 现在直接读本机账本，活动部件更少，也不再有"Vercel 挂了推送就停"的耦合。
 *
 * 与旧实现保持一致的两点行为：
 *   1. 正文之外追加一行 Markdown 链接，正文里已含目标地址时不重复追加；
 *   2. 发送成功与否以进程退出码为准，externalId 取 openclaw 返回的 messageId。
 */

export const DEFAULT_PUBLIC_URL = 'https://course.law-tech.dev'

export function absoluteObjectUrl(value, publicSiteUrl = DEFAULT_PUBLIC_URL) {
  const objectUrl = String(value || '').trim()
  if (!objectUrl) return ''
  if (/^https?:\/\//i.test(objectUrl)) return objectUrl
  const base = String(publicSiteUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')
  return `${base}${objectUrl.startsWith('/') ? objectUrl : `/${objectUrl}`}`
}

export function deliveryLinkLabel(purpose = '') {
  if (purpose === 'course-brief') return '打开课程简报'
  if (purpose === 'course-note') return '打开课程笔记'
  if (purpose === 'daily-schedule') return '打开今日工作台'
  if (purpose === 'new-lesson') return '打开管理台传课件'
  if (purpose === 'provider-issue') return '去处理'
  if (purpose === 'balance-warning') return '去充值'
  if (purpose === 'needs-attention') return '打开管理台处理'
  return '打开课程笔记'
}

function bodyAlreadyContainsTarget(body = '', targetUrl = '') {
  if (!targetUrl) return true
  if (String(body).includes(targetUrl)) return true
  try {
    const target = new URL(targetUrl)
    // 注意：URL.pathname 返回的是百分号编码形式，而正文里通常是原始中文路径。
    // 旧实现只比对编码形式，导致中文 slug（我们这里全部是中文）的去重完全失效，
    // 通知里会出现两行重复链接。两种形式都要比。
    return [target.pathname, decodeURIComponent(target.pathname)]
      .some(candidate => candidate && String(body).includes(candidate))
  } catch {
    return false
  }
}

/** 正文 + 一行链接。正文已含目标地址时不再重复追加。 */
export function buildDeliveryMessage(delivery = {}, { publicSiteUrl = DEFAULT_PUBLIC_URL } = {}) {
  const body = String(delivery.body_text ?? delivery.bodyText ?? '').trim()
  const targetUrl = absoluteObjectUrl(delivery.object_url ?? delivery.objectUrl, publicSiteUrl)
  if (!targetUrl || bodyAlreadyContainsTarget(body, targetUrl)) return body
  // 正文与链接之间留一个空行：微信里链接单独成段更好点。
  // 旧实现写作 [body, '', link].filter(Boolean).join('\n')，那个空行被 filter 一并滤掉了，
  // 属于笔误——这里保留空行。
  return `${body}\n\n[${deliveryLinkLabel(delivery.purpose)}](${targetUrl})`
}

/**
 * OpenClaw 通道发送器。
 *
 * spawn 与二进制路径都可注入：测试不需要真的装 openclaw，服务器上则用绝对路径
 * （旧仓库踩过"CLI 找不到插件因为 PATH 不对"的坑，绝对路径可以避免）。
 */
export function createWechatSender({
  openclawBin = process.env.OPENCLAW_BIN || 'openclaw',
  target,
  spawnImpl = spawn,
  openclawHome = process.env.OPENCLAW_HOME || '',
  openclawStateDir = process.env.OPENCLAW_STATE_DIR || ''
} = {}) {
  if (!target) throw new Error('缺少推送目标：请设置 COURSE_WECHAT_TARGET')

  function run(args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }
      // 必须同时设置 HOME 与 STATE_DIR：只设 HOME 时 CLI 会报 "Unknown channel: openclaw-weixin"，
      // 因为插件与账号状态分别从这两个目录解析。relay 的 systemd 单元也是两个都设，
      // 实测对照：只设 HOME → Unknown channel；两个都设 → 正常返回 send 结果。
      if (openclawHome) env.OPENCLAW_HOME = openclawHome
      if (openclawHome || openclawStateDir) {
        env.OPENCLAW_STATE_DIR = openclawStateDir || openclawHome
      }
      const child = spawnImpl(openclawBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
      // 绝对路径：旧仓库踩过"CLI 找不到插件因为 PATH 不对"的坑
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => reject(new Error(`无法启动 ${openclawBin}：${error.message}`)))
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `${openclawBin} 退出码 ${code}`))
          return
        }
        let parsed = null
        try { parsed = JSON.parse(stdout) } catch {}
        resolve({ stdout: stdout.trim(), parsed })
      })
    })
  }

  return {
    target,
    openclawBin,

    async send(message) {
      const result = await run([
        'message', 'send',
        '--channel', 'openclaw-weixin',
        '--target', target,
        '--message', message,
        '--json'
      ])
      return {
        externalId: result.parsed?.messageId || result.parsed?.id || '',
        stdout: result.stdout
      }
    },

    /** 只验证通道与目标是否可用，不发送真实消息。 */
    async probe() {
      try {
        const result = await run(['message', 'send', '--channel', 'openclaw-weixin', '--target', target, '--message', 'course 通道探测', '--dry-run', '--json'])
        return { ok: true, detail: result.stdout || 'dry-run 成功' }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}

/**
 * 跑一轮投递：领取 → 发送 → 回执。
 *
 * 失败按退避重试，超过上限才标记 failed——微信侧偶发失败不该让一条通知永久消失，
 * 但也不能无限重试变成骚扰。
 */
export async function runDeliveryCycle({
  store,
  sender,
  workerId = 'course-notify',
  publicSiteUrl = DEFAULT_PUBLIC_URL,
  maxItems = 10,
  maxAttempts = 3,
  retryDelayMs = 5 * 60 * 1000,
  now,
  at = now,
  onEvent = () => {}
} = {}) {
  if (!store) throw new Error('投递需要一个账本')
  if (!sender) throw new Error('投递需要一个发送器')

  const results = []
  for (let index = 0; index < maxItems; index += 1) {
    const delivery = store.claimDelivery({ workerId, now: at })
    if (!delivery) break

    const message = buildDeliveryMessage(delivery, { publicSiteUrl })
    try {
      const sent = await sender.send(message)
      store.ackDelivery({ id: delivery.id, status: 'sent', externalId: sent.externalId, now: at })
      const event = { id: delivery.id, dedupeKey: delivery.dedupe_key, status: 'sent', externalId: sent.externalId, message }
      results.push(event)
      onEvent(event)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const exhausted = Number(delivery.attempts || 0) >= maxAttempts
      if (exhausted) {
        store.ackDelivery({ id: delivery.id, status: 'failed', error: detail, now: at })
      } else {
        store.retryDelivery({
          id: delivery.id,
          error: detail,
          nextAttemptAt: new Date(new Date(at ?? Date.now()).getTime() + retryDelayMs).toISOString()
        })
      }
      const event = { id: delivery.id, dedupeKey: delivery.dedupe_key, status: exhausted ? 'failed' : 'retry', error: detail, attempts: delivery.attempts }
      results.push(event)
      onEvent(event)
    }
  }

  return {
    results,
    sent: results.filter(item => item.status === 'sent').length,
    retried: results.filter(item => item.status === 'retry').length,
    failed: results.filter(item => item.status === 'failed').length
  }
}
/**
 * 备用推送通道。
 *
 * 为什么必须有：微信机器人这条通道**要求用户最近给机器人发过消息**——平台在每次来信时
 * 发一个 context_token，出站要原样带上。没有它，接口照样返回 messageId，看起来「发送成功」，
 * 微信端却收不到（实测：2026-09-26 之前发出的 21 条全部如此）。用户明确说「不要依赖我先给机器人发消息」，
 * 所以补一条不依赖会话的通道，主通道不可用时自动改走它。
 *
 * 各家都吃 HTTP，因此这里只做「把一段文字发出去」这一件事，不引任何 SDK：
 *   wecom / dingtalk  群机器人 webhook：{ msgtype: 'text', text: { content } }
 *   feishu            群机器人 webhook：{ msg_type: 'text', content: { text } }
 *   bark              GET <url>/<标题>/<正文>（iOS 推送）
 *   serverchan        POST https://sctapi.ftqq.com/<SendKey>.send（表单 title/desp）
 *   pushplus          POST https://www.pushplus.plus/send（JSON token/title/content）
 *   generic           自建接口：POST JSON { text }
 *
 * 正文里的 Markdown 链接在这些通道里不一定能点，所以统一把 [文字](url) 展成「文字 url」。
 */
export function plainTextForChannel(message = '') {
  return String(message || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 $2')
    .trim()
}

function firstLine(text = '', limit = 40) {
  const line = String(text || '').split('\n').map(item => item.trim()).filter(Boolean)[0] || '课程笔记'
  return line.length > limit ? line.slice(0, limit) + '…' : line
}

/** 每个通道导出成一个 { kind, send(message) } 的发送器；send 失败就抛错。 */
export function createFallbackSender({ kind, url = '', sendKey = '', token = '', fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const type = String(kind || '').trim().toLowerCase()
  if (!type) throw new Error('备用通道需要 COURSE_NOTIFY_FALLBACK')

  async function request(target, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(target, { ...options, signal: controller.signal })
      const text = await response.text()
      if (!response.ok) throw new Error(type + ' HTTP ' + response.status + '：' + text.slice(0, 200))
      return text
    } finally {
      clearTimeout(timer)
    }
  }
  const postJson = (target, body) => request(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  return {
    kind: type,
    configured: Boolean(
      (type === 'serverchan' && sendKey) ||
      (type === 'pushplus' && token) ||
      (['wecom', 'dingtalk', 'feishu', 'bark', 'generic'].includes(type) && url)
    ),

    async send(message) {
      const text = plainTextForChannel(message)
      if (type === 'wecom' || type === 'dingtalk') {
        return { externalId: type + ':', stdout: await postJson(url, { msgtype: 'text', text: { content: text } }) }
      }
      if (type === 'feishu') {
        return { externalId: 'feishu:', stdout: await postJson(url, { msg_type: 'text', content: { text } }) }
      }
      if (type === 'bark') {
        const base = String(url).replace(/\/+$/, '')
        const text2 = await request(base + '/' + encodeURIComponent(firstLine(text)) + '/' + encodeURIComponent(text))
        return { externalId: 'bark:', stdout: text2 }
      }
      if (type === 'serverchan') {
        const body = await request('https://sctapi.ftqq.com/' + encodeURIComponent(sendKey) + '.send', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ title: firstLine(text), desp: text }).toString()
        })
        let parsed = null
        try { parsed = JSON.parse(body) } catch {}
        if (parsed && Number(parsed.code) !== 0) throw new Error('serverchan：' + (parsed.message || body.slice(0, 120)))
        return { externalId: 'serverchan:', stdout: body }
      }
      if (type === 'pushplus') {
        const body = await postJson('https://www.pushplus.plus/send', { token, title: firstLine(text), content: text, template: 'txt' })
        let parsed = null
        try { parsed = JSON.parse(body) } catch {}
        if (parsed && Number(parsed.code) !== 200) throw new Error('pushplus：' + (parsed.msg || body.slice(0, 120)))
        return { externalId: 'pushplus:', stdout: body }
      }
      return { externalId: 'webhook:', stdout: await postJson(url, { text }) }
    }
  }
}

/**
 * 一条通知该走哪个通道。
 *
 * 规则很简单，但必须显式写下来：**主通道知道自己发不出去时，不要再试一次才改走备用**——
 * 那会留下一批「接口说成功、用户没收到」的假记录（之前 21 条消息的处境）。
 */
export function chooseChannel({ primaryUsable = true, fallback = null } = {}) {
  if (!primaryUsable && fallback && fallback.configured) return { channel: 'fallback', reason: '主通道会话不可用' }
  return { channel: 'primary', reason: '' }
}

/** 带备用的发送器：主通道不可用（或发送失败）时改走备用，返回值里标明走的哪条。 */
export function createResilientSender({ primary, fallback = null, primaryUsable = async () => true, onFallback = () => {} } = {}) {
  if (!primary) throw new Error('需要一个主通道')
  return {
    async send(message) {
      const usable = fallback && fallback.configured ? await primaryUsable() : true
      const decision = chooseChannel({ primaryUsable: usable, fallback })
      if (decision.channel === 'fallback') {
        onFallback(decision.reason)
        return { ...(await fallback.send(message)), channel: fallback.kind }
      }
      try {
        return { ...(await primary.send(message)), channel: 'wechat' }
      } catch (error) {
        if (!fallback || !fallback.configured) throw error
        onFallback('主通道发送失败：' + (error instanceof Error ? error.message : String(error)))
        return { ...(await fallback.send(message)), channel: fallback.kind }
      }
    },
    probe: () => primary.probe()
  }
}

