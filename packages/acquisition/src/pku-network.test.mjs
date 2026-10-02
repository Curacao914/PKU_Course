import assert from 'node:assert/strict'
import test from 'node:test'

import { PKU_UNREACHABLE_HINT, describePkuFailure, looksLikeNetworkFailure } from './pku-network.mjs'

test('教学网连不上：给出"连校园网或 VPN"的明确提示，并保留原始错误', () => {
  const raw = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://course.pku.edu.cn/')
  const described = describePkuFailure(raw)
  assert.match(described.message, new RegExp(PKU_UNREACHABLE_HINT))
  assert.match(described.message, /ERR_NAME_NOT_RESOLVED/, '原始错误要留着，排查时最有用')
  assert.equal(described.code, 'PKU_UNREACHABLE')
  assert.equal(described.cause, raw)
  // 导航超时同样是"连不上"，不能只说超时
  assert.match(describePkuFailure(new Error('page.goto: Timeout 90000ms exceeded.')).message, new RegExp(PKU_UNREACHABLE_HINT))
  assert.match(describePkuFailure(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })).message, new RegExp(PKU_UNREACHABLE_HINT))
})

test('不是网络问题就不许伪装成网络问题（凭据错、页面结构变了都要原样抛出）', () => {
  const auth = Object.assign(new Error('教学网会话失效，且未配置 PKU_USERNAME / PKU_PASSWORD'), { code: 'AUTH_EXPIRED' })
  assert.equal(describePkuFailure(auth), auth)
  const layout = new Error('没有识别到统一登录表单')
  assert.equal(describePkuFailure(layout), layout)
  assert.equal(looksLikeNetworkFailure(auth), false)
  assert.equal(looksLikeNetworkFailure(new Error('net::ERR_CONNECTION_TIMED_OUT')), true)
})
