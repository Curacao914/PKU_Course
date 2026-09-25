import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  LOW_BALANCE_THRESHOLD_CNY,
  aliyunRpcSignature,
  classifyProviderIssue,
  fetchAliyunBalance,
  fetchDeepseekBalance,
  renderBalanceWarning
} from './billing.mjs'

test('a DeepSeek balance response is parsed into a comparable number', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, /api\.deepseek\.com\/user\/balance/)
    assert.match(options.headers.authorization, /^Bearer sk-test$/)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '13.45', granted_balance: '0.00', topped_up_balance: '13.45' }]
      })
    }
  }
  const balance = await fetchDeepseekBalance({ apiKey: 'sk-test', fetchImpl })
  assert.equal(balance.provider, 'deepseek')
  assert.equal(balance.total, 13.45)
  assert.equal(balance.available, true)
  assert.match(balance.rechargeUrl, /platform\.deepseek\.com/)
})

test('a failing balance endpoint raises instead of reporting zero', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, text: async () => 'insufficient balance' })
  await assert.rejects(() => fetchDeepseekBalance({ apiKey: 'sk', fetchImpl }), /HTTP 402/)
  await assert.rejects(() => fetchDeepseekBalance({ apiKey: '', fetchImpl }), /未配置/)
})

test('aliyun signature follows the documented RPC v1.0 algorithm', () => {
  const params = {
    Action: 'QueryAccountBalance',
    Format: 'JSON',
    Version: '2017-12-14',
    AccessKeyId: 'testid',
    SignatureNonce: 'abc',
    Timestamp: '2026-09-25T00:00:00Z'
  }
  const signature = aliyunRpcSignature({ params, accessKeySecret: 'secret' })
  // 按文档独立算一遍：GET & %2F & percentEncode(排序后的查询串)
  const encode = value => encodeURIComponent(String(value)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
  const canonical = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&')
  const expected = crypto.createHmac('sha1', 'secret&')
    .update(`GET&${encode('/')}&${encode(canonical)}`)
    .digest('base64')
  assert.equal(signature, expected)
  assert.notEqual(aliyunRpcSignature({ params, accessKeySecret: 'other' }), signature, '换密钥必须换签名')
})

test('aliyun balance reports "not configured" instead of pretending zero', async () => {
  const missing = await fetchAliyunBalance({})
  assert.equal(missing.configured, false)
  assert.match(missing.reason, /ALIYUN_ACCESS_KEY_ID/)
  assert.match(missing.rechargeUrl, /bailian/)
})

test('aliyun balance parses the BSS payload', async () => {
  const fetchImpl = async url => {
    assert.match(url, /business\.aliyuncs\.com/)
    assert.match(url, /Action=QueryAccountBalance/)
    assert.match(url, /Signature=/)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ Code: '200', Data: { AvailableAmount: 8.5, CreditAmount: 0, AvailableCashAmount: 8.5 } })
    }
  }
  const balance = await fetchAliyunBalance({ accessKeyId: 'id', accessKeySecret: 'secret', fetchImpl })
  assert.equal(balance.configured, true)
  assert.equal(balance.available, 8.5)
})

test('provider errors are classified into actionable categories', () => {
  const arrears = classifyProviderIssue('Model call failed: Arrearage · dashscope')
  assert.equal(arrears.category, 'arrears')
  assert.equal(arrears.provider, 'aliyun')
  assert.match(arrears.hint, /充值/)
  assert.match(arrears.rechargeUrl, /bailian/)

  assert.equal(classifyProviderIssue('HTTP 401 Unauthorized: invalid api key').category, 'auth')
  assert.equal(classifyProviderIssue('Throttling.User: Allocated quota exceeded').category, 'quota')
  assert.equal(classifyProviderIssue('普通网络抖动'), null, '认不出来就不要乱归类')
  assert.equal(classifyProviderIssue(''), null)
})

test('the balance warning is actionable and names the provider', () => {
  const text = renderBalanceWarning({ provider: 'deepseek', total: 1.23 })
  assert.match(text, /DeepSeek/)
  assert.match(text, /¥1\.23/)
  assert.match(text, /platform\.deepseek\.com\/top_up/)
  assert.match(text, /进度不会丢/)
  assert.ok(LOW_BALANCE_THRESHOLD_CNY > 0)
})
