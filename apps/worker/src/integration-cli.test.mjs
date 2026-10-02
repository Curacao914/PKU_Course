import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './cli.mjs'

const record = (title, date, checksum, body) => ({
  slug: `notes/刑事执行法/${title}`,
  courseName: '刑事执行法',
  lessonTitle: title,
  lessonDate: date,
  checksum,
  markdown: [
    `# ${title}`,
    '',
    '## 一、罪刑均衡是什么？',
    '',
    body
  ].join('\n'),
  sections: [{ id: '一-罪刑均衡是什么', title: '一、罪刑均衡是什么？', level: 2, fingerprint: checksum }],
  metadata: { concepts: ['罪刑均衡'], statutes: [], cases: [], keywords: [] },
  anchors: { concepts: { 罪刑均衡: '一-罪刑均衡是什么' }, statutes: {}, cases: {} }
})

function harness(root) {
  const lines = []
  const errors = []
  return {
    lines,
    errors,
    deps: {
      env: {},
      configOverrides: { scratchRoot: root },
      stdout: line => lines.push(String(line)),
      stderr: line => errors.push(String(line)),
      now: () => new Date('2026-10-02T00:00:00Z'),
      which: async () => '',
      runPython: async () => ({ code: 0, stdout: '', stderr: '' }),
      acquire: async () => { throw new Error('integrate test must not acquire browser') }
    }
  }
}

test('integrate --save freezes the resolved lessons; --configured rebuilds from that manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-integrate-cli-'))
  const site = path.join(root, 'site')
  fs.mkdirSync(site, { recursive: true })
  const library = path.join(site, 'library.json')
  fs.writeFileSync(library, JSON.stringify([
    record('09-07', '2026-09-07', 'sum-a', '第一节正文'),
    record('09-14', '2026-09-14', 'sum-b', '第二节正文'),
    record('09-21', '2026-09-21', 'sum-c', '第三节正文')
  ]))

  const first = harness(root)
  const saved = await runCli([
    'integrate',
    '--course', '刑事执行法',
    '--lessons', '09-07,09-14',
    '--topic', '罪刑均衡',
    '--save'
  ], first.deps)
  assert.equal(saved, 0, first.errors.join('\n'))

  const manifestFile = path.join(root, 'integration-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.equal(manifest.integrations.length, 1)
  assert.deepEqual(manifest.integrations[0].lessons, ['09-07', '09-14'], '09-21 不能因为同课程就被自动带进来')

  const planFile = path.join(root, 'integrations', '刑事执行法-罪刑均衡.json')
  const before = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  assert.equal(before.lessons.find(item => item.lessonTitle === '09-14').checksum, 'sum-b')

  fs.writeFileSync(library, JSON.stringify([
    record('09-07', '2026-09-07', 'sum-a', '第一节正文'),
    record('09-14', '2026-09-14', 'sum-b2', '第二节正文已经修订'),
    record('09-21', '2026-09-21', 'sum-c', '第三节正文')
  ]))

  const second = harness(root)
  const rebuilt = await runCli(['integrate', '--configured'], second.deps)
  assert.equal(rebuilt, 0, second.errors.join('\n'))
  const after = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  assert.equal(after.lessons.find(item => item.lessonTitle === '09-14').checksum, 'sum-b2')
  assert.deepEqual(after.lessons.map(item => item.lessonTitle), ['09-07', '09-14'])
  const payload = JSON.parse(second.lines.at(-1))
  assert.equal(payload.configured, true)
  assert.equal(payload.count, 1)
})

test('integrate --save requires an explicit topic so the manifest identity cannot be a placeholder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-integrate-cli-'))
  const site = path.join(root, 'site')
  fs.mkdirSync(site, { recursive: true })
  fs.writeFileSync(path.join(site, 'library.json'), JSON.stringify([
    record('09-07', '2026-09-07', 'sum-a', '正文')
  ]))
  const h = harness(root)
  const code = await runCli(['integrate', '--course', '刑事执行法', '--lessons', '09-07', '--save'], h.deps)
  assert.equal(code, 1)
  assert.match(h.errors.join('\n'), /必须显式给 --topic/)
})
