#!/usr/bin/env node
/**
 * 点击审计：用真浏览器把管理台每个按钮、笔记页与搜索页的交互都点一遍。
 *
 *   node tools/ui-click-audit.mjs
 *
 * 为什么要有这个东西：管理台上的按钮出问题**不会有任何报错**。属性名写错、
 * 分支漏写、处理函数抛异常在异步里被吞掉——页面都毫无反应，看起来就是"按钮坏了"，
 * 而单元测试全绿。静态比对（apps/site/src/admin.test.mjs 里那几条）能挡住
 * "页面上的 data-act 与处理分支对不上"，但挡不住"点击之后其实没发出请求"、
 * "请求发出去了但界面没有任何提示"这类问题。
 *
 * 因此这里用真 Chrome 打开页面：
 *   1. 每个 tab 都切过去，把该区里每个 [data-act] 按钮点一次；
 *   2. 每点一次都要求**立刻出现可见反馈**（右下角提示条），且不能是失败提示；
 *   3. 触发运行的动作，核对服务端真的收到了对应的 CLI argv（用注入的假 runCommand 抓）；
 *   4. 最后打印一张表：按钮 → 提示 → 实际 argv。
 *
 * 不会真的跑流水线：runCommand 被替换成记录 argv 的假实现，所以循环点也不会下载、
 * 不会调用模型、不会删文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

import { buildNoteRecord, renderNotePage, renderSearchPage } from '@course/publish'
import { openLedger } from '@course/store'
import { startSiteServer } from '../apps/site/src/server.mjs'

const TOKEN = 'audit-token'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 找一个能用的 Chrome/Chromium：本机 Chrome、Playwright 缓存、或环境变量指定。 */
function findChrome() {
  const candidates = [
    process.env.COURSE_AUDIT_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) {
      const guess = path.join(cache, entry, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')
      if (fs.existsSync(guess)) return guess
    }
  }
  throw new Error('找不到 Chrome/Chromium，可用 COURSE_AUDIT_CHROME=<路径> 指定')
}

/** 造一篇够长的笔记：四个层级的小节、表格、列表，页面要能滚过一整屏。 */
function buildFixtureMarkdown() {
  const lines = ['## 一、执行程序总论', '执行程序是刑事执行的入口。本节先交代执行依据与执行机关的分工。']
  for (let index = 1; index <= 8; index += 1) {
    lines.push('### ' + index + '. 执行依据与机关分工（第 ' + index + ' 组）')
    lines.push('生效判决与裁定是执行的唯一依据，这一点没有例外。执行机关的分工决定救济路径，理解它的前提是分清裁判确定力与执行力这两件事。第 ' + index + ' 组的争点集中在' + '送达与期限的计算方式上。')
    lines.push('实践中常见的问题是把执行依据与执行根据混为一谈。前者是裁判文书本身，后者是执行机关据以行动的法律状态。二者错位时，救济顺序会整体后移。')
    lines.push('#### 细节：送达与期限（第 ' + index + ' 组）')
    lines.push('送达回证要附卷，送达日期决定上诉期与申请执行期间的起算。当事人拒收时留置送达的成立要件与见证要求，是这一节的考点。')
    lines.push('| 措施 | 依据 | 期限 |')
    lines.push('| --- | --- | --- |')
    lines.push('| 收监 | 刑事诉讼法第 264 条 | 十日以内 |')
    lines.push('| 减刑 | 刑法第 78 条 | 按次报请 |')
    lines.push('- 关键概念：执行依据、执行力、送达生效')
    lines.push('- 常见错误：把期限起算点算在裁判作出之日')
  }
  lines.push('## 二、执行措施与救济')
  lines.push('执行措施的关键在于期限与审批层级。救济路径分异议、复议与申诉三层，顺序不能颠倒。')
  return lines.join('\n')
}

/** 造一份"什么都有"的账本：能出模块列表、失败通知、卡住的课次。 */
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-click-audit-'))
  const scratchRoot = path.join(dir, 'scratch')
  const siteRoot = path.join(scratchRoot, 'site')
  const outputDir = path.join(scratchRoot, 'replays', 'replay-audit-1', 'output')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(siteRoot, { recursive: true })

  const transcriptPath = path.join(outputDir, 'transcript.txt')
  fs.writeFileSync(transcriptPath, '第一讲 执行程序\n第二讲 执行措施\n')

  // 笔记模块状态：管理台「笔记」区据此渲染逐模块重写按钮
  fs.writeFileSync(path.join(outputDir, 'lesson-state.json'), JSON.stringify({
    savedAt: '2026-09-25T10:00:00.000Z',
    lesson: {
      status: 'notes_ready',
      finalNote: { markdown: '# 刑事执行法\n正文' },
      nodes: [
        { id: 'node-1', outlineNodeId: 'node-1', title: '执行程序总论', status: 'approved', draft: '正文一', revisionCount: 0 },
        { id: 'node-2', outlineNodeId: 'node-2', title: '执行措施', status: 'approved', draft: '正文二', revisionCount: 1 }
      ]
    }
  }, null, 2))

  const store = openLedger(path.join(scratchRoot, 'ledger.sqlite'))
  store.discoverReplays([
    { replay_key: 'replay-audit-1', course_key: 'course-1', course_name: '刑事执行法', title: '第5-6节' },
    { replay_key: 'replay-audit-2', course_key: 'course-1', course_name: '刑事执行法', title: '第7-8节' }
  ])
  const first = store.claimTask({ replayKey: 'replay-audit-1', workerId: 'audit' })
  store.reportStage({ id: first.task.id, stage: 'transcript_ready', message: '转录完成', data: { artifacts: { transcriptPath, slug: 'xingfa-zhixing-5-6' } } })
  const second = store.claimTask({ replayKey: 'replay-audit-2', workerId: 'audit' })
  store.reportStage({ id: second.task.id, stage: 'needs_attention', message: '连续失败', error: '模型连续返回空结果' })

  // 一条发送失败的通知：管理台要能把它放回队列
  store.enqueueDelivery({ dedupeKey: 'course-note:replay-audit-1', purpose: 'course-note', bodyText: '本节讲执行程序', objectUrl: '/n.html', scheduledFor: '2026-01-01T00:00:00.000Z' })
  const claimed = store.claimDelivery({ workerId: 'audit' })
  store.ackDelivery({ id: claimed.id, status: 'failed', error: '通道超时' })
  store.close()

  // 一份真笔记：阅读页的交互（字号/深色/进度/回到顶部/锚点复制/位置记忆）都得有东西可点
  const record = buildNoteRecord({
    courseName: '刑事执行法',
    teacher: '张三',
    lessonTitle: '第5-6节 · 执行程序与执行措施',
    publishedAt: '2026-09-25T10:00:00.000Z',
    // 要够长：进度条、回到顶部、位置记忆都按滚动位置工作，短页面根本触发不到
    markdown: buildFixtureMarkdown()
  })
  // slug 形如 notes/刑事执行法/第5-6节，要落成真实的多层目录
  const noteFile = path.join(siteRoot, record.slug + '.html')
  fs.mkdirSync(path.dirname(noteFile), { recursive: true })
  fs.writeFileSync(noteFile, renderNotePage(record, { siteOrigin: '' }))
  fs.writeFileSync(path.join(siteRoot, 'search.html'), renderSearchPage({ siteOrigin: '' }))
  fs.writeFileSync(path.join(siteRoot, 'index.html'), '<!doctype html><title>站点</title>')
  fs.writeFileSync(path.join(siteRoot, 'notes.json'), JSON.stringify({
    siteName: '课程笔记',
    generatedAt: '2026-09-25T00:00:00.000Z',
    count: 1,
    notes: [{
      slug: record.slug, lessonTitle: record.lessonTitle, courseName: record.courseName,
      summary: record.summary, readMinutes: record.readMinutes, headings: record.headings,
      publishedAt: record.publishedAt, metadata: record.metadata
    }]
  }))

  return { dir, scratchRoot, siteRoot, outputDir, transcriptPath, noteUrl: '/' + record.slug + '.html' }
}

/** 每个按钮点下去应当看到的提示（子串匹配）；没写在这里的按"不能出现失败字样"判定。 */
const EXPECTED = {
  save: '已登录',
  refresh: '已刷新',
  'refresh-balance': '正在查余额',
  upload: '已归档',
  retry: '完成',
  republish: '完成',
  cycle: '完成',
  'cycle-all': '完成',
  revise: '完成',
  'revise-first': '完成',
  'notify-retry': '完成',
  discover: '完成',
  notify: '完成',
  doctor: '完成',
  backup: '完成',
  prune: '完成',
  'prune-apply': '完成',
  'save-config': '设置已保存',
  'save-password': '密码已更新',
  'clear-password': '已清除密码'
}

/** 管理台：把每个按钮点一遍，要求「立刻有反馈」且发出的命令正确。 */
async function auditAdmin(page, site, calls, dialogs, failures) {
  const results = []
  await page.goto(site.url + '/admin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#tab-overview .card', { timeout: 10000 })
  if (await page.locator('text=需要登录').count()) throw new Error('管理台没登录上（fixture 或令牌有问题）')

  for (const tab of ['overview', 'courses', 'notes', 'settings']) {
    await page.click('.tabs button[data-tab="' + tab + '"]')
    const acts = await page.$$eval('#tab-' + tab + ' [data-act]', nodes => [...new Set(nodes.map(node => node.dataset.act))])
    for (const act of acts) {
      const selector = '#tab-' + tab + ' [data-act="' + act + '"]'
      // 点之前把该填的填好，否则测到的是「参数没填」那条分支
      if (act === 'upload') {
        await page.setInputFiles('#tab-' + tab + ' input[type=file]', {
          name: '第5-6节课件.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '执行程序' }] }))
        })
      }
      if (act === 'revise' || act === 'revise-first') {
        await page.fill('#tab-' + tab + ' [data-request]', '把这一节压缩到 1200 字并拆成列表')
      }
      if (act === 'save-password') await page.fill('[data-pw="next"]', 'audit-password-2026')

      const before = calls.length
      await page.click(selector, { timeout: 5000 })

      // 第一关：点下去必须立刻出现可见提示——这就是「按钮有没有反应」的判据
      let immediate = { text: '', kind: '' }
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('toast')
          return el && el.className.includes('show') && el.textContent.trim().length > 0
        }, { timeout: 8000 })
        immediate = await page.$eval('#toast', el => ({ text: el.textContent.trim(), kind: el.className }))
      } catch (error) {
        immediate = { text: '（没有任何提示）', kind: 'missing' }
      }

      // 第二关：等这次操作真的结束，再读最终提示（否则读到的永远是「已开始」）
      await page.waitForFunction(() => window.state && window.state.busy === false, { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(250)
      const settled = await page.$eval('#toast', el => ({ text: el.textContent.trim(), kind: el.className })).catch(() => immediate)
      const toast = settled.text && settled.text !== immediate.text ? settled : immediate

      const argv = calls.length > before ? calls[calls.length - 1] : null
      results.push({ tab, act, toast: toast.text, argv })

      const expected = EXPECTED[act]
      if (toast.kind.includes('missing')) failures.push('管理台 ' + tab + ' · ' + act + '：点了之后没有任何可见反馈')
      else if (expected && !toast.text.includes(expected)) failures.push('管理台 ' + tab + ' · ' + act + '：提示是「' + toast.text + '」，预期包含「' + expected + '」')
      else if (!expected && /失败|还没接上|没成功/.test(toast.text)) failures.push('管理台 ' + tab + ' · ' + act + '：' + toast.text)
    }
  }

  console.log('管理台按钮（' + results.length + ' 个）')
  for (const row of results) console.log('  [' + row.tab + '] ' + row.act.padEnd(16) + row.toast + (row.argv ? '  →  course ' + row.argv.join(' ') : ''))
  if (dialogs.length) console.log('  确认弹窗 ' + dialogs.length + ' 次：' + dialogs.join(' / '))

  // 关键点：整轮跑要一次处理 5 节（与定时任务一致），单节重跑只推 1 节
  if (!calls.some(argv => argv[0] === 'cycle' && argv[2] === '5')) failures.push('「跑一轮完整链路」没有按 --max-tasks 5 发出去（与定时任务不一致）')
  if (!calls.some(argv => argv[0] === 'cycle' && argv[2] === '1')) failures.push('课次行里的「跑一轮」没有按 --max-tasks 1 发出去')
  if (!calls.some(argv => argv[0] === 'notes' && argv.includes('--revise'))) failures.push('「只重写这个模块」没有走到 notes --revise')
  if (!calls.some(argv => argv[0] === 'prune' && argv.includes('--apply'))) failures.push('「清理并删除」没有带 --apply')
  return results
}

/** 笔记阅读页：字号 / 深色 / 进度条 / 回到顶部 / 锚点复制 / 位置记忆 / 目录。 */
async function auditNotePage(page, site, noteUrl, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('笔记页 ' + name + '：' + detail)
  }
  console.log('笔记阅读页')
  const scale = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--font-scale'))

  await page.goto(site.url + noteUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('article h2', { timeout: 8000 })

  // 字号：点两下要看得见变大，并且记住
  const before = parseFloat(await scale() || '1')
  await page.click('[data-read="font-up"]')
  const bigger = parseFloat(await scale() || '1')
  await page.click('[data-read="font-down"]')
  const back = parseFloat(await scale() || '1')
  const savedFont = await page.evaluate(() => localStorage.getItem('course.fontScale'))
  await record('A+ 放大字号', bigger > before, '点之前 ' + before + '，点之后 ' + bigger)
  await record('A− 缩小字号', back <= bigger, '点之后 ' + back)
  await record('字号写进本地存储', savedFont != null, 'localStorage.course.fontScale=' + savedFont)

  // 深色：切换后 html[data-theme] 要变，按钮文字也要跟着变
  const themeBefore = await page.getAttribute('html', 'data-theme')
  await page.click('[data-read="theme"]')
  const themeAfter = await page.getAttribute('html', 'data-theme')
  const label = await page.textContent('#themeToggle')
  await record('深色切换', themeBefore !== themeAfter && themeAfter === 'dark', themeBefore + ' → ' + themeAfter)
  await record('深色按钮改字', /浅色/.test(label || ''), '按钮显示「' + label + '」')

  // 进度条与回到顶部
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(400)
  const width = await page.$eval('#progress', el => el.style.width)
  const shown = await page.$eval('#totop', el => el.className.includes('show'))
  await record('进度条走到底', width === '100%', '宽度 ' + width)
  await record('回到顶部浮现', shown, 'class=' + await page.$eval('#totop', el => el.className))
  await page.click('#totop')
  // 平滑滚动是动画，等位置稳定下来再判断
  await page.waitForFunction(() => window.scrollY === 0, { timeout: 4000 }).catch(() => {})
  const scrollY = await page.evaluate(() => window.scrollY)
  await record('回到顶部可用', scrollY < 60, '滚动位置 ' + scrollY)

  // 锚点复制
  const anchor = await page.$('article h2 a.anchor')
  if (!anchor) await record('小节锚点', false, '标题上没有生成可复制的锚点')
  else {
    await anchor.click()
    await page.waitForTimeout(150)
    const text = await page.$eval('article h2 a.anchor', el => el.textContent)
    const hash = await page.evaluate(() => location.hash)
    await record('锚点复制', text === '已复制' && hash.length > 1, '文字「' + text + '」，地址 ' + hash)
    await page.waitForTimeout(1300)
    await record('锚点文字复位', (await page.$eval('article h2 a.anchor', el => el.textContent)) === '#', '一秒多之后应回到 #')
  }

  // 位置记忆：先读一段，刷新后应出现「继续上次阅读」
  await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight) })
  await page.waitForTimeout(2000)
  const savedPos = await page.evaluate(() => localStorage.getItem('course.readPos:' + location.pathname))
  await record('记住读到哪一节', Boolean(savedPos), 'localStorage=' + savedPos)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const resumeVisible = await page.$eval('#resume', el => !el.hidden).catch(() => false)
  await record('出现继续阅读入口', resumeVisible, resumeVisible ? '按钮可见' : '按钮仍然隐藏')
  if (resumeVisible) {
    await page.click('#resume')
    await page.waitForTimeout(900)
    await record('点它真的滚过去', (await page.evaluate(() => window.scrollY)) > 100, '滚动位置 ' + await page.evaluate(() => window.scrollY))
  }

  // 目录：点一条要跳到对应小节，且当前小节会被高亮
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  // 宽屏下可点的是 .rail-desktop 那一份（窄屏那份在折叠面板里）
  await page.click('.rail-desktop nav.toc a')
  await page.waitForTimeout(1200)
  const active = await page.$('.rail-desktop nav.toc a.active')
  const hash = await page.evaluate(() => location.hash)
  await record('目录可跳转', hash.length > 1, '地址 ' + decodeURIComponent(hash))
  await record('目录高亮当前小节', Boolean(active), active ? '高亮：' + (await active.textContent()) : '没有任何一条被高亮')

  return results
}

/** 搜索页：/ 聚焦、输入即搜、Esc 清空。 */
async function auditSearch(page, site, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('搜索页 ' + name + '：' + detail)
  }
  console.log('搜索页')
  await page.goto(site.url + '/search.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)

  await page.click('body')
  await page.keyboard.press('/')
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id)
  await record('按 / 聚焦搜索框', focused === 'q', '当前焦点 id=' + focused)

  await page.fill('#q', '执行措施')
  await page.waitForTimeout(300)
  const hits = (await page.$$('#results a.card')).length
  const hint = await page.textContent('#hint')
  await record('输入即出结果', hits >= 1, '命中 ' + hits + ' 篇，提示「' + hint + '」')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const cleared = await page.inputValue('#q')
  await record('Esc 清空', cleared === '', '输入框剩「' + cleared + '」')

  return results
}

async function main() {
  const fixture = buildFixture()
  const calls = []
  const site = await startSiteServer({
    root: fixture.siteRoot,
    port: 0,
    adminToken: TOKEN,
    scratchRoot: fixture.scratchRoot,
    materialsRoot: path.join(fixture.scratchRoot, 'materials'),
    workerPath: path.join(repoRoot, 'apps/worker/bin/course.mjs'),
    // 关键：真的流水线不跑，只把 argv 记下来
    runCommand: async (args) => {
      calls.push(args.slice(1))
      return { code: 0, stdout: JSON.stringify({ ok: true, audit: true }), stderr: '' }
    }
  })

  const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const failures = []
  const dialogs = []
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept() })
  page.on('pageerror', error => { failures.push('页面脚本异常：' + error.message) })
  page.on('console', message => { if (message.type() === 'error') failures.push('控制台报错：' + message.text()) })
  // 余额是外部网络调用，审计里换成固定值
  await page.route('**/api/admin/balance', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, threshold: 5, balances: [
      { provider: 'deepseek', total: 19.42 }, { provider: 'aliyun', total: 18.56 }
    ] })
  }))
  await page.addInitScript(token => { try { localStorage.setItem('course.admin.token', token) } catch (e) {} }, TOKEN)

  try {
    await auditAdmin(page, site, calls, dialogs, failures)
    console.log('')
    await auditNotePage(page, site, fixture.noteUrl, failures)
    console.log('')
    await auditSearch(page, site, failures)
  } finally {
    await browser.close()
    // 浏览器关掉后可能还有 keep-alive 连接挂在服务器上，close() 会一直等它们；
    // 审计进程不该为了善后卡住，直接断开剩下的连接
    site.server.closeAllConnections?.()
    await site.close()
  }

  console.log('')
  if (failures.length) {
    console.error('✖ 审计未通过（' + failures.length + ' 项）：')
    for (const failure of failures) console.error('  - ' + failure)
    process.exit(1)
  }
  console.log('✔ 管理台每个按钮点下去都有可见反馈且命令正确；笔记页与搜索页的交互全部可用')
  // 显式退出：审计跑完就该结束，不留着事件循环等超时
  process.exit(0)
}

await main()

