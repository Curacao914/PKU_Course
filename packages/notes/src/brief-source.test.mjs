import assert from 'node:assert/strict'
import test from 'node:test'

import { BRIEF_SCHEMA, buildBriefSource, generateBrief } from './brief.mjs'
import {
  BRIEF_SOURCE_BUDGET,
  assertBriefBinding,
  briefSourceChecksum,
  buildBriefSourceFromFinalNote,
  charCount,
  checkBriefBinding,
  parseFinalNote
} from './brief-source.mjs'

/** 成品正文的骨架（与线上发布的笔记同构）：概览三连、正文小节、附录、知识连接、META。 */
function noteMarkdown({ title = '第1-2节 有限责任', course = '商法概论', sections = [], appendix = true } = {}) {
  const body = sections.map(section => [
    `## ${section.title}`,
    '',
    section.summary || '这一节交代该问题的来龙去脉。',
    '',
    section.prose || '',
    '',
    '**自测**（合上笔记，先自己写出来，再看答案）',
    '',
    '1. 这一节的问题是什么？',
    '2. 判断标准有哪些？',
    '',
    '<details><summary>参考答案</summary>',
    '',
    '1. 见正文；2. 见正文。',
    '',
    '</details>'
  ].join('\n')).join('\n\n***\n\n')

  return [
    `# ${title}`,
    '',
    `> 课程：${course} · 转录 L1–L100`,
    '',
    '## 课程概览',
    '',
    '### 本课要回答的核心问题',
    '',
    '1. 为什么需要法人人格否认？',
    '2. 资本维持与债权人保护是什么关系？',
    '',
    '### 本课你应当能够',
    '',
    '- [ ] 说出人格否认的适用条件。',
    '- [ ] 区分资本维持与资本不变。',
    '',
    '### 课程脉络',
    '',
    '> 先讲有限责任的两条边界，再讲资本制度如何守住这两条边界。',
    '',
    '<details><summary>知识地图</summary>',
    '',
    '```mermaid',
    'flowchart TD',
    '  A[人格否认] --> B[资本维持]',
    '```',
    '',
    '</details>',
    '',
    '***',
    '',
    body,
    appendix ? ['', '***', '', '## 附录：补充与发散', '', '### 课后答疑与课程事务', '', '- 交作业的时间。'].join('\n') : '',
    '',
    '***',
    '',
    '## 知识连接',
    '',
    '**承接什么**：承接上节关于公司设立的讲述。',
    '',
    '**为后续铺垫什么**：',
    '',
    '- 人格否认 → 用于理解关联交易。',
    '',
    '***',
    '',
    '<details><summary>📑 笔记元数据（用于跨课整合）</summary>',
    '',
    '<pre><code>',
    'META: CONCEPT: 法人人格否认',
    'META: CONCEPT: 资本维持',
    'META: CASE: 某公司抽逃出资案',
    'META: PROVISION: 公司法第20条（相关条款）',
    '</code></pre>',
    '',
    '</details>'
  ].filter(Boolean).join('\n')
}

const twoSections = noteMarkdown({
  sections: [
    {
      title: '一、法人人格否认',
      prose: '揭开公司面纱，针对股东滥用有限责任。法人人格否认不是否认公司人格本身，而是否认股东的责任限制。它与资本维持一起构成有限责任的两条边界。适用上要求股东实施了滥用行为，并且严重损害债权人利益。这一段的长度用来检验"开头"的截断规则，写得长一点才看得出是不是真的按上限在截。'
    },
    {
      title: '二、资本维持与抽逃出资',
      prose: '资本维持要求公司在存续期间保持与其资本额相当的财产。抽逃出资是最典型的违反情形，公司法第20条与相关司法解释给出了认定标准。'
    }
  ]
})

test('受控上下文只认成品正文：概览、各节开头、术语、知识连接、元数据都在', () => {
  const source = buildBriefSourceFromFinalNote(twoSections, { lessonTitle: '第1-2节 有限责任' })
  assert.match(source, /课程：商法概论/, '课程名从前言的"课程："行里读出来')
  assert.match(source, /课次：第1-2节 有限责任/)
  assert.match(source, /## 课程概览（来自成品正文）/)
  assert.match(source, /核心问题：为什么需要法人人格否认？；资本维持与债权人保护是什么关系？/)
  assert.match(source, /应当能够：说出人格否认的适用条件。；区分资本维持与资本不变。/)
  assert.match(source, /## 各节标题与开头/)
  assert.match(source, /1. 法人人格否认/, '小节标题去掉中文章序，避免和清单编号写两遍')
  assert.match(source, /开头：这一节交代该问题的来龙去脉。 揭开公司面纱/)
  assert.match(source, /概念：法人人格否认、资本维持/)
  assert.match(source, /案例：某公司抽逃出资案/, '案例名不在正文里逐字出现，也不能丢')
  assert.match(source, /法条：公司法第20条/, '术语里的括号注解不进上下文')
  assert.match(source, /## 知识连接/)
  assert.match(source, /承接上节关于公司设立的讲述/)
  assert.match(source, /## 元数据/)
  assert.match(source, /## 附录小节（只列标题）/)
  assert.match(source, /- 课后答疑与课程事务/)
})

test('装置不进上下文：折叠块、META 原始行、自测题都不出现', () => {
  const source = buildBriefSourceFromFinalNote(twoSections, {})
  assert.ok(!source.includes('META:'), 'META 是给检索用的清单，不是给简报模型的正文')
  assert.ok(!source.includes('mermaid'), '知识地图是装置')
  assert.ok(!source.includes('参考答案'), '参考答案是复习页的东西')
  assert.ok(!source.includes('自测'), '自测是提问，不是这节课讲授了什么')
})

test('每节开头有上限也有下限，标题一个都不能少', () => {
  const many = noteMarkdown({
    sections: Array.from({ length: 24 }, (_, index) => ({
      title: `${index + 1}、第${index + 1}个小节`,
      prose: '这一节的正文写得很长，用来检验按节数摊预算时每节还能拿到多少字。'.repeat(20)
    }))
  })
  const source = buildBriefSourceFromFinalNote(many, {})
  const excerpts = [...source.matchAll(/   开头：([^\n]+)/g)].map(match => charCount(match[1]))
  assert.equal(excerpts.length, 24, '每节都要有开头，不能因为预算不够就丢掉后面几节')
  assert.ok(Math.max(...excerpts) <= BRIEF_SOURCE_BUDGET.sectionMax, `单节不得超过 ${BRIEF_SOURCE_BUDGET.sectionMax} 字`)
  assert.ok(Math.min(...excerpts) >= BRIEF_SOURCE_BUDGET.sectionMin, `单节不得低于 ${BRIEF_SOURCE_BUDGET.sectionMin} 字`)
  for (let index = 1; index <= 24; index += 1) assert.match(source, new RegExp(`${index}\\. 第${index}个小节`))
  assert.ok(charCount(source) <= BRIEF_SOURCE_BUDGET.total, `上下文不得超过 ${BRIEF_SOURCE_BUDGET.total} 字`)
})

test('受控上下文与写单元无关：同样正文，谁切的、怎么切都不影响', () => {
  const a = buildBriefSourceFromFinalNote(twoSections, { lessonTitle: 'x' })
  const b = buildBriefSourceFromFinalNote(twoSections.replace(/\r\n/g, '\n'), { lessonTitle: 'x' })
  assert.equal(a, b)
  // 老的按写单元拼的入口仍在（拿不到成品正文时兜底），但它读的是节点，形状完全不同
  const legacy = buildBriefSource({
    title: 'x',
    outline: [{ id: 'o1', title: '一、法人人格否认', lineRange: [1, 10] }],
    nodes: [{ outlineNodeId: 'o1', draft: '揭开公司面纱。' }]
  })
  assert.match(legacy, /摘要：揭开公司面纱/)
  assert.ok(!legacy.includes('## 课程概览（来自成品正文）'))
})

test('简报的指纹与身份绑在正文上：改一个字就不认', () => {
  const checksum = briefSourceChecksum(twoSections)
  assert.equal(checksum, briefSourceChecksum(twoSections.replace(/\n/g, '\r\n')), '换行风格不同不算改动')
  assert.notEqual(checksum, briefSourceChecksum(`${twoSections}\n补充一句。`))
  const brief = { course: '商法概论', lesson: '第1-2节 有限责任', sourceChecksum: checksum }
  assert.deepEqual(checkBriefBinding(brief, { course: '商法概论', lesson: '第1-2节 有限责任', markdown: twoSections }), { ok: true, bound: true, problems: [] })
})

test('几节课共用一个目录时不认错人：串课的简报必须当场拦住', () => {
  // 这是真实发生过的故障：同一个 --from 目录里放过几节课的 brief.json，谁最后写谁生效，
  // 于是几节课发布了同一段简报。绑定字段就是为了让这种情况发布不出去。
  const other = noteMarkdown({ title: '第3-4节 公司治理', sections: [{ title: '一、董事会中心主义', prose: '董事会中心主义的一段正文。' }] })
  const staleBrief = { course: '商法概论', lesson: '第1-2节 有限责任', sourceChecksum: briefSourceChecksum(twoSections) }
  const check = checkBriefBinding(staleBrief, { course: '商法概论', lesson: '第3-4节 公司治理', markdown: other })
  assert.equal(check.ok, false)
  assert.equal(check.problems.length, 2, '课次与指纹两处都要报出来')
  assert.throws(() => assertBriefBinding(staleBrief, { course: '商法概论', lesson: '第3-4节 公司治理', markdown: other }), /简报与笔记不同源/)
  // 老简报没有绑定字段：不拦（历史数据），但明确报告"未绑定"
  const legacy = checkBriefBinding({ briefing: '老的简报' }, { course: '商法概论', lesson: '第3-4节 公司治理', markdown: other })
  assert.deepEqual(legacy, { ok: true, bound: false, problems: [] })
})

test('简报这一步喂给模型的是成品正文的切片，不是写单元草稿', async () => {
  const lesson = {
    title: '第1-2节 有限责任',
    courseName: '商法概论',
    outline: [{ id: 'o1', title: '一、法人人格否认', lineRange: [1, 40] }],
    nodes: [{ outlineNodeId: 'o1', draft: '这是写单元草稿：它不该出现在简报的输入里。' }],
    finalNote: { markdown: twoSections }
  }
  let payload = null
  const brief = await generateBrief({
    lesson,
    courseSpec: { courseName: '商法概论' },
    modelConfig: {},
    callModel: async request => {
      payload = request
      return {
        parsed: {
          briefing: '这节课讲有限责任的两条边界。'.repeat(6),
          keyPoints: ['人格否认针对滥用', '资本维持保护债权人', '抽逃出资是典型情形'],
          theme: '有限责任的两条边界',
          keywords: ['法人人格否认', '资本维持', '抽逃出资']
        },
        trace: { usage: { inputTokens: 1, outputTokens: 1 } }
      }
    }
  })
  const sourceText = payload.prompt.user
  assert.match(sourceText, /## 课程概览（来自成品正文）/)
  assert.match(sourceText, /TranscriptSource/)
  assert.ok(!sourceText.includes('写单元草稿'), '写单元的草稿不能进上下文')
  assert.equal(payload.prompt.role, 'brief')
  assert.match(sourceText, new RegExp(BRIEF_SCHEMA.briefing.replace(/[（）()—]/g, '.')))
  assert.equal(brief.sourceChecksum, briefSourceChecksum(twoSections))
  assert.deepEqual(brief.keywords, ['法人人格否认', '资本维持', '抽逃出资'])
})

test('正文残缺时兜底：没有概览也能拼出上下文，空正文直接报错', () => {
  const plain = ['# 第5节', '', '> 课程：国际刑法学 · 转录 L1–L20', '', '## 一、纽约公约的适用范围', '', '公约适用于外国仲裁裁决的承认与执行。'].join('\n')
  const source = buildBriefSourceFromFinalNote(plain, {})
  assert.match(source, /课程：国际刑法学/)
  assert.match(source, /1\. 纽约公约的适用范围/)
  assert.match(source, /课程概览（来自成品正文）/)
  assert.deepEqual(parseFinalNote(plain).sections.map(section => section.title), ['一、纽约公约的适用范围'])
  assert.throws(() => buildBriefSourceFromFinalNote('   '), /正文是空的/)
})
