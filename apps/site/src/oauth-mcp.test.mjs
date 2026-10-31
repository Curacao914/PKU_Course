import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {createCourseOAuth} from './oauth-mcp.mjs'
import {createProtocolServer} from '../../../packages/notes-mcp/src/protocol.mjs'

const OWNER='550e8400-e29b-41d4-a716-446655440000'
const KEY='test-key-for-course-oauth-with-more-than-32-bytes'
const BASE='https://course.law-tech.dev'
const CLIENT='https://chatgpt.com/oauth/client.json'
const CALLBACK='https://chatgpt.com/connector_platform_oauth_redirect'
const AUD=BASE+'/mcp'
const DIGEST=v=>crypto.createHash('sha256').update(v).digest('base64url')
async function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'course-oauth-test-'))
  const oauth=createCourseOAuth({ownerId:OWNER,signingKey:KEY,root})
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost')
    const session=req.headers['x-test-owner']==='yes'
      ? {sub:OWNER,role:'owner',amr:'passkey'} : null
    if(await oauth.handle(req,res,url.pathname,url,session))return
    res.writeHead(404);res.end()
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  return {root,oauth,url:'http://127.0.0.1:'+server.address().port,
    async close(){await new Promise(done=>server.close(done));fs.rmSync(root,{recursive:true,force:true})}}
}
function requestParams(verifier){
  return new URLSearchParams({
    client_id:CLIENT,redirect_uri:CALLBACK,response_type:'code',
    state:'example-state',scope:'notes:read offline_access',
    resource:AUD,code_challenge:DIGEST(verifier),code_challenge_method:'S256'
  })
}
function post(url,form,headers={}){
  return fetch(url,{method:'POST',redirect:'manual',
    headers:{'content-type':'application/x-www-form-urlencoded',...headers},
    body:new URLSearchParams(form)})
}
test('OAuth metadata advertises CIMD, S256 and resource audience',async t=>{
  const app=await fixture();t.after(app.close)
  const resource=await (await fetch(app.url+'/.well-known/oauth-protected-resource/mcp')).json()
  const metadata=await (await fetch(app.url+'/.well-known/oauth-authorization-server')).json()
  assert.equal(resource.resource,AUD)
  assert.deepEqual(resource.authorization_servers,[BASE])
  assert.equal(metadata.client_id_metadata_document_supported,true)
  assert.equal(metadata.authorization_response_iss_parameter_supported,true)
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256'])
})
test('owner consent, S256 authorization grant, rotating refresh and durable token',async t=>{
  const app=await fixture();t.after(app.close)
  const verifier=crypto.randomBytes(36).toString('base64url')
  const endpoint=app.url+'/oauth/authorize?'+requestParams(verifier)
  const unauth=await fetch(endpoint,{redirect:'manual'})
  assert.equal(unauth.status,302)
  assert.match(unauth.headers.get('location'),/^\/login\?next=/)
  const approval=await fetch(endpoint,{headers:{'x-test-owner':'yes'}})
  assert.equal(approval.status,200)
  // The browser's same-origin form POST must carry its actual Origin.
  // "no-referrer" changes it to "null" and breaks the owner consent flow.
  assert.equal(approval.headers.get('referrer-policy'),'same-origin')
  const flow=(await approval.text()).match(/name="flow" value="([^"]+)"/)?.[1]
  assert.ok(flow)
  const crossOrigin=await post(app.url+'/oauth/authorize',{flow,decision:'allow'},
    {origin:'null','x-test-owner':'yes'})
  assert.equal(crossOrigin.status,403)
  assert.equal((await crossOrigin.json()).error,'invalid_authorization')
  const notOwner=await post(app.url+'/oauth/authorize',{flow,decision:'allow'},
    {origin:BASE})
  assert.equal(notOwner.status,403)
  assert.equal((await notOwner.json()).error,'invalid_authorization')
  const confirmed=await post(app.url+'/oauth/authorize',{flow,decision:'allow'},
    {origin:BASE,'x-test-owner':'yes'})
  const callback=new URL(confirmed.headers.get('location'))
  assert.equal(callback.searchParams.get('iss'),BASE)
  assert.equal(callback.searchParams.get('state'),'example-state')
  const code=callback.searchParams.get('code')
  assert.ok(code)
  const inputs={grant_type:'authorization_code',code,client_id:CLIENT,
    resource:AUD,redirect_uri:CALLBACK,code_verifier:verifier}
  const exchanged=await post(app.url+'/oauth/token',inputs)
  assert.equal(exchanged.status,200)
  const first=await exchanged.json()
  assert.equal(app.oauth.verifyAccessToken(first.access_token)?.sub,OWNER)
  assert.ok(first.refresh_token)
  assert.equal((await post(app.url+'/oauth/token',inputs)).status,400)
  const refreshInputs={grant_type:'refresh_token',client_id:CLIENT,
    resource:AUD,refresh_token:first.refresh_token}
  const exchangedAgain=await post(app.url+'/oauth/token',refreshInputs)
  assert.equal(exchangedAgain.status,200)
  const second=await exchangedAgain.json()
  assert.notEqual(first.refresh_token,second.refresh_token)
  assert.equal((await post(app.url+'/oauth/token',refreshInputs)).status,400)
  const afterRestart=createCourseOAuth({ownerId:OWNER,signingKey:KEY,root:app.root})
  assert.equal(afterRestart.verifyAccessToken(second.access_token)?.sub,OWNER)
  const store=fs.readFileSync(path.join(app.root,'oauth','refresh-tokens.json'),'utf8')
  assert.ok(!store.includes(second.refresh_token))
  assert.equal(fs.statSync(path.join(app.root,'oauth','refresh-tokens.json')).mode&0o777,0o600)
  assert.equal((await post(app.url+'/oauth/revoke',{client_id:CLIENT,token:second.refresh_token})).status,200)
  assert.equal((await post(app.url+'/oauth/token',{...refreshInputs,refresh_token:second.refresh_token})).status,400)
})
test('rejects unsupported clients, redirects, audiences, methods and wrong verifiers',async t=>{
  const app=await fixture();t.after(app.close)
  const verifier='v'.repeat(48)
  for(const invalid of [
    {client_id:'https://example.com/client.json'},
    {redirect_uri:'https://example.com/callback'},
    {resource:'https://example.com/mcp'},
    {code_challenge_method:'plain'}
  ]){
    const params=new URLSearchParams({...Object.fromEntries(requestParams(verifier)),...invalid})
    const res=await fetch(app.url+'/oauth/authorize?'+params,{headers:{'x-test-owner':'yes'}})
    assert.equal(res.status,400)
  }
  assert.equal(app.oauth.verifyAccessToken('nonsense'),null)
})

test('MCP tool declarations explicitly require read-only OAuth scope',async()=>{
  const server=createProtocolServer({service:{},oauthScopes:['notes:read','offline_access']})
  const response=await server.handleMessage({jsonrpc:'2.0',id:1,method:'tools/list'})
  assert.equal(response.result.tools.length,7)
  assert.ok(response.result.tools.every(tool=>
    tool.securitySchemes?.length===1&&tool.securitySchemes[0].type==='oauth2'&&
    tool.securitySchemes[0].scopes.join(' ')==='notes:read offline_access'))
})

test('site MCP accepts OAuth access tokens while unauthenticated callers get discovery challenge',async t=>{
  const source=await fixture()
  t.after(source.close)
  fs.writeFileSync(path.join(source.root,'library.json'),'[]')
  const {startSiteServer}=await import('./server.mjs')
  const site=await startSiteServer({
    root:source.root,scratchRoot:source.root,port:0,host:'127.0.0.1',
    ssoKey:KEY,passkeyMode:'passkey',passkeyOwnerId:OWNER,
    ownerOnly:true,ownerId:OWNER,ownerLocalContent:true,
    contentVisibility:'private',mcpOAuth:true
  })
  t.after(()=>site.close())
  const endpoint=site.url+'/mcp'
  const rpc=async access=>fetch(endpoint,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'accept':'application/json,text/event-stream',
      ...(access?{authorization:'Bearer '+access}:{})
    },
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})
  })
  const missing=await rpc()
  assert.equal(missing.status,401)
  assert.match(missing.headers.get('www-authenticate'),/oauth-protected-resource\/mcp/)
  const verifier=crypto.randomBytes(36).toString('base64url')
  const flowUrl=source.url+'/oauth/authorize?'+requestParams(verifier)
  const consent=await fetch(flowUrl,{headers:{'x-test-owner':'yes'}})
  const flow=(await consent.text()).match(/name="flow" value="([^"]+)"/)?.[1]
  assert.ok(flow)
  const confirmation=await post(source.url+'/oauth/authorize',{flow,decision:'allow'},
    {'x-test-owner':'yes',origin:BASE})
  const code=new URL(confirmation.headers.get('location')).searchParams.get('code')
  const exchange=await post(source.url+'/oauth/token',{
    grant_type:'authorization_code',code,client_id:CLIENT,
    redirect_uri:CALLBACK,code_verifier:verifier,resource:AUD
  })
  assert.equal(exchange.status,200)
  const {access_token}=await exchange.json()
  const result=await rpc(access_token)
  assert.equal(result.status,200)
  const body=await result.json()
  assert.equal(body.result.tools.length,7)
  assert.deepEqual(body.result.tools[0].securitySchemes,
    [{type:'oauth2',scopes:['notes:read','offline_access']}])
})
