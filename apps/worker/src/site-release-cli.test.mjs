import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './cli.mjs'
import { beginSiteRelease, promoteSiteRelease, sealSiteRelease } from './site-releases.mjs'

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
      acquire: async () => { throw new Error('migration must not open browser') }
    }
  }
}

test('publish --migrate-site-root is explicit and keeps the legacy site readable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-migrate-cli-'))
  const site = path.join(root, 'site')
  fs.mkdirSync(site, { recursive: true })
  fs.writeFileSync(path.join(site, 'index.html'), 'legacy')

  const no = harness(root)
  assert.equal(await runCli(['publish', '--migrate-site-root', '--out', site], no.deps), 1)
  assert.match(no.errors.join('\n'), /加 --yes/)
  assert.equal(fs.lstatSync(site).isDirectory(), true)

  const yes = harness(root)
  assert.equal(await runCli(['publish', '--migrate-site-root', '--yes', '--out', site], yes.deps), 0, yes.errors.join('\n'))
  assert.equal(fs.lstatSync(site).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'legacy')
  const payload = JSON.parse(yes.lines.at(-1))
  assert.equal(payload.migrated, true)
  assert.match(payload.releaseDir, /site\.releases/)
})


function writeValidRelease(root, label) {
  fs.mkdirSync(path.join(root, 'notes', '课程'), { recursive: true })
  fs.mkdirSync(path.join(root, 'md', '课程'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), label)
  fs.writeFileSync(path.join(root, 'notes', '课程', '第一课.html'), '<h1>第一课</h1>')
  fs.writeFileSync(path.join(root, 'md', '课程', '第一课.md'), '# 第一课\n')
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify([
    { slug: 'notes/课程/第一课', courseName: '课程', lessonTitle: '第一课', markdown: '# 第一课' }
  ]))
  fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({
    count: 1,
    notes: [{ slug: 'notes/课程/第一课' }]
  }))
}

test('publish --rollback-site validates and atomically switches to the previous content release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-rollback-cli-'))
  const site = path.join(root, 'site')

  const firstStage = beginSiteRelease({ siteRoot: site, now: new Date('2026-10-01T00:00:00Z') })
  writeValidRelease(firstStage.stagingDir, 'old')
  const first = sealSiteRelease({ siteRoot: site, stagingDir: firstStage.stagingDir, now: new Date('2026-10-01T00:00:00Z') })
  promoteSiteRelease({ siteRoot: site, releaseDir: first })

  const secondStage = beginSiteRelease({ siteRoot: site, now: new Date('2026-10-02T00:00:00Z') })
  writeValidRelease(secondStage.stagingDir, 'new')
  const second = sealSiteRelease({ siteRoot: site, stagingDir: secondStage.stagingDir, now: new Date('2026-10-02T00:00:00Z') })
  promoteSiteRelease({ siteRoot: site, releaseDir: second })
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'new')

  const h = harness(root)
  assert.equal(await runCli(['publish', '--rollback-site', '--yes', '--out', site, '--no-purge'], h.deps), 0, h.errors.join('\n'))
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'old')
  const payload = JSON.parse(h.lines.at(-1))
  assert.equal(payload.rolledBack, true)
  assert.equal(payload.to, first)
  assert.equal(payload.from, second)
  assert.equal(payload.validatedNotes, 1)
})
