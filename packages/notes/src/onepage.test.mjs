import assert from 'node:assert/strict'
import test from 'node:test'

import { generateOnepage } from './onepage.mjs'

const NOTE = [
  '# 测试课次',
  '',
  '## 核心规则',
  '',
  '这里是原笔记正文，用来给一页纸提供唯一素材。',
  '来源摘录必须逐字来自这里。'
].join('\n')

const PAGE = [
  '## 核心规则',
  '',
  ...Array.from({ length: 28 }, (_, index) => `- 要点${index + 1}：围绕规则、条件、例外与结论进行复习。`)
].join('\n')

test('generateOnepage：正文合格但 sourceMap 为空时自动重试一次', async () => {
  const calls = []
  const callModel = async payload => {
    calls.push(payload)
    if (calls.length === 1) {
      return {
        parsed: { title: '测试', markdown: PAGE, outline: ['核心规则'], sourceMap: [] },
        trace: { attempt: 1 }
      }
    }
    return {
      parsed: {
        title: '测试',
        markdown: PAGE,
        outline: ['核心规则'],
        sourceMap: [{
          block: '核心规则',
          label: '核心规则',
          sections: [{ id: '核心规则', title: '核心规则', quote: '来源摘录必须逐字来自这里' }]
        }]
      },
      trace: { attempt: 2 }
    }
  }

  const result = await generateOnepage({
    markdown: NOTE,
    courseName: '测试课',
    lessonTitle: '第1讲',
    sections: [{ id: '核心规则', title: '核心规则' }],
    callModel,
    modelConfig: {}
  })

  assert.equal(calls.length, 2)
  assert.equal(result.attempts, 2)
  assert.equal(result.sourceMap.length, 1)
  assert.match(calls[1].prompt.user, /sourceMap 为空/)
})

test('generateOnepage：sourceMap 重试后仍为空时保留合格正文，不无限重试', async () => {
  let calls = 0
  const result = await generateOnepage({
    markdown: NOTE,
    courseName: '测试课',
    lessonTitle: '第1讲',
    sections: [{ id: '核心规则', title: '核心规则' }],
    callModel: async () => {
      calls += 1
      return {
        parsed: { title: '测试', markdown: PAGE, outline: ['核心规则'], sourceMap: [] },
        trace: { attempt: calls }
      }
    },
    modelConfig: {}
  })

  assert.equal(calls, 2)
  assert.equal(result.sourceMap.length, 0)
  assert.equal(result.attempts, 2)
})
