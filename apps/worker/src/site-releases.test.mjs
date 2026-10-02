import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  beginSiteRelease,
  discardSiteRelease,
  inspectSiteRoot,
  migrateLegacySiteRoot,
  promoteSiteRelease,
  sealSiteRelease,
  siteReleaseLayout,
  validateSiteRelease
} from './site-releases.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'course-site-release-'))
}

function writeValidRelease(root, label = 'v1') {
  fs.mkdirSync(path.join(root, 'notes', '课程'), { recursive: true })
  fs.mkdirSync(path.join(root, 'md', '课程'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), label)
  fs.writeFileSync(path.join(root, 'notes', '课程', '第一课.html'), '<h1>第一课</h1>')
  fs.writeFileSync(path.join(root, 'md', '课程', '第一课.md'), '# 第一课\n')
  const library = [{ slug: 'notes/课程/第一课', courseName: '课程', lessonTitle: '第一课', markdown: '# 第一课' }]
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify(library))
  fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({ count: 1, notes: [{ slug: 'notes/课程/第一课' }] }))
}

test('fresh site: stage -> validate -> seal -> atomic symlink promotion', () => {
  const root = tmp()
  const site = path.join(root, 'site')
  const stage = beginSiteRelease({ siteRoot: site, now: new Date('2026-10-02T00:00:00Z') })
  writeValidRelease(stage.stagingDir, 'v1')
  assert.equal(validateSiteRelease(stage.stagingDir).notes, 1)
  const release = sealSiteRelease({ siteRoot: site, stagingDir: stage.stagingDir, now: new Date('2026-10-02T00:00:00Z') })
  const promoted = promoteSiteRelease({ siteRoot: site, releaseDir: release })
  assert.equal(promoted.previous, null)
  assert.equal(fs.lstatSync(site).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'v1')
  assert.equal(inspectSiteRoot(site).managed, true)
})

test('second promotion switches pointer and keeps previous release for rollback', () => {
  const root = tmp()
  const site = path.join(root, 'site')

  const firstStage = beginSiteRelease({ siteRoot: site })
  writeValidRelease(firstStage.stagingDir, 'old')
  const first = sealSiteRelease({ siteRoot: site, stagingDir: firstStage.stagingDir })
  promoteSiteRelease({ siteRoot: site, releaseDir: first })

  const secondStage = beginSiteRelease({ siteRoot: site })
  writeValidRelease(secondStage.stagingDir, 'new')
  const second = sealSiteRelease({ siteRoot: site, stagingDir: secondStage.stagingDir })
  const switched = promoteSiteRelease({ siteRoot: site, releaseDir: second })

  assert.equal(switched.previous, first)
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'new')
  assert.equal(fs.existsSync(path.join(first, 'index.html')), true)

  promoteSiteRelease({ siteRoot: site, releaseDir: first })
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'old')
})

test('legacy directory migration preserves contents and becomes managed symlink', () => {
  const root = tmp()
  const site = path.join(root, 'site')
  fs.mkdirSync(site)
  writeValidRelease(site, 'legacy')

  const result = migrateLegacySiteRoot({ siteRoot: site, now: new Date('2026-10-02T00:00:00Z') })
  assert.equal(result.migrated, true)
  assert.equal(fs.lstatSync(site).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), 'legacy')
  assert.equal(inspectSiteRoot(site).managed, true)

  const again = migrateLegacySiteRoot({ siteRoot: site })
  assert.equal(again.migrated, false)
  assert.equal(again.alreadyManaged, true)
})

test('promotion refuses to overwrite a legacy real directory implicitly', () => {
  const root = tmp()
  const site = path.join(root, 'site')
  fs.mkdirSync(site)
  const stage = beginSiteRelease({ siteRoot: site })
  writeValidRelease(stage.stagingDir)
  const release = sealSiteRelease({ siteRoot: site, stagingDir: stage.stagingDir })
  assert.throws(
    () => promoteSiteRelease({ siteRoot: site, releaseDir: release }),
    /migrate-site-root/
  )
})

test('validation catches incomplete snapshot and staging can be discarded', () => {
  const root = tmp()
  const site = path.join(root, 'site')
  const stage = beginSiteRelease({ siteRoot: site })
  fs.writeFileSync(path.join(stage.stagingDir, 'index.html'), 'broken')
  assert.throws(() => validateSiteRelease(stage.stagingDir), /缺少/)
  discardSiteRelease(stage.stagingDir)
  assert.equal(fs.existsSync(stage.stagingDir), false)
})

test('release layout keeps releases next to site, not inside it', () => {
  const root = tmp()
  const site = path.join(root, 'site')
  const layout = siteReleaseLayout(site)
  assert.equal(layout.releases, `${site}.releases`)
})
