import assert from 'node:assert/strict'
import test from 'node:test'

import { checkMarkerPropagation, checkMetadata, checkNoteQuality, checkTables, checkTruncation, findOpenMarkers, formatQualityReport } from './quality.mjs'

/**
 * A8：内容质量检查。
 *
 * 每条检查都对应一种真实会漏出去的错：表格少一列、同一节被拼两遍、正文被截断、
 * 分类漏抽/重复、待核标记没有出处、正文标了"待核"而摘要里像结论一样肯定。
 * 检查只报告不改写，所以每条都必须带证据。
 */

test('表格列数：少一列要指出来是哪一行', () => {
  const markdown = [
    '| 情形 | 处理 | 依据 |',
    '|---|---|---|',
    '| 已满 | 减刑 | 第 78 条 |',
    '| 未满 | 假释 |'
  ].join('\n')
  const found = checkTables(markdown)
  assert.equal(found.length, 1)
  assert.equal(found[0].code, 'table-columns')
  assert.equal(found[0].line, 4)
  assert.match(found[0].message, /2 列，表头是 3 列/)
  assert.equal(checkTables('| a | b |\n|---|---|\n| 1 | 2 |').length, 0)
})

test('截断：半句话、围栏没闭合、details 没闭合', () => {
  assert.equal(checkTruncation('正文到这里就断了，').some(item => item.code === 'truncated-tail'), true)
  assert.equal(checkTruncation('正常结尾。').length, 0)
  assert.equal(checkTruncation(['正文。', '```js', 'var a = 1'].join('\n')).some(item => item.code === 'unbalanced-fence'), true)
  assert.equal(checkTruncation(['正文。', '<details>', 'META'].join('\n')).some(item => item.code === 'unbalanced-details'), true)
})

test('重复标题与重复测验：同一节被拼两遍能被看出来', () => {
  const markdown = ['## 一、减刑', '', '正文。', '', '## 一、减刑', '', '又一遍。', '', '### 思考题', '', '1. 甲', '', '### 思考题', '', '2. 乙'].join('\n')
  const found = checkNoteQuality({ markdown }).findings
  assert.ok(found.some(item => item.code === 'duplicate-heading'))
  assert.ok(found.some(item => item.code === 'duplicate-quiz'))
  assert.ok(found.every(item => item.evidence !== undefined), '每条发现都要带证据')
})

test('分类：桶内重复与"正文有明显法条但桶是空的"', () => {
  const markdown = '依第 78 条、第 79 条、第 81 条处理。'
  const found = checkMetadata(markdown, { statutes: [], cases: [], concepts: ['减刑', '减刑'] })
  assert.ok(found.some(item => item.code === 'duplicate-term' && /减刑/.test(item.message)))
  assert.ok(found.some(item => item.code === 'statutes-missing'))
  assert.equal(checkMetadata(markdown, { statutes: ['第78条'], cases: [], concepts: ['减刑'] }).length, 0)
})

test('待核标记：没出处的标出来，贯通到摘要/一页纸/测验的情况也说清楚', () => {
  const markdown = ['正文。', '待核', '这里转录不清，待核：第 3 段听不清（09-07）。'].join('\n')
  const markers = findOpenMarkers(markdown)
  assert.equal(markers.length, 2)
  assert.equal(markers[0].hasSource, false)
  assert.equal(markers[1].hasSource, true)

  const provenance = checkNoteQuality({ markdown }).findings.filter(item => item.code === 'marker-without-source')
  assert.equal(provenance.length, 1)

  const propagated = checkMarkerPropagation(markdown, { 简报: '本节讲减刑的适用条件。', 一页纸: '', 测验: '1. 减刑的条件是什么？' })
  assert.equal(propagated.length, 1)
  assert.match(propagated[0].message, /简报 \/ 测验/)
  // 产物里同样带了标记就不算漏；本来没有这份产物也不算漏
  assert.equal(checkMarkerPropagation(markdown, { 简报: '（待核：转录不清）', 一页纸: '' }).length, 0)
})

test('报告：先错误后提醒，且空结果也有话说', () => {
  const result = checkNoteQuality({ markdown: '| a | b |\n|---|---|\n| 1 |\n\n这一段话没有写完' })
  assert.ok(result.counts.error >= 2)
  assert.equal(result.findings[0].level, 'error', '错误排在最前')
  const text = formatQualityReport(result)
  assert.match(text, /内容质量检查：/)
  assert.match(text, /\[error\]/)
  assert.equal(formatQualityReport({ findings: [], counts: { error: 0, warn: 0, info: 0 } }), '内容质量检查：没有发现问题。')
})
