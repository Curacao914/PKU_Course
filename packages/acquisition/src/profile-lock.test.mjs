import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquireProfileLock, clearStaleProfileLock, entryExists, isProcessAlive, parseSingletonLock } from './profile-lock.mjs'

const profile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'course-profile-'))
const alive = () => true
const dead = () => { const error = new Error('ESRCH'); error.code = 'ESRCH'; throw error }

test('parseSingletonLock reads hostname and pid from the symlink target', () => {
  assert.deepEqual(parseSingletonLock('VM-0-6-ubuntu-3698801'), { host: 'VM-0-6-ubuntu', pid: 3698801 })
  assert.equal(parseSingletonLock('nonsense'), null)
  assert.equal(parseSingletonLock(''), null)
})

test('isProcessAlive treats EPERM as alive', () => {
  const eperm = () => { const error = new Error('EPERM'); error.code = 'EPERM'; throw error }
  assert.equal(isProcessAlive(123, { kill: alive }), true)
  assert.equal(isProcessAlive(123, { kill: eperm }), true)
  assert.equal(isProcessAlive(123, { kill: dead }), false)
  assert.equal(isProcessAlive(0, { kill: alive }), false)
})

test('a stale lock from a dead process is cleared', () => {
  const dir = profile()
  fs.symlinkSync('somehost-999999', path.join(dir, 'SingletonLock'))
  fs.writeFileSync(path.join(dir, 'SingletonCookie'), 'x')

  const result = clearStaleProfileLock(dir, { kill: dead })
  assert.equal(result.cleared, true)
  assert.deepEqual(result.removed.sort(), ['SingletonCookie', 'SingletonLock'])
  assert.equal(entryExists(path.join(dir, 'SingletonLock')), false)
  assert.equal(entryExists(path.join(dir, 'SingletonCookie')), false)
})

test('a lock held by a live process is left alone', () => {
  const dir = profile()
  fs.symlinkSync('somehost-4242', path.join(dir, 'SingletonLock'))
  const result = clearStaleProfileLock(dir, { kill: alive })
  assert.equal(result.cleared, false)
  assert.equal(result.reason, 'in-use')
  assert.equal(result.pid, 4242)
  assert.equal(entryExists(path.join(dir, 'SingletonLock')), true, '不得抢占正在使用的 profile')
})

test('no lock at all is a no-op', () => {
  assert.equal(clearStaleProfileLock(profile(), { kill: dead }).reason, 'no-lock')
})

test('a dangling symlink still counts as an existing lock', () => {
  // Chromium 的锁指向"主机名-pid"，那个路径并不存在；existsSync 会跟着软链返回 false
  const dir = profile()
  const link = path.join(dir, 'SingletonLock')
  fs.symlinkSync('somehost-999999', link)
  assert.equal(fs.existsSync(link), false, 'existsSync 对悬空软链返回 false——这正是坑')
  assert.equal(entryExists(link), true, 'lstat 才能看到锁本身')
  assert.equal(clearStaleProfileLock(dir, { kill: dead }).cleared, true)
})

test('the profile lock is exclusive and released on demand', async () => {
  const dir = profile()
  const first = await acquireProfileLock(dir, { timeoutMs: 500, pollMs: 20 })
  assert.equal(first.acquired, true)

  const blocked = await acquireProfileLock(dir, { timeoutMs: 200, pollMs: 20 })
  assert.equal(blocked.acquired, false, '第二个持有者应等待而不是抢走')
  assert.equal(blocked.owner.pid, process.pid)

  first.release()
  const second = await acquireProfileLock(dir, { timeoutMs: 500, pollMs: 20 })
  assert.equal(second.acquired, true)
  second.release()
})

test('a lock left by a dead process is taken over instead of blocking forever', async () => {
  const dir = profile()
  fs.mkdirSync(`${dir}.lock`, { recursive: true })
  fs.writeFileSync(path.join(`${dir}.lock`, 'owner.json'), JSON.stringify({ pid: 999999, at: new Date().toISOString() }))

  // 用真实的 process.kill 判断：999999 不存在 → 判为陈旧
  const lock = await acquireProfileLock(dir, { timeoutMs: 1000, pollMs: 20 })
  assert.equal(lock.acquired, true, '死进程留下的锁必须能自动接管，否则一次崩溃就永久卡死')
  lock.release()
})

test('an over-age lock is taken over even if the pid is still alive', async () => {
  const dir = profile()
  fs.mkdirSync(`${dir}.lock`, { recursive: true })
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  fs.writeFileSync(path.join(`${dir}.lock`, 'owner.json'), JSON.stringify({ pid: process.pid, at: old }))

  const lock = await acquireProfileLock(dir, { timeoutMs: 1000, pollMs: 20, staleMs: 60 * 1000 })
  assert.equal(lock.acquired, true)
  lock.release()
})
