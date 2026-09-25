import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildNoteRecord,
  noteSlug,
  readSiteIndex,
  renderIndexPage,
  renderNotePage,
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
  assert.match(html, /<nav class="toc">/)
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

test('the index groups by course and lists newest first', () => {
  const html = renderIndexPage([
    record({ lessonTitle: '第1-2节', publishedAt: '2026-09-01T00:00:00.000Z' }),
    record({ lessonTitle: '第10-12节 共犯与罪数', publishedAt: '2026-09-25T00:00:00.000Z' }),
    record({ courseName: '国际法学', lessonTitle: '第3-4节', publishedAt: '2026-09-10T00:00:00.000Z' })
  ])
  assert.match(html, /<h2>刑法分论<\/h2>/)
  assert.match(html, /<h2>国际法学<\/h2>/)
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
    'notes/刑法分论/第10-12节-共犯与罪数.html'
  ].sort())
  assert.ok(fs.existsSync(path.join(dir, 'index.html')))
  assert.ok(fs.existsSync(path.join(dir, 'notes/刑法分论/第10-12节-共犯与罪数.html')))

  const index = readSiteIndex(dir)
  assert.equal(index.count, 1)
  assert.equal(index.notes[0].slug, 'notes/刑法分论/第10-12节-共犯与罪数')
  assert.equal('markdown' in index.notes[0], false, '索引里不带正文，避免索引文件过大')

  // 全量重写：删除的笔记不会残留在索引里
  const second = writeSite({ records: [], outputDir: dir })
  assert.equal(second.count, 0)
  assert.equal(readSiteIndex(dir).count, 0)
})

test('a corrupt index is reported rather than silently treated as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-'))
  fs.writeFileSync(path.join(dir, 'notes.json'), '{ broken')
  assert.throws(() => readSiteIndex(dir), /站点索引损坏/)
  assert.deepEqual(readSiteIndex(path.join(dir, 'nope')).notes, [], '索引不存在时视为空站')
})
