import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clip,
  extractHeadings,
  findSection,
  normalizeRecord,
  noteFileName,
  slugify,
  splitSections
} from './records.mjs'

test('slugify 与 publish 保持同一套规则', () => {
  assert.equal(slugify('第一课 国家责任的构成'), '第一课-国家责任的构成')
  assert.equal(slugify('一、归因'), '一-归因')
  assert.equal(slugify('   '), 'section')
  assert.equal(slugify('A/B:C', 'note'), 'a-b-c')
})

test('extractHeadings 抽 1—6 级标题并给出锚点 id', () => {
  const headings = extractHeadings('# 标题\n\n## 一、归因\n\n###### 末级\n')
  assert.deepEqual(headings, [
    { level: 1, text: '标题', id: '标题' },
    { level: 2, text: '一、归因', id: '一-归因' },
    { level: 6, text: '末级', id: '末级' }
  ])
})

test('splitSections 按同级标题切段，子标题留在父段里', () => {
  const markdown = [
    '# 课',
    '## 一、甲',
    '甲正文',
    '### 甲-1',
    '子节正文',
    '## 二、乙',
    '乙正文'
  ].join('\n')
  const sections = splitSections(markdown)
  assert.deepEqual(sections.map(item => item.title), ['课', '一、甲', '甲-1', '二、乙'])
  assert.equal(sections[1].body, '## 一、甲\n甲正文\n### 甲-1\n子节正文')
  assert.equal(sections[3].body, '## 二、乙\n乙正文')
})

test('findSection 按 id、标题、包含三种方式命中，找不到返回 null', () => {
  const markdown = '# 课\n## 一、国家责任的构成要素\n正文甲\n## 二、归因\n正文乙\n'
  assert.equal(findSection(markdown, '二-归因').title, '二、归因')
  assert.equal(findSection(markdown, '二、归因').title, '二、归因')
  assert.equal(findSection(markdown, '归因').title, '二、归因')
  assert.equal(findSection(markdown, '不存在的节'), null)
  assert.equal(findSection(markdown, '  '), null)
})

test('normalizeRecord 补齐缺省字段、去重关键词、保留可选正文', () => {
  const record = normalizeRecord({
    slug: 'notes/刑法总论/第一课',
    courseName: '刑法总论',
    lessonTitle: '第一课',
    keywords: ['罪刑法定', '罪刑法定', ''],
    metadata: { concepts: ['罪刑法定'] },
    headings: [{ level: 2, text: '一、法律主义' }],
    markdown: '正文'
  })
  assert.deepEqual(record.keywords, ['罪刑法定'])
  assert.deepEqual(record.metadata.concepts, ['罪刑法定'])
  assert.equal(record.headings[0].id, '一-法律主义')
  assert.equal(record.markdown, '正文')
  assert.equal(record.theme, '')
  assert.equal(record.brief, null)
  assert.equal(record.readMinutes, 0)
  assert.equal('markdown' in normalizeRecord({ slug: 'x' }), false)
})

test('noteFileName 取 slug 最后一段，clip 按字数截断', () => {
  assert.equal(noteFileName('notes/国际法学/第一课-国家责任的构成'), '第一课-国家责任的构成')
  assert.equal(noteFileName(''), 'note')
  assert.equal(clip('一二三四五', 3), '一二三…')
  assert.equal(clip(' 一  二 ', 10), '一 二')
})
