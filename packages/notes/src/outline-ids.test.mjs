import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBriefSource } from './brief.mjs'
import { coversOutline, isMergedWriteUnit, outlineIdsOf, primaryOutlineIdOf } from './outline-ids.mjs'
import { splicePlaceholderContext } from './task-runner.mjs'
import { getNextCourseWorkerTasks } from './worker-tasks.mjs'

/**
 * P0 回归：合并写单元的语义继承。
 *
 * 一次模型调用写完多个模块时（writeUnits=1），节点上只有 outlineNodeId=第一个模块，
 * 完整覆盖范围在 outlineNodeIds。历史实现有几处只读 outlineNodeId，导致：
 *   brief 摘要被第一个模块支配；writer 的结构表只把第一模块标成"正在写"；
 *   接缝上下文里其余模块一个已批准节点都没有。
 * 正文本身一直是对的（装配读 outlineNodeIds），所以症状很隐蔽。
 *
 * 这组测试按真实形态构造：outline=o1..o4，一个合并节点覆盖四个模块。
 */

const OUTLINE = [
  { id: 'o1', title: '一、总论', lineRange: [1, 100], kind: 'content' },
  { id: 'o2', title: '二、构成要件', lineRange: [101, 200], kind: 'content' },
  { id: 'o3', title: '三、典型案例', lineRange: [201, 300], kind: 'content' },
  { id: 'o4', title: '四、实务争议', lineRange: [301, 400], kind: 'content' }
]

const MERGED_NODE = {
  id: 'write-1',
  outlineNodeId: 'o1',                       // 只代表第一个模块
  outlineNodeIds: ['o1', 'o2', 'o3', 'o4'],  // 真正的覆盖范围
  title: '一、总论',
  status: 'node_approved',
  kind: 'content',
  draft: [
    '<!-- META',
    'CONCEPT: 归因',
    '-->',
    '## 一、总论',
    '总论部分讲清了问题的来龙去脉与本节要解决的问题。',
    '## 二、构成要件',
    '构成要件分为归因、违反义务与赔偿三步。',
    '## 三、典型案例',
    '典型案例说明了三步如何落地。',
    '## 四、实务争议',
    '实务争议集中在赔偿范围与举证责任。'
  ].join('\n'),
  concepts: ['归因'],
  statutes: ['《国家责任条款》第2条'],
  cases: ['尼加拉瓜案'],
  writerBrief: { currentNodeGoal: '把四个模块一次写完：总论 → 要件 → 案例 → 争议' }
}

const lesson = () => ({
  title: '第一课 国家责任的构成',
  status: 'node_writing',
  transcript: Array.from({ length: 400 }, (_, index) => `L${index + 1} 转录内容`).join('\n'),
  outline: OUTLINE,
  outlineMainLine: '从归因到赔偿',
  nodes: [MERGED_NODE],
  finalNote: { assembly: { spliceData: { courseOverview: { coreQuestions: ['归因怎么认定'], shouldBeAbleTo: ['判断归因'], lectureThread: '要件—案例—争议' } } } }
})

test('outlineIdsOf：合并节点返回全部模块，普通节点返回单元素', () => {
  assert.deepEqual(outlineIdsOf(MERGED_NODE), ['o1', 'o2', 'o3', 'o4'])
  assert.deepEqual(outlineIdsOf({ outlineNodeId: 'o1' }), ['o1'])
  assert.deepEqual(outlineIdsOf({ outlineNodeId: 'o1', outlineNodeIds: [] }), ['o1'], '空数组退回单值')
  assert.deepEqual(outlineIdsOf({ outlineNodeId: 'o1', outlineNodeIds: ['o2', 'o2', 'o1'] }), ['o2', 'o1'], '去重且保序')
  assert.deepEqual(outlineIdsOf({}), [], '什么都没有时返回空数组')
  assert.equal(primaryOutlineIdOf(MERGED_NODE), 'o1', '主模块仍是第一个（只用于展示）')
  assert.equal(isMergedWriteUnit(MERGED_NODE), true)
  assert.equal(isMergedWriteUnit({ outlineNodeId: 'o1' }), false)
  assert.equal(coversOutline(MERGED_NODE, 'o3'), true, '覆盖判定要认全部模块')
  assert.equal(coversOutline({ outlineNodeId: 'o1' }, 'o3'), false)
})

test('brief 输入：合并写单元时四个模块都要有摘要（原来只有第一个）', () => {
  const source = buildBriefSource(lesson())
  for (const node of OUTLINE) {
    assert.ok(source.includes(node.title), `简报输入缺少模块：${node.title}`)
  }
  const digests = source.split('\n').filter(line => line.includes('摘要：'))
  assert.equal(digests.length, 4, '四个模块都要带摘要行，实际：' + JSON.stringify(digests))
  for (const text of ['总论部分讲清了', '构成要件分为', '典型案例说明了', '实务争议集中在']) {
    assert.ok(source.includes(text), `摘要内容缺失：${text}`)
  }
})

test('接缝上下文：合并写单元时四个模块都挂上已批准节点与术语', () => {
  const context = splicePlaceholderContext(lesson())
  for (const node of OUTLINE) {
    const at = context.indexOf(`### ${node.title}`)
    assert.ok(at >= 0, `接缝上下文缺少小节：${node.title}`)
    const sectionEnd = context.indexOf('\n***', at)
    const section = context.slice(at, sectionEnd < 0 ? undefined : sectionEnd)
    assert.ok(section.includes('已批准节点'), `${node.title} 没有挂上任何已批准节点`)
  }
  // 元数据条目要按模块出现四次（原来只出现在 o1 下）
  assert.equal((context.match(/- CONCEPT: 归因/g) || []).length, 4)
  assert.equal((context.match(/- CASE: 尼加拉瓜案/g) || []).length, 4)
})

test('writer 结构表：四个模块都要标成"正在写"，且都有写作目标', () => {
  const workflow = {
    status: 'running',
    courseSpec: { maxAutoRevisions: 2 },
    lessons: [lesson()]
  }
  // 让工作流认为该写这个节点：清掉草稿状态，交给任务推导
  workflow.lessons[0].status = 'node_pending'
  workflow.lessons[0].nodes[0] = { ...MERGED_NODE, status: 'node_pending', draft: '' }
  const tasks = getNextCourseWorkerTasks(workflow)
  const write = tasks.find(task => task.type === 'write-node')
  assert.ok(write, '应当推导出 write-node 任务，实际：' + JSON.stringify(tasks.map(task => task.type)))
  const structure = write.node?.writerBrief?.lessonStructure
  assert.ok(Array.isArray(structure), '写作任务里应当带上 lessonStructure')
  assert.equal(structure.length, 4)
  assert.deepEqual(structure.map(item => item.isCurrent), [true, true, true, true],
    '合并写单元覆盖的四个模块都应标成正在写')
  for (const item of structure) {
    assert.match(item.goal, /四个模块一次写完/, `${item.title} 的目标应来自该写单元的 writerBrief`)
  }
})
