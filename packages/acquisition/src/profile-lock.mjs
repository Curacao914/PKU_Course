import fs from 'node:fs'
import path from 'node:path'

/**
 * Chromium 持久化 profile 的锁处理。
 *
 * 两个真实问题，都会让流水线在**启动浏览器**这一步就失败，而且错误信息与真实原因
 * 完全不相干（"Profile is already in use"）：
 *
 *   1. **陈旧锁**：Chrome 被 kill（超时、OOM、断电）时来不及清理 SingletonLock，
 *      下次启动直接失败。这是最常见的一种，服务器上实测撞到过。
 *   2. **并发使用同一 profile**：定时任务与管理台手动触发同时跑，两个 Chrome 抢同一个
 *      profile 目录，Chrome 自己会拒绝其中一个。
 *
 * 因此：启动前清掉陈旧锁（通过锁里记录的 pid 判断持有者是否还活着），
 * 并用一个跨进程的文件锁把并发挡住——顺序等待比随机失败好得多。
 */

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']

/** Chromium 的 SingletonLock 是指向 "<hostname>-<pid>" 的软链。 */
export function parseSingletonLock(target) {
  const text = String(target || '')
  const index = text.lastIndexOf('-')
  if (index < 0) return null
  const pid = Number(text.slice(index + 1))
  return Number.isFinite(pid) && pid > 0 ? { pid, host: text.slice(0, index) } : null
}

export function isProcessAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户——仍然算活着
    return error?.code === 'EPERM'
  }
}

/**
 * 清掉无人持有的 Singleton 文件。
 * 持有者仍活着时**不动**——把正在使用的 profile 抢过来会损坏会话。
 */
/**
 * 判断"条目是否存在"，必须用 lstat。
 *
 * Chromium 的 SingletonLock 是指向 `主机名-pid` 的**悬空软链**——目标路径并不存在，
 * 因此 existsSync（会跟随软链）永远返回 false，用它检测等于完全没检测。
 * 这个坑会让整套修复在生产上静默失效。
 */
export function entryExists(target) {
  return fs.lstatSync(target, { throwIfNoEntry: false }) != null
}

export function clearStaleProfileLock(profileDir, { kill = process.kill, exists = entryExists } = {}) {
  const lockPath = path.join(profileDir, 'SingletonLock')
  if (!exists(lockPath)) return { cleared: false, reason: 'no-lock' }

  let holder = null
  try {
    holder = parseSingletonLock(fs.readlinkSync(lockPath))
  } catch {
    holder = null
  }

  if (holder && isProcessAlive(holder.pid, { kill })) {
    return { cleared: false, reason: 'in-use', pid: holder.pid }
  }

  const removed = []
  for (const name of SINGLETON_FILES) {
    const target = path.join(profileDir, name)
    if (!exists(target)) continue
    // 必须用 unlinkSync，不能用 rmSync({force:true})：后者内部先 stat，
    // 而 SingletonLock 是悬空软链，stat 得到 ENOENT，于是被 force 静默吞掉——
    // 结果是"报告清理成功、链接原封不动"。这是同一个软链陷阱的第二次踩中。
    try {
      fs.unlinkSync(target)
      removed.push(name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return { cleared: true, pid: holder?.pid ?? null, removed }
}

/**
 * 跨进程互斥：同一时刻只允许一个进程使用该 profile。
 *
 * 用 mkdir 做原子获取（mkdir 在已存在时必然失败，比 open+flock 更好移植）。
 * 持有者进程已死或超时的话，锁会被判定为陈旧并接管——否则一次崩溃会让整条链路
 * 永久卡死，需要人工介入。
 */
export function acquireProfileLock(profileDir, { timeoutMs = 120000, staleMs = 30 * 60 * 1000, pollMs = 500, now = () => Date.now(), kill = process.kill } = {}) {
  const lockDir = `${profileDir}.lock`
  const ownerPath = path.join(lockDir, 'owner.json')
  const startedAt = now()
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const release = () => fs.rmSync(lockDir, { recursive: true, force: true })

  const readOwner = () => {
    try {
      return JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
    } catch {
      return null
    }
  }

  const tryTake = () => {
    try {
      fs.mkdirSync(lockDir, { recursive: false })
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }))
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    // 已存在：判断是否陈旧
    const owner = readOwner()
    const age = owner?.at ? now() - Date.parse(owner.at) : Number.POSITIVE_INFINITY
    const ownerAlive = owner?.pid ? isProcessAlive(owner.pid, { kill }) : false
    if (!ownerAlive || age > staleMs) {
      release()
      return tryTake()
    }
    return false
  }

  return (async () => {
    while (now() - startedAt < timeoutMs) {
      if (tryTake()) return { acquired: true, release, waitedMs: now() - startedAt }
      await sleep(pollMs)
    }
    return { acquired: false, release, waitedMs: now() - startedAt, owner: readOwner() }
  })()
}
