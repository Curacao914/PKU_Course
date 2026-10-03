import test from 'node:test'
import assert from 'node:assert/strict'
import { createR2, assertMaterialKey } from './r2.mjs'
const owner='11111111-2222-4333-8444-555555555555'
const env=Object.fromEntries(['ENDPOINT','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY'].map(s=>['COURSE_MEMBER_R2_'+s,s==='ENDPOINT'?'https://r2.example':s]))
test('single file limit, exact quota boundary and owner namespace', async () => {
  let signed
  const r2=createR2(env,{client:{send:async()=>({Contents:[{Size:100}]})},sign:async(_c,command,options)=>{signed={command,options};return 'signed'}})
  await assert.rejects(r2.presignUpload(owner,'a.pdf','application/pdf',11,10,110),/单文件/)
  await assert.rejects(r2.presignUpload(owner,'a.pdf','application/pdf',10,10,109),/存储空间/)
  const result=await r2.presignUpload(owner,'a.pdf','application/pdf',10,10,110)
  assert.equal(result.expectedBytes,10)
  assert.equal(signed.command.input.ContentLength,10)
  assert.ok(signed.options.signableHeaders.has('content-length'))
  assertMaterialKey(owner,result.key)
  for(const key of ['users/another/materials/a.pdf',`users/${owner}/materials/../secret`,`users/${owner}/materials/`]) {
    assert.throws(()=>assertMaterialKey(owner,key))
    await assert.rejects(r2.head(owner,key))
    await assert.rejects(r2.remove(owner,key))
    await assert.rejects(r2.download(owner,key,'/unused'))
  }
  await assert.rejects(r2.presignUpload(owner,'a.pdf','x',0,10,110))
})
