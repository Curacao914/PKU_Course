import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBriefSourceFromMarkdown, cleanKeywords, validateBrief } from './brief.mjs'

test('关键词要像术语，不像目录名或者课程名', () => {
  // 用户的原话：不能泛泛而谈——《商法概论》的关键词不能写"商法"。
  // 开学第一节课的概念清单里还常混着教室、考核、助教这类事务性内容，同样要挡掉。
  const words = cleanKeywords([
    '法人人格否认', '资本维持', '抽逃出资',
    '商法', '法律制度', '重点内容', '问题',
    '教室安排', '考核方式：5%签到加95%期末开卷考试', '助教', '参考书目',
    '法人人格否认',
    '这是一个明显过长的句子片段不该当关键词'
  ], { courseName: '商法概论' })
  assert.deepEqual(words, ['法人人格否认', '资本维持', '抽逃出资'])
})

test('关键词最多六个，少给可以，给错不行', () => {
  const many = ['法人人格否认', '资本维持', '抽逃出资', '董事会中心主义', '股东代表诉讼', '资本多数决', '揭开公司面纱', '关联交易']
  assert.equal(cleanKeywords(many).length, 6)
  assert.deepEqual(cleanKeywords(['a']), [], '一个字的词不算术语')
  assert.deepEqual(cleanKeywords('不是数组'), [])
})

test('validateBrief 带出关键词，并在简报过短时照旧拦住', () => {
  const value = {
    briefing: '这节课讲有限责任的两条主线：法人人格否认与资本维持。'.repeat(3),
    keyPoints: ['人格否认针对滥用', '资本维持保护债权人', '抽逃出资是典型情形'],
    keywords: ['法人人格否认', '资本维持', '商法']
  }
  const brief = validateBrief(value, { courseName: '商法概论' })
  assert.deepEqual(brief.keywords, ['法人人格否认', '资本维持'])
  assert.throws(() => validateBrief({ briefing: '太短' }), /简报过短/)
})

test('从成品笔记也能拼出简报输入：只要标题与每节开头', () => {
  const markdown = [
    '# 第1-2节 有限责任',
    '',
    '## 课程概览',
    '',
    '引入。',
    '',
    '## 一、法人人格否认',
    '',
    '揭开公司面纱，针对股东滥用有限责任。',
    '',
    '## 二、资本维持',
    '',
    '不得抽逃出资。',
    '',
    '<details><summary>元数据</summary>',
    '<pre><code>',
    'META: CONCEPT: 法人人格否认',
    '</code></pre>',
    '</details>'
  ].join('\n')
  const source = buildBriefSourceFromMarkdown(markdown, { courseName: '商法概论', lessonTitle: '第1-2节 有限责任' })
  assert.match(source, /课程：商法概论/)
  assert.match(source, /## 课程概览（来自成品正文）/, '概览单独成块，不再混进小节清单')
  assert.match(source, /1\. 法人人格否认/, '小节标题去掉中文章序')
  assert.match(source, /2\. 资本维持/)
  assert.match(source, /揭开公司面纱/)
  assert.ok(!source.includes('META: CONCEPT'), 'META 原始行不进简报输入（术语另有独立一行）')
})
