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

import { buildNoteRecord, renderIndexPage, renderNotePage, renderSearchPage, renderTermIndexPage } from '@course/publish'
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

  // 首页 / 索引页：横向课次条、课程过滤、条目落到正文位置，都要真的点一遍
  const execSecond = buildNoteRecord({
    courseName: '刑事执行法',
    lessonTitle: '第7-8节 减刑与假释',
    publishedAt: '2026-09-23T10:00:00.000Z',
    markdown: ['# 第7-8节 减刑与假释', '', '## 一、减刑的条件', '', '减刑要经过报请与裁定两个环节。'].join('\n')
  })
  const companyRecord = buildNoteRecord({
    courseName: '商法概论',
    teacher: '李四',
    lessonTitle: '第1-2节 公司法总论',
    publishedAt: '2026-09-26T10:00:00.000Z',
    markdown: [
      '# 第1-2节 公司法总论',
      '',
      '## 一、公司的设立',
      '',
      '设立中的公司不具有权利能力。',
      '',
      '## 二、法人人格否认',
      '',
      '法人人格否认针对的是股东滥用有限责任的情形。',
      '',
      '## 三、法条依据',
      '',
      '《公司法》第二十条是这一节的支点。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 法人人格否认',
      'META: PROVISION: 公司法第20条',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  const empiricalRecord = buildNoteRecord({
    courseName: '法律实证分析',
    lessonTitle: '第3节 抽样与变量',
    publishedAt: '2026-09-24T10:00:00.000Z',
    markdown: [
      '# 第3节 抽样与变量',
      '',
      '## 一、抽样',
      '',
      '法人人格否认在实证研究里对应变量构造。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 法人人格否认',
      'META: CONCEPT: 抽样框',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  const courseRecords = [record, execSecond, companyRecord, empiricalRecord]
  for (const item of courseRecords) {
    const pageFile = path.join(siteRoot, item.slug + '.html')
    fs.mkdirSync(path.dirname(pageFile), { recursive: true })
    fs.writeFileSync(pageFile, renderNotePage(item, { siteOrigin: '' }))
  }
  fs.writeFileSync(path.join(siteRoot, 'index.html'), renderIndexPage(courseRecords))
  fs.mkdirSync(path.join(siteRoot, 'concepts'), { recursive: true })
  fs.mkdirSync(path.join(siteRoot, 'statutes'), { recursive: true })
  fs.writeFileSync(path.join(siteRoot, 'concepts/index.html'),
    renderTermIndexPage({ title: '概念索引', kind: 'concepts', notes: [companyRecord, empiricalRecord] }))

  // 一份"图片版课件"：抽不出文字、还有 2 张图没识别——详情面板据此出现「识别图片文字」按钮
  const materialsRoot = path.join(scratchRoot, 'materials')
  const materialHome = path.join(materialsRoot, '刑事执行法', '第5-6节')
  fs.mkdirSync(path.join(materialHome, 'slides'), { recursive: true })
  fs.writeFileSync(path.join(materialHome, '图片版课件.pptx'), 'fake-pptx')
  fs.writeFileSync(path.join(materialHome, 'slides', '图片版课件.pptx.json'), JSON.stringify({
    slideCount: 2,
    slides: [{ slideNumber: 1, text: '第一页' }, { slideNumber: 2, text: '第二页：整页是图' }],
    images: [{ path: 'ppt/media/image1.png', bytes: 194436, width: 2360, height: 1800, slides: [2], needsOcr: true }],
    ocr: { pending: 2, attempted: 0, engine: '', errors: [] }
  }, null, 2))
  fs.writeFileSync(path.join(materialHome, 'meta.json'), JSON.stringify({
    materials: [{
      name: '图片版课件.pptx',
      scope: 'lesson',
      course: '刑事执行法',
      courseKey: '',
      lesson: '第5-6节',
      replayKey: 'replay-audit-1',
      appliesTo: [],
      bytes: 8,
      checksum: 'audit',
      slideCount: 2,
      imageCount: 1,
      ocrPending: 2,
      ocr: { pending: 2, attempted: 0, engine: '', errors: [] },
      parsedPath: path.join(materialHome, 'slides', '图片版课件.pptx.json'),
      addedAt: '2026-09-25T10:00:00.000Z'
    }]
  }, null, 2))
  fs.writeFileSync(path.join(siteRoot, 'statutes/index.html'),
    renderTermIndexPage({ title: '法条索引', kind: 'statutes', notes: [companyRecord] }))

  return { dir, scratchRoot, siteRoot, outputDir, transcriptPath, noteUrl: '/' + record.slug + '.html' }
}

/** 每个按钮点下去应当看到的提示（子串匹配）；没写在这里的按"不能出现失败字样"判定。 */
const EXPECTED = {
  save: '已登录',
  refresh: '已刷新',
  'refresh-balance': '正在查余额',
  pick: '已归档',
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
  'clear-password': '已清除密码',  // 「已清除密码；当前浏览器用的是主令牌，仍然有效」也匹配
  // 整合材料生成还没实现：按钮点了要如实说自己没做，这不算缺陷（下一步实现）
  'pick-file': '已归档',
  'ocr-material': '完成',
  integrate: '还没做',
  'add-tag': '先写标签名'   // 审计不填标签输入框：这条分支本来就要说"先写标签名"
}

/** 管理台：把每个按钮点一遍，要求「立刻有反馈」且发出的命令正确。 */
async function auditAdmin(page, site, calls, dialogs, failures) {
  const results = []
  await page.goto(site.url + '/admin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#tab-overview .card', { timeout: 10000 })
  if (await page.locator('text=需要登录').count()) throw new Error('管理台没登录上（fixture 或令牌有问题）')

  // 界面默认折叠（课程、课次、运行参数、输出）——审计要先把折叠层打开，
  // 否则测不到里面那些按钮，而"藏在折叠里的按钮点不动"恰恰是最容易漏的
  // 顶栏那个 ··· 是浮层，不展开（它会盖住内容，点了会挡住下面的按钮）
  const openAll = () => page.$$eval('main details, .card details', nodes => nodes.forEach(node => { node.open = true }))
  await openAll()

  const tabNames = ['overview', 'courses', 'settings']
  for (const tab of tabNames) {
    await openAll()
    await page.click('.seg button[data-tab="' + tab + '"]')
    // 课程区是分栏：详情面板里的按钮要先选中课程与课次才会出现；
    // 筛选栏默认收起，也要先展开——"藏在收起栏里的按钮点不动"正是要测的东西。
    if (tab === 'courses') {
      // 收起筛选栏之后右侧要向左补齐（用户：'不然整体左边是空白的也很难受'）。
      // 这一条同时是给一个真 bug 立的桩：早先用 display:none 收起，栅格少一格，
      // 后面的列各自顶到前一格上，课程列落进 0 宽的那一格——按钮看得见却点不动。
      const measure = () => page.evaluate(() => {
        const board = document.querySelector('.board')
        const courses = document.querySelector('#courses')
        return {
          collapsed: document.querySelector('.board').className.includes('rail-hidden'),
          boardLeft: board.getBoundingClientRect().left,
          coursesLeft: courses.getBoundingClientRect().left,
          coursesWidth: courses.getBoundingClientRect().width
        }
      })
      const before = await measure()
      if (!before.collapsed) await page.click('#tab-courses [data-act="rail-toggle"]')
      const collapsed = await measure()
      if (!collapsed.collapsed) failures.push('管理台 · 筛选栏收不起来')
      else if (Math.abs(collapsed.coursesLeft - collapsed.boardLeft) > 2 || collapsed.coursesWidth < 120) {
        failures.push('管理台 · 收起筛选栏后列没有向左补齐：课程列 left=' + Math.round(collapsed.coursesLeft) +
          '（栅格 left=' + Math.round(collapsed.boardLeft) + '）宽=' + Math.round(collapsed.coursesWidth))
      }
      await page.click('#courses .item[data-act="pick-course"]')
      // 选一节**有转录稿**的课次：详情面板里的"重新发布/只重写这个模块"只在有产物时出现
      await page.click('#lessons .item[data-act="pick-lesson"][data-value="replay-audit-1"]')
      await page.waitForTimeout(150)
    }
    // 切页也是"点了要有反应"的一份：选中态与内容区显隐都要跟着动
    const selected = await page.getAttribute('.seg button[data-tab="' + tab + '"]', 'aria-selected')
    const visible = await page.isVisible('#tab-' + tab)
    const others = await Promise.all(tabNames.filter(name => name !== tab).map(name => page.isVisible('#tab-' + name)))
    if (selected !== 'true' || !visible || others.some(Boolean)) {
      failures.push('管理台 tab · ' + tab + '：切换后选中态或显示状态不对')
    }
    await openAll()
    const acts = await page.$$eval('#tab-' + tab + ' [data-act]', nodes => [...new Set(nodes.map(node => node.dataset.act))])
    for (const act of acts) {
      const selector = '#tab-' + tab + ' [data-act="' + act + '"]'
      // 每次操作后界面会重绘（折叠层又合上），所以每点一个按钮前都先展开
      await openAll()
      // 分栏界面里详情面板的按钮要"先选中课程与课次"才存在：每次点之前重新选一遍，
      // 否则前一个动作重绘之后，后面的按钮就找不到了（不是缺陷，是审计自己的前提）
      if (tab === 'courses' && !(await page.$(selector))) {
        const pickCourse = await page.$('#courses .item[data-act="pick-course"]')
        if (pickCourse) await pickCourse.click()
        const pickLesson = await page.$('#lessons .item[data-act="pick-lesson"][data-value="replay-audit-1"]')
        if (pickLesson) await pickLesson.click()
        await page.waitForTimeout(120)
      }
      // 筛选栏里的按钮在收起状态下是看不见的（那是上面专门断言过的行为）：
      // 要测它们就得先把栏展开
      if (tab === 'courses') {
        const target = await page.$(selector)
        if (!target || !(await target.isVisible())) {
          const toggle = await page.$('#tab-courses [data-act="rail-toggle"]')
          if (toggle) { await toggle.click(); await page.waitForTimeout(120) }
        }
      }
      // 点之前把该填的填好，否则测到的是「参数没填」那条分支
      if (act === 'revise' || act === 'revise-first') {
        await page.fill('#tab-' + tab + ' [data-request]', '把这一节压缩到 1200 字并拆成列表')
      }
      if (act === 'save-password') await page.fill('[data-pw="next"]', 'audit-password-2026')

      await openAll()
      const before = calls.length
      if (act === 'pick-file') {
        // 「上传课件」唤起文件框；选完直接上传（多选也走同一条路）
        const chooser = page.waitForEvent('filechooser', { timeout: 5000 })
        await page.click(selector, { timeout: 5000 })
        const fileChooser = await chooser
        await fileChooser.setFiles({
          name: '第5-6节课件.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '执行程序' }] }))
        })
      } else if (act === 'pick') {
        // 「选择课件并上传」会唤起系统文件框，然后**直接开始上传**（不再点第二次）
        const chooser = page.waitForEvent('filechooser', { timeout: 5000 })
        await page.click(selector, { timeout: 5000 })
        const fileChooser = await chooser
        await fileChooser.setFiles({
          name: '第5-6节课件.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ slides: [{ slideNumber: 1, text: '执行程序' }] }))
        })
      } else {
        await page.click(selector, { timeout: 5000 })
      }

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

      // 清密码之后浏览器手上那串就失效了（这是对的）。审计继续跑下去要重新用主令牌登录，
      // 相当于用户在服务器上查到主令牌再粘回来。
      if (act === 'clear-password') {
        await page.evaluate(token => {
          localStorage.setItem('course.admin.token', token)
          var input = document.getElementById('token')
          if (input) input.value = token
        }, TOKEN)
      }

      const argv = calls.length > before ? calls[calls.length - 1] : null
      results.push({ tab, act, toast: toast.text, argv })

      const expected = EXPECTED[act]
      if (toast.kind.includes('missing')) failures.push('管理台 ' + tab + ' · ' + act + '：点了之后没有任何可见反馈')
      else if (expected && !toast.text.includes(expected)) failures.push('管理台 ' + tab + ' · ' + act + '：提示是「' + toast.text + '」，预期包含「' + expected + '」')
      else if (!expected && /失败|还没接上|没成功/.test(toast.text)) failures.push('管理台 ' + tab + ' · ' + act + '：' + toast.text)
    }
  }

  // 折叠状态必须跨重绘保持：用户点开一栏之后，轮询重绘不能把它收回去
  // （用户报过"我什么都没动，点开的栏目自己收回去"）
  await page.click('.seg button[data-tab="settings"]')
  await openAll()
  const foldKeys = await page.$$eval('#tab-settings details[data-fold]', nodes => nodes.map(node => node.dataset.fold))
  if (!foldKeys.length) failures.push('管理台 · 设置区的折叠块没有 data-fold 标记：展开状态无法保持')
  else {
    await page.$$eval('#tab-settings details[data-fold]', nodes => nodes.forEach(node => { node.open = true }))
    await page.evaluate(() => window.load({ quiet: true }))
    await page.waitForTimeout(400)
    const stillOpen = await page.$$eval('#tab-settings details[data-fold]', nodes => nodes.filter(node => node.open).length)
    if (stillOpen !== foldKeys.length) {
      failures.push('管理台 · 重绘之后折叠块被收回：' + stillOpen + '/' + foldKeys.length + ' 仍然展开')
    } else {
      console.log('  [设置] 重绘后折叠状态保持 ✓（' + stillOpen + ' 个）')
    }
  }

  // 「去处理」这类页内跳转：点了要切到对应 tab
  await page.click('.seg button[data-tab="overview"]')
  const jump = await page.$('#tab-overview [data-go]')
  if (jump) {
    const target = await jump.getAttribute('data-go')
    await jump.click()
    await page.waitForTimeout(150)
    const on = await page.getAttribute('.seg button[data-tab="' + target + '"]', 'aria-selected')
    if (on !== 'true') failures.push('管理台 · 「去处理」链接没有切到 ' + target)
    else console.log('  [概览] 去处理链接 →  切到 ' + target + ' 区')
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

/** 首页与索引页：横向课次条、课程过滤、条目落到正文的哪一节。 */
async function auditIndexPages(page, site, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('索引页 ' + name + '：' + detail)
  }
  console.log('首页与索引页')

  // 首页：一门课一行，课次在行内横向排开（同一 y、x 递增），不是一列到底
  await page.goto(site.url + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.band', { timeout: 8000 })
  const bands = await page.$$eval('.band', nodes => nodes.map(node => {
    const cards = [...node.querySelectorAll('.strip .card')].map(card => card.getBoundingClientRect())
    return {
      title: (node.querySelector('h2') || {}).textContent || '',
      tops: cards.map(rect => Math.round(rect.top)),
      lefts: cards.map(rect => Math.round(rect.left))
    }
  }))
  const execBand = bands.find(band => band.title.indexOf('刑事执行法') >= 0) || { tops: [], lefts: [] }
  const sameRow = execBand.tops.length > 1 && execBand.tops.every(top => Math.abs(top - execBand.tops[0]) <= 2)
  const runningRight = execBand.lefts.length > 1 && execBand.lefts[1] > execBand.lefts[0]
  await record('一门课一行', bands.length === 3, '共 ' + bands.length + ' 行：' + bands.map(band => band.title).join(' / '))
  await record('课次横向排开', sameRow && runningRight, '同一行 y=' + execBand.tops.join(',') + '，x=' + execBand.lefts.join(','))

  // 索引页：左侧挑课程，条目一次列到底，不做折叠
  await page.goto(site.url + '/concepts/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.index-row', { timeout: 8000 })
  const visibleRows = () => page.$$eval('.index-row', nodes => nodes.filter(node => !node.hidden).length)
  const visibleLinks = () => page.$$eval('.index-notes a', nodes => nodes.filter(node => !node.hidden).map(node => node.getAttribute('href')))
  const folds = await page.$$eval('details', nodes => nodes.length)
  await record('索引不折叠', folds === 0, '没有折叠块，' + (await visibleRows()) + ' 条一次列出')

  await page.click('#filter-rail button[data-course="商法概论"]')
  await page.waitForTimeout(150)
  const oneCourse = await visibleRows()
  const oneLinks = await visibleLinks()
  await record('按课程过滤', oneCourse === 1 && oneLinks.length === 1 && oneLinks[0].indexOf('商法概论') >= 0,
    '选中商法概论后可见 ' + oneCourse + ' 条 / ' + oneLinks.length + ' 个出处')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(200)
  const persisted = await page.$eval('#filter-rail button[data-course="商法概论"]', node => node.getAttribute('aria-pressed'))
  await record('过滤选择记在本地', persisted === 'true' && (await visibleRows()) === 1, '刷新后仍选中商法概论')

  await page.click('#filter-rail button[data-course=""]')
  await page.waitForTimeout(150)
  await record('切回全部', (await visibleRows()) === 2 && (await visibleLinks()).length === 3,
    '可见 ' + (await visibleRows()) + ' 条 / ' + (await visibleLinks()).length + ' 个出处')

  // 条目要落到正文里那一节，不是笔记开头
  await page.goto(site.url + '/statutes/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.index-notes a', { timeout: 8000 })
  const href = await page.$eval('.index-notes a', node => node.getAttribute('href'))
  const lawGroup = await page.$$eval('.index-group h2', nodes => nodes.map(node => node.textContent))
  await record('法条按法律名分段', lawGroup.length === 1 && lawGroup[0].indexOf('公司法') >= 0, lawGroup.join(' / '))
  await record('条目落到具体一节', /#三-法条依据$/.test(href || ''), '链接 ' + href)

  await page.click('.index-notes a')
  await page.waitForSelector('article h2', { timeout: 8000 })
  const headingId = await page.evaluate(() => decodeURIComponent(location.hash.replace(/^#/, '')))
  const headingExists = await page.evaluate(id => !!document.getElementById(id), headingId)
  await record('点击后落到正文位置', headingExists, '落在 ' + headingId + '，页面 ' + decodeURIComponent(page.url().split('/').pop()))
  const flashed = await page.waitForSelector('.anchor-flash', { timeout: 2500 }).then(() => true).catch(() => false)
  await record('落点高亮', flashed, flashed ? '目标小节带 anchor-flash' : '没有看到高亮')

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
  page.on('console', message => {
    // 清密码那一步会把当前凭据作废，浏览器随后必然吃到一次 401——这是预期行为，
    // 不是缺陷；其余控制台报错一律算失败
    if (message.type() !== 'error') return
    if (/401/.test(message.text())) return
    failures.push('控制台报错：' + message.text())
  })
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
    console.log('')
    await auditIndexPages(page, site, failures)
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

