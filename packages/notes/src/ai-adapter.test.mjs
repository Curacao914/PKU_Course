import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMON_RULES,
  ROLE_MODEL_ENV,
  ROLE_SYSTEM,
  buildPrompt,
  callCourseModel,
  extractCourseModelContent,
  isRetryableStatus,
  parseJsonResponse,
  requireCourseModelConfig,
  retryDelayFor
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

test('传输层重试：429 与 5xx 会重试，其余 4xx 立即失败', async () => {
  const call = fetchImpl => callCourseModel({
    role: 'writer',
    prompt: buildPrompt({ role: 'writer', sourceText: '转录', schema: { markdown: 'string' } }),
    env: ENV,
    fetchImpl,
    sleepImpl: async () => {},
    onRetry: () => {}
  })

  // 429 → 200：应当重试一次并成功，模型调用算 1 次成功
  let calls = 0
  const throttled = await call(async () => {
    calls += 1
    return calls === 1
      ? reply({ error: 'rate limited' }, { status: 429, body: '{"error":"rate limited"}' })
      : reply(completion('{"markdown":"正文"}'))
  })
  assert.equal(calls, 2, '429 之后要再试一次')
  assert.deepEqual(throttled.parsed, { markdown: '正文' })

  // 网络抖动 → 200：同样重试
  let networkCalls = 0
  const flaky = await call(async () => {
    networkCalls += 1
    if (networkCalls === 1) throw new TypeError('fetch failed')
    return reply(completion('{"markdown":"正文"}'))
  })
  assert.equal(networkCalls, 2)
  assert.deepEqual(flaky.parsed, { markdown: '正文' })

  // 500 一直失败：重试到上限后如实抛出，错误里带状态码与尝试次数
  let serverCalls = 0
  const error = await call(async () => {
    serverCalls += 1
    return reply({ error: 'boom' }, { status: 500, body: '{"error":"boom"}' })
  }).then(() => null, failure => failure)
  assert.equal(serverCalls, 3, '默认 2 次重试 = 最多 3 次尝试')
  assert.match(error.message, /failed: 500/)
  assert.equal(error.meta.transportAttempts, 3)

  // 401：重试没有意义，请求只发一次
  let authCalls = 0
  await call(async () => {
    authCalls += 1
    return reply({ error: 'unauthorized' }, { status: 401, body: '{"error":"unauthorized"}' })
  }).catch(() => {})
  assert.equal(authCalls, 1, '认证失败不重试，重试只是再浪费一次额度')
})

test('重试会报告给运维：谁在重试、第几次、等多久、为什么', async () => {
  const retries = []
  let calls = 0
  await callCourseModel({
    role: 'writer',
    prompt: buildPrompt({ role: 'writer', sourceText: '转录', schema: { markdown: 'string' } }),
    env: ENV,
    sleepImpl: async () => {},
    onRetry: info => retries.push(info),
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return reply({}, { status: 503, body: '{}', headers: { get: () => null } })
      return reply(completion('{"markdown":"正文"}'))
    }
  })
  assert.equal(retries.length, 1)
  assert.equal(retries[0].reason, 'HTTP 503')
  assert.equal(retries[0].attempt, 1)
  assert.ok(retries[0].delayMs >= 0)
})

test('退避策略：指数增长有上限、听 Retry-After、预算不够就不试', () => {
  assert.equal(isRetryableStatus(429), true)
  assert.equal(isRetryableStatus(503), true)
  assert.equal(isRetryableStatus(408), true)
  assert.equal(isRetryableStatus(400), false)
  assert.equal(isRetryableStatus(401), false)
  assert.equal(isRetryableStatus(404), false)

  const noHeader = { headers: { get: () => null } }
  const first = retryDelayFor({ attempt: 0, response: noHeader, now: 0, deadlineAt: 1_000_000 })
  const later = retryDelayFor({ attempt: 4, response: noHeader, now: 0, deadlineAt: 1_000_000 })
  assert.ok(first >= 375 && first <= 625, `首次退避约 500ms（含抖动），实际 ${first}`)
  assert.ok(later <= 8000, '退避有上限，不会一等就是几分钟')
  assert.ok(later > first, '退避总体递增')

  const withHeader = retryDelayFor({ attempt: 0, response: { headers: { get: () => '7' } }, now: 0, deadlineAt: 1_000_000 })
  assert.equal(withHeader, 7000, '服务端说等 7 秒就等 7 秒')
  const absurd = retryDelayFor({ attempt: 0, response: { headers: { get: () => '99999' } }, now: 0, deadlineAt: 1_000_000 })
  assert.equal(absurd, 60_000, '但也不能被服务端拖住一小时')

  assert.equal(retryDelayFor({ attempt: 0, response: noHeader, now: 0, deadlineAt: 0 }), null, '没有预算就不试')
  const clamped = retryDelayFor({ attempt: 3, response: noHeader, now: 0, deadlineAt: 3000 })
  assert.ok(clamped <= 2000, `退避不得越过总预算（实际 ${clamped}）`)
})

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
  assert.equal(requireCourseModelConfig('topicPlan', null, env).model, 'outline-m', '专题划分复用大纲模型')
  assert.equal(requireCourseModelConfig('topic', null, env).model, 'default-model', '专题框架未单配一页纸模型时回落通用模型')
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
