import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 发布的互斥与"版本没被人动过"检查。
 *
 * 为什么要有它：publish 的流程是「读发布库 → 写页面 → 写发布库」。两个发布同时跑
 * （定时 cycle 与手动点一下、或者两节课并行推），两边都拿着同一份旧库，各自算 nextLibrary，
 * 后写的那个把先写的**整条记录抹掉**——站点上少一整节课，而且没有任何报错。
 * 覆盖式写页面也一样：两个进程同时重写同一个 site 目录，产物可能互相截断。
 *
 * 两道防线，都不依赖"大家都很小心"：
 *   1. **锁文件**（O_EXCL 创建，写在站点目录**旁边**，不会被站点重写带走）：
 *      拿不到就拒绝开工，并告诉调用方是谁在跑、怎么处理。锁超过 staleMs 视为陈旧
 *      （进程被杀、断电留下的），可以接管——宁可允许接管，也不要让一次崩溃永久锁死发布。
 *   2. **乐观版本检查**：读库时记下 sha256，提交前再读一次比对。库被改过就中止——
 *      这时"重跑一次 publish"是正确动作（幂等），比覆盖别人的改动安全得多。
 *
 * 说清楚边界：这把锁只在同一台机器、同一个文件系统上有效；它挡的是"两个发布互相覆盖"，
 * 不是分布式互斥。跨机器的并发发布本来就不该发生（发布只在服务器上跑）。
 */

export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000

/** 锁文件放在站点目录**外面**：site 每次发布都会被全量重写（还可能清理多余文件）。 */
export function publishLockPath(siteRoot) {
  return `${path.resolve(String(siteRoot))}.publish.lock`
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 取锁。成功返回 { ok: true, release() }；失败返回 { ok: false, holder, reason }。
 * release 幂等，并且只删自己写的那把锁（不会把别人的锁删掉）。
 */
export function acquirePublishLock({ lockPath, info = {}, now = Date.now(), staleMs = DEFAULT_LOCK_STALE_MS, warnings = () => {} } = {}) {
  const target = path.resolve(String(lockPath))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // token 而不是 pid 作为身份：同一个进程里两次取锁（测试、或同进程重入）pid 相同，
  // 只比 pid 会让"旧持有者"删掉新持有者的锁。
  const token = crypto.randomBytes(8).toString('hex')
  const payload = JSON.stringify({ ...info, pid: process.pid, token, host: os.hostname(), startedAt: new Date(now).toISOString() })

  const attempt = () => {
    try {
      const fd = fs.openSync(target, 'wx')
      fs.writeSync(fd, payload)
      fs.closeSync(fd)
      return { ok: true }
    } catch (error) {
      if (error && error.code === 'EEXIST') return { ok: false }
      throw error
    }
  }

  let result = attempt()
  if (!result.ok) {
    const holder = readLock(target)
    const stat = (() => {
      try { return fs.statSync(target) } catch { return null }
    })()
    const age = stat ? now - stat.mtimeMs : Number.POSITIVE_INFINITY
    if (age >= staleMs) {
      // 陈旧锁：接管，但要在 stderr 上说清楚接管了谁的、多久以前的
      warnings(`发布锁已陈旧（${Math.round(age / 1000)}s > ${Math.round(staleMs / 1000)}s，持有者 ${holder?.pid || '未知'}），本次接管`)
      try { fs.unlinkSync(target) } catch {}
      result = attempt()
    }
    if (!result.ok) {
      return {
        ok: false,
        reason: 'held',
        holder,
        message: `另一个发布正在进行中（pid ${holder?.pid ?? '未知'}@${holder?.host ?? '?'}，开始于 ${holder?.startedAt ?? '?'}）。` +
          `等它结束后重跑一次即可；确认它已经死了就删掉 ${target}（超过 ${Math.round(staleMs / 1000)} 秒会被自动接管）。`
      }
    }
  }

  let released = false
  return {
    ok: true,
    lockPath: target,
    token,
    info: { ...info, pid: process.pid, token, host: os.hostname(), startedAt: new Date(now).toISOString() },
    release() {
      if (released) return false
      released = true
      // 只删"还是自己写的那把"：万一已经被接管（陈旧锁被接管、或同进程重入），
      // 别把新持有者的锁删掉——那会让两个发布同时开工。
      const current = readLock(target)
      if (current && current.token === token) {
        try { fs.unlinkSync(target) } catch {}
      }
      return true
    }
  }
}

/** 发布库的版本指纹：内容 sha256（文件不存在时 revision 为空串）。 */
export function libraryRevision(file) {
  try {
    const bytes = fs.readFileSync(file)
    return { exists: true, revision: crypto.createHash('sha256').update(bytes).digest('hex') }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, revision: '' }
    throw error
  }
}

/**
 * 提交前的乐观检查：库从"读进来"到"写回去"之间有没有被改过。
 * 返回 ok:false 而不是抛错，让调用方决定怎么报（这里只需要一句人话）。
 */
export function checkRevisionUnchanged({ file, expected }) {
  const current = libraryRevision(file)
  if (!current.exists && !expected) return { ok: true, revision: current.revision }
  if (current.revision === expected) return { ok: true, revision: current.revision }
  return {
    ok: false,
    revision: current.revision,
    message: `发布库在这次发布期间被改过（${file}）：读入时 ${String(expected).slice(0, 12) || '（不存在）'}，` +
      `提交前 ${current.revision.slice(0, 12)}。已中止，避免覆盖别人的改动；重跑一次 publish 即可（幂等）。`
  }
}
