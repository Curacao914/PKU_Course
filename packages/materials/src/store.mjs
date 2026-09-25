import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanText } from '@course/core'

/**
 * 课件（PPT）归档与解析。
 *
 * 教学网上没有课件，课件只在用户手里，因此这条链路必须支持"随时补传"：
 * 课件晚到一步也要能用上——补传后只重写受影响的模块（`notes --revise`），
 * 不必整节课重跑。
 *
 * 归档形状：
 *   <root>/<课程>/<课次>/原文件.pptx
 *   <root>/<课程>/<课次>/slides/<文件名>.json   ← {"slideCount":N,"slides":[{"slideNumber":1,"text":""}]}
 *   <root>/<课程>/<课次>/meta.json              ← 每个材料的来源、哈希、解析时间
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

export function materialDir({ root, course, lesson }) {
  if (!root) throw new Error('缺少课件归档根目录')
  return path.join(path.resolve(root), safeSegment(course, 'course'), safeSegment(lesson, 'lesson'))
}

/** 默认的 python 执行器：可用 deps 注入，测试不需要真的装 python。 */
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

/** 收下一个课件：归档原件 + 解析出 json + 记元数据。同文件名重复上传视为替换。 */
export async function addMaterial({
  root, course, lesson, filePath, name,
  runPython = defaultRunPython, python = 'python3', env = process.env, at = new Date()
} = {}) {
  const dir = materialDir({ root, course, lesson })
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
  const fileName = safeSegment(name || path.basename(filePath), 'slides.pptx')
  const target = path.join(dir, fileName)
  const bytes = fs.readFileSync(filePath)
  fs.writeFileSync(target, bytes)
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex')

  const deck = await extractSlides({ filePath: target, runPython, python, env })
  const parsedPath = path.join(dir, 'slides', `${fileName}.json`)
  fs.writeFileSync(parsedPath, `${JSON.stringify({ ...deck, source: fileName, checksum }, null, 2)}\n`)

  const metaPath = path.join(dir, 'meta.json')
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { materials: [] }
  const entry = {
    name: fileName,
    bytes: bytes.length,
    checksum,
    slideCount: deck.slideCount,
    parsedPath,
    addedAt: at.toISOString()
  }
  meta.materials = [...(meta.materials || []).filter(item => item.name !== fileName), entry]
  meta.updatedAt = at.toISOString()
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  return { dir, entry, deck }
}

export function listMaterials({ root, course, lesson } = {}) {
  const dir = materialDir({ root, course, lesson })
  const metaPath = path.join(dir, 'meta.json')
  if (!fs.existsSync(metaPath)) return []
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')).materials || []
  } catch {
    return []
  }
}

/**
 * 读出这一课次可用于模型调用的课件文本。
 * 形状与 `lesson.pptText` 一致：[{name, slides:[{slideNumber,text}]}]。
 */
export function readDecks({ root, course, lesson } = {}) {
  return listMaterials({ root, course, lesson })
    .map(item => {
      if (!item.parsedPath || !fs.existsSync(item.parsedPath)) return null
      const parsed = JSON.parse(fs.readFileSync(item.parsedPath, 'utf8'))
      return { name: item.name, slides: parsed.slides || [] }
    })
    .filter(deck => deck && deck.slides.length)
}

/** 文件名 → 课次：收件箱里的文件按 `课程__课次.pptx` 命名归属；不匹配时返回 null。 */
export function parseInboxName(fileName) {
  const base = path.basename(String(fileName || ''))
  const match = base.match(/^(.+?)__(.+?)(\.[A-Za-z0-9]+)?$/)
  if (!match) return null
  return { course: match[1].trim(), lesson: match[2].trim(), extension: match[3] || '' }
}
