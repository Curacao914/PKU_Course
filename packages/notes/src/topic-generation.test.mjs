import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTopicPlanningSource,
  generateTopicArtifact,
  normalizeTopicPlan,
  planCourseTopics
} from './topic-generation.mjs'

const records = [
  {
    courseName: '国际刑法学',
    lessonTitle: '第1讲',
    lessonDate: '2026-09-09',
    slug: 'notes/国际刑法学/第1讲',
    theme: '国际刑法的基础',
    keywords: ['国际犯罪', '管辖'],
    summary: '介绍国际刑法的基本问题。',
    checksum: 'a1',
    sections: [
      { id: '国际犯罪', title: '国际犯罪' },
      { id: '管辖', title: '管辖' }
    ],
    markdown: '## 国际犯罪\n\n国际犯罪的定义。\n\n## 管辖\n\n管辖的基本规则。'
  },
  {
    courseName: '国际刑法学',
    lessonTitle: '第2讲',
    lessonDate: '2026-09-16',
    slug: 'notes/国际刑法学/第2讲',
    theme: '国际刑事审判',
    keywords: ['纽伦堡审判', '胜者正义'],
    summary: '围绕国际刑事审判的正当性展开。',
    checksum: 'b2',
    sections: [
      { id: '纽伦堡审判', title: '纽伦堡审判' },
      { id: '胜者正义', title: '胜者正义' }
    ],
    markdown: '## 纽伦堡审判\n\n审判制度。\n\n## 胜者正义\n\n胜者正义的争议。'
  }
]

test('planning source only carries course index/summary, not full lesson bodies', () => {
  const source = buildTopicPlanningSource({ records, course: '国际刑法学' })
  assert.match(source, /slug=notes\/国际刑法学\/第1讲/)
  assert.match(source, /主题：国际刑法的基础/)
  assert.doesNotMatch(source, /国际犯罪的定义/, '划专题阶段不应把全文塞给模型')
})

test('topic plan requires exact slugs and complete lesson coverage', () => {
  const topics = normalizeTopicPlan({
    topics: [
      { title: '基础', lessons: [records[0].slug] },
      { title: '审判', lessons: [records[1].slug] }
    ]
  }, { records, course: '国际刑法学' })
  assert.equal(topics.length, 2)
  assert.throws(() => normalizeTopicPlan({
    topics: [{ title: '只覆盖一半', lessons: [records[0].slug] }]
  }, { records, course: '国际刑法学' }), /没有覆盖全部课次/)
  assert.throws(() => normalizeTopicPlan({
    topics: [{ title: '错', lessons: ['不存在'] }]
  }, { records, course: '国际刑法学' }), /不存在的课次/)
})

test('planCourseTopics is one index-level model call', async () => {
  const calls = []
  const result = await planCourseTopics({
    records,
    course: '国际刑法学',
    callModel: async payload => {
      calls.push(payload)
      return {
        parsed: {
          topics: [
            { title: '国际刑法基础', summary: '基础问题', lessons: [records[0].slug] },
            { title: '国际刑事审判', summary: '审判正当性', lessons: [records[1].slug] }
          ]
        },
        trace: { ok: true }
      }
    }
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'topicPlan')
  assert.equal(result.topics.length, 2)
})

test('generateTopicArtifact reads only selected lessons and retries bad sourceRefs once', async () => {
  const calls = []
  const definition = {
    id: '国际刑法学::国际刑事审判',
    course: '国际刑法学',
    title: '国际刑事审判',
    summary: '审判正当性',
    lessons: [records[1].slug]
  }
  const result = await generateTopicArtifact({
    records,
    definition,
    generatedAt: '2026-10-04T00:00:00.000Z',
    callModel: async payload => {
      calls.push(payload)
      if (calls.length === 1) {
        return {
          parsed: {
            nodes: [{
              title: '正当性质疑',
              children: [{ title: '胜者正义', sourceRefs: [{ slug: records[1].slug, sectionId: '不存在' }] }]
            }]
          },
          trace: { attempt: 1 }
        }
      }
      return {
        parsed: {
          summary: '围绕国际刑事审判的正当性组织。',
          nodes: [{
            title: '正当性质疑',
            children: [{
              title: '胜者正义',
              relation: 'contrast',
              sourceRefs: [{ slug: records[1].slug, sectionId: '胜者正义', title: '胜者正义' }]
            }]
          }]
        },
        trace: { attempt: 2 }
      }
    }
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].role, 'topic')
  assert.match(calls[0].prompt.user, /胜者正义的争议/)
  assert.doesNotMatch(calls[0].prompt.user, /国际犯罪的定义/, '逐专题生成不应读取未选课次全文')
  assert.match(calls[1].prompt.user, /上一版被退回/)
  assert.equal(result.artifact.lessons[0].checksum, 'b2')
  assert.equal(result.artifact.nodes[0].children[0].sourceRefs[0].sectionId, '胜者正义')
})
