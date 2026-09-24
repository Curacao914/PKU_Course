import assert from 'node:assert/strict'
import test from 'node:test'

import { createValidatedAcquisitionRuntime, resolveAcquisitionLimits } from './acquisition-runtime.mjs'

test('resolveAcquisitionLimits falls back to safe defaults on an empty environment', () => {
  assert.deepEqual(resolveAcquisitionLimits({}), {
    startUrl: 'https://course.pku.edu.cn/',
    concurrency: 6,
    fetchAttempts: 4,
    segmentTimeoutMs: 90_000,
    progressEvery: 5
  })
})

test('resolveAcquisitionLimits clamps out-of-range overrides', () => {
  const limits = resolveAcquisitionLimits({
    COURSE_DOWNLOAD_CONCURRENCY: '99',
    COURSE_FETCH_ATTEMPTS: '0',
    COURSE_SEGMENT_TIMEOUT_MS: '5000',
    COURSE_DOWNLOAD_PROGRESS_EVERY: '1000',
    COURSE_START_URL: 'https://example.invalid/portal'
  })
  assert.equal(limits.concurrency, 8)
  assert.equal(limits.fetchAttempts, 1)
  assert.equal(limits.segmentTimeoutMs, 10_000)
  assert.equal(limits.progressEvery, 100)
  assert.equal(limits.startUrl, 'https://example.invalid/portal')
})

test('resolveAcquisitionLimits never lets a malformed value become NaN', () => {
  // 旧实现用 Number(env || fallback) + Math.max/min，'abc' 会得到 NaN 并一路传播
  const limits = resolveAcquisitionLimits({
    COURSE_DOWNLOAD_CONCURRENCY: 'abc',
    COURSE_FETCH_ATTEMPTS: '',
    COURSE_SEGMENT_TIMEOUT_MS: '  ',
    COURSE_DOWNLOAD_PROGRESS_EVERY: 'NaN'
  })
  assert.equal(limits.concurrency, 6)
  assert.equal(limits.fetchAttempts, 4)
  assert.equal(limits.segmentTimeoutMs, 90_000)
  assert.equal(limits.progressEvery, 5)
})

test('reading limits does not require the environment loader to run first', () => {
  // 旧实现是模块顶层 const：import 之后再改 env 无效。
  // 现在每次解析，环境在 import 之后设置同样生效。
  const before = resolveAcquisitionLimits().concurrency
  process.env.COURSE_DOWNLOAD_CONCURRENCY = '3'
  assert.equal(resolveAcquisitionLimits().concurrency, 3)
  delete process.env.COURSE_DOWNLOAD_CONCURRENCY
  assert.equal(resolveAcquisitionLimits().concurrency, before)
  assert.equal(typeof createValidatedAcquisitionRuntime, 'function')
})
