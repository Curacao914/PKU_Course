import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { writeJsonAtomic } from './atomic.mjs'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-atomic-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('library.json 以 tmp + rename 原子替换，不留残骸', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'library.json')
  writeJsonAtomic(file, [{ slug: 'notes/a', markdown: '第一版' }])
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify([{ slug: 'notes/a', markdown: '第一版' }], null, 2) + '\n')
  assert.equal(fs.existsSync(`${file}.tmp`), false, '.tmp 不该残留')

  writeJsonAtomic(file, [{ slug: 'notes/a', markdown: '第二版' }, { slug: 'notes/b' }])
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].markdown, '第二版')
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})

test('写失败时旧内容完整保留，也不会留下半截的 tmp 文件', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'library.json')
  const old = JSON.stringify([{ slug: 'notes/a', markdown: '旧的一版' }], null, 2) + '\n'
  fs.writeFileSync(file, old)

  // 模拟"写到一半磁盘满 / 进程被杀"：writeSync 抛错
  const failing = {
    openSync: (...args) => fs.openSync(...args),
    writeSync: () => { throw new Error('ENOSPC: no space left on device') },
    fsyncSync: (...args) => fs.fsyncSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    renameSync: (...args) => fs.renameSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args)
  }
  assert.throws(() => writeJsonAtomic(file, [{ slug: 'notes/a', markdown: '新的一版' }], { fsImpl: failing }), /ENOSPC/)
  assert.equal(fs.readFileSync(file, 'utf8'), old, '读到的必须还是旧的完整内容')
  assert.equal(fs.existsSync(`${file}.tmp`), false)

  // 模拟"rename 之前断电"：即便写成功，rename 失败也不能动到旧文件
  const failingRename = {
    openSync: (...args) => fs.openSync(...args),
    writeSync: (...args) => fs.writeSync(...args),
    fsyncSync: (...args) => fs.fsyncSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    renameSync: () => { throw new Error('EIO') },
    unlinkSync: (...args) => fs.unlinkSync(...args)
  }
  assert.throws(() => writeJsonAtomic(file, [{ slug: 'notes/a', markdown: '新的一版' }], { fsImpl: failingRename }), /EIO/)
  assert.equal(fs.readFileSync(file, 'utf8'), old)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})

test('序列化失败时不碰磁盘：旧文件原样', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'library.json')
  fs.writeFileSync(file, '{"old":true}')
  const circular = {}
  circular.self = circular
  assert.throws(() => writeJsonAtomic(file, circular), /circular|Converting/i)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})
