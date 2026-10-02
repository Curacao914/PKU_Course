import crypto from 'node:crypto'
import http from 'node:http'
import { createAccountStore } from './store.mjs'
import { createJobQueue } from './jobs.mjs'
import { createQrSessions } from './qr.mjs'
import { createR2 } from './r2.mjs'
import { openLedger } from '@course/store'
import os from 'node:os'
import path from 'node:path'

const BODY_LIMIT = 512 * 1024
const MATERIAL_EXTENSIONS = new Set(['.ppt', '.pptx', '.pdf', '.doc', '.docx', '.xls', '.xlsx'])

function isAllowedMaterial(fileName) {
  return MATERIAL_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase())
}

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body) + '\n')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': data.length
  })
  res.end(data)
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

function authenticate(req, env) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!sameSecret(token, env.COURSE_CONTROL_SECRET)) {
    const error = new Error('UNAUTHORIZED')
    error.status = 401
    throw error
  }
  const ownerId = String(req.headers['x-course-owner-id'] || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) {
    const error = new Error('OWNER_ID_REQUIRED')
    error.status = 400
    throw error
  }
  return ownerId
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      const error = new Error('请求体过大')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    const error = new Error('JSON 格式错误')
    error.status = 400
    throw error
  }
}

function publicPku(row) {
  if (!row) return {
    configured: false, mode: 'qr', status: 'disconnected', autoSyncEnabled: false,
    selectedCourseKeys: [], lastVerifiedAt: null, lastSyncAt: null, lastError: ''
  }
  return {
    configured: Boolean(row.session_ciphertext || row.password_ciphertext),
    hasPassword: Boolean(row.password_ciphertext),
    mode: row.mode,
    status: row.status,
    autoSyncEnabled: row.auto_sync_enabled,
    selectedCourseKeys: row.selected_course_keys || [],
    lastVerifiedAt: row.last_verified_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error || ''
  }
}

export function createControlServer({ env = process.env } = {}) {
  if (!env.COURSE_CONTROL_SECRET) throw new Error('COURSE_CONTROL_SECRET 未配置')
  const store = createAccountStore(env)
  const r2 = createR2(env)
  const jobs = createJobQueue({ env, store, r2 })
  const qr = createQrSessions({ env, store })

  const syncIntervalMs = Math.max(15, Number(env.COURSE_MEMBER_SYNC_INTERVAL_MINUTES || 60)) * 60 * 1000
  const enqueueAutoSync = async () => {
    try {
      for (const ownerId of await store.autoSyncOwners()) jobs.enqueue(ownerId, 'sync', { maxTasks: 4 })
    } catch (error) {
      process.stderr.write('member auto-sync failed: ' + (error?.message || error) + '\n')
    }
  }
  const timer = setInterval(enqueueAutoSync, syncIntervalMs)
  timer.unref?.()
  setTimeout(enqueueAutoSync, 15_000).unref?.()

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://course-control.local')
      if (url.pathname === '/health') {
        send(res, 200, { ok: true, service: 'course-control' })
        return
      }

      const ownerId = authenticate(req, env)
      const profile = await store.profile(ownerId)

      if (req.method === 'GET' && url.pathname === '/v1/tasks') {
        const ledgerPath = env.COURSE_LEDGER_PATH || path.join(env.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.course-worker'), 'ledger.sqlite')
        const pku = await store.getPkuConnection(ownerId)
        const selectedKeys = new Set(pku?.selected_course_keys || [])
        const ledger = openLedger(ledgerPath)
        try {
          const all = ledger.listTasks({ limit: Math.min(500, Number(url.searchParams.get('limit') || 300)) })
          const visible = all.filter(task => {
            if (profile.role === 'owner' && !task.owner_id && task.resource_class === 'owner') return true
            if (task.owner_id !== ownerId) return false
            return profile.role === 'owner' || selectedKeys.has(task.course_key)
          }).map(task => ({
            id: task.id,
            replayKey: task.replay_key,
            sourceReplayKey: task.source_replay_key || task.replay_key,
            courseKey: task.course_key,
            courseName: task.course_name,
            title: task.title,
            teacher: task.teacher,
            stage: task.stage,
            attempts: task.attempts,
            lastError: task.last_error,
            priority: task.priority,
            resourceClass: task.resource_class,
            updatedAt: task.updated_at
          }))
          send(res, 200, { ok: true, tasks: visible })
        } finally {
          ledger.close()
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/account/status') {
        const [credentials, pku, limits] = await Promise.all([
          store.credentialStatus(ownerId), store.getPkuConnection(ownerId), store.resourceLimits(ownerId)
        ])
        send(res, 200, {
          ok: true,
          profile: { id: profile.id, role: profile.role },
          credentials: {
            ocr: credentials.ocr || { configured: false },
            deepseek: credentials.deepseek || { configured: false },
            dashscope: credentials.dashscope || { configured: false }
          },
          pku: publicPku(pku),
          limits
        })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/account/credential') {
        const body = await readJson(req)
        send(res, 200, { ok: true, credential: await store.putCredential(ownerId, String(body.provider || ''), body.secret) })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/v1/account/credential') {
        await store.deleteCredential(ownerId, String(url.searchParams.get('provider') || ''))
        send(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/account/pku/password') {
        const body = await readJson(req)
        await store.putPkuPassword(ownerId, body.username, body.password)
        send(res, 200, { ok: true, mode: 'password', note: '凭据已加密保存；首次同步会验证登录状态' })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/v1/account/pku/password') {
        await store.deletePkuPassword(ownerId)
        send(res, 200, { ok: true, mode: 'qr' })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/account/pku/selection') {
        const body = await readJson(req)
        await store.setPkuSelection(ownerId, {
          selectedCourseKeys: Array.isArray(body.selectedCourseKeys) ? body.selectedCourseKeys : [],
          autoSyncEnabled: body.autoSyncEnabled === true
        })
        send(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/account/pku/qr/start') {
        send(res, 200, { ok: true, ...(await qr.start(ownerId)) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/account/pku/qr/status') {
        const id = String(url.searchParams.get('id') || '')
        send(res, 200, { ok: true, ...(await qr.status(ownerId, id)) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/internal/private-note') {
        const body = await readJson(req)
        if (!body.replayKey || !body.markdown) {
          send(res, 400, { ok: false, error: 'NOTE_PAYLOAD_REQUIRED' })
          return
        }
        const note = await store.savePrivateNote(ownerId, body)
        send(res, 200, { ok: true, note: { id: note.id, title: note.title, updatedAt: note.updated_at } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/materials/presign') {
        const body = await readJson(req)
        if (!isAllowedMaterial(body.fileName)) {
          send(res, 400, { ok: false, error: '仅支持 PPT、PDF、Word 与 Excel 课件' })
          return
        }
        const limits = await store.resourceLimits(ownerId)
        const upload = await r2.presignUpload(
          ownerId,
          body.fileName,
          body.mimeType,
          Number(body.fileSize || 0),
          Number(limits.max_file_bytes),
          Number(limits.storage_quota_bytes)
        )
        send(res, 200, { ok: true, upload })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/materials/complete') {
        const body = await readJson(req)
        const key = String(body.key || '')
        if (!key.startsWith('users/' + ownerId + '/materials/')) {
          send(res, 400, { ok: false, error: 'INVALID_STORAGE_KEY' })
          return
        }
        const [head, limits, usage] = await Promise.all([
          r2.head(key), store.resourceLimits(ownerId), r2.usage(ownerId)
        ])
        if (!isAllowedMaterial(body.fileName)) {
          await r2.remove(key).catch(() => {})
          send(res, 400, { ok: false, error: '仅支持 PPT、PDF、Word 与 Excel 课件' })
          return
        }
        if (head.bytes > Number(limits.max_file_bytes)) {
          await r2.remove(key).catch(() => {})
          send(res, 413, { ok: false, error: '文件超过单文件上限' })
          return
        }
        if (usage.bytes > Number(limits.storage_quota_bytes)) {
          await r2.remove(key).catch(() => {})
          send(res, 413, { ok: false, error: '存储空间已超过限额' })
          return
        }
        const material = await store.createMaterial(ownerId, {
          title: body.fileName,
          storagePath: key,
          mimeType: head.contentType || body.mimeType,
          bytes: head.bytes,
          courseName: body.courseName,
          lessonTitle: body.lessonTitle,
          replayKey: body.replayKey
        })
        const job = jobs.enqueue(ownerId, 'material', { materialId: material.id })
        send(res, 202, { ok: true, material: { id: material.id, title: material.title }, job })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/jobs/discover') {
        const body = await readJson(req)
        const job = jobs.enqueue(ownerId, 'discover', { courseKey: String(body.courseKey || '') })
        send(res, 202, { ok: true, job })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/jobs/sync') {
        const body = await readJson(req)
        const job = jobs.enqueue(ownerId, 'sync', { maxTasks: Math.max(1, Math.min(5, Number(body.maxTasks || 3))) })
        send(res, 202, { ok: true, job })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/jobs') {
        send(res, 200, { ok: true, jobs: jobs.list(ownerId) })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
        const id = url.pathname.split('/').at(-1)
        const job = jobs.get(ownerId, id)
        if (!job) { send(res, 404, { ok: false, error: 'JOB_NOT_FOUND' }); return }
        send(res, 200, { ok: true, job })
        return
      }

      send(res, 404, { ok: false, error: 'NOT_FOUND' })
    } catch (error) {
      send(res, error.status || 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
