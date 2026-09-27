import fs from 'node:fs'
import path from 'node:path'

import { ToolError } from './errors.mjs'
import { normalizeRecord, noteFileName } from './records.mjs'

/**
 * 两种数据源，同一套接口：
 *
 *   listNotes()            → 记录数组（远程那份不含正文）
 *   readMarkdown(slug)     → 整篇 Markdown
 *   describe()             → 给人/日志看的来源说明
 *
 * 选哪个：本地发布库（COURSE_LIBRARY 指向 library.json）优先——它含正文，检索能做全文；
 * 没有本地库时才走站点（COURSE_SITE_ORIGIN），好处是零配置，代价是正文要逐篇下载。
 */

export const DEFAULT_SITE_ORIGIN = 'https://course.law-tech.dev'
export const DEFAULT_TTL_SECONDS = 60

export function normalizeOrigin(origin) {
  return String(origin || DEFAULT_SITE_ORIGIN).trim().replace(/\/+$/, '') || DEFAULT_SITE_ORIGIN
}

/**
 * 本地发布库。
 *
 * 每次 listNotes 都先 stat 再看要不要重读：发布是**另一个进程**做的
 * （course publish 写完 library.json 就退出），MCP 服务器可能已经跑了几周。
 * 进程启动时读死的话，AI 问「昨天那节新课」会一直得到旧答案。
 * 用 mtimeMs + size 当缓存键，不设 TTL——本地文件的变化必须立刻可见。
 */
export function createLocalLibrarySource({ file } = {}) {
  const target = path.resolve(String(file || ''))
  if (!String(file || '').trim()) throw new ToolError('没有配置本地发布库：把 COURSE_LIBRARY 指向 site/library.json')
  let cache = null

  function readLibrary() {
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw new ToolError(`读不到发布库 ${target}：文件不存在或不可读。请检查 COURSE_LIBRARY，或改用 COURSE_SITE_ORIGIN 走远程站点。`)
    }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.records
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch (error) {
      throw new ToolError(`发布库不是合法 JSON：${target}（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (!Array.isArray(raw)) throw new ToolError(`发布库格式不对：${target} 应当是记录数组（course publish 的产物）`)
    const records = raw.map(normalizeRecord).filter(record => record.slug)
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, records }
    return records
  }

  return {
    kind: 'local',
    describe: () => ({ kind: 'local', label: '本地发布库', location: target, live: true }),
    listNotes: async () => readLibrary(),
    readMarkdown: async slug => {
      const record = readLibrary().find(item => item.slug === slug)
      if (!record) throw new ToolError(`发布库里没有 slug=${slug} 的笔记（可能刚发布还没写进 library.json）。`)
      if (!record.markdown || !record.markdown.trim()) throw new ToolError(`笔记 ${slug} 没有正文（发布库记录缺 markdown 字段）。`)
      return record.markdown
    }
  }
}

/**
 * 远程站点。
 *
 * /api/notes 是 no-store 的（站点服务器显式设了 cache-control），所以短 TTL 缓存
 * 只是省掉同一轮对话里的重复请求；/md/*.md 是静态文件、边缘可能缓存一小时，
 * 因此正文用同一个 TTL 缓存，避免每次 get_note 都重新下载。
 *
 * TTL 默认 60 秒：够短（新发布的笔记一分钟内可见），也够长（一次多轮检索不会刷屏请求）。
 */
export function createRemoteSiteSource({
  origin = DEFAULT_SITE_ORIGIN,
  ttlMs = DEFAULT_TTL_SECONDS * 1000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  const base = normalizeOrigin(origin)
  const ttl = Math.max(0, Number(ttlMs) || 0)
  let indexCache = null
  const markdownCache = new Map()

  async function fetchChecked(url, what) {
    let response
    try {
      response = await fetchImpl(url, { headers: { accept: what === 'json' ? 'application/json' : 'text/markdown, text/plain, */*' } })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ToolError(`访问 ${url} 失败：${reason}。离线时用 COURSE_LIBRARY 指向本地 library.json。`)
    }
    if (!response.ok) throw new ToolError(`请求 ${url} 返回 ${response.status} ${response.statusText || ''}`.trim())
    return response
  }

  async function loadIndex() {
    if (indexCache && now() - indexCache.at < ttl) return indexCache.records
    const response = await fetchChecked(`${base}/api/notes`, 'json')
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new ToolError(`站点索引不是合法 JSON：${base}/api/notes`)
    }
    const notes = Array.isArray(payload?.notes) ? payload.notes : Array.isArray(payload) ? payload : null
    if (!notes) throw new ToolError(`站点索引格式不对：${base}/api/notes 期望 { notes: [...] }`)
    const records = notes.map(normalizeRecord).filter(record => record.slug)
    indexCache = { at: now(), records }
    return records
  }

  return {
    kind: 'remote',
    describe: () => ({ kind: 'remote', label: '远程站点', location: base, live: true, ttlSeconds: Math.round(ttl / 1000) }),
    listNotes: loadIndex,
    readMarkdown: async slug => {
      const key = String(slug)
      const cached = markdownCache.get(key)
      if (cached && now() - cached.at < ttl) return cached.text
      const url = `${base}/md/${encodeURIComponent(noteFileName(key))}.md`
      const response = await fetchChecked(url, 'markdown')
      const text = await response.text()
      markdownCache.set(key, { at: now(), text })
      return text
    }
  }
}

/** 按配置二选一。本地优先：它含正文，能力最全。 */
export function createSource({ library = '', origin = DEFAULT_SITE_ORIGIN, ttlSeconds = DEFAULT_TTL_SECONDS, fetchImpl, now } = {}) {
  if (String(library || '').trim()) return createLocalLibrarySource({ file: library })
  return createRemoteSiteSource({
    origin,
    ttlMs: Math.max(0, Number(ttlSeconds) || 0) * 1000,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(now ? { now } : {})
  })
}
