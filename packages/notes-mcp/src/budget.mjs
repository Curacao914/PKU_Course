import net from 'node:net'

/**
 * 请求预算：限流（每 IP 滑动窗口）、并发、墙钟时间、查询长度。
 *
 * 为什么单独一个模块：这些账在**两个入口**上必须是同一本——
 * POST /mcp（给 AI 客户端）与 GET /api/search（站内搜索页）。
 * 以前它们各算各的：MCP 有自己的 inFlight 计数，站点搜索完全没有任何闸门；
 * 一个脚本刷站内搜索能把 1.2G 内存的机器打到换页，而 MCP 那边看起来还很空闲。
 * 现在两个入口拿同一个 budget 实例，账才是真的共用。
 *
 * 三处实现上的取舍：
 *
 *  1. **归还只做一次**。以前 MCP 只在响应 finish 时做 inFlight -= 1：客户端中途断开
 *     （浏览器取消、代理超时、网络抖动）时 finish 可能根本不触发，槽位就永久漏了——
 *     漏满 maxConcurrent 之后接口对所有人返回 503，只能重启。现在 finish 与 close
 *     都挂上，槽位内部用 released 标志保证幂等，重复调不会多减。
 *  2. **不只是把计数减回去，还要真的把后台活停掉**。释放只是记账；正在跑的检索如果没人
 *     告诉它别算了，它会把 CPU（或远程请求）烧完，只是结果没人要。所以每个槽位带一个
 *     AbortSignal：客户端断开或超时就 abort，检索在记录之间、远程取正文处都会检查它。
 *     （同步打分不可抢占，检查点在记录之间——单条记录的打分是有界的，够用且诚实。）
 *  3. **X-Forwarded-For 只在直连方是可信代理时才认**。nginx 在本机，它会把真实客户端
 *     地址**追加**到 XFF 末尾；那么从右往左第一个不可信的地址就是真客户端，客户端自己
 *     伪造的前缀影响不了它。直连方不可信时，整条 XFF 一律忽略，只看 socket 地址——
 *     否则任何人都能手编 XFF 换身份，限流等于没有。
 */

/** 查询串长度上限（字符）。超长查询会炸出成千上万个 n-gram：既是成本也是风险。 */
export const DEFAULT_MAX_QUERY_CHARS = 200

export const DEFAULT_BUDGET = Object.freeze({
  windowMs: 60_000,
  // 每 IP 每窗口的请求数。/api/search 与 /mcp 共用同一本账，所以给得比单人舒服更宽。
  max: 300,
  // 全局（不是每 IP）同时在处理的请求数：这台机器只有 1.2G 内存，闸门要按机器算。
  maxConcurrent: 8,
  // 单次请求的墙钟预算：到点就 abort 后台工作并回 504，而不是让连接一直挂着。
  timeoutMs: 20_000,
  maxQueryChars: DEFAULT_MAX_QUERY_CHARS
})

/** 把地址写成规范形式：去端口、去 IPv6 方括号与 zone、IPv4-mapped 还原成 IPv4。 */
export function normalizeIp(value) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  text = text.split('%')[0]
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end > 0) text = text.slice(1, end)
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) {
    text = text.slice(0, text.indexOf(':'))
  }
  // 双栈监听时 Node 会给 ::ffff:127.0.0.1：它和 127.0.0.1 是同一个对端
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) text = mapped[1]
  return net.isIP(text) ? text.toLowerCase() : ''
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((sum, part) => (sum * 256) + Number(part), 0)
}

function ipv4InCidr(ip, base, bits) {
  if (!(bits >= 0 && bits <= 32)) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)
}

/**
 * 这个地址在不在可信代理名单里。名单元素可以是单个地址，也可以是 IPv4 的 CIDR
 * （如 10.0.0.0/8；IPv6 只支持整地址——够用，也不容易配错）。
 */
export function ipInList(ip, list = []) {
  const target = normalizeIp(ip)
  if (!target) return false
  for (const entry of list || []) {
    const raw = String(entry ?? '').trim().toLowerCase()
    if (!raw) continue
    const slash = raw.indexOf('/')
    if (slash < 0) {
      if (normalizeIp(raw) === target) return true
      continue
    }
    const base = normalizeIp(raw.slice(0, slash))
    const bits = Number(raw.slice(slash + 1))
    if (!base || !Number.isInteger(bits)) continue
    if (net.isIP(base) === 4 && net.isIP(target) === 4 && ipv4InCidr(target, base, bits)) return true
  }
  return false
}

/**
 * 从右往左取第一个**不可信**的地址。这是 XFF 的标准读法：
 * 每一跳都会把自己看到的对端追加到末尾，所以最右边的那些条目才是可信代理写的。
 */
function rightmostUntrusted(value, trustedProxies) {
  const parts = String(value ?? '').split(',').map(normalizeIp).filter(Boolean)
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (!ipInList(parts[index], trustedProxies)) return parts[index]
  }
  return ''
}

/**
 * 这次请求该按哪个客户端地址记账。
 *
 * 直连方（socket 对端）不在可信名单里 → 只认它，任何转发头都不看。
 * 直连方可信 → 先看配置的 clientIpHeader（Cloudflare 的 CF-Connecting-IP 这类单值头），
 * 再退回 XFF 的最右不可信跳；两者都解析不出合法地址就用直连地址。
 */
export function clientAddress(req, { trustedProxies = [], clientIpHeader = '' } = {}) {
  const peer = normalizeIp(req?.socket?.remoteAddress)
  if (!peer) return 'unknown'
  if (!ipInList(peer, trustedProxies)) return peer
  const header = String(clientIpHeader || '').trim().toLowerCase()
  if (header) {
    const picked = rightmostUntrusted(req?.headers?.[header], trustedProxies)
    if (picked) return picked
  }
  return rightmostUntrusted(req?.headers?.['x-forwarded-for'], trustedProxies) || peer
}

/** 查询串超长时的说明（没超长返回空串）—— /api/search 与 MCP 工具共用同一句话。 */
export function queryLengthProblem(text, limit = DEFAULT_MAX_QUERY_CHARS) {
  const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : 0
  if (!max) return ''
  const length = [...String(text ?? '')].length
  if (length <= max) return ''
  return '查询过长：' + length + ' 字，上限 ' + max + ' 字。请给出更具体的术语、法条或人名。'
}

const positive = (value, fallback) => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback
}
const nonNegative = (value, fallback) => {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback
}

export function createRequestBudget({
  windowMs,
  max,
  maxConcurrent,
  timeoutMs,
  maxQueryChars,
  trustedProxies = [],
  clientIpHeader = '',
  now = () => Date.now()
} = {}) {
  const limits = {
    windowMs: positive(windowMs, DEFAULT_BUDGET.windowMs),
    // max = 0 表示不限流（与旧行为一致：rateLimit.max 为 0 等于关掉）
    max: nonNegative(max, DEFAULT_BUDGET.max),
    maxConcurrent: positive(maxConcurrent, DEFAULT_BUDGET.maxConcurrent),
    // timeoutMs = 0 表示不限时
    timeoutMs: nonNegative(timeoutMs, DEFAULT_BUDGET.timeoutMs),
    maxQueryChars: nonNegative(maxQueryChars, DEFAULT_BUDGET.maxQueryChars)
  }
  const proxies = [...(trustedProxies || [])]
  const buckets = new Map()
  const counters = { acquired: 0, released: 0, rateLimited: 0, busy: 0, timedOut: 0, clientGone: 0 }
  let inFlight = 0

  function rateAllows(key, at) {
    if (!limits.max) return true
    const entry = buckets.get(key) || { start: at, count: 0 }
    if (at - entry.start >= limits.windowMs) { entry.start = at; entry.count = 0 }
    entry.count += 1
    buckets.set(key, entry)
    // 顺手清理过期桶，避免长期运行后 Map 无限增长（键来自客户端地址，不能不信）
    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) if (at - value.start >= limits.windowMs) buckets.delete(bucketKey)
    }
    return entry.count <= limits.max
  }

  function createSlot({ key, label }) {
    const controller = new AbortController()
    let released = false
    let timedOut = false
    let clientGone = false
    let timeoutResolve = () => {}
    let goneResolve = () => {}
    const whenTimedOut = new Promise(resolve => { timeoutResolve = resolve })
    const whenClientGone = new Promise(resolve => { goneResolve = resolve })
    const timer = limits.timeoutMs > 0
      ? setTimeout(() => {
        if (released || timedOut) return
        timedOut = true
        counters.timedOut += 1
        controller.abort(new Error('请求超时'))
        timeoutResolve(true)
      }, limits.timeoutMs)
      : null
    timer?.unref?.()

    return {
      ok: true,
      key,
      label,
      signal: controller.signal,
      whenTimedOut,
      whenClientGone,
      get timedOut() { return timedOut },
      get clientGone() { return clientGone },
      get released() { return released },
      /** 客户端断开：abort 后台工作（幂等）。 */
      cancel(reason = 'client_gone') {
        if (clientGone) return false
        clientGone = true
        counters.clientGone += 1
        controller.abort(new Error(String(reason)))
        goneResolve(true)
        return true
      },
      /** 归还并发槽位：幂等，重复调用只生效一次（finish 与 close 都会调它）。 */
      release() {
        if (released) return false
        released = true
        if (timer) clearTimeout(timer)
        inFlight = Math.max(0, inFlight - 1)
        counters.released += 1
        return true
      }
    }
  }

  /** 取一个请求槽位；失败时返回可直接用的 HTTP 语义（429 / 503）。 */
  function acquire({ key = 'unknown', label = '' } = {}) {
    const at = now()
    if (!rateAllows(key, at)) {
      counters.rateLimited += 1
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        retryAfter: Math.max(1, Math.round(limits.windowMs / 1000)),
        message: '请求过于频繁（每 ' + Math.round(limits.windowMs / 1000) + ' 秒最多 ' + limits.max + ' 次），请稍后再试。'
      }
    }
    if (inFlight >= limits.maxConcurrent) {
      counters.busy += 1
      return {
        ok: false,
        status: 503,
        code: 'busy',
        retryAfter: 1,
        message: '同时处理的请求过多（上限 ' + limits.maxConcurrent + '），请稍后再试。'
      }
    }
    inFlight += 1
    counters.acquired += 1
    return createSlot({ key, label })
  }

  return {
    limits,
    acquire,
    addressOf: req => clientAddress(req, { trustedProxies: proxies, clientIpHeader }),
    queryProblem: text => queryLengthProblem(text, limits.maxQueryChars),
    stats: () => ({ ...counters, inFlight, maxConcurrent: limits.maxConcurrent, buckets: buckets.size, limits: { ...limits } })
  }
}

/**
 * 把一次 HTTP 请求的生命周期挂到槽位上：正常结束归还、客户端断开则取消并归还。
 *
 * 两个入口（/mcp、/api/search）都用它，归还与取消的语义就只有一份实现。
 * race(work) 让调用方在结果 / 超时 / 客户端断开三者中取最先到的那个：
 * 超时后不必等后台工作自己收尾（它已经被 abort 了，会在下一个检查点退出），
 * 否则连接会一直挂到工作跑完，超时预算就形同虚设。
 */
export function bindRequestLifecycle(req, res, slot) {
  let settled = false
  const settle = () => {
    if (settled) return false
    settled = true
    slot.release()
    return true
  }
  res.once('finish', settle)
  res.once('close', () => {
    // close 在正常结束后也会来一次：writableFinished 为真就只是已结束，不再取消
    if (!res.writableFinished) slot.cancel('client_gone')
    settle()
  })
  req.once('aborted', () => slot.cancel('client_gone'))

  return {
    settle,
    /** 响应是否还能写（客户端没走、也没写完）。 */
    canWrite: () => !res.writableEnded && !res.destroyed && !slot.clientGone,
    race: work => Promise.race([
      Promise.resolve(work).then(result => ({ kind: 'result', result })),
      slot.whenTimedOut.then(() => ({ kind: 'timeout' })),
      slot.whenClientGone.then(() => ({ kind: 'gone' }))
    ])
  }
}
