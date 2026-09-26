
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { openLedger } from '@course/store'
import { startSiteServer } from '../apps/site/src/server.mjs'
const TOKEN = 'shot-token'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-text-'))
const scratchRoot = path.join(dir, 'scratch'); const siteRoot = path.join(scratchRoot, 'site')
fs.mkdirSync(siteRoot, { recursive: true })
fs.writeFileSync(path.join(siteRoot, 'index.html'), 'x')
fs.writeFileSync(path.join(siteRoot, 'notes.json'), JSON.stringify({ siteName: 'x', count: 0, notes: [] }))
const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
store.discoverReplays([
  { replay_key: 'replay-a', course_key: 'c1', course_name: '刑事执行法', title: '2026-09-21第5-6节' },
  { replay_key: 'replay-b', course_key: 'c1', course_name: '刑事执行法', title: '2026-09-14第5-6节' }
])
const claim = store.claimTask({ replayKey: 'replay-a', workerId: 'x' })
store.reportStage({ id: claim.task.id, stage: 'transcript_ready', message: 'ok', data: { runtime: { videoDurationSeconds: 7186, estimatedCostCny: 0.485 } } })
store.close()
const site = await startSiteServer({ root: siteRoot, port: 0, adminToken: TOKEN, scratchRoot, materialsRoot: path.join(scratchRoot, 'materials'), workerPath: path.join(process.cwd(), 'apps/worker/bin/course.mjs'), runCommand: async () => ({ code: 0, stdout: '{}', stderr: '' }) })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } })
await page.addInitScript(t => { try { localStorage.setItem('course.admin.token', t) } catch (e) {} }, TOKEN)
await page.route('**/api/admin/balance', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, threshold: 5, balances: [{ provider: 'deepseek', total: 5.18 }, { provider: 'aliyun', total: 11.62 }] }) }))
await page.goto(site.url + '/admin', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#tab-overview .card')
for (const tab of ['overview', 'courses', 'notes', 'settings']) {
  await page.click('.seg button[data-tab="' + tab + '"]')
  await page.$$eval('main details', ns => ns.forEach(n => { n.open = true }))
  await page.waitForTimeout(200)
  const text = await page.$eval('#tab-' + tab, el => el.innerText.replace(/\n{2,}/g, '\n').trim())
  console.log('===== ' + tab + ' =====')
  console.log(text)
  console.log()
}
await browser.close(); site.server.closeAllConnections?.(); await site.close(); process.exit(0)
