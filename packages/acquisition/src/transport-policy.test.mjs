import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { isDirectFirst, shouldRetryThroughVpn, waitForLoopbackProxy } from './transport-policy.mjs'

test('explicit direct first and one bounded campus VPN fallback on transport failures',()=>{
 assert.equal(isDirectFirst({}),false)
 assert.equal(isDirectFirst({COURSE_ACQUISITION_DIRECT_FIRST:'1'}),true)
 for(const message of ['自动打开回放后没有捕获到 M3U8','net::ERR_CONNECTION_CLOSED','媒体请求多次失败：fetch failed','upstream HTTP 403','playlist HTTP 503']){
   assert.equal(shouldRetryThroughVpn(new Error(message)),true,message)
 }
 for(const message of ['当前课堂实录列表无法定位目标回放','回放 HLS 清单已变化；请清理该任务 fragments 后重试','账号认证失败']){
   assert.equal(shouldRetryThroughVpn(new Error(message)),false,message)
 }
 assert.equal(shouldRetryThroughVpn({code:'ACQUISITION_VPN_UNAVAILABLE',message:'net::ERR_CONNECTION_CLOSED'}),false)
})

async function startProxy(handler) {
 const server = net.createServer(handler)
 await new Promise((resolve,reject)=>{
   server.once('error',reject)
   server.listen(0,'127.0.0.1',resolve)
 })
 return {server,url:'http://127.0.0.1:'+server.address().port}
}

test('VPN fallback probe requires a successful PKU CONNECT, not just an open TCP port',async t=>{
 for(const [status,expected] of [[200,true],[503,false],[403,false]]){
   const {server,url}=await startProxy(socket=>{
     socket.once('data',data=>{
       assert.match(data.toString(),/^CONNECT course\.pku\.edu\.cn:443 HTTP\/1\.1\r\n/)
       socket.write('HTTP/1.1 '+status+' '+(status===200?'Connection Established':'Unavailable')+'\r\n\r\n')
     })
   })
   t.after(()=>server.close())
   assert.equal(await waitForLoopbackProxy(url,500),expected,'CONNECT '+status)
 }
})

test('VPN fallback probe rejects a stalled or unavailable forwarded port',async t=>{
 const {server,url}=await startProxy(()=>{})
 t.after(()=>server.close())
 assert.equal(await waitForLoopbackProxy(url,75),false)
 const address=server.address()
 await new Promise(resolve=>server.close(resolve))
 assert.equal(await waitForLoopbackProxy('http://127.0.0.1:'+address.port,100),false)
})
