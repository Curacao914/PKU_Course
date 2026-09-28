import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createQueryEmbedder, createSemanticFallback, loadEmbeddingIndex, parseEmbeddingIndex, semanticHits } from './semantic.mjs'

/**
 * 语义回退的四件事，每件一组用例：
 *   ① 指纹校验（正文改过、索引过期就不用那条向量）
 *   ② 门槛（相似度太低不报——"总得给点什么"是最糟的检索行为）
 *   ③ 降级（服务慢/挂/超时 → 静默返回空，不抛错、不阻塞）
 *   ④ 标注（命中带 similarity 与 semantic:true，调用方能告诉读者"这是按意思找的"）
 */

const vector = (...values) => values
const record = (slug, sections) => ({
  slug,
  courseName: '刑法分论',
  lessonTitle: slug.split('/').pop(),
  lessonDate: '2026-09-01',
  markdown: '正文',
  keywords: ['甲'],
  sections
})

const INDEX = {
  version: 1,
  provider: 'dashscope',
  model: 'text-embedding-v3',
  dim: 3,
  items: {
    'notes/刑法分论/第1节#一-甲': { fingerprint: 'fp-甲', vector: vector(1, 0, 0) },
    'notes/刑法分论/第1节#二-乙': { fingerprint: 'fp-乙', vector: vector(0, 1, 0) }
  }
}
const RECORDS = [record('notes/刑法分论/第1节', [
  { id: '一-甲', title: '一、甲', fingerprint: 'fp-甲' },
  { id: '二-乙', title: '二、乙', fingerprint: 'fp-乙' }
])]

test('解析索引：坏条目跳过而不是整份作废；维度不一致也跳过', () => {
  const index = parseEmbeddingIndex({
    ...INDEX,
    items: {
      ...INDEX.items,
      'notes/刑法分论/第1节#坏': { fingerprint: 'x', vector: [] },
      'notes/刑法分论/第1节#维度不对': { fingerprint: 'y', vector: [1, 0] }
    }
  })
  assert.equal(index.items.size, 2)
  assert.equal(index.skipped, 2)
  assert.equal(index.dim, 3)
  assert.equal(parseEmbeddingIndex('不是 JSON'), null)
  assert.equal(parseEmbeddingIndex({}), null)
})

test('① 指纹校验：正文改过（指纹变了）的那条向量不参与检索', () => {
  const index = parseEmbeddingIndex(INDEX)
  const query = vector(0, 1, 0)
  const fresh = semanticHits({ index, queryVector: query, records: RECORDS })
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].location.id, '二-乙')

  const changed = [record('notes/刑法分论/第1节', [
    { id: '一-甲', title: '一、甲', fingerprint: 'fp-甲' },
    { id: '二-乙', title: '二、乙', fingerprint: 'fp-乙-改过了' }
  ])]
  assert.equal(semanticHits({ index, queryVector: query, records: changed }).length, 0, '指纹对不上就不该用旧向量')
  // 课次从库里消失：那条向量同样作废
  assert.equal(semanticHits({ index, queryVector: query, records: [] }).length, 0)
})

test('② 门槛：相似度低于 minScore 的一条都不报', () => {
  const index = parseEmbeddingIndex(INDEX)
  // 索引里两条向量是 [1,0,0] 与 [0,1,0]。这个查询与两者余弦都是 0.5：
  // 属于"勉强沾一点"，默认门槛（0.55）下一条都不该报
  const weak = normalizeQuery(vector(0.5, 0.5, 0.7071))
  assert.equal(semanticHits({ index, queryVector: weak, records: RECORDS, minScore: 0.55 }).length, 0, '宁可少报也不要瞎报')
  assert.equal(semanticHits({ index, queryVector: weak, records: RECORDS, minScore: 0.4 }).length, 1, '门槛下调就报（同一节课去重后只留 1 条）')
  assert.equal(semanticHits({ index, queryVector: normalizeQuery(vector(0, 1, 0)), records: RECORDS, minScore: 0.55 }).length, 1, '方向对上就该报')
})

function normalizeQuery (values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map(value => value / norm)
}

test('④ 标注：命中带 similarity 与 semantic:true，并且一篇只留最高分那一节', () => {
  const index = parseEmbeddingIndex({
    ...INDEX,
    items: {
      'notes/刑法分论/第1节#一-甲': { fingerprint: 'fp-甲', vector: vector(1, 0, 0) },
      'notes/刑法分论/第1节#二-乙': { fingerprint: 'fp-乙', vector: vector(0.9, 0.1, 0) }
    }
  })
  const hits = semanticHits({ index, queryVector: vector(1, 0, 0), records: RECORDS, minScore: 0.5 })
  assert.equal(hits.length, 1, '同一节课只留最像的那一节')
  assert.equal(hits[0].semantic, true)
  assert.equal(hits[0].kind, '语义')
  assert.ok(hits[0].similarity > 0.9)
  assert.equal(hits[0].location.title, '一、甲')
})

test('③ 降级：没有 key / 服务超时 / 服务报错，都只返回空，不抛错', async () => {
  const noKey = createQueryEmbedder({ apiKey: '' })
  assert.equal(await noKey.embed('甲'), null)
  assert.equal(noKey.stats().lastError, 'no_api_key')

  const slow = createQueryEmbedder({ apiKey: 'k', timeoutMs: 30, fetchImpl: () => new Promise(() => {}) })
  assert.equal(await slow.embed('甲'), null, '超时要返回 null（硬超时靠 AbortController，不能一直挂着）')
  assert.match(slow.stats().lastError, /abort|超时|AbortError/i)

  const broken = createQueryEmbedder({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })
  assert.equal(await broken.embed('甲'), null)
  assert.equal(broken.stats().failures, 1)
})

test('降级不影响上层：索引缺失 / 查询失败时 search() 返回空数组', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-semantic-'))
  const missing = createSemanticFallback({ indexFile: path.join(dir, 'nope.json'), apiKey: 'k' })
  assert.deepEqual(await missing.search({ query: '甲', records: RECORDS }), [])

  const file = path.join(dir, 'embeddings.json')
  fs.writeFileSync(file, JSON.stringify(INDEX))
  const failing = createSemanticFallback({ indexFile: file, apiKey: 'k', fetchImpl: async () => { throw new Error('断网') } })
  assert.deepEqual(await failing.search({ query: '甲', records: RECORDS }), [])

  const working = createSemanticFallback({
    indexFile: file,
    apiKey: 'k',
    fetchImpl: async (url, options) => ({ ok: true, json: async () => ({ output: { embeddings: [{ embedding: vector(0, 1, 0) }] } }) })
  })
  const hits = await working.search({ query: '乙是什么', records: RECORDS })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].location.id, '二-乙')
})

test('查询向量化有进程内缓存：同一句话第二次不再请求', async () => {
  let calls = 0
  const embedder = createQueryEmbedder({
    apiKey: 'k',
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ output: { embeddings: [{ embedding: vector(1, 0, 0) }] } }) } }
  })
  await embedder.embed('同一个问题')
  await embedder.embed('同一个问题')
  assert.equal(calls, 1)
  assert.equal(embedder.stats().hits, 1)
})

test('索引文件按 mtime 缓存：发布写完新索引后不用重启进程', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-semantic-'))
  const file = path.join(dir, 'embeddings.json')
  fs.writeFileSync(file, JSON.stringify(INDEX))
  const first = loadEmbeddingIndex(file)
  assert.equal(first.index.items.size, 2)
  fs.writeFileSync(file, JSON.stringify({ ...INDEX, items: { 'notes/刑法分论/第1节#一-甲': { fingerprint: 'fp-甲', vector: vector(1, 0, 0) } } }))
  const second = loadEmbeddingIndex(file)
  assert.equal(second.index.items.size, 1, '文件变了就要重读（按 mtime+size 判断）')
  assert.equal(loadEmbeddingIndex(path.join(dir, 'nope.json')).reason, 'missing')
  fs.rmSync(dir, { recursive: true, force: true })
})
test('接线：字面零命中才走语义回退，且带标注；字面命中时一次都不调用（成本与延迟纪律）', async () => {
  const { createNotesService } = await import('./service.mjs')
  const { normalizeRecord, sectionIndex, extractHeadings } = await import('./records.mjs')

  const markdown = ['## 一、归因', '', '归因是把行为归于国家的第一步。'].join('\n')
  const records = [normalizeRecord({
    slug: 'notes/国际法/第1讲',
    courseName: '国际法',
    lessonTitle: '第1讲 国家责任',
    keywords: ['归因'],
    markdown,
    headings: extractHeadings(markdown),
    sections: sectionIndex(markdown),
    publishedAt: '2026-01-01T00:00:00.000Z'
  })]

  const calls = []
  const semantic = {
    enabled: true,
    search: async ({ query }) => {
      calls.push(query)
      return [{
        slug: 'notes/国际法/第1讲',
        courseName: '国际法',
        lessonTitle: '第1讲 国家责任',
        lessonDate: '2026-01-01',
        kind: '语义',
        kinds: ['语义'],
        location: { id: '一-归因', title: '一、归因' },
        snippets: ['归因是把行为归于国家的第一步。'],
        score: 0.81,
        similarity: 0.81,
        semantic: true
      }]
    }
  }
  const service = createNotesService({
    source: { kind: 'test', describe: () => ({ kind: 'test' }), listNotes: async () => records, readMarkdown: async () => markdown },
    semantic
  })

  // ① 字面能命中：语义一次都不该被调用（否则每次搜索都要多一次网络往返）
  const lexical = await service.searchNotes({ query: '归因' })
  assert.ok(lexical.hits.length >= 1)
  assert.deepEqual(calls, [], '字面命中时不该动用语义回退')
  assert.equal(lexical.semantic.used, false)
  assert.equal(lexical.semantic.enabled, true)

  // ② 字面零命中（换个说法）：走一次语义，并且把"这是猜着找的"标出来
  const semanticOnly = await service.searchNotes({ query: '合同解除后的溯及力' })
  assert.equal(calls.length, 1)
  assert.equal(semanticOnly.semantic.used, true)
  assert.equal(semanticOnly.lexicalTotal, 0, '字面为空这件事必须报出去，不能被语义命中盖掉')
  assert.equal(semanticOnly.hits[0].semantic, true)
  assert.equal(semanticOnly.hits[0].similarity, 0.81)
  assert.equal(semanticOnly.hits[0].location.id, '一-归因')

  // ③ 回退自己失败（服务挂了）：调用方看到的仍然是"没有命中"，不是 500
  const broken = createNotesService({
    source: { kind: 'test', describe: () => ({ kind: 'test' }), listNotes: async () => records, readMarkdown: async () => markdown },
    semantic: { enabled: true, search: async () => { throw new Error('embedding 服务挂了') } }
  })
  const degraded = await broken.searchNotes({ query: '合同解除后的溯及力' })
  assert.equal(degraded.hits.length, 0)
  assert.equal(degraded.semantic.used, false)
})

test('端到端：服务 → 真实语义回退（桩 fetch）能召回，且标注齐全', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-semantic-e2e-'))
  const { createNotesService } = await import('./service.mjs')
  const { normalizeRecord, extractHeadings, sectionIndex } = await import('./records.mjs')
  const { createSemanticFallback } = await import('./semantic.mjs')

  const markdown = ['## 一、轻微犯罪记录封存', '', '轻罪前科的记录可以封存，不影响就业。'].join('\n')
  const sections = sectionIndex(markdown)
  const records = [normalizeRecord({
    slug: 'notes/刑事执行法/第1节',
    courseName: '刑事执行法',
    lessonTitle: '第1节',
    keywords: ['封存'],
    markdown,
    headings: extractHeadings(markdown),
    sections,
    publishedAt: '2026-01-01T00:00:00.000Z'
  })]
  // 这条断言是这次真踩的坑：normalizeRecord 丢掉 sections 之后，语义回退永远召不回任何东西
  assert.equal(records[0].sections.length, 1, 'normalizeRecord 必须把小节索引带出来')
  assert.ok(records[0].sections[0].fingerprint)

  const indexFile = path.join(dir, 'embeddings.json')
  fs.writeFileSync(indexFile, JSON.stringify({
    version: 1, provider: 'dashscope', model: 'text-embedding-v3', dim: 3,
    items: { ['notes/刑事执行法/第1节#一-轻微犯罪记录封存']: { fingerprint: sections[0].fingerprint, vector: [0, 1, 0] } }
  }))

  const semantic = createSemanticFallback({
    indexFile,
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, json: async () => ({ output: { embeddings: [{ embedding: [0, 1, 0] }] } }) })
  })
  const service = createNotesService({
    source: { kind: 'test', describe: () => ({ kind: 'test' }), listNotes: async () => records, readMarkdown: async () => markdown },
    semantic
  })
  const found = await service.searchNotes({ query: '轻罪前科怎么处理' })
  assert.equal(found.semantic.used, true)
  assert.equal(found.hits.length, 1, '端到端必须真的召回（这条用例就是为"启用了却召回不到"写的）')
  assert.equal(found.hits[0].semantic, true)
  assert.equal(found.hits[0].location.id, '一-轻微犯罪记录封存')
  assert.ok(found.hits[0].similarity > 0.99)
  assert.ok(found.hits[0].snippets[0].includes('封存'), '片段从正文现取，读者不必点进去才知道是什么')
  fs.rmSync(dir, { recursive: true, force: true })
})

