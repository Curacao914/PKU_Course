import { spawn } from 'node:child_process'
import path from 'node:path'

import { openLedger } from '@course/store'

import { parseArgv, UsageError } from './args.mjs'
import { createCommands, USAGE } from './commands.mjs'
import { resolveWorkerConfig } from './config.mjs'

function defaultWhich(command) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', `command -v "${String(command).replace(/"/g, '')}"`])
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => resolve(''))
    child.on('close', code => resolve(code === 0 ? out.trim().split('\n')[0] : ''))
  })
}

function defaultRunPython({ python, args, env }) {
  return new Promise(resolve => {
    const child = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ code: 127, stdout, stderr: String(error.message) }))
    child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

function defaultAcquire({ log } = {}) {
  // 延迟加载：只有真正需要浏览器时才导入 Playwright。
  return import('@course/acquisition').then(({ createValidatedAcquisitionRuntime }) =>
    createValidatedAcquisitionRuntime({ log })
  )
}

/**
 * 运行 CLI。所有副作用都可通过 deps 注入，因此测试不需要 Chrome、网络或凭据。
 *
 * @returns {Promise<number>} 进程退出码
 */
export async function runCli(argv = [], deps = {}) {
  const env = deps.env ?? process.env
  const stdout = deps.stdout ?? (line => process.stdout.write(`${line}\n`))
  const stderr = deps.stderr ?? (line => process.stderr.write(`${line}\n`))

  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`错误：${error.message}`)
      stderr(USAGE)
      return 2
    }
    throw error
  }

  if (parsed.command === 'help' || parsed.flags.has('help')) {
    stdout(USAGE)
    return 0
  }

  const config = resolveWorkerConfig(env, { envFile: deps.envFile, ...(deps.configOverrides || {}) })
  const commands = createCommands({
    config,
    acquire: deps.acquire ?? defaultAcquire,
    runPython: deps.runPython ?? defaultRunPython,
    which: deps.which ?? defaultWhich,
    openStore: deps.openStore ?? (path => openLedger(path)),
    stdout,
    stderr
  })

  try {
    return await commands[parsed.command](parsed)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`错误：${error.message}`)
      stderr(USAGE)
      return 2
    }
    stderr(`命令 ${parsed.command} 失败：${error instanceof Error ? error.message : String(error)}`)
    if (error && typeof error === 'object' && error.retryable) stderr('该错误被标记为可重试。')
    return 1
  }
}
