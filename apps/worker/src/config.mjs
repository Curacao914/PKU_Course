import os from 'node:os'
import path from 'node:path'

import { ASR_WORKER_ENTRY } from '@course/asr'
import { resolveAcquisitionLimits } from '@course/acquisition'

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

export function resolveWorkerConfig(env = process.env, options = {}) {
  const scratchRoot = path.resolve(
    options.scratchRoot || env.COURSE_WORKER_SCRATCH_DIR || DEFAULT_SCRATCH_ROOT
  )
  const profileDir = path.resolve(
    options.profileDir || env.COURSE_BROWSER_PROFILE_DIR || path.join(scratchRoot, 'browser-profile')
  )

  return {
    envFile: options.envFile || { path: DEFAULT_ENV_FILE, loaded: false, keys: [] },
    scratchRoot,
    profileDir,
    mediaRoot: path.join(scratchRoot, 'replays'),
    ledgerPath: options.ledgerPath || env.COURSE_LEDGER_PATH || path.join(scratchRoot, 'ledger.sqlite'),
    chromePath: options.chromePath || env.COURSE_CHROME_PATH || '',
    python: options.python || env.COURSE_PYTHON || 'python3',
    ffmpeg: env.COURSE_FFMPEG || 'ffmpeg',
    ffprobe: env.COURSE_FFPROBE || 'ffprobe',
    headless: (options.headless ?? env.COURSE_HEADLESS) !== '0',
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
      maxAttempts: Number(env.COURSE_NOTIFY_MAX_ATTEMPTS || 3)
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
