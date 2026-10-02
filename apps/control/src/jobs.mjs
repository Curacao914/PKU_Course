import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const courseBin = path.join(repoRoot, 'apps/worker/bin/course.mjs')
const jobs = new Map()
const queue = []
let active = null

function safeOwner(ownerId) {
  return String(ownerId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function sanitizeMemberEnv(base, ownerId, accountRoot, credentials, pku, limits) {
  const env = { ...base }
  for (const key of [
    'PKU_USERNAME', 'PKU_PASSWORD', 'PADDLEOCR_ACCESS_TOKEN', 'DASHSCOPE_API_KEY',
    'COURSE_AI_API_KEY', 'SCHEDULE_AI_API_KEY', 'OPENAI_API_KEY',
    'COURSE_OUTLINE_MODEL', 'COURSE_WRITER_MODEL', 'COURSE_REVIEWER_MODEL',
    'COURSE_REVISION_MODEL', 'COURSE_FINAL_REVIEW_MODEL', 'COURSE_BRIEF_MODEL'
  ]) env[key] = ''

  env.COURSE_ACCOUNT_OWNER_ID = ownerId
  env.COURSE_RESOURCE_CLASS = 'member'
  env.COURSE_TASK_PRIORITY = '10'
  env.COURSE_SELECTED_COURSE_KEYS = JSON.stringify(pku.row?.selected_course_keys || [])
  env.COURSE_WORKER_SCRATCH_DIR = accountRoot
  env.COURSE_LEDGER_PATH = path.join(base.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.course-worker'), 'ledger.sqlite')
  env.COURSE_MATERIALS_DIR = path.join(accountRoot, 'materials')
  env.COURSE_INBOX_DIR = path.join(accountRoot, 'inbox')
  env.COURSE_BROWSER_STORAGE_STATE = path.join(accountRoot, 'pku-session.json')
  env.COURSE_KEEP_MEDIA = '0'
  env.COURSE_DOWNLOAD_CONCURRENCY = String(Math.max(1, Math.min(1, Number(limits?.hls_concurrency || 1))))
  env.COURSE_MEMBER_MIN_FREE_BYTES = String(base.COURSE_MEMBER_MIN_FREE_BYTES || 12 * 1024 * 1024 * 1024)
  env.COURSE_ASR_ALLOW_PAID = '1'
  env.COURSE_CONTROL_LOCAL_URL = base.COURSE_CONTROL_LOCAL_URL || ('http://127.0.0.1:' + String(base.COURSE_CONTROL_PORT || 3102))
  env.PADDLEOCR_ACCESS_TOKEN = credentials.ocr || ''
  env.DASHSCOPE_API_KEY = credentials.dashscope || ''
  env.COURSE_AI_API_KEY = credentials.deepseek || ''
  env.COURSE_AI_PROVIDER = 'openai-compatible'
  if (credentials.deepseek) {
    env.COURSE_AI_BASE_URL = 'https://api.deepseek.com/v1'
    env.COURSE_AI_MODEL = base.COURSE_MEMBER_AI_MODEL || 'deepseek-chat'
  } else {
    env.COURSE_AI_MODEL = ''
  }
  env.PKU_USERNAME = pku.username || ''
  env.PKU_PASSWORD = pku.password || ''
  return env
}

function runCourse(args, env) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? process.execPath : 'nice'
    const commandArgs = process.platform === 'win32'
      ? [courseBin, ...args]
      : ['-n', '10', process.execPath, courseBin, ...args]
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: { ...env, UV_THREADPOOL_SIZE: '2' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function parseLastJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const starts = [...raw.matchAll(/\n\{/g)].map(match => match.index + 1)
  for (const start of starts.reverse()) {
    try { return JSON.parse(raw.slice(start)) } catch {}
  }
  return null
}

async function prepare(ownerId, env, store) {
  const [profile, credentials, pku, limits] = await Promise.all([
    store.profile(ownerId),
    store.credentials(ownerId),
    store.pkuSecrets(ownerId),
    store.resourceLimits(ownerId)
  ])
  const root = path.join(env.COURSE_MEMBER_ROOT || path.join(os.homedir(), '.course-worker', 'accounts'), safeOwner(ownerId))
  fs.mkdirSync(root, { recursive: true })
  const statePath = path.join(root, 'pku-session.json')
  if (pku.session) {
    fs.writeFileSync(statePath, pku.session, { mode: 0o600 })
    try { fs.chmodSync(statePath, 0o600) } catch {}
  } else {
    fs.rmSync(statePath, { force: true })
  }
  return {
    profile, credentials, pku, limits, root, statePath,
    childEnv: sanitizeMemberEnv(env, ownerId, root, credentials, pku, limits)
  }
}

async function persistSession(ownerId, prepared, store, mode) {
  if (!fs.existsSync(prepared.statePath)) return
  try {
    const text = fs.readFileSync(prepared.statePath, 'utf8')
    JSON.parse(text)
    await store.savePkuSession(ownerId, text, { mode, status: 'connected' })
  } finally {
    fs.rmSync(prepared.statePath, { force: true })
  }
}

async function execute(job, env, store, r2) {
  const prepared = await prepare(job.ownerId, env, store)
  const selected = prepared.pku.row?.selected_course_keys || []
  const mode = prepared.pku.row?.mode || 'qr'
  const results = []

  if (job.kind === 'material') {
    const material = await store.getMaterial(job.ownerId, job.payload.materialId)
    const meta = material.metadata || {}
    const local = path.join(prepared.root, 'incoming', material.id + path.extname(material.title || 'material.pptx'))
    await store.markMaterial(job.ownerId, material.id, {
      status: 'processing',
      startedAt: new Date().toISOString(),
      error: ''
    })
    try {
      await r2.download(material.storage_path, local)
      const args = [
        'materials', '--file', local,
        '--course', String(meta.courseName || ''),
        '--lesson', String(meta.lessonTitle || ''),
        '--name', String(material.title || path.basename(local))
      ]
      if (meta.replayKey) args.push('--replay-key', String(meta.replayKey))
      if (prepared.credentials.ocr) args.push('--ocr', '--ocr-concurrency', '1')
      const result = await runCourse(args, prepared.childEnv)
      results.push({ step: 'materials', code: result.code, output: parseLastJson(result.stdout), stderr: result.stderr.slice(-4000) })
      await store.markMaterial(job.ownerId, material.id, {
        status: result.code === 0 ? 'processed' : 'failed',
        processedAt: new Date().toISOString(),
        error: result.code === 0 ? '' : result.stderr.slice(-1000)
      })
      return { ok: result.code === 0, results }
    } catch (error) {
      await store.markMaterial(job.ownerId, material.id, {
        status: 'failed',
        processedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => {})
      throw error
    } finally {
      fs.rmSync(local, { force: true })
    }
  }

  if (job.kind === 'sync') {
    const missing = []
    if (!prepared.credentials.dashscope) missing.push('阿里云语音识别 Key')
    if (!prepared.credentials.deepseek) missing.push('DeepSeek Key')
    if (!selected.length) missing.push('至少选择一门课程')
    if (missing.length) {
      const message = '开始同步前还需要：' + missing.join('、')
      await store.notifyEmail(job.ownerId, {
        eventKey: 'course-sync-preflight',
        title: '课程同步尚未开始',
        summary: message
      }).catch(() => {})
      return { ok: false, results: [{ step: 'preflight', code: 2, stderr: message }] }
    }
  }

  const discoverKeys = job.kind === 'discover'
    ? [job.payload?.courseKey || '']
    : selected

  for (const courseKey of discoverKeys) {
    const args = ['discover']
    if (job.kind === 'discover') args.push('--no-record')
    if (courseKey) args.push('--course-key', String(courseKey))
    const result = await runCourse(args, prepared.childEnv)
    const output = parseLastJson(result.stdout)
    results.push({ step: 'discover', courseKey, code: result.code, output, stderr: result.stderr.slice(-4000) })
    if (result.code !== 0 && !output?.loginMode) {
      const failure = result.stderr.slice(-1000) || '教学网同步失败'
      await store.markPku(job.ownerId, { status: 'needs_reauth', last_error: failure })
      await store.notifyEmail(job.ownerId, {
        eventKey: 'pku-needs-reauth',
        title: '教学网需要重新登录',
        summary: '课程同步已经暂停。请回到课程设置重新扫码，或检查长期登录凭据。'
      }).catch(() => {})
      await persistSession(job.ownerId, prepared, store, mode).catch(() => {})
      return { ok: false, results }
    }
  }

  await persistSession(job.ownerId, prepared, store, mode)

  if (job.kind === 'sync') {
    const cycle = await runCourse(['cycle', '--max-tasks', String(job.payload?.maxTasks || 3)], prepared.childEnv)
    results.push({ step: 'cycle', code: cycle.code, output: parseLastJson(cycle.stdout), stderr: cycle.stderr.slice(-4000) })
    if (cycle.code !== 0) {
      const failure = cycle.stderr.slice(-1200) || '课程处理没有完成'
      await store.notifyEmail(job.ownerId, {
        eventKey: 'course-cycle-failed:' + new Date().toISOString().slice(0, 10),
        title: '课程处理需要检查',
        summary: failure
      }).catch(() => {})
      return { ok: false, results }
    }
    await store.markPku(job.ownerId, { last_sync_at: new Date().toISOString(), status: 'connected', last_error: '' })
  }

  return { ok: true, results }
}

async function pump(env, store, r2) {
  if (active || !queue.length) return
  const id = queue.shift()
  const job = jobs.get(id)
  if (!job) return pump(env, store, r2)
  active = id
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  try {
    job.result = await execute(job, env, store, r2)
    job.status = job.result.ok ? 'succeeded' : 'failed'
    if (!job.result.ok) job.error = '任务没有完成'
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    job.finishedAt = new Date().toISOString()
    active = null
    queueMicrotask(() => pump(env, store, r2))
  }
}

export function createJobQueue({ env, store, r2 }) {
  function enqueue(ownerId, kind, payload = {}) {
    const existing = [...jobs.values()].find(job =>
      job.ownerId === ownerId && ['queued', 'running'].includes(job.status)
    )
    if (existing) return existing
    const job = {
      id: crypto.randomUUID(), ownerId, kind, payload, status: 'queued',
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null, error: ''
    }
    jobs.set(job.id, job)
    queue.push(job.id)
    queueMicrotask(() => pump(env, store, r2))
    return job
  }

  function get(ownerId, id) {
    const job = jobs.get(id)
    return job?.ownerId === ownerId ? job : null
  }

  function list(ownerId) {
    return [...jobs.values()].filter(job => job.ownerId === ownerId).slice(-20).reverse()
  }

  return { enqueue, get, list }
}
