import crypto from 'node:crypto'

const SENSITIVE_PATTERN = /(secret|token|cookie|authorization|session|credential)/i
const USER_POSITIVE = /(user|username|user_name|account|login|userid|uid|学号|账号|用户名)/i
const USER_NEGATIVE = /(password|passwd|pwd|otp|sms|rand|captcha|verify|verification|code|验证码|短信)/i
const PASSWORD_POSITIVE = /(password|passwd|pwd|pass_word|密码)/i

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

export function templatePath(pathname) {
  return String(pathname || '/')
    .split('/')
    .map(part => {
      if (!part) return part
      if (/^\d{3,}$/.test(part)) return ':number'
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ':uuid'
      if (/^[A-Za-z0-9_-]{24,}$/.test(part)) return ':token'
      return part
    })
    .join('/')
}

export function describeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    return {
      origin: parsed.origin,
      pathTemplate: templatePath(parsed.pathname),
      queryKeys: [...new Set([...parsed.searchParams.keys()])].sort()
    }
  } catch {
    return { origin: 'invalid', pathTemplate: '/invalid', queryKeys: [] }
  }
}

function combined(control) {
  return [
    control.id,
    control.name,
    control.autocomplete,
    control.placeholder,
    control.ariaLabel,
    control.label,
    control.type
  ].filter(Boolean).join(' ')
}

export function usernameScore(control) {
  if (!control || !control.visible || control.disabled) return -1000
  const type = String(control.type || 'text').toLowerCase()
  if (['hidden', 'password', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return -1000
  const text = combined(control)
  if (USER_NEGATIVE.test(text)) return -500

  let score = 0
  if (String(control.autocomplete || '').toLowerCase() === 'username') score += 100
  if (USER_POSITIVE.test(String(control.id || ''))) score += 50
  if (USER_POSITIVE.test(String(control.name || ''))) score += 50
  if (USER_POSITIVE.test(String(control.placeholder || ''))) score += 30
  if (USER_POSITIVE.test(String(control.ariaLabel || ''))) score += 30
  if (USER_POSITIVE.test(String(control.label || ''))) score += 30
  if (['text', 'email', 'tel', ''].includes(type)) score += 10
  return score
}

export function passwordScore(control) {
  if (!control || !control.visible || control.disabled) return -1000
  const type = String(control.type || '').toLowerCase()
  const text = combined(control)
  let score = 0
  if (type === 'password') score += 100
  if (String(control.autocomplete || '').toLowerCase() === 'current-password') score += 80
  if (PASSWORD_POSITIVE.test(String(control.id || ''))) score += 40
  if (PASSWORD_POSITIVE.test(String(control.name || ''))) score += 40
  if (PASSWORD_POSITIVE.test(String(control.placeholder || ''))) score += 25
  if (PASSWORD_POSITIVE.test(String(control.ariaLabel || ''))) score += 25
  if (PASSWORD_POSITIVE.test(String(control.label || ''))) score += 25
  if (/(otp|sms|rand|captcha|verify|code|验证码|短信)/i.test(text)) score -= 200
  return score
}

export function chooseLoginControls(controls) {
  const indexed = (controls || []).map((control, index) => ({
    ...control,
    index,
    usernameScore: usernameScore(control),
    passwordScore: passwordScore(control)
  }))
  const username = [...indexed].sort((a, b) => b.usernameScore - a.usernameScore)[0]
  const password = [...indexed].sort((a, b) => b.passwordScore - a.passwordScore)[0]
  return {
    username: username?.usernameScore > 0 ? username : null,
    password: password?.passwordScore > 0 ? password : null
  }
}

export function sanitizeControl(control) {
  return {
    index: Number(control.index ?? -1),
    tag: String(control.tag || '').toLowerCase(),
    type: String(control.type || '').toLowerCase(),
    id: safeText(control.id),
    name: safeText(control.name),
    autocomplete: safeText(control.autocomplete),
    placeholder: safeText(control.placeholder),
    ariaLabel: safeText(control.ariaLabel),
    label: safeText(control.label),
    visible: Boolean(control.visible),
    disabled: Boolean(control.disabled)
  }
}

function safeText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (SENSITIVE_PATTERN.test(text)) {
    return `<REDACTED_META:${sha256(text).slice(0, 12)}>`
  }
  return text
}

export function assertNoInputValues(value) {
  const serialized = JSON.stringify(value)
  if (/"value"\s*:/i.test(serialized)) throw new Error('Report contains input value field')
  if (/(authorization|cookie|bearer|pku_username|pku_password)/i.test(serialized)) {
    throw new Error('Report contains credentials')
  }
  return true
}
