import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyTopicManifest,
  normalizeTopicManifest,
  removeTopicDefinition,
  replaceCourseTopics,
  selectConfiguredTopics,
  upsertTopicDefinition
} from './topic-manifest.mjs'

test('topic manifest keeps stable explicit course/topic definitions', () => {
  const manifest = normalizeTopicManifest({
    topics: [{ course: '国际刑法学', title: '国际刑事审判', lessons: ['a', 'b', 'a'] }]
  })
  assert.equal(manifest.version, 1)
  assert.equal(manifest.topics[0].id, '国际刑法学::国际刑事审判')
  assert.deepEqual(manifest.topics[0].lessons, ['a', 'b'])
})

test('replaceCourseTopics only replaces one course and upsert stays idempotent', () => {
  let manifest = normalizeTopicManifest({
    topics: [{ id: 'keep', course: '犯罪学', title: 'A', lessons: ['x'] }]
  })
  manifest = replaceCourseTopics(manifest, '国际刑法学', [
    { title: '审判', lessons: ['a'] },
    { title: '责任', lessons: ['b'] }
  ])
  assert.deepEqual(manifest.topics.map(item => item.id), ['keep', '国际刑法学::审判', '国际刑法学::责任'])

  manifest = upsertTopicDefinition(manifest, {
    id: '国际刑法学::审判', course: '国际刑法学', title: '审判制度', lessons: ['a', 'b']
  })
  assert.equal(manifest.topics.length, 3)
  assert.equal(manifest.topics.find(item => item.id === '国际刑法学::审判').title, '审判制度')
})

test('selection and deletion are exact', () => {
  let manifest = replaceCourseTopics(emptyTopicManifest(), '国际刑法学', [
    { id: 'a', title: 'A', lessons: ['1', '2'] },
    { id: 'b', title: 'B', lessons: ['3'], enabled: false }
  ])
  assert.deepEqual(selectConfiguredTopics(manifest, { course: '国际刑法学', lesson: '2' }).map(item => item.id), ['a'])
  assert.deepEqual(selectConfiguredTopics(manifest, { id: 'b', enabledOnly: false }).map(item => item.id), ['b'])
  manifest = removeTopicDefinition(manifest, 'a')
  assert.equal(manifest.removed, true)
  assert.deepEqual(manifest.topics.map(item => item.id), ['b'])
})
