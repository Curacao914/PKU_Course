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

test('a corrupt index is reported rather than silently treated as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  fs.writeFileSync(path.join(dir, 'notes.json'), '{ broken')
  assert.throws(() => readSiteIndex(dir), /站点索引损坏/)
  assert.deepEqual(readSiteIndex(path.join(dir, 'nope')).notes, [], '索引不存在时视为空站')
})
