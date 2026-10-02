import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './cli.mjs'

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
      now: () => new Date('2026-10-02T07:00:00Z'),
      which: async () => '',
      runPython: async () => ({ code: 0, stdout: '', stderr: '' }),
      acquire: async () => { throw new Error('sourcemap test must not open browser') }
    }
  }
}

test('sourcemap --write atomically publishes a managed content release and leaves the old release untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-sourcemap-atomic-'))
  const site = path.join(root, 'site')
  const releases = site + '.releases'
  const oldRelease = path.join(releases, 'release-old')
  fs.mkdirSync(path.join(oldRelease, 'md', '甲'), { recursive: true })

  const quoted = '共同犯罪要求共同故意与共同行为同时具备'
  const markdown = ['# 第1节', '', '## 甲节', '', quoted + '，缺一不可。'].join('\n')
  const onepageMarkdown = ['## 一、体系', '', '- ' + quoted + '。'].join('\n')
  const record = {
    slug: 'notes/甲/第1节',
    courseName: '甲',
    lessonTitle: '第1节',
    lessonDate: '2026-10-01',
    firstPublishedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    checksum: 'bytes-do-not-matter-here',
    markdown,
    sections: [{ id: '甲节', title: '甲节', level: 2, chars: 30, fingerprint: '00000000' }],
    onepage: { title: '一页', markdown: onepageMarkdown, chars: onepageMarkdown.length }
  }
  fs.writeFileSync(path.join(oldRelease, 'library.json'), JSON.stringify([record], null, 2))
  fs.writeFileSync(path.join(oldRelease, 'md', '甲', '第1节.md'), markdown)
  fs.symlinkSync(path.relative(path.dirname(site), oldRelease), site, 'dir')

  const h = harness(root)
  const beforeTarget = fs.realpathSync(site)
  const code = await runCli(['sourcemap', '--site-root', site, '--write', '--no-purge'], h.deps)
  assert.equal(code, 0, h.errors.join('\n'))

  const payload = JSON.parse(h.lines.at(-1))
  assert.equal(payload.written, true)
  assert.equal(payload.published, true)
  assert.equal(payload.atomicRelease, true)
  assert.equal(payload.cachePurged, false)

  const afterTarget = fs.realpathSync(site)
  assert.notEqual(afterTarget, beforeTarget, '正式 site 应切到一份全新的 release')
  assert.match(afterTarget, /site\.releases\/release-/)

  const oldLibrary = JSON.parse(fs.readFileSync(path.join(oldRelease, 'library.json'), 'utf8'))
  assert.equal(oldLibrary[0].onepage.sourceMap, undefined, '旧 release 必须保持不可变，不能被 sourcemap 原地改脏')

  const currentLibrary = JSON.parse(fs.readFileSync(path.join(site, 'library.json'), 'utf8'))
  assert.equal(currentLibrary[0].onepage.sourceMap.entries.length, 1)
  assert.match(currentLibrary[0].onepage.sourceMap.entries[0].block, /^ob-[0-9a-f]{8}$/)

  const page = fs.readFileSync(path.join(site, 'onepage', '甲', '第1节.html'), 'utf8')
  assert.match(page, /看原文/, '原子切换完成时页面应已经包含新来源入口，不需要第二次 rebuild')

  fs.rmSync(root, { recursive: true, force: true })
})
