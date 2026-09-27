import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolError } from './errors.mjs'
import { parseServerArgv, resolveSettings, USAGE } from './settings.mjs'

test('parseServerArgv：只认三个选项，支持 --k=v 与 --k v 两种写法', () => {
  const parsed = parseServerArgv(['--library', '/tmp/library.json', '--origin=https://example.com/', '--ttl', '30'])
  assert.deepEqual(parsed, { help: false, library: '/tmp/library.json', origin: 'https://example.com/', ttl: '30' })
  assert.equal(parseServerArgv(['--help']).help, true)
  assert.equal(parseServerArgv(['-h']).help, true)
})

test('parseServerArgv：未知选项、缺取值、位置参数都要报错', () => {
  assert.throws(() => parseServerArgv(['--nope']), /无法识别的参数/)
  assert.throws(() => parseServerArgv(['--library']), /--library 缺少取值/)
  assert.throws(() => parseServerArgv(['library.json']), /无法识别的参数/)
})

test('resolveSettings：命令行 > 环境变量 > 默认值；本地优先', () => {
  const env = { COURSE_LIBRARY: '/env/library.json', COURSE_SITE_ORIGIN: 'https://env.example.com', COURSE_MCP_TTL_SECONDS: '5' }
  const fromEnv = resolveSettings({ env })
  assert.equal(fromEnv.library, '/env/library.json')
  assert.equal(fromEnv.source, 'local')
  assert.equal(fromEnv.origin, 'https://env.example.com')
  assert.equal(fromEnv.ttlSeconds, 5)

  const overridden = resolveSettings({ env, overrides: { library: '/cli/library.json', origin: 'https://cli.example.com/', ttl: '90' } })
  assert.deepEqual(overridden, { library: '/cli/library.json', origin: 'https://cli.example.com', ttlSeconds: 90, source: 'local' })

  const defaults = resolveSettings({ env: {} })
  assert.deepEqual(defaults, { library: '', origin: 'https://course.law-tech.dev', ttlSeconds: 60, source: 'remote' })

  // 空白字符串视为没配：客户端配置里常留空的 COURSE_LIBRARY，不能因此报错
  assert.equal(resolveSettings({ env: { COURSE_LIBRARY: '  ' } }).source, 'remote')
})

test('resolveSettings：非法 ttl 立刻报错', () => {
  assert.throws(() => resolveSettings({ env: {}, overrides: { ttl: '很快' } }), ToolError)
  assert.throws(() => resolveSettings({ env: {}, overrides: { ttl: '-1' } }), /非负数字/)
})

test('USAGE 写清了数据源与工具分层', () => {
  assert.match(USAGE, /--library/)
  assert.match(USAGE, /list_courses/)
  assert.match(USAGE, /docs\/12/)
})
