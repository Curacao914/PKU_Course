import net from 'node:net'

export function isDirectFirst(env = process.env) {
  return env.COURSE_ACQUISITION_DIRECT_FIRST === '1'
}

export function shouldRetryThroughVpn(error) {
  const code = String(error?.code || '')
  // Never fetch a different lesson, retry bad credentials, or discard a
  // partially downloaded playlist merely because network access changed.
  if (/COURSE_REPLAY_NOT_FOUND|COURSE_REPLAY_NOT_FOUND|AUTH_EXPIRED|ACQUISITION_VPN_UNAVAILABLE/.test(code)) return false
  const message = String(error?.message || error || '')
  if (/账号|密码|认证失败|登录失败|验证码|无效会话|指纹|校验|清单已变化|无法定位目标回放|无法定位.*课程/.test(message)) return false
  return /M3U8|HLS|playlist|HTTP (401|403|404|429|5\d\d)|timeout|timed out|net::ERR_|ECONN|ENOTFOUND|EHOST|ETIMEDOUT|fetch failed|AbortError|媒体请求多次失败|socket|连接断开/i.test(message)
}

export function waitForLoopbackProxy(url, timeoutMs = 1500) {
  const { hostname, port } = new URL(url)
  return new Promise(resolve => {
    const socket = net.connect({host:hostname.replace(/^\[|\]$/g,''),port:Number(port)})
    const finish = ok => {socket.destroy();resolve(ok)}
    socket.setTimeout(timeoutMs)
    socket.once('connect',()=>finish(true))
    socket.once('error',()=>finish(false))
    socket.once('timeout',()=>finish(false))
  })
}
