import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareFirstPublishedDescending,
  compareLessonAscending,
  compareLessonDescending,
  dateOnly,
  firstPublishedAtOf,
  lessonDateOf,
  parseDateFromText,
  resolveLessonDate,
  updatedAtOf
} from './lesson-date.mjs'

test('从课次标题里读出上课日期，读不到就不编一个', () => {
  assert.equal(parseDateFromText('2026-09-20第2-4节'), '2026-09-20')
  assert.equal(parseDateFromText('2026-09-07第5-6节'), '2026-09-07')
  assert.equal(parseDateFromText('第10-12节 共犯与罪数'), '', '不带日期的旧标题不该猜出日期')
  assert.equal(parseDateFromText('第3-4节'), '')
  // 账本里的 starts_at_text 是 "2026-05-27 13:00" 这种写法
  assert.equal(parseDateFromText('2026-05-27 13:00'), '2026-05-27')
  assert.equal(parseDateFromText('2026年9月7日第5-6节'), '2026-09-07')
  assert.equal(parseDateFromText('2026.9.7'), '2026-09-07')
  // 不存在的日期不返回（宁可没有，也不要一个假日期）
  assert.equal(parseDateFromText('2026-02-30'), '')
  assert.equal(parseDateFromText(''), '')

  assert.equal(dateOnly('2026-09-25T03:00:00.000Z'), '2026-09-25')
  assert.equal(dateOnly('2026-09-25'), '2026-09-25')
  assert.equal(dateOnly('昨天'), '')
})

test('lessonDate 的解析顺序：显式 > 标题 > 账本 > 已有值 > 发布时间', () => {
  assert.deepEqual(
    resolveLessonDate({
      explicit: '2026-10-12', lessonTitle: '2026-09-20第2-4节', startsAtText: '2026-09-19 13:00',
      previousLessonDate: '2026-09-01', fallbackAt: '2026-09-25T00:00:00.000Z'
    }),
    { lessonDate: '2026-10-12', lessonDateSource: 'explicit' }
  )
  assert.deepEqual(
    resolveLessonDate({ lessonTitle: '2026-09-20第2-4节', startsAtText: '2026-09-19 13:00', fallbackAt: '2026-09-25T00:00:00.000Z' }),
    { lessonDate: '2026-09-20', lessonDateSource: 'title' }
  )
  assert.deepEqual(
    resolveLessonDate({ lessonTitle: '第10-12节', startsAtText: '2026-05-27 13:00', fallbackAt: '2026-09-25T00:00:00.000Z' }),
    { lessonDate: '2026-05-27', lessonDateSource: 'ledger' }
  )
  // 重新发布时标题与账本都没有日期：保持记录里已有的那一天，不跟着发布时间漂
  assert.deepEqual(
    resolveLessonDate({ lessonTitle: '第10-12节', previousLessonDate: '2026-05-27', fallbackAt: '2026-09-25T00:00:00.000Z' }),
    { lessonDate: '2026-05-27', lessonDateSource: 'previous' }
  )
  // 什么线索都没有：退回首次发布的日期，并且**标注来源**（调用方要在输出里说明这是猜的）
  assert.deepEqual(
    resolveLessonDate({ lessonTitle: '补课', fallbackAt: '2026-09-25T00:00:00.000Z' }),
    { lessonDate: '2026-09-25', lessonDateSource: 'published' }
  )
  assert.deepEqual(resolveLessonDate({}), { lessonDate: '', lessonDateSource: 'none' })
})

test('三个时间字段的读取都对老记录留了后路', () => {
  const modern = { lessonDate: '2026-05-27', firstPublishedAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }
  assert.equal(lessonDateOf(modern), '2026-05-27')
  assert.equal(firstPublishedAtOf(modern), '2026-09-25T00:00:00.000Z')
  assert.equal(updatedAtOf(modern), '2026-09-26T00:00:00.000Z')

  // 老发布库只有 publishedAt：它同时充当首次进站时间与展示日期（迁移时由 refreshRecord 补全）
  const legacy = { publishedAt: '2026-09-25T00:00:00.000Z' }
  assert.equal(lessonDateOf(legacy), '2026-09-25')
  assert.equal(firstPublishedAtOf(legacy), '2026-09-25T00:00:00.000Z')
  assert.equal(updatedAtOf(legacy), '2026-09-25T00:00:00.000Z')
  assert.equal(lessonDateOf({}), '')
})

test('课次排序按上课日期，同一天按标题定一个稳定次序', () => {
  const first = { lessonTitle: '2026-09-07第5-6节', lessonDate: '2026-09-07', slug: 'notes/a' }
  const second = { lessonTitle: '2026-09-20第2-4节', lessonDate: '2026-09-20', slug: 'notes/b' }
  const sameDayB = { lessonTitle: '2026-09-20第7-8节', lessonDate: '2026-09-20', slug: 'notes/c' }
  const sorted = [second, sameDayB, first].sort(compareLessonAscending)
  assert.deepEqual(sorted.map(item => item.slug), ['notes/a', 'notes/b', 'notes/c'])
  assert.deepEqual([...sorted].sort(compareLessonDescending).map(item => item.slug), ['notes/c', 'notes/b', 'notes/a'])
  // 同一批数据排两次结果相同（排序必须是确定的，页面才不会每次重生成都换样子）
  assert.deepEqual([second, first, sameDayB].sort(compareLessonAscending).map(item => item.slug),
    [second, first, sameDayB].sort(compareLessonAscending).map(item => item.slug))
})

test('RSS 的"新条目"按首次进站时间排，重新发布旧课不会把它顶到最前', () => {
  const older = { lessonTitle: '2026-09-07第5-6节', lessonDate: '2026-09-07', firstPublishedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
  const newer = { lessonTitle: '2026-09-20第2-4节', lessonDate: '2026-09-20', firstPublishedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' }
  assert.deepEqual([older, newer].sort(compareFirstPublishedDescending).map(item => item.lessonTitle),
    ['2026-09-20第2-4节', '2026-09-07第5-6节'])
})
