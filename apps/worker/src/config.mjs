import os from 'node:os'
import path from 'node:path'

import { ASR_WORKER_ENTRY } from '@course/asr'
import { DEFAULT_MIN_FREE_BYTES, resolveAcquisitionLimits } from '@course/acquisition'

import { DEFAULT_ENV_FILE } from './env-file.mjs'

const SECRET_KEYS = [
  'PKU_USERNAME',
  'PKU_PASSWORD',
  'DASHSCOPE_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'COURSE_AI_API_KEY'
]

/** 新系统使用独立目录，与旧 worker 的 ~/.law-tech-course-worker 并存不冲突。 */
export const DEFAULT_SCRATCH_ROOT = path.join(os.homedir(), '.course-worker')

/**
 * 管理台可以改的运行时配置（config.json）。
 *
 * 边界很清楚：**密钥永远只从环境变量来**（不接受界面写入），
 * 这里只收"调参"这类可以随手改的东西。文件优先于环境变量——
 * 界面改完立刻生效，不必去服务器上编辑 env。
 */
export function readRuntimeConfig(scratchRoot) {
  const file = path.join(path.resolve(scratchRoot), 'config.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function resolveWorkerConfig(env = process.env, options = {}) {
  const scratchRoot = path.resolve(
    options.scratchRoot || env.COURSE_WORKER_SCRATCH_DIR || DEFAULT_SCRATCH_ROOT
  )
  const runtime = readRuntimeConfig(scratchRoot)
  const profileDir = path.resolve(
    options.profileDir || env.COURSE_BROWSER_PROFILE_DIR || path.join(scratchRoot, 'browser-profile')
  )

  return {
    envFile: options.envFile || { path: DEFAULT_ENV_FILE, loaded: false, keys: [] },
    scratchRoot,
    profileDir,
    mediaRoot: path.join(scratchRoot, 'replays'),
    // 课件（PPT）归档与收件箱。教学网上没有课件，只能由用户上传；
    // 收件箱是"拖文件进去"的入口，materials 命令按 课程__课次.pptx 命名归档。
    materialsRoot: options.materialsRoot || env.COURSE_MATERIALS_DIR || path.join(scratchRoot, 'materials'),
    inboxRoot: options.inboxRoot || env.COURSE_INBOX_DIR || path.join(scratchRoot, 'inbox'),
    ledgerPath: options.ledgerPath || env.COURSE_LEDGER_PATH || path.join(scratchRoot, 'ledger.sqlite'),
    chromePath: options.chromePath || env.COURSE_CHROME_PATH || '',
    python: options.python || env.COURSE_PYTHON || 'python3',
    ffmpeg: env.COURSE_FFMPEG || 'ffmpeg',
    ffprobe: env.COURSE_FFPROBE || 'ffprobe',
    headless: (options.headless ?? env.COURSE_HEADLESS) !== '0',
    // 开始下载前的磁盘下限：一节课媒体有 1—2G 峰值，且 swap 与数据同盘，
    // 写满不只是下不了课，而是整机开始出问题。
    minFreeBytes: Number(runtime.minFreeBytes || env.COURSE_WORKER_MIN_FREE_BYTES || DEFAULT_MIN_FREE_BYTES),
    // 转写成功后是否保留原始媒体。默认删除：一节课 600MB—2GB，
    // 全部留着会很快吃满盘，而视频本来就在教学平台上，转录稿才是要留的东西。
    keepMedia: runtime.keepMedia === true || env.COURSE_KEEP_MEDIA === '1',
    // 笔记阶段的可调参数：命令行显式传的值优先，其次是界面里改的 config.json
    notes: {
      targetChars: Number(runtime.targetChars || 0) || 0,
      writeUnits: Number(runtime.writeUnits || 0) || 0,
      concurrency: Number(runtime.concurrency || 0) || 0,
      reviewConcurrency: Number(runtime.reviewConcurrency || 0) || 0
    },
    // 成本窗口：界面里改的模式与时段
    llm: {
      mode: String(runtime.llmCostMode || env.COURSE_LLM_COST_MODE || 'economy'),
      peakWindows: String(runtime.llmPeakWindows || env.COURSE_LLM_PEAK_WINDOWS || '')
    },
    limits: resolveAcquisitionLimits(env),
    ai: {
      apiKey: env.COURSE_AI_API_KEY || env.SCHEDULE_AI_API_KEY || env.OPENAI_API_KEY || '',
      baseUrl: env.COURSE_AI_BASE_URL || env.SCHEDULE_AI_BASE_URL || 'https://api.openai.com/v1',
      provider: env.COURSE_AI_PROVIDER || 'openai-compatible',
      timeoutMs: Number(env.COURSE_AI_TIMEOUT_MS || 240_000),
      temperature: Number(env.COURSE_AI_TEMPERATURE || 0.2),
      jsonRetries: Number(env.COURSE_AI_JSON_RETRIES ?? 1),
      costMode: env.COURSE_LLM_COST_MODE || 'economy',
      models: {
        default: env.COURSE_AI_MODEL || env.SCHEDULE_AI_MODEL || '',
        outline: env.COURSE_OUTLINE_MODEL || '',
        writer: env.COURSE_WRITER_MODEL || '',
        reviewer: env.COURSE_REVIEWER_MODEL || '',
        revision: env.COURSE_REVISION_MODEL || '',
        finalReview: env.COURSE_FINAL_REVIEW_MODEL || '',
        brief: env.COURSE_BRIEF_MODEL || ''
      }
    },
    notify: {
      openclawBin: env.OPENCLAW_BIN || 'openclaw',
      openclawHome: env.OPENCLAW_HOME || '',
      openclawStateDir: env.OPENCLAW_STATE_DIR || '',
      target: env.COURSE_WECHAT_TARGET || env.LAW_TECH_WECHAT_TARGET || '',
      publicUrl: env.COURSE_PUBLIC_URL || 'https://course.law-tech.dev',
      pollSeconds: Number(env.COURSE_NOTIFY_POLL_SECONDS || 30),
      maxAttempts: Number(runtime.notifyMaxAttempts || env.COURSE_NOTIFY_MAX_ATTEMPTS || 3)
    },
    asr: {
      entry: ASR_WORKER_ENTRY,
      chunkMinutes: Number(env.COURSE_ASR_CHUNK_MINUTES || 45),
      allowPaid: env.COURSE_ASR_ALLOW_PAID === '1',
      maxTaskCostCny: Number(env.COURSE_ASR_MAX_TASK_COST_CNY || 2),
      dailyMaxCostCny: Number(env.COURSE_ASR_DAILY_MAX_COST_CNY || 5)
    },
    sources: {
      PKU_USERNAME: env.PKU_USERNAME || '',
      PKU_PASSWORD: env.PKU_PASSWORD || '',
      DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY || '',
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || '',
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || '',
      R2_ENDPOINT: env.R2_ENDPOINT || '',
      R2_BUCKET: env.R2_BUCKET || '',
      COURSE_AI_API_KEY: env.COURSE_AI_API_KEY || ''
    }
  }
}

/** 子进程需要的环境变量：只透传转录真正要用的那些。 */
export function pythonEnvironment(config, env = process.env) {
  const passthrough = ['DASHSCOPE_API_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']
  const result = { ...env }
  for (const key of passthrough) result[key] = config.sources[key] || ''
  return result
}

/**
 * 面向人与日志的配置摘要：密钥永远只报 set / missing，绝不回显取值。
 */
export function describeConfig(config) {
  const state = value => (String(value || '').trim() ? 'set' : 'missing')
  return {
    envFile: {
      path: config.envFile.path,
      loaded: Boolean(config.envFile.loaded),
      keys: config.envFile.keys || []
    },
    scratchRoot: config.scratchRoot,
    ledgerPath: config.ledgerPath,
    profileDir: config.profileDir,
    headless: config.headless,
    minFreeBytes: config.minFreeBytes,
    python: config.python,
    chromePath: config.chromePath || '(自动探测)',
    limits: config.limits,
    asr: { ...config.asr },
    notify: {
      openclawBin: config.notify.openclawBin,
      openclawHome: config.notify.openclawHome || '(未设置)',
      openclawStateDir: config.notify.openclawStateDir || (config.notify.openclawHome ? '(跟随 HOME)' : '(未设置)'),
      target: config.notify.target ? 'set' : 'missing',
      publicUrl: config.notify.publicUrl,
      pollSeconds: config.notify.pollSeconds
    },
    ai: {
      baseUrl: config.ai.baseUrl,
      provider: config.ai.provider,
      costMode: config.ai.costMode,
      timeoutMs: config.ai.timeoutMs,
      models: config.ai.models
    },
    credentials: Object.fromEntries(SECRET_KEYS.map(key => [key, state(config.sources[key])])),
    // R2 端点与桶名不是密钥，照常显示，便于排查对象存储配置
    storage: {
      endpoint: config.sources.R2_ENDPOINT || '(未设置)',
      bucket: config.sources.R2_BUCKET || '(未设置)'
    }
  }
}

export function assertNoSecretsInText(text, config) {
  for (const key of SECRET_KEYS) {
    const value = String(config.sources[key] || '')
    if (value.length >= 4 && String(text).includes(value)) {
      throw new Error(`输出中检测到 ${key} 的取值，已拒绝写出`)
    }
  }
  return true
}
