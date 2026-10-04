import { spawn } from 'node:child_process'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { asrCostCny, noteCostCny, resolvePricing } from '@course/core'
import { WECHAT_SESSION_MAX_AGE_MINUTES, wechatSessionState } from '@course/notify'
import { addMaterial, listMaterials, materialDir, readDecks, unassignedDir } from '@course/materials'
import {
  emptyIntegrationManifest,
  emptyTopicManifest,
  normalizeIntegrationManifest,
  normalizeTopicManifest,
  removeIntegrationDefinition,
  removeTopicDefinition,
  upsertIntegrationDefinition,
  upsertTopicDefinition,
  checkBriefBinding
} from '@course/notes'

import { signRequest as signControlRequest } from '../../control/src/server/auth.mjs'
import { ADMIN_HTML } from './admin-page.mjs'
import { MEMBER_ADMIN_HTML } from './member-page.mjs'
import { readSiteIndex, renderTopicMarkdown, verifySourceMap } from '@course/publish'
import { openLedger } from '@course/store'

/**
 * 管理台：查看账本状态、手动触发各个环节。
 *
 * 安全约定：
 *   1. 未配置令牌时**一律 503**（fail closed），而不是"没配就等于开放"；
 *   2. 响应里**只出现 set / missing**，绝不回显任何密钥取值；
 *   3. 重任务仍然串行执行，但管理台允许继续提交——后来的动作进入 OWNER FIFO 队列，
 *      不让用户被一个长任务锁死，也不在 2 核机器上强开危险并发；
 *   4. 登录失败按来源 IP 计数并在窗口期内拒绝，避免令牌被暴力尝试。
 */

const ADMIN_PREFIX = '/api/admin/'
const AUTH_FAILURE_LIMIT = 5
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000

const COURSE_SESSION_COOKIE = 'lawtech_course_session'
const COURSE_SSO_ORIGIN = 'https://desk.law-tech.dev'
const COURSE_SESSION_TTL_SECONDS = 60 * 60
const COURSE_MCP_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signEnvelope(payload, key, scope) {
  const body = base64urlJson(payload)
  const sig = createHmac('sha256', key).update(scope + '.' + body).digest('base64url')
  return body + '.' + sig
}

function verifyEnvelope(token, key, scope, nowSeconds) {
  if (!token || !key) return null
  const parts = String(token).split('.')
  if (parts.length !== 2) return null
  const body = parts[0]
  const supplied = parts[1]
  const expected = createHmac('sha256', key).update(scope + '.' + body).digest('base64url')
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload || payload.v !== 1) return null
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < nowSeconds) return null
    return payload
  } catch {
    return null
  }
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '')
  for (const item of raw.split(';')) {
    const index = item.indexOf('=')
    if (index < 0) continue
    if (item.slice(0, index).trim() === name) return decodeURIComponent(item.slice(index + 1).trim())
  }
  return ''
}

function safeCoursePath(value, fallback = '/') {
  const text = String(value || '')
  if (!/^\/(?!\/)/.test(text) || /[\\\u0000-\u0020\u007f]/.test(text)) return fallback
  try {
    const decoded = decodeURIComponent(text)
    return /^\/(?!\/)/.test(decoded) && !/[\\\u0000-\u0020\u007f]/.test(decoded) ? text : fallback
  } catch {
    return fallback
  }
}

function sessionCookie(payload, key) {
  const token = signEnvelope(payload, key, 'course-session-v1')
  return COURSE_SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + COURSE_SESSION_TTL_SECONDS
}

function ssoLocation(next = '/') {
  return COURSE_SSO_ORIGIN + '/api/course/sso?next=' + encodeURIComponent(safeCoursePath(next, '/'))
}

export function issueMcpAccessToken(session, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!session?.sub || !['owner', 'member'].includes(session.role)) throw new Error('有效账户会话才可以签发 MCP token')
  return signEnvelope({
    v: 1,
    sub: String(session.sub),
    role: session.role,
    iat: nowSeconds,
    exp: nowSeconds + COURSE_MCP_TOKEN_TTL_SECONDS
  }, key, 'course-mcp-v1')
}

export function verifyMcpAccessToken(token, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = verifyEnvelope(token, key, 'course-mcp-v1', nowSeconds)
  if (!payload || !payload.sub || !['owner', 'member'].includes(payload.role)) return null
  return payload
}

/**
 * 允许管理台触发的动作——**白名单 + argv 数组**，永不拼 shell 字符串。
 * 每个动作最终都落回与定时任务完全相同的那条 CLI 入口，因此不存在"界面上能做、
 * 命令行里不能做"的岔路。
 */
export const ALLOWED_ACTIONS = new Set([
  'doctor', 'discover', 'cycle', 'notify', 'notify-retry', 'download', 'transcribe', 'notes', 'publish', 'status',
  'retry', 'revise', 'refresh-note', 'republish', 'prune', 'backup', 'balance',
  'rollback-content', 'rebuild-content', 'rebuild-integration', 'rebuild-integrations',
  'generate-topics', 'rebuild-topic', 'rebuild-topics',
  'ocr-material'
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
  minFreeBytes: { type: 'number', min: 1_000_000_000, max: 50_000_000_000, label: '磁盘下限（字节）' },
  // 备用推送通道：微信机器人要用户先来信才能推，这条依赖不该转嫁给用户，
  // 所以允许在界面上直接配一条不依赖会话的通道。密钥同样只落本机私有文件。
  notifyFallback: {
    type: 'string',
    enum: ['', 'wecom', 'dingtalk', 'feishu', 'bark', 'serverchan', 'pushplus', 'generic'],
    label: '备用推送通道',
    hint: '主通道会话过期时改走它；留空则不启用'
  },
  notifyFallbackUrl: { type: 'string', label: '备用通道地址', hint: '群机器人 webhook / Bark 地址；Server酱与 PushPlus 不用填' },
  notifyFallbackKey: { type: 'string', label: '备用通道密钥', hint: 'Server酱 SendKey 或 PushPlus token' }
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

/**
 * 微信会话：过期就说清楚，不让用户自己算。
 *
 * 这条通道只在"用户最近给机器人发过消息"之后才能真正送达——平台随每条来信下发
 * context_token，出站必须原样带上；没有它接口照常返回 messageId，微信端却收不到。
 * 所以"最近互动多久了"不是背景信息，而是"现在能不能推"的判据：超过
 * WECHAT_SESSION_MAX_AGE_MINUTES（默认 720 分钟 = 12 小时）就直接写
 * "已过期（超过 12 小时）"并用 warn 色，而不是只丢一个"23 小时前"让人自己减。
 *
 * 文案与 worker 侧 apps/worker/src/wechat.mjs 保持一致：站点进程与 worker 是两条
 * 独立进程，读不到彼此的模块，这一句只能各留一份（改动时两边一起改）。
 */
export const WECHAT_ACTIVATION = {
  supported: false,
  reason: 'OpenClaw 没有可自动重建会话的入口',
  // 依据（2026-09 核实）：openclaw channels login --channel openclaw-weixin 是**扫码登录**
  // （官方文档 openclaw/docs/channels/wechat.md：必须用手机扫码确认）；context_token 由
  // 微信随用户的入站消息下发、存在网关进程里，CLI 的 message / sessions / devices /
  // pairing 都不会重建它。详见 deploy/README.md「会话过期：先显示清楚，再谈自动」。
  hint: '给微信机器人发一条消息即可恢复会话；OpenClaw 没有可自动重建会话的入口（需要人工扫码登录或批准设备，见 deploy/README.md）'
}

/**
 * 把会话状态的原始数字翻成人话：是否过期、多久没互动、阈值多少小时。
 *
 * @returns {{ok:boolean, fresh:boolean, expired:boolean, ageMinutes:number|null, ageText:string,
 *           limitHours:number, summary:string, hint:string}}
 */
export function describeWechatSession({ session = {}, maxAgeMinutes = WECHAT_SESSION_MAX_AGE_MINUTES } = {}) {
  const limitHours = Math.round(Number(maxAgeMinutes || WECHAT_SESSION_MAX_AGE_MINUTES) / 60)
  if (!session.ok) {
    return { ...session, fresh: false, expired: false, limitHours, ageText: '', summary: '不可用', hint: '' }
  }
  const ageMinutes = Math.max(0, Math.round(Number(session.ageMinutes) || 0))
  const fresh = ageMinutes <= maxAgeMinutes
  const ageText = ageMinutes < 60 ? `${ageMinutes} 分钟前` : `${Math.round(ageMinutes / 60)} 小时前`
  return {
    ...session,
    fresh,
    expired: !fresh,
    limitHours,
    ageText,
    // 过期时把"多久没互动"和"超过多少算过期"写进同一句：用户不需要自己减
    summary: fresh ? `最近互动 ${ageText}` : `已过期（超过 ${limitHours} 小时）：最近互动 ${ageText}`,
    hint: fresh ? '' : WECHAT_ACTIVATION.hint
  }
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

/** 归档目录里的 meta.json：谁在归档里，以它为准；读坏了就当空的（宁可说"不在归档里"）。 */
function readMaterialMeta(metaPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { materials: [] }
  } catch {
    return { materials: [] }
  }
}

/** 删完之后把空目录往上收：归档树里不该剩下没有课件的课次目录（连 slides/ 一起）。 */
function pruneEmptyDirs(start, stopAt) {
  const stop = path.resolve(stopAt)
  let current = path.resolve(start)
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    // 先把里面空掉的子目录（slides/）收掉，再看自己是不是也空了
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = path.join(current, entry.name)
      try { if (!fs.readdirSync(child).length) fs.rmdirSync(child) } catch { /* 收不掉就留着 */ }
    }
    try { entries = fs.readdirSync(current) } catch { return }
    if (entries.length) return
    try { fs.rmdirSync(current) } catch { return }
    current = path.dirname(current)
  }
}

/**
 * 删掉一份已归档的课件。
 *
 * 三样东西要一起清：归档目录里的原件、slides/<名>.json 里的解析结果、meta.json 里的那一条。
 * 少清一样都会留下麻烦——要么磁盘上堆着界面上看不见的文件，要么列表里留着一条指向
 * 不存在文件的记录（写笔记时去读它，然后报一个谁都看不懂的错）。
 * 只有 meta.json 里登记过的名字才允许删：它是唯一一份可信的清单，别的名字一律拒绝，
 * 这样即使参数被拼成奇怪的样子也删不到归档目录之外的东西。
 */
export function removeMaterial({ root, course, lesson = '', scope = 'lesson', name } = {}) {
  const fileName = safeMaterialName(name)
  if (!root || !course || !fileName) throw new Error('删除课件需要 course / name')
  const dir = materialDir({ root, course, lesson: scope === 'course' ? '' : lesson })
  const metaPath = path.join(dir, 'meta.json')
  const meta = readMaterialMeta(metaPath)
  const entry = (meta.materials || []).find(item => item.name === fileName)
  if (!entry) throw new Error(`这份课件不在归档里：${fileName}`)
  const inside = target => String(target || '').startsWith(`${path.resolve(dir)}${path.sep}`)
  const removed = []
  for (const target of [path.join(dir, entry.name), entry.parsedPath || path.join(dir, 'slides', `${entry.name}.json`)]) {
    // parsedPath 是我们自己写进 meta.json 的，但仍然核对一次：删错文件是收不回来的
    if (!inside(target) || !fs.existsSync(target)) continue
    fs.rmSync(target, { force: true })
    removed.push(path.basename(target))
  }
  const kept = (meta.materials || []).filter(item => item.name !== fileName)
  if (kept.length) {
    fs.writeFileSync(metaPath, `${JSON.stringify({ ...meta, materials: kept, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  } else {
    fs.rmSync(metaPath, { force: true })
  }
  pruneEmptyDirs(dir, root)
  return { name: fileName, scope, removed, remaining: kept.length }
}

/** 后台识别进程写的进度快照；读不到就当没有（进度是可选项，缺了不该让状态页报错）。 */
export function readOcrProgress(file) {
  if (!file) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.records) ? parsed.records.filter(Boolean) : []
  } catch { return [] }
}

/**
 * 把进度换算成界面要的两个数。
 *
 * 分母在排队那一刻就定下来（plan.images），分子用"现在还剩几张没识别"倒推：
 * 识别进程只在每份课件开始/结束时落一次盘，中途没有更细的钩子。这样算出来的
 * 数字与列表里的"待识别"永远对得上，也不会因为重试而往前跳。
 */
export function describeOcrProgress(job = {}, materials = []) {
  const records = readOcrProgress(job.progressPath)
  const current = [...records].reverse().find(item => item && item.status === 'running') || null
  const metadataPending = materials.reduce((sum, item) => sum + Number(item.ocrPending || 0), 0)
  const planned = Number(job.plan?.images || 0)
  const total = planned > 0 ? planned : metadataPending

  // 新版 Python 在每张图完成后都会把 completed 写进进度文件。旧进度文件没有这个字段，
  // 因此保留“总数 - 当前 metadata pending”的兼容兜底。
  const hasImageProgress = records.some(item => item && item.completed != null && Number.isFinite(Number(item.completed)))
  const recordDone = records.reduce((sum, item) => {
    const images = Math.max(0, Number(item?.images || 0))
    if (item?.completed != null && Number.isFinite(Number(item.completed))) return sum + Math.max(0, Number(item.completed))
    if (item?.status === 'done') return sum + Math.max(0, images - Number(item.pending || 0))
    return sum
  }, 0)
  const legacyDone = Math.max(0, total - metadataPending)
  // 新版进度文件已经按“每张图”回报 completed，就不能再让旧 metadata 的粗粒度估算把它抬高。
  // 只有整个 job 都是旧格式时才使用 total - metadataPending 兜底。
  const done = Math.max(0, Math.min(total, hasImageProgress ? recordDone : legacyDone))
  return {
    running: true,
    total,
    done,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    current: current ? String(current.name || '') : '',
    currentImages: Number(current?.images || 0),
    currentDone: Number(current?.completed || 0),
    materials: Number(job.plan?.materials || 0),
    startedAt: job.startedAt || null
  }
}

/**
 * 动作 → argv。
 *
 * **白名单 + argv 数组**，永不拼 shell 字符串；每个动作最终都落回与定时任务
 * 完全相同的那条 CLI 入口，因此不存在"界面上能做、命令行里不能做"的岔路。
 *
 * 放在模块级（而不是处理器闭包里）是为了让测试能逐条核对：界面上的每个按钮
 * 到底会跑出什么命令、用的旗标在 CLI 里是否真的存在。这类"改名一处忘一处"
 * 的错不会自己暴露——界面会照常弹出"已开始"，只是命令跑不起来。
 */
export function buildActionArgs(action, payload = {}, workerPath = '') {
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
    case 'refresh-note':
      return [...base, 'refresh-note', '--replay-key', need('replayKey')]
    case 'notify-retry':
      return [...base, 'notify', '--retry-failed']
    case 'rollback-content':
      return [...base, 'publish', '--rollback-site', '--yes']
    case 'rebuild-content':
      return [...base, 'publish', '--rebuild']
    case 'rebuild-integration':
      return [...base, 'integrate', '--configured', '--id', need('id')]
    case 'rebuild-integrations':
      return [...base, 'integrate', '--configured']
    case 'generate-topics':
      return [...base, 'topics', '--course', need('course')]
    case 'rebuild-topic':
      return [...base, 'topics', '--configured', '--id', need('id')]
    case 'rebuild-topics':
      return [...base, 'topics', '--configured', ...(payload.course ? ['--course', String(payload.course)] : [])]
    // 图片版课件（整页是图、扫描件）抽不出文字时，用这条把图上的字识别出来补进课件。
    // 走的是与定时任务同一条 CLI：界面上能点，命令行里也一定能跑。
    case 'ocr-material':
      return [
        ...base, 'materials', '--ocr',
        '--course', need('course'),
        ...(payload.lesson ? ['--lesson', String(payload.lesson)] : []),
        ...(payload.replayKey ? ['--replay-key', String(payload.replayKey)] : [])
      ]
    case 'prune':
      return [...base, 'prune', ...(payload.apply ? ['--apply'] : [])]
    case 'cycle':
      // 课次行里的「立即跑这一节」是一次**显式点击**：把 --require-materials 0 明确写进
      // 命令行，等于"我知道这节没课件，我就是要跑"。整轮那个按钮保持 CLI 默认
      // （缺课件就跳过），因为它做的事与定时任务完全一样。
      return [
        ...base, 'cycle',
        '--max-tasks', String(Number(payload.maxTasks) || 5),
        ...(payload.replayKey ? ['--replay-key', String(payload.replayKey), '--require-materials', '0'] : [])
      ]
    case 'backup': case 'balance': case 'doctor': case 'discover': case 'notify': case 'status':
      return [...base, action]
    default:
      return [...base, action, ...(payload.replayKey ? ['--replay-key', String(payload.replayKey)] : []), ...(payload.course ? ['--course', String(payload.course)] : [])]
  }
}


/**
 * 标签。
 *
 * 用户要的是「手动打标签，一节课可以多个，能在左侧筛选里拖动排序，而且存服务器」，
 * 所以标签值单独落一个小文件（不塞进账本——账本是进度账，不是偏好存储）。
 * 三处可打：课程、课次、全局顺序。
 */
function tagsPath(scratchRoot) {
  return path.join(scratchRoot, 'tags.json')
}

export function readTags(scratchRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tagsPath(scratchRoot), 'utf8'))
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter(Boolean) : [],
      courses: parsed.courses && typeof parsed.courses === 'object' ? parsed.courses : {},
      lessons: parsed.lessons && typeof parsed.lessons === 'object' ? parsed.lessons : {}
    }
  } catch {
    return { order: [], courses: {}, lessons: {} }
  }
}

export function writeTags(scratchRoot, value) {
  const file = tagsPath(scratchRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  fs.chmodSync(file, 0o600)
  return file
}

const cleanTag = value => String(value ?? '').trim().slice(0, 40)

/** 校验并归一：未在顺序表里出现过的标签自动追加到末尾，界面不需要再管这件事。 */
export function normalizeTags(input = {}, previous = { order: [], courses: {}, lessons: {} }) {
  const order = []
  const pushTag = value => {
    const tag = cleanTag(value)
    if (tag && !order.includes(tag) && order.length < 80) order.push(tag)
  }
  for (const tag of Array.isArray(input.order) ? input.order : previous.order) pushTag(tag)
  const mapOf = (source, fallback) => {
    const next = {}
    const entries = source && typeof source === 'object' ? source : fallback
    for (const [key, list] of Object.entries(entries || {})) {
      const tags = []
      for (const tag of Array.isArray(list) ? list : []) {
        const clean = cleanTag(tag)
        if (clean && !tags.includes(clean)) tags.push(clean)
      }
      if (tags.length) next[String(key)] = tags.slice(0, 20)
      tags.forEach(pushTag)
    }
    return next
  }
  return {
    order,
    courses: mapOf(input.courses, previous.courses),
    lessons: mapOf(input.lessons, previous.lessons)
  }
}

/**
 * 存储占用。
 *
 * 用户要「知道我存了些什么、占了多少空间」，但不要一堆文件名——所以按类别汇总：
 * 每类给一个数字与一句人话说明，界面上画成条状图。
 */
const STORAGE_CATEGORIES = [
  { key: 'replays', label: '课次处理缓存', hint: '录播下载、分片、转录与写作中间文件；未完成课次会保留媒体以便重试，完成后可安全清理', dir: 'replays' },
  { key: 'materials', label: '课件', hint: '你上传的 PPT / PDF / Word / Excel 与解析出的文字', dir: 'materials' },
  { key: 'site', label: '站点', hint: '生成的 HTML、索引与 RSS', dir: 'site' },
  { key: 'browserProfile', label: '浏览器配置', hint: '登录教学网用的持久化配置（不能删）', dir: 'browser-profile' },
  { key: 'backups', label: '备份', hint: '账本与站点库的快照（默认留 7 份）', dir: 'backups' },
  { key: 'runs', label: '运行记录', hint: '每次运行的摘要（只留最近若干次）', dir: 'runs' },
  { key: 'experiments', label: '实验产物', hint: '切片对比实验留下的中间文件', dir: 'experiments' },
  { key: 'assets', label: '静态资源', hint: '站点用到的第三方库（绘图库等）', dir: 'assets' },
  { key: 'tmp', label: '临时文件', hint: '上传分片与中间文件，用完即删', dir: 'tmp' }
]

function directorySize(target, depth = 0) {
  if (depth > 6) return 0
  let total = 0
  let stat
  try { stat = fs.statSync(target) } catch { return 0 }
  if (stat.isFile()) return stat.size
  let entries = []
  try { entries = fs.readdirSync(target, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    total += directorySize(path.join(target, entry.name), depth + 1)
  }
  return total
}

function integrationManifestPath(scratchRoot) {
  return path.join(scratchRoot, 'integration-manifest.json')
}

export function readIntegrationManifestState(scratchRoot) {
  const file = integrationManifestPath(scratchRoot)
  if (!fs.existsSync(file)) return emptyIntegrationManifest()
  try {
    return normalizeIntegrationManifest(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(`整合清单损坏：${error instanceof Error ? error.message : String(error)}`)
  }
}

function writePrivateJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try { fs.rmSync(temp, { force: true }) } catch {}
  }
}

export function writeIntegrationManifestState(scratchRoot, manifest) {
  const normalized = normalizeIntegrationManifest(manifest)
  const file = integrationManifestPath(scratchRoot)
  writePrivateJsonAtomic(file, normalized)
  return { file, manifest: normalized }
}

function topicManifestPath(scratchRoot) {
  return path.join(scratchRoot, 'topic-manifest.json')
}

export function readTopicManifestState(scratchRoot) {
  const file = topicManifestPath(scratchRoot)
  if (!fs.existsSync(file)) return emptyTopicManifest()
  try {
    return normalizeTopicManifest(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(`专题清单损坏：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeTopicManifestState(scratchRoot, manifest) {
  const normalized = normalizeTopicManifest(manifest)
  const file = topicManifestPath(scratchRoot)
  writePrivateJsonAtomic(file, normalized)
  return { file, manifest: normalized }
}

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/**
 * 内容 release 只在这里读状态；真正的切换/回滚仍然只能经过 worker CLI。
 * 管理台因此没有第二套“偷偷改 symlink”的实现。
 */
export function contentReleaseReport(root) {
  const live = path.resolve(root)
  const releasesRoot = `${live}.releases`
  let mode = 'missing'
  let current = ''
  try {
    const stat = fs.lstatSync(live)
    if (stat.isSymbolicLink()) {
      mode = 'atomic'
      current = path.basename(fs.realpathSync(live))
    } else if (stat.isDirectory()) {
      mode = 'legacy'
      current = path.basename(live)
    } else {
      mode = 'other'
    }
  } catch {}

  const releases = []
  if (fs.existsSync(releasesRoot)) {
    for (const entry of fs.readdirSync(releasesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.staging-')) continue
      const dir = path.join(releasesRoot, entry.name)
      let modifiedAt = null
      try { modifiedAt = fs.statSync(dir).mtime.toISOString() } catch {}
      const library = readJsonSafe(path.join(dir, 'library.json'), [])
      releases.push({
        name: entry.name,
        current: entry.name === current,
        legacy: entry.name.startsWith('legacy-'),
        modifiedAt,
        notes: Array.isArray(library) ? library.length : null
      })
    }
  }
  releases.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')))
  return {
    mode,
    current,
    releases,
    canRollback: mode === 'atomic' && releases.some(item => !item.current)
  }
}

function integrationArtifacts(scratchRoot) {
  const dir = path.join(scratchRoot, 'integrations')
  const found = new Map()
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(dir, entry.name)
    const plan = readJsonSafe(file, null)
    if (!plan || typeof plan !== 'object') continue
    const id = String(plan.integrationId || `${plan.course || ''}::${plan.topic || ''}`).trim()
    if (id) found.set(id, { file, plan })
  }
  return found
}

function integrationReport({ root, scratchRoot, manifest }) {
  const library = readJsonSafe(path.join(root, 'library.json'), [])
  const currentBySlug = new Map((Array.isArray(library) ? library : []).map(record => [String(record.slug || ''), record]))
  const artifacts = integrationArtifacts(scratchRoot)
  return manifest.integrations.map(definition => {
    const artifact = artifacts.get(definition.id)
    if (!artifact) return { ...definition, status: 'missing', generatedAt: null, staleLessons: [] }
    const staleLessons = (artifact.plan.lessons || []).filter(lesson => {
      const currentRecord = currentBySlug.get(String(lesson.slug || ''))
      return !currentRecord || String(currentRecord.checksum || '') !== String(lesson.checksum || '')
    }).map(lesson => String(lesson.lessonTitle || lesson.slug || ''))
    return {
      ...definition,
      status: staleLessons.length ? 'stale' : 'fresh',
      generatedAt: artifact.plan.generatedAt || null,
      staleLessons
    }
  })
}

function topicArtifacts(scratchRoot) {
  const dir = path.join(scratchRoot, 'topics')
  const found = new Map()
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(dir, entry.name)
    const artifact = readJsonSafe(file, null)
    if (!artifact || artifact.kind !== 'course-topic' || !artifact.id) continue
    found.set(String(artifact.id), { file, artifact })
  }
  return found
}

function topicReport({ root, scratchRoot, manifest }) {
  const library = readJsonSafe(path.join(root, 'library.json'), [])
  const currentBySlug = new Map((Array.isArray(library) ? library : []).map(record => [String(record.slug || ''), record]))
  const artifacts = topicArtifacts(scratchRoot)
  return manifest.topics.map(definition => {
    const hit = artifacts.get(definition.id)
    if (!hit) return { ...definition, status: 'missing', generatedAt: null, staleLessons: [] }
    const staleLessons = (hit.artifact.lessons || []).filter(lesson => {
      const current = currentBySlug.get(String(lesson.slug || ''))
      return !current || String(current.checksum || '') !== String(lesson.checksum || '')
    }).map(lesson => String(lesson.lessonTitle || lesson.slug || ''))
    const artifactLessons = (hit.artifact.lessons || []).map(lesson => String(lesson.slug || ''))
    const definitionChanged =
      String(hit.artifact.title || '') !== String(definition.title || '') ||
      JSON.stringify(artifactLessons) !== JSON.stringify(definition.lessons || [])
    return {
      ...definition,
      status: staleLessons.length || definitionChanged ? 'stale' : 'fresh',
      generatedAt: hit.artifact.generatedAt || null,
      staleLessons,
      definitionChanged
    }
  })
}

function removeTopicArtifact(scratchRoot, id) {
  const hit = topicArtifacts(scratchRoot).get(String(id || '').trim())
  if (!hit || !fs.existsSync(hit.file)) return []
  fs.rmSync(hit.file, { force: true })
  return [path.basename(hit.file)]
}

export function contentAdminReport({ root, scratchRoot }) {
  const integrationManifest = readIntegrationManifestState(scratchRoot)
  const topicManifest = readTopicManifestState(scratchRoot)
  return {
    ok: true,
    release: contentReleaseReport(root),
    topics: {
      path: topicManifestPath(scratchRoot),
      items: topicReport({ root, scratchRoot, manifest: topicManifest })
    },
    integrations: {
      path: integrationManifestPath(scratchRoot),
      items: integrationReport({ root, scratchRoot, manifest: integrationManifest })
    }
  }
}

function removeIntegrationArtifacts(scratchRoot, id) {
  const artifacts = integrationArtifacts(scratchRoot)
  const hit = artifacts.get(String(id || '').trim())
  if (!hit) return []
  const removed = []
  for (const file of [hit.file, hit.file.replace(/\.json$/i, '.md')]) {
    if (!fs.existsSync(file)) continue
    fs.rmSync(file, { force: true })
    removed.push(path.basename(file))
  }
  return removed
}

export function storageReport(scratchRoot) {
  const categories = STORAGE_CATEGORIES.map(item => {
    const bytes = directorySize(path.join(scratchRoot, item.dir))
    return { key: item.key, label: item.label, hint: item.hint, bytes }
  })
  const ledgerBytes = ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm']
    .reduce((sum, name) => sum + directorySize(path.join(scratchRoot, name)), 0)
  categories.splice(2, 0, { key: 'ledger', label: '账本', hint: '任务进度与通知队列（SQLite）', bytes: ledgerBytes })
  let disk = null
  try {
    const info = fs.statfsSync(scratchRoot)
    disk = { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize }
  } catch { disk = null }
  return {
    categories: categories.filter(item => item.bytes > 0).sort((a, b) => b.bytes - a.bytes),
    totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0),
    disk
  }
}

export function createAdminHandler({
  root,
  scratchRoot,
  materialsRoot = path.join(scratchRoot, 'materials'),
  workerPath,
  workerEnv = {},
  runCommand = defaultRunCommand,
  spawnOcr = defaultSpawnOcr,
  now = () => Date.now(),
  ssoKey = '',
  controlUrl = 'http://127.0.0.1:3102',
  controlFetch = fetch
} = {}) {
  const failures = new Map()
  let running = null
  const pendingJobs = []
  /**
   * 进程内的"长动作"快照（Phase 5.2 C2）。
   *
   * 为什么要有：跑一轮 / 重跑一节 / 备份动辄几分钟，旧实现是**挂着一个请求等它跑完**——
   * 中间刷新页面、网络抖一下，人就不知道到底跑没跑、跑到哪了。现在立刻返回 jobId，
   * 由前端轮询 job 状态。
   *
   * 边界写清楚：这是**进程内**快照，重启就没了；真正持久的记录在账本里（阶段、事件、
   * 尝试次数），所以"重启后还能不能续跑"靠的是账本，不是这个 Map。
   */
  const jobs = new Map()
  const JOB_KEEP = 30


  const controlBase = String(controlUrl || '').replace(/\/$/, '')

  async function controlCall(session, { method = 'GET', target = '/', body = null } = {}) {
    if (!session?.sub) throw Object.assign(new Error('ACCOUNT_SESSION_REQUIRED'), { status: 401 })
    if (!controlBase || !ssoKey) throw Object.assign(new Error('ACCOUNT_CONTROL_UNAVAILABLE'), { status: 503 })
    const rawBody = body == null ? '' : JSON.stringify(body)
    const signed = signControlRequest({
      key: ssoKey,
      ownerId: String(session.sub),
      method,
      path: target,
      body: rawBody
    })
    const response = await controlFetch(controlBase + target, {
      method,
      headers: {
        ...signed,
        accept: 'application/json',
        ...(rawBody ? { 'content-type': 'application/json' } : {})
      },
      ...(rawBody ? { body: rawBody } : {}),
      redirect: 'error'
    })
    const text = await response.text()
    let payload = {}
    try { payload = text ? JSON.parse(text) : {} } catch { payload = { ok: false, error: text || 'CONTROL_BAD_JSON' } }
    return { status: response.status, ok: response.ok, payload }
  }

  async function accountWorkspace(session) {
    const [account, content, tasks, jobsView] = await Promise.all([
      controlCall(session, { target: '/v1/account/status' }),
      controlCall(session, { target: '/v1/private/content' }),
      controlCall(session, { target: '/v1/tasks?limit=300' }),
      controlCall(session, { target: '/v1/jobs' })
    ])
    for (const item of [account, content, tasks, jobsView]) {
      if (!item.ok) throw Object.assign(new Error(item.payload?.error || 'ACCOUNT_CONTROL_FAILED'), { status: item.status || 502 })
    }
    return {
      ok: true,
      account: account.payload,
      notes: content.payload.notes || [],
      topics: content.payload.topics || [],
      tasks: tasks.payload.tasks || [],
      jobs: jobsView.payload.jobs || []
    }
  }

  function jobMeta(payload = {}) {
    return {
      replayKey: String(payload.replayKey || ''),
      course: String(payload.course || ''),
      lesson: String(payload.lesson || ''),
      module: String(payload.module || ''),
      integrationId: String(payload.id || '')
    }
  }

  function jobView(job, includeOutput = false) {
    const queuePosition = job.status === 'queued'
      ? Math.max(1, pendingJobs.findIndex(item => item.id === job.id) + 1)
      : 0
    return {
      id: job.id,
      action: job.action,
      status: job.status,
      queuedAt: job.queuedAt || null,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      exitCode: job.exitCode === null || job.exitCode === undefined ? null : job.exitCode,
      meta: job.meta || {},
      queuePosition,
      ...(job.error ? { error: job.error } : {}),
      ...(includeOutput ? { result: job.result, stderr: job.stderr } : {})
    }
  }

  async function executeJob(job) {
    job.status = 'running'
    job.startedAt = new Date(now()).toISOString()
    running = job
    try {
      const result = await runCommand(job.args, { env: workerEnv, timeoutMs: DEFAULT_RUN_TIMEOUT_MS })
      const parsed = safeJson(result.stdout)
      job.status = result.code === 0 ? 'done' : 'failed'
      job.exitCode = result.code
      job.result = parsed ? redactStatus(parsed) : null
      job.stderr = String(result.stderr || '').slice(-4000)
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      job.finishedAt = new Date(now()).toISOString()
      running = null
      drainJobs()
    }
  }

  function drainJobs() {
    if (running || !pendingJobs.length) return
    const job = pendingJobs.shift()
    void executeJob(job)
  }

  function enqueueJob(action, args, payload) {
    const job = {
      id: randomUUID(),
      action,
      args,
      meta: jobMeta(payload),
      status: 'queued',
      queuedAt: new Date(now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      result: null,
      stderr: '',
      error: ''
    }
    jobs.set(job.id, job)
    pendingJobs.push(job)
    while (jobs.size > JOB_KEEP) {
      const first = jobs.keys().next().value
      if (first === running?.id || pendingJobs.some(item => item.id === first)) break
      jobs.delete(first)
    }
    drainJobs()
    return job
  }

  function contentQualityMap() {
    const result = new Map()
    const file = path.join(root, 'library.json')
    if (!fs.existsSync(file)) return result
    let records = []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      records = Array.isArray(parsed) ? parsed : (parsed.records || parsed.notes || [])
    } catch {
      return result
    }
    for (const record of records) {
      const course = String(record.courseName || '')
      const lesson = String(record.lessonTitle || '')
      const markdown = String(record.markdown || '')
      if (!course || !lesson) continue
      const missing = []
      if (!markdown.trim()) missing.push('正文')
      const brief = record.brief || {}
      const briefCheck = checkBriefBinding(brief, { course, lesson, markdown })
      if (!brief.briefing || !(brief.keyPoints || []).length || !briefCheck.ok || !briefCheck.bound) missing.push('简报')
      if (!String(record.theme || '').trim()) missing.push('主题')
      if (!(record.keywords || []).length) missing.push('关键词')
      const onepage = record.onepage || {}
      if (!String(onepage.markdown || '').trim()) {
        missing.push('一页纸')
      } else {
        const mapCheck = verifySourceMap(onepage.sourceMap, {
          slug: record.slug || '',
          noteMarkdown: markdown,
          onepageMarkdown: onepage.markdown,
          sections: record.sections || null
        })
        if (!mapCheck.ok || !mapCheck.bound) missing.push('来源映射')
      }
      result.set(course + '\u0000' + lesson, {
        complete: missing.length === 0,
        missing,
        hasBrief: Boolean(brief.briefing),
        hasOnepage: Boolean(onepage.markdown),
        updatedAt: record.updatedAt || ''
      })
    }
    return result
  }

  // 主令牌由 handle() 每次请求传进来，但 handleApi 也需要它（鉴权 + 找回路径提示），
  // 因此在这里留一个当前请求的闭包副本。
  let activeToken = ''


  /**
   * 后台补识别图片文字。
   *
   * 上传请求等不起：一张图几秒到几十秒，一份 80 页课件要几分钟，这条请求会被
   * 代理的 100 秒上限掐断（而且用户要盯着转圈）。所以归档完就返回，识别另起一个
   * 脱离父进程的 node 进程去跑，结果写回归档的 json——管理台轮询就能看到数字变化。
   *
   * 同一课次只跑一个：状态记在 <scratch>/ocr-state.json，判断依据是那个进程还活着没有。
   */
  function ocrStateFile() {
    return path.join(scratchRoot, 'ocr-state.json')
  }

  function readOcrState() {
    try {
      const list = JSON.parse(fs.readFileSync(ocrStateFile(), 'utf8'))
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }

  function alive(pid) {
    try { process.kill(Number(pid), 0); return true } catch { return false }
  }

  function writeOcrState(list) {
    fs.mkdirSync(scratchRoot, { recursive: true })
    fs.writeFileSync(ocrStateFile(), `${JSON.stringify(list.slice(-20), null, 2)}\n`)
  }

  /** 还在跑的识别任务（同一课次去重），顺带清掉已经结束的。 */
  function runningOcr() {
    const list = readOcrState()
    const live = list.filter(item => alive(item.pid))
    if (live.length !== list.length) writeOcrState(live)
    return live
  }

  /** 排队时算一次"这次要识别多少张图"：进度条的分母必须有个人先定下来。 */
  function ocrPlan(course, lesson = '') {
    try {
      const targets = listMaterials({ root: materialsRoot, course, lesson }).filter(item => item.ocrPending > 0)
      return {
        materials: targets.length,
        images: targets.reduce((sum, item) => sum + Number(item.ocrPending || 0), 0)
      }
    } catch { return { materials: 0, images: 0 } }
  }

  function queueOcr({ course, lesson }) {
    if (!workerPath || !course) return { queued: 0, reason: 'no_worker' }
    const pendingTask = runningOcr().find(item => item.course === course && item.lesson === (lesson || ''))
    if (pendingTask) return { queued: 0, reason: 'already_running' }

    const logDir = path.join(scratchRoot, 'ocr')
    fs.mkdirSync(logDir, { recursive: true })
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const stem = `${stamp}-${safeMaterialName(course)}-${safeMaterialName(lesson || 'course')}`
    const logPath = path.join(logDir, `${stem}.log`)
    // 识别进程把"做到哪一份了"写在这里（store.mjs 读 COURSE_OCR_PROGRESS_FILE）：
    // 它是脱离本进程跑的，管理台只能靠文件看它的进展
    const progressPath = path.join(logDir, `${stem}.progress.json`)
    const args = [
      workerPath, 'materials', '--ocr',
      '--course', course,
      ...(lesson ? ['--lesson', lesson] : [])
    ]
    let started
    try {
      started = spawnOcr({ args, env: { ...process.env, ...workerEnv, COURSE_OCR_PROGRESS_FILE: progressPath }, logPath })
    } catch (error) {
      return { queued: 0, reason: error instanceof Error ? error.message : String(error) }
    }
    writeOcrState([...readOcrState(), {
      course, lesson: lesson || '', pid: started.pid,
      startedAt: new Date(now()).toISOString(), logPath, progressPath,
      plan: ocrPlan(course, lesson)
    }])
    return { queued: 1, pid: started.pid, logPath, progressPath }
  }

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

  /**
   * 从 lesson-state 的调用轨迹里汇总 token 用量。
   *
   * 每一步模型调用的 usage 都留在状态文件里，所以"这节课花了多少钱"不用翻账单反推。
   * 注意 **finalNoteVersions 是 finalNote 的历史副本**：同一份 usage 会在两处出现，
   * 一起算就把最后那次拼装重复计一遍，因此显式跳过它。
   */
  function collectNoteUsage(lesson = {}) {
    const totals = { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    const add = (usage) => {
      if (!usage || typeof usage !== 'object' || !Number.isFinite(Number(usage.prompt_tokens))) return
      totals.calls += 1
      totals.inputTokens += Number(usage.prompt_tokens || 0)
      totals.outputTokens += Number(usage.completion_tokens || 0)
      totals.cachedTokens += Number(usage.prompt_tokens_details?.cached_tokens || 0)
      totals.reasoningTokens += Number(usage.completion_tokens_details?.reasoning_tokens || 0)
    }
    const addTrace = (holder) => add(holder?.trace?.usage)
    for (const trace of lesson.outlineTraces || []) add(trace?.usage || trace?.trace?.usage)
    for (const node of lesson.nodes || []) {
      for (const version of node.versions || []) addTrace(version)
      for (const report of node.reviewerReports || []) addTrace(report)
      for (const trace of node.reviseTraces || []) add(trace?.usage)
    }
    addTrace(lesson.finalNote?.assembly)
    for (const report of lesson.finalReviewReports || []) addTrace(report)
    return totals
  }

  /** 一节课的两笔钱：转写（按语音时长）与写笔记（按 token）。 */
  function lessonCostOf(task, lessonState, pricing) {
    const runtime = task?.runtime || {}
    const asrCny = Number.isFinite(Number(runtime.estimatedCostCny)) && Number(runtime.estimatedCostCny) > 0
      ? Number(runtime.estimatedCostCny)
      : asrCostCny({ seconds: Number(runtime.videoDurationSeconds || 0), pricing })
    const usage = lessonState?.usage || null
    const notesCny = usage
      ? noteCostCny({ inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, pricing })
      : 0
    return {
      asrCny: Number(asrCny.toFixed(4)),
      notesCny: Number(notesCny.toFixed(4)),
      totalCny: Number((asrCny + notesCny).toFixed(4)),
      usage: usage || null
    }
  }

  /**
   * 推送通道状态：微信会话（含是否过期）与备用通道配没配。
   *
   * 会话判定交给 describeWechatSession（纯函数、有固定时钟的测试），这里只负责
   * 把进程环境里的 OPENCLAW_* 喂进去——站点服务的环境变量来自 systemd 单元。
   */
  function channelHealth() {
    const session = wechatSessionState({
      stateDir: process.env.OPENCLAW_STATE_DIR || '',
      home: process.env.OPENCLAW_HOME || '',
      now: now()
    })
    return {
      ...describeWechatSession({ session, maxAgeMinutes: WECHAT_SESSION_MAX_AGE_MINUTES }),
      fallback: fallbackChannelState(),
      activation: WECHAT_ACTIVATION
    }
  }

  /**
   * 备用通道配了没。
   *
   * 站点进程的环境变量来自 systemd 单元，而推送的配置在 worker 的 env 文件里，
   * 两处都可能写着——所以两边都看。这里只判断"配没配齐"，绝不回显密钥。
   */
  function fallbackChannelState() {
    const file = path.join(scratchRoot, 'env')
    let fromFile = {}
    try {
      fromFile = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim()] }))
    } catch { fromFile = {} }
    const read = key => process.env[key] || fromFile[key] || ''
    // 界面上配的写在 config.json 里（键名与 EDITABLE_CONFIG 一致），优先于环境变量
    let runtime = {}
    try { runtime = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { runtime = {} }
    const kind = String(runtime.notifyFallback || read('COURSE_NOTIFY_FALLBACK') || '')
    const url = String(runtime.notifyFallbackUrl || read('COURSE_NOTIFY_FALLBACK_URL') || '')
    const key = String(runtime.notifyFallbackKey || read('SERVERCHAN_SENDKEY') || read('PUSHPLUS_TOKEN') || '')
    if (!kind) return { kind: '', configured: false }
    const needsUrl = ['wecom', 'dingtalk', 'feishu', 'bark', 'generic'].includes(kind)
    return { kind, configured: needsUrl ? Boolean(url) : Boolean(key) }
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
        usage: collectNoteUsage(lesson),
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
      // 已经有转录稿但还没课件：说明马上要写笔记了，这时补课件最有用。
      // **只对还没写笔记的课次提这件事**：已经发布/已写完的课次再提示"缺课件"是噪音，
      // 第一屏的待办一旦掺水，用户就不会再看它了。
      const waitingForNotes = task.stage === 'transcript_ready'
      if (waitingForNotes && !task.materials.length) {
        todos.missingMaterials.push({ replayKey: task.replayKey, courseName: task.courseName, title: task.title })
      }
    }
    return todos
  }

  function snapshot() {
    const pricing = resolvePricing(process.env)
    const qualityByLesson = contentQualityMap()
    const status = {
      generatedAt: new Date(now()).toISOString(),
      pricing,
      // 正在运行的状态要暴露出来：否则用户点完按钮看不到反馈，
      // 又在别处点一次会撞上 409 却不明白为什么
      running: running ? jobView(running) : null,
      queue: pendingJobs.map(job => jobView(job)),
      // 最近任务：进程内快照；服务重启就没了，持久阶段仍以账本为准。
      recentJobs: [...jobs.values()].slice(-12).reverse().map(job => jobView(job)),
      ledger: null,
      site: null,
      runs: []
    }
    // 活着的识别进程只查一次：逐课次去读那个文件等于把同一份 ocr-state.json 读 60 遍
    const liveOcr = runningOcr()
    // OCR 是后台任务，不能只挂在“当前选中的那节课”上。给状态页一份全局列表，
    // 运行面板因此能在用户切到别的课程以后继续显示哪份课件识别到哪里。
    status.ocrJobs = liveOcr.map(job => {
      let materials = []
      try { materials = listMaterials({ root: materialsRoot, course: job.course, lesson: job.lesson || '' }) } catch {}
      return {
        courseName: job.course || '',
        lesson: job.lesson || '',
        ...describeOcrProgress(job, materials)
      }
    })
    try {
      const store = openLedger(path.resolve(scratchRoot, 'ledger.sqlite'))
      try {
        const rawTasks = store.listTasks({ limit: 60 })
        const tasks = rawTasks.map(task => {
          const artifacts = task.artifacts || {}
          const lesson = readLessonState(task)
          const materials = task.course_name && task.title
            ? listMaterials({ root: materialsRoot, course: task.course_name, lesson: task.title, replayKey: task.replay_key })
            : []
          const ocrJob = liveOcr.find(item => item.course === task.course_name && item.lesson === (task.title || '')) || null
          const materialList = materials.map(item => ({
            name: item.name,
            scope: item.scope,
            slideCount: item.slideCount,
            // 图片与待识别数量要露出来：详情面板据此说明"图片版课件还有几张图没识别"
            imageCount: item.imageCount || 0,
            ocrPending: item.ocrPending || 0,
            ocrEngine: item.ocr?.engine || '',
            addedAt: item.addedAt,
            bytes: item.bytes || 0,
            kind: String(item.name || '').slice(String(item.name || '').lastIndexOf('.') + 1).toLowerCase()
          }))
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
            // 后台正在识别图片文字：界面据此显示进度，而不是让人以为要点按钮
            ocrRunning: Boolean(ocrJob),
            ocr: ocrJob ? describeOcrProgress(ocrJob, materialList) : null,
            materials: materialList,
            lesson,
            cost: lessonCostOf(task, lesson, pricing),
            quality: qualityByLesson.get(String(task.course_name || '') + '\u0000' + String(task.title || '')) || null
          }
        })
        status.spend = tasks.reduce((sum, task) => ({
          asrCny: Number((sum.asrCny + (task.cost?.asrCny || 0)).toFixed(4)),
          notesCny: Number((sum.notesCny + (task.cost?.notesCny || 0)).toFixed(4)),
          totalCny: Number((sum.totalCny + (task.cost?.totalCny || 0)).toFixed(4))
        }), { asrCny: 0, notesCny: 0, totalCny: 0 })
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

  // 动作 → argv 的映射放在模块级：测试要能直接拿它逐条核对界面发出的每个动作
  const argsFor = (action, payload) => buildActionArgs(action, payload, workerPath)

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
      // 网页鉴权统一由 law-tech SSO 提供；主令牌只保留给服务器内部调用。
      snap.auth = { provider: 'law-tech', masterTokenSet: Boolean(activeToken) }
      // 微信通道：主动推送需要用户最近和机器人有过互动，界面要把这件事说清楚
      snap.channel = channelHealth()
      snap.tags = readTags(scratchRoot)
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
    /**
     * 分片上传。
     *
     * 为什么需要：Cloudflare 隧道对大请求体会中途掐断——实测 20MB 的 PUT 传到 12MB
     * 时连接被关（客户端只看到「上传失败」，服务端一个字节都没落盘）。用户上传的
     * PPT 动辄二三十兆，所以大文件必须切小走：每个分片几百 KB，单个请求又快又小，
     * 隧道的限制就碰不到了。
     *
     * 两段式：PUT .../chunk 落分片 → POST .../commit 合并并归档。
     * 分片只写在 scratchRoot/tmp/uploads/<id>/ 下，id 走白名单字符集，杜绝路径穿越。
     */
    if (pathname === `${ADMIN_PREFIX}materials/chunk` && req.method === 'PUT') {
      const uploadId = String(url.searchParams.get('uploadId') || '')
      const index = Number(url.searchParams.get('index'))
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(uploadId)) {
        sendJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return true
      }
      if (!Number.isInteger(index) || index < 0 || index > 4000) {
        sendJson(res, 400, { ok: false, error: 'bad_chunk_index' })
        return true
      }
      let bytes
      try {
        // 单片的硬上限：切分逻辑用 1MB，这里留 8 倍余量，防止有人拿它当无限制上传用
        bytes = await readBinary(req, 8 * 1024 * 1024)
      } catch (error) {
        // 先把话说清楚再断开：直接 destroy 会让 nginx 把这次请求报成 502，
        // 用户看到的是"网关错误"，而真正的原因是这一片太大了。
        sendJson(res, 413, { ok: false, error: 'chunk_too_large', message: error.message })
        setImmediate(() => { try { req.destroy() } catch {} })
        return true
      }
      const dir = path.join(scratchRoot, 'tmp', 'uploads', uploadId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${String(index).padStart(5, '0')}.part`), bytes)
      const received = fs.readdirSync(dir).filter(name => name.endsWith('.part')).length
      sendJson(res, 200, { ok: true, uploadId, index, bytes: bytes.length, received })
      return true
    }

    /**
     * 放弃一次分片上传。
     *
     * 取消上传时客户端不再发后续分片，已经落盘的几片就留在 tmp 里等清理——与其等
     * 下一次 prune，不如让取消这个动作把它收干净（用户点了取消，就该什么都没留下）。
     */
    if (pathname === `${ADMIN_PREFIX}materials/chunk` && req.method === 'DELETE') {
      const uploadId = String(url.searchParams.get('uploadId') || '')
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(uploadId)) {
        sendJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return true
      }
      fs.rmSync(path.join(scratchRoot, 'tmp', 'uploads', uploadId), { recursive: true, force: true })
      sendJson(res, 200, { ok: true, canceled: true, uploadId })
      return true
    }

    if (pathname === `${ADMIN_PREFIX}materials/commit` && req.method === 'POST') {
      let payload = {}
      try {
        payload = safeJson(await readBody(req, 256 * 1024)) || {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_body', message: error.message })
        return true
      }
      const uploadId = String(payload.uploadId || '')
      const course = String(payload.course || '').trim()
      const lesson = String(payload.lesson || '').trim()
      const scope = String(payload.scope || 'lesson').trim()
      const name = safeMaterialName(payload.name || 'slides.pptx')
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(uploadId)) {
        sendJson(res, 400, { ok: false, error: 'bad_upload_id' })
        return true
      }
      if (!course || (scope !== 'course' && !lesson)) {
        sendJson(res, 400, { ok: false, error: 'missing_target', message: '分片齐了但没说清这份课件属于哪节课' })
        return true
      }
      const dir = path.join(scratchRoot, 'tmp', 'uploads', uploadId)
      const parts = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(item => item.endsWith('.part')).sort()
        : []
      const expected = Number(payload.chunks || 0)
      // 少一片就合并出半个文件，解析时报"不是 zip"之类莫名其妙的话。
      // 所以按片号核对齐全再合并——错要说在能看懂的地方。
      const indexes = parts.map(name => Number(name.slice(0, 5)))
      const missing = expected > 0
        ? Array.from({ length: expected }, (_, i) => i).filter(i => !indexes.includes(i))
        : []
      if (!parts.length || missing.length) {
        sendJson(res, 400, {
          ok: false,
          error: 'incomplete_upload',
          message: missing.length ? `缺 ${missing.length} 个分片（${missing.slice(0, 8).join('、')}…），请重试` : '没有收到任何分片',
          received: parts.length,
          expected
        })
        return true
      }
      const tempDir = path.join(scratchRoot, 'tmp')
      fs.mkdirSync(tempDir, { recursive: true })
      const tempPath = path.join(tempDir, `upload-${Date.now()}-${name}`)
      try {
        fs.writeFileSync(tempPath, Buffer.alloc(0))
        for (const part of parts) {
          fs.appendFileSync(tempPath, fs.readFileSync(path.join(dir, part)))
        }
        const result = await addMaterial({
          root: materialsRoot,
          course,
          lesson: scope === 'course' ? '' : lesson,
          scope,
          appliesTo: Array.isArray(payload.appliesTo) ? payload.appliesTo : [],
          filePath: tempPath,
          name
        })
        sendJson(res, 200, {
          ok: true,
          course,
          lesson: scope === 'course' ? '（全课程通用）' : lesson,
          scope,
          name: result.entry.name,
          slideCount: result.deck.slideCount,
          bytes: result.entry.bytes,
          chunks: parts.length,
          checksum: result.entry.checksum.slice(0, 12),
          // 课件里有图就自动排队识别：不用点按钮，也不用把上传请求拖成几分钟
          ocr: result.entry.ocrPending > 0
            ? queueOcr({ course, lesson: scope === 'course' ? '' : lesson })
            : { queued: 0, reason: 'no_images' },
          ocrPending: result.entry.ocrPending || 0,
          imageCount: result.entry.imageCount || 0
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'material_failed', message: error instanceof Error ? error.message : String(error) })
      } finally {
        fs.rmSync(tempPath, { force: true })
        fs.rmSync(dir, { recursive: true, force: true })
      }
      return true
    }

    /** 删除一份已归档的课件：原件、解析结果、meta.json 里的那一条一起清。 */
    if (pathname === `${ADMIN_PREFIX}materials` && req.method === 'DELETE') {
      const course = String(url.searchParams.get('course') || '').trim()
      const lesson = String(url.searchParams.get('lesson') || '').trim()
      const scope = String(url.searchParams.get('scope') || 'lesson').trim()
      const name = String(url.searchParams.get('name') || '').trim()
      if (!course || !name) {
        sendJson(res, 400, { ok: false, error: 'missing_target', message: '要说清删哪门课的哪份课件' })
        return true
      }
      try {
        const result = removeMaterial({ root: materialsRoot, course, lesson, scope, name })
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(res, 404, { ok: false, error: 'material_not_found', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

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
          checksum: result.entry.checksum.slice(0, 12),
          // 课件里有图就自动排队识别：不用点按钮，也不用把上传请求拖成几分钟
          ocr: result.entry.ocrPending > 0
            ? queueOcr({ course, lesson: scope === 'course' ? '' : lesson })
            : { queued: 0, reason: 'no_images' },
          ocrPending: result.entry.ocrPending || 0,
          imageCount: result.entry.imageCount || 0
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'material_failed', message: error instanceof Error ? error.message : String(error) })
      } finally {
        fs.rmSync(tempPath, { force: true })
      }
      return true
    }


    /** 标签：界面上手动打的，存在服务器上（不是浏览器）。 */
    if (pathname === `${ADMIN_PREFIX}tags`) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...readTags(scratchRoot) })
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
        const next = normalizeTags(payload, readTags(scratchRoot))
        writeTags(scratchRoot, next)
        sendJson(res, 200, { ok: true, ...next })
        return true
      }
    }

    /** 存储占用：按类别给数字，界面上画成条状图。 */
    if (pathname === `${ADMIN_PREFIX}storage`) {
      sendJson(res, 200, { ok: true, ...storageReport(scratchRoot) })
      return true
    }

    /**
     * 内容版本与章级整合。
     *
     * 这里只负责“看状态 / 改 manifest”；真正的 release 切换和整合重建仍走 /run → worker CLI，
     * 这样管理台没有第二套发布实现。
     */
    if (pathname === `${ADMIN_PREFIX}content` && req.method === 'GET') {
      try {
        sendJson(res, 200, contentAdminReport({ root, scratchRoot }))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'content_state_failed', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }


    if (pathname === `${ADMIN_PREFIX}topics` && (req.method === 'PUT' || req.method === 'POST')) {
      let payload = {}
      try {
        payload = safeJson(await readBody(req)) || {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_body', message: error.message })
        return true
      }
      try {
        const current = readTopicManifestState(scratchRoot)
        const next = upsertTopicDefinition(current, payload.definition || payload)
        const saved = writeTopicManifestState(scratchRoot, next)
        sendJson(res, 200, {
          ok: true,
          manifest: saved.manifest,
          content: contentAdminReport({ root, scratchRoot })
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'invalid_topic', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

    if (pathname === `${ADMIN_PREFIX}topics` && req.method === 'DELETE') {
      const id = String(url.searchParams.get('id') || '').trim()
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'missing_topic_id' })
        return true
      }
      try {
        const current = readTopicManifestState(scratchRoot)
        const next = removeTopicDefinition(current, id)
        if (!next.removed) {
          sendJson(res, 404, { ok: false, error: 'topic_not_found', id })
          return true
        }
        const saved = writeTopicManifestState(scratchRoot, next)
        const removedArtifacts = removeTopicArtifact(scratchRoot, id)
        sendJson(res, 200, {
          ok: true,
          removed: id,
          removedArtifacts,
          manifest: saved.manifest,
          content: contentAdminReport({ root, scratchRoot })
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'topic_delete_failed', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

    if (pathname === `${ADMIN_PREFIX}integrations` && (req.method === 'PUT' || req.method === 'POST')) {
      let payload = {}
      try {
        payload = safeJson(await readBody(req)) || {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_body', message: error.message })
        return true
      }
      try {
        const current = readIntegrationManifestState(scratchRoot)
        const next = upsertIntegrationDefinition(current, payload.definition || payload)
        const saved = writeIntegrationManifestState(scratchRoot, next)
        sendJson(res, 200, {
          ok: true,
          manifest: saved.manifest,
          content: contentAdminReport({ root, scratchRoot })
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'invalid_integration', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

    if (pathname === `${ADMIN_PREFIX}integrations` && req.method === 'DELETE') {
      const id = String(url.searchParams.get('id') || '').trim()
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'missing_integration_id' })
        return true
      }
      try {
        const current = readIntegrationManifestState(scratchRoot)
        const next = removeIntegrationDefinition(current, id)
        if (!next.removed) {
          sendJson(res, 404, { ok: false, error: 'integration_not_found', id })
          return true
        }
        const saved = writeIntegrationManifestState(scratchRoot, next)
        const removedArtifacts = removeIntegrationArtifacts(scratchRoot, id)
        sendJson(res, 200, {
          ok: true,
          removed: id,
          removedArtifacts,
          manifest: saved.manifest,
          content: contentAdminReport({ root, scratchRoot })
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'integration_delete_failed', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

    /**
     * 课件文字预览。
     *
     * 预览用的是**解析出来的每页文字**，不是把 PPT 渲染成图——几十兆的原件在浏览器里
     * 渲染既慢又没必要：用户要看的是"这一页讲了什么"。
     */
    if (pathname === `${ADMIN_PREFIX}material`) {
      const course = String(url.searchParams.get('course') || '').trim()
      const lesson = String(url.searchParams.get('lesson') || '').trim()
      const name = String(url.searchParams.get('name') || '').trim()
      // 一次给一屏（默认 8 页），要看全就带 offset 继续拿：一份 80 页的课件
      // 一次全塞进响应既慢又没人真的一口气读完，但"只能看 8 页"更糟
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('pages') || 8)))
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
      if (!course) {
        sendJson(res, 400, { ok: false, error: 'missing_course' })
        return true
      }
      try {
        const decks = readDecks({ root: materialsRoot, course, lesson })
        const deck = decks.find(item => item.name === name) || decks[0]
        if (!deck) {
          sendJson(res, 404, { ok: false, error: 'no_material' })
          return true
        }
        const slides = deck.slides || []
        sendJson(res, 200, {
          ok: true,
          name: deck.name,
          scope: deck.scope,
          slideCount: deck.slideCount || slides.length,
          addedAt: deck.addedAt || null,
          bytes: deck.bytes || 0,
          offset,
          hasMore: offset + limit < slides.length,
          pages: slides.slice(offset, offset + limit).map(slide => ({ slideNumber: slide.slideNumber, text: String(slide.text || '').slice(0, 2000) }))
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'material_unreadable', message: error instanceof Error ? error.message : String(error) })
      }
      return true
    }

    if (pathname === `${ADMIN_PREFIX}run` && req.method === 'POST') {
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
        args = argsFor(action, payload)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'bad_arguments', message: error instanceof Error ? error.message : String(error) })
        return true
      }

      const job = enqueueJob(action, args, payload)

      sendJson(res, 202, {
        ok: true,
        accepted: true,
        jobId: job.id,
        ...jobView(job),
        poll: ADMIN_PREFIX + 'job?id=' + job.id
      })
      return true
    }

    /** 查询长动作的状态：`GET /api/admin/job?id=…`。 */
    if (pathname === `${ADMIN_PREFIX}job` && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '').trim()
      const job = jobs.get(id)
      if (!job) {
        sendJson(res, 404, {
          ok: false,
          error: 'job_not_found',
          message: '进程内只保留最近 30 个任务、重启即清空；持久阶段仍以账本为准'
        })
        return true
      }
      sendJson(res, 200, { ok: true, ...jobView(job, true) })
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
        // 这个文件可能存着备用通道的密钥（SendKey / token）：只给自己读
        fs.chmodSync(configPath(), 0o600)
        sendJson(res, 200, { ok: true, values: next, applied: Object.keys(clean) })
        return true
      }
    }

    sendJson(res, 404, { ok: false, error: 'unknown_admin_route', path: pathname })
    return true
  }


  async function handleAccountApi(req, res, pathname, url, session) {
    if (!pathname.startsWith('/api/account/')) return false
    if (!session) {
      sendJson(res, 401, { ok: false, error: 'account_session_required' })
      return true
    }
    try {
      if (req.method === 'GET' && pathname === '/api/account/workspace') {
        sendJson(res, 200, await accountWorkspace(session))
        return true
      }
      if (req.method === 'GET' && pathname === '/api/account/status') {
        const result = await controlCall(session, { target: '/v1/account/status' })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/mcp-token') {
        const token = issueMcpAccessToken(session, ssoKey, Math.floor(now() / 1000))
        sendJson(res, 200, {
          ok: true,
          token,
          expiresInSeconds: COURSE_MCP_TOKEN_TTL_SECONDS,
          endpoint: '/mcp'
        }, { 'cache-control': 'private, no-store' })
        return true
      }
      if (req.method === 'GET' && pathname === '/api/account/note') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) { sendJson(res, 400, { ok: false, error: 'note_id_required' }); return true }
        const result = await controlCall(session, { target: '/v1/private/note?id=' + encodeURIComponent(id) })
        sendJson(res, result.status, result.payload, { 'cache-control': 'private, no-store' })
        return true
      }
      if (req.method === 'PUT' && pathname === '/api/account/notification-email') {
        const body = safeJson(await readBody(req)) || {}
        const result = await controlCall(session, {
          method: 'PUT',
          target: '/v1/account/notification-email',
          body: { email: String(body.email || '') }
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && pathname === '/api/account/credential') {
        let target = '/v1/account/credential'
        let body = null
        if (req.method === 'PUT') {
          body = safeJson(await readBody(req)) || {}
        } else {
          const provider = String(url.searchParams.get('provider') || '').trim()
          if (!provider) { sendJson(res, 400, { ok: false, error: 'provider_required' }); return true }
          target += '?provider=' + encodeURIComponent(provider)
        }
        const result = await controlCall(session, { method: req.method, target, body })
        sendJson(res, result.status, result.payload)
        return true
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && pathname === '/api/account/pku/password') {
        const body = req.method === 'PUT' ? (safeJson(await readBody(req)) || {}) : null
        const result = await controlCall(session, {
          method: req.method,
          target: '/v1/account/pku/password',
          body
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'PUT' && pathname === '/api/account/pku/selection') {
        const body = safeJson(await readBody(req)) || {}
        const result = await controlCall(session, {
          method: 'PUT',
          target: '/v1/account/pku/selection',
          body: {
            selectedCourseKeys: Array.isArray(body.selectedCourseKeys) ? body.selectedCourseKeys : [],
            autoSyncEnabled: body.autoSyncEnabled === true
          }
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/pku/qr/start') {
        const result = await controlCall(session, {
          method: 'POST',
          target: '/v1/account/pku/qr/start',
          body: {}
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'GET' && pathname === '/api/account/pku/qr/status') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) { sendJson(res, 400, { ok: false, error: 'qr_id_required' }); return true }
        const result = await controlCall(session, {
          target: '/v1/account/pku/qr/status?id=' + encodeURIComponent(id)
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/discover') {
        const payload = safeJson(await readBody(req)) || {}
        const result = await controlCall(session, {
          method: 'POST',
          target: '/v1/jobs/discover',
          body: { courseKey: String(payload.courseKey || '') }
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/sync') {
        const payload = safeJson(await readBody(req)) || {}
        const result = await controlCall(session, {
          method: 'POST',
          target: '/v1/jobs/sync',
          body: { maxTasks: Math.max(1, Math.min(5, Number(payload.maxTasks || 3))) }
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/topics/generate') {
        const payload = safeJson(await readBody(req)) || {}
        const courseName = String(payload.courseName || '').trim()
        if (!courseName) { sendJson(res, 400, { ok: false, error: 'course_required' }); return true }
        const result = await controlCall(session, {
          method: 'POST',
          target: '/v1/jobs/topics',
          body: { courseName }
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/topics/rebuild') {
        const payload = safeJson(await readBody(req)) || {}
        const courseName = String(payload.courseName || '').trim()
        const topicId = String(payload.topicId || '').trim()
        if (!courseName) { sendJson(res, 400, { ok: false, error: 'course_required' }); return true }
        const result = await controlCall(session, {
          method: 'POST',
          target: '/v1/jobs/topics',
          body: { courseName, topicId, rebuild: true }
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'DELETE' && pathname === '/api/account/topic') {
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) { sendJson(res, 400, { ok: false, error: 'topic_id_required' }); return true }
        const result = await controlCall(session, {
          method: 'DELETE',
          target: '/v1/private/topic?id=' + encodeURIComponent(id)
        })
        sendJson(res, result.status, result.payload)
        return true
      }
      if (req.method === 'POST' && pathname === '/api/account/import-owner-library') {
        if (session.role !== 'owner') {
          sendJson(res, 403, { ok: false, error: 'owner_required' })
          return true
        }
        const libraryFile = path.join(root, 'library.json')
        const records = readJsonSafe(libraryFile, [])
        if (!Array.isArray(records)) throw new Error('当前发布库不可读')
        let notes = 0
        for (const record of records) {
          const payload = {
            replayKey: String(record.replayKey || record.slug || ''),
            courseName: String(record.courseName || ''),
            lessonTitle: String(record.lessonTitle || ''),
            lessonDate: String(record.lessonDate || ''),
            slug: String(record.slug || ''),
            checksum: String(record.checksum || ''),
            markdown: String(record.markdown || ''),
            silent: true,
            index: Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'markdown'))
          }
          if (!payload.replayKey || !payload.markdown) continue
          const result = await controlCall(session, { method: 'PUT', target: '/v1/private/note', body: payload })
          if (!result.ok) throw Object.assign(new Error(result.payload?.error || '导入笔记失败'), { status: result.status })
          notes += 1
        }
        let topics = 0
        const topicDir = path.join(scratchRoot, 'topics')
        if (fs.existsSync(topicDir)) {
          for (const entry of fs.readdirSync(topicDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue
            const artifact = readJsonSafe(path.join(topicDir, entry.name), null)
            if (!artifact || artifact.kind !== 'course-topic' || !artifact.id) continue
            const result = await controlCall(session, {
              method: 'PUT',
              target: '/v1/private/topic',
              body: {
                topicId: artifact.id,
                courseName: artifact.course,
                title: artifact.title,
                summary: artifact.summary || '',
                artifact,
                markdown: renderTopicMarkdown(artifact, { notes: records })
              }
            })
            if (!result.ok) throw Object.assign(new Error(result.payload?.error || '导入专题失败'), { status: result.status })
            topics += 1
          }
        }
        sendJson(res, 200, { ok: true, imported: { notes, topics } })
        return true
      }
      sendJson(res, 404, { ok: false, error: 'unknown_account_route', path: pathname })
      return true
    } catch (error) {
      sendJson(res, Number(error?.status) || 502, {
        ok: false,
        error: 'account_control_failed',
        message: error instanceof Error ? error.message : String(error)
      })
      return true
    }
  }

  return {
    /** @returns {boolean} 是否已处理该请求 */
    async handle(req, res, pathname, url, { adminToken } = {}) {
      const nowSeconds = Math.floor(now() / 1000)

      if (pathname === '/_auth/callback') {
        const ticket = verifyEnvelope(url.searchParams.get('token'), ssoKey, 'course-sso-v1', nowSeconds)
        if (!ticket || !['owner', 'member'].includes(ticket.role)) {
          res.writeHead(302, { location: ssoLocation('/'), 'cache-control': 'no-store' })
          res.end()
          return true
        }
        const next = safeCoursePath(ticket.next, '/')
        const session = {
          v: 1,
          sub: ticket.sub,
          role: ticket.role,
          email: ticket.email || '',
          iat: nowSeconds,
          exp: nowSeconds + COURSE_SESSION_TTL_SECONDS
        }
        const destination = next
        res.writeHead(302, {
          location: destination,
          'set-cookie': sessionCookie(session, ssoKey),
          'cache-control': 'no-store'
        })
        res.end()
        return true
      }

      const session = verifyEnvelope(
        cookieValue(req, COURSE_SESSION_COOKIE),
        ssoKey,
        'course-session-v1',
        nowSeconds
      )

      if (pathname === '/_auth/start') {
        const next = safeCoursePath(url.searchParams.get('next'), '/')
        const destination = session ? next : ssoLocation(next)
        res.writeHead(302, { location: destination, 'cache-control': 'no-store' })
        res.end()
        return true
      }

      if (pathname === '/_auth/session') {
        sendJson(res, 200, {
          authenticated: Boolean(session),
          role: session?.role || '',
          email: session?.email || ''
        })
        return true
      }

      if (pathname.startsWith('/api/account/')) {
        return handleAccountApi(req, res, pathname, url, session)
      }

      if (pathname === '/admin' || pathname === '/admin/') {
        const host = String(req.headers.host || '').split(':')[0]
        if (host === 'cf.law-tech.dev') {
          res.writeHead(302, { location: 'https://course.law-tech.dev/', 'cache-control': 'no-store' })
          res.end()
          return true
        }
        if (!session) {
          res.writeHead(302, { location: ssoLocation('/admin'), 'cache-control': 'no-store' })
          res.end()
          return true
        }
        const body = Buffer.from(session.role === 'owner' ? ADMIN_HTML : MEMBER_ADMIN_HTML)
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

      const provided = String(req.headers['x-course-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '')
      const byMasterToken = Boolean(activeToken) && provided === activeToken
      const byOwnerSession = session?.role === 'owner'
      if (!byMasterToken && !byOwnerSession) {
        recordFailure(req)
        sendJson(res, 401, { ok: false, error: 'unauthorized' })
        return true
      }

      await handleApi(req, res, pathname, url)
      return true
    }
  }
}

/**
 * 默认的"后台起一个 worker 进程"：脱离父进程，日志落到文件。
 * 抽成参数是为了让测试与点击审计能替换掉它——它们不该真的拉起一个 worker。
 */
export function defaultSpawnOcr({ args, env = {}, logPath }) {
  const out = fs.openSync(logPath, 'a')
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env })
    child.unref()
    return { pid: child.pid }
  } finally {
    fs.closeSync(out)
  }
}

/** 默认运行方式：以子进程调用 course CLI，复用与定时任务完全相同的入口。 */
function defaultRunCommand(args, { env = {}, timeoutMs = DEFAULT_RUN_TIMEOUT_MS } = {}) {
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
