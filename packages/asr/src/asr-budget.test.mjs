import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  reserveAsrBudget
} from './asr-budget.mjs'

test('ASR reservation is idempotent for the same replay', () => {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'course-asr-budget-')
  )
  const options = {
    scratchRoot,
    replayKey: 'replay-one',
    durationSeconds: 3600,
    now: new Date('2026-06-30T04:00:00.000Z'),
    budget: {
      allowPaid: true,
      freeSecondsBudget: 0,
      maxTaskSeconds: 14400,
      dailyMaxSeconds: 28800,
      maxTaskCostCny: 2,
      dailyMaxCostCny: 5,
      pricePerHourCny: 0.288,
      timeZone: 'Asia/Shanghai'
    }
  }
  const first = reserveAsrBudget(options)
  const second = reserveAsrBudget(options)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.durationSeconds, 3600)
})

test('paid-disabled mode blocks a task that exceeds the configured free seconds', () => {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'course-asr-budget-')
  )
  assert.throws(
    () => reserveAsrBudget({
      scratchRoot,
      replayKey: 'replay-expensive',
      durationSeconds: 7200,
      budget: {
        allowPaid: false,
        freeSecondsBudget: 6000,
        maxTaskSeconds: 14400,
        dailyMaxSeconds: 28800,
        maxTaskCostCny: 2,
        dailyMaxCostCny: 5,
        pricePerHourCny: 0.288,
        timeZone: 'Asia/Shanghai'
      }
    }),
    error => error.code === 'COURSE_ASR_PAID_DISABLED'
  )
})

test('daily budget defers the second task without consuming a technical attempt', () => {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'course-asr-budget-')
  )
  const budget = {
    allowPaid: true,
    freeSecondsBudget: 0,
    maxTaskSeconds: 14400,
    dailyMaxSeconds: 5000,
    maxTaskCostCny: 2,
    dailyMaxCostCny: 5,
    pricePerHourCny: 0.288,
    timeZone: 'Asia/Shanghai'
  }
  reserveAsrBudget({
    scratchRoot,
    replayKey: 'replay-a',
    durationSeconds: 3000,
    budget
  })
  assert.throws(
    () => reserveAsrBudget({
      scratchRoot,
      replayKey: 'replay-b',
      durationSeconds: 3000,
      budget
    }),
    error =>
      error.code === 'COURSE_ASR_DAILY_BUDGET_DEFERRED' &&
      error.retryable === true
  )
})

test('zero daily limits keep only the per-task ASR guard', () => {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'course-asr-budget-')
  )
  const budget = {
    allowPaid: true,
    freeSecondsBudget: 0,
    maxTaskSeconds: 16200,
    dailyMaxSeconds: 0,
    maxTaskCostCny: 2,
    dailyMaxCostCny: 0,
    pricePerHourCny: 0.288,
    timeZone: 'Asia/Shanghai'
  }

  reserveAsrBudget({
    scratchRoot,
    replayKey: 'replay-a',
    durationSeconds: 12000,
    budget
  })
  const second = reserveAsrBudget({
    scratchRoot,
    replayKey: 'replay-b',
    durationSeconds: 12000,
    budget
  })

  assert.equal(second.dailyReservedSeconds, 24000)
})
