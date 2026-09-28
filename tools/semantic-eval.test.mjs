import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildUnits, makeEmbedder, runExperiment } from './semantic-eval.mjs'

/**
 * B1：语义召回实验骨架的自测。
 *
 * 骨架的价值在于"管道与预算是可验证的"：单元怎么切、指纹怎么当缓存键、
 * 花钱的 provider 有没有闸门、指标怎么算。模型效果不在这里断言——stub 不代表语义。
 */

const RECORDS = [
  {
    slug: 'notes/甲/第一讲',
    courseName: '甲',
    lessonTitle: '第一讲',
    markdown: ['## 一、归因', '', '归因是把行为归于国家的第一步。', '', '## 二、赔偿', '', '赔偿是后果。'].join('\n'),
    sections: [
      { id: '一-归因', title: '一、归因', level: 2, chars: 16, fingerprint: 'aaaa1111' },
      { id: '二-赔偿', title: '二、赔偿', level: 2, chars: 7, fingerprint: 'bbbb2222' }
    ]
  }
]

test('单元 = 小节：带指纹（缓存键），老库自动退回现切', () => {
  const withSections = buildUnits(RECORDS)
  assert.equal(withSections.length, 2)
  assert.equal(withSections[0].sectionId, '一-归因')
  assert.equal(withSections[0].fingerprint, 'aaaa1111', '指纹就是"要不要重新向量化"的判据')
  assert.match(withSections[0].text, /归因是把行为归于国家的第一步/)

  const legacy = buildUnits([{ ...RECORDS[0], sections: undefined }])
  assert.equal(legacy.length, 2, '没有 sections 的老库按正文现切，同样能测')
  assert.equal(legacy[0].fingerprint, '')
})

test('花钱的 provider 必须显式开闸（预算纪律）', () => {
  delete process.env.COURSE_EMBED_ALLOW_PAID
  assert.throws(() => makeEmbedder('dashscope'), /ALLOW_PAID/)
  process.env.COURSE_EMBED_ALLOW_PAID = '1'
  assert.throws(() => makeEmbedder('dashscope'), /还没接/, '开闸了也只是报"还没接"，不会偷偷花钱')
  delete process.env.COURSE_EMBED_ALLOW_PAID
  assert.equal(makeEmbedder('local-stub').provider, 'local-stub')
})

test('评测：开发集与冻结集分开统计，冻结集只报告', async () => {
  const records = [
    ...RECORDS,
    {
      slug: 'notes/乙/第一讲',
      courseName: '乙',
      lessonTitle: '第一讲',
      markdown: ['## 一、企业为什么存在', '', '因为交易成本，企业替代市场。'].join('\n')
    }
  ]
  const report = await runExperiment({
    records,
    queries: [
      { query: '企业为什么存在', expect: ['notes/乙/第一讲'], report: false },
      { query: '归因是什么意思', expect: ['notes/甲/第一讲'], report: true }
    ],
    provider: 'local-stub'
  })
  assert.equal(report.units, 3)
  assert.equal(report.development.total, 1)
  assert.equal(report.frozen.total, 1, '冻结集单独统计，绝不混进开发集')
  assert.equal(report.frozen.total && report.results.find(item => item.report).report, true)
  assert.ok(report.indexCostCny === 0, 'stub 不产生费用')
  assert.ok(report.queryCostCny === 0)
})
