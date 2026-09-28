import assert from 'node:assert/strict'
import test from 'node:test'

import { extractHeadings, findSection, fingerprintOf, normalizeRecord, sectionIndex, splitSections } from './records.mjs'
import { dedupeSnippets, searchRecords } from './search.mjs'
import { createProtocolServer } from './protocol.mjs'
import { createNotesService } from './service.mjs'

/**
 * A3：小节索引与检索的"指到同一处"。
 *
 * 这一组用例钉住四件事，每一件都对应一个真实会出错的形状：
 *   1. 小节解析只认真正的标题（代码围栏里的 `# 注释` 不算），同名小节 id 唯一且能按别名找到；
 *   2. 一节课可以有多处小节命中，去重、按分数、每篇有配额；
 *   3. 片段不重复讲同一句话（n-gram 命中同一句不该高亮三次）；
 *   4. 三个入口（MCP 专用检索 / 标准 search / 站点搜索）共用同一套覆盖策略。
 */

const fence = String.fromCharCode(96).repeat(3)

const markdownOf = (...parts) => parts.join('\n')

function lesson(slug, course, title, keywords, markdown) {
  return normalizeRecord({
    slug,
    courseName: course,
    lessonTitle: title,
    keywords,
    markdown,
    headings: extractHeadings(markdown),
    sections: sectionIndex(markdown),
    publishedAt: '2026-01-01T00:00:00.000Z'
  })
}

test('小节解析：代码围栏里的井号不算小节，同名小节 id 唯一且别名仍可命中', () => {
  const markdown = markdownOf(
    '# 笔记标题',
    '',
    '## 课程概览',
    '',
    '概览正文。',
    '',
    fence + 'bash',
    '# 这行是注释，不是标题',
    'echo hi',
    fence,
    '',
    '## 课程概览',
    '',
    '第二处同名小节。'
  )
  const headings = extractHeadings(markdown)
  assert.deepEqual(headings.map(head => head.id), ['笔记标题', '课程概览', '课程概览-2'], '同名小节必须各有各的 id')
  assert.ok(!headings.some(head => head.text.includes('这行是注释')), '代码围栏里的井号不是标题')

  // splitSections 与 extractHeadings 必须是同一套解析（以前两处各写一遍正则）
  assert.deepEqual(splitSections(markdown).map(section => section.id), headings.map(head => head.id))

  // 按精确 id、按别名（原始 slug）、按标题都能找到；别名只指向第一处，避免"猜语义"
  assert.equal(findSection(markdown, '课程概览-2').ownBody.includes('第二处同名小节'), true)
  assert.equal(findSection(markdown, '课程概览').ownBody.includes('概览正文'), true)
  assert.equal(findSection(markdown, '课程概览').id, '课程概览')
})

test('小节索引：按内容算字数与指纹，正文变了指纹就变', () => {
  const before = sectionIndex(markdownOf('## 一、甲', '', '原来的正文。'))
  const after = sectionIndex(markdownOf('## 一、甲', '', '改过的正文，长度不一样。'))
  assert.equal(before[0].id, '一-甲')
  assert.equal(before[0].chars, '原来的正文。'.length)
  assert.match(before[0].fingerprint, /^[0-9a-f]{8}$/)
  assert.notEqual(before[0].fingerprint, after[0].fingerprint, '正文变了，指纹必须变')
  assert.equal(fingerprintOf('同样的正文'), fingerprintOf('同样的正文'), '同样的内容指纹稳定')
  // 索引里不含正文本身（公开索引的体积不能随正文膨胀）
  assert.equal('body' in before[0] || 'ownBody' in before[0], false)
})

test('按小节打分：一节课多处命中，去重、按分数、受每篇配额限制', async () => {
  const markdown = markdownOf(
    '## 一、直接效果',
    '',
    '合同无效的直接效果是恢复原状。',
    '',
    '## 二、其他',
    '',
    '这一段讲的是别的东西。',
    '',
    '## 三、反射效果',
    '',
    '合同无效还会产生反射效果，第三人也会受影响。'
  )
  const records = [lesson('notes/民法/第1讲', '民法', '第1讲 合同无效', ['合同无效'], markdown)]
  const found = await searchRecords({ records, query: '合同无效', coverage: 'body' })
  const hit = found.hits[0]
  assert.ok(hit, '应当命中')
  assert.equal(hit.sections.length, 2, '两节都讲到，就该报两处')
  assert.deepEqual(hit.sections.map(item => item.id), ['一-直接效果', '三-反射效果'], '按分数排序，去重')
  assert.ok(hit.sections.every(item => item.snippets.some(text => text.includes('合同无效'))))
  assert.equal(hit.location.id, '一-直接效果', 'location 指向最高分那一处')
  assert.ok(hit.location.fingerprint, '位置要带内容指纹，拿到正文才好核对')

  const quota = await searchRecords({ records, query: '合同无效', coverage: 'body', perNoteSections: 1 })
  assert.equal(quota.hits[0].sections.length, 1, '配额生效：一节课最多报几处')
})

test('片段去重：同一句话被多个 n-gram 命中时只留一条', async () => {
  const markdown = markdownOf('## 一、共犯', '', '共犯的成立需要共同故意与共同行为，二者缺一不可。')
  const records = [lesson('notes/刑法/第1讲', '刑法', '第1讲 共犯', ['共犯'], markdown)]
  const found = await searchRecords({ records, query: '共同行为', coverage: 'body' })
  const snippets = found.hits[0].snippets
  assert.ok(snippets.length >= 1)
  assert.ok(snippets.length <= 2, '同一句话不该被切成三条片段：' + JSON.stringify(snippets))

  // 直接测去重函数：三句里有两句说同一件事
  const kept = dedupeSnippets([
    { text: '…前文「共同」故意与共同行为…', term: '共同' },
    { text: '…前文共同故意与「共同行为」…', term: '共同行为' },
    { text: '…另一节讲「共同犯罪」的成立…', term: '共同犯罪' }
  ])
  assert.equal(kept.length, 2, '同句的短词片段让位给长词，另一句保留：' + JSON.stringify(kept))
  assert.ok(kept.some(text => text.includes('「共同行为」')), '留下的是信息量更大的那个')
})

test('n-gram 只是加分项，不会变成硬过滤器', async () => {
  const markdown = markdownOf('## 一、归因', '', '归因是把行为归于国家的第一步。')
  const records = [lesson('notes/国际法/第1讲', '国际法', '第1讲 国家责任', ['归因', '赔偿'], markdown)]
  // 查询里混了一个语料中根本不存在的词：剩下的词仍然要能命中
  const found = await searchRecords({ records, query: '归因 完全不存在的词', coverage: 'body' })
  assert.ok(found.hits.length >= 1, '缺一个词不该让整条查询查不出东西')
  assert.equal(found.hits[0].slug, 'notes/国际法/第1讲')
  assert.ok(found.terms.includes('归因'))
})

test('覆盖策略：index/auto/body 三个入口同一套默认，索引答不上来才下沉', async () => {
  const bodyOnly = markdownOf('## 一、识别', '', '两组两期，看处理效应，这就是双重差分。')
  const records = [lesson('notes/计量/第1讲', '计量', '第1讲 识别策略', ['识别策略'], bodyOnly)]

  // ① 正文在记录里（本地发布库）：auto 第一遍就用上，不必"下沉"，
  //    但它是 index 之外的一层，coverage 如实报 body
  const auto = await searchRecords({ records, query: '双重差分' })
  assert.equal(auto.hits.length, 1)
  assert.equal(auto.coverage, 'body')
  assert.equal(auto.escalated, false, '没经过"索引答不上来"这一步')

  // ② 只查索引：正文里的词查不到 —— 这不是 bug，是调用方明确要求不下沉
  const indexOnly = await searchRecords({ records, query: '双重差分', coverage: 'index' })
  assert.equal(indexOnly.hits.length, 0)
  assert.equal(indexOnly.bodyScanned, false)

  // ③ 远程数据源（记录不含正文）：索引先查，什么都没有时才去读正文，并标 escalated
  const remote = records.map(record => ({ ...record, markdown: undefined }))
  let reads = 0
  const scanned = await searchRecords({
    records: remote,
    query: '双重差分',
    readMarkdown: async () => { reads += 1; return bodyOnly }
  })
  assert.equal(reads, 1, '只有下沉那一步才会去读正文')
  assert.equal(scanned.escalated, true)
  assert.equal(scanned.hits.length, 1)
  assert.equal(scanned.hits[0].location.id, '一-识别', '正文命中也要定位到小节')
})

test('目录分页：全部小节都给，截断了要说清，offset 能接着翻', async () => {
  const body = Array.from({ length: 7 }, (_, index) => markdownOf(`## 第${index + 1}节`, '', '正文' + index)).join('\n\n')
  const records = [lesson('notes/测试/第1讲', '测试', '第1讲', ['测试'], markdownOf('# 标题', '', body))]
  const service = createNotesService({ source: { kind: 'test', describe: () => ({ kind: 'test' }), listNotes: async () => records, readMarkdown: async slug => records.find(r => r.slug === slug).markdown } })

  const all = await service.getCourse({ course: '测试', includeOutline: true })
  const outline = all.lessons[0].outline
  assert.equal(outline.total, outline.items.length, '不静默截断：默认就要给全')
  assert.equal(outline.truncated, false)
  assert.ok(outline.items.some(item => item.text === '第7节'))

  const paged = await service.getCourse({ course: '测试', includeOutline: true, outlineLimit: 3, outlineOffset: 0 })
  assert.equal(paged.lessons[0].outline.items.length, 3)
  assert.equal(paged.lessons[0].outline.truncated, true)
  assert.equal(paged.lessons[0].outline.total, outline.total)
  const next = await service.getCourse({ course: '测试', includeOutline: true, outlineLimit: 3, outlineOffset: 3 })
  assert.equal(next.lessons[0].outline.offset, 3)
  assert.notEqual(next.lessons[0].outline.items[0].id, paged.lessons[0].outline.items[0].id)

  // get_note 的小节清单同样分页 + 报总数
  const note = await service.getNote({ slug: 'notes/测试/第1讲', sectionsLimit: 2 })
  assert.equal(note.sections.length, 2)
  assert.equal(note.sectionsTruncated, true)
  assert.ok(note.sectionsTotal > 2)

  // 工具层必须真的接受这些参数：服务层支持、inputSchema 却写着 additionalProperties:false
  // 的话，模型传 outlineLimit 只会拿到"参数 不接受未知字段"——线上冒烟就是这么发现的。
  const protocol = createProtocolServer({ service, logger: () => {} })
  const call = (name, args) => protocol.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const outlineCall = await call('get_course', { course: '测试', includeOutline: true, outlineLimit: 3 })
  assert.equal(outlineCall.result.isError, false, outlineCall.result.content?.[0]?.text)
  assert.match(outlineCall.result.content[0].text, /小节（3\/\d+）/)
  const search = await call('search_notes', { query: '第1节', coverage: 'index', perNoteSections: 1 })
  assert.equal(search.result.isError, false, search.result.content?.[0]?.text)
  const sections = await call('get_note', { slug: 'notes/测试/第1讲', sectionsLimit: 1 })
  assert.equal(sections.result.isError, false, sections.result.content?.[0]?.text)
})
