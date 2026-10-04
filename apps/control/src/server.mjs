import { assertSignedRequestEnvelope, createRequestVerifier, createJobTokens } from './server/auth.mjs'
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

async function readBody(req) {
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
  return Buffer.concat(chunks)
}

function readJson(req) {
  if (!req.rawBody.length) return {}
  try { return JSON.parse(req.rawBody.toString('utf8')) } catch {
    const error = new Error('JSON 格式错误')
    error.status = 400
    throw error
  }
}

function publicPku(row) {
  if (!row) return {
    configured: false, mode: 'qr', status: 'disconnected', autoSyncEnabled: false,
    selectedCourseKeys: [], scannedCourseKeys: [], lastVerifiedAt: null, lastSyncAt: null, lastError: ''
  }
  return {
    configured: Boolean(row.session_ciphertext || row.password_ciphertext),
    hasPassword: Boolean(row.password_ciphertext),
    mode: row.mode,
    status: row.status,
    autoSyncEnabled: row.auto_sync_enabled,
    selectedCourseKeys: row.selected_course_keys || [],
    scannedCourseKeys: row.scanned_course_keys || [],
    lastVerifiedAt: row.last_verified_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error || ''
  }
}

export function createControlServer({ env = process.env, store = createAccountStore(env), r2 = createR2(env), qr = createQrSessions({env, store}), jobTokens = createJobTokens() } = {}) {
  const authenticate = createRequestVerifier({ key: env.COURSE_CONTROL_SIGNING_KEY })
  const jobs = createJobQueue({ env, store, r2, jobTokens })

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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://course-control.local')
      if (url.pathname === '/health') {
        send(res, 200, { ok: true, service: 'course-control' })
        return
      }

      const declaredLength = Number(req.headers['content-length'] || 0)
      if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > BODY_LIMIT) {
        throw Object.assign(new Error('请求体过大'), { status: 413 })
      }

      let ownerId
      const privateWrite = url.pathname === '/v1/internal/private-note' || url.pathname === '/v1/internal/private-topic'
      if (privateWrite) {
        if (req.method !== 'POST') throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const claims = jobTokens.verify(token, {
          ownerId: req.headers['x-course-owner-id'], jobId: req.headers['x-course-job-id'], scope: 'private-content:write'
        })
        ownerId = claims.ownerId
      } else {
        assertSignedRequestEnvelope({ headers: req.headers })
      }

      req.rawBody = await readBody(req)
      if (!privateWrite) {
        ownerId = authenticate({ headers: req.headers, method: req.method, path: req.url, body: req.rawBody })
      }
      const profile = await store.profile(ownerId)

      if (req.method === 'GET' && url.pathname === '/v1/tasks') {
        const ledgerPath = env.COURSE_LEDGER_PATH || path.join(env.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.course-worker'), 'ledger.sqlite')
        const pku = await store.getPkuConnection(ownerId)
        const selectedKeys = new Set(pku?.selected_course_keys || [])
        const ledger = openLedger(ledgerPath)
        try {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 300)))
          const all = profile.role === 'owner'
            ? ledger.listTasks({ resourceClass: 'owner', limit })
            : ledger.listTasks({ ownerId, resourceClass: 'member', limit })
          const visible = all.filter(task =>
            profile.role === 'owner' || selectedKeys.has(task.course_key)
          ).map(task => ({
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
          profile: {
            id: profile.id,
            role: profile.role,
            email: profile.email || '',
            notificationEmail: profile.notification_email || profile.email || ''
          },
          credentials: {
            ocr: credentials.ocr || { configured: false },
            deepseek: credentials.deepseek || { configured: false },
            dashscope: credentials.dashscope || { configured: false },
            // MCP 长期令牌也走 provider_credentials（provider='mcp'）。以前这里只回三个 key，
            // 界面于是永远认为"没配过"：按钮一直写"生成访问令牌"（实际是换发、会让旧令牌立刻失效），
            // 而"删除令牌"按钮因为 configured 恒为 false 根本不出现——删都删不掉。
            mcp: credentials.mcp || { configured: false }
          },
          pku: publicPku(pku),
          limits
        })
        return
      }


      if (req.method === 'GET' && url.pathname === '/v1/private/content') {
        send(res, 200, { ok: true, ...(await store.privateContent(ownerId)) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/private/note') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) { send(res, 400, { ok: false, error: 'NOTE_ID_REQUIRED' }); return }
        const note = await store.privateNote(ownerId, id)
        if (!note) { send(res, 404, { ok: false, error: 'NOTE_NOT_FOUND' }); return }
        send(res, 200, { ok: true, note })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/private/note') {
        const body = await readJson(req)
        if (!body.replayKey || !body.markdown) { send(res, 400, { ok: false, error: 'NOTE_PAYLOAD_REQUIRED' }); return }
        const note = await store.savePrivateNote(ownerId, body)
        send(res, 200, { ok: true, note: { id: note.id, title: note.title, updatedAt: note.updated_at } })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/private/topic') {
        const body = await readJson(req)
        if (!body.topicId || !body.artifact) { send(res, 400, { ok: false, error: 'TOPIC_PAYLOAD_REQUIRED' }); return }
        const topic = await store.savePrivateTopic(ownerId, body)
        send(res, 200, { ok: true, topic: { id: topic.id, title: topic.title, updatedAt: topic.updated_at } })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/v1/private/topic') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) { send(res, 400, { ok: false, error: 'TOPIC_ID_REQUIRED' }); return }
        const removed = await store.deletePrivateTopic(ownerId, id)
        send(res, removed ? 200 : 404, { ok: removed, removed: id })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/account/notification-email') {
        const body = await readJson(req)
        const updated = await store.setNotificationEmail(ownerId, body.email)
        send(res, 200, {
          ok: true,
          email: updated.email || '',
          notificationEmail: updated.notification_email || updated.email || ''
        })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/account/mcp-token') {
        const body = await readJson(req)
        const secret = String(body.secret || '')
        if (secret.length < 32 || secret.includes('.')) {
          send(res, 400, { ok: false, error: 'MCP_SECRET_INVALID' })
          return
        }
        send(res, 200, { ok: true, credential: await store.putCredential(ownerId, 'mcp', secret) })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/v1/account/mcp-token') {
        await store.deleteCredential(ownerId, 'mcp')
        send(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/account/mcp-secret') {
        await store.profile(ownerId)
        const credentials = await store.credentials(ownerId)
        send(res, 200, { ok: true, configured: Boolean(credentials.mcp), secret: credentials.mcp || '' })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/v1/account/credential') {
        const body = await readJson(req)
        const provider = String(body.provider || '')
        if (provider === 'mcp') { send(res, 400, { ok: false, error: 'USE_MCP_TOKEN_ENDPOINT' }); return }
        send(res, 200, { ok: true, credential: await store.putCredential(ownerId, provider, body.secret) })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/v1/account/credential') {
        const provider = String(url.searchParams.get('provider') || '')
        if (provider === 'mcp') { send(res, 400, { ok: false, error: 'USE_MCP_TOKEN_ENDPOINT' }); return }
        await store.deleteCredential(ownerId, provider)
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

      if (req.method === 'POST' && url.pathname === '/v1/internal/private-topic') {
        const body = await readJson(req)
        if (!body.topicId || !body.artifact) {
          send(res, 400, { ok: false, error: 'TOPIC_PAYLOAD_REQUIRED' })
          return
        }
        const topic = await store.savePrivateTopic(ownerId, body)
        send(res, 200, { ok: true, topic: { id: topic.id, title: topic.title, updatedAt: topic.updated_at } })
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
          r2.head(ownerId, key), store.resourceLimits(ownerId), r2.usage(ownerId)
        ])
        if (!isAllowedMaterial(body.fileName)) {
          await r2.remove(ownerId, key).catch(() => {})
          send(res, 400, { ok: false, error: '仅支持 PPT、PDF、Word 与 Excel 课件' })
          return
        }
        if (head.bytes > Number(limits.max_file_bytes)) {
          await r2.remove(ownerId, key).catch(() => {})
          send(res, 413, { ok: false, error: '文件超过单文件上限' })
          return
        }
        if (usage.bytes > Number(limits.storage_quota_bytes)) {
          await r2.remove(ownerId, key).catch(() => {})
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

      if (req.method === 'POST' && url.pathname === '/v1/jobs/topics') {
        const body = await readJson(req)
        const courseName = String(body.courseName || '').trim()
        if (!courseName) { send(res, 400, { ok: false, error: 'COURSE_REQUIRED' }); return }
        const job = jobs.enqueue(ownerId, 'topics', {
          courseName,
          topicId: String(body.topicId || '').trim(),
          rebuild: body.rebuild === true
        })
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
  server.on('close', () => { clearInterval(timer); jobs.close() })
  return server
}
