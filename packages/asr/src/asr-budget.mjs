import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PRICE_PER_HOUR = 0.288

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : fallback
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(
    String(value).trim().toLowerCase()
  )
}

function dateKey(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  )
  return `${values.year}-${values.month}-${values.day}`
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`
  )
  fs.renameSync(temporary, filePath)
}

function budgetError(code, message, options = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = Boolean(options.retryable)
  error.retryAfterMs = Number(options.retryAfterMs || 0)
  return error
}

export function resolveAsrBudget(env = process.env) {
  return {
    allowPaid: booleanValue(env.COURSE_ASR_ALLOW_PAID, false),
    freeSecondsBudget: Math.max(
      0,
      Number(env.COURSE_ASR_FREE_SECONDS_BUDGET || 0)
    ),
    maxTaskSeconds: positiveNumber(
      env.COURSE_ASR_MAX_TASK_SECONDS,
      4 * 60 * 60
    ),
    dailyMaxSeconds: nonNegativeNumber(
      env.COURSE_ASR_DAILY_MAX_SECONDS,
      8 * 60 * 60
    ),
    maxTaskCostCny: positiveNumber(
      env.COURSE_ASR_MAX_TASK_COST_CNY,
      2
    ),
    dailyMaxCostCny: nonNegativeNumber(
      env.COURSE_ASR_DAILY_MAX_COST_CNY,
      5
    ),
    pricePerHourCny: positiveNumber(
      env.COURSE_ASR_PRICE_PER_HOUR_CNY,
      DEFAULT_PRICE_PER_HOUR
    ),
    timeZone: String(
      env.COURSE_ASR_BUDGET_TIME_ZONE ||
      'Asia/Shanghai'
    )
  }
}

export function reserveAsrBudget(options = {}) {
  const scratchRoot = path.resolve(options.scratchRoot)
  const replayKey = String(options.replayKey || '').trim()
  const durationSeconds = Number(options.durationSeconds || 0)
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || Date.now())
  const budget = {
    ...resolveAsrBudget(options.env),
    ...(options.budget || {})
  }

  if (!replayKey) {
    throw budgetError(
      'COURSE_ASR_TASK_BUDGET_EXCEEDED',
      'ASR budget check requires replayKey'
    )
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw budgetError(
      'COURSE_ASR_TASK_BUDGET_EXCEEDED',
      'ASR budget check requires a valid media duration'
    )
  }

  const estimatedCostCny =
    durationSeconds / 3600 * budget.pricePerHourCny
  if (
    durationSeconds > budget.maxTaskSeconds ||
    estimatedCostCny > budget.maxTaskCostCny
  ) {
    throw budgetError(
      'COURSE_ASR_TASK_BUDGET_EXCEEDED',
      `课程预计转录 ${Math.round(durationSeconds)} 秒、` +
      `最高估算费用 ${estimatedCostCny.toFixed(3)} 元，` +
      '超过单任务费用保护上限。'
    )
  }

  const budgetDir = path.join(scratchRoot, 'budget')
  const day = dateKey(now, budget.timeZone)
  const dailyPath = path.join(budgetDir, `asr-${day}.json`)
  const daily = readJson(dailyPath, {
    schemaVersion: 1,
    date: day,
    reservations: {}
  })

  if (daily.reservations?.[replayKey]) {
    return {
      ...daily.reservations[replayKey],
      reused: true,
      date: day
    }
  }

  const reservations = Object.values(daily.reservations || {})
  const reservedSeconds = reservations.reduce(
    (sum, item) => sum + Number(item.durationSeconds || 0),
    0
  )
  const reservedCostCny = reservations.reduce(
    (sum, item) => sum + Number(item.estimatedCostCny || 0),
    0
  )

  const dailySecondsExceeded =
    budget.dailyMaxSeconds > 0 &&
    reservedSeconds + durationSeconds >
      budget.dailyMaxSeconds
  const dailyCostExceeded =
    budget.dailyMaxCostCny > 0 &&
    reservedCostCny + estimatedCostCny >
      budget.dailyMaxCostCny

  if (
    dailySecondsExceeded ||
    dailyCostExceeded
  ) {
    throw budgetError(
      'COURSE_ASR_DAILY_BUDGET_DEFERRED',
      '今日 ASR 时长或费用保护上限已达到，任务将在下一生产周期重试。',
      {
        retryable: true,
        retryAfterMs: 12 * 60 * 60 * 1000
      }
    )
  }

  if (!budget.allowPaid) {
    const freePath = path.join(budgetDir, 'asr-free-reservations.json')
    const free = readJson(freePath, {
      schemaVersion: 1,
      reservations: {}
    })
    const existingFreeReservation =
      free.reservations?.[replayKey] || null
    const usedFreeSeconds = Object.values(
      free.reservations || {}
    ).reduce(
      (sum, item) => sum + Number(item.durationSeconds || 0),
      0
    )
    if (
      !existingFreeReservation &&
      (
        budget.freeSecondsBudget <= 0 ||
        usedFreeSeconds + durationSeconds > budget.freeSecondsBudget
      )
    ) {
      throw budgetError(
        'COURSE_ASR_PAID_DISABLED',
        '未允许付费转录，且配置的剩余免费秒数不足以覆盖本课程。'
      )
    }
    if (!existingFreeReservation) {
      free.reservations[replayKey] = {
        replayKey,
        durationSeconds,
        estimatedCostCny,
        reservedAt: now.toISOString()
      }
      writeJsonAtomic(freePath, free)
    }
  }

  const reservation = {
    replayKey,
    durationSeconds,
    estimatedCostCny,
    reservedAt: now.toISOString(),
    paidAllowed: Boolean(budget.allowPaid)
  }
  daily.reservations = {
    ...(daily.reservations || {}),
    [replayKey]: reservation
  }
  writeJsonAtomic(dailyPath, daily)

  return {
    ...reservation,
    reused: false,
    date: day,
    dailyReservedSeconds: reservedSeconds + durationSeconds,
    dailyReservedCostCny: reservedCostCny + estimatedCostCny
  }
}
