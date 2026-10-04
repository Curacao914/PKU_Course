import test from 'node:test'
import assert from 'node:assert/strict'
import { signRequest, createRequestVerifier, createJobTokens } from './auth.mjs'
const key = 'test-signing-key-with-at-least-32-bytes'
const ownerId = '11111111-2222-4333-8444-555555555555'
const other = '21111111-2222-4333-8444-555555555555'
const request = { method: 'PUT', path: '/v1/account/credential?q=1', ownerId, body: '{"secret":"member"}' }
test('HMAC requires signature, valid time, nonce, owner, method, raw path and body', () => {
  const verify = createRequestVerifier({ key, now: () => 100_000 })
  const headers = signRequest({ ...request, key, timestamp: 100_000 })
  const call = (h, patch = {}) => verify({ ...request, headers: h, ...patch })
  for (const h of [{}, { ...headers, 'x-course-signature': '0'.repeat(64) }, signRequest({ ...request, key, timestamp: 1 })]) {
    assert.throws(() => call(h), { status: 401 })
  }
  assert.throws(() => call({ ...headers, 'x-course-owner-id': other }), { status: 401 })
  for (const patch of [{ method: 'POST' }, {path: '/v1/account/credential?q=2'}, { body: '{}' }]) assert.throws(() => call(headers, patch), {status: 401})
  assert.equal(call(headers), ownerId)
  assert.throws(() => call(headers), {status: 401})
})
test('job tokens bind owner/job/scope, expire and revoke on completion', () => {
  let now = 1000
  const tokens = createJobTokens({ now: () => now, ttlMs: 1000 })
  const token = tokens.issue({ ownerId, jobId: 'job-a', scope: 'private-content:write' })
  const context = { ownerId, jobId: 'job-a', scope: 'private-content:write' }
  assert.equal(tokens.verify(token, context).ownerId, ownerId)
  for (const patch of [{ ownerId: other }, { jobId: 'job-b' }, { scope: 'credential:read' }]) assert.throws(() => tokens.verify(token, { ...context, ...patch }), {status: 401})
  assert.throws(() => tokens.verify(token + 'x', context), {status: 401})
  now = 2000
  assert.throws(() => tokens.verify(token, context), {status: 401})
  const next = tokens.issue(context)
  tokens.revoke('job-a')
  assert.throws(() => tokens.verify(next, context), {status: 401})
})

test('HTTP server rejects unsigned requests and confines job token to internal note write', async()=>{
  const {createControlServer}=await import('../server.mjs')
  const tokens=createJobTokens()
  const store={profile:async id=>({id,role:'member',status:'active'}),autoSyncOwners:async()=>[],savePrivateNote:async()=>({id:'note',title:'private'})}
  const server=createControlServer({env:{COURSE_CONTROL_SIGNING_KEY:key},store,r2:{},qr:{},jobTokens:tokens})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(base+'/v1/jobs')).status,401)
    const path='/v1/jobs'
    const headers=signRequest({key,ownerId,method:'GET',path})
    assert.equal((await fetch(base+path,{headers})).status,200)
    assert.equal((await fetch(base+path,{headers})).status,401)
    const token=tokens.issue({ownerId,jobId:'job'})
    const jobHeaders={authorization:'Bearer '+token,'x-course-owner-id':ownerId,'x-course-job-id':'job'}
    assert.equal((await fetch(base+path,{headers:jobHeaders})).status,401)
    assert.equal((await fetch(base+'/v1/internal/private-note',{method:'POST',headers:jobHeaders,body:JSON.stringify({replayKey:'own',markdown:'note'})})).status,200)
    assert.equal((await fetch(base+'/v1/internal/private-note',{method:'POST',headers:{...jobHeaders,'x-course-owner-id':other},body:'{}'})).status,401)
    tokens.revoke('job')
    assert.equal((await fetch(base+'/v1/internal/private-note',{method:'POST',headers:jobHeaders,body:'{}'})).status,401)
  } finally {await new Promise(resolve=>server.close(resolve))}
})
