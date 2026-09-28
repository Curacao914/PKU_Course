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

import {
  buildNoteRecord, renderIndexPage, renderKnowledgeMapPage, renderNotePage, renderSearchPage, renderTermIndexPage
} from '@course/publish'
// 一页纸页面的渲染函数没有从包的入口导出（包只暴露 "."），审计要造一份能点进去的
// 一页纸夹具，所以直接引这份源码——不然"首页那个入口点下去是不是真的到得了"就测不到。
import { renderOnepagePageHtml } from '../packages/publish/src/site.mjs'
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
    lessonDate: '2026-09-25',
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
      lessonDate: record.lessonDate, metadata: record.metadata
    }]
  }))
  // 搜索走服务端（/api/search），它读的是发布库——审计用的站点根也要有一份，
  // 否则搜索页在这里会"检索服务不可用"，而线上却是好的。
  fs.writeFileSync(path.join(siteRoot, 'library.json'), JSON.stringify([{
    ...record,
    keywords: record.keywords || [],
    theme: record.theme || '',
    metadata: record.metadata
  }], null, 2))

  // 首页 / 索引页：横向课次条、课程过滤、条目落到正文位置，都要真的点一遍
  const execSecond = buildNoteRecord({
    courseName: '刑事执行法',
    lessonTitle: '第7-8节 减刑与假释',
    lessonDate: '2026-09-23',
    // 这一节配了一页纸：首页那门课的第一行与课次行里的入口都要有东西可点
    onepage: {
      title: '减刑与假释的适用条件',
      markdown: ['## 一、减刑', '', '- 报请与裁定', '', '## 二、假释', '', '- 没有再犯危险'].join('\n'),
      chars: 26
    },
    brief: {
      briefing: '本节讲减刑与假释的适用条件：减刑的报请与裁定、假释的实质条件与考验期。',
      keyPoints: ['减刑要经过报请与裁定', '假释看没有再犯危险'],
      theme: '减刑与假释的适用条件',
      keywords: ['减刑', '假释', '报请与裁定', '考验期']
    },
    markdown: [
      '# 第7-8节 减刑与假释',
      '',
      '## 一、减刑的条件',
      '',
      '减刑要经过报请与裁定两个环节。假释看的是没有再犯危险。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 减刑',
      'META: CONCEPT: 假释',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  const companyRecord = buildNoteRecord({
    courseName: '商法概论',
    teacher: '李四',
    lessonTitle: '第1-2节 公司法总论',
    lessonDate: '2026-09-26',
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
    lessonDate: '2026-09-24',
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
  const companySecond = buildNoteRecord({
    courseName: '商法概论',
    lessonTitle: '第3-4节 公司治理',
    lessonDate: '2026-09-27',
    markdown: [
      '# 第3-4节 公司治理',
      '',
      '## 一、董事会中心主义',
      '',
      '法人人格否认在治理结构里是救济手段。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 法人人格否认',
      'META: CONCEPT: 董事会中心主义',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  const courseRecords = [record, execSecond, companyRecord, companySecond, empiricalRecord]
  for (const item of courseRecords) {
    const pageFile = path.join(siteRoot, item.slug + '.html')
    fs.mkdirSync(path.dirname(pageFile), { recursive: true })
    fs.writeFileSync(pageFile, renderNotePage(item, { siteOrigin: '' }))
  }
  // 一页纸页面：有 onepage 的课次才写（与 writeSite 的规则一致）
  for (const item of courseRecords.filter(record => record.onepage?.markdown)) {
    const pageFile = path.join(siteRoot, item.slug.replace(/^notes\//, 'onepage/') + '.html')
    fs.mkdirSync(path.dirname(pageFile), { recursive: true })
    fs.writeFileSync(pageFile, renderOnepagePageHtml(item, { siteOrigin: '' }))
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
    ocr: { pending: 2, attempted: 0, engine: '', errors: [{ path: '', error: '连不上 PaddleOCR' }] }
  }, null, 2))
  // 第二份课件 12 页：预览默认只给一屏，"继续加载"与"共 N 页"要有东西可测
  fs.writeFileSync(path.join(materialHome, '讲座课件.pptx'), 'fake-pptx')
  fs.writeFileSync(path.join(materialHome, 'slides', '讲座课件.pptx.json'), JSON.stringify({
    slideCount: 12,
    slides: Array.from({ length: 12 }, (_, index) => ({
      slideNumber: index + 1,
      text: '第 ' + (index + 1) + ' 页：执行措施的期限与审批'
    })),
    images: [],
    ocr: { pending: 0, attempted: 0, engine: '', errors: [] }
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
      ocr: { pending: 2, attempted: 0, engine: '', errors: [{ path: '', error: '连不上 PaddleOCR' }] },
      parsedPath: path.join(materialHome, 'slides', '图片版课件.pptx.json'),
      addedAt: '2026-09-25T10:00:00.000Z'
    }, {
      name: '讲座课件.pptx',
      scope: 'lesson',
      course: '刑事执行法',
      courseKey: '',
      lesson: '第5-6节',
      replayKey: 'replay-audit-1',
      appliesTo: [],
      bytes: 8,
      checksum: 'audit-long',
      slideCount: 12,
      imageCount: 0,
      ocrPending: 0,
      ocr: null,
      parsedPath: path.join(materialHome, 'slides', '讲座课件.pptx.json'),
      addedAt: '2026-09-25T10:00:00.000Z'
    }]
  }, null, 2))
  fs.writeFileSync(path.join(siteRoot, 'statutes/index.html'),
    renderTermIndexPage({ title: '法条索引', kind: 'statutes', notes: [companyRecord] }))
  // 绘图库替身：线上是 /assets/mermaid.min.js（3.5MB，自托管）。审计只需要它
  // "能被加载 + 返回一个 SVG"，真库的排版结果不在这里验。
  const assetsDir = path.join(scratchRoot, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  fs.writeFileSync(path.join(assetsDir, 'mermaid.min.js'), [
    'window.mermaid = {',
    '  initialize: function () {},',
    '  render: function (id, source) {',
    "    return Promise.resolve({ svg: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"80\" data-lines=\"' + source.split('\\n').length + '\"></svg>' })",
    '  }',
    '}'
  ].join('\n'))
  fs.mkdirSync(path.join(siteRoot, 'map'), { recursive: true })
  fs.writeFileSync(path.join(siteRoot, 'map/index.html'),
    renderKnowledgeMapPage({ notes: [companyRecord, companySecond, empiricalRecord] }))

  // 一个"正在后台识别"的任务：pid 用审计进程自己（活着），进度文件由识别进程写。
  // 这里手写一份快照，界面据此画进度条；断言完再清掉，好让"重新识别"那个按钮露出来。
  const ocrStatePath = path.join(scratchRoot, 'ocr-state.json')
  const ocrProgressPath = path.join(scratchRoot, 'ocr', 'audit.progress.json')
  fs.mkdirSync(path.dirname(ocrProgressPath), { recursive: true })
  fs.writeFileSync(ocrProgressPath, JSON.stringify({
    updatedAt: '2026-09-25T10:03:00.000Z',
    records: [{ name: '图片版课件.pptx', status: 'running', images: 4, pending: 2, at: '2026-09-25T10:03:00.000Z' }]
  }, null, 2))
  fs.writeFileSync(ocrStatePath, JSON.stringify([{
    course: '刑事执行法',
    lesson: '第5-6节',
    pid: process.pid,
    startedAt: '2026-09-25T10:02:00.000Z',
    logPath: path.join(scratchRoot, 'ocr', 'audit.log'),
    progressPath: ocrProgressPath,
    plan: { materials: 1, images: 4 }
  }], null, 2))

  return {
    dir, scratchRoot, siteRoot, outputDir, transcriptPath, noteUrl: '/' + record.slug + '.html',
    materialsRoot, ocrStatePath, ocrProgressPath
  }
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
  'add-tag': '先写标签名',   // 审计不填标签输入框：这条分支本来就要说"先写标签名"
  'cancel-upload': '取消',
  'delete-material': '已删除',
  'load-more': '已加载'
}

/**
 * 这几个动作的反馈是界面状态本身（展开课件、切换设置分类），不是右下角提示条，
 * 所以不能套"必须弹提示"那一关：改成点击后核对状态真的变了。
 */
const DEFERRED_ACTS = new Set(['delete-material'])

/** 在页面里造一个 File 并模拟拖放——浏览器只认页面里造出来的 File 对象。 */
async function dropFileOn(page, selector, { name, bytes, type }) {
  await page.evaluate(({ selector, name, size, type }) => {
    const file = new File([new Uint8Array(size)], name, { type })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    const zone = document.querySelector(selector)
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  }, { selector, name, size: bytes, type })
}

/** 模拟"剪贴板里带着一个文件"的粘贴；clipboardData 用 defineProperty 挂最稳。 */
async function pasteFile(page, { name, text }) {
  await page.evaluate(({ name, text }) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([text], name, { type: 'application/json' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer })
    document.dispatchEvent(event)
  }, { name, text })
}

/** 管理台：把每个按钮点一遍，要求「立刻有反馈」且发出的命令正确。 */
async function auditAdmin(page, site, fixture, calls, dialogs, failures) {
  const results = []
  await page.goto(site.url + '/admin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#tab-overview .card', { timeout: 10000 })
  if (await page.locator('text=需要登录').count()) throw new Error('管理台没登录上（fixture 或令牌有问题）')

  // 界面默认折叠（课程、课次、运行参数、输出）——审计要先把折叠层打开，
  // 否则测不到里面那些按钮，而"藏在折叠里的按钮点不动"恰恰是最容易漏的
  // 顶栏那个 ··· 是浮层，不展开（它会盖住内容，点了会挡住下面的按钮）
  const openAll = () => page.$$eval('main details, .card details', nodes => nodes.forEach(node => { node.open = true }))
  await openAll()

  /** 选中那一节有转录稿的课次：详情面板里的按钮都挂在它身上。 */
  const selectLesson = async () => {
    await page.click('.seg button[data-tab="courses"]')
    const course = await page.$('#courses .item[data-act="pick-course"]')
    if (course) await course.click()
    const lesson = await page.$('#lessons .item[data-act="pick-lesson"][data-value="replay-audit-1"]')
    if (lesson) await lesson.click()
    await page.waitForTimeout(150)
  }

  /**
   * 这几个动作的反馈是界面状态本身，不是右下角提示条：点击之后直接核对状态，
   * 顺带把"点了真有反应"这件事验实（比读一条提示条更接近用户看到的画面）。
   */
  const stateActs = {
    'pick-pane': async (selector) => {
      const pane = await page.getAttribute(selector, 'data-value')
      await page.click(selector)
      await page.waitForTimeout(120)
      const current = await page.getAttribute('#settingsRail [aria-current="true"]', 'data-value').catch(() => null)
      const shown = await page.getAttribute('#settingsDetail', 'data-pane').catch(() => null)
      if (current !== pane || shown !== pane) {
        failures.push('管理台 设置 · 切到「' + pane + '」后 aria-current 或右栏没跟着变（' + current + ' / ' + shown + '）')
      }
      return '切到 ' + pane
    },
    'pick-course': async (selector) => {
      const course = await page.getAttribute(selector, 'data-value')
      await page.click(selector)
      await page.waitForTimeout(120)
      const lessons = await page.$$eval('#lessons .item[data-act="pick-lesson"]', nodes => nodes.length)
      const selected = await page.getAttribute('#courses .item[aria-selected="true"]', 'data-value').catch(() => null)
      if (!lessons) failures.push('管理台 课程 · 点了课程之后课次列是空的')
      if (selected !== course) failures.push('管理台 课程 · 点了课程之后没有选中标记（' + course + ' → ' + selected + '）')
      return course + ' · ' + lessons + ' 节课次'
    },
    'pick-lesson': async (selector) => {
      const key = await page.getAttribute(selector, 'data-value')
      await page.click(selector)
      await page.waitForTimeout(150)
      const title = await page.textContent('#detail h2').catch(() => '')
      // 选中的那一行要标出来：否则"点了没反应"和"点了没事发生"看起来一模一样
      const selected = await page.getAttribute('#lessons .item[aria-selected="true"]', 'data-value').catch(() => null)
      if (!title || !title.trim()) failures.push('管理台 课程 · 点了课次之后详情面板是空的')
      if (selected !== key) failures.push('管理台 课程 · 点了课次之后没有选中标记（' + key + ' → ' + selected + '）')
      return '详情「' + String(title).trim() + '」'
    },
    'open-material': async (selector) => {
      await page.click(selector)
      await page.waitForSelector('#detail .pages .page', { timeout: 5000 }).catch(() => {})
      const pages = await page.$$eval('#detail .pages .page', nodes => nodes.length)
      const expanded = await page.getAttribute(selector, 'aria-expanded')
      if (!pages || expanded !== 'true') {
        failures.push('管理台 课程 · 点课件行没有展开（页数 ' + pages + '，aria-expanded=' + expanded + '）')
      }
      return '展开 ' + pages + ' 页'
    }
  }

  // 后台识别的进度要看得见：夹具里塞了一个"正在跑"的识别任务，
  // 先断言进度条与 done/total 文案，再把状态清掉，好让后面「重新识别」按钮露出来
  await selectLesson()
  const ocrText = await page.textContent('#detail .ocr').catch(() => '')
  const ocrWidth = await page.$eval('#detail .ocr .bar > i', el => el.style.width).catch(() => '0%')
  if (!/已识别 2\/4 张图/.test(ocrText) || !/正在处理 图片版课件\.pptx/.test(ocrText) || parseFloat(ocrWidth) <= 0) {
    failures.push('管理台 课程 · 识别进度没显示出来（「' + String(ocrText).trim() + '」，条宽 ' + ocrWidth + '）')
  } else {
    console.log('  [课件] 识别进度 ✓ ' + String(ocrText).trim() + '（条宽 ' + ocrWidth + '）')
  }
  fs.writeFileSync(fixture.ocrStatePath, '[]\n')
  await page.evaluate(() => window.load())
  await page.waitForTimeout(300)
  if (await page.$('#detail .ocr')) failures.push('管理台 课程 · 识别任务清掉之后进度条还在')
  await page.evaluate(() => window.load({ quiet: true }))
  await page.waitForTimeout(200)

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
    // 设置区是分栏：按钮只在自己那一栏里存在，所以先把每个分类都点一遍，
    // 把"哪一栏里的哪个动作"收齐——否则只有当前可见那栏的按钮会被测到
    const targets = []
    if (tab === 'settings') {
      const panes = await page.$$eval('#settingsRail [data-act="pick-pane"]', nodes => nodes.map(node => node.dataset.value))
      for (const pane of panes) {
        await page.click('#settingsRail [data-act="pick-pane"][data-value="' + pane + '"]')
        await page.waitForTimeout(80)
        const found = await page.$$eval('#tab-settings [data-act]', nodes => [...new Set(nodes.map(node => node.dataset.act))])
        for (const act of found) if (!targets.some(item => item.act === act && item.pane === pane)) targets.push({ act, pane })
      }
    } else {
      const found = await page.$$eval('#tab-' + tab + ' [data-act]', nodes => [...new Set(nodes.map(node => node.dataset.act))])
      for (const act of found) targets.push({ act, pane: '' })
    }
    for (const target of targets) {
      const act = target.act
      const selector = '#tab-' + tab + ' [data-act="' + act + '"]'
      // 每次操作后界面会重绘（折叠层又合上），所以每点一个按钮前都先展开
      await openAll()
      // 分栏里的按钮得先切到它那一栏才在
      if (target.pane) {
        const rail = await page.$('#settingsRail [data-act="pick-pane"][data-value="' + target.pane + '"]')
        if (rail) { await rail.click(); await page.waitForTimeout(80) }
      }
      // 删课件会把后面还要用的夹具删掉：它由课件场景单独验证
      if (DEFERRED_ACTS.has(act)) {
        results.push({ tab, act, toast: '（由课件场景单独验证）', argv: null })
        continue
      }
      if (stateActs[act]) {
        const detail = await stateActs[act](selector)
        results.push({ tab, act, toast: '（界面状态变化：' + detail + '）', argv: null })
        continue
      }
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

  // 状态必须跨重绘保持：用户报过"我什么都没动，点开的栏目自己收回去"。
  // 设置区现在没有折叠块了，所以这里查两处真实状态——选中的设置分类、运行输出的展开。
  await page.click('.seg button[data-tab="settings"]')
  await openAll()
  await page.click('#settingsRail [data-act="pick-pane"][data-value="params"]')
  await page.$eval('#outCard', node => { node.open = true })
  await page.evaluate(() => window.renderSettings())
  await page.waitForTimeout(200)
  const paneKept = await page.getAttribute('#settingsDetail', 'data-pane').catch(() => null)
  const outOpen = await page.$eval('#outCard', node => node.open)
  if (paneKept !== 'params') failures.push('管理台 · 重绘之后设置分类被重置（当前 ' + paneKept + '）')
  else if (!outOpen) failures.push('管理台 · 重绘之后「运行输出」被收回')
  else console.log('  [设置] 重绘后分类与展开状态都保持 ✓')

  const settingFolds = await page.$$eval('#tab-settings details', nodes => nodes.length)
  if (settingFolds) failures.push('管理台 · 设置区还在向下展开（' + settingFolds + ' 个折叠块），应该是分栏')
  // 键盘：分类是 button，Tab 能到、回车能切，选中那个带 aria-current
  await page.focus('#settingsRail [data-act="pick-pane"][data-value="password"]')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  const byKeyboard = await page.getAttribute('#settingsDetail', 'data-pane').catch(() => null)
  const currentPane = await page.getAttribute('#settingsRail [aria-current="true"]', 'data-value').catch(() => null)
  if (byKeyboard !== 'password' || currentPane !== 'password') {
    failures.push('管理台 · 设置分类用键盘回车切不过去（右栏 ' + byKeyboard + '，aria-current ' + currentPane + '）')
  } else {
    console.log('  [设置] 键盘回车切分类 ✓')
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

  // 课件这一块单开一段：拖放/粘贴/取消/删除都要求按顺序来，
  // 塞进"每个按钮点一遍"的循环里会互相拆台（删掉的那份正是后面要用的）
  const courseware = await auditCoursewareFlow(page, site, fixture, failures)
  for (const row of courseware) if (!row.ok) failures.push('管理台课件 · ' + row.name)
  return results
}

/**
 * 课件：展开收起、看全部页、拖放上传、取消上传、粘贴上传、删除。
 *
 * 这一段是用户逐条提的问题，所以每条都单独断言，不靠"点下去有提示"糊过去。
 */
async function auditCoursewareFlow(page, site, fixture, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('管理台课件 · ' + name + '：' + detail)
  }
  console.log('课件上传与预览')

  await page.click('.seg button[data-tab="courses"]')
  await page.click('#courses .item[data-act="pick-course"]')
  await page.click('#lessons .item[data-act="pick-lesson"][data-value="replay-audit-1"]')
  await page.waitForSelector('#detail .dropzone', { timeout: 5000 })

  // 展开 → 收起：用户报过"再点也收缩不回去"
  const row = '#detail .file[data-value="讲座课件.pptx"] .name'
  await page.click(row)
  await page.waitForSelector('#detail .pages .page', { timeout: 5000 })
  const opened = await page.$$eval('#detail .pages .page', nodes => nodes.length)
  const firstLabel = (await page.textContent('#detail .pages .row span')).trim()
  await page.click(row)
  await page.waitForTimeout(300)
  const closed = await page.$$eval('#detail .pages .page', nodes => nodes.length)
  await record('课件行展开与收起', opened === 8 && closed === 0, '展开 ' + opened + ' 页 → 再点变 ' + closed + ' 页')
  await record('说清共几页看到第几页', /共 12 页，当前显示到第 8 页/.test(firstLabel), firstLabel)

  // 继续加载：一屏 8 页只是"先看这些"，不是"只能看这些"
  await page.click(row)
  await page.waitForSelector('#detail [data-act="load-more"]', { timeout: 5000 })
  await page.click('#detail [data-act="load-more"]')
  await page.waitForFunction(() => !document.querySelector('#detail [data-act="load-more"]'), { timeout: 6000 }).catch(() => {})
  await page.waitForTimeout(200)
  const allPages = await page.$$eval('#detail .pages .page', nodes => nodes.length)
  const lastLabel = (await page.textContent('#detail .pages .row span')).trim()
  await record('继续加载能看全部', allPages === 12 && /共 12 页，当前显示到第 12 页/.test(lastLabel), lastLabel + '，共 ' + allPages + ' 页')

  // 20 秒轮询走的就是重绘这条路：展开的预览不能被它收回去
  await page.evaluate(() => window.renderCourses())
  await page.waitForTimeout(150)
  const keptPages = await page.$$eval('#detail .pages .page', nodes => nodes.length)
  await record('重绘不丢展开状态', keptPages === 12, '重绘后仍然 ' + keptPages + ' 页')
  await page.click('#detail [data-act="close-material"]')
  await page.waitForTimeout(150)

  // 拖放上传：把分片请求拖慢，好让"取消"来得及点
  let chunkCalls = 0
  await page.route('**/api/admin/materials/chunk**', async route => {
    if (route.request().method() === 'PUT') {
      chunkCalls += 1
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    await route.continue().catch(() => {})
  })
  await dropFileOn(page, '#detail .dropzone', {
    name: '大课件.pptx', bytes: 3 * 1024 * 1024, type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  })
  await page.waitForSelector('#detail [data-act="cancel-upload"]', { timeout: 6000 })
  // 取消按钮一出现就说明上传已经启动，但第一个分片可能还在路上：
  // 等它真的发出去再断言，否则测到的是"按钮比请求先出现"
  const dropAt = Date.now()
  while (chunkCalls < 1 && Date.now() - dropAt < 4000) await page.waitForTimeout(50)
  await record('拖进虚线框就开始上传', chunkCalls >= 1, '已发出 ' + chunkCalls + ' 个分片')
  await page.click('#detail [data-act="cancel-upload"]')
  const atCancel = chunkCalls
  await page.waitForTimeout(1600)
  await record('取消之后不再发分片', chunkCalls === atCancel, '取消时 ' + atCancel + ' 个，1.6 秒后 ' + chunkCalls + ' 个')
  const cancelToast = (await page.textContent('#toast')).trim()
  await record('取消有提示', /已取消上传/.test(cancelToast), cancelToast)
  await page.unroute('**/api/admin/materials/chunk**')
  await page.waitForFunction(() => !document.querySelector('#detail [data-act="cancel-upload"]'), { timeout: 6000 }).catch(() => {})

  // 粘贴上传：剪贴板里带文件（截图、从访达复制的课件）
  await pasteFile(page, { name: '粘贴课件.json', text: JSON.stringify({ slides: [{ slideNumber: 1, text: '粘贴进来的第一页' }] }) })
  const pasted = await page.waitForSelector('#detail .file[data-value="粘贴课件.json"]', { timeout: 8000 }).then(() => true).catch(() => false)
  await record('粘贴即上传', pasted, pasted ? '粘贴课件.json 已经出现在课件列表' : '列表里没有这份文件')

  // 删除：确认之后原件、解析结果、meta 里那一条一起清掉
  const filesBefore = await page.$$eval('#detail .file', nodes => nodes.length)
  await page.click('#detail .file[data-value="粘贴课件.json"] [data-act="delete-material"]')
  const gone = await page.waitForFunction(() => !document.querySelector('#detail .file[data-value="粘贴课件.json"]'), { timeout: 8000 }).then(() => true).catch(() => false)
  await page.waitForTimeout(200)
  const filesAfter = await page.$$eval('#detail .file', nodes => nodes.length)
  const onDisk = fs.existsSync(path.join(fixture.materialsRoot, '刑事执行法', '第5-6节', '粘贴课件.json'))
  const deletedToast = (await page.textContent('#toast')).trim()
  await record('删除课件', gone && !onDisk && filesAfter === filesBefore - 1 && /已删除/.test(deletedToast),
    '列表 ' + filesBefore + ' → ' + filesAfter + '，磁盘上' + (onDisk ? '还在' : '已经没了'))

  // 卡在哪、为什么：阶段说人话、错误给原文、退避时间写出来（夹具里第 7-8 节是失败停下的那节）
  await page.click('#lessons .item[data-act="pick-lesson"][data-value="replay-audit-2"]')
  await page.waitForTimeout(250)
  const stuck = await page.evaluate(() => ({
    row: document.querySelector('#detail .block .row').textContent.replace(/\s+/g, ' ').trim(),
    err: (document.querySelector('#detail .errbox pre') || {}).textContent || '',
    actions: [...document.querySelectorAll('#detail .action-item')].map(node => node.textContent.replace(/\s+/g, ' ').trim())
  }))
  await record('说清卡在哪、为什么',
    /连续失败已停/.test(stuck.row) && /needs_attention/.test(stuck.row) &&
    /尝试 1 次/.test(stuck.row) && /下次重试/.test(stuck.row) && stuck.err === '模型连续返回空结果',
    stuck.row + '｜原文：' + stuck.err)
  await record('两个按钮改名带说明',
    stuck.actions.some(text => text.includes('立即跑这一节') && text.includes('从当前阶段继续跑到发布')) &&
    stuck.actions.some(text => text.includes('清除失败、重新排队') && text.includes('清掉失败状态与退避时间')),
    stuck.actions.join(' / '))

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

  // 工具在顶栏这一排，正文右上角不该再有浮层（用户明确要求）
  const toolsInTopbar = await page.$eval('.topbar', el => !!el.querySelector('#tools'))
  const floatingTools = await page.$eval('#tools', el => getComputedStyle(el).position === 'fixed')
  await record('工具排在顶栏里', toolsInTopbar && !floatingTools, toolsInTopbar ? '顶栏里能找到工具栏' : '工具栏不在顶栏里')
  // 阅读页保持原样：工具栏图标排 + 导航下拉，不再多挂一个「阅读设置」下拉
  // （一页上出现两套一模一样的控件，读者只会犹豫该点哪个）
  const prefMenuOnNote = await page.$('#prefmenu')
  await record('阅读页不挂设置下拉', !prefMenuOnNote, prefMenuOnNote ? '顶栏里多了一个设置下拉' : '只有工具栏那一排')
  // 顶栏那几条站点链接（含知识地图）收进下拉，点开才出现
  await page.click('.navmenu > summary')
  await page.waitForTimeout(120)
  const navShown = await page.$eval('.navmenu .nav-pop', el => el.getBoundingClientRect().height > 0)
  const navLinks = await page.$$eval('.navmenu .nav-pop a', nodes => nodes.length)
  await record('导航收进下拉', navShown && navLinks === 5, '点开后 ' + navLinks + ' 条链接可见')
  await page.keyboard.press('Escape')
  await page.click('article h2')
  await page.waitForTimeout(120)

  // 字号：滑块改一下就变大，并且记住
  const before = parseFloat(await scale() || '1')
  await page.click('[data-tool="font"]')
  await page.$eval('#fontRange', el => { el.value = '1.25'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  const bigger = parseFloat(await scale() || '1')
  await page.$eval('#fontRange', el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  const back = parseFloat(await scale() || '1')
  const savedFont = await page.evaluate(() => localStorage.getItem('course.fontScale'))
  await record('字号滑块放大', bigger > before, '滑块 1 → 1.25，字号 ' + before + ' → ' + bigger)
  await record('字号写进本地存储', savedFont != null, 'localStorage.course.fontScale=' + savedFont)
  await record('字号能调回去', back <= bigger, '回到 ' + back)

  // 深色：切换后 html[data-theme] 要变，太阳/月亮图标要跟着换
  const shownIcon = async () => page.$eval('[data-tool="theme"]', el => {
    const sun = el.querySelector('.icon-sun')
    const moon = el.querySelector('.icon-moon')
    return { sun: getComputedStyle(sun).display !== 'none', moon: getComputedStyle(moon).display !== 'none' }
  })
  const iconBefore = await shownIcon()
  const themeBefore = await page.getAttribute('html', 'data-theme')
  await page.click('#toolTheme')
  const themeAfter = await page.getAttribute('html', 'data-theme')
  const iconAfter = await shownIcon()
  await record('深色切换', themeBefore !== themeAfter && themeAfter === 'dark', themeBefore + ' → ' + themeAfter)
  await record('图标跟着换', iconBefore.sun && !iconBefore.moon && iconAfter.moon && !iconAfter.sun,
    '日间显示太阳、夜间显示月亮')
  await page.click('#toolTheme')

  // 调色盘：小浮层要挂在按钮正下方（以前贴在屏幕最右边），选中的颜色要有标记
  await page.click('[data-tool="paper"]')
  const popPlacement = await page.evaluate(() => {
    const button = document.querySelector('[data-tool="paper"]').getBoundingClientRect()
    const pop = document.getElementById('paperPop').getBoundingClientRect()
    return {
      visible: getComputedStyle(document.getElementById('paperPop')).display !== 'none',
      dx: Math.round(Math.abs((pop.left + pop.width / 2) - (button.left + button.width / 2))),
      below: pop.top >= button.bottom - 2
    }
  })
  await record('色板浮层挂在按钮下方', popPlacement.visible && popPlacement.below && popPlacement.dx <= 24,
    '水平偏差 ' + popPlacement.dx + 'px，在按钮' + (popPlacement.below ? '下方' : '其它位置'))
  // 色板按钮要限定成 button.paper：<html> 自己也带 data-paper（底色挂在根元素上）
  await page.click('button.paper[data-paper="green"]')
  await page.waitForTimeout(150)
  const paperState = await page.evaluate(() => ({
    paper: document.documentElement.getAttribute('data-paper'),
    body: getComputedStyle(document.body).backgroundColor,
    pressed: document.querySelector('button.paper[data-paper="green"]').getAttribute('aria-pressed')
  }))
  await record('豆沙绿是 199/237/204', paperState.paper === 'green' && paperState.body === 'rgb(199, 237, 204)',
    '页面底色 ' + paperState.body)
  await record('选中的颜色有标记', paperState.pressed === 'true', 'aria-pressed=' + paperState.pressed)
  // 选完颜色浮层会自动收起（免得盖住别的按钮），所以再选一次要重新点开调色盘
  const closedAfterPick = await page.evaluate(() =>
    getComputedStyle(document.getElementById('paperPop')).display === 'none')
  await record('选完颜色自动收起', closedAfterPick, closedAfterPick ? '浮层已收起' : '浮层还开着')
  const paperPopOpen = async () => page.evaluate(() =>
    getComputedStyle(document.getElementById('paperPop')).display !== 'none')
  if (!(await paperPopOpen())) await page.click('[data-tool="paper"]')
  await page.click('button.paper[data-paper=""]')
  await page.keyboard.press('Escape')
  // 换过底色之后其它按钮必须照旧可用——这是用户报过的真实故障
  // （<html> 带 data-paper，宽松的 closest 判定把每次点击都当成选颜色）
  await page.click('#toolTheme')
  const themeAfterPaper = await page.getAttribute('html', 'data-theme')
  await record('换底色后其它按钮仍可用', themeAfterPaper === 'dark', '切到了 ' + themeAfterPaper)
  await page.click('#toolTheme')

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

  // 专注模式：两侧收起后正文必须还是正常宽度（用户报过"文字被压成最左边一列"）
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.click('[data-tool="focus"]')
  await page.waitForTimeout(200)
  const focusWidth = await page.$eval('article', el => el.getBoundingClientRect().width)
  const focusLeft = await page.$eval('article', el => el.getBoundingClientRect().left)
  await record('专注模式不压列', focusWidth > 400 && focusLeft > 40,
    '正文宽 ' + Math.round(focusWidth) + 'px，左边距 ' + Math.round(focusLeft) + 'px')
  await page.click('[data-tool="focus"]')
  await page.waitForTimeout(150)

  // 回到顶部：图标按钮，且让开右侧目录栏
  const topButton = await page.$eval('#totop', el => {
    const rect = el.getBoundingClientRect()
    const rail = document.querySelector('.rail-right')
    const railRect = rail ? rail.getBoundingClientRect() : null
    return {
      hasIcon: !!el.querySelector('svg'),
      overlapsRail: Boolean(railRect && rect.left < railRect.right && rect.right > railRect.left &&
        rect.top < railRect.bottom && rect.bottom > railRect.top)
    }
  })
  await record('回到顶部是图标', topButton.hasIcon, topButton.hasIcon ? '按钮里是 SVG' : '仍然是文字')
  await record('回到顶部不压目录', !topButton.overlapsRail, topButton.overlapsRail ? '与右侧目录重叠' : '位置让开了目录')

  // 划词：浮出像 Word 的小工具条（加粗/下划线/高亮/复制），快捷键 ⌘B/⌘U/⌘H 都要能用
  const selectSomeText = async () => {
    await page.evaluate(() => {
      const node = document.querySelector('article p')
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.waitForTimeout(150)
  }
  await selectSomeText()
  const annotButtons = await page.$$eval('#selbar button', nodes => nodes.map(node => node.dataset.annot))
  const selbarAbove = await page.evaluate(() => {
    const bar = document.getElementById('selbar')
    const selection = window.getSelection()
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    return { shown: bar.classList.contains('show'), above: bar.getBoundingClientRect().bottom <= rect.top + 4 }
  })
  await record('划词浮出工具条', selbarAbove.shown && annotButtons.length === 4,
    '按钮：' + annotButtons.join(' / '))
  await record('工具条在选区上方', selbarAbove.above, selbarAbove.above ? '出现在选区上方' : '出现在了选区下方')

  await page.click('#selbar button[data-annot="bold"]')
  await page.waitForTimeout(200)
  const bolded = await page.$$eval('article .annot-bold', nodes => nodes.length)
  // 断言"比周围重"，而不是逐字比较 '700'：浏览器对字重的计算值写法不止一种
  const boldWeight = await page.evaluate(() => {
    const span = document.querySelector('article .annot-bold')
    if (!span) return { span: null, parent: null }
    const weight = value => Number(String(value).replace('bold', '700').replace('normal', '400')) || 400
    return { span: weight(getComputedStyle(span).fontWeight), parent: weight(getComputedStyle(span.parentElement).fontWeight) }
  })
  await record('加粗真的加粗', bolded >= 1 && boldWeight.span > boldWeight.parent,
    '正文里 ' + bolded + ' 处加粗，字重 ' + boldWeight.parent + ' → ' + boldWeight.span)

  await selectSomeText()
  await page.keyboard.press('Meta+u')
  await page.waitForTimeout(200)
  const underlined = await page.$$eval('article .annot-underline', nodes => nodes.length)
  await record('⌘U 下划线', underlined >= 1, '正文里出现 ' + underlined + ' 处下划线')

  await selectSomeText()
  await page.keyboard.press('Meta+h')
  await page.waitForTimeout(200)
  const marked = await page.$$eval('article .annot-mark', nodes => nodes.length)
  await record('⌘H 高亮', marked >= 1, '正文里出现 ' + marked + ' 处高亮')

  // ⌘B 与按钮一样可切：同一段再按一次取消，再按一次又加回来
  await selectSomeText()
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(200)
  const toggledOff = await page.$$eval('article .annot-bold', nodes => nodes.length)
  await record('再按一次取消加粗', toggledOff < bolded, '加粗从 ' + bolded + ' 处变成 ' + toggledOff + ' 处')

  await selectSomeText()
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(200)
  const boldAgain = await page.$$eval('article .annot-bold', nodes => nodes.length)
  await record('⌘B 加粗', boldAgain > toggledOff, '加粗从 ' + toggledOff + ' 处变回 ' + boldAgain + ' 处')

  const annotStore = await page.evaluate(() => {
    const raw = localStorage.getItem('course.annots:' + location.pathname)
    const list = raw ? JSON.parse(raw) : []
    return { count: list.length, kinds: [...new Set(list.map(item => item.kind))].sort() }
  })
  await record('批注存在浏览器里', annotStore.count >= 3 && annotStore.kinds.length >= 3,
    'localStorage 里 ' + annotStore.count + ' 条，类型：' + annotStore.kinds.join('/'))

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
  await page.waitForSelector('#results a.card', { timeout: 5000 }).catch(() => {})
  const hits = (await page.$$('#results a.card')).length
  const hint = await page.textContent('#hint')
  await record('输入即出结果（服务端检索）', hits >= 1, '命中 ' + hits + ' 篇，提示「' + hint + '」')

  // 结果卡片要指到命中的那一节（带锚点），而不只是整篇
  const firstHref = await page.getAttribute('#results a.card', 'href')
  await record('结果落点带小节锚点', Boolean(firstHref && firstHref.includes('#')), '首个链接：' + firstHref)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const cleared = await page.inputValue('#q')
  await record('Esc 清空', cleared === '', '输入框剩「' + cleared + '」')

  return results
}

/** 首页与索引页：横向课次条、课程过滤、条目落到正文的哪一节。 */
async function auditIndexPages(page, site, noteUrl, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('索引页 ' + name + '：' + detail)
  }
  console.log('首页与索引页')

  // 首页：一门课一张表，一行一节课，列是 课次 | 关键词 | 时长 | 日期
  await page.goto(site.url + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lesson-table', { timeout: 8000 })
  const bands = await page.$$eval('.band', nodes => nodes.map(node => ({
    course: node.getAttribute('data-course'),
    lessons: node.querySelectorAll('.lesson-table tbody tr:not(.onepage-row)').length,
    headers: [...node.querySelectorAll('.lesson-table th')].map(th => th.textContent),
    // 一页纸那一行（.onepage-row）不是课次：它的关键词格写的是"共 N 节"，单独看
    keywords: [...node.querySelectorAll('.lesson-table tbody tr:not(.onepage-row)')]
      .map(row => [...row.querySelectorAll('.kw')].map(kw => kw.textContent))
  })))
  await record('一门课一组', bands.length === 3, '共 ' + bands.length + ' 组：' + bands.map(band => band.course).join(' / '))
  await record('课次按表格排', bands.every(band => band.lessons >= 1) && !(await page.$('.card')),
    bands.map(band => band.course + ' ' + band.lessons + ' 节').join('，'))
  await record('表头是课次/关键词/时长/日期', bands[0].headers.join('|') === '课次|关键词|时长|日期', bands[0].headers.join(' · '))
  // 一页纸那一行只说"共 N 节"，不是关键词，数关键词时要跳过它
  const keywordCounts = bands.flatMap(band => band.keywords.map(list => list.length))
  const keywordSample = bands[0].keywords[0] || []
  await record('每节课都有关键词', keywordCounts.every(count => count >= 2 && count <= 6),
    '关键词条数 ' + keywordCounts.join('/') + '，例如：' + keywordSample.join('、'))
  const themes = await page.$$eval('.lesson-theme', nodes => nodes.map(node => node.textContent.trim()))
  await record('每节课有一句主题', themes.length >= 1 && themes.every(text => text.length >= 4),
    themes[0] || '（没有主题句）')
  await page.click('#course-rail button[data-course="商法概论"]')
  await page.waitForTimeout(150)
  const visibleBands = await page.$$eval('.band', nodes => nodes.filter(node => !node.hidden).length)
  await record('首页按课程筛选', visibleBands === 1, '可见 ' + visibleBands + ' 组')
  await page.click('#course-rail button[data-course=""]')
  await page.waitForTimeout(120)

  // 一页纸入口：一个"带折角的纸"图标（原来那"一页纸"三个字被这张表挤得换行）
  const onepageEntry = await page.evaluate(() => {
    // 课次行里的图标入口
    const link = document.querySelector('.onepage-link')
    if (!link) return null
    const svg = link.querySelector('svg')
    // 每门课第一行的"一页纸摘要"入口（那一行的关键词格只说有几节）
    const row = document.querySelector('.onepage-row')
    return {
      isIcon: Boolean(svg) && link.textContent.trim() === '',
      label: link.getAttribute('aria-label'),
      title: link.getAttribute('title'),
      viewBox: svg ? svg.getAttribute('viewBox') : '',
      stroke: svg ? getComputedStyle(svg).stroke : '',
      fill: svg ? getComputedStyle(svg).fill : '',
      href: link.getAttribute('href'),
      rowText: row ? row.querySelector('.lesson-keywords').textContent.trim() : '',
      rowHref: row ? row.querySelector('.lesson-title a').getAttribute('href') : ''
    }
  })
  await record('一页纸入口是图标',
    Boolean(onepageEntry && onepageEntry.isIcon && onepageEntry.viewBox === '0 0 24 24' &&
      onepageEntry.fill === 'none' && onepageEntry.stroke !== 'none' &&
      onepageEntry.label === '一页纸摘要' && onepageEntry.title === '一页纸摘要'),
    onepageEntry
      ? 'aria-label=' + onepageEntry.label + '，viewBox ' + onepageEntry.viewBox + '，描边 ' + onepageEntry.stroke + '，链接 ' + onepageEntry.href
      : '页面上没有一页纸入口')
  await record('一页纸那一行只说有几节',
    Boolean(onepageEntry && onepageEntry.rowText === '共 1 节' && onepageEntry.rowHref === onepageEntry.href),
    onepageEntry
      ? '关键词格写着「' + onepageEntry.rowText + '」，入口指向 ' + onepageEntry.rowHref
      : '没有一页纸那一行')

  // 图标点下去要真的到那一页：入口不是装饰
  await page.click('.onepage-link')
  await page.waitForSelector('.sheet', { timeout: 8000 })
  const landedOnepage = await page.evaluate(() => ({
    path: location.pathname,
    title: (document.querySelector('.sheet-title') || {}).textContent || ''
  }))
  await record('点图标进入一页纸',
    /^\/onepage\//.test(landedOnepage.path) && landedOnepage.title.trim().length > 0,
    '落到 ' + landedOnepage.path + '（' + landedOnepage.title.trim() + '）')
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lesson-table', { timeout: 8000 })

  /** 打开设置下拉（已经开着就别再点一下关掉它）。 */
  const openPrefMenu = async () => {
    if (!(await page.$eval('#prefmenu', node => node.open))) await page.click('#prefmenu > summary')
    await page.waitForTimeout(120)
  }

  // 「阅读设置」下拉：深浅 / 底色 / 字号，这三项以前只有笔记页能改
  const prefPlacement = await page.evaluate(() => {
    const menu = document.getElementById('prefmenu')
    if (!menu) return null
    const box = menu.getBoundingClientRect()
    const others = [...menu.parentElement.children].filter(node => node !== menu)
    return {
      inTopbar: Boolean(menu.closest('.topbar')),
      isRightmost: others.every(node => node.getBoundingClientRect().right <= box.right),
      hasIcon: Boolean(menu.querySelector('summary svg')),
      // 顶栏那一排的最后一项，也就是页面右上角
      rightGap: Math.round(window.innerWidth - box.right),
      dots: menu.querySelectorAll('button.paper[data-paper]').length
    }
  })
  await record('设置下拉排在顶栏最右',
    Boolean(prefPlacement && prefPlacement.inTopbar && prefPlacement.isRightmost && prefPlacement.hasIcon && prefPlacement.dots === 4),
    prefPlacement ? '顶栏里最后一项，距右边缘 ' + prefPlacement.rightGap + 'px，' + prefPlacement.dots + ' 个底色圆点' : '顶栏里没有设置下拉')

  // 键盘可达 + 点外面收起 + Esc 收起：<details> 原生只管"点自己那一下"
  await page.focus('#prefmenu > summary')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(120)
  const openedByKeyboard = await page.$eval('#prefmenu', node => node.open)
  await page.click('.band > h2')
  await page.waitForTimeout(120)
  const closedByOutside = await page.$eval('#prefmenu', node => !node.open)
  await openPrefMenu()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  const closedByEscape = await page.$eval('#prefmenu', node => !node.open)
  await record('设置下拉键盘可达、点外面/Esc 收起',
    openedByKeyboard && closedByOutside && closedByEscape,
    '回车' + (openedByKeyboard ? '能展开' : '展不开') + '，点别处' + (closedByOutside ? '收起' : '没收起') + '，Esc ' + (closedByEscape ? '收起' : '没收起'))

  // 首页也能切底色 / 夜间 / 字号——都要真的改到这一页，而不是只写进 localStorage
  const homeLook = {}
  homeLook.bodyBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  homeLook.fontBefore = await page.$eval('.lesson-table .lesson-title a', el => parseFloat(getComputedStyle(el).fontSize))
  await openPrefMenu()
  await page.click('#prefmenu button.paper[data-paper="green"]')
  await page.waitForTimeout(150)
  const homePaper = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-paper'),
    body: getComputedStyle(document.body).backgroundColor,
    pressed: document.querySelector('#prefmenu button.paper[data-paper="green"]').getAttribute('aria-pressed'),
    stillOpen: document.getElementById('prefmenu').open
  }))
  await openPrefMenu()
  await page.click('#prefmenu [data-pref="theme"]')
  await page.waitForTimeout(150)
  const homeTheme = await page.evaluate(() => {
    const button = document.querySelector('#prefmenu [data-pref="theme"]')
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      pressed: button.getAttribute('aria-pressed'),
      moon: getComputedStyle(button.querySelector('.icon-moon')).display !== 'none',
      sun: getComputedStyle(button.querySelector('.icon-sun')).display !== 'none'
    }
  })
  await openPrefMenu()
  await page.$eval('#prefmenu #fontRange', el => { el.value = '1.3'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.waitForTimeout(200)
  const homeFont = await page.evaluate(() => ({
    scale: document.documentElement.style.getPropertyValue('--font-scale'),
    size: parseFloat(getComputedStyle(document.querySelector('.lesson-table .lesson-title a')).fontSize),
    stored: localStorage.getItem('course.fontScale')
  }))
  await page.keyboard.press('Escape')
  await record('首页也能切底色/夜间/字号',
    homePaper.attr === 'green' && homePaper.body === 'rgb(199, 237, 204)' &&
      homePaper.body !== homeLook.bodyBefore && homePaper.pressed === 'true' && !homePaper.stillOpen &&
      homeTheme.theme === 'dark' && homeTheme.pressed === 'true' && homeTheme.moon && !homeTheme.sun &&
      homeFont.scale === '1.3' && homeFont.size > homeLook.fontBefore && homeFont.stored === '1.3',
    '底色 ' + homeLook.bodyBefore + ' → ' + homePaper.body + '（' + homePaper.attr + '）；' +
    '主题 light → ' + homeTheme.theme + '（月亮图标 ' + (homeTheme.moon ? '亮' : '灭') + '）；' +
    '字号 ' + homeLook.fontBefore + 'px → ' + homeFont.size + 'px（--font-scale ' + homeFont.scale + '）')

  // 与笔记页互通：同一批 localStorage 键，刚才那一套在笔记页要原样生效
  await page.goto(site.url + noteUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('article h2', { timeout: 8000 })
  const inherited = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    paper: document.documentElement.getAttribute('data-paper'),
    scale: document.documentElement.style.getPropertyValue('--font-scale'),
    toolTheme: document.getElementById('toolTheme').getAttribute('aria-pressed'),
    range: document.getElementById('fontRange').value
  }))
  await record('设置与笔记页互通',
    inherited.theme === 'dark' && inherited.paper === null && inherited.scale === '1.3' &&
      inherited.toolTheme === 'true' && inherited.range === '1.3',
    '笔记页拿到 data-theme=' + inherited.theme + '，--font-scale=' + inherited.scale + '，工具栏滑块=' + inherited.range)

  // 收尾：切回白天，别让后面的索引页断言在一个夜间页面上跑
  await page.goto(site.url + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lesson-table', { timeout: 8000 })
  await openPrefMenu()
  await page.$eval('#prefmenu #fontRange', el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.click('#prefmenu button.paper[data-paper=""]')
  await page.waitForTimeout(150)
  await openPrefMenu()
  await page.click('#prefmenu [data-pref="theme"]')
  await page.waitForTimeout(150)
  const resetLook = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    paper: document.documentElement.getAttribute('data-paper')
  }))
  await record('切回白天', resetLook.theme === 'light' && resetLook.paper === null, 'data-theme=' + resetLook.theme)

  // 窄屏：顶栏那一排本来就挤，设置下拉不能溢出屏幕
  await page.setViewportSize({ width: 375, height: 800 })
  await page.waitForTimeout(200)
  await openPrefMenu()
  const narrow = await page.evaluate(() => {
    const menu = document.getElementById('prefmenu')
    const pop = menu.querySelector('.pref-pop').getBoundingClientRect()
    const summary = menu.querySelector('summary').getBoundingClientRect()
    return {
      popLeft: Math.round(pop.left), popRight: Math.round(pop.right),
      summaryRight: Math.round(summary.right),
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    }
  })
  await record('窄屏下拉不溢出屏幕',
    narrow.popLeft >= 0 && narrow.popRight <= narrow.viewport &&
      narrow.summaryRight <= narrow.viewport && narrow.scrollWidth <= narrow.viewport + 1,
    '375px 视口：下拉占 ' + narrow.popLeft + '~' + narrow.popRight + 'px，入口右边缘 ' + narrow.summaryRight + 'px，页面宽 ' + narrow.scrollWidth + 'px')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(150)

  // 索引页：课程 → 课次切分，术语是可点的词；不做折叠
  await page.goto(site.url + '/concepts/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.chip', { timeout: 8000 })
  const groupCount = await page.$$eval('.term-group', nodes => nodes.length)
  const chipCount = await page.$$eval('.chip', nodes => nodes.length)
  // 内容不做折叠（顶栏那个「阅读设置」下拉不算内容折叠）
  const folds = await page.$$eval('details', nodes => nodes.filter(node => node.id !== 'prefmenu').length)
  await record('概念按课次切分', groupCount >= 2 && chipCount >= groupCount, groupCount + ' 个课次分组 / ' + chipCount + ' 个术语')
  await record('索引不折叠', folds === 0, '没有折叠块，一次列到底')
  const sharedChips = await page.$$eval('.chip-shared', nodes => nodes.length)
  await record('标出跨课次的概念', sharedChips >= 1, sharedChips + ' 个术语不止一节讲过')

  await page.click('#filter-rail button[data-course="法律实证分析"]')
  await page.waitForTimeout(150)
  const visibleCourses = await page.$$eval('.term-course', nodes => nodes.filter(node => !node.hidden).map(node => node.dataset.course))
  await record('按课程切分', visibleCourses.length === 1 && visibleCourses[0] === '法律实证分析', '可见：' + visibleCourses.join(' / '))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(250)
  const persisted = await page.$eval('#filter-rail button[data-course="法律实证分析"]', node => node.getAttribute('aria-pressed'))
  await record('过滤选择记在本地', persisted === 'true', '刷新后仍选中法律实证分析')

  // 点一个术语：要滚到正文那一节、闪一下、并把术语在正文里标出来（?mark=）
  const chipHref = await page.$eval('.term-course:not([hidden]) .chip', node => node.getAttribute('href'))
  await page.click('.term-course:not([hidden]) .chip')
  await page.waitForSelector('article h2', { timeout: 8000 })
  // 标记是进页面后等 DOM 稳定再打的（120ms 与 load 各一次），这里等它出现再断言
  await page.waitForSelector('.mark-hit', { timeout: 2500 }).catch(() => {})
  const landed = await page.evaluate(() => ({
    scrollY: window.scrollY,
    marks: document.querySelectorAll('.mark-hit').length,
    hash: decodeURIComponent(location.hash.replace(/^#/, '')),
    exists: !!document.getElementById(decodeURIComponent(location.hash.replace(/^#/, '')))
  }))
  await record('术语跳到正文那一节', landed.exists, '落在「' + landed.hash + '」，链接 ' + chipHref.slice(0, 60))
  // 落点要对齐到视野顶部附近：只判断 scrollY 会误伤"目标本来就在第一屏"的情况
  const landedTop = await page.evaluate(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''))
    const node = document.getElementById(id)
    return node ? Math.round(node.getBoundingClientRect().top) : null
  })
  // 短笔记滚不到顶部（页面本身没那么长），所以只要求"落点在视野里"
  const landedVisible = await page.evaluate(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''))
    const node = document.getElementById(id)
    if (!node) return false
    const top = node.getBoundingClientRect().top
    return top >= -12 && top < window.innerHeight * 0.6
  })
  await record('落点滚动到位', landedVisible, '目标标题距视野顶部 ' + landedTop + 'px')
  const flashed = await page.waitForSelector('.anchor-flash', { timeout: 2500 }).then(() => true).catch(() => false)
  await record('落点高亮闪一下', flashed, flashed ? '目标小节带 anchor-flash' : '没有看到高亮')
  await record('正文里标出这个术语', landed.marks >= 1, landed.marks + ' 处高亮')

  // 知识地图：课次先后 + 每节课的骨架 + 跨课次概念
  await page.goto(site.url + '/map/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#map-rail button[data-course]', { timeout: 8000 })
  const mapCourses = await page.$$eval('#map-rail button[data-course]', nodes => nodes.length)
  const mapData = await page.$eval('#map-data', node => JSON.parse(node.textContent))
  const skeleton = mapData.courses.flatMap(course => course.lessons.flatMap(lesson => lesson.sections || []))
  const sharedTerms = [...new Set(mapData.courses
    .flatMap(course => course.lessons.flatMap(lesson => lesson.terms))
    .filter((term, index, all) => all.indexOf(term) !== index))]
  await record('地图数据完整', mapCourses >= 1 && skeleton.length >= 1,
    mapCourses + ' 门课可选；课次骨架 ' + skeleton.length + ' 节、跨课次概念 ' + sharedTerms.length + ' 个')

  const firstTitle = await page.textContent('#map-title')
  await page.click('#map-rail button[data-course="商法概论"]')
  await page.waitForTimeout(1500)
  const richCourse = await page.evaluate(() => ({
    title: document.getElementById('map-title').textContent,
    svg: document.querySelectorAll('#map-holder svg').length,
    drawn: document.querySelectorAll('#map-holder svg [data-lines]').length
  }))
  await record('地图跟着课程切换', richCourse.title === '商法概论' && richCourse.svg >= 1,
    (firstTitle || '') + ' → ' + richCourse.title + '，画布 ' + richCourse.svg + ' 张图（含骨架 ' +
    (richCourse.drawn ? '有' : '无') + '）')
  // 只讲一节课概念的小课程也要有东西可画：靠课次骨架，而不是空白
  await page.click('#map-rail button[data-course="法律实证分析"]')
  await page.waitForTimeout(1200)
  const thinCourse = await page.evaluate(() => ({
    title: document.getElementById('map-title').textContent,
    svg: document.querySelectorAll('#map-holder svg').length,
    explained: !document.getElementById('map-fallback').hidden
  }))
  await record('冷门课程也有图可看', thinCourse.title === '法律实证分析' && (thinCourse.svg >= 1 || thinCourse.explained),
    thinCourse.title + '：' + (thinCourse.svg >= 1 ? '画出了骨架' : '给了说明'))
  // 本地夹具没有绘图库（线上才有 /assets/mermaid.min.js），所以这里只要求"不出错、
  // 要么画出图、要么给出为什么没画"
  const mapState = await page.evaluate(() => ({
    svg: document.querySelectorAll('#map-holder svg').length,
    explained: !document.getElementById('map-fallback').hidden
  }))
  await record('地图有图或有说明', mapState.svg > 0 || mapState.explained,
    mapState.svg > 0 ? '已画出 ' + mapState.svg + ' 张图' : '给出了"没有跨课次概念"的说明')

  return results
}

/**
 * 手机视口下的两处布局（真实浏览器、真视口）：
 *   1. 笔记页：目录必须在正文**之前**、课次导航在正文**之后**——手机读者一打开就能跳小节；
 *   2. 管理台通知记录：窄屏是卡片（两行 grid），拉丁串（course-note / failed / 日期）不逐字硬换行。
 */
async function auditMobileLayout (page, site, noteUrl, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(22) + detail)
    if (!ok) failures.push('移动端 ' + name + '：' + detail)
  }
  console.log('移动端布局（390×844）')
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto(site.url + noteUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
  const geometry = await page.evaluate(() => {
    const at = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { top: Math.round(rect.top + window.scrollY), visible: rect.width > 0 && rect.height > 0 }
    }
    return {
      article: at('.col article') || at('.col'),
      toc: at('.rail-right .rail-toggle'),
      courseNav: at('.rail-left'),
      detailOpen: Boolean(document.querySelector('.rail-right .rail-toggle details[open]'))
    }
  })
  await record('本页目录在正文之前', Boolean(geometry.toc?.visible && geometry.toc.top < (geometry.article?.top ?? 0)),
    '目录 top=' + (geometry.toc?.top ?? -1) + '，正文 top=' + (geometry.article?.top ?? -1))
  // 课次导航（左栏）在夹具里可能只有一节课、渲染为空，所以直接核对**计算样式里的顺序**：
  // 目录 1 → 正文 2 → 课次导航 3，这正是用户要的移动端阅读顺序。
  const orders = await page.evaluate(() => ({
    toc: getComputedStyle(document.querySelector('.rail-right .rail-toggle')).order,
    article: getComputedStyle(document.querySelector('.col')).order,
    courseNav: getComputedStyle(document.querySelector('.rail-left')).order
  }))
  await record('顺序：目录 < 正文 < 课次导航', Number(orders.toc) < Number(orders.article) && Number(orders.article) < Number(orders.courseNav),
    'order 目录=' + orders.toc + '，正文=' + orders.article + '，课次导航=' + orders.courseNav)
  await record('目录默认展开可点', geometry.detailOpen, '折叠块 open=' + geometry.detailOpen)
  await record('目录链接可点区域足够大', await page.evaluate(() => {
    const link = document.querySelector('.rail nav.toc a')
    return Boolean(link && link.getBoundingClientRect().height >= 36)
  }), '首个目录链接高度 ≥36px')

  // 管理台：通知记录在窄屏是卡片，且不用逐字换行
  await page.goto(site.url + '/admin', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  // 通知记录在「设置」这一栏里：先切到设置栏，再点分类按钮（与主审计同一套路径）
  await page.click('#tabs [data-tab="settings"], [data-act="tab"][data-value="settings"]').catch(async () => {
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('[data-tab], .tab')].find(node => /设置/.test(node.textContent || ''))
      if (tab) tab.click()
    })
  })
  await page.waitForTimeout(200)
  await page.click('#settingsRail [data-act="pick-pane"][data-value="deliveries"]')
  await page.waitForSelector('.notify-item', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(200)
  const cardState = await page.evaluate(() => {
    const row = document.querySelector('.notify-item')
    if (!row) return { rows: 0 }
    const style = getComputedStyle(row)
    const purpose = row.querySelector('.notify-purpose')
    return {
      rows: document.querySelectorAll('.notify-item').length,
      display: style.display,
      purposeHeight: purpose ? Math.round(purpose.getBoundingClientRect().height) : -1,
      purposeWidth: purpose ? Math.round(purpose.getBoundingClientRect().width) : -1,
      purposeText: purpose ? (purpose.textContent || '').trim().slice(0, 20) : ''
    }
  })
  await record('通知记录在窄屏是卡片', cardState.rows > 0 && cardState.display === 'grid',
    cardState.rows + ' 行，display=' + cardState.display)
  await record('用途不被逐字换行', cardState.purposeHeight > 0 && cardState.purposeHeight <= 40 && cardState.purposeWidth > 60,
    '「' + cardState.purposeText + '」' + cardState.purposeWidth + '×' + cardState.purposeHeight + 'px（单行、有宽度）')

  await page.setViewportSize({ width: 1280, height: 900 })
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
    assetsDir: path.join(fixture.scratchRoot, 'assets'),
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
    await auditAdmin(page, site, fixture, calls, dialogs, failures)
    console.log('')
    await auditNotePage(page, site, fixture.noteUrl, failures)
    console.log('')
    await auditSearch(page, site, failures)
    console.log('')
    await auditIndexPages(page, site, fixture.noteUrl, failures)
    console.log('')
    await auditMobileLayout(page, site, fixture.noteUrl, failures)
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

