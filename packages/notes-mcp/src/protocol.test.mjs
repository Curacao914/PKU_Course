import assert from 'node:assert/strict'
import test from 'node:test'

import { createFixtureService } from './fixtures/fixture.mjs'
import { createProtocolServer, PREFERRED_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.mjs'

const service = createFixtureService()
const logs = []
const server = createProtocolServer({ service, logger: line => logs.push(line) })
const NOTE_ONE = 'notes/国际法学/第一课-国家责任的构成'

const request = (id, method, params) => server.handleMessage({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const initialize = protocolVersion => request(1, 'initialize', {
  protocolVersion,
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' }
})

test('initialize：协商版本、声明能力、给出分层 instructions', async () => {
  const response = await initialize('2025-11-25')
  assert.equal(response.result.protocolVersion, '2025-11-25')
  assert.deepEqual(response.result.capabilities, { tools: {}, resources: {} })
  assert.equal(response.result.serverInfo.name, 'course-notes')
  assert.match(response.result.instructions, /list_courses/)
  assert.match(response.result.instructions, /get_note/)
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
})

test('initialize：客户端要哪个（受支持的）版本就回哪个，不支持的回自己最新的', async () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal((await initialize(version)).result.protocolVersion, version)
  }
  // 2026-07-28 起是没有 initialize 的新纪元：本服务器不装懂，按规范回自己支持的版本，
  // 只支持新纪元的客户端会先用 server/discover 探测并回落到 initialize（见 docs/12）
  assert.equal((await initialize('2026-07-28')).result.protocolVersion, PREFERRED_PROTOCOL_VERSION)
  assert.equal((await initialize('')).result.protocolVersion, PREFERRED_PROTOCOL_VERSION)
})

test('notifications/initialized 与未知通知都不产生响应', async () => {
  assert.equal(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/whatever' }), null)
  assert.equal(logs.length, 0)
})

test('tools/list：五个工具，名字唯一、描述与 inputSchema 齐备、不泄漏内部字段', async () => {
  const response = await request(2, 'tools/list')
  const tools = response.result.tools
  assert.deepEqual(tools.map(tool => tool.name), ['list_courses', 'get_course', 'search_notes', 'get_note', 'list_terms'])
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length)
  for (const tool of tools) {
    assert.ok(tool.description.length > 20, tool.name)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal('run' in tool, false)
  }
  for (const name of ['get_course', 'search_notes', 'list_terms']) {
    assert.deepEqual(tools.find(tool => tool.name === name).inputSchema.required, name === 'search_notes' ? ['query'] : ['course'])
  }
  // 定义必须能原样过 JSON（响应是要写到 stdout 的一行）
  assert.deepEqual(tools, JSON.parse(JSON.stringify(tools)))
})

test('tools/call：返回紧凑文本，错误参数走 isError', async () => {
  const response = await request(3, 'tools/call', { name: 'list_courses', arguments: {} })
  assert.equal(response.result.isError, false)
  assert.equal(response.result.content[0].type, 'text')
  assert.match(response.result.content[0].text, /国际法学/)
  assert.match(response.result.content[0].text, /get_course/)

  const badLimit = await request(4, 'tools/call', { name: 'list_courses', arguments: { limit: 999 } })
  assert.equal(badLimit.result.isError, true)
  assert.match(badLimit.result.content[0].text, /limit 不能大于 200/)

  const unknownField = await request(5, 'tools/call', { name: 'list_courses', arguments: { nope: 1 } })
  assert.equal(unknownField.result.isError, true)
  assert.match(unknownField.result.content[0].text, /未知字段/)

  const missing = await request(6, 'tools/call', { name: 'get_note', arguments: {} })
  assert.equal(missing.result.isError, true)
  assert.match(missing.result.content[0].text, /slug/)
})

test('tools/call：数字字符串能自动纠正，搜索与正文都能跑通', async () => {
  const search = await request(7, 'tools/call', { name: 'search_notes', arguments: { query: '有效控制', includeBody: 'true' } })
  assert.match(search.result.content[0].text, /二、归因/)

  const note = await request(8, 'tools/call', { name: 'get_note', arguments: { slug: NOTE_ONE, section: '归因', maxChars: '300' } })
  assert.match(note.result.content[0].text, /小节「二、归因」/)
})

test('tools/call：未知工具、arguments 不是对象都是协议错误', async () => {
  const unknown = await request(9, 'tools/call', { name: 'nope', arguments: {} })
  assert.equal(unknown.error.code, -32602)
  assert.match(unknown.error.message, /Unknown tool: nope/)

  const badArgs = await request(10, 'tools/call', { name: 'list_courses', arguments: ['x'] })
  assert.equal(badArgs.error.code, -32602)

  const noName = await request(11, 'tools/call', {})
  assert.equal(noName.error.code, -32602)

  const badParams = await request(12, 'tools/call', 'not-an-object')
  assert.equal(badParams.error.code, -32602)
})

test('tools/call：内部错误按 -32603 回，并记进 stderr 日志', async () => {
  const broken = createProtocolServer({
    service: {
      listCourses: () => { throw new Error('boom') },
      listResources: async () => [],
      resourceTemplates: () => [],
      readResource: async () => ({ uri: 'notes://courses', mimeType: 'text/plain', text: '' })
    },
    logger: line => logs.push(line)
  })
  const response = await broken.handleMessage({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'list_courses', arguments: {} } })
  assert.equal(response.error.code, -32603)
  assert.match(response.error.message, /内部错误/)
  assert.ok(logs.some(line => line.includes('boom')))
})

test('resources：list / templates / read 齐全，找不到的资源回 -32002', async () => {
  const list = await request(14, 'resources/list')
  assert.ok(list.result.resources.some(item => item.uri === 'notes://courses'))
  assert.ok(list.result.resources.some(item => item.uri.startsWith('notes://note/')))

  const templates = await request(15, 'resources/templates/list')
  assert.equal(templates.result.resourceTemplates.length, 3)

  const courses = await request(16, 'resources/read', { uri: 'notes://courses' })
  assert.equal(courses.result.contents[0].mimeType, 'application/json')
  assert.equal(JSON.parse(courses.result.contents[0].text).total, 3)

  const note = await request(17, 'resources/read', { uri: `notes://note/${encodeURIComponent(NOTE_ONE)}` })
  assert.equal(note.result.contents[0].mimeType, 'text/markdown')
  assert.match(note.result.contents[0].text, /^# 国际法学/)

  const missing = await request(18, 'resources/read', { uri: 'notes://nope' })
  assert.equal(missing.error.code, -32002)
  assert.equal(missing.error.data.uri, 'notes://nope')

  const noUri = await request(19, 'resources/read', {})
  assert.equal(noUri.error.code, -32602)
})

test('协议细节：ping、id=0、未知方法、坏消息、批量数组', async () => {
  const ping = await request(0, 'ping')
  assert.equal(ping.id, 0)
  assert.deepEqual(ping.result, {})

  const unknown = await request(20, 'prompts/list')
  assert.equal(unknown.error.code, -32601)
  assert.deepEqual(unknown.error.data, { method: 'prompts/list' })

  const badVersion = await server.handleMessage({ jsonrpc: '1.0', id: 21, method: 'ping' })
  assert.equal(badVersion.error.code, -32600)

  const noMethod = await server.handleMessage({ jsonrpc: '2.0', id: 22 })
  assert.equal(noMethod.error.code, -32600)

  const batch = await server.handleMessage([{ jsonrpc: '2.0', id: 23, method: 'ping' }])
  assert.equal(batch.error.code, -32600)
  assert.equal(batch.id, null)

  const notObject = await server.handleMessage('hello')
  assert.equal(notObject.error.code, -32600)
})
