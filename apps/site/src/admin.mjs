import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { clearPassword, readPasswordRecord, validatePassword, verifyPassword, writePassword } from '@course/core'
import { addMaterial, listMaterials, unassignedDir } from '@course/materials'

import { ADMIN_HTML } from './admin-page.mjs'
import { readSiteIndex } from '@course/publish'
import { openLedger } from '@course/store'

/**
 * 管理台：查看账本状态、手动触发各个环节。
 *
 * 安全约定：
 *   1. 未配置令牌时**一律 503**（fail closed），而不是"没配就等于开放"；
 *   2. 响应里**只出现 set / missing**，绝不回显任何密钥取值；
 *   3. 同一时刻只允许一次运行——手动触发与定时任务撞车会互相抢租约，
 *      与其让它们竞争，不如直接告诉调用方"正在运行中"；
 *   4. 登录失败按来源 IP 计数并在窗口期内拒绝，避免令牌被暴力尝试。
 */

const ADMIN_PREFIX = '/api/admin/'
const AUTH_FAILURE_LIMIT = 5
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 允许管理台触发的动作——**白名单 + argv 数组**，永不拼 shell 字符串。
 * 每个动作最终都落回与定时任务完全相同的那条 CLI 入口，因此不存在"界面上能做、
 * 命令行里不能做"的岔路。
 */
const ALLOWED_ACTIONS = new Set([
  'doctor', 'discover', 'cycle', 'notify', 'notify-retry', 'download', 'transcribe', 'notes', 'publish', 'status',
  'retry', 'revise', 'republish', 'prune', 'backup', 'balance'
])

/** 可写配置的键与类型：表单能改的东西就是这些，别的只能改环境变量。 */
export const EDITABLE_CONFIG = {
  targetChars: { type: 'number', min: 3000, max: 60000, label: '单课目标字数', hint: '两小时课 15000 左右；超出 1.25 倍会告警' },
  writeUnits: { type: 'number', min: 0, max: 20, label: '写作单元数', hint: '0 = 按模块各写一次；1 = 一次写完（模块结构不变）' },
  concurrency: { type: 'number', min: 1, max: 6, label: '并发任务数' },
  reviewConcurrency: { type: 'number', min: 1, max: 4, label: '并发审查数' },
  llmCostMode: { type: 'string', enum: ['economy', 'standard', 'immediate'], label: '成本窗口模式', hint: 'economy = 避开高价时段，笔记顺延到低价窗口' },
  llmPeakWindows: { type: 'string', label: '高价时段', hint: '形如 09:00-12:00,14:00-18:00（北京时间）' },
  keepMedia: { type: 'boolean', label: '保留媒体原件', hint: '打开后 prune 不会删视频/音频' },
  notifyMaxAttempts: { type: 'number', min: 1, max: 10, label: '通知最大重试次数' },
  minFreeBytes: { type: 'number', min: 1_000_000_000, max: 50_000_000_000, label: '磁盘下限（字节）' }
}

export function validateConfigPatch(patch = {}) {
  const clean = {}
  const errors = []
  for (const [key, value] of Object.entries(patch)) {
    const spec = EDITABLE_CONFIG[key]
    if (!spec) { errors.push(`不支持修改 ${key}`); continue }
    if (spec.type === 'number') {
      const num = Number(value)
      if (!Number.isFinite(num) || num < spec.min || num > spec.max) { errors.push(`${key} 需要在 ${spec.min}—${spec.max} 之间`); continue }
      clean[key] = Math.round(num)
    } else if (spec.type === 'boolean') {
      clean[key] = value === true || value === 'true' || value === 1 || value === '1'
    } else {
      const text = String(value ?? '').trim()
      if (spec.enum && !spec.enum.includes(text)) { errors.push(`${key} 只能是 ${spec.enum.join(' / ')}`); continue }
      clean[key] = text
    }
  }
  return { clean, errors }
}

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': body.length,
    ...headers
  })
  res.end(body)
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 从状态里删掉可能带密钥的字段：只保留键名与 set/missing。
 *
 * 匹配必须精确到"凭据类"名称：早期写成 /(key|token|…)/ 会把 replayKey、
 * dedupeKey、taskKey 这类**普通标识**也抹成 'set'，等于把有用的状态信息删掉。
 */
const SECRET_FIELD = /(api[_-]?key|secret|token|password|passwd|credential|cookie|authorization|access[_-]?key)/i

export function redactStatus(value) {
  const secretish = SECRET_FIELD
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => {
        // 容器一律继续递归：credentials / secrets 这类**对象名**本身命中关键词，
        // 若把它整体替换成 'set'，里面每个键的 set/missing 细节就全丢了。
        if (child && typeof child === 'object') return [key, walk(child)]
        // 只处理字符串值：真正的密钥一定是字符串。布尔/数字是状态信息，
        // 例如 `pkuCredentials: false` 表示"未配置"——一旦被改写成 'set'，
        // 界面就会把"没配"显示成"配好了"，是比泄漏更危险的错误。
        if (typeof child === 'string' && secretish.test(key)) {
          return [key, child.trim() ? 'set' : 'missing']
        }
        return [key, child]
      }))
    }
    return node
  }
  return walk(value)
}

/** 上传文件名的安全化：课件名里常有中文、空格与括号，但绝不能带路径分隔符。 */
export function safeMaterialName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120) || 'slides.pptx'
}

export function createAdminHandler({
  root,
  scratchRoot,
  materialsRoot = path.join(scratchRoot, 'materials'),
  workerPath,
  workerEnv = {},
  runCommand = defaultRunCommand,
  now = () => Date.now()
} = {}) {
  const failures = new Map()
  let running = null
  // 主令牌由 handle() 每次请求传进来，但 handleApi 也需要它（鉴权 + 找回路径提示），
  // 因此在这里留一个当前请求的闭包副本。
  let activeToken = ''

  function clientKey(req) {
    return String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown')
  }

  function blocked(req) {
    const entry = failures.get(clientKey(req))
    if (!entry) return false
    if (now() - entry.at > AUTH_FAILURE_WINDOW_MS) {
      failures.delete(clientKey(req))
      return false
    }
    return entry.count >= AUTH_FAILURE_LIMIT
  }

  function recordFailure(req) {
    const key = clientKey(req)
    const entry = failures.get(key)
    if (!entry || now() - entry.at > AUTH_FAILURE_WINDOW_MS) failures.set(key, { at: now(), count: 1 })
    else failures.set(key, { at: entry.at, count: entry.count + 1 })
  }

  /** 从课次产物里读出笔记模块列表（管理台要能"只重写某一个模块"）。 */
  function readLessonState(task) {
    const transcriptPath = task?.artifacts?.transcriptPath || ''
    if (!transcriptPath) return null
    const statePath = path.join(path.dirname(transcriptPath), 'lesson-state.json')
    if (!fs.existsSync(statePath)) return null
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      const lesson = state.lesson || {}
      return {
        statePath,
        outputDir: path.dirname(transcriptPath),
        status: lesson.status || null,
        finalChars: (lesson.finalNote?.markdown || '').length,
        savedAt: state.savedAt || null,
        modules: (lesson.nodes || []).map(node => ({
          id: node.id,
          title: node.title,
          status: node.status,
          chars: (node.draft || '').length,
          revisions: Number(node.revisionCount || 0),
          outlineNodeId: node.outlineNodeId
        }))
      }
    } catch {
      return null
    }
  }

  /** 待办：需要人动手的三类事。管理台的第一屏就该回答"现在要我做什么"。 */
  function collectTodos(tasks) {
    const todos = { missingMaterials: [], stuck: [], failedDeliveries: 0 }
    for (const task of tasks) {
      if (task.stage === 'needs_attention') {
        todos.stuck.push({
          replayKey: task.replayKey, courseName: task.courseName, title: task.title,
          stage: task.stage, attempts: task.attempts, lastError: task.lastError
        })
        continue
      }
      // 已经有转录稿但还没课件：说明马上要写笔记了，这时补课件最有用
      const hasTranscript = Boolean(task.artifactsPath || task.hasTranscript)
      if (hasTranscript && !task.materials.length) {
        todos.missingMaterials.push({ replayKey: task.replayKey, courseName: task.courseName, title: task.title })
      }
    }
    return todos
  }

  function snapshot() {
    const status = {
      generatedAt: new Date(now()).toISOString(),
      // 正在运行的状态要暴露出来：否则用户点完按钮看不到反馈，
      // 又在别处点一次会撞上 409 却不明白为什么
      running: running ? { action: running.action, startedAt: running.startedAt } : null,
      ledger: null,
      site: null,
      runs: []
    }
    try {
      const store = openLedger(path.resolve(scratchRoot, 'ledger.sqlite'))
      try {
        const rawTasks = store.listTasks({ limit: 60 })
        const tasks = rawTasks.map(task => {
          const artifacts = task.artifacts || {}
          const materials = task.course_name && task.title
            ? listMaterials({ root: materialsRoot, course: task.course_name, lesson: task.title, replayKey: task.replay_key })
            : []
          return {
            replayKey: task.replay_key,
            courseName: task.course_name,
            title: task.title,
            stage: task.stage,
            attempts: task.attempts,
            lastError: task.last_error,
            nextAttemptAt: task.next_attempt_at,
            updatedAt: task.updated_at,
            // 路径要露出来：管理台的"重写某模块 / 重新发布"都靠它定位产物
            artifacts: {
              transcriptPath: artifacts.transcriptPath || '',
              notePath: artifacts.notePath || '',
              slug: artifacts.slug || '',
              mediaPath: artifacts.mediaPath || ''
            },
            hasTranscript: Boolean(artifacts.transcriptPath && fs.existsSync(artifacts.transcriptPath)),
            materials: materials.map(item => ({ name: item.name, scope: item.scope, slideCount: item.slideCount, addedAt: item.addedAt })),
            lesson: readLessonState(task)
          }
        })
        status.ledger = {
          path: store.path,
          stages: store.countTasks(),
          tasks,
          deliveries: store.listDeliveries({ limit: 30 }),
          deliveriesByStatus: store.countDeliveries()
        }
        status.todos = collectTodos(tasks)
        status.todos.failedDeliveries = Number(status.ledger.deliveriesByStatus.failed || 0)
        status.todos.missingMaterials = status.todos.missingMaterials.filter(item => item.replayKey)
      } finally {
        store.close()
      }
    } catch (error) {
      status.ledger = { error: error instanceof Error ? error.message : String(error) }
    }

    try {
      const index = readSiteIndex(root)
      status.site = { count: index.count ?? 0, generatedAt: index.generatedAt ?? null, notes: (index.notes || []).slice(0, 20) }
    } catch (error) {
      status.site = { error: error instanceof Error ? error.message : String(error) }
    }

    const runsDir = path.join(scratchRoot, 'runs')
    if (fs.existsSync(runsDir)) {
      status.runs = fs.readdirSync(runsDir)
        .map(name => {
          const summaryPath = path.join(runsDir, name, 'summary.json')
          const stat = fs.statSync(path.join(runsDir, name))
          return fs.existsSync(summaryPath)
            ? { name, at: stat.mtime.toISOString(), summary: safeJson(fs.readFileSync(summaryPath, 'utf8')) }
            : { name, at: stat.mtime.toISOString(), summary: null }
        })
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 10)
    }

    return redactStatus(status)
  }

  /** 二进制请求体：课件动辄几十兆，不能按 UTF-8 字符串读。 */
  function readBinary(req, limitBytes = 200 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', chunk => {
        size += chunk.length
        if (size > limitBytes) {
          reject(new Error(`文件超过上限 ${Math.round(limitBytes / 1024 / 1024)} MB`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  /** 动作 → argv。参数只做存在性与枚举校验，绝不拼接成 shell 命令。 */
  function buildActionArgs(action, payload = {}) {
    const need = (name) => {
      const value = String(payload[name] ?? '').trim()
      if (!value) throw new Error(`缺少参数 ${name}`)
      return value
    }
    const base = [workerPath]
    switch (action) {
      case 'retry':
        return [...base, 'retry', '--replay-key', need('replayKey'), ...(payload.stage ? ['--stage', String(payload.stage)] : [])]
      case 'revise': {
        const transcriptPath = need('transcriptPath')
        if (!fs.existsSync(transcriptPath)) throw new Error('找不到该课次的转录稿，无法重写模块')
        return [
          ...base, 'notes',
          '--transcript', transcriptPath,
          '--course', need('course'),
          '--lesson', need('lesson'),
          '--output-dir', path.dirname(transcriptPath),
          '--revise', need('module'),
          '--request', need('request'),
          // 手动触发就是"我现在就要"，不再等低价窗口（用户点了按钮就该动）
          '--ignore-cost-window', '1'
        ]
      }
      case 'republish': {
        const transcriptPath = need('transcriptPath')
        return [
          ...base, 'publish',
          '--from', path.dirname(transcriptPath),
          '--course', need('course'),
          '--lesson', need('lesson'),
          ...(payload.replayKey ? ['--replay-key', String(payload.replayKey)] : [])
        ]
      }
      case 'notify-retry':
        return [...base, 'notify', '--retry-failed']
      case 'prune':
        return [...base, 'prune', ...(payload.apply ? ['--apply'] : [])]
      case 'cycle':
        return [...base, 'cycle', '--max-tasks', String(Number(payload.maxTasks) || 5), ...(payload.replayKey ? ['--replay-key', String(payload.replayKey)] : [])]
      case 'backup': case 'balance': case 'doctor': case 'discover': case 'notify': case 'status':
        return [...base, action]
      default:
        return [...base, action, ...(payload.replayKey ? ['--replay-key', String(payload.replayKey)] : []), ...(payload.course ? ['--course', String(payload.course)] : [])]
    }
  }

  const configPath = () => path.join(scratchRoot, 'config.json')

  function readConfigFile() {
    const file = configPath()
    if (!fs.existsSync(file)) return {}
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  async function handleApi(req, res, pathname, url) {
    if (pathname === `${ADMIN_PREFIX}status`) {
      const snap = snapshot()
      // 鉴权方式让界面知道：是否已设密码、主令牌是否可用（后者是找回路径）
      snap.auth = {
        passwordSet: Boolean(readPasswordRecord(scratchRoot)),
        masterTokenSet: Boolean(activeToken)
      }
      // _unassigned：收件箱里认不出归属的课件，等人指定
      try {
        const parked = unassignedDir(materialsRoot)
        snap.unassigned = fs.existsSync(parked) ? fs.readdirSync(parked).filter(name => !name.startsWith('.')) : []
      } catch {
        snap.unassigned = []
      }
      sendJson(res, 200, snap)
      return true
    }

    /**
     * 余额单独一个接口。
     *
     * 不塞进 status 的原因有两个：它是外部网络调用（慢、可能失败），
     * 而且它要起子进程——如果和"运行中"的手动任务挤在同一个 runCommand 上，
     * 两边会互相等（实测：状态页把正在跑的 cycle 卡死）。
     */
    if (pathname === `${ADMIN_PREFIX}balance`) {
      try {
        const result = await runCommand([workerPath, 'balance'], { env: workerEnv, timeoutMs: 25_000 })
        sendJson(res, 200, { ok: result.code === 0, ...(safeJson(result.stdout) || {}), stderr: String(result.stderr || '').slice(-500) })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

    /**
     * 课件上传。
     *
     * 用 PUT + 原始 body（而不是 multipart）：浏览器 fetch 直接把 File 当 body 发，
     * 服务端不需要解析 multipart，也就没有多一个解析器的攻击面。
     * 归属由前端的选择器给出（课程 + 课次 + 作用域），因此**不需要文件名约定**。
     */
    if (pathname === `${ADMIN_PREFIX}materials` && (req.method === 'PUT' || req.method === 'POST')) {
      const course = String(url.searchParams.get('course') || '').trim()
      const lesson = String(url.searchParams.get('lesson') || '').trim()
      const scope = String(url.searchParams.get('scope') || 'lesson').trim()
      const appliesTo = String(url.searchParams.get('appliesTo') || '').split(',').map(item => item.trim()).filter(Boolean)
      const name = String(url.searchParams.get('name') || '').trim()
      if (!course) {
        sendJson(res, 400, { ok: false, error: 'missing_course', message: '必须先选课程' })
        return true
      }
      if (scope !== 'course' && !lesson) {
        sendJson(res, 400, { ok: false, error: 'missing_lesson', message: '本课次课件必须先选课次；全课程通用请选"全课程"' })
        return true
      }
      let bytes
      try {
        bytes = await readBinary(req)
      } catch (error) {
        sendJson(res, 413, { ok: false, error: 'too_large', message: error.message })
        return true
      }
      if (!bytes.length) {
        sendJson(res, 400, { ok: false, error: 'empty_body' })
        return true
      }
      const tempDir = path.join(scratchRoot, 'tmp')
      fs.mkdirSync(tempDir, { recursive: true })
      const safeName = safeMaterialName(name || 'slides.pptx')
      const tempPath = path.join(tempDir, `upload-${Date.now()}-${safeName}`)
      fs.writeFileSync(tempPath, bytes)
      try {
        const result = await addMaterial({
          root: materialsRoot,
          course,
          lesson: scope === 'course' ? '' : lesson,
          scope,
          appliesTo,
          filePath: tempPath,
          name: safeName
        })
        sendJson(res, 200, {
          ok: true,
          course,
          lesson: scope === 'course' ? '（全课程通用）' : lesson,
          scope,
          appliesTo,
          name: result.entry.name,
          slideCount: result.deck.slideCount,
          bytes: result.entry.bytes,
          checksum: result.entry.checksum.slice(0, 12)
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'material_failed', message: error instanceof Error ? error.message : String(error) })
      } finally {
        fs.rmSync(tempPath, { force: true })
      }
      return true
    }

    if (pathname === `${ADMIN_PREFIX}run` && req.method === 'POST') {
      if (running) {
        sendJson(res, 409, { ok: false, error: 'already_running', startedAt: running.startedAt, action: running.action })
        return true
      }
      let payload = {}
      try {
        payload = safeJson(await readBody(req)) || {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_body', message: error.message })
        return true
      }
      const action = String(payload.action || '').trim()
      if (!ALLOWED_ACTIONS.has(action)) {
        sendJson(res, 400, { ok: false, error: 'unsupported_action', allowed: [...ALLOWED_ACTIONS] })
        return true
      }

      let args
      try {
        args = buildActionArgs(action, payload)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_arguments', message: error instanceof Error ? error.message : String(error) })
        return true
      }

      running = { action, startedAt: new Date(now()).toISOString() }
      try {
        const result = await runCommand(args, { env: workerEnv, timeoutMs: DEFAULT_RUN_TIMEOUT_MS })
        const parsed = safeJson(result.stdout)
        sendJson(res, 200, {
          ok: result.code === 0,
          action,
          exitCode: result.code,
          result: parsed ? redactStatus(parsed) : null,
          stderr: String(result.stderr || '').slice(-4000)
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, action, error: error instanceof Error ? error.message : String(error) })
      } finally {
        running = null
      }
      return true
    }

    /** 改密码：必须先用当前密码（或主令牌）通过鉴权，再给新密码。 */
    if (pathname === `${ADMIN_PREFIX}password` && (req.method === 'PUT' || req.method === 'POST')) {
      let payload = {}
      try {
        payload = safeJson(await readBody(req)) || {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_body', message: error.message })
        return true
      }
      const provided = String(req.headers['x-course-token'] || '')
      const byMasterToken = Boolean(activeToken) && provided === activeToken
      if (!byMasterToken && !verifyPassword(provided, readPasswordRecord(scratchRoot))) {
        recordFailure(req)
        sendJson(res, 401, { ok: false, error: 'unauthorized' })
        return true
      }
      const action = String(payload.action || 'set')
      if (action === 'clear') {
        clearPassword(scratchRoot)
        sendJson(res, 200, { ok: true, cleared: true, note: '已清除密码，现在只能用服务器上的主令牌登录' })
        return true
      }
      const problem = validatePassword(payload.password)
      if (problem) {
        sendJson(res, 400, { ok: false, error: 'weak_password', message: problem })
        return true
      }
      const file = writePassword(scratchRoot, payload.password)
      sendJson(res, 200, { ok: true, changed: true, path: file })
      return true
    }

    if (pathname === `${ADMIN_PREFIX}config`) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, path: configPath(), values: readConfigFile(), editable: EDITABLE_CONFIG })
        return true
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        let payload = {}
        try {
          payload = safeJson(await readBody(req)) || {}
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'bad_body', message: error.message })
          return true
        }
        const { clean, errors } = validateConfigPatch(payload.values || payload || {})
        if (errors.length) {
          sendJson(res, 400, { ok: false, error: 'invalid_config', errors })
          return true
        }
        const next = { ...readConfigFile(), ...clean, updatedAt: new Date(now()).toISOString() }
        fs.mkdirSync(path.dirname(configPath()), { recursive: true })
        fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`)
        sendJson(res, 200, { ok: true, values: next, applied: Object.keys(clean) })
        return true
      }
    }

    sendJson(res, 404, { ok: false, error: 'unknown_admin_route', path: pathname })
    return true
  }

  return {
    /** @returns {boolean} 是否已处理该请求 */
    async handle(req, res, pathname, url, { adminToken } = {}) {
      if (pathname === '/admin' || pathname === '/admin/') {
        const body = Buffer.from(ADMIN_HTML)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-length': body.length
        })
        res.end(body)
        return true
      }

      if (!pathname.startsWith(ADMIN_PREFIX)) return false

      activeToken = String(adminToken || '')
      if (!adminToken) {
        sendJson(res, 503, { ok: false, error: 'admin_token_unconfigured' })
        return true
      }
      if (blocked(req)) {
        sendJson(res, 429, { ok: false, error: 'too_many_attempts' })
        return true
      }
      // 两条路都能进：自己设的密码，或环境变量里的主令牌（忘记密码时的万能钥匙）。
      const provided = String(req.headers['x-course-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '')
      const byMasterToken = Boolean(activeToken) && provided === activeToken
      const byPassword = verifyPassword(provided, readPasswordRecord(scratchRoot))
      if (!byMasterToken && !byPassword) {
        recordFailure(req)
        sendJson(res, 401, { ok: false, error: 'unauthorized', hint: '用管理台密码或服务器上的主令牌（见 docs/10）' })
        return true
      }

      await handleApi(req, res, pathname, url)
      return true
    }
  }
}

/** 默认运行方式：以子进程调用 course CLI，复用与定时任务完全相同的入口。 */
export function defaultRunCommand(args, { env = {}, timeoutMs = DEFAULT_RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`运行超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
  })
}

// 页面在 admin-page.mjs 里：界面源码本来就长，混在 handler 里既难读也容易和转义打架
export { ADMIN_HTML } from './admin-page.mjs'
