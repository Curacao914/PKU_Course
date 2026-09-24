import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REPLAY_IDENTITY_VERSION,
  assertNoSecrets,
  chooseCurrentCourses,
  compareWithState,
  courseKey,
  dedupeRecordings,
  normalizeCourseName,
  normalizeRecordingRow,
  parseCourseLabel,
  replayKey,
  semanticReplayIdentity
} from './platform-core.mjs'

test('normalizeCourseName strips term suffix, prefix and extra spaces', () => {
  // 四位年份与两位年份都必须剥除（两位是原实现唯一支持的形式）
  assert.equal(normalizeCourseName('国际法学（2025-2026学年第1学期）'), '国际法学')
  assert.equal(normalizeCourseName('国际法学（25-26学年第1学期）'), '国际法学')
  assert.equal(normalizeCourseName('张老师：国际法学'), '国际法学')
  assert.equal(normalizeCourseName('  国际   法学  '), '国际 法学')
  assert.equal(normalizeCourseName(''), '')
})

test('parseCourseLabel splits platform code, name and term', () => {
  const parsed = parseCourseLabel('00412-张老师：国际法学（2025-2026学年第1学期）')
  assert.equal(parsed.platformDisplayCode, '00412-张老师')
  assert.equal(parsed.termCode, '00412')
  assert.equal(parsed.name, '国际法学')
  assert.equal(parsed.term, '2025-2026学年第1学期')
  assert.equal(parsed.normalizedName, '国际法学')
})

test('courseKey and replayKey are stable and non-reversible', () => {
  const key = courseKey('国际法学|2025-2026学年第1学期')
  assert.match(key, /^course-[0-9a-f]{24}$/)
  assert.equal(key, courseKey('国际法学|2025-2026学年第1学期'))

  const recording = { title: '2026-06-03第5-6节', startsAtText: '2026-06-03 13:00', teacher: '陈晓航' }
  const replay = replayKey(key, recording)
  assert.match(replay, /^replay-[0-9a-f]{24}$/)
  assert.equal(replay, replayKey(key, recording))
  assert.notEqual(replay, replayKey(key, { ...recording, teacher: '其他老师' }))
})

test('replay identity ignores whitespace differences but not content', () => {
  const messy = { title: '  2026-06-03第5-6节 ', startsAtText: '2026-06-03\n13:00', teacher: ' 陈晓航 ' }
  const clean = { title: '2026-06-03第5-6节', startsAtText: '2026-06-03 13:00', teacher: '陈晓航' }
  assert.equal(semanticReplayIdentity(messy), semanticReplayIdentity(clean))
})

test('normalizeRecordingRow collapses a table row into named fields', () => {
  assert.deepEqual(normalizeRecordingRow(['  国际法学  ', '2026-06-03', '陈晓航', '观看']), {
    title: '国际法学',
    startsAtText: '2026-06-03',
    teacher: '陈晓航',
    operation: '观看'
  })
  assert.deepEqual(normalizeRecordingRow(undefined), { title: '', startsAtText: '', teacher: '', operation: '' })
})

test('dedupeRecordings keeps the first of each semantic identity', () => {
  const a = { replayKey: 'replay-1', title: '第一讲', startsAtText: '2026-06-03', teacher: '陈' }
  const b = { replayKey: 'replay-1', title: '第一讲', startsAtText: '2026-06-03', teacher: '陈' }
  const c = { title: '第二讲', startsAtText: '2026-06-10', teacher: '陈' }
  const d = { title: '第二讲', startsAtText: '2026-06-10', teacher: '陈' }
  assert.equal(dedupeRecordings([a, b, c, d]).length, 2)
})

test('chooseCurrentCourses prefers explicit current section, then newest term code', () => {
  const explicit = [
    { name: 'A', section: 'past', termCode: '00412' },
    { name: 'B', section: 'current', termCode: '00100' }
  ]
  assert.deepEqual(chooseCurrentCourses(explicit).map(c => c.name), ['B'])

  const byTerm = [
    { name: 'A', termCode: '00412' },
    { name: 'B', termCode: '00500' },
    { name: 'C', termCode: '00300' }
  ]
  assert.deepEqual(chooseCurrentCourses(byTerm).map(c => c.name), ['B'])
})

test('compareWithState initialises a baseline then reports only genuinely new replays', () => {
  const key = courseKey('国际法学')
  const first = { replayKey: replayKey(key, { title: '第一讲', startsAtText: '2026-06-03', teacher: '陈' }), title: '第一讲', startsAtText: '2026-06-03', teacher: '陈' }
  const second = { replayKey: replayKey(key, { title: '第二讲', startsAtText: '2026-06-10', teacher: '陈' }), title: '第二讲', startsAtText: '2026-06-10', teacher: '陈' }

  const run1 = compareWithState([{ courseKey: key, recordings: [first] }], null, '2026-09-24T00:00:00.000Z')
  assert.equal(run1.baselineInitialized, true)
  assert.equal(run1.newReplayCount, 0)
  assert.equal(run1.courses[0].recordings[0].isNew, false)
  assert.equal(run1.nextState.replayIdentityVersion, REPLAY_IDENTITY_VERSION)

  const run2 = compareWithState([{ courseKey: key, recordings: [first, second] }], run1.nextState, '2026-09-25T00:00:00.000Z')
  assert.equal(run2.baselineInitialized, false)
  assert.equal(run2.newReplayCount, 1)
  assert.deepEqual(run2.courses[0].recordings.map(r => r.isNew), [false, true])

  const upgraded = compareWithState([{ courseKey: key, recordings: [first] }], { replayIdentityVersion: 'semantic-v1', courses: {} })
  assert.equal(upgraded.baselineResetReason, 'replay-identity-version-upgrade')
  assert.equal(upgraded.baselineInitialized, true)
})

test('assertNoSecrets rejects URLs, credentials and forbidden fields', () => {
  assert.equal(assertNoSecrets({ courseName: '国际法学', count: 3 }), true)
  assert.throws(() => assertNoSecrets({ page: 'https://course.pku.edu.cn/webapps/login' }), /URL/)
  assert.throws(() => assertNoSecrets({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij' }), /credential/)
  assert.throws(() => assertNoSecrets({ header: 'Bearer abcdefghijklmnop' }), /credential/)
  assert.throws(() => assertNoSecrets({ link: 'https://x/y?token=abcdef' }), /URL/)
  assert.throws(() => assertNoSecrets({ cookie: 'anything' }), /forbidden field/)
  assert.throws(() => assertNoSecrets({ nested: [{ Authorization: 'x' }] }), /forbidden field/)
})
