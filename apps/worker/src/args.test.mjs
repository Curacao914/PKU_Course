import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArgv, requireOption, UsageError } from './args.mjs'

test('parseArgv splits command, options and flags', () => {
  const parsed = parseArgv(['download', '--course-key', 'course-abc', '--replay-key=replay-1', '--json'])
  assert.equal(parsed.command, 'download')
  assert.deepEqual(parsed.options, { 'course-key': 'course-abc', 'replay-key': 'replay-1' })
  assert.deepEqual([...parsed.flags], ['json'])
})

test('parseArgv defaults to help and rejects unknown commands', () => {
  assert.equal(parseArgv([]).command, 'help')
  assert.throws(() => parseArgv(['frobnicate']), UsageError)
})

test('parseArgv rejects positional arguments and bare tokens', () => {
  assert.throws(() => parseArgv(['discover', '国际法学']), /无法识别的参数/)
  assert.throws(() => parseArgv(['discover', '--']), /无法识别的参数/)
})

test('a flag never swallows the following option', () => {
  const parsed = parseArgv(['discover', '--json', '--course', '刑法分论'])
  assert.equal(parsed.flags.has('json'), true)
  assert.equal(parsed.options.course, '刑法分论')
})

test('requireOption reports the command and option name', () => {
  assert.equal(requireOption({ media: ' a.mp4 ' }, 'media', 'transcribe'), 'a.mp4')
  assert.throws(() => requireOption({}, 'media', 'transcribe'), /transcribe 缺少必填选项 --media/)
  assert.throws(() => requireOption({ media: '   ' }, 'media', 'transcribe'), UsageError)
})
