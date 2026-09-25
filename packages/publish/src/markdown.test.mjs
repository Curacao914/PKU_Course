import assert from 'node:assert/strict'
import test from 'node:test'

import { escapeHtml, extractHeadings, renderInline, renderMarkdown, slugify, summarizeMarkdown } from './markdown.mjs'

test('all HTML in the source is escaped, so model output cannot inject markup', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n正常段落')
  assert.ok(!html.includes('<script>'), '不得输出 script 标签')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /<p>正常段落<\/p>/)
  assert.equal(escapeHtml('a & b < c "d" \'e\''), 'a &amp; b &lt; c &quot;d&quot; &#39;e&#39;')
})

test('links only survive with a safe scheme', () => {
  assert.match(renderInline('[官网](https://example.com/x)'), /<a href="https:\/\/example.com\/x"/)
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,xx', 'vbscript:x']) {
    const html = renderInline(`[点我](${bad})`)
    assert.ok(!html.includes('<a '), `${bad} 不应生成链接`)
    assert.ok(!/javascript:|data:|vbscript:/i.test(html), `${bad} 不应出现在输出里`)
  }
})

test('headings, rules and paragraphs', () => {
  const html = renderMarkdown('# 一级\n\n## 二级\n\n正文一\n正文二\n\n***\n')
  assert.match(html, /<h1 id="一级">一级<\/h1>/, '标题必须带 id：目录锚点与滚动高亮都靠它')
  assert.match(html, /<h2 id="二级">二级<\/h2>/)
  assert.match(html, /<p>正文一\n正文二<\/p>/, '连续行合并为一个段落')
  assert.match(html, /<hr>/)
})

test('heading ids match the toc anchors', () => {
  // 目录里的 #锚点 必须真的存在，否则点了不动、也无法高亮当前小节
  const markdown = '## 课程概览\n\n内容\n\n### 一、共犯的成立条件\n\n内容'
  const html = renderMarkdown(markdown)
  for (const heading of extractHeadings(markdown)) {
    assert.match(html, new RegExp(`id="${heading.id}"`), `\`${heading.text}\` 的锚点应当存在`)
  }
})

test('blockquotes keep their inner structure', () => {
  const html = renderMarkdown('> **自测**（合上笔记，能回答吗？）\n> 1. 第一个问题\n> 2. 第二个问题')
  assert.match(html, /^<blockquote>/)
  assert.match(html, /<strong>自测<\/strong>/)
  assert.match(html, /<ol><li>第一个问题<\/li><li>第二个问题<\/li><\/ol>/)
})

test('task lists and ordinary lists', () => {
  const html = renderMarkdown('- [ ] 待办一\n- [x] 已完成\n\n- 普通项\n- 另一项')
  assert.match(html, /<li class="task"><input type="checkbox" disabled> 待办一<\/li>/)
  assert.match(html, /<li class="task"><input type="checkbox" disabled checked> 已完成<\/li>/)
  assert.match(html, /<ul><li>普通项<\/li><li>另一项<\/li><\/ul>/)
})

test('tables render with alignment and escaped cells', () => {
  const html = renderMarkdown([
    '| 术语 | 原文 | 说明 |',
    '|:-----|:----:|-----:|',
    '| 共犯 | <b>joint</b> | 二人以上 |'
  ].join('\n'))
  assert.match(html, /<table>/)
  assert.match(html, /<th style="text-align:left">术语<\/th>/)
  assert.match(html, /<th style="text-align:center">原文<\/th>/)
  assert.match(html, /<th style="text-align:right">说明<\/th>/)
  assert.match(html, /&lt;b&gt;joint&lt;\/b&gt;/, '单元格里的 HTML 同样要转义')
})

test('fenced code blocks keep their content verbatim', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2\n```')
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2<\/code><\/pre>/)
})

test('the metadata details block is rebuilt and its content escaped', () => {
  const markdown = [
    '正文',
    '',
    '<details><summary>📑 笔记元数据（用于跨课整合）</summary>',
    '<pre><code>',
    'META: CONCEPT: 共犯 <script>',
    '</code></pre>',
    '</details>'
  ].join('\n')
  const html = renderMarkdown(markdown)
  assert.match(html, /<details class="note-meta"><summary>📑 笔记元数据（用于跨课整合）<\/summary>/)
  assert.match(html, /META: CONCEPT: 共犯 &lt;script&gt;/)
  assert.ok(!html.includes('<script>'))
})

test('inline emphasis and code do not interfere', () => {
  const html = renderInline('**粗** 与 *斜* 与 `a*b*c`')
  assert.match(html, /<strong>粗<\/strong>/)
  assert.match(html, /<em>斜<\/em>/)
  assert.match(html, /<code>a\*b\*c<\/code>/, '行内代码里的星号不应被当作强调')
})

test('summarizeMarkdown strips structure down to prose', () => {
  const summary = summarizeMarkdown([
    '# 标题',
    '',
    '> 引用',
    '',
    '- [ ] 待办',
    '',
    '```',
    'code',
    '```',
    '',
    '<details><summary>📑 笔记元数据（用于跨课整合）</summary>',
    'META: CONCEPT: 共犯',
    '</details>',
    '',
    '**正文**内容若干。'
  ].join('\n'))
  assert.ok(!summary.includes('#'), '标题标记应被去掉')
  assert.ok(!summary.includes('META:'), '元数据不应进入摘要')
  assert.ok(!summary.includes('code'), '代码块不应进入摘要')
  assert.match(summary, /正文内容若干/)
  assert.equal(summarizeMarkdown('很长'.repeat(200), 20).length, 21)
})

test('headings and slugs are stable for anchors and urls', () => {
  const headings = extractHeadings('# 不算\n## 一、共犯的成立条件\n### 细目')
  assert.deepEqual(headings.map(h => h.level), [2, 3])
  assert.equal(headings[0].text, '一、共犯的成立条件')
  assert.equal(slugify('一、共犯的成立条件'), '一-共犯的成立条件')
  assert.equal(slugify('  '), 'section')
  assert.equal(slugify('第10-12节 共犯与罪数'), '第10-12节-共犯与罪数')
})
