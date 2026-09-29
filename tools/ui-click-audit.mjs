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
  buildNoteRecord, buildSourceMap, renderIndexPage, renderKnowledgeMapPage, renderNotePage, renderSearchPage,
  renderTermIndexPage, sectionTexts, verifySourceMap
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
  // 搜索页与真实建站一致：课程筛选在建站时算好（这一份夹具里只有上面那一篇笔记）。
  // 目录形式（/search/）也要写：页面的查询是写进地址栏的，返回时按 /search/?q=… 回到这一页。
  const searchHtml = renderSearchPage({ siteOrigin: '', courses: [{ name: record.courseName, count: 1 }] })
  fs.writeFileSync(path.join(siteRoot, 'search.html'), searchHtml)
  fs.mkdirSync(path.join(siteRoot, 'search'), { recursive: true })
  fs.writeFileSync(path.join(siteRoot, 'search/index.html'), searchHtml)
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

  /**
   * 夹具里的这一页纸要带**真实的来源映射**：用免费路径（确定性抽取）现算，
   * 这样"看原文 → 原文 → 返回一页纸"整条路是在真实数据上验的，而不是手写的假映射。
   */
  const attachFixtureSourceMap = record => {
    const note = String(record.markdown || '')
    const onepageMarkdown = String(record.onepage?.markdown || '')
    if (!note || !onepageMarkdown) return record
    const draft = buildSourceMap({ slug: record.slug, noteMarkdown: note, onepageMarkdown })
    const verified = verifySourceMap(draft, {
      slug: record.slug, noteMarkdown: note, onepageMarkdown, sections: sectionTexts(note)
    })
    if (!verified.entries.length) return record
    return {
      ...record,
      onepage: { ...record.onepage, sourceMap: { ...draft, entries: verified.entries } }
    }
  }

  // 首页 / 索引页：横向课次条、课程过滤、条目落到正文位置，都要真的点一遍
  const execSecond = buildNoteRecord({
    courseName: '刑事执行法',
    lessonTitle: '第7-8节 减刑与假释',
    lessonDate: '2026-09-23',
    // 这一节配了一页纸：首页那门课的第一行与课次行里的入口都要有东西可点
    onepage: {
      title: '减刑与假释的适用条件',
      // 第一块**逐字**引用正文（免费路径能定位到），第二块是概括（不硬指，走"未定位"）
      markdown: ['## 一、减刑', '', '- 减刑要经过报请与裁定两个环节。', '', '## 二、假释', '', '- 没有再犯危险的判断'].join('\n'),
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
  // 一页纸那一篇带上真实的来源映射（其余篇没有一页纸，不受影响）
  const courseRecords = [record, attachFixtureSourceMap(execSecond), companyRecord, companySecond, empiricalRecord]
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
/**
 * 审计里"故意注入失败"的开关：目前只有 .md 的 404 用它。
 * 放在模块作用域是因为控制台错误收集器在 main() 里，而注入发生在 auditNotePage() 里——
 * 用一个布尔把两边连起来，比把 404 全局放行安全得多。
 */
let expectedHttp404 = false

async function auditNotePage(page, site, noteUrl, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('笔记页 ' + name + '：' + detail)
  }
  console.log('笔记阅读页')
  const scale = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--font-scale'))
  /**
   * 浮层"开着没有"的判据：**看得见才算开着**，而不是某一种具体实现。
   * 收起可以用 display:none，也可以用 opacity:0 + pointer-events:none——后者做得了过渡，
   * 但闭着的浮层仍在布局里；两种实现都要能被正确判断（判据写死在 display 上就会误判）。
   * 判断就地写进每次 evaluate：addInitScript 只对**之后**加载的文档生效。
   */

  await page.goto(site.url + noteUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('article h2', { timeout: 8000 })

  /**
   * R1：**零标记**时点「我的标记」。
   *
   * 旧实现把这个 handler 写在笔记页脚本里，却去调用另一个闭包里的 toast——
   * 隔离浏览器复现的是 `toast is not defined`：点了什么都不发生，控制台报错。
   * 这里在页面还没有任何标记时先点一次：要有可读提示，且不能有页面脚本异常
   * （pageerror 由 main() 统一收集，出现即失败）。
   */
  {
    const pageErrors = []
    const onError = error => pageErrors.push(error.message)
    page.on('pageerror', onError)
    await page.click('[data-dock="marks"]')
    await page.waitForTimeout(400)
    const emptyMarks = await page.evaluate(() => {
      const box = document.getElementById('toast')
      return {
        toast: box ? box.textContent.trim() : '',
        visible: box ? box.style.opacity === '1' : false,
        panelHidden: document.getElementById('railMarks') ? document.getElementById('railMarks').hidden : null,
        marks: (() => { try { return JSON.parse(localStorage.getItem('course.annots:' + location.pathname) || '[]').length } catch (e) { return -1 } })()
      }
    })
    page.off('pageerror', onError)
    await record('零标记时点入口有真实反馈',
      emptyMarks.visible && /还没有标记/.test(emptyMarks.toast) && pageErrors.length === 0 && emptyMarks.marks === 0,
      '提示「' + emptyMarks.toast + '」，脚本异常 ' + pageErrors.length + ' 个，面板隐藏=' + emptyMarks.panelHidden)
  }

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
  // 浮层出现是 220ms 的短过渡：等它落定再量位置，否则量到的是动画中途
  await page.waitForTimeout(280)
  const popPlacement = await page.evaluate(() => {
    const button = document.querySelector('[data-tool="paper"]').getBoundingClientRect()
    const pop = document.getElementById('paperPop').getBoundingClientRect()
    return {
      // "开着"= 在布局里且没被藏起来；正在淡入也算开着，所以这里不看 opacity
      visible: (() => { const n = document.getElementById('paperPop'); if (!n) return false; const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' })(),
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
  // 收起是 180ms 的短过渡：等它播完再判断"收起了没有"
  await page.waitForTimeout(260)
  const closedAfterPick = await page.evaluate(() => {
    const n = document.getElementById('paperPop')
    if (!n) return true
    const s = getComputedStyle(n)
    return s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity || 1) <= 0.5
  })
  await record('选完颜色自动收起', closedAfterPick, closedAfterPick ? '浮层已收起' : '浮层还开着')
  const paperPopOpen = async () => page.evaluate(() => {
    const n = document.getElementById('paperPop')
    if (!n) return false
    const s = getComputedStyle(n)
    return s.display !== 'none' && s.visibility !== 'hidden'
  })
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

  /**
   * R2：小节链接复制。
   *
   * 旧实现不等 clipboard.writeText 完成就把按钮改成"已复制"——剪贴板被拒时同样报成功。
   * 成功路径要先给权限才测得出来（无权限时走的本来就是失败路径），失败路径见后面的
   * "剪贴板被拒"与"没有剪贴板 API"两段。
   */
  const anchorState = () => page.evaluate(() => {
    const a = document.querySelector('article h2 a.anchor')
    const box = document.getElementById('toast')
    return {
      label: a ? a.textContent : '',
      hash: location.hash,
      toast: box ? box.textContent.trim() : '',
      fallback: Boolean(box && box.querySelector('textarea')),
      visible: box ? box.style.opacity === '1' : false
    }
  })
  const anchor = await page.$('article h2 a.anchor')
  if (!anchor) await record('小节锚点', false, '标题上没有生成可复制的锚点')
  else {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.url }).catch(() => {})
    await anchor.click()
    await page.waitForTimeout(400)
    const copied = await anchorState()
    await record('小节链接复制成功才说已复制',
      copied.label === '已复制' && /已复制小节链接/.test(copied.toast) && copied.hash.length > 1 && !copied.fallback,
      '文字「' + copied.label + '」提示「' + copied.toast + '」地址 ' + decodeURIComponent(copied.hash))
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

  /**
   * A5：锚点必须指回**原来那一处**。
   *
   * 旧实现恢复时在整篇里 indexOf(文字)，同一个词出现两次时第二次的批注会被贴到第一处——
   * 这一步专门用浏览器里真实存在的重复短语来验：给第二处加高亮，刷新后它必须还在第二处。
   */
  // 只扫**正文**：目录/侧栏/工具条里的文字也带 id、也会重复，混进来会让"选第几处"
  // 指向导航而不是笔记（第一次跑就踩到了：批注被正确地锚在目录那一条上）。
  const pickRepeated = () => page.evaluate(() => {
    const article = document.querySelector('article')
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null)
    const texts = []
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement
      if (!parent || ['A', 'CODE', 'SCRIPT', 'STYLE'].includes(parent.tagName)) continue
      if (parent.closest('.annot, nav, .rail, .toc, #tools, #selbar')) continue
      texts.push(walker.currentNode.nodeValue || '')
    }
    for (let size = 8; size >= 4; size -= 1) {
      const seen = new Map()
      for (let n = 0; n < texts.length; n += 1) {
        const value = texts[n]
        for (let i = 0; i + size <= value.length; i += 1) {
          const chunk = value.slice(i, i + size)
          if (/^[\d\s、。，；：]+$/.test(chunk)) continue
          if (seen.has(chunk)) return { needle: chunk, occurrences: 2 }
          seen.set(chunk, n)
        }
      }
    }
    return null
  })

  const selectNth = (needle, nth) => page.evaluate(({ needle, nth }) => {
    const article = document.querySelector('article')
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null)
    const hits = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      const parent = node.parentElement
      if (!parent || ['A', 'CODE', 'SCRIPT', 'STYLE'].includes(parent.tagName)) continue
      if (parent.closest('.annot, nav, .rail, .toc, #tools, #selbar')) continue
      const value = node.nodeValue || ''
      let from = 0
      while (true) {
        const at = value.indexOf(needle, from)
        if (at < 0) break
        hits.push({ node, at })
        from = at + 1
      }
    }
    const hit = hits[nth]
    if (!hit) return { found: false, total: hits.length }
    const range = document.createRange()
    range.setStart(hit.node, hit.at)
    range.setEnd(hit.node, hit.at + needle.length)
    // 记下"这一处的上下文"：恢复之后用同样的上下文比对，比对比字符偏移稳得多
    // （读者的定位根可能是小节元素，审计扫的是整篇，两套偏移本来就不同）
    const before = document.createRange()
    before.selectNodeContents(article)
    before.setEnd(hit.node, hit.at)
    const after = document.createRange()
    after.selectNodeContents(article)
    after.setStart(hit.node, hit.at + needle.length)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    hit.node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return {
      found: true,
      total: hits.length,
      before: before.toString().slice(-24),
      after: after.toString().slice(0, 24)
    }
  }, { needle, nth })

  /** 正文纯文本里，某段文字的第 n 次出现位置（用来判断批注贴在了哪一处）。 */
  const occurrenceOffsets = needle => page.evaluate((needle) => {
    const article = document.querySelector('article')
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null)
    let text = ''
    const spans = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      const parent = node.parentElement
      if (!parent || ['A', 'CODE', 'SCRIPT', 'STYLE'].includes(parent.tagName)) continue
      if (parent.closest('.annot, nav, .rail, .toc, #tools, #selbar') && !parent.closest('.annot')) continue
      spans.push({ start: text.length, node })
      text += node.nodeValue || ''
    }
    const offsets = []
    let from = 0
    while (true) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      offsets.push(at)
      from = at + 1
    }
    // 被批注包住的片段：它在正文纯文本里的起点
    const annotated = [...article.querySelectorAll('.annot')].map(span => {
      const before = document.createRange()
      before.selectNodeContents(article)
      before.setEnd(span, 0)
      return { id: span.getAttribute('data-annot-id'), text: span.textContent || '', offset: before.toString().length }
    })
    return { offsets, annotated }
  }, needle)

  const repeated = await pickRepeated()
  if (!repeated) {
    await record('批注锚点：正文里有可测的重复短语', false, '这份夹具里找不到出现两次的短语，A5 无法在浏览器里验收')
  } else {
    const second = await selectNth(repeated.needle, 1)
    await record('能在正文里选中重复短语的第二处', second.found && second.total >= 2,
      second.found ? `共找到 ${second.total} 处` : '没选中（夹具或选择器有问题）')
    await page.keyboard.press('Meta+h')
    await page.waitForTimeout(200)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const after = await occurrenceOffsets(repeated.needle)
    const target = after.offsets[1]
    const first = after.offsets[0]
    const ours = after.annotated.filter(item => item.text === repeated.needle)
    const best = ours
      .map(item => ({ ...item, distance: Math.abs(item.offset - target), toFirst: Math.abs(item.offset - first) }))
      .sort((left, right) => left.distance - right.distance)[0]
    const anchors = await page.evaluate(needle => window.__courseAnnots
      ? window.__courseAnnots.debug().filter(item => item.text === needle)
      : [], repeated.needle)
    void first; void target; void best
    // 恢复后的批注（文字等于目标短语的那几个 span）各自的上下文
    const restored = await page.evaluate(needle => {
      const article = document.querySelector('article')
      return [...article.querySelectorAll('.annot')]
        .filter(span => (span.textContent || '') === needle)
        .map(span => {
          const before = document.createRange()
          before.selectNodeContents(article)
          before.setEnd(span, 0)
          const after = document.createRange()
          after.selectNodeContents(article)
          after.setStart(span, span.childNodes.length)
          return { before: before.toString().slice(-24), after: after.toString().slice(0, 24) }
        })
    }, repeated.needle)
    const matched = restored.find(item => item.before === second.before && item.after === second.after)
    await record('批注贴回原来那一处（同一个短语出现多次）',
      Boolean(matched),
      matched
        ? `上下文对上了：…${matched.before}「${repeated.needle}」${matched.after}…`
        : `选中的是 …${second.before}「${repeated.needle}」${second.after}…，恢复后有 ${restored.length} 条同文本批注但上下文都不是它｜锚点：${JSON.stringify(anchors)}`)

    // 同文本的两条批注：删掉其中一条，另一条必须还在（按 id 删，不按文字删）
    const firstSelect = await selectNth(repeated.needle, 0)
    await page.keyboard.press('Meta+h')
    await page.waitForTimeout(200)
    const beforeDelete = await page.$$eval('article .annot-mark', nodes => nodes.length)
    await selectNth(repeated.needle, 0)
    await page.keyboard.press('Meta+h')
    await page.waitForTimeout(200)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const afterDelete = await occurrenceOffsets(repeated.needle)
    await record('同一句话的两条批注：取消一条不会连带删掉另一条',
      firstSelect.found && beforeDelete >= 2 && afterDelete.annotated.length >= 1,
      `取消前 ${beforeDelete} 条，取消并刷新后剩 ${afterDelete.annotated.length} 条`)
  }

  // 导出/导入入口在工具栏上（批注只存本地，换设备前要能带走）
  const annotTools = await page.$$eval('#tools button[data-tool^="annot-"]', nodes => nodes.map(node => node.dataset.tool))
  await record('工具栏有批注导出/导入入口', annotTools.length === 2, '按钮：' + annotTools.join(' / '))

  /**
   * A6：复制的两条失败路径都要当场说清楚。
   *
   * 旧实现不看 HTTP 状态、也不接剪贴板的 Promise：取到 404 错误页也照样往剪贴板里塞，
   * 权限被拒时则一点反应都没有——读者以为"点了没生效"，其实复制的是错误页或在静默失败。
   */
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('权限被拒绝（审计注入）')) }
    })
  })
  const readToast = () => page.evaluate(() => {
    const box = document.getElementById('toast')
    return {
      text: box ? box.textContent : '',
      hasFallback: Boolean(box && box.querySelector('textarea')),
      visible: box ? box.style.opacity === '1' : false
    }
  })

  // 先验"A 路径"：剪贴板被拒 → 提示 + 给出可手工复制的文本域。
  // 走**选区工具条**上的复制：它没有网络请求，测的就是剪贴板这一件事
  // （工具栏那个还依赖 .md 的响应，混在一起会分不清失败原因）。
  await page.reload({ waitUntil: 'networkidle' })
  await selectSomeText()
  await page.click('#selbar button[data-annot="copy"]')
  await page.waitForTimeout(400)
  const clipboardFail = await readToast()
  await record('剪贴板被拒时给出手工兜底',
    clipboardFail.visible && /复制失败/.test(clipboardFail.text) && clipboardFail.hasFallback,
    '提示：' + clipboardFail.text.trim().slice(0, 40) + '｜是否带可选中的文本域：' + clipboardFail.hasFallback)

  // 再验"B 路径"：HTTP 不对时绝不能把错误页塞进剪贴板
  expectedHttp404 = true
  await page.route('**/*.md', route => route.fulfill({
    status: 404,
    contentType: 'text/plain',
    headers: { 'cache-control': 'no-store' },
    body: 'not found'
  }))
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('#tools button[data-tool="copy"]')
  await page.waitForTimeout(600)
  const httpFail = await readToast()
  await page.unroute('**/*.md')
  expectedHttp404 = false
  await record('取正文失败时不往剪贴板塞错误页', httpFail.visible && /取正文失败（HTTP 404）/.test(httpFail.text),
    '提示：' + httpFail.text.trim().slice(0, 60))

  /**
   * R2 的两条失败路径（同一个 bug 的另一半）：剪贴板被拒、浏览器没有剪贴板 API。
   * 两种情况下按钮都**不许**变成"已复制"，而且要给出可手工拿走的链接。
   */
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('article h2 a.anchor')
  await page.waitForTimeout(400)
  const anchorDenied = await anchorState()
  await record('剪贴板被拒时不谎报已复制',
    anchorDenied.label === '#' && /复制失败/.test(anchorDenied.toast) && anchorDenied.fallback && anchorDenied.hash.length > 1,
    '文字「' + anchorDenied.label + '」提示「' + anchorDenied.toast.trim().slice(0, 40) + '」带兜底文本域：' + anchorDenied.fallback)

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined })
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('article h2 a.anchor')
  await page.waitForTimeout(400)
  const anchorMissing = await anchorState()
  await record('没有剪贴板 API 时也说清楚',
    anchorMissing.label === '#' && /复制失败/.test(anchorMissing.toast) && anchorMissing.fallback,
    '文字「' + anchorMissing.label + '」提示「' + anchorMissing.toast.trim().slice(0, 40) + '」')
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('权限被拒绝（审计注入）')) }
    })
  })

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

  /**
   * U4：我的标记。
   *
   * 批注做完了还要能**找回来**：右侧那一列要给出摘录、所在小节、类型，点一下回到原处，
   * 删一条不能连坐别的（按 id 删）。定位不到的那几条也要留在列表里（标"待重新定位"），
   * 而不是从读者眼前消失。
   */
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const marksPanel = await page.evaluate(() => {
    const panel = document.getElementById('railMarks')
    const items = [...document.querySelectorAll('#marksList li')]
    const first = items[0]
    return {
      visible: panel ? !panel.hidden : false,
      count: items.length,
      kind: first ? (first.querySelector('.mark-kind') || {}).textContent || '' : '',
      excerpt: first ? (first.querySelector('.mark-excerpt') || {}).textContent || '' : '',
      where: first ? (first.querySelector('.mark-where') || {}).textContent || '' : '',
      stored: (() => { try { return JSON.parse(localStorage.getItem('course.annots:' + location.pathname) || '[]').length } catch (error) { return -1 } })(),
      heading: (document.getElementById('marksCount') || {}).textContent || '',
      note: (document.querySelector('.rail-marks-note') || {}).textContent || ''
    }
  })
  await record('我的标记：列出现有的标记', marksPanel.visible && marksPanel.count >= 1,
    marksPanel.count + ' 条（标题计数 ' + marksPanel.heading + '）｜类型「' + marksPanel.kind + '」｜小节「' + marksPanel.where + '」｜摘录「' + marksPanel.excerpt.slice(0, 24) + '」')
  await record('我的标记：写清只存在这台浏览器', /只存在这台浏览器/.test(marksPanel.note), '说明「' + marksPanel.note + '」')

  await page.click('#marksList .mark-jump')
  await page.waitForTimeout(700)
  const jumped = await page.evaluate(() => {
    const node = document.querySelector('article .annot[data-annot-id]')
    const rect = node ? node.getBoundingClientRect() : null
    return { inView: rect ? rect.top > -20 && rect.top < window.innerHeight : false }
  })
  await record('我的标记：点一条回到原处', jumped.inView, jumped.inView ? '目标标记在视野内' : '点了没滚到那条标记')

  const beforeDrop = marksPanel.count
  await page.click('#marksList .mark-drop')
  await page.waitForTimeout(400)
  const afterDrop = await page.evaluate(() => ({
    count: document.querySelectorAll('#marksList li').length,
    stored: (() => { try { return JSON.parse(localStorage.getItem('course.annots:' + location.pathname) || '[]').length } catch (error) { return -1 } })()
  }))
  await record('我的标记：删一条不动其他',
    afterDrop.count === beforeDrop - 1 && afterDrop.stored === afterDrop.count,
    beforeDrop + ' → ' + afterDrop.count + ' 条（localStorage ' + afterDrop.stored + ' 条）')

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
  await page.waitForSelector('#results .card.group', { timeout: 5000 }).catch(() => {})
  const shape = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#results .card.group')]
    const rows = [...document.querySelectorAll('#results .hit-list .hit a')]
    const first = rows[0]
    return {
      cards: cards.length,
      rows: rows.length,
      lesson: cards[0] ? (cards[0].querySelector('h3') || {}).textContent || '' : '',
      section: first ? (first.querySelector('h4') || {}).textContent || '' : '',
      href: first ? first.getAttribute('href') : '',
      badges: [...document.querySelectorAll('#results .hit-badge')].map(node => node.textContent.trim()),
      semantic: document.querySelectorAll('#results .hit-badge.semantic').length,
      rail: document.querySelectorAll('#search-rail button[data-course]').length,
      url: location.pathname + location.search
    }
  })
  const hint = await page.textContent('#hint')
  await record('输入即出结果（服务端检索）', shape.cards >= 1,
    '命中 ' + shape.cards + ' 节课 / ' + shape.rows + ' 处小节，提示「' + hint + '」')
  // 审计指出过：卡主标题是课次、小节只在次行——读者要的是"这句话在哪一节"
  await record('卡片主标题是命中的小节', Boolean(shape.section) && shape.section !== shape.lesson,
    '课次「' + shape.lesson + '」→ 小节「' + shape.section + '」')
  // 结果落点要指到命中的那一节（带锚点），而不只是整篇
  await record('结果落点带小节锚点', Boolean(shape.href && shape.href.includes('#')), '首个链接：' + shape.href)
  /**
   * R3：四档匹配不许混为一谈。
   *
   * 旧实现把所有非语义结果都写成"精确命中"——多词查询、错别字回退也算，读者会以为
   * 整句查询原样出现在笔记里。这里逐档验：完整短语→精确匹配；多词→关键词匹配；
   * 纠错回退→近似词匹配（写明原词→替换词）；向量召回→语义近似（公开端未启用时不出现）。
   */
  await record('完整短语命中标成精确匹配、不假装有语义',
    shape.badges.length > 0 && shape.badges.every(text => text === '精确匹配') && shape.semantic === 0,
    '标签：' + (shape.badges.join(' / ') || '（无）'))

  await page.fill('#q', '执行 措施')
  await page.waitForTimeout(800)
  const multiWord = await page.evaluate(() => ({
    badges: [...document.querySelectorAll('#results .hit-badge')].map(n => n.textContent.trim()),
    cards: document.querySelectorAll('#results .card.group').length
  }))
  await record('多词查询不冒充精确匹配',
    multiWord.cards > 0 && multiWord.badges.every(text => text === '关键词匹配'),
    multiWord.cards + ' 张卡，标签：' + (multiWord.badges.join(' / ') || '（无）'))

  // 纠错回退与向量召回：公开端没有语义、夹具里也没有错别字查询，用拦截响应验 UI 契约
  const injectSearch = payload => page.route('**/api/search**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payload)
  }))
  const baseHit = {
    slug: 'notes/刑事执行法/第5-6节', url: '/notes/刑事执行法/第5-6节.html',
    anchor: '/notes/刑事执行法/第5-6节.html#%E4%BA%8C', courseName: '刑事执行法',
    lessonTitle: '第5-6节', lessonDate: '2026-09-25', section: '二、执行措施与救济', sectionId: '二',
    snippets: ['执行措施与救济的关系需要先分清执行依据。'], keywords: [], theme: ''
  }
  await injectSearch({
    ok: true, query: '罪刑法定主意', total: 1, coverage: 'body', escalated: false,
    semantic: { used: false, enabled: false }, lexicalTotal: 1,
    fuzzy: [{ from: '主意', to: '主义' }],
    hits: [Object.assign({}, baseHit, { section: '罪刑法定主义的质疑' })]
  })
  await page.fill('#q', '罪刑法定主意')
  await page.waitForTimeout(800)
  const fuzzyBadge = await page.evaluate(() => {
    const node = document.querySelector('#results .hit-badge')
    return { text: node ? node.textContent.trim() : '', cls: node ? node.className : '' }
  })
  await record('纠错回退标成近似词匹配并写明替换',
    /近似词匹配/.test(fuzzyBadge.text) && /主意→主义/.test(fuzzyBadge.text) && /fuzzy/.test(fuzzyBadge.cls),
    '标签：' + fuzzyBadge.text)

  await page.unroute('**/api/search**')
  await injectSearch({
    ok: true, query: '轻罪前科怎么处理', total: 1, coverage: 'body', escalated: false,
    semantic: { used: true, enabled: true }, lexicalTotal: 0,
    fuzzy: [], hits: [Object.assign({}, baseHit, { semantic: true, similarity: 0.662 })]
  })
  await page.fill('#q', '轻罪前科怎么处理')
  await page.waitForTimeout(800)
  const semanticBadge = await page.evaluate(() => {
    const node = document.querySelector('#results .hit-badge')
    return { text: node ? node.textContent.trim() : '', hint: document.getElementById('hint').textContent.trim() }
  })
  await record('语义召回标成语义近似并给相似度',
    /语义近似/.test(semanticBadge.text) && /0.662/.test(semanticBadge.text) && !/正确率/.test(semanticBadge.hint),
    '标签：' + semanticBadge.text + '｜提示：' + semanticBadge.hint.slice(0, 50))
  await page.unroute('**/api/search**')
  await record('查询写进地址栏（返回时能还原）', /[?&]q=/.test(shape.url), '地址：' + shape.url)
  await record('课程筛选来自建站数据', shape.rail >= 2, shape.rail + ' 个筛选项')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const cleared = await page.inputValue('#q')
  await record('Esc 清空', cleared === '', '输入框剩「' + cleared + '」')

  /**
   * A6：异步反馈必须跟得上人的手速。
   *
   * 三件事各自对应一次真实的错觉：
   *   · 清空/Esc 之后，在途的那次请求晚一拍返回，把结果贴回一个已经空掉的框里；
   *   · 服务端其实拒绝了（429/400/504），页面却只说"暂时不可用"，读者找不到原因；
   *   · 中文输入法组字途中就发请求，搜的是半成品，还会顶掉完整查询的结果。
   * 这里用**可控延迟**与**拦截响应**把三种情形摆出来，而不是靠手速碰运气。
   */
  let searchRequests = 0
  await page.route('**/api/search**', async (route) => {
    searchRequests += 1
    await new Promise(resolve => setTimeout(resolve, 400))
    await route.continue()
  })

  await page.fill('#q', '执行措施')
  await page.waitForTimeout(220)   // 过 160ms 防抖，请求已经在途
  await page.fill('#q', '')
  await page.waitForTimeout(700)   // 等那次在途请求"回来"
  const afterClear = await page.evaluate(() => ({
    results: document.getElementById('results').innerHTML.trim().length,
    hint: document.getElementById('hint').textContent.trim()
  }))
  await record('清空后不被在途结果污染', afterClear.results === 0 && afterClear.hint === '',
    `结果长度 ${afterClear.results}、提示「${afterClear.hint}」`)

  await page.fill('#q', '执行措施')
  await page.waitForTimeout(220)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const afterEscape = await page.evaluate(() => ({
    results: document.getElementById('results').innerHTML.trim().length,
    hint: document.getElementById('hint').textContent.trim(),
    value: document.getElementById('q').value
  }))
  await record('Esc 取消在途检索', afterEscape.value === '' && afterEscape.results === 0 && afterEscape.hint === '',
    `输入「${afterEscape.value}」结果长度 ${afterEscape.results} 提示「${afterEscape.hint}」`)

  // 服务端说了原因就照实转达（429 / 400 / 504 都带 message）
  await page.unroute('**/api/search**')
  await page.route('**/api/search**', route => route.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'rate_limited', message: '请求过于频繁（每 60 秒最多 300 次），请稍后再试。' })
  }))
  await page.fill('#q', '执行措施')
  await page.waitForTimeout(600)
  const refused = await page.textContent('#hint')
  await record('服务端拒绝时说清原因', /请求过于频繁/.test(refused || ''), '提示「' + (refused || '').trim() + '」')

  // 输入法组字期间不发请求
  await page.unroute('**/api/search**')
  searchRequests = 0
  await page.route('**/api/search**', async (route) => { searchRequests += 1; await route.continue() })
  await page.fill('#q', '')
  await page.waitForTimeout(300)
  searchRequests = 0
  await page.evaluate(() => {
    const input = document.getElementById('q')
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = '执行措施'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
  })
  await page.waitForTimeout(500)
  const duringCompose = searchRequests
  await page.evaluate(() => {
    const input = document.getElementById('q')
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  await page.waitForTimeout(700)
  await record('输入法组字期间不检索、组完再搜',
    duringCompose === 0 && searchRequests >= 1,
    `组字中发了 ${duringCompose} 次，组完发了 ${searchRequests} 次`)
  await page.unroute('**/api/search**')

  // ── 课程筛选：点一下只看这门课，筛选也写进 URL ──
  await page.goto(site.url + '/search.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
  const courseName = await page.evaluate(() => {
    const button = [...document.querySelectorAll('#search-rail button[data-course]')].find(node => node.getAttribute('data-course'))
    return button ? button.getAttribute('data-course') : ''
  })
  if (courseName) {
    await page.fill('#q', '执行措施')
    await page.waitForTimeout(500)
    await page.click('#search-rail button[data-course="' + courseName + '"]')
    await page.waitForTimeout(600)
    const scoped = await page.evaluate(() => ({
      url: location.search,
      pressed: (document.querySelector('#search-rail button[aria-pressed="true"]') || {}).textContent || '',
      courses: [...document.querySelectorAll('#results .card-meta span')].map(node => node.textContent),
      cards: document.querySelectorAll('#results .card.group').length
    }))
    await record('课程筛选收窄结果并写进地址栏',
      scoped.url.includes('course=') && scoped.cards >= 1,
      '地址 ' + scoped.url + '，选中「' + scoped.pressed.trim() + '」，' + scoped.cards + ' 张卡')
  } else {
    await record('课程筛选收窄结果并写进地址栏', false, '页面里没有课程筛选项')
  }

  // ── 空数据：字面没有、语义入口又没开，页面要说清是两回事 ──
  await page.fill('#q', '量子纠缠与公司法')
  await page.waitForTimeout(700)
  const emptyState = await page.evaluate(() => ({
    hint: document.getElementById('hint').textContent.trim(),
    cards: document.querySelectorAll('#results .card.group').length
  }))
  await record('无结果时分别表达（不都说"知识库没有"）',
    emptyState.cards === 0 && /字面没有找到/.test(emptyState.hint) && /未启用语义检索/.test(emptyState.hint),
    '提示「' + emptyState.hint + '」')

  // ── 返回搜索：query、筛选、滚动位置都要还在 ──
  await page.fill('#q', '执行措施')
  await page.waitForTimeout(600)
  await page.evaluate(() => window.scrollTo(0, Math.min(300, document.body.scrollHeight - window.innerHeight)))
  await page.waitForTimeout(200)
  const beforeLeave = await page.evaluate(() => ({ q: document.getElementById('q').value, y: Math.round(window.scrollY) }))
  const firstLink = await page.$('#results .hit-list .hit a')
  if (firstLink) {
    // 往下滚一点，让"滚动位置"这件事真的有一个非零的值可验
    await page.evaluate(() => window.scrollTo(0, Math.max(120, Math.round(document.body.scrollHeight * 0.6 - window.innerHeight / 2))))
    await page.waitForTimeout(200)
    const scrolled = await page.evaluate(() => Math.round(window.scrollY))
    await firstLink.click()
    await page.waitForTimeout(700)
    // 点结果链接时先记一份（返回时用它还原）
    const savedRecord = await page.evaluate(() => sessionStorage.getItem('course.searchScroll'))
    await page.goBack()
    await page.waitForTimeout(1000)
    const afterBack = await page.evaluate(() => ({
      q: document.getElementById('q').value,
      y: Math.round(window.scrollY),
      cards: document.querySelectorAll('#results .card.group').length,
      url: location.pathname + location.search,
      left: sessionStorage.getItem('course.searchScroll')
    }))
    const recorded = savedRecord ? JSON.parse(savedRecord) : null
    await record('返回搜索保留查询与滚动',
      afterBack.q === beforeLeave.q && afterBack.cards >= 1 && afterBack.left === null &&
        (!recorded || Math.abs(recorded.y - scrolled) <= 4) && Math.abs(afterBack.y - scrolled) <= 60,
      '查询「' + afterBack.q + '」，离开时滚动 ' + scrolled + ' 记录为 ' + (recorded ? recorded.y : '（无）') +
        '，返回后 ' + afterBack.y + '，记录已用掉=' + (afterBack.left === null) + '，' + afterBack.cards + ' 张卡')
  } else {
    await record('返回搜索保留查询与滚动', false, '结果里没有可点的链接')
  }

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

  /**
   * U1：首页最多一个"继续阅读"入口。
   *
   * 前面刚在笔记页读过（位置记忆已写进 localStorage），所以这一页应当给出**一个**
   * 能一键回到那节课的入口，并说清读到哪一小节。它说的是位置，不是"学会了多少"。
   */
  const resume = await page.evaluate(() => {
    const box = document.getElementById('homeResume')
    const links = box ? [...box.querySelectorAll('a')] : []
    return {
      visible: box ? !box.hidden : false,
      count: links.length,
      text: links[0] ? links[0].textContent.trim() : '',
      href: links[0] ? links[0].getAttribute('href') : '',
      mastery: /已学会|掌握度|完成度|积分|排行榜/.test(document.body.textContent || '')
    }
  })
  await record('首页最多一个继续阅读入口',
    resume.visible && resume.count === 1 && resume.href.includes('.html#') && !resume.mastery,
    '入口「' + resume.text + '」→ ' + resume.href)
  if (resume.visible) {
    await page.click('#homeResume a')
    await page.waitForTimeout(900)
    const landed = await page.evaluate(() => ({ path: decodeURIComponent(location.pathname), hash: decodeURIComponent(location.hash) }))
    await record('点它能回到上次那一节', landed.path.includes('.html') && landed.hash.length > 1,
      '落在 ' + landed.path + landed.hash)
    await page.goto(site.url + '/index.html', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lesson-table', { timeout: 8000 })
  }
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
 * A7/U2：一页纸的两种看法。
 *
 * 旧实现（审计实测）：手机单栏但正文仍是 11.5px，fit 只在初始化与打印前跑且把用户字号
 * 限制在 0.85—1.15，于是"页面里把字号调到 140%"对正文毫无影响。所以这里**在真实浏览器里量
 * 计算字号**，而不是看 CSS 声明：
 *   · 阅读模式（默认）：正文 17px 基准，字号随全局滑块**即时**变化，标题与表格一起响应，
 *     且不靠裁切伪装放得下（没有 overflow:hidden）；
 *   · 纸张模式（一次点击）：仍按 A4 缩放、缩到底如实标出超限，缩放随字号即时重算；
 *   · 打印永远按纸张输出：即便当前是阅读模式，PDF 也正好 1 页 A4。
 */
async function auditOnepagePrint (page, site, noteUrl, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(22) + detail)
    if (!ok) failures.push('一页纸 ' + name + '：' + detail)
  }
  // 一页纸不是每节课都有（夹具里只有写了 onepage.markdown 的那一节）：
  // 从首页/索引页里找一个真实存在的一页纸链接，而不是拿笔记 URL 硬拼。
  await page.goto(site.url + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
  const onepageHref = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/onepage/"]')
    return link ? link.getAttribute('href') : ''
  })
  console.log('一页纸（阅读模式 / 纸张模式 / 真 PDF 数页数）')
  if (!onepageHref) {
    await record('夹具里有一页纸可测', false, '首页与索引页都没有 /onepage/ 链接')
    return results
  }
  const onepageUrl = new URL(onepageHref, site.url).toString()

  const measure = () => page.evaluate(() => {
    const sheet = document.getElementById('sheet')
    const body = document.getElementById('sheetBody')
    const h2 = body.querySelector('h2')
    const table = body.querySelector('table')
    const stateNode = document.getElementById('sheetState')
    return {
      mode: sheet.getAttribute('data-mode'),
      dataOverflow: sheet.getAttribute('data-overflow') === '1',
      scale: getComputedStyle(sheet).getPropertyValue('--sheet-scale').trim(),
      font: parseFloat(getComputedStyle(body).fontSize),
      h2Font: h2 ? parseFloat(getComputedStyle(h2).fontSize) : 0,
      tableFont: table ? parseFloat(getComputedStyle(table).fontSize) : 0,
      bodyOverflow: getComputedStyle(body).overflow,
      aspect: getComputedStyle(sheet).aspectRatio,
      chars: (body.textContent || '').length,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      state: stateNode ? stateNode.textContent.trim() : ''
    }
  })
  const pdfPages = async () => {
    const buffer = await page.pdf({ format: 'A4', printBackground: true })
    const text = buffer.toString('latin1')
    // 只数页对象：/Type /Pages 是目录节点，不能算进去
    return { pages: (text.match(/\/Type\s*\/Page[^s]/g) || []).length, bytes: buffer.length }
  }
  const setFont = async value => {
    await page.evaluate(scale => {
      localStorage.setItem('course.fontScale', String(scale))
      document.documentElement.style.setProperty('--font-scale', String(scale))
    }, value)
    await page.waitForTimeout(220)
  }

  // ── 手机 390×844：默认就是阅读模式 ──
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(onepageUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { localStorage.removeItem('course.onepageMode') })
  await setFont(1)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  const mobile = await measure()
  await record('手机默认阅读模式可读', mobile.mode === 'read' && mobile.font >= 17 && mobile.font <= 18,
    'mode=' + mobile.mode + '，正文 ' + mobile.font + 'px，标题 ' + mobile.h2Font + 'px，表格 ' + mobile.tableFont + 'px')
  await record('阅读模式不靠裁切伪装', mobile.bodyOverflow !== 'hidden' && mobile.aspect === 'auto',
    'overflow=' + mobile.bodyOverflow + '，aspect-ratio=' + mobile.aspect)
  await record('阅读模式整页不横移', mobile.scrollWidth <= mobile.viewport + 1,
    'scrollWidth=' + mobile.scrollWidth + '，viewport=' + mobile.viewport)

  // ── 字号即时响应：不刷新页面，直接改全局变量 ──
  await setFont(1.4)
  const bigger = await measure()
  const scaled = Math.abs(bigger.font - mobile.font * 1.4) < 0.6
  await record('字号随全局滑块即时变化', scaled && bigger.h2Font > mobile.h2Font,
    '正文 ' + mobile.font + ' → ' + bigger.font + 'px，标题 ' + mobile.h2Font + ' → ' + bigger.h2Font + 'px')
  await record('放大后仍不横移', bigger.scrollWidth <= bigger.viewport + 1,
    'scrollWidth=' + bigger.scrollWidth + '，viewport=' + bigger.viewport)

  // ── 纸张模式：一次点击，缩放随字号重算，缩不动就如实标出 ──
  await page.click('button[data-sheet-mode="a4"]')
  await page.waitForTimeout(220)
  const paperAt140 = await measure()
  const pressed = await page.evaluate(() => document.querySelector('button[data-sheet-mode="a4"]').getAttribute('aria-pressed'))
  await record('可切到 A4 预览', paperAt140.mode === 'a4' && pressed === 'true' && paperAt140.aspect !== 'auto',
    'mode=' + paperAt140.mode + '，aspect-ratio=' + paperAt140.aspect + '，' + paperAt140.state)
  await setFont(1)
  const paperAt100 = await measure()
  await record('纸张缩放随字号即时重算', paperAt100.scale !== paperAt140.scale,
    '--sheet-scale ' + paperAt140.scale + ' → ' + paperAt100.scale + '（' + paperAt100.state + '）')
  await record('纸张模式没有静默裁切', paperAt100.dataOverflow === false,
    'data-overflow=' + paperAt100.dataOverflow + '，正文 ' + paperAt100.chars + ' 字')
  const first = await pdfPages()
  await record('纸张模式：打印正好一页 A4', first.pages === 1,
    'PDF ' + first.pages + ' 页（' + Math.round(first.bytes / 1024) + 'KB）')

  // ── 打印兜底：当前是阅读模式，纸上也必须还是那张 A4 ──
  await page.click('button[data-sheet-mode="read"]')
  await page.waitForTimeout(200)
  const readAgain = await measure()
  const fromRead = await pdfPages()
  await record('阅读模式下打印仍是一页 A4',
    readAgain.mode === 'read' && fromRead.pages === 1,
    'mode=' + readAgain.mode + '，PDF ' + fromRead.pages + ' 页')

  // ── 桌面 1440×900：同一份内容，阅读模式依然是 17px 基准 ──
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  const desktop = await measure()
  await record('桌面阅读模式同宽可读', desktop.mode === 'read' && Math.abs(desktop.font - 17) < 0.6,
    'mode=' + desktop.mode + '，正文 ' + desktop.font + 'px，正文 ' + desktop.chars + ' 字')

  await page.evaluate(() => { localStorage.setItem('course.fontScale', '1'); localStorage.removeItem('course.onepageMode') })
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
  // A7：手机端目录**默认折叠**——它是几十条链接，展开着会把正文顶到屏幕外一千多像素。
  // 折叠了仍然要"够得着"：summary 可见、可点、点开之后列表出现。
  await record('目录默认折叠（不再把正文顶下去）', geometry.detailOpen === false,
    '折叠块 open=' + geometry.detailOpen + '，正文 top=' + (geometry.article?.top ?? -1))
  await record('折叠着的目录仍然够得着', await page.evaluate(() => {
    const summary = document.querySelector('.rail-toggle details summary')
    if (!summary) return false
    const rect = summary.getBoundingClientRect()
    return rect.height >= 36 && rect.top >= 0 && rect.width > 40
  }), '摘要行高度 ≥36px 且在视口内')
  const toggled = await page.evaluate(() => {
    const details = document.querySelector('.rail-toggle details')
    const summary = details.querySelector('summary')
    summary.click()
    return { open: details.open, links: details.querySelectorAll('nav.toc a').length }
  })
  await page.waitForTimeout(200)
  await record('点一下能展开目录', toggled.open === true && toggled.links > 0,
    '展开后 open=' + toggled.open + '，链接 ' + toggled.links + ' 条')
  const remembered = await page.evaluate(() => localStorage.getItem('course.tocOpen'))
  await record('目录开合状态被记住', remembered === '1', 'localStorage course.tocOpen=' + remembered)
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

/**
 * 阅读样板的截图（只在 COURSE_AUDIT_SHOTS=<目录> 时跑）。
 *
 * 审计本身是断言，截图是给人和评审看的同一版证据：一节课的首页入口、正文、一页纸
 * （阅读模式 100%/140%、纸张模式）、搜索结果，桌面与手机各一张。
 * 默认不写文件——CI 里跑审计不该往仓库里丢图片。
 */
async function captureReadingShots (page, site, fixture, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const shot = async (name, viewport) => {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(400)
    const target = path.join(dir, name + '.png')
    await page.screenshot({ path: target })
    console.log('  ▸ ' + target)
  }
  const desktop = { width: 1440, height: 900 }
  const mobile = { width: 390, height: 844 }
  const setFont = async value => {
    await page.evaluate(scale => {
      localStorage.setItem('course.fontScale', String(scale))
      document.documentElement.style.setProperty('--font-scale', String(scale))
    }, value)
    await page.waitForTimeout(250)
  }

  console.log('阅读样板截图')
  const narrow = { width: 320, height: 800 }
  const noteUrl = fixture.noteUrl.startsWith('http') ? fixture.noteUrl : new URL(fixture.noteUrl, site.url).toString()
  await page.goto(noteUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await shot('lesson-note-desktop', desktop)
  await shot('lesson-note-mobile', mobile)
  await shot('lesson-note-narrow', narrow)
  // 深色模式也留一张：配色精修要能在四种底色下看
  await page.evaluate(() => {
    localStorage.setItem('course.theme', 'dark')
    document.documentElement.setAttribute('data-theme', 'dark')
  })
  await page.waitForTimeout(300)
  await shot('lesson-note-dark-mobile', mobile)
  await page.evaluate(() => {
    localStorage.setItem('course.theme', 'light')
    document.documentElement.setAttribute('data-theme', 'light')
  })
  await page.waitForTimeout(200)
  // 四档底色各来一张：换底色之后卡片/表格/提示/工具栏都不能残留另一套底色
  for (const paper of ['green', 'kraft', 'gray']) {
    await page.evaluate(value => {
      localStorage.setItem('course.paper', value)
      document.documentElement.setAttribute('data-paper', value)
    }, paper)
    await page.waitForTimeout(250)
    await shot('lesson-note-paper-' + paper + '-mobile', mobile)
  }
  await page.evaluate(() => {
    localStorage.setItem('course.paper', '')
    document.documentElement.removeAttribute('data-paper')
  })
  await page.waitForTimeout(200)

  await page.goto(site.url + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  await shot('lesson-home-desktop', desktop)
  await shot('lesson-home-mobile', mobile)

  const onepageHref = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/onepage/"]')
    return link ? link.getAttribute('href') : ''
  })
  if (onepageHref) {
    await page.goto(new URL(onepageHref, site.url).toString(), { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => { localStorage.removeItem('course.onepageMode') })
    await setFont(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(400)
    await shot('lesson-onepage-read-mobile', mobile)
    await shot('lesson-onepage-read-desktop', desktop)
    await setFont(1.4)
    await shot('lesson-onepage-read-140-mobile', mobile)
    await shot('lesson-onepage-read-140-desktop', desktop)
    await page.evaluate(() => {
      localStorage.setItem('course.theme', 'dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await page.waitForTimeout(300)
    await shot('lesson-onepage-read-dark-mobile', mobile)
    await page.evaluate(() => {
      localStorage.setItem('course.theme', 'light')
      document.documentElement.setAttribute('data-theme', 'light')
    })
    await page.waitForTimeout(200)
    await page.click('button[data-sheet-mode="a4"]')
    await page.waitForTimeout(300)
    await shot('lesson-onepage-a4-desktop', desktop)
    await shot('lesson-onepage-a4-mobile', mobile)
    await page.evaluate(() => { localStorage.setItem('course.fontScale', '1'); localStorage.removeItem('course.onepageMode') })
  }

  await page.goto(site.url + '/search.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
  await page.fill('#q', '执行措施')
  await page.waitForTimeout(700)
  await shot('lesson-search-desktop', desktop)
  await shot('lesson-search-mobile', mobile)
  return []
}

/**
 * 来源映射的往返（§1.5）：一页纸 → 原文 → 返回一页纸。
 *
 * 验的是四件事，都在真实浏览器里点：
 *   1. 阅读模式里"看原文"在块旁边，点一下到**真正那一节**（地址栏锚点 + 小节在视野内）；
 *   2. 原文给出「返回一页纸」，地址与当前这一篇对得上（对不上就不该显示）；
 *   3. 回到一页纸时落回**原来那一块**（不是页首），并且有一点点落点提示；
 *   4. 浏览器后退同样落回去；往返不重置字号、纸色与深浅。
 * 另外确认 A4 模式里这些交互控件不出现（纸上不许多长出按钮）。
 */
async function auditSourceMapRoundTrip (page, site, failures) {
  const results = []
  const record = async (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log('  ' + (ok ? '✔' : '✖') + ' ' + name.padEnd(20) + detail)
    if (!ok) failures.push('来源映射 ' + name + '：' + detail)
  }
  console.log('来源映射往返')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(site.url + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
  const onepageHref = await page.evaluate(() => {
    const link = document.querySelector('a.onepage-link, a[href*="/onepage/"]')
    return link ? link.getAttribute('href') : ''
  })
  if (!onepageHref) {
    await record('夹具里有一页纸可测', false, '首页没有 /onepage/ 链接')
    return results
  }
  const onepageUrl = new URL(onepageHref, site.url).toString()

  // 读者字号调到 140%：往返之后必须还是 140%
  await page.goto(onepageUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('course.fontScale', '1.4')
    document.documentElement.style.setProperty('--font-scale', '1.4')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)

  const entries = await page.evaluate(() => ({
    links: document.querySelectorAll('.ob-link').length,
    blocks: document.querySelectorAll('[data-ob]').length,
    label: (document.querySelector('.ob-label') || {}).textContent || '',
    unmapped: (document.querySelector('.ob-unmapped') || {}).textContent || '',
    fontScale: document.documentElement.style.getPropertyValue('--font-scale')
  }))
  await record('一页纸上有"看原文"', entries.links >= 1 && entries.blocks >= 2 && entries.fontScale === '1.4',
    entries.links + ' 个入口，' + entries.blocks + ' 个块，字号 ' + entries.fontScale)
  await record('未定位的要点如实说明', /未能定位到具体小节/.test(entries.unmapped),
    '「' + entries.unmapped.trim() + '」')

  const target = await page.evaluate(() => {
    const link = document.querySelector('.ob-link')
    return link ? { href: link.getAttribute('href'), block: link.getAttribute('data-ob-from'), section: link.getAttribute('data-ob-section') } : null
  })
  await page.click('.ob-link')
  await page.waitForTimeout(700)
  const landed = await page.evaluate(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''))
    const node = id ? document.getElementById(id) : null
    const rect = node ? node.getBoundingClientRect() : null
    const back = document.getElementById('obBack')
    return {
      path: location.pathname,
      hash: decodeURIComponent(location.hash),
      inView: rect ? rect.top > -40 && rect.top < window.innerHeight : false,
      backVisible: back ? !back.hidden : false,
      backHref: back ? back.getAttribute('href') : '',
      storedReturn: (() => { try { return localStorage.getItem('course.obReturn') || '' } catch (error) { return '（读不到）' } })(),
      fontScale: document.documentElement.style.getPropertyValue('--font-scale'),
      theme: document.documentElement.getAttribute('data-theme')
    }
  })
  await record('点"看原文"到真正那一节',
    /^\/notes\//.test(landed.path) && landed.inView && landed.hash.length > 1 && landed.storedReturn.indexOf('onepagePath') > 0,
    landed.path + landed.hash + '，小节在视野内=' + landed.inView + '，已记下查阅上下文=' + (landed.storedReturn.indexOf('onepagePath') > 0))
  await record('原文给出「返回一页纸」',
    landed.backVisible && landed.backHref.indexOf('/onepage/') === 0 && landed.backHref.includes('#ob-'),
    landed.backVisible ? landed.backHref : '（没有出现返回入口）｜上下文：' + landed.storedReturn.slice(0, 160))

  await page.click('#obBack')
  await page.waitForTimeout(800)
  const returned = await page.evaluate(target => {
    const node = target ? document.querySelector('[data-ob="' + target + '"]') : null
    const rect = node ? node.getBoundingClientRect() : null
    return {
      path: location.pathname,
      inView: rect ? rect.top > -60 && rect.top < window.innerHeight : false,
      flashed: node ? node.className.includes('ob-flash') : false,
      atTop: Math.round(window.scrollY) < 80,
      scrollable: document.documentElement.scrollHeight - window.innerHeight > 120,
      fontScale: document.documentElement.style.getPropertyValue('--font-scale')
    }
  }, target ? target.block : '')
  // 夹具这一页很短，"停在页首"与"落回那一块"其实是同一件事；只有页面够长时才要求真的滚下去
  await record('返回后落回原来那一块',
    /^\/onepage\//.test(returned.path) && returned.inView && (!returned.atTop || !returned.scrollable),
    returned.path + '，块在视野内=' + returned.inView + '，可滚动=' + returned.scrollable + '，滚动到页首=' + returned.atTop)
  await record('往返不重置字号', returned.fontScale === '1.4', '字号 ' + returned.fontScale)

  // 浏览器后退：也该落回那一块，而不是页首
  await page.click('.ob-link')
  await page.waitForTimeout(700)
  await page.goBack()
  await page.waitForTimeout(900)
  const backAgain = await page.evaluate(target => {
    const node = target ? document.querySelector('[data-ob="' + target + '"]') : null
    const rect = node ? node.getBoundingClientRect() : null
    return {
      path: location.pathname,
      inView: rect ? rect.top > -60 && rect.top < window.innerHeight : false,
      atTop: Math.round(window.scrollY) < 80,
      scrollable: document.documentElement.scrollHeight - window.innerHeight > 120
    }
  }, target ? target.block : '')
  await record('浏览器后退也落回原块',
    /^\/onepage\//.test(backAgain.path) && backAgain.inView && (!backAgain.atTop || !backAgain.scrollable),
    backAgain.path + '，块在视野内=' + backAgain.inView)

  // A4 模式：这些交互控件不占纸面
  await page.click('button[data-sheet-mode="a4"]')
  await page.waitForTimeout(300)
  const paper = await page.evaluate(() => ({
    sourceVisible: (() => { const node = document.querySelector('.ob-source'); return node ? getComputedStyle(node).display !== 'none' : false })(),
    unmappedVisible: (() => { const node = document.querySelector('.ob-unmapped'); return node ? getComputedStyle(node).display !== 'none' : false })()
  }))
  await record('A4 预览里不出现来源入口', !paper.sourceVisible && !paper.unmappedVisible,
    '看原文可见=' + paper.sourceVisible + '，未定位说明可见=' + paper.unmappedVisible)
  await page.evaluate(() => {
    localStorage.setItem('course.fontScale', '1')
    localStorage.removeItem('course.onepageMode')
  })
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
    // 429 是搜索页那一步**自己造的**：拦截 /api/search 回一个限流响应，专门验证
    // "服务端拒绝时说清原因"。浏览器把它记成控制台错误是预期的，不算缺陷。
    if (/429 \(Too Many Requests\)/.test(message.text())) return
    // 404 只在"故意注入 .md 失败"的那一小段里被忽略（expectedHttp404 由那一步自己开关），
    // 其它时间出现 404 仍然算缺陷——不要为了省事把 404 全局放行。
    if (expectedHttp404 && /404 \(Not Found\)/.test(message.text())) return
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
    await auditOnepagePrint(page, site, fixture.noteUrl, failures)
    console.log('')
    await auditSourceMapRoundTrip(page, site, failures)
    if (process.env.COURSE_AUDIT_SHOTS) {
      console.log('')
      await captureReadingShots(page, site, fixture, process.env.COURSE_AUDIT_SHOTS)
    }
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

