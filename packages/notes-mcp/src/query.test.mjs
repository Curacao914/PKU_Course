import assert from 'node:assert/strict'
import test from 'node:test'

import { corpusTerms, editDistanceWithin, fuzzyTerms, queryTerms } from './query.mjs'

const termsOf = query => queryTerms(query).map(item => item.term)

test('多词查询按虚词切开，而不是把整串当一个词', () => {
  // 旧实现拿整串 indexOf：多词查询必然零命中，这是线上最常见的失效
  assert.deepEqual(termsOf('资本维持与抽逃出资').filter(term => term.length >= 4).sort(), ['抽逃出资', '资本维持'])
  assert.ok(termsOf('交易成本 资产专用性').includes('交易成本'))
  assert.ok(termsOf('交易成本 资产专用性').includes('资产专用性'))
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

test('全是疑问词与虚词的查询解析为空（调用方据此报错，而不是把整库当命中）', () => {
  assert.deepEqual(queryTerms('为什么是这样的呢'), [])
  assert.deepEqual(queryTerms('   '), [])
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
