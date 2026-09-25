import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanText } from '@course/core'

/**
 * 课件（PPT）归档与解析。
 *
 * 教学网上没有课件，课件只在用户手里，因此这条链路要能回答三个问题：
 *   1. **归属**：这门课、这一课次，还是跨课次共用（上一讲的 PPT 这讲接着用）？
 *   2. **稳定标识**：课次标题会变（老师改个名、平台补个日期），所以真正的键是 replayKey；
 *      标题只作兜底匹配。
 *   3. **随时补传**：课件晚到一步也要能用——补传后用 `notes --revise` 只重写受影响模块。
 *
 * 目录形状（scope = course 的放在 course/ 下，全课程通用）：
 *   <root>/<课程>/course/            全课程通用课件 + meta.json
 *   <root>/<课程>/<课次>/            该课次课件 + meta.json
 *   <root>/_unassigned/              归属不明的文件（不猜，列出来让人指定）
 */

const PYTHON_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'python', 'extract_slides.py')

/** 文件名/目录名安全化：课程名与课次里常有斜杠、冒号、空格。 */
export function safeSegment(value, fallback = 'unnamed') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80) || fallback
}

/** 全课程通用课件的固定目录名。 */
export const COURSE_SCOPE_DIR = 'course'

export function courseMaterialDir({ root, course }) {
  if (!root) throw new Error('缺少课件归档根目录')
  return path.join(path.resolve(root), safeSegment(course, 'course'))
}

export function materialDir({ root, course, lesson }) {
  if (!root) throw new Error('缺少课件归档根目录')
  if (!lesson) return path.join(courseMaterialDir({ root, course }), COURSE_SCOPE_DIR)
  return path.join(courseMaterialDir({ root, course }), safeSegment(lesson, 'lesson'))
}

function defaultRunPython({ python = 'python3', args, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

/** 解析一个 pptx（或已解析好的 json）。返回 {slideCount, slides:[{slideNumber,text}]}。 */
export async function extractSlides({ filePath, runPython = defaultRunPython, python = 'python3', env = process.env } = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`找不到课件文件：${filePath}`)
  if (path.extname(filePath).toLowerCase() === '.json') {
    return normalizeDeck(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  }
  const result = await runPython({
    python,
    args: [PYTHON_SCRIPT, path.resolve(filePath)],
    env: { ...env, PYTHONIOENCODING: 'utf-8' }
  })
  if (result.code !== 0) {
    throw new Error(`课件解析失败（${path.basename(filePath)}）：${cleanText(result.stderr) || `退出码 ${result.code}`}`)
  }
  return normalizeDeck(JSON.parse(result.stdout))
}

export function normalizeDeck(value = {}) {
  const slides = (Array.isArray(value.slides) ? value.slides : [])
    .map((slide, index) => ({
      slideNumber: Number(slide?.slideNumber || index + 1),
      text: cleanText(slide?.text || '')
    }))
    .filter(slide => slide.text)
    .sort((left, right) => left.slideNumber - right.slideNumber)
  return { slideCount: slides.length, slides }
}

function readMeta(dir) {
  const metaPath = path.join(dir, 'meta.json')
  if (!fs.existsSync(metaPath)) return { materials: [] }
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return { materials: [] }
  }
}

/**
 * 收下一个课件：归档原件 + 解析出 json + 记元数据。
 *
 * @param scope       'lesson'（默认，只给这一课次）| 'course'（全课程通用）
 * @param appliesTo   跨课次共用的课次标题列表（上一讲的 PPT 这讲继续用时填这里）
 * @param replayKey   该课次的稳定标识；标题改名后仍能对上
 */
export async function addMaterial({
  root, course, courseKey = '', lesson = '', replayKey = '', scope = 'lesson', appliesTo = [],
  filePath, name,
  runPython = defaultRunPython, python = 'python3', env = process.env, at = new Date()
} = {}) {
  const effectiveScope = scope === 'course' ? 'course' : 'lesson'
  const dir = materialDir({ root, course, lesson: effectiveScope === 'course' ? '' : lesson })
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
  const fileName = safeSegment(name || path.basename(filePath), 'slides.pptx')
  const target = path.join(dir, fileName)
  const bytes = fs.readFileSync(filePath)
  fs.writeFileSync(target, bytes)
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex')

  const deck = await extractSlides({ filePath: target, runPython, python, env })
  const parsedPath = path.join(dir, 'slides', `${fileName}.json`)
  fs.writeFileSync(parsedPath, `${JSON.stringify({ ...deck, source: fileName, checksum }, null, 2)}\n`)

  const meta = readMeta(dir)
  const entry = {
    name: fileName,
    scope: effectiveScope,
    course,
    courseKey,
    lesson: effectiveScope === 'course' ? '' : lesson,
    replayKey: effectiveScope === 'course' ? '' : replayKey,
    appliesTo: effectiveScope === 'course' ? [] : (Array.isArray(appliesTo) ? appliesTo.filter(Boolean) : []),
    bytes: bytes.length,
    checksum,
    slideCount: deck.slideCount,
    parsedPath,
    addedAt: at.toISOString()
  }
  meta.materials = [...(meta.materials || []).filter(item => item.name !== fileName), entry]
  meta.updatedAt = at.toISOString()
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return { dir, entry, deck }
}

/** 扫这门课下所有课次目录里的课件元数据（跨课次共用要能引用别的课次的文件）。 */
function allLessonMaterials({ root, course }) {
  const base = courseMaterialDir({ root, course })
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== COURSE_SCOPE_DIR && !entry.name.startsWith('_'))
    .flatMap(entry => readMeta(path.join(base, entry.name)).materials || [])
}

/** 某课次该加载哪些课件：全课程通用 + 本课次 + 显式声明适用本课次的跨课次课件。 */
export function listMaterials({ root, course, lesson = '', replayKey = '' } = {}) {
  const lessonScoped = lesson ? readMeta(materialDir({ root, course, lesson })).materials || [] : []
  const courseScoped = readMeta(materialDir({ root, course, lesson: '' })).materials || []
  const shared = lesson
    ? allLessonMaterials({ root, course }).filter(item => (item.appliesTo || []).includes(lesson))
    : []
  // 归属判定：replayKey（稳定）优先，其次课次标题，最后看"显式声明适用于哪些课次"。
  // 三条是"或"的关系——上一讲的 PPT 这一讲接着用时，它既不属于本课次目录，
  // 也不共享 replayKey，只能靠 appliesTo 匹配上。
  const applies = (item) => {
    if (!item) return false
    if (replayKey && item.replayKey === replayKey) return true
    if (lesson && item.lesson === lesson) return true
    return Boolean(lesson) && (item.appliesTo || []).includes(lesson)
  }
  const seen = new Set()
  return [...courseScoped, ...lessonScoped, ...shared].filter(item => {
    // 同名文件只保留一份（同一份课件可能既在本课次目录、又被别的课次声明共用）
    const key = `${item.name}:${item.checksum || ''}`
    if (item.scope === 'course') {
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    if (item.lesson === lesson || applies(item)) {
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    return false
  })
}

/** 读出这一课次可用于模型调用的课件文本（形状与 lesson.pptText 一致）。 */
export function readDecks({ root, course, lesson = '', replayKey = '' } = {}) {
  return listMaterials({ root, course, lesson, replayKey })
    .map(item => {
      if (!item.parsedPath || !fs.existsSync(item.parsedPath)) return null
      const parsed = JSON.parse(fs.readFileSync(item.parsedPath, 'utf8'))
      return { name: item.name, scope: item.scope || 'lesson', slides: parsed.slides || [] }
    })
    .filter(deck => deck && deck.slides.length)
}

/**
 * 文件名 → 归属。
 *   `课程__课次.pptx`  → 该课次
 *   `课程__ALL.pptx`   → 全课程通用
 * 其余一律返回 null：归属不明时**不猜**，进 _unassigned 让人指定。
 */
export function parseInboxName(fileName) {
  const base = path.basename(String(fileName || ''))
  const match = base.match(/^(.+?)__(.+?)(\.[A-Za-z0-9]+)?$/)
  if (!match) return null
  const course = match[1].trim()
  const scopeRaw = match[2].trim()
  const extension = match[3] || ''
  if (!course || !scopeRaw) return null
  if (/^(all|ALL|全部|全课程)$/.test(scopeRaw)) {
    return { course, lesson: '', scope: 'course', extension }
  }
  return { course, lesson: scopeRaw, scope: 'lesson', extension }
}

/**
 * 从文件名猜归属——**只在有把握时给答案**。
 *
 * 严格的 `课程__课次.pptx` 命名对用户太麻烦（尤其是从微信/邮箱下载下来的文件名）。
 * 这里改用"跟账本里已有的课程与课次对一下"：
 *   · 文件名里出现某门课程的名字 → 课程确定；
 *   · 再在里面找课次：完整标题、日期（2026-09-30 / 09-30）、或"第N-M节"；
 *   · 课程与课次都确定才返回 canAutoAssign，否则只报"匹配到了什么"，由人确认。
 * 猜错的代价是笔记用错课件，比让人点一下贵得多，所以这里宁可返回不确定。
 */
export function guessMaterialIdentity(fileName, { courses = [], lessons = [] } = {}) {
  const raw = path.basename(String(fileName || ''))
  const base = raw.replace(/\.[A-Za-z0-9]+$/, '')
  const compact = base.replace(/[\s_\-—·、,，()（）\[\]【】]+/g, '')

  // 课程匹配：允许简称（"实证分析" 对 "法律实证分析"）。
  // 用最长公共子串而不是"包含"：用户从微信下载的文件名常把课程名截短。
  const longestCommon = (left, right) => {
    let best = 0
    for (let start = 0; start < left.length; start += 1) {
      for (let length = best + 1; start + length <= left.length; length += 1) {
        if (right.includes(left.slice(start, start + length))) best = length
        else break
      }
    }
    return best
  }
  const course = courses.find(name => {
    const key = String(name || '').replace(/\s+/g, '')
    if (!key || !compact) return false
    if (compact.includes(key) || key.includes(compact)) return true
    return longestCommon(key, compact) >= Math.max(3, Math.ceil(key.length / 2))
  }) || null

  const candidates = lessons.filter(item => !course || !item.course || item.course === course)
  const lesson = candidates.find(item => {
    const title = String(item.lesson || item.title || '').replace(/\s+/g, '')
    if (!title) return false
    if (compact.includes(title) || title.includes(compact)) return true
    // 日期：2026-09-30 / 20260930 / 09-30
    const date = title.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (date) {
      const [, year, month, day] = date
      const forms = [`${year}-${month}-${day}`, `${year}${month}${day}`, `${month}-${day}`, `${month}${day}`]
      if (forms.some(form => compact.includes(form.replace(/-/g, '')) || compact.includes(form))) return true
    }
    // 节次：第5-6节 / 第56节
    const period = title.match(/第(\d+)-(\d+)节/)
    if (period) {
      const forms = [`第${period[1]}-${period[2]}节`, `第${period[1]}${period[2]}节`, `${period[1]}-${period[2]}节`]
      if (forms.some(form => compact.includes(form.replace(/-/g, '')) || compact.includes(form))) return true
    }
    return false
  }) || null

  return {
    file: raw,
    course,
    lesson: lesson ? (lesson.lesson || lesson.title || '') : '',
    replayKey: lesson?.replayKey || '',
    canAutoAssign: Boolean(course && lesson),
    reason: !course ? '文件名里认不出课程'
      : !lesson ? `认出了课程「${course}」，但认不出是哪个课次`
        : `认出了 ${course} · ${lesson.lesson || lesson.title}`
  }
}

/** 归属不明的文件先放这里，等人在管理台指定，不做模糊猜测。 */
export function unassignedDir(root) {
  return path.join(path.resolve(root), '_unassigned')
}
