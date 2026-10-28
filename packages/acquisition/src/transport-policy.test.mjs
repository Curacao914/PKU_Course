import assert from 'node:assert/strict'
import test from 'node:test'
import { isDirectFirst, shouldRetryThroughVpn } from './transport-policy.mjs'

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
