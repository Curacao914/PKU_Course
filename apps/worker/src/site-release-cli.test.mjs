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
