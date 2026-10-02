/**
 * 教学网连不上时，程序该说什么。
 *
 * 教学网在**节假日只对校园网开放**——这是外部网络条件，程序绕不过去，也不该试着去绕。
 * 但"把话说清楚"是程序的事：与其把 `net::ERR_NAME_NOT_RESOLVED`、`Timeout 90000ms exceeded`
 * 这种一坨原始错误扔给使用者，不如直接告诉他要去连校园网或学校 VPN。
 *
 * 两条纪律：
 *   1. **只改网络类失败**。登录凭据错、页面结构变了这类问题不能被伪装成"网络不通"——
 *      那会让人白跑一趟 VPN。
 *   2. 原始错误仍然带着（放在括号里）：真要排查时它是最有用的线索。
 */
export const PKU_UNREACHABLE_HINT = '当前无法访问教学网，请连接校园网或学校 VPN'

/** 网络层失败的典型特征：Chromium 的 net::ERR_*、Node 的 DNS/连接错误、导航超时。 */
const NETWORK_SIGNS = [
  /net::ERR_/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /ERR_TIMED_OUT/i,
  /ERR_ADDRESS_UNREACHABLE/i,
  /ERR_PROXY_CONNECTION_FAILED/i,
  /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i,
  /fetch failed/i,
  /navigation (timeout|failed)/i,
  /timeout \d+ms exceeded/i
]

export function looksLikeNetworkFailure(error) {
  const text = error instanceof Error ? `${error.message || ''} ${error.code || ''}` : String(error || '')
  return NETWORK_SIGNS.some(pattern => pattern.test(text))
}

/**
 * 把教学网访问失败翻译成人话；不是网络问题就**原样返回**，不假装。
 * 返回 Error（带 code='PKU_UNREACHABLE' 与 cause），方便上层按类型处理。
 */
export function describePkuFailure(error, { action = '访问教学网' } = {}) {
  if (!looksLikeNetworkFailure(error)) return error
  const raw = error instanceof Error ? error.message : String(error || '')
  const wrapped = new Error(`${PKU_UNREACHABLE_HINT}（${action}失败：${raw}）`)
  wrapped.code = 'PKU_UNREACHABLE'
  wrapped.cause = error
  return wrapped
}
