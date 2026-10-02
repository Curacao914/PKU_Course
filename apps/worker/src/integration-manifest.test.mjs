import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyIntegrationManifest,
  normalizeIntegrationManifest,
  selectConfiguredIntegrations,
  upsertIntegrationDefinition
} from './integration-manifest.mjs'

test('integration manifest normalizes stable explicit lesson groups', () => {
  const manifest = normalizeIntegrationManifest({
    integrations: [{
      course: '刑事执行法',
      topic: '罪刑均衡与以刑制罪',
      lessons: ['09-07', '09-14', '09-14', '09-21']
    }]
  })
  assert.equal(manifest.version, 1)
  assert.equal(manifest.integrations[0].id, '刑事执行法::罪刑均衡与以刑制罪')
  assert.deepEqual(manifest.integrations[0].lessons, ['09-07', '09-14', '09-21'])
  assert.equal(manifest.integrations[0].enabled, true)
})

test('upsert replaces the same id instead of growing duplicate definitions', () => {
  let manifest = emptyIntegrationManifest()
  manifest = upsertIntegrationDefinition(manifest, {
    id: 'criminal-execution-balance',
    course: '刑事执行法',
    topic: '罪刑均衡',
    lessons: ['A', 'B']
  })
  manifest = upsertIntegrationDefinition(manifest, {
    id: 'criminal-execution-balance',
    course: '刑事执行法',
    topic: '罪刑均衡与以刑制罪',
    lessons: ['A', 'B', 'C']
  })
  assert.equal(manifest.integrations.length, 1)
  assert.equal(manifest.integrations[0].topic, '罪刑均衡与以刑制罪')
  assert.deepEqual(manifest.integrations[0].lessons, ['A', 'B', 'C'])
})

test('affected selection is exact: a changed lesson only refreshes integrations containing it', () => {
  const manifest = normalizeIntegrationManifest({
    integrations: [
      { id: 'a', course: '刑事执行法', topic: 'A', lessons: ['09-07', '09-14'] },
      { id: 'b', course: '刑事执行法', topic: 'B', lessons: ['09-21'] },
      { id: 'c', course: '商法概论', topic: 'C', lessons: ['09-14'] },
      { id: 'off', course: '刑事执行法', topic: '关闭', lessons: ['09-14'], enabled: false }
    ]
  })
  assert.deepEqual(
    selectConfiguredIntegrations(manifest, { course: '刑事执行法', lesson: '09-14' }).map(item => item.id),
    ['a']
  )
  assert.deepEqual(selectConfiguredIntegrations(manifest, { id: 'b' }).map(item => item.id), ['b'])
})

test('bad definitions fail early instead of silently broadening the chapter scope', () => {
  assert.throws(
    () => normalizeIntegrationManifest({ integrations: [{ course: '刑事执行法', topic: '主题', lessons: [] }] }),
    /至少要固定一个课次/
  )
  assert.throws(
    () => normalizeIntegrationManifest({
      integrations: [
        { id: 'same', course: 'A', topic: 'A', lessons: ['1'] },
        { id: 'same', course: 'B', topic: 'B', lessons: ['2'] }
      ]
    }),
    /id 重复/
  )
})
