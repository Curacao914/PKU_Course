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
  renderFeed,
  renderNotePage,
  renderSearchPage,
  renderTermIndexPage,
  writeSite
} from './site.mjs'

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
  publishedAt: '2026-09-25T00:00:00.000Z',
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
  assert.equal(built.publishedAt, '2026-09-25T00:00:00.000Z')
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
  // 字号、深浅、位置记忆都只依赖浏览器本地存储——个人笔记站不该为这三件小事引入登录
  const html = renderNotePage(record({ markdown: NOTE }))
  assert.match(html, /data-read="font-up"/)
  assert.match(html, /data-read="font-down"/)
  assert.match(html, /data-read="theme"/)
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
  assert.match(html, /setActive\(current\.id\)[\s\S]{0,200}followActive|followActive\(next\[0\]\)/, '高亮与滚动要一起发生')
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
  // 划词批注：下划线 / 高亮 / 复制，快捷键 Cmd-U 与 Cmd-H（加粗不做）
  assert.match(html, /id="selbar"/)
  assert.match(html, /data-annot="underline"/)
  assert.match(html, /data-annot="mark"/)
  assert.match(html, /key === 'u'/)
  assert.match(html, /key === 'h'/)
  assert.match(html, /course\.annots:/, '批注按页面路径存本地')
  assert.match(html, /drawLine/, '下划线要有从左到右画出来的动画')
  assert.match(html, /anchor-flash/, '锚点高亮')
})

test('the index groups by course and lists newest first', () => {
  const html = renderIndexPage([
    record({ lessonTitle: '第1-2节', publishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', publishedAt: '2026-09-25T00:00:00.000Z' }),
    record({ courseName: '国际法学', lessonTitle: '第3-4节', publishedAt: '2026-09-10T00:00:00.000Z' })
  ])
  assert.match(html, /<h2>刑法分论 · 2 讲<\/h2>/, '课程分组标题带课次数')
  assert.match(html, /<h2>国际法学 · 1 讲<\/h2>/)
  assert.ok(html.indexOf('第10-12节 共犯与罪数') < html.indexOf('第1-2节'), '同一课程内新的在前')
  assert.match(html, /共 3 篇/)

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
    // 正文全文就不必再内嵌进 HTML（那会让每页翻一倍）
    'md/第10-12节-共犯与罪数.md',
    'concepts/index.html',
    'statutes/index.html',
    'cases/index.html',
    'search/index.html',
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

  // 全量重写：删除的笔记不会残留在索引里
  const second = writeSite({ records: [], outputDir: dir })
  assert.equal(second.count, 0)
  assert.equal(readSiteIndex(dir).count, 0)
})

test('the feed lists the newest notes first and points at their pages', () => {
  const feed = renderFeed([
    record({ lessonTitle: '第1-2节', publishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', publishedAt: '2026-09-25T00:00:00.000Z' })
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
  assert.match(search, /fetch\('\/api\/notes'\)/, '搜索是纯客户端的：直接读站点索引')
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
  assert.match(concepts, /href="\/notes\/刑法分论\/第10-12节-共犯与罪数\.html#一-共犯的成立条件"/, '索引锚点也要重算')
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
  assert.match(html, /href="\/notes\/刑法分论\/第10-12节-共犯与罪数\.html#一-共犯的成立条件"/)
  assert.match(html, /id="filter-rail"/, '左侧按课程过滤')
  assert.match(html, /data-course="刑法分论"/)
  assert.ok(!html.includes('<details'), '索引页不做折叠，一屏看到底')
  assert.ok(!/篇笔记|已索引|发布过/.test(html), '页面上不写解释站点自身的话')
})

test('the home page lays every course out as a horizontal strip of lessons', () => {
  const html = renderIndexPage([
    record({ lessonTitle: '第1-2节', publishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', publishedAt: '2026-09-25T00:00:00.000Z' })
  ])
  assert.match(html, /<section class="band">/)
  assert.match(html, /<div class="strip">/)
  assert.match(html, /\.strip \{ display: grid; grid-auto-flow: column;/, '课次横向排开，而不是一列到底')
  assert.ok(!html.includes('course-group'), '纵向一列到底的旧版式已经换掉')
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

