import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'
import { runCli } from './cli.mjs'

function rawSha(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function harness(root) {
  const lines = []
  const errors = []
  const ledger = openLedger(':memory:')
  return {
    lines,
    errors,
    deps: {
      env: {},
      configOverrides: { scratchRoot: root },
      stdout: line => lines.push(String(line)),
      stderr: line => errors.push(String(line)),
      now: () => new Date('2026-10-02T04:00:00Z'),
      which: async () => '',
      runPython: async () => ({ code: 0, stdout: '', stderr: '' }),
      acquire: async () => { throw new Error('source-sync test must not open browser') },
      openStore: () => Object.create(ledger, { close: { value: () => {} } })
    }
  }
}

function writeDriftFixture(root) {
  const replayKey = 'replay-source-drift'
  const course = '刑事执行法'
  const lesson = '2026-09-21第5-6节'
  const published = '# 正式正文\n\n## 一、框架\n\n正式版本。\n'
  const source = '# 旧源文件\n\n旧版本。\n'
  const stateText = '# state 里的另一版\n\n中间版本。\n'
  const outputDir = path.join(root, 'replays', replayKey, 'transcript')
  const siteDir = path.join(root, 'site')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(siteDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, lesson + '.md'), source)
  fs.writeFileSync(path.join(outputDir, 'notes-run-summary.json'), JSON.stringify({
    course, lesson, replayKey, status: 'completed'
  }))
  fs.writeFileSync(path.join(outputDir, 'lesson-state.json'), JSON.stringify({
    lesson: {
      title: lesson,
      finalNote: { markdown: stateText, stale: false },
      finalNoteVersions: []
    }
  }, null, 2))
  fs.writeFileSync(path.join(siteDir, 'library.json'), JSON.stringify([{
    slug: 'notes/刑事执行法/2026-09-21第5-6节',
    courseName: course,
    lessonTitle: lesson,
    replayKey,
    checksum: rawSha(published),
    markdown: published,
    firstPublishedAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z'
  }], null, 2))
  return { replayKey, course, lesson, published, source, stateText, outputDir, siteDir }
}

test('publish refuses a replay note that disagrees with lesson-state.finalNote', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-source-guard-'))
  const f = writeDriftFixture(root)
  const h = harness(root)
  const code = await runCli([
    'publish', '--from', f.outputDir, '--out', f.siteDir, '--replay-key', f.replayKey, '--no-notify'
  ], h.deps)
  assert.equal(code, 1)
  assert.match(h.errors.join('\n'), /Markdown 与 lesson-state\.finalNote 不一致/)
  assert.match(h.errors.join('\n'), /source-sync/)
  const library = JSON.parse(fs.readFileSync(path.join(f.siteDir, 'library.json'), 'utf8'))
  assert.equal(library[0].markdown, f.published, '保护失败时正式正文一个字都不能变')
})

test('source-sync explicitly adopts production as replay baseline and keeps a backup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-source-sync-'))
  const f = writeDriftFixture(root)
  const h = harness(root)

  assert.equal(await runCli(['source-sync', '--replay-key', f.replayKey], h.deps), 1)
  assert.match(h.errors.join('\n'), /确认后加 --yes/)

  const code = await runCli(['source-sync', '--replay-key', f.replayKey, '--yes'], h.deps)
  assert.equal(code, 0, h.errors.join('\n'))
  const payload = JSON.parse(h.lines.at(-1))
  assert.equal(payload.before.status, 'source-state-drift')
  assert.equal(payload.after.status, 'fresh')
  assert.equal(fs.readFileSync(path.join(f.outputDir, f.lesson + '.md'), 'utf8'), f.published)

  const state = JSON.parse(fs.readFileSync(path.join(f.outputDir, 'lesson-state.json'), 'utf8'))
  assert.equal(state.lesson.finalNote.markdown, f.published)
  assert.equal(state.lesson.finalNoteVersions.at(-1).source, 'source-sync:library')
  assert.ok(fs.existsSync(path.join(payload.backupDir, f.lesson + '.md')), '旧 note.md 必须留备份')
  assert.ok(fs.existsSync(path.join(payload.backupDir, 'lesson-state.json')), '旧 lesson-state 必须留备份')

  // 对齐之后同一份正文可以正常重新发布，不再触发源漂移保护。
  const republish = await runCli([
    'publish', '--from', f.outputDir, '--out', f.siteDir, '--replay-key', f.replayKey, '--no-notify'
  ], h.deps)
  assert.equal(republish, 0, h.errors.join('\n'))
})
