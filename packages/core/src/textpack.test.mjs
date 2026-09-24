import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildTranscriptTextPack, writeTranscriptTextPack } from './textpack.mjs'

test('builds a transcript-only TextPack', () => {
  const pack = buildTranscriptTextPack({
    courseName: '国际法学',
    lessonTitle: '2026-06-03第5-6节',
    lessonKey: 'replay-1',
    teacher: '教师',
    transcript: '[00:00:01 – 00:00:03] 第一段\n\n[00:00:04 – 00:00:06] 第二段'
  })
  assert.equal(pack.schemaVersion, 'course-textpack.v1')
  assert.equal(pack.lessons.length, 1)
  assert.equal(pack.ppt_text.length, 0)
  assert.equal(pack.lessons[0].key, 'replay-1')
  assert.ok(pack.manifest.sourceHash)
})

test('writes TextPack atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-tech-textpack-'))
  const output = path.join(dir, 'pack.json')
  writeTranscriptTextPack({ courseName: '课程', lessonTitle: '课次', transcript: '正文' }, output)
  assert.ok(fs.existsSync(output))
  assert.equal(fs.existsSync(`${output}.part`), false)
})
