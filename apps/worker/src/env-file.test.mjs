import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyEnvFile, parseEnvText, resolveEnvFile } from './env-file.mjs'

test('parseEnvText handles comments, blanks, export prefixes and quoting', () => {
  const parsed = parseEnvText(`
# 教学网凭据
PKU_USERNAME=student-id

export PKU_PASSWORD="p@ss word"
COURSE_HEADLESS=0        # 行尾注释会被当作值的一部分，因此不在此支持
R2_BUCKET='law-tech-assets'
not a valid line
1INVALID=skip
EMPTY=
`)
  assert.equal(parsed.PKU_USERNAME, 'student-id')
  assert.equal(parsed.PKU_PASSWORD, 'p@ss word')
  assert.equal(parsed.R2_BUCKET, 'law-tech-assets')
  assert.equal(parsed.EMPTY, '')
  assert.equal('1INVALID' in parsed, false)
  assert.equal(parsed.COURSE_HEADLESS, '0        # 行尾注释会被当作值的一部分，因此不在此支持')
})

test('applyEnvFile lets the existing environment win and reports what it applied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-env-'))
  const file = path.join(dir, 'env')
  fs.writeFileSync(file, [
    'PKU_USERNAME=from-file',
    'PKU_PASSWORD=from-file',
    'DASHSCOPE_API_KEY=from-file',
    ''
  ].join('\n'))

  const result = applyEnvFile({ PKU_USERNAME: 'from-shell' }, file)
  assert.equal(result.loaded, true)
  assert.equal(result.env.PKU_USERNAME, 'from-shell')
  assert.equal(result.env.PKU_PASSWORD, 'from-file')
  assert.deepEqual(result.keys.sort(), ['DASHSCOPE_API_KEY', 'PKU_PASSWORD'])
})

test('keys left blank in the file are not reported as applied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-env-'))
  const file = path.join(dir, 'env')
  fs.writeFileSync(file, [
    'COURSE_AI_API_KEY=sk-real',
    'COURSE_AI_BASE_URL=',
    'COURSE_AI_MODEL=   ',
    ''
  ].join('\n'))

  const result = applyEnvFile({}, file)
  assert.deepEqual(result.keys, ['COURSE_AI_API_KEY'], '留空的键不算已配置')
  assert.equal(result.env.COURSE_AI_BASE_URL, undefined, '留空不应写进环境，否则会掩盖默认值回落')
  assert.equal(result.env.COURSE_AI_MODEL, undefined)
})

test('applyEnvFile treats an empty existing variable as unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-env-'))
  const file = path.join(dir, 'env')
  fs.writeFileSync(file, 'PKU_USERNAME=from-file\n')
  const result = applyEnvFile({ PKU_USERNAME: '   ' }, file)
  assert.equal(result.env.PKU_USERNAME, 'from-file')
})

test('applyEnvFile is a no-op when the file is absent', () => {
  const result = applyEnvFile({ A: '1' }, path.join(os.tmpdir(), 'course-env-does-not-exist'))
  assert.equal(result.loaded, false)
  assert.deepEqual(result.env, { A: '1' })
  assert.deepEqual(result.keys, [])
})

test('resolveEnvFile prefers the explicit path, then COURSE_ENV_FILE, then the default', () => {
  assert.equal(resolveEnvFile({ COURSE_ENV_FILE: '/tmp/a' }, '/tmp/b'), '/tmp/b')
  assert.equal(resolveEnvFile({ COURSE_ENV_FILE: '/tmp/a' }), '/tmp/a')
  assert.match(resolveEnvFile({}), /\.course-worker\/env$/)
})
