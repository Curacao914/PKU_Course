import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readOwnerLocalState } from './owner-local.mjs'

test('OWNER local snapshot reads and invalidates across atomic release switch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-owner-local-'))
  try {
    for (const version of ['v1','v2']) {
      const dir = path.join(root, version)
      fs.mkdirSync(path.join(dir,'topics'),{recursive:true})
      fs.writeFileSync(path.join(dir,'library.json'),JSON.stringify([{slug:'notes/test',courseName:version,lessonTitle:'x',markdown:'# '+version}]))
      fs.writeFileSync(path.join(dir,'topics','a.json'),JSON.stringify({kind:'course-topic',id:'topic-a',course:version,title:'a'}))
      fs.writeFileSync(path.join(dir,'topics.json'),JSON.stringify({topics:[{id:'topic-a',json:'topics/a.json'}]}))
    }
    const link=path.join(root,'site')
    fs.symlinkSync('v1',link)
    const first=readOwnerLocalState(link)
    assert.equal(first.records[0].courseName,'v1')
    assert.equal(first.topics[0].course,'v1')
    assert.strictEqual(readOwnerLocalState(link),first)
    fs.symlinkSync('v2',path.join(root,'next'))
    fs.renameSync(path.join(root,'next'),link)
    const second=readOwnerLocalState(link)
    assert.equal(second.records[0].courseName,'v2')
    assert.equal(second.topics[0].course,'v2')
    assert.notStrictEqual(first,second)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})
