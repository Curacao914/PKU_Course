import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const CLIENT = 'https://chatgpt.com/oauth/client.json'
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect'
const ISSUER = 'https://course.law-tech.dev'
const RESOURCE = ISSUER + '/mcp'
const READ = 'notes:read'
const OFFLINE = 'offline_access'
const ACCESS_TTL = 3600
const REFRESH_TTL = 60 * 86400
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
const hash = value => crypto.createHash('sha256').update(String(value)).digest('base64url')
const eq = (a,b) => {
  const x=Buffer.from(String(a||''))
  const y=Buffer.from(String(b||''))
  return x.length>0 && x.length===y.length && crypto.timingSafeEqual(x,y)
}
const error = (status,code) => Object.assign(new Error(code),{status})
const reply = (res,status,data,extra={}) => {
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',...extra
  })
  res.end(JSON.stringify(data))
}
const redirect = (res,target) => {
  res.writeHead(302,{'location':target,'cache-control':'no-store','referrer-policy':'no-referrer'})
  res.end()
}
async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type']||''))) throw error(415,'invalid_content_type')
  const parts=[]
  let size=0
  for await (const chunk of req) {
    size+=chunk.length
    if (size>8192) throw error(413,'request_too_large')
    parts.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'))
}
function getStore(file) {
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if (saved.version!==1||!saved.tokens||typeof saved.tokens!=='object') throw Error('invalid OAuth token store')
    return saved
  } catch(e) {
    if (e.code==='ENOENT') return {version:1,tokens:{}}
    throw e
  }
}
function saveStore(file,store) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
  const tmp=file+'.'+random(8)
  try {
    fs.writeFileSync(tmp,JSON.stringify(store),{flag:'wx',mode:0o600})
    fs.renameSync(tmp,file)
  } finally {try {fs.unlinkSync(tmp)}catch{}}
}
function esc(s) {return String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}

/** Owner-only OAuth 2.1 issuer. The public OAuth client is restricted to ChatGPT's CIMD. */
export function createCourseOAuth({ownerId,signingKey,root,now=Date.now}={}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ownerId||'')) throw Error('OAuth OWNER UUID required')
  if (Buffer.byteLength(String(signingKey||''))<32||!root) throw Error('OAuth signing key and persistent root required')
  const key=crypto.createHmac('sha256',signingKey).update('course-mcp-oauth-v1').digest()
  const file=path.join(root,'oauth','refresh-tokens.json')
  const consents=new Map()
  const codes=new Map()
  function signature(body){return crypto.createHmac('sha256',key).update(body).digest('base64url')}
  function issueAccess() {
    const t=Math.floor(now()/1000)
    const body=Buffer.from(JSON.stringify({
      typ:'oauth-access',v:1,sub:ownerId,iss:ISSUER,aud:RESOURCE,
      scope:READ,iat:t,exp:t+ACCESS_TTL
    })).toString('base64url')
    return body+'.'+signature(body)
  }
  function verifyAccessToken(token) {
    if (!token||token.length>4096) return null
    const [body,sig,extra]=String(token).split('.')
    if (!body||!sig||extra||!eq(signature(body),sig)) return null
    try {
      const claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'))
      const t=Math.floor(now()/1000)
      if (claims.typ!=='oauth-access'||claims.v!==1||claims.sub!==ownerId||
          claims.iss!==ISSUER||claims.aud!==RESOURCE||claims.scope!==READ||
          !Number.isSafeInteger(claims.exp)||claims.exp<=t||
          !Number.isSafeInteger(claims.iat)||claims.iat>t+60) return null
      return {sub:ownerId,scope:READ,oauth:true}
    } catch{return null}
  }
  function createRefresh(scope) {
    const value=random(48)
    const stored=getStore(file)
    const t=Math.floor(now()/1000)
    for (const [k,v] of Object.entries(stored.tokens)) if (v.expires<=t) delete stored.tokens[k]
    if (Object.keys(stored.tokens).length>=20) throw error(429,'too_many_active_connections')
    stored.tokens[hash(value)]={client:CLIENT,scope,expires:t+REFRESH_TTL}
    saveStore(file,stored)
    return value
  }
  function revokeRefresh(value) {
    const stored=getStore(file)
    if (!value||String(value).length>256) return
    delete stored.tokens[hash(value)]
    saveStore(file,stored)
  }
  function rotateRefresh(value) {
    if (!value||value.length>256) throw error(400,'invalid_grant')
    const stored=getStore(file)
    const entry=stored.tokens[hash(value)]
    if (!entry||entry.client!==CLIENT||entry.expires<=Math.floor(now()/1000)) throw error(400,'invalid_grant')
    delete stored.tokens[hash(value)]
    saveStore(file,stored)
    return entry
  }
  function prune(map) {
    for (const [k,v] of map) if (v.exp<now()) map.delete(k)
    if (map.size>=300) throw error(429,'too_many_requests')
  }
  function validate(query) {
    const scope=(query.get('scope')||READ).trim().split(/\s+/)
    const challenge=query.get('code_challenge')
    const state=query.get('state')||''
    if (query.get('client_id')!==CLIENT||query.get('redirect_uri')!==CALLBACK||
      query.get('resource')!==RESOURCE||query.get('response_type')!=='code'||
      query.get('code_challenge_method')!=='S256'||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge||'')||state.length>512||
      !scope.includes(READ)||scope.some(s=>s!==READ&&s!==OFFLINE))
      throw error(400,'invalid_request')
    return {challenge,state,scope:scope.join(' '),exp:now()+600000}
  }
  function isOwner(session) {
    return session?.role==='owner'&&session.amr==='passkey'&&session.sub===ownerId
  }
  async function handle(req,res,pathname,url,session) {
    if (pathname==='/.well-known/oauth-protected-resource'||
        pathname==='/.well-known/oauth-protected-resource/mcp') {
      reply(res,200,{resource:RESOURCE,authorization_servers:[ISSUER],scopes_supported:[READ,OFFLINE]})
      return true
    }
    if (pathname==='/.well-known/oauth-authorization-server') {
      reply(res,200,{
        issuer:ISSUER,authorization_endpoint:ISSUER+'/oauth/authorize',
        token_endpoint:ISSUER+'/oauth/token',revocation_endpoint:ISSUER+'/oauth/revoke',response_types_supported:['code'],
        grant_types_supported:['authorization_code','refresh_token'],
        scopes_supported:[READ,OFFLINE],token_endpoint_auth_methods_supported:['none'],
        code_challenge_methods_supported:['S256'],
        client_id_metadata_document_supported:true,
        authorization_response_iss_parameter_supported:true
      })
      return true
    }
    if (pathname==='/oauth/authorize') {
      try {
        if (req.method==='GET') {
          const request=validate(url.searchParams)
          if (!isOwner(session)) {
            redirect(res,'/login?next='+encodeURIComponent(url.pathname+url.search))
            return true
          }
          prune(consents)
          const flow=random(24)
          consents.set(flow,request)
          const form='<form method="post" action="/oauth/authorize"><input type="hidden" name="flow" value="'+esc(flow)+'"><button name="decision" value="allow">授权读取</button><button name="decision" value="deny">取消</button></form>'
          const page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>课程笔记 OAuth 授权</title>'+
            '<style>body{font:16px system-ui,sans-serif;max-width:470px;margin:12vh auto;padding:20px;line-height:1.8}button{margin:6px;padding:10px 15px}</style>'+
            '<h2>允许 ChatGPT 读取课程笔记？</h2><p>授权后可以搜索、读取已发布的笔记和专题。无法修改内容或启动补课。</p>'+form+'</html>'
          res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
            'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            'referrer-policy':'no-referrer','x-content-type-options':'nosniff'})
          res.end(page)
          return true
        }
        if (req.method==='POST') {
          if (req.headers.origin!==ISSUER||!isOwner(session)) throw error(403,'invalid_authorization')
          const form=await readForm(req)
          const id=form.get('flow')
          const saved=consents.get(id)
          consents.delete(id)
          if (!saved||saved.exp<now()) throw error(400,'invalid_request')
          const destination=new URL(CALLBACK)
          if (saved.state) destination.searchParams.set('state',saved.state)
          destination.searchParams.set('iss',ISSUER)
          if (form.get('decision')==='allow') {
            prune(codes)
            const code=random()
            codes.set(hash(code),{...saved,exp:now()+300000})
            destination.searchParams.set('code',code)
          } else destination.searchParams.set('error','access_denied')
          redirect(res,destination.toString())
          return true
        }
        throw error(405,'method_not_allowed')
      } catch(e) { reply(res,e.status||400,{error:e.message||'invalid_request'});return true}
    }
    if (pathname==='/oauth/revoke') {
      if (req.method!=='POST') {reply(res,405,{error:'method_not_allowed'});return true}
      try {
        const form=await readForm(req)
        if (form.get('client_id')!==CLIENT) throw error(400,'invalid_client')
        revokeRefresh(form.get('token'))
        reply(res,200,{})
      } catch(e) {reply(res,e.status||400,{error:e.message||'invalid_request'})}
      return true
    }
    if (pathname==='/oauth/token') {
      if (req.method!=='POST') {reply(res,405,{error:'method_not_allowed'});return true}
      try {
        const form=await readForm(req)
        if (form.get('client_id')!==CLIENT||form.get('resource')!==RESOURCE) throw error(400,'invalid_client')
        const grant=form.get('grant_type')
        if (grant==='authorization_code') {
          if (form.get('redirect_uri')!==CALLBACK) throw error(400,'invalid_grant')
          const code=form.get('code')||''
          if (code.length>256) throw error(400,'invalid_grant')
          const saved=codes.get(hash(code))
          codes.delete(hash(code))
          const verifier=form.get('code_verifier')||''
          if (!saved||saved.exp<now()||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!eq(hash(verifier),saved.challenge))
            throw error(400,'invalid_grant')
          const response={access_token:issueAccess(),token_type:'Bearer',expires_in:ACCESS_TTL,scope:saved.scope}
          if (saved.scope.split(' ').includes(OFFLINE)) response.refresh_token=createRefresh(saved.scope)
          reply(res,200,response)
          return true
        }
        if (grant==='refresh_token') {
          const saved=rotateRefresh(form.get('refresh_token'))
          reply(res,200,{access_token:issueAccess(),refresh_token:createRefresh(saved.scope),
            token_type:'Bearer',expires_in:ACCESS_TTL,scope:saved.scope})
          return true
        }
        throw error(400,'unsupported_grant_type')
      } catch(e) {reply(res,e.status||400,{error:e.message||'invalid_request'});return true}
    }
    return false
  }
  return {handle,verifyAccessToken,
    challenge:'Bearer resource_metadata="'+ISSUER+'/.well-known/oauth-protected-resource/mcp", scope="'+READ+'", error="invalid_token", error_description="Please sign in to read course notes"'}
}
