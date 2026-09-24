import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COURSE_LLM_COST_MODES,
  CourseLlmWindowClosedError,
  DEFAULT_COURSE_LLM_SCHEDULE,
  assertCourseLlmWindowOpen,
  cleanTimezone,
  getCourseLlmWindowDecision,
  isCourseModelTask,
  normalizeCourseLlmSchedule
} from './llm-schedule.mjs'

/** 北京时间（UTC+8）的某个时刻 → Date */
const shanghai = (hour, minute = 0) =>
  new Date(Date.UTC(2026, 8, 25, hour - 8, minute, 0))

test('normalizeCourseLlmSchedule applies defaults and accepts aliases', () => {
  const defaults = normalizeCourseLlmSchedule({}, {})
  assert.equal(defaults.mode, 'economy')
  assert.equal(defaults.timezone, 'Asia/Shanghai')
  assert.equal(defaults.boundaryBufferMinutes, 10)
  assert.deepEqual(defaults.peakWindows, [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' }
  ])

  assert.equal(normalizeCourseLlmSchedule({ mode: 'off_peak_only' }, {}).mode, 'economy')
  assert.equal(normalizeCourseLlmSchedule({ mode: 'balanced' }, {}).mode, 'standard')
  assert.equal(normalizeCourseLlmSchedule({ mode: '胡说' }, {}).mode, 'economy')
  assert.ok(COURSE_LLM_COST_MODES.includes('immediate'))
})

test('peak windows parse from strings and fall back when unusable', () => {
  assert.deepEqual(
    normalizeCourseLlmSchedule({ peakWindows: '09:00-12:00, 14:00-18:00' }, {}).peakWindows,
    [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]
  )
  assert.deepEqual(
    normalizeCourseLlmSchedule({ peakWindows: [{ start: '9:00', end: '25:00' }] }, {}).peakWindows,
    DEFAULT_COURSE_LLM_SCHEDULE.peakWindows.map(w => ({ ...w })),
    '全部窗口非法时应回落到默认窗口'
  )
  assert.deepEqual(
    normalizeCourseLlmSchedule({ peakWindows: ['22:00-02:00', 'garbage'] }, {}).peakWindows,
    [{ start: '22:00', end: '02:00' }],
    '非法条目被丢弃，合法条目保留'
  )
})

test('boundary buffer and timezone are sanitised', () => {
  assert.equal(normalizeCourseLlmSchedule({ boundaryBufferMinutes: 999 }, {}).boundaryBufferMinutes, 60)
  assert.equal(normalizeCourseLlmSchedule({ boundaryBufferMinutes: -5 }, {}).boundaryBufferMinutes, 0)
  assert.equal(normalizeCourseLlmSchedule({ boundaryBufferMinutes: 'abc' }, {}).boundaryBufferMinutes, 10)

  assert.equal(cleanTimezone('Asia/Tokyo'), 'Asia/Tokyo')
  assert.equal(cleanTimezone('Not/AZone'), 'Asia/Shanghai')
  assert.equal(cleanTimezone(''), 'Asia/Shanghai')
  assert.equal(normalizeCourseLlmSchedule({ timezone: 'Bad/Zone' }, {}).timezone, 'Asia/Shanghai')
})

test('economy mode blocks the peak windows and reports when to retry', () => {
  const inside = getCourseLlmWindowDecision({ now: shanghai(10), schedule: { mode: 'economy' } })
  assert.equal(inside.allowed, false)
  assert.equal(inside.reason, 'peak-price-window')
  assert.equal(inside.activeWindow.start, '09:00')
  assert.equal(inside.activeWindow.effectiveStart, '08:50', 'economy 模式应把窗口向外扩出缓冲')
  assert.equal(inside.activeWindow.effectiveEnd, '12:10')
  assert.ok(inside.retryAfterMs >= 60_000)
  assert.equal(inside.nextAllowedAt, shanghai(12, 10).toISOString())

  const offPeak = getCourseLlmWindowDecision({ now: shanghai(8), schedule: { mode: 'economy' } })
  assert.equal(offPeak.allowed, true)
  assert.equal(offPeak.reason, 'off-peak')

  const between = getCourseLlmWindowDecision({ now: shanghai(13), schedule: { mode: 'economy' } })
  assert.equal(between.allowed, true, '两个高峰窗口之间应放行')
})

test('the boundary buffer is what economy adds and standard does not', () => {
  const bufferEdge = shanghai(8, 55)
  assert.equal(getCourseLlmWindowDecision({ now: bufferEdge, schedule: { mode: 'economy' } }).allowed, false)
  assert.equal(getCourseLlmWindowDecision({ now: bufferEdge, schedule: { mode: 'standard' } }).allowed, true)

  const secondEdge = shanghai(13, 55)
  assert.equal(getCourseLlmWindowDecision({ now: secondEdge, schedule: { mode: 'economy' } }).allowed, false)
  assert.equal(getCourseLlmWindowDecision({ now: secondEdge, schedule: { mode: 'standard' } }).allowed, true)
})

test('immediate mode always runs, including inside a peak window', () => {
  const decision = getCourseLlmWindowDecision({ now: shanghai(10), schedule: { mode: 'immediate' } })
  assert.equal(decision.allowed, true)
  assert.equal(decision.reason, 'immediate-override')
  assert.equal(decision.activeWindow, null)
})

test('overrideMode wins over the stored schedule without mutating it', () => {
  const schedule = { mode: 'economy' }
  const forced = getCourseLlmWindowDecision({ now: shanghai(10), schedule, overrideMode: 'immediate' })
  assert.equal(forced.allowed, true)
  assert.equal(schedule.mode, 'economy', '传入的日程对象不应被改写')
})

test('an overnight peak window is handled correctly', () => {
  const schedule = { mode: 'standard', peakWindows: [{ start: '22:00', end: '02:00' }] }
  assert.equal(getCourseLlmWindowDecision({ now: shanghai(23), schedule }).allowed, false)
  assert.equal(getCourseLlmWindowDecision({ now: shanghai(1), schedule }).allowed, false)
  assert.equal(getCourseLlmWindowDecision({ now: shanghai(3), schedule }).allowed, true)
  assert.equal(getCourseLlmWindowDecision({ now: shanghai(21), schedule }).allowed, true)
})

test('assertCourseLlmWindowOpen throws a retryable, self-describing error', () => {
  assert.doesNotThrow(() => assertCourseLlmWindowOpen({ now: shanghai(8), schedule: { mode: 'economy' } }))

  assert.throws(
    () => assertCourseLlmWindowOpen({ now: shanghai(10), schedule: { mode: 'economy' } }),
    error => {
      assert.ok(error instanceof CourseLlmWindowClosedError)
      assert.equal(error.code, 'COURSE_LLM_WINDOW_CLOSED')
      assert.equal(error.retryable, true, '高峰窗口应被上层当作可重试而不是失败')
      assert.equal(error.decision.allowed, false)
      return true
    }
  )
})

test('only model-consuming task types are gated', () => {
  for (const type of ['generate-outline', 'write-node', 'review-node', 'revise-node', 'assemble', 'final-review', 'group-materials', 'revise-final-note']) {
    assert.equal(isCourseModelTask({ type }), true, type)
  }
  assert.equal(isCourseModelTask({ type: 'plan-nodes' }), false)
  assert.equal(isCourseModelTask({}), false)
})
