import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function stamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function readLinkTarget(link) {
  const raw = fs.readlinkSync(link)
  return path.resolve(path.dirname(link), raw)
}

export function siteReleaseLayout(siteRoot) {
  const live = path.resolve(String(siteRoot))
  return {
    live,
    releases: `${live}.releases`
  }
}

export function inspectSiteRoot(siteRoot) {
  const { live, releases } = siteReleaseLayout(siteRoot)
  let stat
  try {
    stat = fs.lstatSync(live)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', managed: true, live, releases, target: null }
    throw error
  }

  if (stat.isSymbolicLink()) {
    const target = readLinkTarget(live)
    return {
      kind: 'symlink',
      managed: isInside(releases, target),
      live,
      releases,
      target
    }
  }
  if (stat.isDirectory()) return { kind: 'directory', managed: false, live, releases, target: live }
  return { kind: 'other', managed: false, live, releases, target: live }
}

export function beginSiteRelease({ siteRoot, now = new Date() } = {}) {
  const { live, releases } = siteReleaseLayout(siteRoot)
  fs.mkdirSync(releases, { recursive: true })
  const prefix = path.join(releases, `.staging-${stamp(now)}-`)
  const stagingDir = fs.mkdtempSync(prefix)
  return { live, releases, stagingDir }
}

export function discardSiteRelease(stagingDir) {
  if (!stagingDir) return
  fs.rmSync(path.resolve(stagingDir), { recursive: true, force: true })
}

export function sealSiteRelease({ siteRoot, stagingDir, now = new Date() } = {}) {
  const { releases } = siteReleaseLayout(siteRoot)
  const stage = path.resolve(String(stagingDir || ''))
  if (!isInside(releases, stage) || !path.basename(stage).startsWith('.staging-')) {
    throw new Error(`拒绝封存站点快照：临时目录不在 release 根目录内（${stage}）`)
  }
  if (!fs.existsSync(stage)) throw new Error(`站点快照不存在：${stage}`)
  const suffix = crypto.randomBytes(3).toString('hex')
  const releaseDir = path.join(releases, `release-${stamp(now)}-${suffix}`)
  fs.renameSync(stage, releaseDir)
  return releaseDir
}

export function promoteSiteRelease({ siteRoot, releaseDir } = {}) {
  const { live, releases } = siteReleaseLayout(siteRoot)
  const target = path.resolve(String(releaseDir || ''))
  if (!isInside(releases, target) || !fs.existsSync(target)) {
    throw new Error(`拒绝切换站点：release 不存在或不在 release 根目录内（${target}）`)
  }

  const state = inspectSiteRoot(live)
  if (state.kind === 'directory') {
    throw new Error(
      `站点目录还是旧式实体目录（${live}），不能直接做原子切换。` +
      '先在停站窗口运行 course publish --migrate-site-root --yes；之后 site 会变成 release 符号链接。'
    )
  }
  if (state.kind === 'other' || (state.kind === 'symlink' && !state.managed)) {
    throw new Error(`站点根目录不是本项目管理的 release 链接：${live}`)
  }

  const previous = state.kind === 'symlink' ? state.target : null
  const tempLink = `${live}.next-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const relativeTarget = path.relative(path.dirname(live), target) || '.'
  try {
    fs.symlinkSync(relativeTarget, tempLink, 'dir')
    // POSIX 下 rename 覆盖旧 symlink 是单个原子元数据操作。读者只会看到旧 release 或新 release。
    fs.renameSync(tempLink, live)
  } finally {
    try { if (fs.lstatSync(tempLink)) fs.unlinkSync(tempLink) } catch {}
  }
  return { live, releaseDir: target, previous }
}

/**
 * 一次性把旧的实体 site 目录迁成：
 *   site -> site.releases/legacy-...
 *
 * 这一步本身不可做到“实体目录 → symlink”零间隙，因此必须显式调用；生产上应先停 public/admin
 * 两个站点进程，迁移完成后再启动。日后的每次 release 切换则都是原子的。
 */
export function migrateLegacySiteRoot({ siteRoot, now = new Date() } = {}) {
  const { live, releases } = siteReleaseLayout(siteRoot)
  const state = inspectSiteRoot(live)
  if (state.kind === 'symlink' && state.managed) {
    return { migrated: false, alreadyManaged: true, live, releaseDir: state.target }
  }
  if (state.kind !== 'directory') {
    throw new Error(`只能迁移旧式实体站点目录：${live}（当前类型 ${state.kind}）`)
  }

  fs.mkdirSync(releases, { recursive: true })
  const releaseDir = path.join(releases, `legacy-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}`)
  const tempLink = `${live}.next-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.renameSync(live, releaseDir)
  try {
    const relativeTarget = path.relative(path.dirname(live), releaseDir) || '.'
    fs.symlinkSync(relativeTarget, tempLink, 'dir')
    fs.renameSync(tempLink, live)
  } catch (error) {
    try { fs.unlinkSync(tempLink) } catch {}
    // 能回滚就回滚：迁移失败时宁可继续用旧目录，也不要留下 site 缺失。
    if (!fs.existsSync(live) && fs.existsSync(releaseDir)) {
      try { fs.renameSync(releaseDir, live) } catch {}
    }
    throw error
  }
  return { migrated: true, alreadyManaged: false, live, releaseDir }
}

export function listSiteReleases(siteRoot) {
  const { releases } = siteReleaseLayout(siteRoot)
  if (!fs.existsSync(releases)) return []
  return fs.readdirSync(releases, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.staging-'))
    .map(entry => {
      const dir = path.join(releases, entry.name)
      const stat = fs.statSync(dir)
      return { name: entry.name, dir, mtimeMs: stat.mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
}

export function listReleaseFiles(rootDir) {
  const root = path.resolve(String(rootDir || ''))
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(root, full))
    }
  }
  if (fs.existsSync(root)) walk(root)
  return files.sort()
}

export function previousSiteRelease(siteRoot) {
  const state = inspectSiteRoot(siteRoot)
  if (state.kind !== 'symlink' || !state.managed || !state.target) {
    throw new Error('内容回滚只支持已经完成 --migrate-site-root 的 release 模式')
  }
  const candidates = listSiteReleases(siteRoot).filter(item => path.resolve(item.dir) !== path.resolve(state.target))
  return candidates[0] || null
}

export function validateSiteRelease(releaseDir) {
  const root = path.resolve(String(releaseDir || ''))
  const required = ['index.html', 'notes.json', 'library.json']
  const missing = required.filter(name => !fs.existsSync(path.join(root, name)))
  if (missing.length) throw new Error(`站点快照不完整：缺少 ${missing.join('、')}`)

  let library
  let index
  try {
    library = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8'))
  } catch (error) {
    throw new Error(`站点快照 library.json 损坏：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    index = JSON.parse(fs.readFileSync(path.join(root, 'notes.json'), 'utf8'))
  } catch (error) {
    throw new Error(`站点快照 notes.json 损坏：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(library)) throw new Error('站点快照 library.json 必须是数组')
  if (!Array.isArray(index?.notes)) throw new Error('站点快照 notes.json 缺少 notes 数组')
  if (Number(index.count) !== library.length || index.notes.length !== library.length) {
    throw new Error(`站点快照数量不一致：library=${library.length}，notes.count=${index.count}，notes[]=${index.notes.length}`)
  }

  const seen = new Set()
  for (const record of library) {
    const slug = String(record?.slug || '').trim()
    if (!slug) throw new Error('站点快照里存在没有 slug 的记录')
    if (seen.has(slug)) throw new Error(`站点快照里 slug 重复：${slug}`)
    seen.add(slug)
    if (!fs.existsSync(path.join(root, `${slug}.html`))) {
      throw new Error(`站点快照缺少正文页面：${slug}.html`)
    }
    const md = slug.replace(/^notes\//, 'md/')
    if (!fs.existsSync(path.join(root, `${md}.md`))) {
      throw new Error(`站点快照缺少 Markdown 正文：${md}.md`)
    }
    if (record?.onepage?.markdown) {
      const onepage = slug.replace(/^notes\//, 'onepage/')
      if (!fs.existsSync(path.join(root, `${onepage}.html`))) {
        throw new Error(`站点快照缺少一页纸页面：${onepage}.html`)
      }
    }
  }

  const indexed = new Set(index.notes.map(item => String(item?.slug || '').trim()).filter(Boolean))
  for (const slug of seen) {
    if (!indexed.has(slug)) throw new Error(`站点快照公开索引漏掉正文：${slug}`)
  }
  return { ok: true, notes: library.length, root }
}

export function copyReleaseFileIfPresent({ fromRoot, toRoot, name } = {}) {
  const source = path.join(path.resolve(String(fromRoot)), String(name))
  if (!fs.existsSync(source)) return false
  const target = path.join(path.resolve(String(toRoot)), String(name))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return true
}
