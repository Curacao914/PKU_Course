import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'
import { runCli } from './cli.mjs'

function sha256Bytes(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function harness(root, env = {}) {
  const lines = []
  const errors = []
  const ledger = openLedger(':memory:')
  return {
    lines,
    errors,
    deps: {
      env: {
        COURSE_EMBED_API_KEY: 'test-key',
        COURSE_EMBED_MAX_COST_CNY: '1',
        ...env
      },
      configOverrides: { scratchRoot: root },
      stdout: line => lines.push(String(line)),
      stderr: line => errors.push(String(line)),
      now: () => new Date('2026-10-02T08:00:00Z'),
      which: async () => '',
      runPython: async () => ({ code: 0, stdout: '', stderr: '' }),
      acquire: async () => { throw new Error('embed test must not open browser') },
      openStore: () => Object.create(ledger, { close: { value: () => {} } })
    }
  }
}

function writeLibrary(root, { fingerprint = 'fp-1', body = '正文一。' } = {}) {
  const site = path.join(root, 'site')
  fs.mkdirSync(site, { recursive: true })
  const library = path.join(site, 'library.json')
  const record = [{
    slug: 'notes/刑法分论/第1讲',
    courseName: '刑法分论',
    lessonTitle: '第1讲',
    markdown: ['# 第1讲', '', '## 一、甲', '', body, ''].join('\n'),
    sections: [{ id: '一-甲', title: '一、甲', fingerprint }]
  }]
  fs.writeFileSync(library, JSON.stringify(record, null, 2))
  return { site, library }
}

test('embed reuses fingerprint-matching vectors from an old revision, then rebinds the index to current library bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-embed-revision-'))
  const { site, library } = writeLibrary(root)
  const index = path.join(site, 'embeddings.json')
  fs.writeFileSync(index, JSON.stringify({
    version: 1,
    libraryRevision: 'old-library-revision',
    provider: 'dashscope',
    model: 'text-embedding-v3',
    dim: 3,
    items: {
      'notes/刑法分论/第1讲#一-甲': { fingerprint: 'fp-1', vector: [1, 0, 0] }
    }
  }, null, 2))

  const h = harness(root)
  const code = await runCli(['embed', '--site-root', site, '--max-cost', '1'], h.deps)
  assert.equal(code, 0, h.errors.join('\n'))

  const payload = JSON.parse(fs.readFileSync(index, 'utf8'))
  assert.equal(payload.libraryRevision, sha256Bytes(library))
  assert.equal(payload.counts.units, 1)
  assert.equal(payload.counts.reused, 1)
  assert.equal(payload.counts.embedded, 0)
  assert.deepEqual(payload.items['notes/刑法分论/第1讲#一-甲'].vector, [1, 0, 0])

  const emitted = JSON.parse(h.lines.at(-1))
  assert.equal(emitted.libraryRevision, payload.libraryRevision)
})

test('embed aborts final index commit if library changes during vectorization, while leaving the previous index intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-embed-race-'))
  const { site, library } = writeLibrary(root, { fingerprint: 'fp-new', body: '需要新向量。' })
  const index = path.join(site, 'embeddings.json')
  const previous = {
    version: 1,
    libraryRevision: 'old',
    provider: 'dashscope',
    model: 'text-embedding-v3',
    dim: 3,
    items: {
      'notes/刑法分论/第1讲#一-甲': { fingerprint: 'fp-old', vector: [1, 0, 0] }
    }
  }
  fs.writeFileSync(index, JSON.stringify(previous, null, 2))

  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const changed = JSON.parse(fs.readFileSync(library, 'utf8'))
    changed[0].updatedAt = '2026-10-02T08:01:00.000Z'
    fs.writeFileSync(library, JSON.stringify(changed, null, 2))
    return {
      ok: true,
      json: async () => ({
        output: { embeddings: [{ text_index: 0, embedding: [0, 1, 0] }] },
        usage: { total_tokens: 10 }
      })
    }
  }

  const h = harness(root, { COURSE_EMBED_CACHE: path.join(root, 'embed-cache.json') })
  const code = await runCli(['embed', '--site-root', site, '--max-cost', '1'], h.deps)
  assert.equal(code, 1)
  assert.equal(calls, 1)
  assert.match(h.errors.join('\n'), /发布库在这次发布期间被改过/)
  assert.match(h.errors.join('\n'), /重跑 course embed 会复用/)

  const after = JSON.parse(fs.readFileSync(index, 'utf8'))
  assert.deepEqual(after, previous, 'revision 变化后旧 index 可以继续留着，但绝不能提交一份错误绑定的新 index')
  assert.ok(fs.existsSync(path.join(root, 'embed-cache.json')), '已经付费拿到的向量应保留在 cache，下一次不重复付费')
})
