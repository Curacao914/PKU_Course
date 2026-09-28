import assert from 'node:assert/strict'
import test from 'node:test'

import { clientAddress, createRequestBudget, ipInList, normalizeIp, queryLengthProblem } from './budget.mjs'

/**
 * 请求预算的单元测试：地址判定（XFF 到底信不信）、限流、并发、超时、取消、长度。
 *
 * 这一层的每条规则都直接对应一个线上事故形状，所以测试名写的是"为什么"：
 *   · 直连方不可信时读 XFF → 谁都能换身份绕过限流；
 *   · 槽位归还只挂 finish → 客户端异常断开后并发名额永久泄漏，漏满只能重启；
 *   · 只减计数不 abort → 客户端走了，CPU 还在烧。
 */

/** 最小化的"像 IncomingMessage"的对象：只用到 socket.remoteAddress 与 headers。 */
const reqOf = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })

test('normalizeIp：去端口、去方括号与 zone、IPv4-mapped 还原成 IPv4', () => {
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp('127.0.0.1:51234'), '127.0.0.1')
  assert.equal(normalizeIp('[::1]:51234'), '::1')
  // 双栈监听时 Node 给的就是这个形状：它和 127.0.0.1 必须算同一个客户端
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp('fe80::1%lo0'), 'fe80::1')
  assert.equal(normalizeIp(' 203.0.113.9 '), '203.0.113.9')
  assert.equal(normalizeIp('not-an-ip'), '')
  assert.equal(normalizeIp(''), '')
  assert.equal(normalizeIp(undefined), '')
})

test('ipInList：整地址与 IPv4 CIDR；IPv6 只认整地址', () => {
  assert.equal(ipInList('127.0.0.1', ['127.0.0.1']), true)
  assert.equal(ipInList('127.0.0.2', ['127.0.0.1']), false)
  assert.equal(ipInList('10.1.2.3', ['10.0.0.0/8']), true)
  assert.equal(ipInList('11.1.2.3', ['10.0.0.0/8']), false)
  assert.equal(ipInList('::1', ['::1']), true)
  assert.equal(ipInList('::2', ['::1']), false)
  // 名单为空 = 谁都不信（这是默认值，语义必须是这样）
  assert.equal(ipInList('127.0.0.1', []), false)
  assert.equal(ipInList('127.0.0.1', ['乱七八糟']), false)
})

test('XFF：直连方不可信时一律不读（否则谁都能手编一个头换身份）', () => {
  const req = reqOf('203.0.113.7', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
  assert.equal(clientAddress(req), '203.0.113.7')
  assert.equal(clientAddress(req, { trustedProxies: ['127.0.0.1'] }), '203.0.113.7')
  // 直连方是 IPv4-mapped 形状时也一样：不可信就不读头
  const mapped = reqOf('::ffff:203.0.113.7', { 'x-forwarded-for': '1.2.3.4' })
  assert.equal(clientAddress(mapped, { trustedProxies: ['127.0.0.1'] }), '203.0.113.7')
})

test('XFF：直连方可信时取最右不可信跳，客户端伪造的前缀影响不了身份', () => {
  const trusted = ['127.0.0.1']
  // nginx 的 proxy_add_x_forwarded_for 会把真实客户端追加到末尾
  assert.equal(
    clientAddress(reqOf('127.0.0.1', { 'x-forwarded-for': '9.9.9.9' }), { trustedProxies: trusted }),
    '9.9.9.9'
  )
  // 客户端自己塞了一段假前缀：最右边的那个才是 nginx 亲眼看到的地址
  assert.equal(
    clientAddress(reqOf('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 9.9.9.9' }), { trustedProxies: trusted }),
    '9.9.9.9'
  )
  // 多跳：右边第一跳也是可信代理（本机 nginx 到本机另一个代理）时继续往左找
  assert.equal(
    clientAddress(reqOf('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 127.0.0.1' }), { trustedProxies: trusted }),
    '9.9.9.9'
  )
  // 整条链都不可信 / 头值不是合法地址 / 头缺失 → 退回直连地址
  assert.equal(clientAddress(reqOf('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }), { trustedProxies: trusted }), '127.0.0.1')
  assert.equal(clientAddress(reqOf('127.0.0.1', { 'x-forwarded-for': 'garbage' }), { trustedProxies: trusted }), '127.0.0.1')
  assert.equal(clientAddress(reqOf('127.0.0.1'), { trustedProxies: trusted }), '127.0.0.1')
})

test('单值转发头（CF-Connecting-IP 这类）只在直连方可信时生效，且能退回 XFF', () => {
  const trusted = ['127.0.0.1']
  const headers = { 'cf-connecting-ip': '198.51.100.5', 'x-forwarded-for': '203.0.113.9' }
  assert.equal(clientAddress(reqOf('127.0.0.1', headers), { trustedProxies: trusted, clientIpHeader: 'cf-connecting-ip' }), '198.51.100.5')
  // 头里有垃圾值时不能因此丢掉身份：退回 XFF
  assert.equal(
    clientAddress(reqOf('127.0.0.1', { ...headers, 'cf-connecting-ip': 'x' }), { trustedProxies: trusted, clientIpHeader: 'cf-connecting-ip' }),
    '203.0.113.9'
  )
  // 不可信的直连方带了同样的头：忽略
  assert.equal(
    clientAddress(reqOf('203.0.113.7', headers), { trustedProxies: trusted, clientIpHeader: 'cf-connecting-ip' }),
    '203.0.113.7'
  )
})

test('并发槽位：归还幂等——重复 release 只减一次，不会把计数减到负数', () => {
  const budget = createRequestBudget({ maxConcurrent: 1, max: 0 })
  const first = budget.acquire({ key: 'a' })
  assert.equal(first.ok, true)
  assert.equal(budget.stats().inFlight, 1)

  // 满员：再来一个必须被挡住，而且是 503（不是 429：这是并发不是频率）
  const second = budget.acquire({ key: 'b' })
  assert.equal(second.ok, false)
  assert.equal(second.status, 503)
  assert.equal(second.code, 'busy')

  // finish 与 close 都会调 release：第二次无效，也不该把 inFlight 减成 -1
  assert.equal(first.release(), true)
  assert.equal(first.release(), false)
  assert.equal(budget.stats().inFlight, 0)
  assert.equal(budget.stats().released, 1)

  // 归还之后立刻能再进来（不需要重启）
  const third = budget.acquire({ key: 'c' })
  assert.equal(third.ok, true)
  third.release()
  assert.equal(budget.stats().inFlight, 0)
})

test('限流：按客户端地址记账，窗口滑动，别的地址不受影响', () => {
  let now = 1_000
  const budget = createRequestBudget({ windowMs: 1_000, max: 2, maxConcurrent: 8, now: () => now })
  assert.equal(budget.acquire({ key: 'a' }).ok, true)
  assert.equal(budget.acquire({ key: 'a' }).ok, true)
  const blocked = budget.acquire({ key: 'a' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 429)
  assert.equal(blocked.code, 'rate_limited')
  assert.equal(blocked.retryAfter, 1)
  // 另一个地址照常（限流是每客户端，不是全局）
  assert.equal(budget.acquire({ key: 'b' }).ok, true)
  // 窗口过后恢复
  now += 1_001
  assert.equal(budget.acquire({ key: 'a' }).ok, true)
  // max=0 表示不限流（老配置里 rateLimit.max 为 0 就是这个意思）。
  // 注意：不限流不等于不限并发，所以每次都要归还槽位，否则会撞上并发闸门。
  const unlimited = createRequestBudget({ max: 0 })
  for (let index = 0; index < 50; index += 1) {
    const slot = unlimited.acquire({ key: 'x' })
    assert.equal(slot.ok, true)
    slot.release()
  }
})

test('超时：到点 abort 取消信号（不是只把计数减回去），且只记一次', async () => {
  const budget = createRequestBudget({ timeoutMs: 20, maxConcurrent: 4 })
  const slot = budget.acquire({ key: 'a' })
  assert.equal(slot.signal.aborted, false)
  const outcome = await Promise.race([
    slot.whenTimedOut.then(() => 'timeout'),
    new Promise(resolve => setTimeout(() => resolve('waited'), 500))
  ])
  assert.equal(outcome, 'timeout')
  assert.equal(slot.timedOut, true)
  assert.equal(slot.signal.aborted, true, '超时必须 abort：后台工作要真的停下来')
  // 超时后归还仍然是幂等的，计数不会因为超时而漏
  assert.equal(slot.release(), true)
  assert.equal(slot.release(), false)
  assert.equal(budget.stats().inFlight, 0)
  assert.equal(budget.stats().timedOut, 1)
  // timeoutMs=0 表示不限时
  const forever = createRequestBudget({ timeoutMs: 0 })
  const slow = forever.acquire({ key: 'b' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(slow.timedOut, false)
  assert.equal(slow.signal.aborted, false)
  slow.release()
})

test('客户端断开：cancel 幂等，abort 信号只触发一次', async () => {
  const budget = createRequestBudget({ timeoutMs: 0, maxConcurrent: 2 })
  const slot = budget.acquire({ key: 'a' })
  let aborts = 0
  slot.signal.addEventListener('abort', () => { aborts += 1 })
  assert.equal(slot.cancel('client_gone'), true)
  assert.equal(slot.cancel('client_gone'), false)
  assert.equal(slot.signal.aborted, true)
  assert.equal(aborts, 1)
  assert.equal(slot.clientGone, true)
  assert.equal(await slot.whenClientGone, true, 'whenClientGone 必须已经落地，否则 race() 会一直等下去')
  assert.equal(slot.release(), true)
  assert.equal(budget.stats().clientGone, 1)
  assert.equal(budget.stats().inFlight, 0)
})

test('queryLengthProblem：按字符（码点）算长度，边界上下各一条', () => {
  assert.equal(queryLengthProblem('x'.repeat(200), 200), '')
  assert.match(queryLengthProblem('x'.repeat(201), 200), /查询过长：201 字，上限 200 字/)
  // 中文按字算：200 个汉字就是 200（不是 600 字节）
  assert.equal(queryLengthProblem('法'.repeat(200), 200), '')
  assert.match(queryLengthProblem('法'.repeat(201), 200), /201 字/)
  // 0 / 未配置 = 不限长
  assert.equal(queryLengthProblem('x'.repeat(5_000), 0), '')
  assert.equal(queryLengthProblem(''), '')
})
