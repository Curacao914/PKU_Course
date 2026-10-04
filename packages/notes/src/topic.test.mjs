import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkTopicSources,
  normalizeSourceRefs,
  normalizeTopicArtifact,
  sourceRefHref,
  topicSourceStats
} from './topic.mjs'

const records = [
  {
    slug: 'notes/国际刑法学/2026-09-23第10-12节',
    sections: [
      { id: '胜者正义', title: '胜者正义' },
      { id: '罪刑法定', title: '罪刑法定' }
    ]
  },
  {
    slug: 'notes/国际刑法学/2026-09-16第10-12节',
    sections: [
      { id: '纽伦堡审判', title: '纽伦堡审判' }
    ]
  }
]

test('sourceRefs 用 slug + sectionId 去重并能生成原文锚点链接', () => {
  const refs = normalizeSourceRefs([
    { slug: records[0].slug, sectionId: '胜者正义', title: '胜者正义' },
    { slug: records[0].slug, anchor: '胜者正义' }
  ])
  assert.equal(refs.length, 1)
  assert.equal(
    sourceRefHref(refs[0]),
    '/notes/国际刑法学/2026-09-23第10-12节.html#%E8%83%9C%E8%80%85%E6%AD%A3%E4%B9%89'
  )
})

test('专题只有一份节点树：关系、提纲和自测都从同一数据派生', () => {
  const topic = normalizeTopicArtifact({
    course: '国际刑法学',
    title: '国际刑事审判的正当性',
    lessons: records.map(item => ({ slug: item.slug })),
    nodes: [{
      title: '正当性质疑',
      relation: 'hierarchy',
      children: [
        {
          title: '胜者正义',
          relation: 'contrast',
          sourceRefs: [{ slug: records[0].slug, sectionId: '胜者正义' }]
        },
        {
          title: '溯及既往',
          relation: 'exception',
          sourceRefs: [{ slug: records[0].slug, sectionId: '罪刑法定' }]
        }
      ]
    }]
  })

  assert.equal(topic.kind, 'course-topic')
  assert.equal(topic.nodes[0].children[0].relation, 'contrast')
  assert.equal(topic.nodes[0].children[1].relation, 'exception')
  assert.deepEqual(checkTopicSources(topic, records), [])
  assert.deepEqual(topicSourceStats(topic), { nodes: 3, sourcedNodes: 2, refs: 2, coverage: 2 / 3 })
})

test('分组节点可无出处，但叶节点必须能回到真实课次和小节', () => {
  const base = {
    course: '国际刑法学',
    title: '测试专题',
    lessons: records.map(item => item.slug)
  }

  const noSource = normalizeTopicArtifact({
    ...base,
    nodes: [{ title: '第一层', children: [{ title: '没有出处的知识点' }] }]
  })
  assert.equal(checkTopicSources(noSource, records)[0].code, 'missing-source')

  const badSection = normalizeTopicArtifact({
    ...base,
    nodes: [{ title: '第一层', children: [{
      title: '错误落点',
      sourceRefs: [{ slug: records[1].slug, sectionId: '不存在' }]
    }] }]
  })
  assert.equal(checkTopicSources(badSection, records)[0].code, 'missing-section')
})

test('专题拒绝没有课程、课次或节点的空壳', () => {
  assert.throws(() => normalizeTopicArtifact({ title: 'A', lessons: ['x'], nodes: [{ title: 'n', sourceRefs: [{ slug: 'x', sectionId: 'a' }] }] }), /缺课程/)
  assert.throws(() => normalizeTopicArtifact({ course: 'A', title: 'B', nodes: [{ title: 'n', sourceRefs: [{ slug: 'x', sectionId: 'a' }] }] }), /至少要覆盖一个课次/)
  assert.throws(() => normalizeTopicArtifact({ course: 'A', title: 'B', lessons: ['x'] }), /至少要有一个框架节点/)
})
