import crypto from 'node:crypto'

/**
 * 两个付费 API 的余额与欠费处理。
 *
 * 为什么要有这个模块：2026-09-25 转写因为百炼欠费而失败，而失败信息里只有一串
 * 供应商错误码——用户看到的是"转写失败"，看不出是欠费，也不知道去哪儿充。
 * 付费环节的失败必须是**可行动**的：说清是哪家、什么事、去哪儿处理。
 *
 * DeepSeek：官方提供 GET /user/balance，用现有的 API key 就能查。
 * 阿里云百炼：余额属于账号维度，只能走 BSS OpenAPI（QueryAccountBalance），
 *   需要阿里云账号的 AccessKey（RAM 用户给 AliyunBSSReadOnlyAccess 即可），
 *   **不是** DashScope 的 API key。没配 AK/SK 时如实说"未配置"，不假装查不到就是零。
 */

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const ALIYUN_BSS_ENDPOINT = 'https://business.aliyuncs.com'
/** 低于这个数就提醒充值（元）。 */
export const LOW_BALANCE_THRESHOLD_CNY = 5
export const RECHARGE_URLS = {
  deepseek: 'https://platform.deepseek.com/top_up',
  dashscope: 'https://bailian.console.aliyun.com/?apiKey=1#/efm/apikey'
}

/** DeepSeek 余额：失败时抛错，由调用方决定是"报错"还是"忽略"。 */
export async function fetchDeepseekBalance({ apiKey, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!apiKey) throw new Error('未配置 COURSE_AI_API_KEY，无法查询 DeepSeek 余额')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败：HTTP ${response.status} ${text.slice(0, 200)}`)
    const data = JSON.parse(text)
    const info = (data.balance_infos || []).find(item => item.currency === 'CNY') || (data.balance_infos || [])[0] || {}
    return {
      provider: 'deepseek',
      available: Boolean(data.is_available),
      currency: info.currency || 'CNY',
      total: Number(info.total_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      rechargeUrl: RECHARGE_URLS.deepseek
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 阿里云 RPC 签名（1.0 版）：percentEncode 的规则与 encodeURIComponent 有三处差异。 */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

export function aliyunRpcSignature({ method = 'GET', params, accessKeySecret }) {
  const canonical = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`
  return crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64')
}

/**
 * 阿里云账号余额（BSS OpenAPI）。
 *
 * 需要 AccessKeyId / AccessKeySecret（RAM 用户授予 AliyunBSSReadOnlyAccess）。
 * 只配了 DashScope API key 是查不到的——这一点必须在界面上说清楚，
 * 否则用户会以为"配了 key 就该能看到余额"。
 */
export async function fetchAliyunBalance({
  accessKeyId, accessKeySecret, fetchImpl = fetch, timeoutMs = 15_000, now = new Date()
} = {}) {
  if (!accessKeyId || !accessKeySecret) {
    return {
      provider: 'aliyun',
      configured: false,
      reason: '未配置 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET（余额属账号维度，DashScope 的 API key 查不到）',
      rechargeUrl: RECHARGE_URLS.dashscope
    }
  }
  const params = {
    Action: 'QueryAccountBalance',
    Format: 'JSON',
    Version: '2017-12-14',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    AccessKeyId: accessKeyId
  }
  params.Signature = aliyunRpcSignature({ params, accessKeySecret })
  const url = `${ALIYUN_BSS_ENDPOINT}/?${new URLSearchParams(params).toString()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    const text = await response.text()
    if (!response.ok) throw new Error(`阿里云余额查询失败：HTTP ${response.status} ${text.slice(0, 200)}`)
    const data = JSON.parse(text)
    if (data.Code && data.Code !== '200') throw new Error(`阿里云余额查询失败：${data.Code} ${data.Message || ''}`.trim())
    const info = data.Data || {}
    return {
      provider: 'aliyun',
      configured: true,
      currency: 'CNY',
      available: Number(info.AvailableAmount ?? 0),
      credit: Number(info.CreditAmount ?? 0),
      cash: Number(info.AvailableCashAmount ?? 0),
      rechargeUrl: RECHARGE_URLS.dashscope
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把供应商错误码翻译成"人话 + 下一步"。
 *
 * 付费类故障（欠费、额度用尽、密钥失效）不该以"未知错误"的形式沉在日志里：
 * 它们需要用户动手，而用户动手的前提是知道找谁、去哪儿。
 */
const PROVIDER_PATTERNS = [
  {
    category: 'arrears',
    match: /arrearage|overdue|欠费|余额不足|insufficient\s*balance|account.*(suspend|frozen)/i,
    title: 'API 账户欠费或余额不足',
    hint: '充值后重跑即可；这一课次的进度已保存，不会从头再来。'
  },
  {
    category: 'quota',
    match: /quota|throttl|rate.?limit|额度|超出限制|Allocated quota/i,
    title: 'API 额度用尽或触发限流',
    hint: '额度恢复或提高限额后再跑；若是免费额度用尽，需要开通付费。'
  },
  {
    category: 'auth',
    match: /invalid.?api.?key|unauthor|signature|forbidden|401|403|密钥|鉴权/i,
    title: 'API 密钥无效或权限不足',
    hint: '检查 .course-worker/env 里的密钥是否过期、是否被删除。'
  }
]

export function classifyProviderIssue(message = '') {
  const text = String(message || '')
  if (!text) return null
  for (const pattern of PROVIDER_PATTERNS) {
    if (pattern.match.test(text)) {
      const provider = /dashscope|paraformer|aliyun|百炼|dashscope/i.test(text) ? 'aliyun'
        : /deepseek/i.test(text) ? 'deepseek' : 'unknown'
      return {
        category: pattern.category,
        provider,
        title: pattern.title,
        hint: pattern.hint,
        rechargeUrl: provider === 'aliyun' ? RECHARGE_URLS.dashscope : RECHARGE_URLS.deepseek,
        detail: text.slice(0, 400)
      }
    }
  }
  return null
}

/** 生成一条可行动的提醒文本（用于微信）。 */
export function renderBalanceWarning({ provider, total, available, threshold = LOW_BALANCE_THRESHOLD_CNY } = {}) {
  const amount = Number(total ?? available ?? 0)
  const name = provider === 'aliyun' ? '阿里云百炼（语音转写）' : 'DeepSeek（笔记写作）'
  return [
    `【余额提醒】${name}当前约 ¥${amount.toFixed(2)}，低于 ¥${threshold}。`,
    `充值入口：${provider === 'aliyun' ? RECHARGE_URLS.dashscope : RECHARGE_URLS.deepseek}`,
    '余额不足会让对应的阶段停下来（进度不会丢，充值后继续）。'
  ].join('\n')
}
