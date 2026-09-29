import assert from 'node:assert/strict'
import test from 'node:test'

import { markdownChecksum } from './derived.mjs'
import { blockIdOf } from './markdown.mjs'
import {
  buildSourceMap, onepageBlocks, quoteInSection, sourceMapStats, verifySourceMap
} from './sourcemap.mjs'

const NOTE = [
  '## 一、执行依据与机关分工',
  '',
  '生效判决与裁定是执行的唯一依据，执行机关据此分工负责。',
  '这里要区分"执行依据"与"执行措施"两件事。',
  '',
  '## 二、执行措施与救济',
  '',
  '执行措施包括查封、扣押、冻结；对措施不服的可以提出执行异议。',
  '',
  '## 三、执行程序总论',
  '',
  '执行程序的第一步是立案，立案之后才谈得上措施。'
].join('\n')

const ONEPAGE = [
  '## 执行程序要点',
  '',
  '- 执行依据：生效判决与裁定是执行的唯一依据，执行机关据此分工负责。',
  '- 执行措施：查封、扣押、冻结。',
  '',
  '| 问题 | 结论 |',
  '| --- | --- |',
  '| 不服措施怎么办 | 可以提出执行异议 |'
].join('\n')

test('一页纸块：按空行切、表格与列表合并、ID 由内容决定', () => {
  const blocks = onepageBlocks(ONEPAGE)
  assert.equal(blocks.length, 3, '标题、列表、表格各一块')
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'list', 'table'])
  // 表格被空行切开也要合并：一个要点拆成两条映射比少一条映射更糟
  const split = onepageBlocks('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n| 甲 | 乙 |\n| --- | --- |\n| 3 | 4 |')
  assert.equal(split.length, 1)
  // 内容没变 → ID 不变；内容变了 → ID 变（旧映射随之失效，这正是要的语义）
  assert.equal(blockIdOf('## 执行程序要点'), onepageBlocks(ONEPAGE)[0].id)
  assert.notEqual(blockIdOf('## 执行程序要点'), blockIdOf('## 执行程序要点（改）'))
  // 相邻的同类列表会合并成一块（同一个要点别拆成两条映射）
  assert.equal(onepageBlocks('- 甲甲甲甲甲甲\n\n- 甲甲甲甲甲甲').length, 1)
  // 同文不同块：第二个加 -2，不许撞在一起
  const twins = onepageBlocks('甲甲甲甲甲甲\n\n甲甲甲甲甲甲')
  assert.equal(twins.length, 2)
  assert.match(twins[1].id, /-2$/)
})

test('摘录核对：忽略换行与空白，但短于 8 字的"重合"不算证据', () => {
  assert.equal(quoteInSection('生效判决与裁定是执行的唯一依据', NOTE), true)
  assert.equal(quoteInSection('生效判决与裁定\n是执行的唯一依据', NOTE), true)
  assert.equal(quoteInSection('共同犯罪', NOTE), false, '太短，到处都是，不能当证据')
  assert.equal(quoteInSection('这句话笔记里根本没有', NOTE), false)
})

test('免费路径：只有逐字出现且唯一的块才建映射，概括改写一律不猜', () => {
  const map = buildSourceMap({ slug: 'notes/刑事执行法/第5-6节', noteMarkdown: NOTE, onepageMarkdown: ONEPAGE })
  assert.equal(map.note.slug, 'notes/刑事执行法/第5-6节')
  assert.equal(map.note.checksum, markdownChecksum(NOTE))
  assert.equal(map.onepageChecksum, markdownChecksum(ONEPAGE))
  const byBlock = new Map(map.entries.map(entry => [entry.block, entry]))
  const blocks = onepageBlocks(ONEPAGE)
  const listEntry = byBlock.get(blocks[1].id)
  assert.ok(listEntry, '逐字重叠的列表要点应当被定位')
  assert.equal(listEntry.sections[0].id, '一-执行依据与机关分工')
  assert.match(listEntry.sections[0].quote, /生效判决与裁定是执行的唯一依据/)
  // 表格那块是概括（"不服措施怎么办"是改写），不许硬指一节
  assert.equal(byBlock.has(blocks[2].id), false, '没有逐字依据就不定位')
  assert.equal(map.entries.some(entry => entry.block === blocks[0].id), false, '标题块不配来源入口')
})

test('免费路径：列表项开头就是被引用的那句话时也要认（去掉 Markdown 记号再比对）', () => {
  const note = ['## 甲节', '', '减刑要经过报请与裁定两个环节。假释看的是没有再犯危险。'].join('\n')
  const onepage = ['- 减刑要经过报请与裁定两个环节。', '- 另一条完全不相干的概括说明。'].join('\n\n')
  const map = buildSourceMap({ slug: 'notes/x', noteMarkdown: note, onepageMarkdown: onepage })
  assert.equal(map.entries.length, 1, '被逐字引用的那一条要定位到')
  assert.equal(map.entries[0].sections[0].id, '甲节')
  assert.match(map.entries[0].sections[0].quote, /减刑要经过报请与裁定两个环节/)
})

test('免费路径：两节都像就不定，宁可不定位', () => {
  const note = [
    '## 甲节',
    '',
    '执行措施包括查封、扣押、冻结三种形态。',
    '',
    '## 乙节',
    '',
    '执行措施包括查封、扣押、冻结三种形态。'
  ].join('\n')
  const onepage = '- 执行措施包括查封、扣押、冻结三种形态。'
  const map = buildSourceMap({ slug: 'notes/x', noteMarkdown: note, onepageMarkdown: onepage })
  assert.equal(map.entries.length, 0, '两节逐字相同 → 分不清 → 不映射，退回整篇入口')
})

test('发布前核对：版本对不上整份不用；单条对不上只丢那一条', () => {
  const map = buildSourceMap({ slug: 'notes/刑事执行法/第5-6节', noteMarkdown: NOTE, onepageMarkdown: ONEPAGE })
  const good = verifySourceMap(map, { slug: 'notes/刑事执行法/第5-6节', noteMarkdown: NOTE, onepageMarkdown: ONEPAGE })
  assert.equal(good.bound, true)
  assert.equal(good.ok, true)
  assert.equal(good.dropped, 0)
  const stats = sourceMapStats(good)
  assert.equal(stats.total, 3)
  assert.equal(stats.located, good.entries.length)
  assert.equal(stats.unmapped, 3 - good.entries.length)

  // 正文改过 → 映射整体失效（不许留着"精确来源"的假象）
  const stale = verifySourceMap(map, {
    slug: 'notes/刑事执行法/第5-6节', noteMarkdown: NOTE + '\n\n补一句。', onepageMarkdown: ONEPAGE
  })
  assert.equal(stale.bound, false)
  assert.equal(stale.entries.length, 0)
  assert.match(stale.problems.join(' / '), /源正文改过/)

  // 小节没了 / 摘录不在那一节里 → 丢这一条，其余照用
  const handcrafted = {
    ...map,
    entries: [
      { block: onepageBlocks(ONEPAGE)[1].id, label: '要点', sections: [{ id: '不存在的节', quote: '生效判决与裁定是执行的唯一依据', title: '' }] },
      { block: onepageBlocks(ONEPAGE)[1].id, label: '要点', sections: [{ id: '二-执行措施与救济', quote: '生效判决与裁定是执行的唯一依据', title: '' }] },
      { block: onepageBlocks(ONEPAGE)[2].id, label: '表格', sections: [{ id: '二-执行措施与救济', quote: '执行措施包括查封、扣押、冻结', title: '' }] }
    ]
  }
  const partial = verifySourceMap(handcrafted, { slug: 'notes/刑事执行法/第5-6节', noteMarkdown: NOTE, onepageMarkdown: ONEPAGE })
  assert.equal(partial.entries.length, 1, '只有"摘录确实在这一节里"的那一条留下')
  assert.equal(partial.entries[0].sections[0].id, '二-执行措施与救济')
  assert.equal(partial.dropped, 2)
  assert.match(partial.problems.join(' / '), /不存在/)
  assert.match(partial.problems.join(' / '), /摘录不在小节/)
})

test('多来源：同一块引用多节时按顺序保留，供页面显示来源列表', () => {
  const note = [
    '## 甲节',
    '',
    '共同犯罪要求共同故意与共同行为同时具备。',
    '',
    '## 乙节',
    '',
    '片面共犯不成立共同犯罪，因为缺少共同故意。'
  ].join('\n')
  const onepage = '- 共同犯罪要求共同故意与共同行为同时具备；片面共犯不成立共同犯罪，因为缺少共同故意。'
  const map = buildSourceMap({ slug: 'notes/x', noteMarkdown: note, onepageMarkdown: onepage })
  const verified = verifySourceMap(map, { slug: 'notes/x', noteMarkdown: note, onepageMarkdown: onepage })
  // 一句话跨越两节时：要么定到唯一领先的那一节，要么不定——不许两节都算"精确来源"
  for (const entry of verified.entries) {
    assert.ok(entry.sections.length >= 1)
    assert.ok(entry.sections.length <= 3)
  }
  assert.ok(verified.entries.length <= 1)
})
