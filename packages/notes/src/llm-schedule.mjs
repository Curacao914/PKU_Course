/**
 * 课程 AI 的成本窗口闸门：economy 模式避开高峰计价时段，把批量写作推到低价窗口。
 *
 * 从 my-blog-main 的 lib/course/llmSchedule.js 摘出，逻辑保持原样，只补一处兜底：
 * 写错的时区名原本会在 zonedMinute 深处抛 RangeError，现在在归一化阶段就回落到
 * 默认时区——worker 循环里不该因为一个配置拼写错误整轮崩掉。
 */
export const COURSE_LLM_COST_MODES = ['economy', 'standard', 'immediate']

export const DEFAULT_COURSE_LLM_SCHEDULE = Object.freeze({
  mode: 'economy',
  timezone: 'Asia/Shanghai',
  peakWindows: Object.freeze([
    Object.freeze({ start: '09:00', end: '12:00' }),
    Object.freeze({ start: '14:00', end: '18:00' })
  ]),
  boundaryBufferMinutes: 10
})

const MINUTE_MS = 60 * 1000
const MAX_LOOKAHEAD_MINUTES = 48 * 60

function cleanMode(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'off_peak_only' || raw === 'off-peak-only') return 'economy'
  if (raw === 'normal' || raw === 'balanced') return 'standard'
  return COURSE_LLM_COST_MODES.includes(raw)
    ? raw
    : DEFAULT_COURSE_LLM_SCHEDULE.mode
}

/** 时区名无效时回落到默认值，而不是等到 Intl 在深处抛 RangeError。 */
export function cleanTimezone(value, fallback = DEFAULT_COURSE_LLM_SCHEDULE.timezone) {
  const candidate = String(value || '').trim() || fallback
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate })
    return candidate
  } catch {
    return fallback
  }
}

function parseClock(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function cleanWindow(value) {
  if (typeof value === 'string') {
    const [start, end] = value.split('-').map(item => item.trim())
    if (parseClock(start) == null || parseClock(end) == null) return null
    return { start, end }
  }
  if (!value || typeof value !== 'object') return null
  const start = String(value.start || '').trim()
  const end = String(value.end || '').trim()
  if (parseClock(start) == null || parseClock(end) == null) return null
  return { start, end }
}

function parseWindows(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const windows = source.map(cleanWindow).filter(Boolean)
  return windows.length
    ? windows
    : DEFAULT_COURSE_LLM_SCHEDULE.peakWindows.map(item => ({ ...item }))
}

function integer(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function normalizeCourseLlmSchedule(input = {}, env = process.env) {
  const peakWindows =
    input.peakWindows ??
    input.coursePeakWindows ??
    env.COURSE_LLM_PEAK_WINDOWS

  return {
    mode: cleanMode(
      input.mode ??
      input.courseCostMode ??
      env.COURSE_LLM_COST_MODE ??
      DEFAULT_COURSE_LLM_SCHEDULE.mode
    ),
    timezone: cleanTimezone(
      input.timezone ??
      input.courseTimezone ??
      env.COURSE_LLM_TIMEZONE ??
      DEFAULT_COURSE_LLM_SCHEDULE.timezone
    ),
    peakWindows: parseWindows(peakWindows),
    boundaryBufferMinutes: integer(
      input.boundaryBufferMinutes ??
      input.courseBoundaryBufferMinutes ??
      env.COURSE_LLM_BOUNDARY_BUFFER_MINUTES,
      DEFAULT_COURSE_LLM_SCHEDULE.boundaryBufferMinutes,
      0,
      60
    )
  }
}

function zonedMinute(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )
  return Number(values.hour) * 60 + Number(values.minute)
}

function insideRange(minute, start, end) {
  if (start === end) return true
  if (start < end) return minute >= start && minute < end
  return minute >= start || minute < end
}

function activePeakWindow(date, schedule) {
  if (schedule.mode === 'immediate') return null
  const minute = zonedMinute(date, schedule.timezone)
  const buffer = schedule.mode === 'economy'
    ? schedule.boundaryBufferMinutes
    : 0

  for (const window of schedule.peakWindows) {
    const rawStart = parseClock(window.start)
    const rawEnd = parseClock(window.end)
    if (rawStart == null || rawEnd == null) continue

    const start = (rawStart - buffer + 24 * 60) % (24 * 60)
    const end = (rawEnd + buffer) % (24 * 60)
    if (insideRange(minute, start, end)) {
      return {
        ...window,
        effectiveStart: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
        effectiveEnd: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
      }
    }
  }
  return null
}

function nextAllowedAt(now, schedule) {
  for (let offset = 1; offset <= MAX_LOOKAHEAD_MINUTES; offset += 1) {
    const candidate = new Date(now.getTime() + offset * MINUTE_MS)
    if (!activePeakWindow(candidate, schedule)) return candidate
  }
  return null
}

export function getCourseLlmWindowDecision({
  now = new Date(),
  schedule = {},
  overrideMode = ''
} = {}) {
  const normalized = normalizeCourseLlmSchedule({
    ...schedule,
    mode: overrideMode || schedule.mode
  })
  const activeWindow = activePeakWindow(now, normalized)

  if (!activeWindow) {
    return {
      allowed: true,
      mode: normalized.mode,
      timezone: normalized.timezone,
      reason: normalized.mode === 'immediate' ? 'immediate-override' : 'off-peak',
      activeWindow: null,
      nextAllowedAt: null,
      retryAfterMs: 0,
      checkedAt: now.toISOString()
    }
  }

  const next = nextAllowedAt(now, normalized)
  return {
    allowed: false,
    mode: normalized.mode,
    timezone: normalized.timezone,
    reason: 'peak-price-window',
    activeWindow,
    nextAllowedAt: next?.toISOString() || null,
    retryAfterMs: next
      ? Math.max(MINUTE_MS, next.getTime() - now.getTime())
      : 60 * MINUTE_MS,
    checkedAt: now.toISOString()
  }
}

export class CourseLlmWindowClosedError extends Error {
  constructor(decision) {
    super('当前处于课程 AI 高峰计价时段，任务已等待低价窗口。')
    this.name = 'CourseLlmWindowClosedError'
    this.code = 'COURSE_LLM_WINDOW_CLOSED'
    this.retryable = true
    this.decision = decision
  }
}

export function assertCourseLlmWindowOpen(options = {}) {
  const decision = getCourseLlmWindowDecision(options)
  if (!decision.allowed) throw new CourseLlmWindowClosedError(decision)
  return decision
}

export function isCourseModelTask(task = {}) {
  return new Set([
    'generate-outline',
    'write-node',
    'review-node',
    'revise-node',
    'assemble',
    'revise-final-note',
    'final-review',
    'group-materials'
  ]).has(task.type)
}
