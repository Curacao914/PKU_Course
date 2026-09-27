import { ToolError } from './errors.mjs'
import { DEFAULT_SITE_ORIGIN, DEFAULT_TTL_SECONDS, normalizeOrigin } from './sources.mjs'

/**
 * 配置来自三处，优先级：命令行 > 环境变量 > 默认值。
 *
 * 默认是远程站点（零配置可用），但只要 COURSE_LIBRARY 指到了 library.json 就用本地：
 * 本地库含正文，检索能做全文，而且离线。这条优先级是刻意的——
 * 用户在服务器上跑，一定是想读那份最新的发布库。
 */

export const USAGE = `用法：notes-mcp [--library <library.json>] [--origin <站点域名>] [--ttl <秒>] [--help]

以 stdio 启动课程笔记 MCP 服务器（MCP 的 stdio 传输：一行一条 JSON-RPC 消息，
stdout 只写协议消息，日志走 stderr）。由客户端作为子进程启动，stdin 关闭即退出。

数据源（二选一，本地优先）：
  --library   <文件>  本地发布库 library.json（含正文，推荐；也可用 COURSE_LIBRARY）
  --origin    <域名>  远程站点，默认 ${DEFAULT_SITE_ORIGIN}
                      （也可用 COURSE_SITE_ORIGIN；走 /api/notes 与 /md/*.md）
  --ttl       <秒>    远程索引/正文的缓存秒数，默认 ${DEFAULT_TTL_SECONDS}
                      （也可用 COURSE_MCP_TTL_SECONDS；本地库按 mtime 变化即时刷新，不受它影响）

工具：list_courses → get_course → search_notes → get_note（+ list_terms），
资源：notes://courses、notes://course/<课程名>、notes://terms/<课程名>、notes://note/<slug>。
详见 docs/12-笔记MCP.md。
`

/** 只认三个选项，其余一律报错——配置写错了要立刻看得见，而不是被默默忽略。 */
export function parseServerArgv(argv = []) {
  const out = { help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? '')
    if (token === '--help' || token === '-h') { out.help = true; continue }
    if (!token.startsWith('--')) throw new ToolError(`无法识别的参数：${token}`)
    const body = token.slice(2)
    const equals = body.indexOf('=')
    const name = equals >= 0 ? body.slice(0, equals) : body
    if (!['library', 'origin', 'ttl'].includes(name)) throw new ToolError(`无法识别的参数：${token}`)
    let value = equals >= 0 ? body.slice(equals + 1) : undefined
    if (value === undefined) {
      const next = argv[index + 1]
      if (next === undefined || String(next).startsWith('--')) throw new ToolError(`--${name} 缺少取值`)
      value = String(next)
      index += 1
    }
    out[name] = value
  }
  return out
}

/** 合并优先级：显式 overrides > 环境变量 > 默认值。空字符串视为"没给"。 */
export function resolveSettings({ env = process.env, overrides = {} } = {}) {
  const pick = (...values) => {
    for (const value of values) {
      const text = value === undefined || value === null ? '' : String(value).trim()
      if (text) return text
    }
    return ''
  }
  const library = pick(overrides.library, env.COURSE_LIBRARY)
  const origin = normalizeOrigin(pick(overrides.origin, env.COURSE_SITE_ORIGIN, DEFAULT_SITE_ORIGIN))
  const ttlText = pick(overrides.ttl, overrides.ttlSeconds, env.COURSE_MCP_TTL_SECONDS, String(DEFAULT_TTL_SECONDS))
  const ttlSeconds = Number(ttlText)
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
    throw new ToolError(`缓存秒数必须是非负数字：${ttlText}（--ttl / COURSE_MCP_TTL_SECONDS）`)
  }
  return { library, origin, ttlSeconds, source: library ? 'local' : 'remote' }
}
