import fs from 'node:fs'

/**
 * 磁盘下限保护。
 *
 * 一节课的媒体有 1—2G 峰值，转完才删。服务器只有一块 50G 的系统盘，而且 swap
 * 也在同一块盘上——盘写满不只是"下不了课"，而是整机开始出问题。
 * 因此在**开始下载之前**就检查，而不是等到中途写失败。
 */
export const DEFAULT_MIN_FREE_BYTES = 5 * 1024 ** 3

/**
 * 找到最近的已存在目录。
 *
 * scratch 目录在首次运行前并不存在，直接 statfs 会抛 ENOENT——而"目录还没有"
 * 恰恰是最该检查磁盘的时候。向上找到最近的已存在祖先即可，同一文件系统上
 * 可用空间是一样的。
 */
export function resolveExistingAncestor(target, { exists = fs.existsSync } = {}) {
  let current = String(target || '.')
  for (let depth = 0; depth < 40; depth += 1) {
    if (exists(current)) return current
    const parent = fs.dirname ? fs.dirname(current) : null
    const next = parent && parent !== current ? parent : null
    if (!next) break
    current = next
  }
  return '.'
}

export function freeBytes(target, { statfs = fs.statfsSync, exists } = {}) {
  const stats = statfs(resolveExistingAncestor(target, { exists }))
  // bavail 是"非特权用户可用块数"，比 bfree 更贴近实际可写空间
  return Number(stats.bavail) * Number(stats.bsize)
}

export function checkFreeSpace({ path: target, minFreeBytes = DEFAULT_MIN_FREE_BYTES, statfs } = {}) {
  const required = Number(minFreeBytes) || 0
  const free = freeBytes(target, { statfs })
  return {
    ok: free >= required,
    freeBytes: free,
    minFreeBytes: required,
    shortfallBytes: Math.max(0, required - free)
  }
}

export function formatBytes(value) {
  const bytes = Number(value) || 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let size = bytes
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
