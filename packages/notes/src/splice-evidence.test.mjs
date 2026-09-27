import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SPLICE_EVIDENCE,
  draftsByOutline,
  isVerbatimCopy,
  nodeEvidence,
  sectionBodyIndex,
  spliceEvidence
} from './splice-evidence.mjs'

const node = (id, outlineNodeId, draft, over = {}) => ({
  id, outlineNodeId, title: `节点 ${id}`, draft, versions: [{}], ...over
})

const lesson = {
  title: '第10-12节 共犯与罪数',
  outline: [
    { id: 'o1', title: '一、共犯的成立条件', concepts: ['共同故意'], statutes: ['《刑法》第25条'] },
    { id: 'o2', title: '二、罪数判断' },
    { id: 'o3', title: '三、课堂事务' }
  ],
  nodes: [
    node('n1', 'o1', [
      '**（一）共犯的两个要件**',
      '',
      '共犯的成立需要共同故意与共同行为，二者缺一不可，判断标准是各行为人之间是否存在意思联络。',
      '这一段剩下的内容只是课堂上的铺垫与举例，不构成要点句。',
      '',
      '**（二）易混之处**',
      '',
      '共犯与共同犯罪不是一回事：前者是参与形态，后者是罪名层面的表述。',
      '',
      '<details><summary>元数据</summary>',
      '<pre><code>',
      'META: CONCEPT: 共同故意',
      '</code></pre>',
      '</details>',
      '',
      '**自测**（合上笔记，先自己写出来，再看答案）',
      '',
      '1. 共同故意的判断标准是什么？'
    ].join('\n')),
    // 合并写单元：这一节点同时覆盖 o1 与 o2
    node('n2', 'o1', '罪数的判断以行为个数与法益侵害个数为基础，这是罪数判断的基本标准。', { outlineNodeIds: ['o1', 'o2'] })
  ]
}

test('要点句进摘录：规则、判断标准、易混句与小标题都在', () => {
  const { byOutlineId, text } = spliceEvidence(lesson)
  const evidence = byOutlineId.o1
  assert.match(evidence, /共犯的成立需要共同故意与共同行为/, '规则句要留下')
  assert.match(evidence, /判断标准是各行为人之间是否存在意思联络/)
  assert.match(evidence, /共犯与共同犯罪不是一回事/, '易混句是索引表"易混"一列的凭据')
  assert.match(evidence, /（一）共犯的两个要件/, '老师自己写的小标题是这一节的结构')
  assert.match(text, /依据摘录（来自已批准正文的要点句，只作依据）/)
  assert.match(text, /不得整句照搬摘录/)
})

test('摘录是节选：铺垫、举例、META 与自测都不进模型', () => {
  const evidence = spliceEvidence(lesson).byOutlineId.o1
  assert.ok(!evidence.includes('不构成要点句'), '铺垫与举例不是依据')
  assert.ok(!evidence.includes('META'), 'META 清单不进接缝模型')
  assert.ok(!evidence.includes('自测'), '自测是接缝层自己出的题，不是依据')
})

test('合并写单元覆盖到的每一节都拿得到依据（P0 语义的延续）', () => {
  const { byOutlineId } = spliceEvidence(lesson)
  assert.match(byOutlineId.o1, /罪数的判断以行为个数与法益侵害个数为基础/, '覆盖的第一节要拿到')
  assert.match(byOutlineId.o2, /罪数的判断以行为个数与法益侵害个数为基础/, '覆盖的第二节同样要拿到')
  const drafts = draftsByOutline(lesson)
  assert.deepEqual(drafts.get('o2').map(item => item.id), ['n2'])
})

test('没有可引用依据的节明说没有，不编', () => {
  const { byOutlineId, text } = spliceEvidence(lesson)
  assert.equal(byOutlineId.o3, '')
  assert.match(text, /### 三、课堂事务/)
  assert.match(text, /本节没有可直接引用的规则句/)
})

test('预算封顶：每节有上限，整课有总预算，节多时按比例下探但不低于下限', () => {
  const long = Array.from({ length: 40 }, (_, index) =>
    `第${index + 1}条规则：这一条的判断标准是什么什么，要件包括甲、乙、丙三项，缺一不可。`).join('')
  const single = { title: 'T', outline: [{ id: 'o1', title: '一节' }], nodes: [node('n1', 'o1', long)] }
  assert.ok(nodeEvidence(long, { limit: 300 }).length <= 300, '单节摘录不得超过上限')

  const many = {
    title: 'T',
    outline: Array.from({ length: 20 }, (_, index) => ({ id: `o${index + 1}`, title: `第${index + 1}节` })),
    nodes: Array.from({ length: 20 }, (_, index) => node(`n${index + 1}`, `o${index + 1}`, long))
  }
  const { entries, chars } = spliceEvidence(many)
  assert.equal(entries.length, 20, '每一节都要出现，哪怕是"没有依据"')
  assert.ok(chars <= SPLICE_EVIDENCE.total, `总预算应当封顶（实际 ${chars}）`)
  const perNode = Math.max(...entries.map(entry => entry.evidence.length))
  assert.ok(perNode <= Math.floor(SPLICE_EVIDENCE.total / 20) + 1, '节多时每节预算按比例下探')
  assert.ok(perNode >= 120, '下探也不低于下限')
  assert.ok(spliceEvidence(single).byOutlineId.o1.length <= SPLICE_EVIDENCE.perNode)
})

test('逐字照搬判定：接缝层把正文原样搬过去就退回兜底', () => {
  const body = '共犯的成立需要共同故意与共同行为，二者缺一不可，判断标准是各行为人之间是否存在意思联络，这一点在认定时要结合具体情境。'
  assert.equal(isVerbatimCopy('共犯的成立需要共同故意与共同行为，二者缺一不可，判断标准是各行为人之间是否存在意思联络。', body), true)
  assert.equal(isVerbatimCopy('共犯的成立需要共同故意 与共同行为，二者缺一不可，判断标准是各行为人之间是否存在意思联络。', body), true, '空白差异不算差异')
  assert.equal(isVerbatimCopy('本节承担本课的第一个论证环节，先确立共犯的成立条件。', body), false)
  assert.equal(isVerbatimCopy('太短。', body), false, '太短的句子不做判定，避免误伤')
  assert.equal(isVerbatimCopy('共犯的成立需要共同故意与共同行为。', ''), false)
})

test('正文索引按大纲节点聚合，供机械校验使用', () => {
  const index = sectionBodyIndex(lesson)
  assert.match(index.get('o1'), /共犯的成立需要共同故意与共同行为/)
  assert.ok(!index.get('o1').includes('META'), '索引里的正文同样要清理装饰')
  assert.match(index.get('o2'), /罪数的判断以行为个数/)
  assert.equal(index.get('o3'), '')
})
