import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activeArtifactDirs } from './artifact-sources.mjs'

test('active artifact scan only sees replay output trees, not experiments or backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-artifact-sources-'))
  const live = path.join(root, 'replays', 'replay-1', 'transcript')
  const experiment = path.join(root, 'experiments', 'replay-1', 'E1')
  const syncBackup = path.join(root, 'source-sync-backups', '2026-10-02', 'replay-1')
  const revisionBackup = path.join(root, 'source-revision-backups', '2026-10-02', 'replay-1')
  for (const dir of [live, experiment, syncBackup, revisionBackup]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'brief.json'), '{}')
  }

  assert.deepEqual(activeArtifactDirs(root), [live])
  fs.rmSync(root, { recursive: true, force: true })
})

test('active artifact scan includes both brief and onepage directories under replays', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-artifact-sources-'))
  const a = path.join(root, 'replays', 'a', 'transcript')
  const b = path.join(root, 'replays', 'b', 'transcript')
  fs.mkdirSync(a, { recursive: true })
  fs.mkdirSync(b, { recursive: true })
  fs.writeFileSync(path.join(a, 'brief.json'), '{}')
  fs.writeFileSync(path.join(b, 'onepage.json'), '{}')

  assert.deepEqual(activeArtifactDirs(root), [a, b].sort())
  fs.rmSync(root, { recursive: true, force: true })
})
