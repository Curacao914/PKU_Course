import net from 'node:net'

export function isDirectFirst(env = process.env) {
  return env.COURSE_ACQUISITION_DIRECT_FIRST === '1'
}

export function shouldRetryThroughVpn(error) {
  const code = String(error?.code || '')
  // Never fetch a different lesson, retry bad credentials, or discard a
  // partially downloaded playlist merely because network access changed.
  if (/COURSE_REPLAY_NOT_FOUND|AUTH_EXPIRED|ACQUISITION_VPN_UNAVAILABLE/.test(code)) return false
  const message = String(error?.message || error || '')
  if (/账号|密码|认证失败|登录失败|验证码|无效会话|指纹|校验|清单已变化|无法定位目标回放|无法定位.*课程/.test(message)) return false
  return /M3U8|HLS|playlist|HTTP (401|403|404|429|5\d\d)|timeout|timed out|net::ERR_|ECONN|ENOTFOUND|EHOST|ETIMEDOUT|fetch failed|AbortError|媒体请求多次失败|socket|连接断开/i.test(message)
}

/**
 * A listening reverse-forwarded port is not proof that its Mac-side campus
 * proxy can reach PKU. Probe the actual CONNECT handshake before launching
 * another authenticated Chromium session through the tunnel.
 */
export function waitForLoopbackProxy(url, timeoutMs = 5000) {
  const { hostname, port } = new URL(url)
  return new Promise(resolve => {
    const socket = net.connect({ host: hostname.replace(/^\[|\]$/g, ''), port: Number(port) })
    let finished = false
    let received = ''
    const finish = ok => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(
        'CONNECT course.pku.edu.cn:443 HTTP/1.1\r\n' +
        'Host: course.pku.edu.cn:443\r\n' +
        'Proxy-Connection: close\r\n\r\n'
      )
    })
    socket.on('data', chunk => {
      received += chunk.toString('latin1')
      if (received.length > 2048) return finish(false)
      const firstLineEnd = received.indexOf('\r\n')
      if (firstLineEnd < 0) return
      const status = received.slice(0, firstLineEnd)
      finish(/^HTTP\/1\.[01] 200(?:\s|$)/.test(status))
    })
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}
