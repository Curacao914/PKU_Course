import assert from 'node:assert/strict'
import test from 'node:test'

import {
  derivedBinding, markdownBytesChecksum, markdownChecksum, normalizeMarkdown, verifyDerived
} from './derived.mjs'

const MARKDOWN = '# 2026-09-20第2-4节\n\n## 课程概览\n\n正文。\n'
const identity = { courseName: '商法概论', lessonTitle: '2026-09-20第2-4节', replayKey: 'replay-1', checksum: markdownChecksum(MARKDOWN) }

test('指纹是 sha256，稳定的 64 位十六进制', () => {
  assert.equal(markdownChecksum(MARKDOWN), markdownChecksum(MARKDOWN))
  assert.match(markdownChecksum(MARKDOWN), /^[0-9a-f]{64}$/)
  // 与标准 sha256 同值（没有可规范化的空白时，两个函数必须给出同一个值）
  assert.equal(markdownChecksum('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(markdownChecksum('abc'), markdownBytesChecksum('abc'))
})

test('指纹对「同一段文字的轻微差别」免疫，但改一个字必须不同', () => {
  // 生成侧读的是笔记文件，校验侧用发布库里的 markdown 字段：两边差一个结尾换行是常态
  // （运维脚本写过 record.markdown + '\n'，scp / 编辑器也会补一个）。
  // 原始字节的散列会把这种差别判成 stale_source 直接中止发布——校验一旦误伤就会被人关掉。
  const text = '# 2026-09-20第2-4节\n\n## 课程概览\n\n正文。'
  const variants = [
    text,
    text + '\n',
    text + '\n\n',
    text.replace(/\n/g, '\r\n') + '\r\n',
    text + '   \n'
  ]
  const stamps = variants.map(markdownChecksum)
  assert.equal(new Set(stamps).size, 1, '带不带结尾换行、LF 还是 CRLF，都必须是同一个指纹')
  assert.equal(stamps[0], markdownChecksum(text), '与不加工的那一份相同')

  // 改一个字就不行（校验的意义所在）
  assert.notEqual(markdownChecksum(text.replace('正文。', '正文！')), stamps[0])
  assert.notEqual(markdownChecksum(text.replace('第2-4节', '第2-5节')), stamps[0])

  // 规范化本身：CRLF → LF，去掉结尾空白（与 @course/notes 的 briefSourceChecksum 同口径）
  assert.equal(normalizeMarkdown('a\r\nb\r\n'), 'a\nb')
  assert.equal(normalizeMarkdown('a\n\n  '), 'a')
  assert.equal(normalizeMarkdown(''), '')
  assert.equal(normalizeMarkdown(null), '')

  // 发布库记录的 checksum（变更判定 / 通知幂等键）仍然按原始字节：口径不同，名字也不同
  assert.equal(markdownBytesChecksum(text), markdownBytesChecksum(text))
  assert.notEqual(markdownBytesChecksum(text), markdownBytesChecksum(text + '\n'), '这一份是「内容变没变」，多一个换行算变过')
  assert.equal(markdownBytesChecksum('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
test('生成侧写进派生物的绑定字段', () => {
  const binding = derivedBinding({ markdown: MARKDOWN, courseName: '商法概论', lessonTitle: '2026-09-20第2-4节', replayKey: 'replay-1', generatedAt: '2026-09-25T00:00:00.000Z' })
  assert.deepEqual(binding, {
    course: '商法概论',
    lesson: '2026-09-20第2-4节',
    replayKey: 'replay-1',
    sourceChecksum: markdownChecksum(MARKDOWN),
    generatedAt: '2026-09-25T00:00:00.000Z'
  })
  const check = verifyDerived(binding, identity)
  assert.equal(check.ok, true)
  assert.equal(check.bound, true)
  assert.deepEqual(check.problems, [])
})

test('对得上才 ok；对不上时给出人话的 problems 与逐项 checks', () => {
  const ok = verifyDerived(derivedBinding({ markdown: MARKDOWN, courseName: '商法概论', lessonTitle: '2026-09-20第2-4节', replayKey: 'replay-1' }), identity)
  assert.deepEqual(ok.checks, { course: 'match', lesson: 'match', replayKey: 'match', sourceChecksum: 'match' })
  assert.equal(ok.reason, 'ok')

  // 正文改了一个字 → 指纹对不上（这是"旧派生物被挂上去"的主要路径）
  const stale = verifyDerived(derivedBinding({ markdown: MARKDOWN + '补一句。', courseName: '商法概论', lessonTitle: '2026-09-20第2-4节', replayKey: 'replay-1' }), identity)
  assert.equal(stale.ok, false)
  assert.equal(stale.bound, true)
  assert.equal(stale.reason, 'stale_source')
  assert.match(stale.problems[0], /来源指纹与要发布的笔记正文不符/)

  // 同一个 --from 目录里放着另一节课的派生物：课程/课次/回放键就会露馅
  const otherLesson = verifyDerived({ ...derivedBinding({ markdown: MARKDOWN }), lesson: '2026-09-07第5-6节' }, identity)
  assert.equal(otherLesson.ok, false)
  assert.equal(otherLesson.reason, 'identity_mismatch')
  assert.match(otherLesson.problems[0], /课次不符（文件是 2026-09-07第5-6节，要发布的是 2026-09-20第2-4节）/)
  assert.equal(verifyDerived({ ...derivedBinding({ markdown: MARKDOWN }), course: '民事诉讼法' }, identity).reason, 'identity_mismatch')
  assert.equal(verifyDerived({ ...derivedBinding({ markdown: MARKDOWN }), replayKey: 'replay-2' }, identity).reason, 'replaykey_mismatch')

  assert.equal(verifyDerived(null, identity).ok, false)
  assert.equal(verifyDerived([], identity).reason, 'unreadable')
})

test('老数据没有绑定字段：不拦，只标成 unbound 让调用方提示一句', () => {
  const legacy = verifyDerived({ course: '商法概论', briefing: '老简报' }, identity)
  assert.equal(legacy.ok, true, '没有绑定字段的老文件不拦（与 checkBriefBinding 同一口径）')
  assert.equal(legacy.bound, false)
  assert.equal(legacy.reason, 'unbound')
  assert.equal(legacy.checks.sourceChecksum, 'absent')

  // 没记 replayKey（生成时没传）不算不一致：指纹才是硬条件
  const withoutReplay = verifyDerived(derivedBinding({ markdown: MARKDOWN, courseName: '商法概论', lessonTitle: '2026-09-20第2-4节' }), identity)
  assert.equal(withoutReplay.ok, true)
  assert.equal(withoutReplay.bound, true)
  assert.equal(withoutReplay.checks.replayKey, 'absent')
})
