import assert from 'node:assert/strict'
import test from 'node:test'

import { findMatches, isConfidentHit, scoreRecord, searchRecords, snippetAround } from './search.mjs'

/** 两条记录的小语料：同一条主线在两节课里各讲一部分，用来检验"多词查询要落在都讲到的那一节"。 */
const lesson = (slug, courseName, lessonTitle, theme, keywords, markdown, metadata = {}) => ({
  slug,
  courseName,
  lessonTitle,
  theme,
  keywords,
  summary: '',
  headings: [],
  anchors: {},
  metadata: { concepts: [], statutes: [], cases: [], keywords: [], ...metadata },
  markdown
})

const RECORDS = [
  lesson('notes/商法/第2讲', '商法', '第2讲', '交易成本与企业', ['交易成本', '资产专用性'],
    '# 第2讲\n\n## 一、为什么要有企业\n\n市场交易有成本，企业以命令替代协商。\n\n## 二、资产专用性\n\n专用性资产离开这一关系就不值钱。'),
  lesson('notes/商法/第3讲', '商法', '第3讲', '有限责任与代理成本', ['代理成本'],
    '# 第3讲\n\n## 一、有限责任\n\n有限责任降低监督成本。\n\n## 二、抽逃出资\n\n抽逃出资侵蚀资本。')
]

const terms = query => queryTermsFor(query)

/** 测试里直接用同一个解析器：检索词与查询词必须同源，否则测的不是线上那条路径。 */
import { queryTerms } from './query.mjs'
function queryTermsFor(query) {
  return queryTerms(query)
}

test('打分：标题/关键词命中的权重远高于正文顺带提到', () => {
  const idf = () => 1
  const title = scoreRecord({ record: RECORDS[0], terms: queryTerms('交易成本'), includeBody: false, markdown: RECORDS[0].markdown })
  const bodyOnly = scoreRecord({
    record: { ...RECORDS[0], theme: '', keywords: [], lessonTitle: '无标题' },
    terms: queryTerms('资产专用性'),
    includeBody: true,
    markdown: RECORDS[0].markdown
  })
  assert.ok(title.score > bodyOnly.score, '同样的词出现在关键词里应当更重')
  assert.ok(title.kinds.includes('关键词') || title.kinds.includes('标题'))
  assert.ok(bodyOnly.kinds.includes('正文'))
})

test('IDF 让"只有一节课在讲的词"起决定作用', () => {
  // 同一节课、同一个字段命中，只有"这个词有多稀有"不同：稀有词必须压过到处都有的词
  const record = lesson('notes/商法/第2讲', '商法', '第2讲', '成本与资产专用性', ['成本', '资产专用性'], '# 第2讲\n\n正文。')
  const idf = term => (term === '成本' ? 0.1 : 2)
  const rareScore = scoreRecord({ record, terms: [{ term: '资产专用性', weight: 1 }], idf, includeBody: false, markdown: '' }).score
  const commonScore = scoreRecord({ record, terms: [{ term: '成本', weight: 1 }], idf, includeBody: false, markdown: '' }).score
  assert.ok(rareScore > commonScore, '稀有词的权重必须压过到处都有的词')
  assert.equal(rareScore / commonScore > 10, true, 'IDF 的差距要真的体现在排序上（此处 20 倍）')
})

test('命中门槛：多词查询沾到一个碎片不算命中', () => {
  const parsed = queryTerms('资产专用性与交易成本')
  const partial = { matchedTerms: new Set(['专用']), terms: parsed, idf: () => 0.2 }
  assert.equal(isConfidentHit(partial), false, '只命中一个低区分度的碎片不该算命中')
  const strong = { matchedTerms: new Set(['交易成本']), terms: parsed, idf: term => (term === '交易成本' ? 2 : 0.2) }
  assert.equal(isConfidentHit(strong), true, '命中一个高区分度的词就算命中')
})

test('命中位置与片段：不越界，片段自带上下文', () => {
  const text = '共同故意与共同行为是共犯成立的两个要件，缺一不可。'
  const [at] = findMatches(text, '共同行为')
  assert.ok(at > 0)
  const snippet = snippetAround(text, at, 4)
  assert.ok(snippet.includes('「共同行为」'))
  assert.equal(findMatches('', '甲').length, 0)
  assert.ok(findMatches(text + text + text, '共同').length <= 8, '同一个词最多记 8 处')
})

test('多词查询落在两节都讲到的那一节上', async () => {
  const both = await searchRecords({ records: RECORDS, query: '交易成本 资产专用性', includeBody: true })
  assert.equal(both.hits[0].slug, 'notes/商法/第2讲')
  assert.ok(both.hits[0].location.title.includes('资产专用性') || both.hits[0].location.title.includes('为什么要有企业'))
})

test('元数据没命中时自动扫正文，并标出 bodyScanned', async () => {
  const metadataOnly = await searchRecords({ records: RECORDS, query: '命令替代协商' })
  assert.equal(metadataOnly.bodyScanned, true)
  assert.equal(metadataOnly.hits[0].slug, 'notes/商法/第2讲')
  const explicit = await searchRecords({ records: RECORDS, query: '命令替代协商', includeBody: true })
  assert.equal(explicit.hits[0].slug, 'notes/商法/第2讲')
  // 元数据就能答上来时**不必下沉**（escalated=false）。注意 bodyScanned 是另一件事：
  // 本地发布库的正文就在记录里，auto 第一遍就会顺带用它，所以 bodyScanned=true 是对的；
  // 站点上那行提示说的是"索引答不上来才去翻正文"，用的是 escalated。
  const byKeyword = await searchRecords({ records: RECORDS, query: '代理成本' })
  assert.equal(byKeyword.escalated, false)
  assert.equal(byKeyword.bodyScanned, true, '正文在内存里，auto 会顺带用上（不额外下载）')
  // 只查索引时才是干净的 index 覆盖：一条都不碰正文
  const indexOnly = await searchRecords({ records: RECORDS, query: '代理成本', coverage: 'index' })
  assert.equal(indexOnly.coverage, 'index')
  assert.equal(indexOnly.bodyScanned, false)
  assert.ok(indexOnly.hits.length > 0, '元数据命中不需要正文')
  assert.equal(indexOnly.escalated, false)
})

test('错别字回退：零命中时才启用，并且只用语料里出现过的词替换', async () => {
  // 两件事要分开看：
  //   1. 中文错别字多半**用不着**回退——n-gram 里总有几个是好的（"资产专用行"仍能靠 "资产/专用" 命中）；
  //   2. 回退是兜底：一条都搜不到时才启用。拉丁缩写写错（did→dld）就是那种一条都搜不到的情况。
  const records = [
    ...RECORDS,
    lesson('notes/计量/第4讲', '计量', '第4讲', '双重差分 DID 方法', ['did'],
      '# 第4讲\n\n## 一、识别策略\n\n两组两期，看处理效应。')
  ]
  const typo = await searchRecords({ records, query: 'dld' })
  assert.equal(typo.hits[0]?.slug, 'notes/计量/第4讲')
  assert.deepEqual(typo.fuzzy, [{ from: 'dld', to: 'did' }])
  assert.ok(typo.fuzzyTerms.includes('did'))

  // 中文错别字（五字以内的词组）：按"词一级单元"做近似替换，并把替换报出来
  const recovering = await searchRecords({ records, query: '资产专用行' })
  assert.deepEqual(recovering.fuzzy, [{ from: '资产专用行', to: '资产专用性' }])
  assert.equal(recovering.hits[0]?.slug, 'notes/商法/第2讲')

  // 语料里根本没有的近义词组：返回 0 条（以前会靠"共同/行为"这类碎片凑出好几篇假命中）
  const absent = await searchRecords({ records, query: '共同行为' })
  assert.equal(absent.total, 0)
})

test('一个词都不剩的查询返回空结果集，由调用方决定怎么报错', async () => {
  const empty = await searchRecords({ records: RECORDS, query: '为什么' })
  assert.deepEqual(empty.terms, [])
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.hits, [])
})
