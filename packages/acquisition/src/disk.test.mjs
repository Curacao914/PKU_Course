import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_MIN_FREE_BYTES, checkFreeSpace, formatBytes, freeBytes, resolveExistingAncestor } from './disk.mjs'

const statfsOf = (bavail, bsize = 4096) => () => ({ bavail, bsize })

test('freeBytes multiplies available blocks by block size', () => {
  assert.equal(freeBytes('/x', { statfs: statfsOf(1000, 4096) }), 1000 * 4096)
  assert.equal(freeBytes('/x', { statfs: statfsOf(2_000_000, 4096) }), 8_192_000_000)
})

test('checkFreeSpace reports the shortfall so the message can be specific', () => {
  const plenty = checkFreeSpace({ path: '/x', minFreeBytes: 1024 ** 3, statfs: statfsOf(1_000_000) })
  assert.equal(plenty.ok, true)
  assert.equal(plenty.shortfallBytes, 0)

  const tight = checkFreeSpace({ path: '/x', minFreeBytes: 10 * 1024 ** 3, statfs: statfsOf(1000) })
  assert.equal(tight.ok, false)
  assert.equal(tight.freeBytes, 1000 * 4096)
  assert.equal(tight.shortfallBytes, 10 * 1024 ** 3 - 1000 * 4096)
})

test('the default floor is 5 GiB and a zero floor never blocks', () => {
  assert.equal(DEFAULT_MIN_FREE_BYTES, 5 * 1024 ** 3)
  assert.equal(checkFreeSpace({ path: '/x', statfs: statfsOf(0) }).ok, false)
  assert.equal(checkFreeSpace({ path: '/x', minFreeBytes: 0, statfs: statfsOf(0) }).ok, true)
})

test('a not-yet-created scratch directory falls back to its nearest existing ancestor', () => {
  // 首次运行前 scratch 目录并不存在，此时直接 statfs 会抛 ENOENT
  const missing = path.join(os.tmpdir(), 'course-disk-missing-' + Date.now(), 'replays')
  const seen = []
  const statfs = target => { seen.push(target); return { bavail: 1000, bsize: 4096 } }
  assert.equal(freeBytes(missing, { statfs }), 1000 * 4096)
  assert.ok(seen[0] && !seen[0].includes('course-disk-missing-'), `应回退到已存在的祖先，实际用到了 ${seen[0]}`)

  // 真实调用也不应抛错
  assert.ok(freeBytes(missing) > 0)
  // 已存在的路径原样返回（macOS 上 /var 是 /private/var 的软链，不做 realpath 比较）
  assert.equal(resolveExistingAncestor(os.tmpdir()), os.tmpdir())
  assert.equal(fs.existsSync(resolveExistingAncestor(missing)), true)
})

test('formatBytes keeps messages readable', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB')
})
