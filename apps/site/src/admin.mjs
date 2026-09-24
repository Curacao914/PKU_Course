import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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

const ALLOWED_ACTIONS = new Set(['doctor', 'discover', 'cycle', 'notify', 'download', 'transcribe', 'notes', 'publish', 'status'])

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

export function createAdminHandler({
  root,
  scratchRoot,
  workerPath,
  workerEnv = {},
  runCommand = defaultRunCommand,
  now = () => Date.now()
} = {}) {
  const failures = new Map()
  let running = null

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
        status.ledger = {
          path: store.path,
          stages: store.countTasks(),
          tasks: store.listTasks({ limit: 20 }).map(task => ({
            replayKey: task.replay_key,
            courseName: task.course_name,
            title: task.title,
            stage: task.stage,
            attempts: task.attempts,
            lastError: task.last_error,
            nextAttemptAt: task.next_attempt_at,
            updatedAt: task.updated_at
          })),
          deliveries: store.db.prepare(
            'SELECT dedupe_key, purpose, status, attempts, sent_at, last_error FROM deliveries ORDER BY id DESC LIMIT 20'
          ).all()
        }
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

  async function handleApi(req, res, pathname, url) {
    if (pathname === `${ADMIN_PREFIX}status`) {
      sendJson(res, 200, snapshot())
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

      const args = [workerPath, action === 'cycle' ? 'cycle' : action]
      if (action === 'cycle') args.push('--max-tasks', String(payload.maxTasks || 5))
      if (payload.replayKey) args.push('--replay-key', String(payload.replayKey))
      if (payload.course) args.push('--course', String(payload.course))

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

      if (!adminToken) {
        sendJson(res, 503, { ok: false, error: 'admin_token_unconfigured' })
        return true
      }
      if (blocked(req)) {
        sendJson(res, 429, { ok: false, error: 'too_many_attempts' })
        return true
      }
      const provided = String(req.headers['x-course-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '')
      if (provided !== adminToken) {
        recordFailure(req)
        sendJson(res, 401, { ok: false, error: 'unauthorized' })
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

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>课程闭环控制台</title>
<style>
:root { --paper:#fbfaf7; --ink:#16302b; --muted:#6b827c; --line:#dde5e1; --accent:#2f6f61; --warn:#9a5b2b; }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:-apple-system,"PingFang SC",system-ui,sans-serif; line-height:1.7; }
.wrap { max-width:900px; margin:0 auto; padding:36px 20px 80px; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:var(--muted); font-size:13px; margin-bottom:22px; }
.panel { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:16px; }
.panel h2 { font-size:14px; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
button { font:inherit; padding:7px 14px; border-radius:9px; border:1px solid var(--line); background:#fff; color:var(--ink); cursor:pointer; }
button:hover { border-color:var(--accent); color:var(--accent); }
button:disabled { opacity:.5; cursor:not-allowed; }
input { font:inherit; padding:7px 10px; border-radius:9px; border:1px solid var(--line); min-width:240px; }
pre { background:#f3f6f4; border-radius:10px; padding:12px; overflow:auto; max-height:340px; font-size:12px; }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; background:#f3f6f4; color:var(--muted); font-size:12px; margin-right:6px; }
.warn { color:var(--warn); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; }
</style>
</head>
<body>
<div class="wrap">
  <h1>课程闭环控制台</h1>
  <div class="sub">course.law-tech.dev · 手动触发各环节并查看账本状态</div>

  <div class="panel">
    <h2>访问令牌</h2>
    <div class="row">
      <input id="token" type="password" placeholder="COURSE_ADMIN_TOKEN" autocomplete="off">
      <button onclick="save()">保存</button>
      <button onclick="load()">刷新状态</button>
    </div>
    <div class="sub" style="margin:8px 0 0">令牌只保存在本机浏览器；未配置令牌时接口一律返回 503。</div>
  </div>

  <div class="panel">
    <h2>手动运行</h2>
    <div class="row">
      <button onclick="run('discover')">扫描教学网</button>
      <button onclick="run('cycle', {maxTasks:5})">跑一轮完整链路</button>
      <button onclick="run('notify')">投递通知</button>
      <button onclick="run('doctor')">体检</button>
    </div>
  </div>

  <div id="status"></div>
  <div class="panel"><h2>运行输出</h2><pre id="out">（尚未运行）</pre></div>
</div>
<script>
const $ = id => document.getElementById(id)
const key = 'course.admin.token'
$('token').value = localStorage.getItem(key) || ''

function save () { localStorage.setItem(key, $('token').value.trim()); load() }
function headers () { return { 'x-course-token': $('token').value.trim(), 'content-type': 'application/json' } }

async function load () {
  $('status').innerHTML = '<div class="panel"><h2>状态</h2><div class="sub">加载中…</div></div>'
  try {
    const res = await fetch('/api/admin/status', { headers: headers() })
    const data = await res.json()
    if (!res.ok) { $('status').innerHTML = '<div class="panel"><h2>状态</h2><div class="warn">' + (data.error || res.status) + '</div></div>'; return }
    $('status').innerHTML = render(data)
  } catch (e) {
    $('status').innerHTML = '<div class="panel"><h2>状态</h2><div class="warn">' + e + '</div></div>'
  }
}

function render (d) {
  const stages = (d.ledger && d.ledger.stages || []).map(s => '<span class="pill">' + s.stage + ' ' + s.n + '</span>').join('') || '<span class="sub">账本为空</span>'
  const tasks = (d.ledger && d.ledger.tasks || []).map(t =>
    '<tr><td>' + esc(t.courseName) + '</td><td>' + esc(t.title) + '</td><td>' + t.stage + '</td><td>' + t.attempts + '</td><td>' + esc(t.lastError || '') + '</td></tr>').join('')
  const deliveries = (d.ledger && d.ledger.deliveries || []).map(x =>
    '<tr><td>' + esc(x.purpose) + '</td><td>' + x.status + '</td><td>' + x.attempts + '</td><td>' + esc(x.sent_at || '') + '</td></tr>').join('')
  return '<div class="panel"><h2>账本</h2>' + stages +
    '<table><tr><th>课程</th><th>课次</th><th>阶段</th><th>尝试</th><th>最近错误</th></tr>' + tasks + '</table></div>' +
    '<div class="panel"><h2>通知投递</h2><table><tr><th>用途</th><th>状态</th><th>次数</th><th>发送时间</th></tr>' + deliveries + '</table></div>' +
    '<div class="panel"><h2>站点</h2><div class="sub">已发布 ' + (d.site && d.site.count || 0) + ' 篇 · 生成于 ' + esc(d.site && d.site.generatedAt || '-') + '</div></div>'
}

function esc (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }

async function run (action, extra) {
  $('out').textContent = '运行中…（' + action + '）'
  try {
    const res = await fetch('/api/admin/run', { method: 'POST', headers: headers(), body: JSON.stringify(Object.assign({ action }, extra || {})) })
    const data = await res.json()
    $('out').textContent = JSON.stringify(data, null, 2)
    load()
  } catch (e) {
    $('out').textContent = String(e)
  }
}

load()
</script>
</body>
</html>
`
