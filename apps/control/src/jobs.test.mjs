import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeMemberEnv, createJobQueue } from './jobs.mjs'
import { applyEnvFile, resolveEnvFile } from '../../worker/src/env-file.mjs'
const ownerId = '11111111-2222-4333-8444-555555555555'
test('MEMBER whitelist never inherits OWNER secrets or runtime injection variables', () => {
  const base = Object.fromEntries(['PKU_USERNAME','PKU_PASSWORD','PADDLEOCR_ACCESS_TOKEN','DASHSCOPE_API_KEY','COURSE_AI_API_KEY','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','ALIYUN_ACCESS_KEY_ID','COURSE_ADMIN_TOKEN','COURSE_CONTROL_SECRET','COURSE_CONTROL_SIGNING_KEY','SUPABASE_SECRET_KEY','RESEND_API_KEY','NEW_UNKNOWN_SECRET','NODE_OPTIONS','NODE_PATH','LD_PRELOAD'].map(k => [k,'OWNER_SECRET']))
  const env = sanitizeMemberEnv({ ...base, PATH: '/bin', HOME: '/home/control', COURSE_ENV_FILE: '/owner/env' }, ownerId, '/member/account', { deepseek: 'member-ai' }, { username: 'member', row: {} }, {})
  assert.equal(env.COURSE_ENV_FILE, '/member/account/env')
  assert.equal(env.COURSE_AI_API_KEY, 'member-ai')
  assert.equal(env.PKU_USERNAME, 'member')
  assert.equal(Object.values(env).includes('OWNER_SECRET'), false)
  assert.equal(env.PATH, '/bin')
})
test('MEMBER cannot fall back to OWNER env file', () => {
  assert.throws(() => resolveEnvFile({ COURSE_RESOURCE_CLASS: 'member' }), /MEMBER/)
})
test('queue is globally serial and gives way while OWNER is active', async () => {
  let busy = true; let running = 0; let max = 0
  const calls = []; const releases = []
  const queue = createJobQueue({ env: {}, store: {}, r2: {}, ownerIsActive: () => busy, retryMs: 5,
    executeJob: async job => { calls.push(job.id); max = Math.max(max, ++running); await new Promise(r => releases.push(r)); running--; return {ok:true} }
  })
  const a = queue.enqueue(ownerId, 'sync'); const b = queue.enqueue('owner-b', 'sync')
  await new Promise(r => setTimeout(r, 20)); assert.equal(calls.length, 0)
  busy = false
  await new Promise(r => setTimeout(r, 20)); assert.deepEqual(calls, [a.id])
  releases.shift()(); await new Promise(r => setTimeout(r, 20)); assert.deepEqual(calls, [a.id,b.id])
  releases.shift()(); await new Promise(r => setTimeout(r, 10)); assert.equal(max, 1)
  queue.close()
})

test('prepared MEMBER file is 0600 and cannot refill OWNER credentials', async () => {
  const {prepare}=await import('./jobs.mjs')
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'member-env-'))
  try {
    fs.writeFileSync(path.join(root,'owner-env'),'PKU_PASSWORD=OWNER_SECRET\nPADDLEOCR_ACCESS_TOKEN=OWNER_SECRET\n')
    const store={profile:async()=>({}),credentials:async()=>({}),pkuSecrets:async()=>({row:{}}),resourceLimits:async()=>({})}
    const result=await prepare(ownerId,{COURSE_MEMBER_ROOT:root,COURSE_ENV_FILE:path.join(root,'owner-env'),PKU_PASSWORD:'OWNER_SECRET'},store)
    const file=resolveEnvFile(result.childEnv)
    assert.equal(fs.statSync(file).mode & 0o777,0o600)
    assert.equal(file,path.join(root,ownerId,'env'))
    const loaded=applyEnvFile(result.childEnv,file).env
    assert.equal(Object.values(loaded).includes('OWNER_SECRET'),false)
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})
test('selection rejects unscanned keys', async()=>{
  const {validateCourseSelection}=await import('./store.mjs')
  assert.deepEqual(validateCourseSelection(['own','own'],['own']),['own'])
  assert.throws(()=>validateCourseSelection(['foreign'],['own']))
  assert.throws(()=>validateCourseSelection([1],['1']))
})

test('real ledger OWNER lease blocks MEMBER admission', async()=>{
  const {openLedger}=await import('@course/store')
  const {ownerHasActiveLease}=await import('./jobs.mjs')
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-lease-'))
  const file=path.join(root,'ledger.sqlite')
  const ledger=openLedger(file)
  try {
    ledger.discoverReplays([{replayKey:'owner-task',courseKey:'course',courseName:'course',title:'lesson'}])
    const claim=ledger.claimTask({replayKey:'owner-task',workerId:'owner-worker'})
    assert.equal(claim.claimed,true)
    assert.equal(ownerHasActiveLease({COURSE_LEDGER_PATH:file}),true)
    ledger.reportStage({id:claim.task.id,stage:claim.task.stage})
    assert.equal(ownerHasActiveLease({COURSE_LEDGER_PATH:file}),false)
  } finally {ledger.close();fs.rmSync(root,{recursive:true,force:true})}
})
