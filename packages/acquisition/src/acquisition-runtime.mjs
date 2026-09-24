import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

import {
  chooseCurrentCourses,
  courseKey,
  dedupeRecordings,
  normalizeRecordingRow,
  parseCourseLabel,
  replayKey,
  assertNoSecrets
} from './platform-core.mjs'
import { chooseLoginControls } from './login-core.mjs'
import {
  assertStateHasNoSecrets,
  buildSafeState,
  chooseAudioRendition,
  chooseVariant,
  fileComplete,
  parseMasterPlaylist,
  parseMediaPlaylist,
  redactText,
  renderLocalPlaylist,
  safeName,
  sha256,
  writeJsonAtomic
} from './hls-core.mjs'

const START_URL = process.env.COURSE_START_URL || 'https://course.pku.edu.cn/'
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.COURSE_DOWNLOAD_CONCURRENCY || 6)))
const FETCH_ATTEMPTS = Math.max(1, Math.min(8, Number(process.env.COURSE_FETCH_ATTEMPTS || 4)))
const SEGMENT_TIMEOUT_MS = Math.max(10_000, Math.min(180_000, Number(process.env.COURSE_SEGMENT_TIMEOUT_MS || 90_000)))
const PROGRESS_EVERY = Math.max(1, Math.min(100, Number(process.env.COURSE_DOWNLOAD_PROGRESS_EVERY || 5)))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map(line => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

function findChrome(explicit = '') {
  return [
    explicit,
    process.env.COURSE_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean).find(candidate => fs.existsSync(candidate))
}

function safeEndpoint(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    return `${parsed.host}${parsed.pathname.replace(/\d{3,}/g, ':number').slice(-100)}`
  } catch {
    return 'invalid-endpoint'
  }
}

function selectHeaders(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )
  return {
    authorization: normalized.authorization || '',
    referer: normalized.referer || '',
    origin: normalized.origin || '',
    userAgent: normalized['user-agent'] || ''
  }
}

function mergeHeaders(current = {}, incoming = {}) {
  return {
    authorization: incoming.authorization || current.authorization || '',
    referer: incoming.referer || current.referer || '',
    origin: incoming.origin || current.origin || '',
    userAgent: incoming.userAgent || current.userAgent || ''
  }
}

function playlistKeys(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    return [`${parsed.origin}${parsed.pathname}${parsed.search}`, `${parsed.origin}${parsed.pathname}`]
  } catch {
    return [String(rawUrl || '')]
  }
}

function createCapture(log) {
  const state = {
    candidate: null,
    headers: {},
    seen: new Set(),
    playlistResponses: new Map()
  }
  const handlers = new Map()

  function attach(page) {
    if (handlers.has(page)) return
    const onRequest = async request => {
      const rawUrl = request.url()
      let pathname = ''
      try { pathname = new URL(rawUrl).pathname.toLowerCase() } catch {}
      const useful = pathname.endsWith('.m3u8') || rawUrl.includes('get-sub-info')
      if (!useful) return
      let headers = {}
      try { headers = await request.allHeaders() } catch { headers = request.headers() }
      const picked = selectHeaders(headers)
      state.headers = mergeHeaders(state.headers, picked)
      if (pathname.endsWith('.m3u8') && !state.seen.has(rawUrl)) {
        state.seen.add(rawUrl)
        state.candidate = { url: rawUrl, headers: mergeHeaders(state.headers, picked) }
        log(`HLS_CAPTURE endpoint=${safeEndpoint(rawUrl)}`)
      }
    }

    const onResponse = async response => {
      const rawUrl = response.url()
      let pathname = ''
      try { pathname = new URL(rawUrl).pathname.toLowerCase() } catch {}
      const type = String(response.headers()['content-type'] || '').toLowerCase()
      if (!pathname.endsWith('.m3u8') && !type.includes('mpegurl')) return
      try {
        const text = (await response.body()).toString('utf8')
        if (!text.includes('#EXTM3U')) return
        const item = { text, finalUrl: rawUrl, source: 'browser-response' }
        for (const key of playlistKeys(rawUrl)) state.playlistResponses.set(key, item)
      } catch (error) {
        log(`PLAYLIST_BODY_FAILED endpoint=${safeEndpoint(rawUrl)} reason=${redactText(error?.message || error)}`)
      }
    }

    page.on('request', onRequest)
    page.on('response', onResponse)
    handlers.set(page, { onRequest, onResponse })
  }

  function detach() {
    for (const [page, value] of handlers) {
      page.off('request', value.onRequest)
      page.off('response', value.onResponse)
    }
    handlers.clear()
  }

  return { state, attach, detach }
}

async function isPortal(page) {
  return page.getByText('当前学期课程', { exact: true }).count().then(count => count > 0).catch(() => false)
}

async function frameControls(frame) {
  try {
    return await frame.evaluate(() => [...document.querySelectorAll('input,textarea')].map((element, index) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      let label = ''
      if (element.id) {
        const direct = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
        label = direct?.innerText || direct?.textContent || ''
      }
      return {
        index,
        type: element.getAttribute('type') || '',
        id: element.id || '',
        name: element.getAttribute('name') || '',
        autocomplete: element.getAttribute('autocomplete') || '',
        placeholder: element.getAttribute('placeholder') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        label,
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        disabled: Boolean(element.disabled)
      }
    }))
  } catch {
    return []
  }
}

async function clickCampusCard(context) {
  for (const page of context.pages()) {
    for (const candidate of [
      page.locator('a.login_stu_a:visible').first(),
      page.getByText('校园卡用户', { exact: false }).first()
    ]) {
      if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
        await candidate.click()
        return
      }
    }
  }
}

async function findLoginSurface(context, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (await isPortal(page)) return { portalPage: page }
      for (const frame of page.frames()) {
        const chosen = chooseLoginControls(await frameControls(frame))
        if (chosen.username && chosen.password) {
          return { frame, usernameIndex: chosen.username.index, passwordIndex: chosen.password.index }
        }
      }
    }
    await sleep(300)
  }
  return null
}

async function findSubmit(frame) {
  for (const selector of ['#logon_button', 'button[type="submit"]', 'input[type="submit"]', 'button', 'input[type="button"]']) {
    const candidates = frame.locator(selector)
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index)
      if (!await candidate.isVisible().catch(() => false)) continue
      const text = [
        await candidate.innerText().catch(() => ''),
        await candidate.getAttribute('value').catch(() => ''),
        await candidate.getAttribute('id').catch(() => '')
      ].join(' ')
      if (selector === '#logon_button' || /登录|login|logon/i.test(text)) return candidate
    }
  }
  return null
}

async function waitPortal(context, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const page of context.pages()) if (await isPortal(page)) return page
    await sleep(400)
  }
  throw new Error('登录后没有回到当前学期课程')
}

async function ensureLoggedIn(context, page, credentials) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(1000)
  for (const candidate of context.pages()) {
    if (await isPortal(candidate)) return { page: candidate, mode: 'existing-session' }
  }

  await clickCampusCard(context)
  if (!credentials.username || !credentials.password) {
    const error = new Error('教学网会话失效，且未配置 PKU_USERNAME / PKU_PASSWORD')
    error.code = 'AUTH_EXPIRED'
    throw error
  }

  const surface = await findLoginSurface(context)
  if (surface?.portalPage) return { page: surface.portalPage, mode: 'existing-session' }
  if (!surface) {
    const error = new Error('没有识别到统一登录表单')
    error.code = 'AUTH_EXPIRED'
    throw error
  }

  const inputs = surface.frame.locator('input,textarea')
  await inputs.nth(surface.usernameIndex).fill(credentials.username)
  await inputs.nth(surface.passwordIndex).fill(credentials.password)
  const submit = await findSubmit(surface.frame)
  if (!submit) {
    const error = new Error('没有识别到统一登录按钮')
    error.code = 'AUTH_EXPIRED'
    throw error
  }
  await submit.click()
  return { page: await waitPortal(context), mode: 'automatic-password' }
}

async function extractCourses(page) {
  const raw = await page.evaluate(() => {
    let section = 'unknown'
    const courses = []
    for (const element of document.querySelectorAll('h2,a[href]')) {
      const text = String(element.textContent || '').replace(/\s+/g, ' ').trim()
      if (element.tagName === 'H2') {
        if (text === '当前学期课程') section = 'current'
        else if (text === '历史课程') section = 'history'
      } else if (String(element.getAttribute('href') || '').includes('/webapps/blackboard/execute/launcher')) {
        courses.push({ section, text, href: element.href })
      }
    }
    return courses
  })

  return chooseCurrentCourses(raw.filter(item => item.text).map(item => {
    const label = parseCourseLabel(item.text)
    const url = new URL(item.href)
    const identity = url.searchParams.get('id') || url.searchParams.get('course_id') || url.pathname + url.search
    return { ...label, section: item.section, href: item.href, identity, courseKey: courseKey(identity) }
  }))
}

async function findRecordingTool(page) {
  return page.evaluate(() => {
    const link = [...document.querySelectorAll('a[href]')].find(anchor => {
      const text = String(anchor.textContent || '').replace(/\s+/g, ' ').trim()
      return text.includes('课堂实录') || text.includes('课程实录') ||
        Boolean(anchor.querySelector('[title="课堂实录"],[title="课程实录"]'))
    })
    return link?.href || ''
  })
}

async function readRecordingPage(page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find(candidate => {
      const text = String(candidate.innerText || '').replace(/\s+/g, ' ')
      return text.includes('名称') && text.includes('时间') && text.includes('教师') && text.includes('操作')
    })
    if (!table) return { rows: [], signature: '' }
    const rows = []
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll(':scope > th,:scope > td')]
        .map(cell => String(cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim())
      const watch = [...row.querySelectorAll('a[href]')].find(anchor =>
        String(anchor.textContent || '').includes('观看') || String(anchor.href).includes('playVideo.action'))
      if (watch && cells.length >= 3) rows.push({ cells, watchHref: watch.href })
    }
    return { rows, signature: rows.map(item => item.cells.slice(0, 3).join('|')).join('\n') }
  })
}

async function scanCourse(page, course) {
  await page.goto(course.href, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(600)
  const tool = await findRecordingTool(page)
  if (!tool) return []
  await page.goto(tool, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(600)

  const recordings = []
  const signatures = new Set()
  for (let pageNo = 1; pageNo <= 30; pageNo += 1) {
    const parsed = await readRecordingPage(page)
    if (!parsed.signature || signatures.has(parsed.signature)) break
    signatures.add(parsed.signature)
    for (const row of parsed.rows) {
      const normalized = normalizeRecordingRow(row.cells)
      const item = {
        title: normalized.title,
        startsAtText: normalized.startsAtText,
        teacher: normalized.teacher,
        page: pageNo,
        watchHref: row.watchHref
      }
      recordings.push({ ...item, replayKey: replayKey(course.identity, item) })
    }
    const next = page.getByRole('link', { name: '前进', exact: true }).first()
    if (!await next.count() || !await next.isVisible().catch(() => false)) break
    await next.click()
    await page.waitForTimeout(700)
    const after = await readRecordingPage(page)
    if (!after.signature || after.signature === parsed.signature) break
  }
  return dedupeRecordings(recordings)
}

async function waitForM3u8(capture, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (capture.candidate) return capture.candidate
    await sleep(250)
  }
  const error = new Error('自动打开回放后没有捕获到 M3U8')
  error.retryable = true
  throw error
}

async function pauseMedia(context) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      await frame.evaluate(() => {
        for (const media of document.querySelectorAll('video,audio')) {
          try { media.pause() } catch {}
        }
      }).catch(() => {})
    }
  }
}

async function authHeaders(context, capture, rawUrl, range = null) {
  const useful = mergeHeaders(capture.headers, capture.candidate?.headers || {})
  const cookies = await context.cookies([rawUrl])
  const headers = {}
  if (useful.authorization) headers.Authorization = useful.authorization
  if (useful.referer) headers.Referer = useful.referer
  if (useful.origin) headers.Origin = useful.origin
  if (useful.userAgent) headers['User-Agent'] = useful.userAgent
  if (cookies.length) headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  if (range) headers.Range = `bytes=${range.start}-${range.end}`
  return headers
}

async function fetchAuthenticated(context, capture, rawUrl, options = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || SEGMENT_TIMEOUT_MS)
    try {
      const response = await fetch(rawUrl, {
        headers: await authHeaders(context, capture, rawUrl, options.range),
        redirect: 'follow',
        signal: controller.signal
      })
      clearTimeout(timer)
      if (response.status === 429 || response.status >= 500) throw new Error(`upstream HTTP ${response.status}`)
      if (!response.ok && response.status !== 206) throw new Error(`upstream HTTP ${response.status}`)
      return response
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)))
    }
  }
  const error = new Error(`媒体请求多次失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  error.retryable = true
  throw error
}

async function obtainPlaylist(context, capture, rawUrl) {
  const deadline = Date.now() + 12_000
  const keys = playlistKeys(rawUrl)
  while (Date.now() < deadline) {
    for (const key of keys) {
      const found = capture.playlistResponses.get(key)
      if (found) return found
    }
    await sleep(200)
  }
  const response = await fetchAuthenticated(context, capture, rawUrl, { timeoutMs: 30_000 })
  return { text: await response.text(), finalUrl: response.url, source: 'authenticated-request' }
}

async function resolveTracks(context, capture, rootUrl) {
  const root = await obtainPlaylist(context, capture, rootUrl)
  const master = parseMasterPlaylist(root.text, root.finalUrl)
  if (!master.isMaster) {
    return [{ trackKey: 'primary', sourceUrl: root.finalUrl, playlistText: root.text, playlistSource: root.source }]
  }

  const variant = chooseVariant(master)
  if (!variant) throw new Error('Master Playlist 没有可用 Variant')
  const primary = await obtainPlaylist(context, capture, variant.url)
  const tracks = [{ trackKey: 'primary', sourceUrl: primary.finalUrl, playlistText: primary.text, playlistSource: primary.source }]
  const audio = chooseAudioRendition(master, variant)
  if (audio) {
    const audioPlaylist = await obtainPlaylist(context, capture, audio.url)
    tracks.push({ trackKey: 'audio', sourceUrl: audioPlaylist.finalUrl, playlistText: audioPlaylist.text, playlistSource: audioPlaylist.source })
  }
  return tracks
}

async function downloadResource(context, capture, resource, targetPath) {
  if (fileComplete(targetPath, resource.range)) return { downloaded: false, bytes: fs.statSync(targetPath).size }
  const partPath = `${targetPath}.part`
  fs.rmSync(partPath, { force: true })
  try {
    const response = await fetchAuthenticated(context, capture, resource.url, { range: resource.range })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error('媒体分片为空')
    if (resource.range?.length && buffer.length !== resource.range.length) {
      throw new Error(`Range 长度不一致：预期 ${resource.range.length}，实际 ${buffer.length}`)
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(partPath, buffer)
    fs.renameSync(partPath, targetPath)
    return { downloaded: true, bytes: buffer.length }
  } catch (error) {
    fs.rmSync(partPath, { force: true })
    throw error
  }
}

async function runPool(jobs, concurrency, worker, heartbeat, log) {
  let cursor = 0
  let done = 0
  async function runner() {
    while (true) {
      const index = cursor++
      if (index >= jobs.length) return
      await worker(jobs[index])
      done += 1
      if (done === jobs.length || done % PROGRESS_EVERY === 0) log(`HLS_PROGRESS ${done}/${jobs.length}`)
      if (heartbeat && done % 20 === 0) await heartbeat()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, runner))
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString().slice(-1200)}`))
    })
  })
}

async function probe(filePath) {
  const result = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name', '-of', 'json', filePath
  ])
  const data = JSON.parse(result.stdout)
  return {
    durationSeconds: Number(data.format?.duration || 0),
    bytes: fs.statSync(filePath).size,
    streams: (data.streams || []).map(stream => ({ codecType: stream.codec_type, codecName: stream.codec_name }))
  }
}

async function assemble(tracks, fragmentsDir, outputFile) {
  const inputs = []
  for (const track of tracks) {
    const trackDir = path.join(fragmentsDir, track.trackKey)
    const playlist = path.join(trackDir, 'full-local.m3u8')
    fs.writeFileSync(playlist, renderLocalPlaylist(track, trackDir, Infinity))
    inputs.push({ trackKey: track.trackKey, playlist })
  }

  const partPath = outputFile.replace(/\.mp4$/i, '.part.mp4')
  fs.rmSync(partPath, { force: true })
  const primary = inputs.find(item => item.trackKey === 'primary')
  const audio = inputs.find(item => item.trackKey === 'audio')
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-protocol_whitelist', 'file,crypto,data',
    '-allowed_extensions', 'ALL', '-i', primary.playlist
  ]
  if (audio) {
    args.push('-i', audio.playlist, '-map', '0:v:0?', '-map', '1:a:0?')
  } else {
    args.push('-map', '0:v:0?', '-map', '0:a:0?')
  }
  args.push('-c', 'copy', '-fflags', '+genpts', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', partPath)
  await run('ffmpeg', args)
  const info = await probe(partPath)
  fs.renameSync(partPath, outputFile)
  return info
}

async function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

export function createValidatedAcquisitionRuntime(input = {}) {
  const repoRoot = path.resolve(input.repoRoot || process.cwd())
  const localEnv = parseEnvFile(path.join(repoRoot, '.env.local'))
  const scratchRoot = path.resolve(
    input.scratchRoot || process.env.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.law-tech-course-worker')
  )
  const profileDir = path.resolve(
    input.profileDir || process.env.COURSE_BROWSER_PROFILE_DIR || path.join(scratchRoot, 'browser-profile')
  )
  const credentials = {
    username: input.username || process.env.PKU_USERNAME || localEnv.PKU_USERNAME || '',
    password: input.password || process.env.PKU_PASSWORD || localEnv.PKU_PASSWORD || ''
  }
  const executablePath = findChrome(input.executablePath)
  if (!executablePath) throw new Error('没有找到 Chrome/Chromium；请设置 COURSE_CHROME_PATH')
  fs.mkdirSync(scratchRoot, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })

  let context = null
  let portalPage = null

  async function ensureBrowser() {
    if (context) return { context, page: portalPage }
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: input.headless ?? process.env.COURSE_HEADLESS !== '0',
      acceptDownloads: false,
      viewport: process.env.COURSE_HEADLESS === '0' ? null : { width: 1440, height: 900 },
      args: process.env.COURSE_HEADLESS === '0' ? ['--start-maximized'] : []
    })
    portalPage = context.pages()[0] || await context.newPage()
    return { context, page: portalPage }
  }


  async function discover(options = {}) {
    const browser = await ensureBrowser()
    const login = await ensureLoggedIn(
      browser.context,
      browser.page,
      credentials
    )
    portalPage = login.page

    const allCourses = await extractCourses(portalPage)
    const courseName = String(
      options.courseName || ''
    ).trim()
    const courseKeyValue = String(
      options.courseKey || ''
    ).trim()

    const selectedCourses = allCourses.filter(course => {
      if (
        courseKeyValue &&
        course.courseKey !== courseKeyValue
      ) {
        return false
      }
      if (
        courseName &&
        !course.name.includes(courseName) &&
        !course.normalizedName.includes(courseName)
      ) {
        return false
      }
      return true
    })

    if (!selectedCourses.length) {
      throw new Error(
        courseName || courseKeyValue
          ? '没有找到匹配的当前学期课程'
          : '当前学期没有可扫描课程'
      )
    }

    const safeCourses = []
    for (const course of selectedCourses) {
      const recordings = await scanCourse(
        portalPage,
        course
      )
      safeCourses.push({
        courseKey: course.courseKey,
        courseName: course.name,
        normalizedName: course.normalizedName,
        recordings: recordings.map(recording => ({
          replayKey: recording.replayKey,
          title: recording.title,
          startsAtText: recording.startsAtText,
          teacher: recording.teacher
        }))
      })
    }

    const result = {
      loginMode: login.mode,
      courses: safeCourses
    }
    assertNoSecrets(result)
    return result
  }

  async function download(task, runtime = {}) {
    const replayKeyValue = String(task.replay_key || '')
    const courseKeyValue = String(task.course_key || '')
    if (!replayKeyValue || !courseKeyValue) throw new Error('任务缺少 replay_key 或 course_key')
    const log = message => runtime.log?.(redactText(String(message)))
    const taskRoot = path.join(scratchRoot, 'replays', replayKeyValue)
    const fragmentsDir = path.join(taskRoot, 'fragments')
    const outputDir = path.join(taskRoot, 'output')
    const outputFile = path.join(outputDir, 'media.mp4')
    const progressPath = path.join(taskRoot, 'download-progress.json')
    fs.mkdirSync(fragmentsDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })

    if (fs.existsSync(outputFile)) {
      const existing = await probe(outputFile)
      if (existing.durationSeconds > 60 && existing.bytes > 1024 * 1024) {
        return {
          artifacts: {
            mediaScratchKey: path.relative(scratchRoot, outputFile),
            mediaChecksum: await fileSha256(outputFile)
          },
          runtime: { durationSeconds: existing.durationSeconds, mediaBytes: existing.bytes, resumed: true }
        }
      }
    }

    const browser = await ensureBrowser()
    const login = await ensureLoggedIn(browser.context, browser.page, credentials)
    portalPage = login.page
    const courses = await extractCourses(portalPage)
    const course = courses.find(item => item.courseKey === courseKeyValue) ||
      courses.find(item => item.name === task.course_name)
    if (!course) {
      const error = new Error(`当前学期课程中无法定位：${task.course_name || courseKeyValue}`)
      error.code = 'COURSE_REPLAY_NOT_FOUND'
      throw error
    }

    const recordings = await scanCourse(portalPage, course)
    const recording = recordings.find(item => item.replayKey === replayKeyValue)
    if (!recording?.watchHref) {
      const error = new Error('当前课堂实录列表无法定位目标回放')
      error.code = 'COURSE_REPLAY_NOT_FOUND'
      throw error
    }

    const capture = createCapture(log)
    for (const page of browser.context.pages()) capture.attach(page)
    browser.context.on('page', capture.attach)
    await portalPage.goto(recording.watchHref, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    const m3u8 = await waitForM3u8(capture.state)
    await portalPage.waitForTimeout(1500)
    await pauseMedia(browser.context)
    const rawTracks = await resolveTracks(browser.context, capture.state, m3u8.url)
    browser.context.off('page', capture.attach)
    capture.detach()

    const tracks = rawTracks.map(track => parseMediaPlaylist(track.playlistText, track.sourceUrl, track.trackKey))
    const playlistFingerprint = sha256(JSON.stringify(tracks.map(track => ({
      trackKey: track.trackKey,
      resources: track.resources.map(resource => [resource.kind, resource.urlHash, resource.range, resource.duration, resource.sequence])
    }))))
    const safeState = buildSafeState({
      lessonName: safeName(`${task.course_name}-${task.title}`),
      playlistFingerprint,
      tracks,
      concurrency: CONCURRENCY
    })
    assertStateHasNoSecrets(safeState)
    const statePath = path.join(taskRoot, 'state.json')
    if (fs.existsSync(statePath)) {
      const prior = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (prior.playlistFingerprint !== playlistFingerprint) {
        throw new Error('回放 HLS 清单已变化；请清理该任务 fragments 后重试')
      }
    }
    writeJsonAtomic(statePath, safeState)

    const jobs = tracks.flatMap(track => track.resources.map(resource => ({ track, resource })))
    let downloadedResources = 0
    let reusedResources = 0
    let resourceBytes = 0
    let completedResources = 0
    const writeProgress = status => writeJsonAtomic(progressPath, {
      schemaVersion: 1,
      replayKey: replayKeyValue,
      status,
      totalResources: jobs.length,
      completedResources,
      downloadedResources,
      reusedResources,
      bytes: resourceBytes,
      concurrency: CONCURRENCY,
      updatedAt: new Date().toISOString()
    })
    writeProgress('downloading')
    await runPool(jobs, CONCURRENCY, async ({ track, resource }) => {
      const result = await downloadResource(
        browser.context,
        capture.state,
        resource,
        path.join(fragmentsDir, track.trackKey, resource.fileName)
      )
      if (result.downloaded) downloadedResources += 1
      else reusedResources += 1
      resourceBytes += result.bytes
      completedResources += 1
      writeProgress(
        completedResources === jobs.length
          ? 'downloaded'
          : 'downloading'
      )
    }, runtime.heartbeat, log)
    writeProgress('assembling')

    fs.rmSync(outputFile, { force: true })
    const media = await assemble(tracks, fragmentsDir, outputFile)
    const checksum = await fileSha256(outputFile)
    writeProgress('completed')
    writeJsonAtomic(path.join(taskRoot, 'download-summary.json'), {
      schemaVersion: 1,
      replayKey: replayKeyValue,
      courseKey: courseKeyValue,
      playlistFingerprint,
      mediaFile: path.relative(scratchRoot, outputFile),
      checksum,
      durationSeconds: media.durationSeconds,
      bytes: media.bytes,
      downloadedResources,
      reusedResources,
      createdAt: new Date().toISOString()
    })

    return {
      artifacts: { mediaScratchKey: path.relative(scratchRoot, outputFile), mediaChecksum: checksum },
      runtime: {
        durationSeconds: media.durationSeconds,
        mediaBytes: media.bytes,
        resourceBytes,
        downloadedResources,
        reusedResources,
        streamTypes: media.streams.map(item => item.codecType),
        loginMode: login.mode
      }
    }
  }

  async function close() {
    if (context) await context.close()
    context = null
    portalPage = null
  }

  return { scratchRoot, discover, download, close }
}
