import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createFixtureService, LIBRARY_PATH, startFakeSite } from './fixtures/fixture.mjs'
import { runStdioServer } from './stdio.mjs'

const BIN = fileURLToPath(new URL('../bin/notes-mcp.mjs', import.meta.url))
const NOTE_ONE = 'notes/国际法学/第一课-国家责任的构成'

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

function waitForLines(state, count, timeoutMs = 8000) {
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

function startServer(args = [], env = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, COURSE_LIBRARY: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stdout = collectLines(child.stdout)
  const stderr = collectLines(child.stderr)
  const exit = new Promise(resolve => child.on('exit', code => resolve(code)))
  return { child, stdout, stderr, exit }
}

test('runStdioServer：一行一条消息、顺序回应、通知不回、坏 JSON 回 -32700', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const logs = []
  const done = runStdioServer({ service: createFixtureService(), input, output, log: line => logs.push(line) })
  const stdout = collectLines(output)

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }))
  input.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  input.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
  input.write('这不是 JSON\n')
  input.write(frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_courses', arguments: {} } }))
  input.end()
  await done

  const responses = stdout.lines.map(line => JSON.parse(line))
  assert.deepEqual(responses.map(item => item.id), [1, 2, null, 3])
  assert.equal(responses[0].result.protocolVersion, '2025-06-18')
  assert.equal(responses[0].result.capabilities.resources !== undefined, true)
  assert.equal(responses[1].result.tools.length, 7)
  assert.equal(responses[2].error.code, -32700)
  assert.match(responses[3].result.content[0].text, /国际法学/)
  assert.ok(logs.some(line => line.includes('就绪')))
  // stdout 里除了协议消息不该有别的（日志全在 stderr）
  assert.equal(stdout.lines.every(line => line.startsWith('{')), true)
})

test('子进程：COURSE_LIBRARY 走本地发布库，握手 → 调工具 → 关闭 stdin 退出 0', async t => {
  const server = startServer([], { COURSE_LIBRARY: LIBRARY_PATH })
  t.after(() => server.child.kill('SIGKILL'))
  server.child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }))
  server.child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_course', arguments: { course: '刑法总论', includeOutline: true } } }))
  const lines = await waitForLines(server.stdout, 2)
  const responses = lines.map(line => JSON.parse(line))
  assert.equal(responses[0].result.serverInfo.name, 'course-notes')
  assert.match(responses[1].result.content[0].text, /第一课 罪刑法定/)
  assert.match(responses[1].result.content[0].text, /一、法律主义/)

  server.child.stdin.end()
  assert.equal(await server.exit, 0)
  assert.ok(server.stderr.lines.some(line => line.includes('本地发布库')))
})

test('子进程：本地库优先（即使同时给了 --origin）；没配本地库时走远程站点', async t => {
  const site = await startFakeSite()
  t.after(() => site.close())

  // 同时给 --origin（指向一个死地址）与 COURSE_LIBRARY：必须用本地库，不碰网络
  const local = startServer(['--origin', 'http://127.0.0.1:1'], { COURSE_LIBRARY: LIBRARY_PATH })
  t.after(() => local.child.kill('SIGKILL'))
  local.child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: '罪刑法定' } } }))
  const localLines = await waitForLines(local.stdout, 1)
  assert.match(JSON.parse(localLines[0]).result.content[0].text, /刑法总论/)
  local.child.stdin.end()
  assert.equal(await local.exit, 0)

  // 不给 COURSE_LIBRARY（测试环境里显式清空）时，--origin 生效
  const remote = startServer(['--origin', site.origin, '--ttl', '30'])
  t.after(() => remote.child.kill('SIGKILL'))
  remote.child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: '罪刑法定' } } }))
  const remoteLines = await waitForLines(remote.stdout, 1)
  assert.match(JSON.parse(remoteLines[0]).result.content[0].text, /刑法总论/)
  assert.ok(site.requests.includes('/api/notes'))
  remote.child.stdin.end()
  assert.equal(await remote.exit, 0)
})

test('子进程：--help 打用法后退出 0；坏参数退出 2 且提示写进 stderr', async () => {
  const help = startServer(['--help'])
  const helpLines = await waitForLines(help.stdout, 1)
  assert.match(helpLines.join('\n'), /用法：notes-mcp/)
  assert.equal(await help.exit, 0)

  const bad = startServer(['--nope'])
  await bad.exit
  const badErr = await waitForLines(bad.stderr, 1)
  assert.match(badErr.join('\n'), /无法识别的参数/)
  assert.equal(await bad.exit, 2)
})

test('子进程：资源读取（notes://note/…）走同一条协议', async t => {
  const server = startServer([], { COURSE_LIBRARY: LIBRARY_PATH })
  t.after(() => server.child.kill('SIGKILL'))
  server.child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `notes://note/${encodeURIComponent(NOTE_ONE)}` } }))
  const lines = await waitForLines(server.stdout, 1)
  const contents = JSON.parse(lines[0]).result.contents
  assert.equal(contents[0].mimeType, 'text/markdown')
  assert.match(contents[0].text, /^# 国际法学/)
  server.child.stdin.end()
  assert.equal(await server.exit, 0)
})
