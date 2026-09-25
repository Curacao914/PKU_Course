import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 管理台登录：密码 + 主令牌。
 *
 * 为什么不是"一个随机 token 写在 env 里"：那串 64 位十六进制既记不住、也不能改，
 * 用户只能把它抄到浏览器里。改成自己设的密码之后，「改密码」变成管理台里的一件事，
 * 而**找回**则靠服务器上的主令牌——两条路互为兜底，谁都锁不死。
 *
 * 存储：密码只存 scrypt 哈希（salt 随机、参数写进文件），明文不落盘、不进日志。
 * 主令牌仍然从环境变量 COURSE_ADMIN_TOKEN 读，它同时是"忘记密码时的万能钥匙"。
 */

const FILE_NAME = 'admin-password.json'
const KEY_LENGTH = 64
const SCRYPT = { N: 16384, r: 8, p: 1 }

export function passwordFile(scratchRoot) {
  return path.join(path.resolve(scratchRoot), FILE_NAME)
}

export function hashPassword(password, { salt = crypto.randomBytes(16).toString('hex') } = {}) {
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH, SCRYPT).toString('hex')
  return { scheme: 'scrypt', salt, hash, keylen: KEY_LENGTH, params: { ...SCRYPT }, updatedAt: new Date().toISOString() }
}

/** 定长比较，避免用 === 泄露前缀信息。 */
function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyPassword(password, record) {
  if (!record || record.scheme !== 'scrypt' || !record.salt || !record.hash) return false
  try {
    const candidate = crypto.scryptSync(String(password), record.salt, record.keylen || KEY_LENGTH, record.params || SCRYPT)
    return timingSafeEqual(candidate.toString('hex'), record.hash)
  } catch {
    return false
  }
}

export function readPasswordRecord(scratchRoot) {
  const file = passwordFile(scratchRoot)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 写入新密码（只写哈希）。返回写入的文件路径。 */
export function writePassword(scratchRoot, password) {
  const file = passwordFile(scratchRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const record = hashPassword(password)
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return file
}

/** 清掉密码：之后只剩主令牌能进（找回路径的最后一招）。 */
export function clearPassword(scratchRoot) {
  const file = passwordFile(scratchRoot)
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true })
    return true
  }
  return false
}

/** 密码强度下限：太短或就是那几个常见词的，直接拒绝并说清楚。 */
const WEAK = new Set(['123456', '12345678', 'password', 'admin', 'admin123', '000000', '111111', 'qwerty', 'course'])

export function validatePassword(password) {
  const text = String(password ?? '')
  if (text.length < 8) return '密码至少 8 位'
  if (text.length > 200) return '密码太长了'
  if (WEAK.has(text.toLowerCase())) return '这个密码太好猜了，换一个'
  if (/^(.)\1+$/.test(text)) return '不要用重复字符'
  return null
}