import assert from 'node:assert/strict'
import test from 'node:test'

import { anchorFromSelection, annotationId, collectText, findAnchor, normalizeAnchor, piecesForRange } from './anchors.mjs'

/**
 * A5：批注锚定。
 *
 * 旧实现只在整篇里 indexOf(text)，同一个词出现两次时第二次的批注会被贴到第一处；
 * 也没有任何上下文校验，正文改版后会把批注贴到无关的句子上。
 * 这一组用例逐条钉住新的四级定位与"找不到就保留"的行为。
 */

const TRICKY = '共同故意与共同行为是共犯成立的两个要件。共同行为要求意思联络。'

test('同一个词出现两次：靠前后文贴回第二次，而不是第一次', () => {
  const first = TRICKY.indexOf('共同行为')
  const second = TRICKY.indexOf('共同行为', first + 1)
  assert.ok(second > first, '这段文本里确实有两处')

  const anchor = anchorFromSelection({
    text: '共同行为',
    prefix: TRICKY.slice(Math.max(0, second - 12), second),
    suffix: TRICKY.slice(second + 4, second + 4 + 12),
    start: second,
    end: second + 4
  })
  const found = findAnchor(TRICKY, anchor)
  assert.equal(found.start, second, '必须贴回第二次（旧实现在这里会贴到第一次）')
  assert.equal(found.strategy, 'context')
  assert.equal(found.reanchored, false)
})

test('正文改版后位置漂移：落在附近也算同一次，但要标出来', () => {
  const shifted = '新增了一段与批注无关的引言。'.repeat(8) + TRICKY
  const anchor = anchorFromSelection({
    text: '意思联络',
    // 记录时的上下文已经不在新正文里了（前缀被改过）
    prefix: '完全不同的一段前缀',
    suffix: '',
    start: 40,
    end: 44
  })
  const found = findAnchor(shifted, anchor)
  assert.ok(found, '仍然要能找到')
  assert.equal(found.strategy, 'unique', '只出现一次时按唯一出现处理')
  assert.equal(shifted.slice(found.start, found.end), '意思联络')
})

test('多处且没有可用上下文：宁可不贴，也不猜', () => {
  const text = '第一处共同行为。第二处共同行为。'
  const anchor = anchorFromSelection({ text: '共同行为', prefix: '对不上的前缀', suffix: '对不上的后缀', start: 0, end: 4 })
  assert.equal(findAnchor(text, anchor), null, '猜错比找不到更糟')
})

test('空白被重排过：归一之后仍能找到，并标记 reanchored', () => {
  // 选中时跨了换行（老正文），重新生成之后这一行被合并成一句——indexOf 直接找不到，
  // 只有把空白归一之后才对得上。这正是"改版之后批注还在"的真实形状。
  const anchor = anchorFromSelection({
    text: '直接效果\n是恢复原状',
    prefix: '合同无效的',
    suffix: '',
    start: 5,
    end: 12
  })
  const reflowed = '合同无效的直接效果是恢复原状。'
  const found = findAnchor(reflowed, anchor)
  assert.ok(found, '空白重排也要找得到')
  assert.equal(found.strategy, 'fuzzy')
  assert.equal(found.reanchored, true, '用了回退策略就必须标出来')
  assert.equal(reflowed.slice(found.start, found.end).replace(/\s+/g, ''), '直接效果是恢复原状')
})

test('跨行内元素的选区：按节点切成若干段包裹（同一 id）', () => {
  // 浏览器里 nodes 就是 TreeWalker 收集到的文本节点；这里直接用字符串数组
  const { text, index } = collectText(['共犯的成立需要', '共同故意', '与', '共同行为', '。'])
  assert.equal(text, '共犯的成立需要共同故意与共同行为。')
  const start = text.indexOf('共同故意')
  const pieces = piecesForRange(index, start, text.length - 1)
  assert.deepEqual(pieces.map(piece => piece.nodeIndex), [1, 2, 3], '第二、三、四个节点上各包一段')
  assert.equal(pieces[0].start, 0)
  assert.equal(pieces[0].end, '共同故意'.length)
  // 每一段拼起来正好是选中的文字
  const joined = pieces.map(piece => ['共犯的成立需要', '共同故意', '与', '共同行为', '。'][piece.nodeIndex].slice(piece.start, piece.end)).join('')
  assert.equal(joined, '共同故意与共同行为')
  assert.deepEqual(piecesForRange(index, 3, 3), [], '空区间不产生片段')
})

test('锚点字段：id 稳定、上下文截断、老记录能升级', () => {
  const id = annotationId('slug')
  assert.match(id, /^a[0-9a-z]+/)
  const anchor = anchorFromSelection({
    text: '甲', prefix: 'x'.repeat(80), suffix: 'y'.repeat(80), sectionId: '二-归因',
    start: 12, end: 13, id, kind: 'mark', revision: 'rev-1'
  })
  assert.equal(anchor.prefix.length, 32, '前缀只留最近的 32 字')
  assert.equal(anchor.suffix.length, 32)
  assert.equal(anchor.sectionId, '二-归因')
  assert.equal(anchor.revision, 'rev-1')
  assert.equal(anchor.id, id)

  // 老记录 {text, before, after} 升级后仍然能定位
  const legacy = normalizeAnchor({ text: '归因', before: '第一步是', after: '，之后' })
  assert.equal(legacy.prefix, '第一步是')
  assert.equal(legacy.suffix, '，之后')
  const text = '国家责任的认定里，第一步是归因，之后才谈赔偿。'
  const found = findAnchor(text, legacy)
  assert.equal(text.slice(found.start, found.end), '归因')
})

test('批注 id：同一条记录里的不同批注不会互相干扰', () => {
  const a = anchorFromSelection({ text: '甲', id: 'x1' })
  const b = anchorFromSelection({ text: '甲', id: 'x2' })
  assert.notEqual(a.id, b.id)
  // 同一段文字的两条批注各自独立：删掉一条不该影响另一条（删除按 id，不按文字）
  const marks = [a, b]
  const kept = marks.filter(mark => mark.id !== 'x1')
  assert.deepEqual(kept.map(mark => mark.id), ['x2'])
})
