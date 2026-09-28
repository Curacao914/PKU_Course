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

/**
 * 采集运行时是**每进程单例**。
 *
 * 早先每次调用都新建实例：discover 用完浏览器不关闭，紧接着 download 再要同一个
 * profile，就被前一个实例持有的锁挡住，等满 120 秒超时——一个 cycle 里
 * 第一步成功、第二步必然失败。
 *
 * 延迟加载：只有真正需要浏览器时才导入 Playwright。
 * 关键配置显式注入而不是依赖 process.env——env 文件的值不一定会进进程环境，
 * 漏掉会表现为「找不到 Chrome」这类与真实原因无关的报错。
 */
let acquisitionRuntime = null

function defaultAcquire({ log, config } = {}) {
  if (!acquisitionRuntime) {
    acquisitionRuntime = import('@course/acquisition').then(({ createValidatedAcquisitionRuntime }) =>
      createValidatedAcquisitionRuntime({
        log,
        executablePath: config?.chromePath || undefined,
        scratchRoot: config?.scratchRoot,
        profileDir: config?.profileDir,
        headless: config?.headless,
        username: config?.sources?.PKU_USERNAME || undefined,
        password: config?.sources?.PKU_PASSWORD || undefined
      })
    )
  }
  return acquisitionRuntime
}

/** 命令结束后关闭浏览器：它占着 profile 锁，也占着这台 1.9G 机器上几百兆内存。 */
async function closeAcquisitionRuntime() {
  if (!acquisitionRuntime) return
  const pending = acquisitionRuntime
  acquisitionRuntime = null
  try {
    const runtime = await pending
    await runtime?.close?.()
  } catch {
    // 关闭失败不影响命令结果
  }
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
    // 环境与时钟都可注入：成本窗口判定依赖"现在几点"，测试不能跟着挂钟走。
    env,
    now: deps.now,
    acquire: deps.acquire ?? defaultAcquire,
    runPython: deps.runPython ?? defaultRunPython,
    which: deps.which ?? defaultWhich,
    openStore: deps.openStore ?? (path => openLedger(path)),
    callModel: deps.callModel,
    sender: deps.sender,
    // 邮件发送器同样可注入：测试用假 sender，绝不真发邮件
    emailSender: deps.emailSender,
    // 出网请求也可注入：清 CDN 缓存这类调用在测试里不该真的打到 Cloudflare
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
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
  } finally {
    // 命令结束后必须关掉浏览器：它占着 profile 锁，也占着这台 1.9G 机器上几百兆内存
    await closeAcquisitionRuntime()
  }
}
