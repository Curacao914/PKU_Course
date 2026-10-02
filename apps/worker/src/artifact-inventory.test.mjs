import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { formatInventory, scanArtifactInventory } from './artifact-inventory.mjs'

/**
 * C1：工件依赖失效记录。
 *
 * 发布时的同源校验只在发布那一刻生效；正文后来改了就没人管旧产物了。这个扫描把账算清楚：
 * 新鲜 / 失效 / 未绑定 / 孤立，四类各自有明确的判据，且**只报告不改写**。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'course-artifacts-'))

test('简报与一页纸：新鲜、失效、未绑定、孤立四类都能分出来', () => {
  const root = tmp()
  const fresh = path.join(root, 'lesson-fresh')
  const stale = path.join(root, 'lesson-stale')
  const unbound = path.join(root, 'lesson-unbound')
  const orphan = path.join(root, 'lesson-gone')
  for (const dir of [fresh, stale, unbound, orphan]) fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(path.join(fresh, 'brief.json'), JSON.stringify({ course: '刑法分论', lesson: '第1节', sourceChecksum: 'aaa111' }))
  fs.writeFileSync(path.join(fresh, 'onepage.json'), JSON.stringify({ course: '刑法分论', lesson: '第1节', sourceChecksum: 'aaa111' }))
  fs.writeFileSync(path.join(stale, 'brief.json'), JSON.stringify({ course: '刑法分论', lesson: '第2节', sourceChecksum: 'bbb222' }))
  fs.writeFileSync(path.join(unbound, 'onepage.json'), JSON.stringify({ course: '刑法分论', lesson: '第3节' }))
  fs.writeFileSync(path.join(orphan, 'brief.json'), JSON.stringify({ course: '刑法分论', lesson: '已删除的一节', sourceChecksum: 'ccc333' }))

  const records = [
    { slug: 'notes/刑法分论/第1节', courseName: '刑法分论', lessonTitle: '第1节', checksum: 'aaa111' },
    { slug: 'notes/刑法分论/第2节', courseName: '刑法分论', lessonTitle: '第2节', checksum: 'bbb999' },
    { slug: 'notes/刑法分论/第3节', courseName: '刑法分论', lessonTitle: '第3节', checksum: 'ddd444' }
  ]
  const inventory = scanArtifactInventory({ dirs: [fresh, stale, unbound, orphan], records, checksumOf: record => record.checksum })
  assert.equal(inventory.total, 5)
  assert.deepEqual(inventory.counts, { fresh: 2, stale: 1, unbound: 1, orphan: 1 })

  const byStatus = status => inventory.items.filter(item => item.status === status)
  assert.equal(byStatus('stale')[0].lessonTitle, '第2节')
  assert.equal(byStatus('stale')[0].boundChecksum, 'bbb222')
  assert.equal(byStatus('stale')[0].currentChecksum, 'bbb999', '要同时给出"绑在哪一版"和"现在是哪一版"')
  assert.equal(byStatus('unbound')[0].kind, 'onepage')
  assert.equal(byStatus('orphan')[0].lessonTitle, '已删除的一节')

  const text = formatInventory(inventory)
  assert.match(text, /共 5 件/)
  assert.match(text, /\[stale\] brief 刑法分论 · 第2节/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('章级整合：逐个课次比指纹，任何一节变了就算失效', () => {
  const root = tmp()
  const dir = path.join(root, 'integrations')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '刑事执行法-主题.json'), JSON.stringify({
    kind: 'course-integration',
    course: '刑事执行法',
    lessons: [
      { slug: 'notes/刑事执行法/A', lessonTitle: 'A', checksum: 'sum-a', contentFingerprint: 'fp-a' },
      { slug: 'notes/刑事执行法/B', lessonTitle: 'B', checksum: 'sum-b', contentFingerprint: 'fp-b' }
    ]
  }))
  const records = [
    { slug: 'notes/刑事执行法/A', courseName: '刑事执行法', lessonTitle: 'A', checksum: 'sum-a' },
    { slug: 'notes/刑事执行法/B', courseName: '刑事执行法', lessonTitle: 'B', checksum: 'sum-b-changed' }
  ]
  const inventory = scanArtifactInventory({ dirs: [], records, integrationDir: dir })
  assert.equal(inventory.total, 1)
  assert.equal(inventory.items[0].kind, 'integration')
  assert.equal(inventory.items[0].status, 'stale')
  assert.deepEqual(inventory.items[0].staleLessons, ['B'])
  assert.match(formatInventory(inventory), /B 的正文变了/)

  // 课次从库里消失也算失效（不是"新鲜"）
  const gone = scanArtifactInventory({ dirs: [], records: [records[0]], integrationDir: dir })
  assert.equal(gone.items[0].status, 'stale')
  assert.deepEqual(gone.items[0].staleLessons, ['B'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('空仓库也有话说（不报错）', () => {
  const root = tmp()
  const inventory = scanArtifactInventory({ dirs: [root], records: [] })
  assert.equal(inventory.total, 0)
  assert.match(formatInventory(inventory), /还没发现任何派生视图/)
  fs.rmSync(root, { recursive: true, force: true })
})
test('指纹口径：简报的 sourceChecksum 是**规范化**指纹，不能拿发布库里的原始字节 checksum 比', () => {
  // 这是我自己踩过的坑：拿 record.checksum（原始字节）去比 brief.sourceChecksum（规范化），
  // 结果所有简报都被报成"失效"——而发布时的判定（checkBriefBinding）比的正是规范化那一个。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-artifacts-'))
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify({ course: '刑法分论', lesson: '第1节', sourceChecksum: 'normalized-1' }))
  const records = [{ slug: 'notes/刑法分论/第1节', courseName: '刑法分论', lessonTitle: '第1节', checksum: 'raw-bytes-9', markdown: '正文' }]

  const wrongPair = scanArtifactInventory({ dirs: [dir], records })
  assert.equal(wrongPair.items[0].status, 'stale', '比错了对就会误报失效（记录下这个形状）')

  const rightPair = scanArtifactInventory({ dirs: [dir], records, checksumOf: () => 'normalized-1' })
  assert.equal(rightPair.items[0].status, 'fresh', '与发布时同一个口径 —— 才是真的同源')
  fs.rmSync(dir, { recursive: true, force: true })
})



test('configured integration missing from disk is reported instead of disappearing from inventory', () => {
  const root = temp()
  const integrationDir = path.join(root, 'integrations')
  fs.mkdirSync(integrationDir, { recursive: true })
  const inventory = scanArtifactInventory({
    dirs: [],
    records: [],
    integrationDir,
    configuredIntegrations: [{
      id: '刑事执行法::罪刑均衡',
      course: '刑事执行法',
      topic: '罪刑均衡',
      lessons: ['09-07', '09-14'],
      enabled: true
    }]
  })
  assert.equal(inventory.counts.missing, 1)
  const item = inventory.items.find(entry => entry.status === 'missing')
  assert.equal(item.kind, 'integration')
  assert.equal(item.integrationId, '刑事执行法::罪刑均衡')
  assert.match(formatInventory(inventory), /长期整合清单要求存在/)
})
