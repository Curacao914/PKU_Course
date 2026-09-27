import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'

import { runCli } from './cli.mjs'
import {
  collectMissingMaterials,
  pptReminderSubject,
  renderPptReminderHtml,
  renderPptReminderText,
  stageLabel
} from './digest.mjs'

/**
 * 每晚 20:00 的缺课件提醒。
 *
 * 两条规矩必须钉死：**清单与 cycle 的判据是同一个**（materials 包的 listMaterials），
 * 以及**一节都不缺就不发邮件**（与 07:00 日报一样，"没变化就不打扰"）。
 * 发送器是注入的假实现——这些测试绝不真发邮件。
 */

/** 归档一份课件，形状与 packages/materials 一致（meta.json + slides/<名>.json）。 */
function writeDeck(scratchRoot, { course, lesson = '', scope = 'lesson', name = '课件.pptx' }) {
  const dir = scope === 'course'
    ? path.join(scratchRoot, 'materials', course, 'course')
    : path.join(scratchRoot, 'materials', course, lesson)
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
  const parsedPath = path.join(dir, 'slides', `${name}.json`)
  fs.writeFileSync(parsedPath, JSON.stringify({ slideCount: 1, slides: [{ slideNumber: 1, text: '正文' }], images: [], ocr: { pending: 0 } }))
  const metaPath = path.join(dir, 'meta.json')
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { materials: [] }
  meta.materials = [...(meta.materials || []), {
    name, scope, course, lesson: scope === 'course' ? '' : lesson, replayKey: '', appliesTo: [],
    bytes: 4, checksum: 'fixture', slideCount: 1, imageCount: 0, ocrPending: 0,
    parsedPath, addedAt: '2026-09-28T00:00:00.000Z'
  }]
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
}

/**
 * 一个最小的 CLI 夹具：内存账本 + 假邮件发送器。
 *
 * 固定时钟走 2026-09-28（北京时间），邮件标题里的日期才有确定值。
 */
function harness({ tasks = [], decks = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-ppt-reminder-'))
  const scratchRoot = path.join(dir, 'scratch')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const ledger = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  if (tasks.length) {
    ledger.discoverReplays(tasks.map(task => ({
      replay_key: task.replayKey,
      course_key: `key-${task.replayKey}`,
      course_name: task.courseName || '',
      title: task.title || ''
    })))
    for (const task of tasks) {
      if (!task.stage) continue
      ledger.reportStage({ id: ledger.getTask(task.replayKey).id, stage: task.stage })
    }
  }
  for (const deck of decks) writeDeck(scratchRoot, deck)

  const emails = []
  const lines = []
  const errors = []
  const deps = {
    env: {
      COURSE_WORKER_SCRATCH_DIR: scratchRoot,
      RESEND_API_KEY: 'sk-fake-resend-key',
      COURSE_DIGEST_FROM: 'course@law-tech.dev',
      COURSE_DIGEST_TO: 'owner@example.com'
    },
    now: () => new Date('2026-09-28T04:00:00Z'),   // 北京时间 12:00
    stdout: line => lines.push(String(line)),
    stderr: line => errors.push(String(line)),
    openStore: () => Object.create(ledger, { close: { value: () => {} } }),
    // 假发送器：记下参数，返回一个 id；绝不联网
    emailSender: async payload => { emails.push(payload); return { id: 'fake-email-1' } }
  }
  return { deps, emails, lines, errors, ledger, scratchRoot }
}

const parse = line => JSON.parse(line)

test('缺课件清单：有课件的、跑完的都不列，其余按课程课次排序并翻成人话', () => {
  const tasks = [
    { replayKey: 'r1', courseName: '刑法分论', title: '第10-12节', stage: 'transcript_ready' },
    { replayKey: 'r2', courseName: '刑法分论', title: '第7-9节', stage: 'downloaded' },
    { replayKey: 'r3', courseName: '商法概论', title: '第1-2节', stage: 'published' },
    { replayKey: 'r4', courseName: '商法概论', title: '第3-4节', stage: 'needs_attention' },
    { replayKey: 'r5', courseName: '刑法分论', title: '第1-2节', stage: 'discovered' }   // 有课件
  ]
  const missing = collectMissingMaterials({
    tasks,
    hasMaterials: task => task.replayKey === 'r5'
  })
  assert.deepEqual(missing.map(item => item.replayKey), ['r4', 'r1', 'r2'], '已发布的 r3 不该出现，r5 有课件也不该出现')
  assert.deepEqual(missing.map(item => item.lessonTitle), ['第3-4节', '第10-12节', '第7-9节'], '先按课程、再按课次标题排')
  assert.equal(missing[0].stageLabel, '需要人工处理')
  assert.equal(stageLabel('writing'), '写笔记中')
  assert.equal(stageLabel('某个新阶段'), '某个新阶段', '没登记过的阶段如实显示，不编一个人话')
})

test('邮件标题与正文：几节、课程课次、状态、管理台链接，没有元文案', () => {
  const missing = [
    { courseName: '刑法分论', lessonTitle: '第10-12节', stage: 'transcript_ready', stageLabel: '已转写，等写笔记' }
  ]
  assert.equal(pptReminderSubject(missing, { date: '2026-09-28' }), '缺课件提醒 · 2026-09-28 · 1 节待上传')

  const adminUrl = 'https://course.law-tech.dev/admin'
  const text = renderPptReminderText(missing, { adminUrl, date: '2026-09-28' })
  assert.match(text, /刑法分论 · 第10-12节（已转写，等写笔记）/)
  assert.match(text, /上传课件：https:\/\/course\.law-tech\.dev\/admin/)

  const html = renderPptReminderHtml(missing, { adminUrl, date: '2026-09-28' })
  assert.match(html, /<th style="[^"]*">课程<\/th>/)
  assert.match(html, /刑法分论/)
  assert.match(html, /已转写，等写笔记/)
  assert.match(html, /https:\/\/course\.law-tech\.dev\/admin/)
})

test('一节都不缺就不发邮件，只留一行说明', async () => {
  const { deps, emails, lines, errors } = harness({
    tasks: [{ replayKey: 'r1', courseName: '刑法分论', title: '第10-12节', stage: 'transcript_ready' }],
    decks: [{ course: '刑法分论', lesson: '第10-12节' }]
  })
  const code = await runCli(['ppt-reminder'], deps)
  const summary = parse(lines.at(-1))

  assert.equal(code, 0)
  assert.equal(summary.sent, false)
  assert.equal(summary.skipped, true)
  assert.equal(summary.checked, 1)
  assert.equal(emails.length, 0, '没缺的就不该发邮件')
  assert.match(errors.join('\n'), /没有缺课件的课次，按约定不发邮件/)
})

test('全课程通用课件算"有课件"：同一门课都不提醒，别的课照常提醒', async () => {
  // 判据必须是 materials 包的 listMaterials：它把"全课程通用"（course/ 目录）也算进来，
  // 天真的目录判断会把这些课次误报成缺课件，那就变成每天一封错的提醒。
  const { deps, emails, lines } = harness({
    tasks: [
      { replayKey: 'r1', courseName: '刑法分论', title: '第10-12节', stage: 'downloaded' },
      { replayKey: 'r2', courseName: '刑法分论', title: '第7-9节', stage: 'downloaded' },
      { replayKey: 'r3', courseName: '商法概论', title: '第1-2节', stage: 'downloaded' }
    ],
    decks: [{ course: '刑法分论', scope: 'course' }]
  })
  await runCli(['ppt-reminder'], deps)
  const summary = parse(lines.at(-1))

  assert.equal(summary.sent, true)
  assert.deepEqual(summary.missing.map(item => item.courseName + item.lessonTitle), ['商法概论第1-2节'])
  assert.equal(emails.length, 1)
})

test('有缺的就发一封：收件人取配置，正文带清单与管理台链接', async () => {
  const { deps, emails, lines } = harness({
    tasks: [
      { replayKey: 'r1', courseName: '刑法分论', title: '第10-12节', stage: 'transcript_ready' },
      { replayKey: 'r2', courseName: '商法概论', title: '第1-2节', stage: 'published' }
    ],
    decks: [{ course: '刑法分论', lesson: '第3-4节' }]   // 与 r1 的课次不同：不算数
  })
  const code = await runCli(['ppt-reminder'], deps)
  const summary = parse(lines.at(-1))

  assert.equal(code, 0)
  assert.equal(summary.sent, true)
  assert.equal(summary.id, 'fake-email-1')
  assert.equal(summary.lessons, 1)
  assert.equal(emails.length, 1)
  assert.deepEqual(emails[0].to, 'owner@example.com')
  assert.equal(emails[0].from, 'course@law-tech.dev')
  assert.equal(emails[0].apiKey, 'sk-fake-resend-key')
  assert.equal(emails[0].subject, '缺课件提醒 · 2026-09-28 · 1 节待上传')
  assert.match(emails[0].text, /刑法分论 · 第10-12节/)
  assert.match(emails[0].text, /https:\/\/course\.law-tech\.dev\/admin/)
  assert.match(emails[0].html, /刑法分论/)
  assert.doesNotMatch(emails[0].text, /已发布/, '跑完的课次不进清单')
})

test('--to 覆盖收件人，--dry-run 只打印不发', async () => {
  const { deps, emails, lines } = harness({
    tasks: [{ replayKey: 'r1', courseName: '刑法分论', title: '第10-12节', stage: 'downloaded' }]
  })
  await runCli(['ppt-reminder', '--to', 'someone@example.com'], deps)
  assert.deepEqual(emails[0].to, 'someone@example.com')

  const dry = harness({ tasks: [{ replayKey: 'r1', courseName: '刑法分论', title: '第10-12节', stage: 'downloaded' }] })
  const code = await runCli(['ppt-reminder', '--dry-run'], dry.deps)
  const summary = parse(dry.lines.at(-1))
  assert.equal(code, 0)
  assert.equal(summary.dryRun, true)
  assert.equal(summary.sent, undefined)
  assert.equal(summary.missing.length, 1)
  assert.match(summary.html, /刑法分论/)
  assert.equal(dry.emails.length, 0, '--dry-run 不得真发')
})
