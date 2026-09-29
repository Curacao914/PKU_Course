export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export const COMMANDS = ['doctor', 'discover', 'download', 'transcribe', 'notes', 'materials', 'balance', 'publish', 'notify', 'cycle', 'verify', 'status', 'retry', 'prune', 'backup', 'digest', 'ppt-reminder', 'brief', 'onepage', 'sourcemap', 'integrate', 'artifacts', 'reconcile', 'embed', 'admin-passwd', 'mcp', 'help']

/**
 * 解析命令行。
 *
 * 约定：`--name value` 是选项，`--name`（后面紧跟另一个 -- 或没有值）是开关。
 * 选项值一律按字符串处理，由各命令自行校验。
 */
export function parseArgv(argv = []) {
  const [command = 'help', ...rest] = argv
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`未知命令：${command}`)
  }
  const options = {}
  const flags = new Set()

  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index])
    if (!token.startsWith('--')) throw new UsageError(`无法识别的参数：${token}`)
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      const name = body.slice(0, equals).trim()
      if (!name) throw new UsageError(`无法识别的参数：${token}`)
      options[name] = body.slice(equals + 1)
      continue
    }
    const name = body.trim()
    if (!name) throw new UsageError(`无法识别的参数：${token}`)
    const next = rest[index + 1]
    if (next === undefined || String(next).startsWith('--')) {
      flags.add(name)
      continue
    }
    options[name] = String(next)
    index += 1
  }

  return { command, options, flags }
}

export function requireOption(options, name, command) {
  const value = options[name]
  if (value === undefined || String(value).trim() === '') {
    throw new UsageError(`${command} 缺少必填选项 --${name}`)
  }
  return String(value).trim()
}
