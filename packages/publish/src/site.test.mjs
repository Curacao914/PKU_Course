import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  articleNumber,
  buildNoteRecord,
  extractNoteMetadata,
  noteSlug,
  parseStatute,
  readSiteIndex,
  renderIndexPage,
  renderKnowledgeMapPage,
  renderOnepagePageHtml,
  refreshRecord,
  renderFeed,
  renderNotePage,
  renderSearchPage,
  renderTermIndexPage,
  writeSite
} from './site.mjs'
import { markdownPath, onePageMarkdownPath } from './markdown-path.mjs'

const NOTE = [
  '# 第10-12节 共犯与罪数',
  '',
  '> 课程：刑法分论 · 车浩',
  '',
  '## 课程概览',
  '',
  '### 本课要回答的核心问题',
  '1. 共犯如何成立？',
  '',
  '***',
  '',
  '### 一、共犯的成立条件',
  '',
  '共犯的成立需要共同故意与共同行为。',
  '',
  '***',
  '',
  '## 知识连接',
  '',
  '- 共犯 → 后续罪名分析'
].join('\n')

const record = (over = {}) => buildNoteRecord({
  courseName: '刑法分论',
  teacher: '车浩',
  lessonTitle: '第10-12节 共犯与罪数',
  markdown: NOTE,
  firstPublishedAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  ...over
})

test('slugs are stable and readable in a url', () => {
  assert.equal(noteSlug({ courseName: '刑法分论', lessonTitle: '第10-12节 共犯与罪数' }), 'notes/刑法分论/第10-12节-共犯与罪数')
  assert.equal(noteSlug({ courseName: '', lessonTitle: '' }), 'notes/course/lesson')
  assert.equal(noteSlug({ courseName: 'A/B:C', lessonTitle: 'x?y' }), 'notes/a-b-c/x-y')
})

test('a record carries summary, headings and metadata', () => {
  const built = record()
  assert.equal(built.slug, 'notes/刑法分论/第10-12节-共犯与罪数')
  assert.equal(built.courseName, '刑法分论')
  // 三个时间字段各管一件事：课次日期、首次进站、最近一次重新发布
  assert.equal(built.lessonDate, '2026-09-25', '标题里没有日期时退回首次发布的那天')
  assert.equal(built.lessonDateSource, 'published')
  assert.equal(built.firstPublishedAt, '2026-09-25T00:00:00.000Z')
  assert.equal(built.updatedAt, '2026-09-25T00:00:00.000Z')
  assert.equal('publishedAt' in built, false, 'publishedAt 已拆成 lessonDate / firstPublishedAt / updatedAt')
  assert.match(built.summary, /共犯的成立需要共同故意与共同行为/)
  assert.ok(built.summary.length <= 151, '摘要应被截断')
  // ## 课程概览 / ### 核心问题 / ### 一、共犯… / ## 知识连接
  assert.deepEqual(built.headings.map(h => h.level), [2, 3, 3, 2])
  assert.equal(built.headings[0].id, '课程概览')
  assert.throws(() => buildNoteRecord({ courseName: 'c', lessonTitle: 't', markdown: '   ' }), /笔记正文为空/)
})

test('the note page renders content, toc and metadata without raw html', () => {
  const html = renderNotePage(record({ markdown: `${NOTE}\n\n<script>alert(1)</script>` }), { siteOrigin: 'https://course.law-tech.dev' })
  assert.match(html, /<title>第10-12节 共犯与罪数 · 课程笔记<\/title>/)
  assert.match(html, /<link rel="canonical" href="https:\/\/course.law-tech.dev\/notes\/刑法分论\/第10-12节-共犯与罪数">/)
  assert.match(html, /<nav class="toc" aria-label="本页目录">/)
  assert.match(html, /href="#课程概览"/)
  assert.match(html, /<h2 id="课程概览">课程概览<\/h2>/)
  assert.match(html, /共犯的成立需要共同故意与共同行为。/)
  assert.ok(!html.includes('<script>alert'), '模型输出中的脚本不得原样进入页面')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.equal((html.match(/<h1>/g) || []).length >= 1, true)
})

test('the mermaid loader only ships on pages that actually contain a diagram', () => {
  const plain = renderNotePage(record({ markdown: NOTE }))
  assert.ok(!plain.includes('/assets/mermaid.min.js'), '没有图就不该让读者下载 3.5MB 的绘图库')

  const withDiagram = renderNotePage(record({
    markdown: `${NOTE}\n\n\`\`\`mermaid\nflowchart TD\n  A[抽样] --> B[变量]\n\`\`\`\n`
  }))
  assert.match(withDiagram, /\/assets\/mermaid\.min\.js\?v=[\d.]+/, '自托管路径必须带版本号：边缘缓存不会因为文件内容变了就失效')
  assert.ok(withDiagram.includes('language-mermaid'), '渲染器仍输出原始代码块，供脚本接管')
})

test('the 3.5MB diagram library is only fetched after the reader opens the fold', () => {
  // 读者到这台机器只有 100—250KB/s：知识地图折叠着的时候，绘图库一个字节都不该下。
  const html = renderNotePage(record({ markdown: `${NOTE}\n\n\`\`\`mermaid\nflowchart TD\n  A-->B\n\`\`\`\n` }))
  assert.match(html, /const fold = blocks\[0\]\.closest\('details'\)/)
  assert.match(html, /if \(!fold \|\| fold\.open\) start\(\)/, '折叠块已展开（或没有折叠块）时才立即加载')
  assert.match(html, /addEventListener\('toggle', function \(\) \{ if \(fold\.open\) start\(\) \}\)/, '展开时才加载')
})

test('the note page ships reading controls that work without an account', () => {
  // 字号、深浅、位置记忆都只依赖浏览器本地存储——个人笔记站不该为这三件小事引入登录。
  // 这三个开关现在只有顶栏工具栏这一份（顺手滑到左栏底部还有一份是重复品，已去掉）。
  const html = renderNotePage(record({ markdown: NOTE }))
  assert.match(html, /id="fontRange"/)
  assert.match(html, /data-tool="theme"/)
  assert.ok(!html.includes('data-read="font-up"'), '工具不该在页面上出现两份')
  assert.match(html, /id="resume"/, '位置记忆的入口要存在（有没有历史由脚本决定）')
  assert.match(html, /course\.readPos:/, '位置按页面路径分别记录')
  assert.match(html, /--font-scale/, '字号要真的驱动正文尺寸，而不是只改一个没人用的变量')
  assert.match(html, /calc\(18px \* var\(--font-scale\)\)/)
  assert.match(html, /:root\[data-theme="dark"\]/, '深色是一套完整的令牌覆盖，不是局部反色')
  assert.match(html, /prefers-color-scheme|浅色/, '默认仍是浅色，深色是可选项')
})

test('the toc highlight matches headings even when their ids are chinese', () => {
  // a.hash 是**百分号编码**后的形式（#%E8%AF%BE%E7%A8%8B…），而标题 id 是原文（课程概览）。
  // 早先直接拿 a.hash.slice(1) 当键去和标题 id 比，等于永远对不上：滚动高亮一条都不亮，
  // 「继续上次阅读」也永远不出现。中文标题的站点上这不是边角问题，是主路径。
  const html = renderNotePage(record({ markdown: NOTE }))
  assert.match(html, /decodeURIComponent/, '片段要先解码，再与标题 id 比较')
  assert.ok(!/links\.set\(a\.hash/.test(html), '不能拿未解码的 hash 当键')
  assert.match(html, /links\.get\(id\) \|\| \[\]/, '同一个 id 在窄屏/宽屏各有一条目录，要高亮两条')
  assert.match(html, /article h2\[id\], article h3\[id\], article h4\[id\]/, '目录里有四级标题，高亮要跟到四级')
})

test('the rail toc scrolls itself so the current section stays visible', () => {
  // 长笔记的目录比屏幕还长：高亮在动、但滚出可视区就等于没有。
  // 目录栏自己也要跟着滚（用户报过「左侧目录不会同步自动滑动」）。
  const html = renderNotePage(record({ markdown: NOTE }))
  assert.match(html, /function followActive/, '要有一个把目录滚到当前条目的函数')
  assert.match(html, /rail\.scrollTo\(/, '滚的是目录栏本身，不是整页')
  assert.match(html, /rail\.scrollHeight <= rail\.clientHeight \+ 8/, '目录没超出可视区时不要乱滚')
  assert.match(html, /function setActive \(id\)[\s\S]{0,900}followActive\(visible/, '高亮与滚动要一起发生')
  // 宽屏/窄屏各有一份目录，藏在 display:none 里的那份量出来是 0 尺寸：
  // 拿它算位置会把目录滚回顶部（正文往下读、目录反着往上走）
  assert.match(html, /getBoundingClientRect\(\)\.height > 0/, '要挑看得见的那份目录算位置')
  assert.match(html, /followActive\(visible \|\| next\[0\]\)/)
})

test('the reading page carries a course rail, a toolbar and the reader script', () => {
  const html = renderNotePage(record({ markdown: NOTE }), {
    siteOrigin: 'https://course.law-tech.dev',
    courseLessons: [
      { slug: 'notes/刑法分论/第10-12节-共犯与罪数', lessonTitle: '第10-12节 共犯与罪数' },
      { slug: 'notes/刑法分论/第9节', lessonTitle: '第9节 罪数' }
    ]
  })
  // 左栏是本课程的课次（点着就能换课），右栏才是本页目录
  assert.match(html, /class="rail rail-left"/)
  assert.match(html, /aria-label="本课程课次"/)
  assert.match(html, /aria-current="page"/)
  assert.match(html, /class="rail rail-right"/)
  // 工具栏：全 SVG 图标，不出现 emoji、不出现文字标签
  assert.match(html, /id="tools"/)
  assert.match(html, /data-tool="theme"/)
  assert.match(html, /data-tool="paper"/)
  assert.match(html, /data-paper="green"/, '豆沙绿要能选')
  assert.match(html, /data-paper="kraft"/, '牛皮纸要能选')
  assert.match(html, /id="fontRange"/)
  assert.match(html, /data-tool="focus"/)
  assert.match(html, /data-tool="copy"/)
  assert.match(html, /href="\/md\//, '导出 Markdown 的链接')
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(html), '工具栏不许用 emoji')
  // 划词之后浮出像 Word 的小工具条：加粗 / 下划线 / 高亮 / 复制，四种都要有
  assert.match(html, /id="selbar"/)
  assert.match(html, /data-annot="bold"/)
  assert.match(html, /data-annot="underline"/)
  assert.match(html, /data-annot="mark"/)
  assert.match(html, /data-annot="copy"/)
  assert.match(html, /annot-bold \{ font-weight: 700/, '加粗要真的加粗')
  // 快捷键 ⌘B / ⌘U / ⌘H：event.key 受输入法影响，用 event.code 兜底
  assert.match(html, /hit\('b'\)/)
  assert.match(html, /hit\('u'\)/)
  assert.match(html, /hit\('h'\)/)
  assert.match(html, /code === 'Key' \+ letter\.toUpperCase\(\)/)
  // 复核过的真实 bug：<html> 自己也带 data-paper，用 closest('[data-paper]') 会把
  // 每一次点击都当成选颜色 —— 换成米黄之后整排工具栏失灵
  assert.match(html, /closest\('button\.paper\[data-paper\]'\)/, '色板选择必须只认色板按钮')
  assert.ok(!/var dot = event\.target\.closest\('\[data-paper\]'\)/.test(html),
    '色板判定不能写成对根元素也生效的形式（<html> 自己也带 data-paper）')
  assert.match(html, /function annotsInRange/, '再按一次同一个按钮要能取消')
  assert.match(html, /range\.intersectsNode\(element\)/, '选区把批注整个包住时也要认出来')
  assert.match(html, /parent\.removeChild\(element\)/, '取消就是把包着的 span 拆掉')
  assert.match(html, /course\.annots:/, '批注按页面路径存本地')
  assert.match(html, /drawLine/, '下划线要有从左到右画出来的动画')
  assert.match(html, /anchor-flash/, '锚点高亮')
})

test('the reading page keeps its tools in the top bar instead of a floating panel', () => {
  const html = renderNotePage(record({ markdown: NOTE }), { siteOrigin: '' })
  // 工具直接排在顶栏这一行，正文右上角不再有浮层
  assert.match(html, /<header class="topbar">[\s\S]{0,600}id="tools"/, '工具栏要在顶栏里')
  assert.ok(!/\.tools \{ position: fixed/.test(html), '工具栏不再是悬浮窗')
  // 顶栏那四个站点链接收进下拉，与图标并排
  assert.match(html, /<details class="navmenu">/)
  assert.match(html, /class="nav-pop"/)
  // 首页/索引页照旧平铺导航，不必点开
  const home = renderIndexPage([record()])
  assert.match(home, /<nav><a href="\/">全部课次<\/a>/)
  assert.ok(!home.includes('title="站点导航"'), '首页的导航不收进下拉')
})

test('every page without the reading toolbar still offers 深浅 / 底色 / 字号', () => {
  // 用户的要求：这三项设置以前只有笔记页与一页纸页能改，首页、索引、地图、文档、搜索
  // 一个入口都没有——而它们是同一批 localStorage 键，本来就该处处能改。
  const pages = {
    首页: renderIndexPage([record()]),
    概念索引: renderTermIndexPage({
      title: '概念索引',
      kind: 'concepts',
      notes: [record({
        markdown: [NOTE, '', '<details><summary>元数据</summary>', '<pre><code>', 'META: CONCEPT: 共同故意', '</code></pre>', '</details>'].join('\n')
      })]
    }),
    知识地图: renderKnowledgeMapPage({ notes: [record({ markdown: NOTE })] }),
    搜索: renderSearchPage()
  }
  for (const [name, html] of Object.entries(pages)) {
    // 下拉挂在那一排导航的最右边（也就页面右上角），样式与站点导航下拉同一套
    assert.match(html, /<\/nav><details class="navmenu prefmenu" id="prefmenu">/, name + ' 的设置下拉要排在一排导航的末尾')
    assert.match(html, /<summary title="阅读设置" aria-label="阅读设置">/, name + ' 的入口要能键盘聚焦、有名字')
    assert.match(html, /data-pref="theme"/, name + ' 要能切深浅')
    for (const paper of ['data-paper="green"', 'data-paper="kraft"', 'data-paper="gray"']) {
      assert.ok(html.includes(paper), name + ' 要能选底色 ' + paper)
    }
    assert.match(html, /id="fontRange" min="0.9" max="1.4"/, name + ' 要能调字号')
    // 点外面收起 / Esc 收起：<details> 原生只管点自己那一下
    assert.match(html, /if \(!event\.target\.closest \|\| !event\.target\.closest\('#prefmenu'\)\) menu\.open = false/)
    assert.match(html, /event\.key === 'Escape' && menu\.open/)
    // 复核过的真实 bug：<html> 自己也带 data-paper，宽松的 closest 会把每次点击都吃成"选颜色"
    assert.match(html, /closest\('button\.paper\[data-paper\]'\)/, name + ' 的色板判定必须只认色板按钮')
    assert.ok(!/event\.target\.closest\('\[data-paper\]'\)/.test(html), name + ' 不能写成对根元素也生效的形式')
  }

  // 字号滑块在这几页要真的改得到字，而不是只改一个没人用的变量
  const home = pages.首页
  assert.match(home, /\.wrap \{ font-size: calc\(1em \* var\(--font-scale\)\); \}/,
    '内容区的基准字号要跟着 --font-scale')
  assert.match(home, /\.lesson-table \.lesson-title a \{ color: var\(--ink\); font-size: \.97em; \}/,
    '表格里的字号要跟着基准走（写成 em）')

  // 阅读页照旧用工具栏图标排，不再多一个同样的下拉；但两边必须是同一套实现（同一批键）
  const note = renderNotePage(record({ markdown: NOTE }))
  assert.ok(!note.includes('id="prefmenu"'), '阅读页不挂第二个设置入口')
  const core = html => html.match(/var store = \{\n    get: function \(key, fallback\)[\s\S]*?applyFont\(store\.get\('course\.fontScale', '1'\)\)/)[0]
  assert.equal(core(note), core(home), '两处必须是同一段实现，改了一边另一边就会漂移')
  for (const key of ['course.theme', 'course.paper', 'course.fontScale']) {
    assert.ok(core(home).includes(key), '共用 localStorage 键 ' + key)
  }
})

test('the reading page extras match what the reader asked for', () => {
  const html = renderNotePage(record({ markdown: NOTE }), { siteOrigin: '' })
  // 打印图标看出来是打印机，不再是引号
  assert.match(html, /data-tool="print"[\s\S]{0,200}<rect x="3.5" y="9"/)
  // 日/夜各一个图标，由主题决定显示哪个
  assert.match(html, /class="icon-sun"/)
  assert.match(html, /class="icon-moon"/)
  assert.match(html, /:root\[data-theme="dark"\] \.tools \[data-tool="theme"\] \.icon-sun \{ display: none; \}/)
  // 底色按钮就是一个调色盘图标；当前选中的颜色由小浮层里的圆点标出
  assert.match(html, /data-tool="paper"[^>]*><svg/, '底色按钮就是一个图标')
  assert.match(html, /--bg: #c7edcc/, '豆沙绿就是 rgb(199, 237, 204)')
  assert.match(html, /--mark: rgba\(255, 226, 108/, '高亮底色要有定义（以前没定义，等于透明）')
  // 小浮层挂在按钮正下方，不贴屏幕右边缘
  assert.match(html, /\.tools \.pop \{ position: absolute; top: 38px; left: 50%; transform: translateX\(-50%\)/)
  // 回到顶部是图标按钮，且让开右侧目录栏
  assert.match(html, /id="totop"[\s\S]{0,120}<svg/)
  assert.match(html, /\.totop \{ position: fixed; right: calc\(var\(--rail-w\) \+ 34px\)/)
  // 专注模式不能把正文塞进 0 宽的第一列
  assert.match(html, /\.reading\.focus \{ grid-template-columns: minmax\(0, 1fr\); gap: 0; \}/)
  // 页脚整块去掉
  assert.ok(!html.includes('footer class="site"'), '页脚不需要')
  assert.ok(!html.includes('course.law-tech.dev</span>'))
})

test('the index groups by course and lists newest first', () => {
  const html = renderIndexPage([
    record({ lessonTitle: '第1-2节', firstPublishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', firstPublishedAt: '2026-09-25T00:00:00.000Z' }),
    record({ courseName: '国际法学', lessonTitle: '第3-4节', firstPublishedAt: '2026-09-10T00:00:00.000Z' })
  ])
  assert.match(html, /<h2>刑法分论<\/h2>/, '一门课一组')
  assert.match(html, /<h2>国际法学<\/h2>/)
  assert.ok(html.indexOf('第10-12节 共犯与罪数') < html.indexOf('第1-2节'), '同一课程内新的在前')
  // 左侧课程筛选：和索引页同一套（点一下只看这门课）
  assert.match(html, /id="course-rail"/)
  assert.match(html, /data-course="刑法分论" aria-pressed="false">刑法分论<span class="filter-count">2<\/span>/)
  assert.match(html, /course\.homeFilter/, '选择记在本地')

  const empty = renderIndexPage([])
  assert.match(empty, /还没有已发布的笔记/)
})

test('writeSite lays out the whole site and can be regenerated from scratch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  const first = writeSite({ records: [record()], outputDir: dir, siteOrigin: 'https://course.law-tech.dev' })
  assert.equal(first.count, 1)
  assert.deepEqual(first.written.sort(), [
    'index.html',
    'notes.json',
    'notes/刑法分论/第10-12节-共犯与罪数.html',
    // 每篇同时写出一份 Markdown：页面上的下载 / 复制 Markdown 取它，
    // 正文全文就不必再内嵌进 HTML（那会让每页翻一倍）。
    // 路径带课程：只按课次命名时，两门课同一天同名课次会互相覆盖
    'md/刑法分论/第10-12节-共犯与罪数.md',
    'concepts/index.html',
    'statutes/index.html',
    'cases/index.html',
    'map/index.html',
    'search/index.html',
    'llms.txt',
    'feed.xml'
  ].sort())
  assert.ok(fs.existsSync(path.join(dir, 'index.html')))
  assert.ok(fs.existsSync(path.join(dir, 'notes/刑法分论/第10-12节-共犯与罪数.html')))
  // 索引页与搜索页是"复习时的入口"，不是附加装饰：它们必须真的被写出来
  for (const page of ['concepts', 'statutes', 'cases', 'search']) {
    assert.ok(fs.existsSync(path.join(dir, page, 'index.html')), `${page}/index.html 应当生成`)
  }

  const index = readSiteIndex(dir)
  assert.equal(index.count, 1)
  assert.equal(index.notes[0].slug, 'notes/刑法分论/第10-12节-共犯与罪数')
  assert.equal('markdown' in index.notes[0], false, '索引里不带正文，避免索引文件过大')
  // 索引里带三个时间字段：MCP、日报、首页都从这里取，缺一个就会退回"发布的那个时间"
  assert.equal(index.notes[0].lessonDate, '2026-09-25')
  assert.equal(index.notes[0].firstPublishedAt, '2026-09-25T00:00:00.000Z')
  assert.equal(index.notes[0].updatedAt, '2026-09-25T00:00:00.000Z')
  assert.equal('publishedAt' in index.notes[0], false)

  // 全量重写：删除的笔记不会残留在索引里
  const second = writeSite({ records: [], outputDir: dir })
  assert.equal(second.count, 0)
  assert.equal(readSiteIndex(dir).count, 0)
})

test('the feed lists the newest notes first and points at their pages', () => {
  const feed = renderFeed([
    record({ lessonTitle: '第1-2节', firstPublishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', firstPublishedAt: '2026-09-25T00:00:00.000Z' })
  ], { siteOrigin: 'https://course.law-tech.dev' })
  assert.match(feed, /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  assert.match(feed, /<link>https:\/\/course\.law-tech\.dev\/notes\//)
  assert.ok(feed.indexOf('第10-12节 共犯与罪数') < feed.indexOf('第1-2节'), '新的在前')
})

test('concept, statute and case indexes link back to the notes that mention them', () => {
  const withMeta = record({
    markdown: [
      '# 第10-12节 共犯与罪数',
      '',
      '## 课程概览',
      '',
      '正文。',
      '',
      '<details><summary>📑 笔记元数据（用于跨课整合）</summary>',
      '<pre><code>',
      'META: CONCEPT: 共同故意',
      'META: CONCEPT: 罪数',
      'META: PROVISION: 刑法第25条',
      'META: PROVISION: 刑法第69条',
      'META: CASE: 甲乙共同伤害案',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  assert.deepEqual(withMeta.metadata.concepts, ['共同故意', '罪数'])
  assert.deepEqual(extractNoteMetadata('META: CONCEPT: 甲\nMETA: PROVISION: 乙法第3条').statutes, ['乙法第3条'])
  assert.ok(withMeta.readMinutes >= 1)

  const concepts = renderTermIndexPage({ title: '概念索引', kind: 'concepts', notes: [withMeta] })
  assert.match(concepts, /共同故意/)
  assert.match(concepts, /href="\/notes\/刑法分论\/第10-12节-共犯与罪数\.html"/, '索引条目要能点回原笔记')

  const statutes = renderTermIndexPage({ title: '法条索引', kind: 'statutes', notes: [withMeta] })
  assert.match(statutes, /刑法第25条/)
  assert.equal(parseStatute('《刑法》第25条').law, '刑法')
  assert.equal(parseStatute('《刑法》第25条').article, '25')
  assert.ok(articleNumber('二十五') > articleNumber('十'), '条号要能比大小（中文数字）')
  assert.ok(articleNumber('69') > articleNumber('二十五'))

  const search = renderSearchPage()
  assert.match(search, /id="q"/)
  assert.match(search, /'\/api\/search\?q='/, '搜索交给服务端：与 MCP 同一套检索（IDF、多词、正文）')
  assert.ok(!search.includes("fetch('/api/notes')"), '不在浏览器里自己算打分：同一句话必须与 AI 检索给出同一批结果')
})

test('rebuilding from the publish library refreshes derived fields instead of reusing stale ones', () => {
  // 发布库里的记录是"发布那一刻"算好的：后来给页面加了新字段（索引锚点、目录），
  // --rebuild 读的是老记录。重建时必须按正文把派生字段重算一遍，否则模板改了页面却不变。
  const markdown = [
    '# 第10-12节 共犯与罪数',
    '',
    '## 课程概览',
    '',
    '引入。',
    '',
    '## 一、共犯的成立条件',
    '',
    '共同故意是共犯成立的主观要件。',
    '',
    '<details><summary>元数据</summary>',
    '<pre><code>',
    'META: CONCEPT: 共同故意',
    '</code></pre>',
    '</details>'
  ].join('\n')
  const stale = { ...record({ markdown }) }
  delete stale.headings
  delete stale.metadata
  delete stale.anchors
  delete stale.readMinutes

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  writeSite({ records: [stale], outputDir: dir2 })
  const notePage = fs.readFileSync(path.join(dir2, 'notes/刑法分论/第10-12节-共犯与罪数.html'), 'utf8')
  assert.match(notePage, /href="#一-共犯的成立条件"/, '目录要按正文重算出来')
  const concepts = fs.readFileSync(path.join(dir2, 'concepts/index.html'), 'utf8')
  assert.match(concepts, /#一-共犯的成立条件"/, '索引锚点也要重算')
})

test('the knowledge map groups lessons and their shared concepts', () => {
  const build = (lesson, terms) => record({
    lessonTitle: lesson,
    markdown: [
      '# ' + lesson,
      '',
      '## 一、本节',
      '',
      '正文。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      ...terms.map(term => 'META: CONCEPT: ' + term),
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  const html = renderKnowledgeMapPage({
    notes: [
      build('第1-2节 数据评价', ['抽样框', '变量测量']),
      build('第3节 抽样', ['抽样框', '简单随机抽样'])
    ]
  })
  // 数据以 JSON 内嵌，画图时才由脚本算"哪些概念跨了课次"
  const payload = JSON.parse(html.match(/<script id="map-data" type="application\/json">([\s\S]*?)<\/script>/)[1])
  assert.equal(payload.courses.length, 1)
  assert.deepEqual(payload.courses[0].lessons.map(lesson => lesson.lessonTitle), ['第1-2节 数据评价', '第3节 抽样'])
  assert.deepEqual(payload.courses[0].lessons[0].terms, ['抽样框', '变量测量'])
  // 绘图库按需加载：进页面不下载 3.5MB
  assert.match(html, /mermaid\.min\.js\?v=/, '绘图库按需加载，且自托管')
  assert.match(html, /type="module"/)
  assert.match(html, /if \(!source\) \{ explain\(\); return \}/, '没有跨课次概念时要给说明，而不是空白')
  assert.match(html, /id="map-rail"/)
})

test('the home page and the index pages share one course filter', () => {
  const html = renderIndexPage([record(), record({ courseName: '国际法学', lessonTitle: '第3-4节' })])
  assert.match(html, /id="course-rail"/)
  assert.match(html, /class="filter-rail"/)
  assert.match(html, /bands\[j\]\.hidden/, '首页过滤的是整组课程')
  const concepts = renderTermIndexPage({
    title: '概念索引',
    kind: 'concepts',
    notes: [record({
      markdown: [NOTE, '', '<details><summary>元数据</summary>', '<pre><code>', 'META: CONCEPT: 共同故意', '</code></pre>', '</details>'].join('\n')
    })]
  })
  assert.match(concepts, /id="filter-rail"/)
  assert.match(concepts, /querySelectorAll\('\.term-course'\)/, '按课程区块显隐')
})

test('keywords chosen while writing the brief win over the ranked fallback', () => {
  const markdown = [
    '# 第1-2节 有限责任',
    '',
    '## 一、法人人格否认',
    '',
    '法人人格否认是揭开公司面纱的手段。资本维持要求不得抽逃出资，资本维持也保护债权人。',
    '',
    '<details><summary>元数据</summary>',
    '<pre><code>',
    'META: CONCEPT: 法人人格否认',
    'META: CONCEPT: 资本维持',
    'META: CONCEPT: 抽逃出资',
    'META: CONCEPT: 制度',
    '</code></pre>',
    '</details>'
  ].join('\n')

  // 没有简报时：按出现频次与标题命中排序，泛词与课程名被挡掉
  const ranked = record({ markdown, courseName: '商法概论' })
  assert.equal(ranked.keywordsSource, 'ranked')
  assert.ok(ranked.keywords.includes('资本维持'), '正文里反复出现的词要进来')
  assert.ok(!ranked.keywords.includes('制度'), '泛词不进来')

  // 有简报时：模型挑的那几个词优先，重建也不覆盖
  const chosen = record({
    markdown,
    courseName: '商法概论',
    brief: { briefing: '这一节讲有限责任的两条主线。'.repeat(4), keyPoints: ['a', 'b', 'c'], keywords: ['法人人格否认', '资本维持', '风险外部化'] }
  })
  assert.equal(chosen.keywordsSource, 'brief')
  assert.deepEqual(chosen.keywords, ['法人人格否认', '资本维持', '风险外部化'])
  assert.deepEqual(refreshRecord(chosen).keywords, ['法人人格否认', '资本维持', '风险外部化'], '模型挑的关键词是判断，重建时不能退回排序结果')
})

test('发布库里的简报与一页纸带着出处（体检工具靠它发现串课）', () => {
  // 出处只存在于笔记目录里的那个文件是不够的：library.json 才是事后追查的唯一线索，
  // 所以要随记录一起落盘（tools/verify-library.mjs 查的正是这几个字段）。
  const bound = record({
    markdown: NOTE,
    brief: {
      briefing: 'x'.repeat(80), keyPoints: ['a'], theme: '共犯成立的条件', keywords: ['共同故意'],
      course: '刑法分论', lesson: '第10-12节 共犯与罪数', replayKey: 'replay-1',
      sourceChecksum: 'abc123', sourceChars: 1200, generatedAt: '2026-09-25T00:00:00.000Z',
      trace: { role: 'brief', model: 'x' }
    },
    onepage: {
      title: '一页', markdown: '## 甲\n\n- 一', chars: 10,
      course: '刑法分论', lesson: '第10-12节 共犯与罪数', sourceChecksum: 'def456'
    }
  })
  assert.deepEqual(Object.keys(bound.brief).sort(),
    ['briefing', 'course', 'generatedAt', 'keyPoints', 'lesson', 'replayKey', 'sourceChars', 'sourceChecksum'])
  assert.equal(bound.brief.sourceChecksum, 'abc123')
  assert.equal(bound.brief.sourceChars, 1200)
  assert.equal('trace' in bound.brief, false, '模型调用记录不进发布库')
  assert.equal(bound.onepage.sourceChecksum, 'def456')
  assert.equal(bound.onepage.course, '刑法分论')

  // 老数据没有出处字段：不带这些键，也不凭空补一个
  const legacy = record({ markdown: NOTE, brief: { briefing: 'y'.repeat(80), keyPoints: [] } })
  assert.equal('sourceChecksum' in legacy.brief, false)
  assert.deepEqual(Object.keys(legacy.brief).sort(), ['briefing', 'keyPoints'])
})

test('the one-page view is an A4 sheet that cannot overflow', () => {
  const built = record({
    markdown: NOTE,
    onepage: {
      title: '共犯成立的条件与判断顺序',
      markdown: ['## 一、成立条件', '', '- 共同故意', '- 共同行为', '', '## 二、辨析', '', '| 情形 | 结论 |', '| --- | --- |', '| 片面共犯 | 不成立 |'].join('\n'),
      chars: 60
    }
  })
  const html = renderOnepagePageHtml(built, {
    siteOrigin: 'https://course.law-tech.dev',
    courseLessons: [
      { slug: built.slug, lessonTitle: built.lessonTitle, chars: 60 },
      { slug: 'notes/刑法分论/第9节', lessonTitle: '第9节 罪数', chars: 0 }
    ]
  })
  assert.match(html, /<div class="onepage">/)
  assert.match(html, /<article class="sheet" id="sheet">/)
  assert.match(html, /id="sheetBody"/)
  assert.match(html, /column-count: 3/, '一页纸按三栏排')
  assert.match(html, /@page \{ size: A4/, '打印就是一张 A4')
  assert.match(html, /aspect-ratio: 210 \/ 297/, '屏幕上也是 A4 比例')
  // 放不下时自动缩小，缩到底还放不下就如实标记（绝不允许悄悄截断）
  assert.match(html, /--sheet-scale/)
  assert.match(html, /while \(overflows\(\) && scale > 0\.72/)
  assert.match(html, /data-overflow/)
  assert.match(html, /内容超出 A4，请精简/)
  // 左栏点的是"一页纸"，不是笔记
  assert.match(html, /href="\/onepage\/刑法分论\/第10-12节-共犯与罪数\.html"/)
  assert.match(html, /aria-current="page"/)
  // 顶栏工具仍在（打印/底色/复制），而且必须真的能用：脚本不带上，这排按钮就是死的
  assert.match(html, /<header class="topbar">[\s\S]{0,600}id="tools"/)
  assert.match(html, /data-tool="print"/)
  assert.match(html, /function applyPaper/, '一页纸页面要带阅读页脚本')
  assert.match(html, /function closePops/, '浮层交互也在那段脚本里')
  // 下载的是这一页纸，而不是整篇笔记
  // 文件名是百分号编码的，"一页纸"三个字编码后是 %E4%B8%80%E9%A1%B5%E7%BA%B8
  assert.match(html, /href="\/md\/[^"]*-%E4%B8%80%E9%A1%B5%E7%BA%B8\.md"/, '下载的是一页纸本身')
  // 一页纸页面没有 #reading（专注模式），点了不能抛错
  assert.match(html, /if \(!reading\) return/)
})

test('writeSite writes a one-page file only for lessons that have one', () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  const withOne = record({
    markdown: NOTE,
    onepage: { title: '一页', markdown: '## 甲\n\n- 一', chars: 10 }
  })
  const without = record({ lessonTitle: '第9节 罪数', markdown: NOTE })
  const site = writeSite({ records: [withOne, without], outputDir: dir3 })
  const written = site.written.sort()
  assert.ok(written.includes('onepage/刑法分论/第10-12节-共犯与罪数.html'), '有的一页纸要写出来')
  assert.ok(!written.some(file => file.startsWith('onepage/') && file.includes('第9节')), '没有一页纸的课次不占位')
  const page = fs.readFileSync(path.join(dir3, 'onepage/刑法分论/第10-12节-共犯与罪数.html'), 'utf8')
  assert.match(page, /class="sheet"/)
  // 首页那门课的第一行是这门课的一页纸入口
  const home = fs.readFileSync(path.join(dir3, 'index.html'), 'utf8')
  assert.match(home, /class="onepage-row"/)
  assert.match(home, /一页纸摘要/)
  // 课次行里的入口是一个"带折角的纸"图标：原来那三个字会被这张表挤得换行
  assert.match(home, /<a class="onepage-link" href="\/onepage\/[^"]+" title="一页纸摘要" aria-label="一页纸摘要"><svg viewBox="0 0 24 24"/,
    '一页纸入口是 SVG 图标，且鼠标悬停与读屏都能看出它是"一页纸摘要"')
  assert.ok(!/>一页纸<\/a>/.test(home), '不再用文字当图标')
  // 一页纸那一行的关键词格只留"共 N 节"：排版说明与总字数都是在解释我们自己的排版
  assert.match(home, /<tr class="onepage-row">[\s\S]*?<span class="kw">共 1 节<\/span><\/td>/)
  assert.ok(!home.includes('每节一张 A4'), '排版说明不该出现在页面上')
  assert.ok(!/class="onepage-row">[\s\S]{0,300}?共 \d+ 字/.test(home), '一页纸那一行不再显示总字数')
})

test('the site carries AI-readable docs: /llms.txt and one page per docs/public/*.md', () => {
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  const docs = [{
    pathName: 'mcp',
    title: '笔记 MCP：让 AI 直接读这个站点的笔记',
    description: '本站是北大法学课程笔记',
    markdown: '# 笔记 MCP\n\n本站是北大法学课程笔记。\n\n## 工具\n\n| 工具 | 用途 |\n| --- | --- |\n| list_courses | 有哪些课 |'
  }]
  const site = writeSite({
    records: [record({ markdown: NOTE, brief: { briefing: 'x'.repeat(80), keyPoints: ['a'], theme: '共犯成立的条件', keywords: ['共同故意', '共犯'] } })],
    outputDir: dir4,
    siteOrigin: 'https://course.law-tech.dev',
    docs
  })
  assert.ok(site.written.includes('mcp/index.html'), '文档页要写出来')
  assert.ok(site.written.includes('mcp.md'), '原文也要有一份，AI 直接取更省事')

  const page = fs.readFileSync(path.join(dir4, 'mcp/index.html'), 'utf8')
  assert.match(page, /笔记 MCP/)
  assert.match(page, /本页目录/, '文档页带目录')
  assert.match(page, /<table>/, '工具表要渲染成表格')

  const raw = fs.readFileSync(path.join(dir4, 'mcp.md'), 'utf8')
  assert.match(raw, /^# 笔记 MCP/m)

  const llms = fs.readFileSync(path.join(dir4, 'llms.txt'), 'utf8')
  assert.match(llms, /^# 课程笔记 · course\.law-tech\.dev/m)
  assert.match(llms, /## 机器可读入口/)
  assert.match(llms, /\[笔记 MCP：让 AI 直接读这个站点的笔记\]\(https:\/\/course\.law-tech\.dev\/mcp\.md\)/)
  assert.match(llms, /\[笔记索引（JSON）\]\(https:\/\/course\.law-tech\.dev\/api\/notes\)/)
  // 课程与课次清单要带主题与关键词，AI 只看这份就能判断要不要深入
  assert.match(llms, /- 刑法分论（1 讲）/)
  assert.match(llms, /主题 — 共犯成立的条件/)
  assert.match(llms, /关键词 — 共同故意、共犯/)
})

test('a corrupt index is reported rather than silently treated as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  fs.writeFileSync(path.join(dir, 'notes.json'), '{ broken')
  assert.throws(() => readSiteIndex(dir), /站点索引损坏/)
  assert.deepEqual(readSiteIndex(path.join(dir, 'nope')).notes, [], '索引不存在时视为空站')
})


test('index entries jump to the section where the term actually appears', () => {
  const note = record({
    markdown: [
      '# 第10-12节 共犯与罪数',
      '',
      '## 课程概览',
      '',
      '引入。',
      '',
      '## 一、共犯的成立条件',
      '',
      '共同故意是共犯成立的主观要件。',
      '',
      '## 二、法条依据',
      '',
      '《刑法》第二十五条对共同犯罪作了规定。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 共同故意',
      'META: CONCEPT: 只在元数据里出现',
      'META: PROVISION: 刑法第25条',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  assert.equal(note.anchors.concepts['共同故意'], '一-共犯的成立条件')
  assert.equal(note.anchors.statutes['刑法第25条'], '二-法条依据', '正文写"第二十五条"、元数据写"第25条"，两种写法要对上')
  assert.equal('只在元数据里出现' in note.anchors.concepts, false, '元数据块不是正文，锚点不能指到文末')

  // 笔记正文里本来就有"知识地图"这类折叠块：不能因为它出现在前面就把后面全切掉
  const withEarlyFold = record({
    markdown: [
      '# 第10-12节 共犯与罪数',
      '',
      '<details><summary>知识地图</summary>',
      '共犯与罪数的关系图',
      '</details>',
      '',
      '## 一、共犯的成立条件',
      '',
      '共同故意是共犯成立的主观要件。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 共同故意',
      '</code></pre>',
      '</details>'
    ].join('\n')
  })
  assert.equal(withEarlyFold.anchors.concepts['共同故意'], '一-共犯的成立条件', '早期折叠块不能截断正文')

  const html = renderTermIndexPage({ title: '概念索引', kind: 'concepts', notes: [note] })
  // 点进去要带 ?mark=：笔记页会把该术语在正文里标出来，并滚到那一节
  assert.match(html, /href="\/notes\/刑法分论\/第10-12节-共犯与罪数\.html\?mark=%E5%85%B1%E5%90%8C%E6%95%85%E6%84%8F#一-共犯的成立条件"/)
  assert.match(html, /id="filter-rail"/, '左侧按课程过滤')
  assert.match(html, /class="term-course" data-course="刑法分论"/, '按课程切分')
  assert.match(html, /<div class="term-group">/, '课程内再按课次切分')
  assert.match(html, /class="chip/, '每条术语只是一个可点的词')
  // 索引页的内容不做折叠，一屏看到底。页面上唯一的折叠是顶栏那个「阅读设置」下拉
  const folds = (html.match(/<details[^>]*>/g) || []).filter(tag => !/id="prefmenu"/.test(tag))
  assert.equal(folds.length, 0, '索引页不做折叠，一屏看到底')
  assert.ok(!/篇笔记|已索引|发布过/.test(html), '页面上不写解释站点自身的话')
})

test('the home page lays every course out as a horizontal strip of lessons', () => {
  const html = renderIndexPage([
    record({ lessonTitle: '第1-2节', firstPublishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', firstPublishedAt: '2026-09-25T00:00:00.000Z' })
  ])
  assert.match(html, /<section class="band" data-course="刑法分论">/)
  assert.match(html, /<table class="lesson-table">/)
  assert.match(html, /<th>课次<\/th><th>关键词<\/th>/, '表格第一列课次、第二列关键词')
  assert.match(html, /<td class="lesson-title"><a href="notes\/刑法分论\/第10-12节-共犯与罪数\.html">/)
  assert.ok(!html.includes('class="card"'), '大卡片换成了表格')
  assert.ok(!html.includes('个概念'), '卡片上那串"几个概念几条法条"不再显示')
  assert.ok(!html.includes('共 3 篇'), '顶部那行统计不需要')
})

test('every page inline script parses — a syntax error means a blank page', () => {
  const pages = {
    笔记页: renderNotePage(record({ markdown: NOTE }), { siteOrigin: '', courseLessons: [] }),
    首页: renderIndexPage([record()]),
    概念索引: renderTermIndexPage({
      title: '概念索引',
      kind: 'concepts',
      notes: [record({
        markdown: [NOTE, '', '<details><summary>元数据</summary>', '<pre><code>', 'META: CONCEPT: 共同故意', '</code></pre>', '</details>'].join('\n')
      })]
    }),
    知识地图: renderKnowledgeMapPage({ notes: [record({ markdown: NOTE })] })
  }
  for (const [name, html] of Object.entries(pages)) {
    const scripts = []
    let at = 0
    for (;;) {
      const start = html.indexOf('<script', at)
      if (start < 0) break
      const open = html.indexOf('>', start) + 1
      const tag = html.slice(start, open)
      const end = html.indexOf('</script>', open)
      // 数据块（application/json 之类）不是脚本，别拿去当 JS 解析
      if (!/type="(?!module|text\/javascript)/.test(tag)) scripts.push(html.slice(open, end))
      at = end + 9
    }
    assert.ok(scripts.length >= 1, name + ' 应该至少有一段内联脚本')
    scripts.forEach((script, index) => {
      assert.doesNotThrow(() => new Function(script), name + ' 的第 ' + (index + 1) + ' 段脚本语法错误（整页会白屏）')
    })
  }
})

test('the pages carry no broken inline script', () => {
  const html = renderTermIndexPage({
    title: '概念索引',
    kind: 'concepts',
    notes: [record({
      markdown: [
        '# 第10-12节 共犯与罪数',
        '',
        '## 一、共犯',
        '',
        '共同故意。',
        '',
        '<details><summary>元数据</summary>',
        '<pre><code>META: CONCEPT: 共同故意</code></pre>',
        '</details>'
      ].join('\n')
    })]
  })
  const scripts = html.split('<script>').slice(1).map(part => part.split('</script>')[0])
  assert.ok(scripts.length >= 1, '过滤脚本应当内联在页面里')
  for (const script of scripts) new Function(script)
})

test('重新发布一节旧课：课程顺序、上一讲下一讲、最新一课都不变', () => {
  // 用户报的正是这件事：旧课改个错字重新发布（updatedAt 变新），它就窜到首页最上面，
  // 变成"最新一课"。排序与前后课现在只看 lessonDate，与发布时间无关。
  const earlier = record({
    lessonTitle: '2026-09-07第5-6节',
    firstPublishedAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z' // 刚重新发布过
  })
  const later = record({
    lessonTitle: '2026-09-20第2-4节',
    firstPublishedAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z'
  })
  assert.equal(earlier.lessonDate, '2026-09-07')
  assert.equal(later.lessonDate, '2026-09-20')

  const home = renderIndexPage([earlier, later])
  assert.ok(home.indexOf('2026-09-20第2-4节') < home.indexOf('2026-09-07第5-6节'),
    '最新一课是最近上过的那节，不是最近重新发布的那节')
  assert.match(home, /<td class="lesson-date">2026-09-07<\/td>/, '首页日期列写的是上课日期')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  writeSite({ records: [earlier, later], outputDir: dir })
  const older = fs.readFileSync(path.join(dir, 'notes/刑法分论/2026-09-07第5-6节.html'), 'utf8')
  const newer = fs.readFileSync(path.join(dir, 'notes/刑法分论/2026-09-20第2-4节.html'), 'utf8')
  assert.match(older, /<span>下一讲<\/span><a href="notes\/刑法分论\/2026-09-20第2-4节\.html">/, '重新发布不改下一讲')
  assert.match(newer, /<span>上一讲<\/span><a href="notes\/刑法分论\/2026-09-07第5-6节\.html">/, '上一讲同样按上课日期定')
  assert.ok(!/<span>上一讲<\/span>/.test(older), '第一节没有上一讲')
  // 左栏课次表按上课日期从早到晚
  const rail = newer.match(/<ol class="lessons">([\s\S]*?)<\/ol>/)[1]
  assert.ok(rail.indexOf('2026-09-07第5-6节') < rail.indexOf('2026-09-20第2-4节'))
})

test('两门课同一天同名课次各写一份 Markdown，不再互相覆盖', () => {
  // 旧写法只取 slug 最后一段，两门课同一天同一课次名的正文会互相顶掉
  const shangfa = record({ courseName: '商法概论', lessonTitle: '2026-10-12第1-2节', markdown: '# 商法概论第一节\n\n公司的特征。' })
  const minsu = record({ courseName: '民事诉讼法', lessonTitle: '2026-10-12第1-2节', markdown: '# 民事诉讼法第一节\n\n管辖的确定。' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  const site = writeSite({ records: [shangfa, minsu], outputDir: dir, siteOrigin: 'https://course.law-tech.dev' })

  assert.equal(markdownPath(shangfa), 'md/商法概论/2026-10-12第1-2节.md')
  assert.equal(markdownPath(minsu), 'md/民事诉讼法/2026-10-12第1-2节.md')
  for (const relative of [markdownPath(shangfa), markdownPath(minsu)]) {
    assert.ok(site.written.includes(relative), relative + ' 要写出来')
  }
  assert.match(fs.readFileSync(path.join(dir, markdownPath(shangfa)), 'utf8'), /公司的特征/)
  assert.match(fs.readFileSync(path.join(dir, markdownPath(minsu)), 'utf8'), /管辖的确定/)

  // 笔记页的下载链接、llms.txt、MCP 的请求路径三者同源
  const page = fs.readFileSync(path.join(dir, 'notes/商法概论/2026-10-12第1-2节.html'), 'utf8')
  const href = page.match(/<a href="([^"]+)" download title="下载 Markdown"/)[1]
  assert.equal(decodeURIComponent(href), '/' + markdownPath(shangfa))
  const llms = fs.readFileSync(path.join(dir, 'llms.txt'), 'utf8')
  assert.match(llms, /\[Markdown 全文\]\(https:\/\/course\.law-tech\.dev\/md\/商法概论\/2026-10-12第1-2节\.md\)/)
  assert.match(llms, /\[Markdown 全文\]\(https:\/\/course\.law-tech\.dev\/md\/民事诉讼法\/2026-10-12第1-2节\.md\)/)
  assert.match(llms, /md\/<课程>\/<课次>\.md/)
})

test('RSS 的 pubDate 与条目顺序用首次进站时间，重新发布旧课不会把它顶回顶部', () => {
  const earlier = record({
    lessonTitle: '2026-09-07第5-6节',
    firstPublishedAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z'
  })
  const later = record({ lessonTitle: '2026-09-20第2-4节', firstPublishedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' })
  const feed = renderFeed([earlier, later], { siteOrigin: 'https://course.law-tech.dev' })
  assert.ok(feed.indexOf('2026-09-20第2-4节') < feed.indexOf('2026-09-07第5-6节'), '订阅器里新的在前')
  assert.ok(feed.includes('<pubDate>' + new Date('2026-09-08T00:00:00.000Z').toUTCString() + '</pubDate>'),
    'pubDate 是首次进站时间，不是最近一次重新发布时间')
  assert.ok(!feed.includes(new Date('2026-10-01T00:00:00.000Z').toUTCString()), '重新发布的时间不进 pubDate')
})

test('老发布库只有 publishedAt：读进来时迁移成三个字段，且只迁移一次', () => {
  const legacy = {
    slug: 'notes/商法概论/2026-09-20第2-4节',
    courseName: '商法概论',
    lessonTitle: '2026-09-20第2-4节',
    publishedAt: '2026-10-01T00:00:00.000Z',
    markdown: '# 2026-09-20第2-4节\n\n## 课程概览\n\n正文。'
  }
  const migrated = refreshRecord(legacy)
  assert.equal(migrated.lessonDate, '2026-09-20', '课次日期从标题里迁移出来')
  assert.equal(migrated.lessonDateSource, 'title')
  assert.equal(migrated.firstPublishedAt, '2026-10-01T00:00:00.000Z')
  assert.equal(migrated.updatedAt, '2026-10-01T00:00:00.000Z')
  assert.equal('publishedAt' in migrated, false, 'publishedAt 不再留在记录里')
  // 幂等：再次读取不会把已有的 lessonDate 重算成别的东西
  assert.equal(refreshRecord(migrated).lessonDate, '2026-09-20')
  assert.equal(refreshRecord(migrated).lessonDateSource, 'title')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  writeSite({ records: [legacy], outputDir: dir })
  const indexed = readSiteIndex(dir).notes[0]
  assert.equal(indexed.lessonDate, '2026-09-20')
  assert.equal(indexed.firstPublishedAt, '2026-10-01T00:00:00.000Z')
  const home = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.match(home, /<td class="lesson-date">2026-09-20<\/td>/, '老库重建后首页日期列也是上课日期')
})

test('笔记页 meta 写课次日期；有了一页纸之后笔记页下载的仍然是整篇笔记', () => {
  const built = record({
    markdown: NOTE,
    onepage: { title: '共犯成立的条件', markdown: '## 一、成立条件\n\n- 共同故意', chars: 12 }
  })
  const note = renderNotePage(built, { siteOrigin: '' })
  assert.match(note, /2026-09-25 课次/, 'meta 行写的是课次日期')
  assert.ok(!/\d{4}-\d{2}-\d{2} 发布/.test(note), '不再出现"哪天发布的"')
  const noteHref = note.match(/<a href="([^"]+)" download title="下载 Markdown"/)[1]
  assert.equal(decodeURIComponent(noteHref), '/' + markdownPath(built), '笔记页下载的是整篇笔记')
  assert.ok(!noteHref.includes('-一页纸'))

  const onepagePage = renderOnepagePageHtml(built, { siteOrigin: '' })
  const onepageHref = onepagePage.match(/<a href="([^"]+)" download title="下载 Markdown"/)[1]
  assert.equal(decodeURIComponent(onepageHref), '/' + onePageMarkdownPath(built), '一页纸页面下载的是一页纸')
})
