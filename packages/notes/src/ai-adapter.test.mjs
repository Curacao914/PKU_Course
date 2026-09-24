import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMON_RULES,
  ROLE_MODEL_ENV,
  ROLE_SYSTEM,
  buildPrompt,
  callCourseModel,
  extractCourseModelContent,
  parseJsonResponse,
  requireCourseModelConfig
} from './ai-adapter.mjs'

const ENV = {
  COURSE_AI_API_KEY: 'sk-test',
  COURSE_AI_BASE_URL: 'https://ai.example/v1/',
  COURSE_AI_MODEL: 'default-model'
}

function reply(payload, { status = 200, body } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body !== undefined ? body : JSON.stringify(payload))
  }
}

function completion(content, extra = {}) {
  return { choices: [{ message: { content } }], usage: { total_tokens: 10 }, ...extra }
}

test('parseJsonResponse accepts plain, fenced and prose-wrapped payloads', () => {
  assert.deepEqual(parseJsonResponse('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonResponse('```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(parseJsonResponse('说明如下：\n{"a":3}\n以上。'), { a: 3 })
  assert.deepEqual(parseJsonResponse('{"a":4,"b":{"c":[1,2]}}'), { a: 4, b: { c: [1, 2] } })
})

test('parseJsonResponse survives the ways models actually break JSON', () => {
  // 思考过程
  assert.deepEqual(parseJsonResponse('<think>先想一下</think>{"a":1}'), { a: 1 })
  // 尾逗号
  assert.deepEqual(parseJsonResponse('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] })
  // 字符串里的裸换行（未转义）
  assert.deepEqual(parseJsonResponse('{"a":"第一行\n第二行"}'), { a: '第一行\n第二行' })
  // 双层编码：模型把 JSON 又序列化了一次
  assert.deepEqual(parseJsonResponse('"{\\"a\\":1}"'), { a: 1 })
  // BOM
  assert.deepEqual(parseJsonResponse('\uFEFF{"a":9}'), { a: 9 })
})

test('parseJsonResponse passes objects through and rejects空响应与垃圾', () => {
  const already = { markdown: '正文' }
  assert.equal(parseJsonResponse(already), already)
  assert.throws(() => parseJsonResponse(''), /Model response is empty/)
  assert.throws(() => parseJsonResponse('   '), /Model response is empty/)
  assert.throws(() => parseJsonResponse('这里没有任何 JSON'), /must be valid JSON/)
  assert.throws(() => parseJsonResponse('{未闭合'), /must be valid JSON/)
})

test('parseJsonResponse ignores arrays at top level', () => {
  // 顶层必须是对象：数组不是本工作流的合法输出
  assert.throws(() => parseJsonResponse('[1,2,3]'), /must be valid JSON/)
})

test('extractCourseModelContent understands the provider shapes in the wild', () => {
  assert.equal(extractCourseModelContent({ choices: [{ message: { content: '{"a":1}' } }] }), '{"a":1}')
  assert.equal(
    extractCourseModelContent({ choices: [{ message: { content: [{ text: '部分A' }, { text: '部分B' }] } }] }),
    '部分A部分B'
  )
  assert.deepEqual(
    extractCourseModelContent({ choices: [{ message: { content: { markdown: 'x' } } }] }),
    { markdown: 'x' }
  )
  assert.equal(
    extractCourseModelContent({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"a":2}' } }] } }] }),
    '{"a":2}'
  )
  assert.equal(extractCourseModelContent({ output_text: '{"a":3}' }), '{"a":3}')
  assert.equal(extractCourseModelContent({ choices: [{ text: '{"a":4}' }] }), '{"a":4}')
  assert.equal(extractCourseModelContent({ choices: [{ message: { reasoning_content: '{"a":5}' } }] }), '{"a":5}')
  assert.equal(extractCourseModelContent({}), '')
  assert.equal(extractCourseModelContent(null), '')
})

test('requireCourseModelConfig maps every role to its模型环境变量', () => {
  const env = { ...ENV, COURSE_OUTLINE_MODEL: 'outline-m', COURSE_WRITER_MODEL: 'writer-m' }
  assert.equal(requireCourseModelConfig('outline', null, env).model, 'outline-m')
  assert.equal(requireCourseModelConfig('outlineRepair', null, env).model, 'outline-m', '修复复用大纲模型')
  // grouping 未配置时回落到大纲模型
  assert.equal(requireCourseModelConfig('grouping', null, env).model, 'outline-m')
  // splicer 未配置时回落到最终审查或写作模型
  assert.equal(requireCourseModelConfig('splicer', null, env).model, 'writer-m')
  // 其余角色回落到通用默认模型
  assert.equal(requireCourseModelConfig('reviewer', null, env).model, 'default-model')

  const config = requireCourseModelConfig('writer', null, env)
  assert.equal(config.baseUrl, 'https://ai.example/v1', '结尾斜杠应被剥掉')
  assert.equal(config.source, 'environment')
  assert.equal(config.provider, 'openai-compatible')
  assert.ok(Object.keys(ROLE_MODEL_ENV).includes('finalReview'))
})

test('requireCourseModelConfig fails loudly with the variable to set', () => {
  assert.throws(() => requireCourseModelConfig('writer', null, {}), /COURSE_AI_API_KEY is required/)
  assert.throws(
    () => requireCourseModelConfig('reviewer', null, { COURSE_AI_API_KEY: 'sk' }),
    /COURSE_REVIEWER_MODEL is required/
  )
})

test('requireCourseModelConfig prefers an injected account config with role fallbacks', () => {
  const override = { apiKey: 'sk-account', baseUrl: 'https://api.deepseek.com/v1', models: { writer: 'w', default: 'd' } }
  assert.equal(requireCourseModelConfig('writer', override).model, 'w')
  assert.equal(requireCourseModelConfig('reviewer', override).model, 'd', '未配置的角色回落默认')
  assert.equal(requireCourseModelConfig('writer', override).source, 'override')
  assert.throws(() => requireCourseModelConfig('writer', { apiKey: 'sk' }), /尚未配置 writer 使用的模型/)
})

test('buildPrompt labels every block and marks empty inputs', () => {
  const prompt = buildPrompt({
    role: 'writer',
    promptVersion: 'v-test',
    courseSpec: { courseName: '刑法分论' },
    writerBrief: { nodeId: 'n1' },
    sourceText: '[L1] 正文',
    schema: { type: 'object' }
  })
  assert.equal(prompt.role, 'writer')
  assert.equal(prompt.version, 'v-test')
  assert.match(prompt.system, /课程节点撰写者/)
  assert.match(prompt.system, /Prompt version: v-test/)
  assert.ok(prompt.system.includes(COMMON_RULES))
  for (const label of ['CourseSpec', 'LessonBlueprint', 'WriterBrief', 'TranscriptSource', 'RequiredOutputSchema']) {
    assert.ok(prompt.user.includes(`## ${label}`), `缺少 ${label} 区块`)
  }
  // 文本区块缺失时显式标注 (empty)；JSON 区块即使为空对象也照常输出 {}，便于模型看到结构
  assert.match(prompt.user, /## PreviousNodeSummary\n\(empty\)/, '空文本区块应显式标注')
  assert.match(prompt.user, /## LessonBlueprint\n```json\n\{\}\n```/, '空 JSON 区块应输出空对象')
  assert.ok(prompt.user.trimEnd().endsWith('请只返回一个有效 JSON 对象。不得编造来源中不存在的内容。'))
})

test('buildPrompt falls back to the writer persona for an unknown role', () => {
  const prompt = buildPrompt({ role: 'nope', sourceText: 'x' })
  assert.match(prompt.system, /课程节点撰写者/)
  assert.ok(Object.keys(ROLE_SYSTEM).length >= 10, '十段角色提示词都应保留')
})

test('callCourseModel returns parsed content plus a trace', async () => {
  const seen = []
  const result = await callCourseModel({
    role: 'writer',
    prompt: buildPrompt({ role: 'writer', sourceText: 'x' }),
    env: { ...ENV, COURSE_AI_TEMPERATURE: '0.1' },
    fetchImpl: async (url, options) => {
      seen.push({ url, options })
      return reply(completion('{"markdown":"正文"}'))
    }
  })

  assert.deepEqual(result.parsed, { markdown: '正文' })
  assert.equal(result.trace.role, 'writer')
  assert.equal(result.trace.model, 'default-model')
  assert.equal(result.trace.attempts, 1)
  assert.deepEqual(result.trace.usage, { total_tokens: 10 })

  const body = JSON.parse(seen[0].options.body)
  assert.equal(seen[0].url, 'https://ai.example/v1/chat/completions')
  assert.equal(body.model, 'default-model')
  assert.equal(body.temperature, 0.1)
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user'])
})

test('callCourseModel retries once when the model returns unparsable text', async () => {
  let call = 0
  const result = await callCourseModel({
    role: 'outline',
    prompt: buildPrompt({ role: 'outline', sourceText: 'x' }),
    env: { ...ENV, COURSE_OUTLINE_MODEL: 'outline-m' },
    fetchImpl: async () => {
      call += 1
      return call === 1 ? reply(completion('这不是 JSON')) : reply(completion('{"nodes":[]}'))
    }
  })
  assert.equal(call, 2)
  assert.deepEqual(result.parsed, { nodes: [] })
  assert.equal(result.trace.attempts, 2)
  assert.equal(result.trace.model, 'outline-m')
})

test('callCourseModel gives up after the retry budget and keeps the parse cause', async () => {
  let call = 0
  await assert.rejects(
    () => callCourseModel({
      role: 'writer',
      prompt: buildPrompt({ role: 'writer', sourceText: 'x' }),
      env: { ...ENV, COURSE_AI_JSON_RETRIES: '1' },
      fetchImpl: async () => { call += 1; return reply(completion('仍然不是 JSON')) }
    }),
    error => {
      assert.match(error.message, /模型返回格式异常/)
      assert.ok(error.cause, '应保留最后一次解析失败作为 cause')
      assert.equal(error.meta.attempts, 2)
      return true
    }
  )
  assert.equal(call, 2)
})

test('callCourseModel surfaces provider errors with status, target and detail', async () => {
  await assert.rejects(
    () => callCourseModel({
      role: 'writer',
      prompt: buildPrompt({ role: 'writer', sourceText: 'x' }),
      env: ENV,
      fetchImpl: async () => reply(null, {
        status: 429,
        body: JSON.stringify({ error: { type: 'rate_limit', message: '慢一点' } })
      })
    }),
    error => {
      assert.match(error.message, /Course model call failed: 429/)
      assert.match(error.message, /ai\.example\/default-model/)
      assert.match(error.message, /rate_limit: 慢一点/)
      assert.equal(error.meta.status, 429)
      return true
    }
  )
})

test('callCourseModel rejects a malformed provider envelope', async () => {
  await assert.rejects(
    () => callCourseModel({
      role: 'writer',
      prompt: buildPrompt({ role: 'writer', sourceText: 'x' }),
      env: ENV,
      fetchImpl: async () => reply(null, { status: 200, body: 'not json at all' })
    }),
    /endpoint returned invalid JSON/
  )
})

test('callCourseModel classifies transport failures as timeout, cancel or network', async () => {
  const prompt = buildPrompt({ role: 'writer', sourceText: 'x' })

  const timeoutError = new Error('boom')
  timeoutError.name = 'TimeoutError'
  await assert.rejects(
    () => callCourseModel({ role: 'writer', prompt, env: ENV, fetchImpl: async () => { throw timeoutError } }),
    error => {
      assert.equal(error.code, 'course_model_timeout')
      assert.equal(error.retryable, true)
      assert.match(error.message, /timed out after \d+ms \(request\)/)
      return true
    }
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => callCourseModel({
      role: 'writer', prompt, env: ENV, signal: controller.signal,
      fetchImpl: async () => { throw new Error('should not be called') }
    }),
    error => {
      assert.equal(error.code, 'course_model_cancelled')
      assert.equal(error.retryable, false, '主动取消不应被当作可重试')
      return true
    }
  )

  await assert.rejects(
    () => callCourseModel({ role: 'writer', prompt, env: ENV, fetchImpl: async () => { throw new Error('ECONNRESET') } }),
    error => {
      assert.equal(error.code, 'course_model_request_failed')
      assert.equal(error.retryable, true)
      return true
    }
  )
})

test('an exhausted batch deadline fails before spending another request', async () => {
  let calls = 0
  await assert.rejects(
    () => callCourseModel({
      role: 'writer',
      prompt: buildPrompt({ role: 'writer', sourceText: 'x' }),
      env: ENV,
      config: { apiKey: 'sk', models: { default: 'm' }, deadlineAt: Date.now() - 1 },
      fetchImpl: async () => { calls += 1; return reply(completion('{}')) }
    }),
    error => {
      assert.equal(error.code, 'course_model_timeout')
      assert.match(error.message, /before-request/)
      return true
    }
  )
  assert.equal(calls, 0, '预算已耗尽时不应再发请求')
})
