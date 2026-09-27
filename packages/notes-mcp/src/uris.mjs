/**
 * 资源 URI。自定义 scheme 用 notes://（规范允许，见 RFC 3986）。
 *
 * 课程名与 slug 一律整段 encodeURIComponent：slug 里本来就有斜杠
 * （notes/国际法学/第一课），不编码的话它会被解析成多级路径，谁也说不清哪一段是 slug。
 * 读取时反过来整段 decode，客户端若没编码（手输的 URI）也能用。
 */

export const COURSES_URI = 'notes://courses'

export const courseUri = course => `notes://course/${encodeURIComponent(String(course ?? ''))}`
export const noteUri = slug => `notes://note/${encodeURIComponent(String(slug ?? ''))}`
export const termsUri = course => `notes://terms/${encodeURIComponent(String(course ?? ''))}`

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 解析 notes:// URI；不认识就返回 null（调用方转成 -32002）。 */
export function parseResourceUri(uri) {
  const text = String(uri ?? '').trim()
  if (!text.startsWith('notes://')) return null
  const rest = text.slice('notes://'.length).replace(/^\/+/, '')
  if (rest === 'courses' || rest === 'courses/') return { kind: 'courses', value: '' }
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const head = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  const value = decode(tail).replace(/^\/+/, '').trim()
  if (!value) return null
  if (head === 'course' || head === 'note' || head === 'terms') return { kind: head, value }
  return null
}
