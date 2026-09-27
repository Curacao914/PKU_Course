import assert from 'node:assert/strict'
import test from 'node:test'

import { corpusTerms, editDistanceWithin, fuzzyTerms, queryTerms } from './query.mjs'

const termsOf = query => queryTerms(query).map(item => item.term)

test('多词查询：整串之外还要给出词一级的片段（旧实现整串 indexOf，必然零命中）', () => {
  const terms = termsOf('资本维持与抽逃出资')
  assert.ok(terms.includes('资本维持'), '4-gram 要覆盖到前一个词')
  assert.ok(terms.includes('抽逃出资'), '4-gram 要覆盖到后一个词')
  assert.ok(termsOf('交易成本 资产专用性').includes('资产专用性'))
})

test('中文单字虚词又是构词成分：不能按它们切词', () => {
  // 这些字一旦当成分隔符，"行为/要件/存在/和解/参与" 这些真词就被切坏了——
  // 试过一版按虚词切开，"共同行为" 变成了 "共同行"，等于把要查的词毁掉。
  for (const [query, keep] of [['共同行为', '共同行为'], ['构成要件', '构成要件'], ['存在与和解', '存在'], ['参与分配', '参与']]) {
    assert.ok(termsOf(query).includes(keep), `${query} 里应当保留 ${keep}`)
  }
})

test('自然语言问句：去掉问法壳子，长片段再补 2—4 字 n-gram', () => {
  const terms = termsOf('为什么审判威廉二世的构想落空了')
  assert.ok(!terms.some(term => term.includes('为什么')), '疑问词不该留在检索词里')
  assert.ok(terms.includes('威廉二世'), '专名要能被切出来')
  assert.ok(terms.includes('构想'))
  assert.ok(terms.includes('落空'))
})

test('拉丁词与数字自成一体，不被中文切碎', () => {
  const terms = termsOf('变量测量水平与标准化Z值')
  assert.ok(terms.includes('标准化z值') || terms.includes('标准化'))
  assert.ok(terms.includes('z值'), 'Z 值要作为一个词')
})

test('整段短语的权重高于它切出来的 n-gram', () => {
  const weights = new Map(queryTerms('资产专用性').map(item => [item.term, item.weight]))
  assert.ok(weights.get('资产专用性') > weights.get('专用性'), '整段比碎片可信')
})

test('只由疑问词组成的查询解析为空（调用方据此报错，而不是把整库当命中）', () => {
  assert.deepEqual(queryTerms('为什么'), [])
  assert.deepEqual(queryTerms('如何'), [])
  assert.deepEqual(queryTerms('   '), [])
  // 疑问句里只要还有实词就照常检索：拆出来的是 2—4 字片段，噪声片段在语料里出现 0 次、拿不到分
  assert.ok(queryTerms('为什么是这样的呢').length > 0)
})

test('编辑距离：只认"差一个字符"这一档', () => {
  assert.equal(editDistanceWithin('罪刑法定主意', '罪刑法定主义', 1), 1)
  assert.equal(editDistanceWithin('罪刑法定', '罪刑法定主义', 1), 2)
  assert.equal(editDistanceWithin('同名', '异名', 1), 1)
  assert.equal(editDistanceWithin('甲', '乙丙', 1), 2, '长度差超过上限直接判出界')
})

test('错别字回退只在语料里真实出现过的词里找', () => {
  const candidates = corpusTerms([{
    lessonTitle: '第3讲',
    courseName: '国际刑法学',
    theme: '罪刑法定主义与禁止事后法',
    keywords: ['罪刑法定主义'],
    headings: [{ text: '五、罪刑法定主义质疑的形式与实质回应' }],
    metadata: { concepts: ['禁止溯及既往'], statutes: [], cases: [] }
  }])
  assert.deepEqual(fuzzyTerms('罪刑法定主意', candidates), ['罪刑法定主义'])
  assert.deepEqual(fuzzyTerms('完全不存在的词', candidates), [])
  assert.deepEqual(fuzzyTerms('主', candidates), [], '太短的词不做模糊匹配（会误伤）')
})
