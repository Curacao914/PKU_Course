import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { COMMANDS } from './args.mjs'
import { createCommands, USAGE } from './commands.mjs'

/**
 * course mcp 的两层验证：
 *   1) 命令层——配置解析与注入，不碰真实 stdio（否则测试会挂在那里等客户端）；
 *   2) 进程层——真的把 bin/course.mjs mcp 拉起来，走一遍 MCP 握手，确认接线没断。
 */

const WORKER_BIN = fileURLToPath(new URL('../bin/course.mjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../packages/notes-mcp/src/fixtures/library.json', import.meta.url))
const frame = message => `${JSON.stringify(message)}\n`

function collectLines(stream) {
  const state = { lines: [], buffer: '' }
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    state.buffer += chunk
    let index
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      state.lines.push(state.buffer.slice(0, index))
      state.buffer = state.buffer.slice(index + 1)
    }
  })
  return state
}

function waitForLines(state, count, timeoutMs = 10000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (state.lines.length >= count) return resolve(state.lines.slice())
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`等待 ${count} 行响应超时，实际收到：${JSON.stringify(state.lines)}`))
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

test('mcp 已登记进命令白名单与帮助文本', () => {
  assert.ok(COMMANDS.includes('mcp'))
  assert.match(USAGE, /mcp\s+\[--library/)
  assert.match(USAGE, /docs\/12/)
})

test('course mcp：命令行 > 环境变量，配置交给注入的服务器实现，且不污染 stdout', async () => {
  const lines = []
  const errors = []
  const calls = []
  const commands = createCommands({
    config: {},
    env: { COURSE_LIBRARY: '/env/library.json', COURSE_SITE_ORIGIN: 'https://env.example.com' },
    mcpServer: async payload => { calls.push(payload); return 0 },
    stdout: line => lines.push(String(line)),
    stderr: line => errors.push(String(line))
  })
  const code = await commands.mcp({ options: { origin: 'https://cli.example.com/', ttl: '15' }, flags: new Set() })
  assert.equal(code, 0)
  assert.deepEqual(lines, [], 'stdout 是 MCP 通道，命令本身一个字都不能写')
  assert.deepEqual(errors, [])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].settings, {
    library: '/env/library.json',
    origin: 'https://cli.example.com',
    ttlSeconds: 15,
    source: 'local'
  })
  assert.equal(calls[0].service.describe().kind, 'local')
  assert.equal(typeof calls[0].service.getNote, 'function')
})

test('course mcp：真实子进程握手 → 调工具 → 关闭 stdin 退出 0', async t => {
  const child = spawn(process.execPath, [WORKER_BIN, 'mcp', '--library', FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const stdout = collectLines(child.stdout)
  const stderr = collectLines(child.stderr)
  const exit = new Promise(resolve => child.on('exit', code => resolve(code)))

  child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }))
  child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_courses', arguments: {} } }))
  const lines = await waitForLines(stdout, 2)
  const responses = lines.map(line => JSON.parse(line))
  assert.equal(responses[0].result.serverInfo.name, 'course-notes')
  assert.equal(responses[0].result.protocolVersion, '2025-11-25')
  assert.match(responses[1].result.content[0].text, /国际法学/)

  child.stdin.end()
  assert.equal(await exit, 0)
  assert.ok(stderr.lines.some(line => line.includes('本地发布库')))
})
