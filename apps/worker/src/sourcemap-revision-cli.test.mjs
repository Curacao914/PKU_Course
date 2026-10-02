import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'
import {
  buildSourceMap,
  derivedBinding,
  markdownBytesChecksum,
  markdownChecksum
} from '@course/publish'
import { runCli } from './cli.mjs'

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
      now: () => new Date('2026-10-02T08:00:00Z'),
      which: async () => '',
      runPython: async () => ({ code: 0, stdout: '', stderr: '' }),
      acquire: async () => { throw new Error('sourcemap revision test must not open browser') },
      openStore: () => Object.create(ledger, { close: { value: () => {} } })
    }
  }
}

function fixture({ changedMappedQuote = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-map-revalidate-'))
  const site = path.join(root, 'site')
  const from = path.join(root, 'replays', 'replay-map', 'transcript')
  fs.mkdirSync(site, { recursive: true })
  fs.mkdirSync(from, { recursive: true })

  const course = '刑事执行法'
  const lesson = '2026-09-14第5-6节'
  const replayKey = 'replay-map'
  const slug = 'notes/刑事执行法/2026-09-14第5-6节'
  const quoted = '共同犯罪要求共同故意与共同行为同时具备'
  const oldNote = [
    '# 2026-09-14第5-6节',
    '',
    '## 甲节',
    '',
    quoted + '，缺一不可。',
    '',
    '## 乙节',
    '',
    '这里是另一部分内容。'
  ].join('\n')
  const newQuoteLine = changedMappedQuote
    ? '共同犯罪现在改成另一种完全不同的表述。'
    : quoted + '，缺一不可。'
  const newNote = [
    '# 2026-09-14第5-6节',
    '',
    '## 甲节',
    '',
    newQuoteLine,
    '',
    '## 乙节',
    '',
    '这里是另一部分内容。',
    '',
    '## 自测',
    '',
    '新增一组与甲节无关的自测题。'
  ].join('\n')
  const onepageMarkdown = ['## 一、体系', '', '- ' + quoted + '。'].join('\n')
  const oldMap = buildSourceMap({ slug, noteMarkdown: oldNote, onepageMarkdown })
  assert.equal(oldMap.entries.length, 1, 'fixture needs one exact old mapping')

  const oldOnepage = {
    ...derivedBinding({
      markdown: oldNote,
      courseName: course,
      lessonTitle: lesson,
      replayKey,
      generatedAt: '2026-09-14T12:00:00.000Z'
    }),
    title: '一页',
    markdown: onepageMarkdown,
    chars: onepageMarkdown.length,
    sourceMap: oldMap
  }
  const currentOnepage = {
    ...derivedBinding({
      markdown: newNote,
      courseName: course,
      lessonTitle: lesson,
      replayKey,
      generatedAt: '2026-10-02T08:00:00.000Z'
    }),
    title: '一页',
    markdown: onepageMarkdown,
    chars: onepageMarkdown.length,
    // top-level derived binding is current, but its sourceMap still remembers the old note revision.
    sourceMap: oldMap
  }

  fs.writeFileSync(path.join(site, 'library.json'), JSON.stringify([{
    slug,
    courseName: course,
    lessonTitle: lesson,
    replayKey,
    lessonDate: '2026-09-14',
    firstPublishedAt: '2026-09-14T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
    checksum: markdownBytesChecksum(oldNote),
    markdown: oldNote,
    onepage: oldOnepage
  }], null, 2))

  fs.writeFileSync(path.join(from, 'notes-run-summary.json'), JSON.stringify({
    course, lesson, replayKey, status: 'completed'
  }))
  fs.writeFileSync(path.join(from, lesson + '.md'), newNote)
  fs.writeFileSync(path.join(from, 'lesson-state.json'), JSON.stringify({
    lesson: { finalNote: { markdown: newNote, stale: false } }
  }, null, 2))
  fs.writeFileSync(path.join(from, 'onepage.json'), JSON.stringify(currentOnepage, null, 2))

  return { root, site, from, course, lesson, replayKey, slug, oldMap, newNote, onepageMarkdown }
}

test('publish revalidates an old sourceMap when its block, section and quote still survive the new note revision', async () => {
  const f = fixture()
  const h = harness(f.root)
  const code = await runCli([
    'publish',
    '--from', f.from,
    '--out', f.site,
    '--course', f.course,
    '--lesson', f.lesson,
    '--replay-key', f.replayKey,
    '--no-notify',
    '--no-purge'
  ], h.deps)
  assert.equal(code, 0, h.errors.join('\n'))

  const record = JSON.parse(fs.readFileSync(path.join(f.site, 'library.json'), 'utf8'))[0]
  const map = record.onepage.sourceMap
  assert.ok(map, 'valid old evidence should be retained')
  assert.equal(map.entries.length, 1)
  assert.equal(map.note.checksum, markdownChecksum(f.newNote))
  assert.equal(map.onepageChecksum, markdownChecksum(f.onepageMarkdown))
  assert.match(map.revalidatedAt, /^2026-10-02T08:00:00/)
  assert.equal(map.revalidatedFrom.noteChecksum, f.oldMap.note.checksum)

  const payload = JSON.parse(h.lines.at(-1))
  assert.equal(payload.sourceMap.located, 1)
  assert.equal(payload.sourceMap.bound, true)
  assert.equal(payload.sourceMap.revalidated, true)
})

test('publish drops an old sourceMap entry when its quote no longer exists in the mapped section', async () => {
  const f = fixture({ changedMappedQuote: true })
  const h = harness(f.root)
  const code = await runCli([
    'publish',
    '--from', f.from,
    '--out', f.site,
    '--course', f.course,
    '--lesson', f.lesson,
    '--replay-key', f.replayKey,
    '--no-notify',
    '--no-purge'
  ], h.deps)
  assert.equal(code, 0, h.errors.join('\n'))

  const record = JSON.parse(fs.readFileSync(path.join(f.site, 'library.json'), 'utf8'))[0]
  assert.ok(!record.onepage.sourceMap, 'changed evidence must not be kept merely because the old map existed')

  const payload = JSON.parse(h.lines.at(-1))
  assert.equal(payload.sourceMap.located, 0)
  assert.equal(payload.sourceMap.revalidated, true)
  assert.ok(payload.sourceMap.problems.some(problem => /摘录不在小节/.test(problem)))
})
