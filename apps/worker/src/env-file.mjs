import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 服务器上的默认配置位置：仓库之外，重新部署不会覆盖。 */
export const DEFAULT_ENV_FILE = path.join(os.homedir(), '.course-worker', 'env')

/**
 * 解析 KEY=VALUE 文本。
 *
 * 支持：注释（# 开头）、空行、可选的 export 前缀、单/双引号包裹的值、值内空格。
 * 不支持：变量插值、多行值——需要这些能力时应改用真正的配置管理，而不是把
 * 复杂度塞进一个解析器。
 */
export function parseEnvText(text) {
  const result = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const equals = withoutExport.indexOf('=')
    if (equals <= 0) continue
    const key = withoutExport.slice(0, equals).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = withoutExport.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/**
 * 把 env 文件合并进环境。
 *
 * 优先级：已在进程中设置的非空变量 > env 文件 > 内置默认值。
 * 这样 `PKU_PASSWORD=x course discover` 可以临时覆盖文件配置，
 * 而文件里留空的键不会把已有变量清掉。
 */
export function applyEnvFile(env, filePath = DEFAULT_ENV_FILE) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    return { env, loaded: false, path: resolved, keys: [] }
  }
  const parsed = parseEnvText(fs.readFileSync(resolved, 'utf8'))
  const merged = { ...env }
  const applied = []
  for (const [key, value] of Object.entries(parsed)) {
    if (String(env[key] ?? '').trim() !== '') continue
    merged[key] = value
    applied.push(key)
  }
  return { env: merged, loaded: true, path: resolved, keys: applied }
}

/** 解析实际使用的配置文件路径：显式参数 > COURSE_ENV_FILE > 默认位置。 */
export function resolveEnvFile(env = process.env, explicit = '') {
  return path.resolve(explicit || env.COURSE_ENV_FILE || DEFAULT_ENV_FILE)
}
