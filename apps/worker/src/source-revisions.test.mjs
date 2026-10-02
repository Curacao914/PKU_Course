import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  formatSourceRevisions,
  inspectSourceRevision,
  scanSourceRevisions,
  sourceRevisionPaths
} from './source-revisions.mjs'

function fixture({ source = '# A\n正文\n', state = '# A\n正文\n', published = '# A\n正文\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-source-revision-'))
  const record = {
    replayKey: 'replay-1',
    courseName: '刑事执行法',
    lessonTitle: '2026-09-21第5-6节',
    slug: 'notes/刑事执行法/2026-09-21第5-6节',
    markdown: published
  }
  const paths = sourceRevisionPaths({ scratchRoot: root, record })
  fs.mkdirSync(paths.outputDir, { recursive: true })
  if (source !== null) fs.writeFileSync(paths.notePath, source)
  if (state !== null) fs.writeFileSync(paths.statePath, JSON.stringify({ lesson: { finalNote: { markdown: state } } }))
  return { root, record, paths }
}

test('fresh: publish source, lesson-state and library agree modulo trailing whitespace', () => {
  const { root, record } = fixture({
    source: '# A\n正文   \n\n',
    state: '# A\n正文\n',
    published: '# A\n正文\n'
  })
  const item = inspectSourceRevision({ scratchRoot: root, record })
  assert.equal(item.status, 'fresh')
  assert.equal(item.sourceMatchesState, true)
  assert.equal(item.sourceMatchesPublished, true)
})

test('dangerous drift: publish file differs from lesson-state, so republish must not silently trust it', () => {
  const { root, record } = fixture({
    source: '# 旧版\n',
    state: '# 新版\n',
    published: '# 正式版\n'
  })
  const item = inspectSourceRevision({ scratchRoot: root, record })
  assert.equal(item.status, 'source-state-drift')
  assert.equal(item.sourceMatchesState, false)
})

test('intentional-looking revision: source and state agree, production is older', () => {
  const { root, record } = fixture({
    source: '# 修订版\n',
    state: '# 修订版\n',
    published: '# 正式旧版\n'
  })
  const item = inspectSourceRevision({ scratchRoot: root, record })
  assert.equal(item.status, 'unpublished-change')
  assert.equal(item.sourceMatchesState, true)
  assert.equal(item.sourceMatchesPublished, false)
})

test('missing source is visible instead of disappearing from reconciliation', () => {
  const { root, record } = fixture({ source: null })
  const report = scanSourceRevisions({ scratchRoot: root, records: [record] })
  assert.equal(report.counts['source-missing'], 1)
  assert.match(formatSourceRevisions(report), /源文件缺失/)
})
