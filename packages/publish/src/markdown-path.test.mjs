import assert from 'node:assert/strict'
import test from 'node:test'

import {
  markdownPath,
  markdownSegments,
  markdownUrl,
  onePageMarkdownPath,
  onePageMarkdownUrl
} from './markdown-path.mjs'

const shangfa = { slug: 'notes/商法概论/2026-10-12第1-2节' }
const minshi = { slug: 'notes/民事诉讼法/2026-10-12第1-2节' }

test('Markdown 的路径是 课程/课次，不再是只有课次的那一段', () => {
  assert.deepEqual(markdownSegments(shangfa), ['商法概论', '2026-10-12第1-2节'])
  assert.equal(markdownPath(shangfa), 'md/商法概论/2026-10-12第1-2节.md')
  assert.equal(onePageMarkdownPath(shangfa), 'md/商法概论/2026-10-12第1-2节-一页纸.md')
  // 字符串 slug 与记录对象等价（MCP 那边只有 slug）
  assert.equal(markdownPath('notes/商法概论/2026-10-12第1-2节'), 'md/商法概论/2026-10-12第1-2节.md')
  // 没有 notes 前缀时照旧（老数据/外部调用）
  assert.equal(markdownPath('商法概论/2026-10-12第1-2节'), 'md/商法概论/2026-10-12第1-2节.md')
  assert.equal(markdownPath(''), 'md/note.md')
  // 目录穿越段被换掉：这条路径也从外部输入（MCP 的 slug）拼出来，不许跳出站点根
  assert.equal(markdownPath({ slug: 'notes/../../etc/passwd' }), 'md/note/note/etc/passwd.md')
})

test('两门课同一天同名课次拿到不同的路径', () => {
  assert.notEqual(markdownPath(shangfa), markdownPath(minshi))
  assert.equal(markdownPath(minshi), 'md/民事诉讼法/2026-10-12第1-2节.md')
})

test('链接与落盘路径同源，只是逐段做了百分号编码', () => {
  assert.equal(markdownUrl(shangfa), '/md/%E5%95%86%E6%B3%95%E6%A6%82%E8%AE%BA/2026-10-12%E7%AC%AC1-2%E8%8A%82.md')
  assert.equal(decodeURIComponent(markdownUrl(shangfa)), '/' + markdownPath(shangfa))
  assert.equal(decodeURIComponent(onePageMarkdownUrl(shangfa)), '/' + onePageMarkdownPath(shangfa))
  assert.match(onePageMarkdownUrl(shangfa), /-%E4%B8%80%E9%A1%B5%E7%BA%B8\.md$/)
})
