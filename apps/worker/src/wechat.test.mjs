import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WECHAT_REACTIVATION_HINT,
  describeWechatSession,
  formatSessionAge,
  wechatActivationPlan
} from './wechat.mjs'

/**
 * 微信会话：判定要说人话，结论要有根据。
 *
 * 阈值是 12 小时（WECHAT_SESSION_MAX_AGE_MINUTES = 720）。这里全部用**固定数字**
 * 当作"现在"，不碰挂钟——否则测试会在半夜或跨天时飘。
 */

test('会话时长说人话：分钟与小时', () => {
  assert.equal(formatSessionAge(0), '0 分钟前')
  assert.equal(formatSessionAge(45), '45 分钟前')
  assert.equal(formatSessionAge(60), '1 小时前')
  assert.equal(formatSessionAge(23 * 60), '23 小时前')
})

test('过期与否直接写进一句话：超过 12 小时就是"已过期（超过 12 小时）"', () => {
  const fresh = describeWechatSession({ session: { ok: true, ageMinutes: 90 } })
  assert.equal(fresh.fresh, true)
  assert.equal(fresh.expired, false)
  assert.equal(fresh.limitHours, 12)
  assert.equal(fresh.summary, '最近互动 2 小时前', '没过期时只报互动时间')

  // 用固定时钟：23 小时前互动过，早超过 720 分钟的阈值
  const expired = describeWechatSession({ session: { ok: true, ageMinutes: 23 * 60 } })
  assert.equal(expired.fresh, false)
  assert.equal(expired.expired, true)
  assert.equal(expired.summary, '已过期（超过 12 小时）：最近互动 23 小时前', '不给用户留一道减法')

  // 正好卡在阈值上不算过期（<= 阈值）
  assert.equal(describeWechatSession({ session: { ok: true, ageMinutes: 720 } }).expired, false)
  assert.equal(describeWechatSession({ session: { ok: true, ageMinutes: 721 } }).expired, true)

  // 阈值可配：改成 2 小时时提示里的数字也跟着变
  assert.equal(describeWechatSession({ session: { ok: true, ageMinutes: 181 }, maxAgeMinutes: 120 }).summary,
    '已过期（超过 2 小时）：最近互动 3 小时前')

  const unknown = describeWechatSession({ session: { ok: false, reason: '机器人还没收到过你的消息' } })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.expired, false, '判断不出来时不能说"已过期"')
  assert.equal(unknown.summary, '不可用')
})

test('会话过期：如实写明"不能自动激活"，不假装试过', () => {
  const fresh = wechatActivationPlan({ session: { ok: true, ageMinutes: 30 } })
  assert.equal(fresh.needed, false)
  assert.equal(fresh.ok, true)
  assert.equal(fresh.attempted, false)
  assert.equal(fresh.hint, '')

  const expired = wechatActivationPlan({ session: { ok: true, ageMinutes: 23 * 60 } })
  assert.equal(expired.needed, true)
  assert.equal(expired.expired, true)
  assert.equal(expired.ok, false)
  assert.equal(expired.attempted, false, '没有可用的非交互式入口，就不要假装试过')
  assert.match(expired.reason, /会话已过期/)
  assert.equal(expired.hint, WECHAT_REACTIVATION_HINT)
  assert.match(expired.hint, /给微信机器人发一条消息/)
  assert.ok(expired.evidence.length >= 3, '结论要带依据，不能只有一句话')
  assert.match(expired.evidence.join('\n'), /扫码/)

  const missing = wechatActivationPlan({ session: { ok: false, reason: '没有找到微信通道状态目录' } })
  assert.equal(missing.needed, true, '状态读不出来时也要提醒，不能默认为"能推"')
  assert.match(missing.reason, /没有找到微信通道状态目录/)
})
