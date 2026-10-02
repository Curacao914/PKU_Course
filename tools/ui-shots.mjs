#!/usr/bin/env node
/** 截图：起一个带假数据的站点，把管理台每个区截一张图，用于人眼检查版面。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { openLedger } from '@course/store'
import { startSiteServer } from '../apps/site/src/server.mjs'

const TOKEN = 'shot-token'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-shot-'))
const scratchRoot = path.join(dir, 'scratch')
const siteRoot = path.join(scratchRoot, 'site')
fs.mkdirSync(siteRoot, { recursive: true })
fs.writeFileSync(path.join(siteRoot, 'index.html'), '<!doctype html><title>x</title>')
fs.writeFileSync(path.join(siteRoot, 'notes.json'), JSON.stringify({ siteName: '课程笔记', generatedAt: '2026-09-26T00:00:00.000Z', count: 3, notes: [] }))

const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
store.discoverReplays([
  { replay_key: 'replay-a', course_key: 'c1', course_name: '刑事执行法', title: '2026-09-21第5-6节' },
  { replay_key: 'replay-b', course_key: 'c1', course_name: '刑事执行法', title: '2026-09-14第5-6节' },
  { replay_key: 'replay-c', course_key: 'c1', course_name: '刑事执行法', title: '2026-09-07第5-6节' },
  { replay_key: 'replay-d', course_key: 'c2', course_name: '商法概论', title: '2026-09-20第2-4节' },
  { replay_key: 'replay-e', course_key: 'c3', course_name: '普通法专题', title: '2026-09-24第7-9节' },
  { replay_key: 'replay-f', course_key: 'c4', course_name: '犯罪学', title: '2026-09-23第7-9节' }
])
const outA = path.join(scratchRoot, 'replays', 'replay-a', 'transcript')
fs.mkdirSync(outA, { recursive: true })
const transcript = path.join(outA, 'raw-transcript.md')
fs.writeFileSync(transcript, '正文')
const trace = (p, c, cached = 0) => ({ trace: { usage: { prompt_tokens: p, completion_tokens: c, prompt_tokens_details: { cached_tokens: cached } } } })
fs.writeFileSync(path.join(outA, 'lesson-state.json'), JSON.stringify({
  savedAt: '2026-09-25T16:39:00.000Z',
  lesson: {
    status: 'notes_ready', finalNote: { markdown: 'x'.repeat(18174), assembly: trace(6000, 14000) },
    outlineTraces: [{ usage: { prompt_tokens: 36000, completion_tokens: 8000 } }],
    nodes: [
      { id: 'node-1', outlineNodeId: 'node-1', title: '刑罚结构的严与厉', status: 'approved', draft: 'x'.repeat(3200), versions: [trace(36000, 24000, 1000)], reviewerReports: [trace(42000, 15000)] },
      { id: 'node-2', outlineNodeId: 'node-2', title: '罪刑均衡与以刑制罪', status: 'approved', draft: 'x'.repeat(2800), versions: [trace(38000, 22000)], reviewerReports: [trace(41000, 12000)] }
    ]
  }
}))
const claimA = store.claimTask({ replayKey: 'replay-a', workerId: 'shot' })
store.reportStage({ id: claimA.task.id, stage: 'published', message: '已发布', data: { artifacts: { transcriptPath: transcript, slug: 'notes/刑事执行法/2026-09-21第5-6节' }, runtime: { videoDurationSeconds: 7186, estimatedCostCny: 0.485 } } })
const claimB = store.claimTask({ replayKey: 'replay-b', workerId: 'shot' })
store.reportStage({ id: claimB.task.id, stage: 'needs_attention', message: '停下', error: '模型连续返回空结果，已停止重试', data: { runtime: { videoDurationSeconds: 7149, estimatedCostCny: 0.475 } } })
const claimD = store.claimTask({ replayKey: 'replay-d', workerId: 'shot' })
store.reportStage({ id: claimD.task.id, stage: 'transcript_ready', message: '转录完成', data: { artifacts: { transcriptPath: transcript }, runtime: { videoDurationSeconds: 11352, estimatedCostCny: 0.703 } } })
store.enqueueDelivery({ dedupeKey: 'course-note:x', purpose: 'course-note', bodyText: '正文', objectUrl: '/n.html', scheduledFor: '2026-01-01T00:00:00.000Z' })
const claimedDelivery = store.claimDelivery({ workerId: 'shot' })
store.ackDelivery({ id: claimedDelivery.id, status: 'failed', error: '会话过期' })
store.close()

const site = await startSiteServer({
  root: siteRoot, port: 0, adminToken: TOKEN, scratchRoot,
  materialsRoot: path.join(scratchRoot, 'materials'), workerPath: path.join(process.cwd(), 'apps/worker/bin/course.mjs'),
  runCommand: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, audit: true }), stderr: '' })
})
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const shots = path.join(process.cwd(), 'docs/shots')
fs.mkdirSync(shots, { recursive: true })
for (const [name, width, height] of [['desktop', 1180, 900], ['mobile', 420, 900]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  await page.addInitScript(token => { try { localStorage.setItem('course.admin.token', token) } catch (e) {} }, TOKEN)
  await page.route('**/api/admin/balance', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, threshold: 5, balances: [{ provider: 'deepseek', total: 6.7, rechargeUrl: 'https://platform.deepseek.com/top_up' }, { provider: 'aliyun', total: 11.62, rechargeUrl: 'https://bailian.console.aliyun.com/' }] }) }))
  await page.goto(site.url + '/admin', { waitUntil: 'domcontentloaded' })
const tabs = ['overview', 'courses', 'content', 'settings']
for (const tab of tabs) {
  await page.click('.seg button[data-tab="' + tab + '"]')
  // 课程区是分栏：要选中课程与课次，详情面板才有东西可看
  if (tab === 'courses') {
    await page.click('#courses .item[data-act="pick-course"]')
    await page.click('#lessons .item[data-act="pick-lesson"]:not([data-value="__multi__"])')
  }
  if (tab === 'settings') await page.$$eval('#tab-settings details', nodes => nodes.forEach(node => { node.open = true }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(shots, name + '-' + tab + '.png'), fullPage: false })
}
}
await browser.close()
site.server.closeAllConnections?.()
await site.close()
console.log('截图目录:', shots, fs.readdirSync(shots).join(' '))
process.exit(0)
