#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { startSiteServer } from '../src/server.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * 角色：public（只对外读站点，**不加载任何机密**）/ admin（管理台 + worker）/ all（老的单进程，兼容）。
 *
 * 默认 all 是为了不改变既有部署方式；生产上跑两个进程：
 *   public → 端口 3100，环境文件里只有站点目录这类公开配置，进程环境里**没有** PKU/AI/R2/管理令牌；
 *   admin  → 端口 3101，拿完整环境，能触发 worker、能读课件与账本。
 * 这样"公开接口被攻破"与"管理凭据泄露"不再是一件事。
 */
const role = String(process.env.COURSE_SITE_ROLE || 'all').toLowerCase()
if (!['public', 'admin', 'all'].includes(role)) throw new Error(`未知的 COURSE_SITE_ROLE：${role}（应为 public / admin / all）`)
const isPublic = role === 'public'
const isAdmin = role === 'admin'

// 站点目录与端口都可配置；默认只监听回环地址，对外由 nginx 直连（隧道只作兜底）。
const root = process.env.COURSE_SITE_ROOT || path.join(os.homedir(), '.course-worker', 'site')
const port = Number(process.env.COURSE_SITE_PORT || (isAdmin ? 3101 : 3100))
const host = process.env.COURSE_SITE_HOST || '127.0.0.1'
const adminToken = isPublic ? '' : (process.env.COURSE_ADMIN_TOKEN || '')
const scratchRoot = isPublic ? '' : (process.env.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.course-worker'))
// 站点目录之外的自有静态资源（Mermaid 等）。站点目录每次发布全量重写，不适合放这些。
const assetsDir = process.env.COURSE_ASSETS_DIR || path.join(os.homedir(), '.course-worker', 'assets')
// 课件归档目录：管理台上传的课件落到这里，notes 阶段从这里取（只有管理进程需要）
const materialsRoot = isPublic ? '' : (process.env.COURSE_MATERIALS_DIR || path.join(os.homedir(), '.course-worker', 'materials'))

/**
 * 公开接口的请求预算：/api/search（站内搜索）与 /mcp（AI 客户端）共用同一本账。
 *
 * 可信代理名单**默认是空的**：只有直连方在名单里时才会读 X-Forwarded-For。
 * 生产上 nginx 就在本机，它的 proxy_add_x_forwarded_for 会把真实客户端地址追加到
 * XFF 末尾，所以配 COURSE_TRUSTED_PROXIES=127.0.0.1,::1 之后按"最右不可信跳"记账；
 * 不配就等于所有请求共用一个桶（今天的行为），不会因为一个可以随便伪造的头而失效。
 * 前面还有 Cloudflare 时，用 COURSE_CLIENT_IP_HEADER=cf-connecting-ip 直接取它设的头。
 */
const listOf = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean)
const positiveOrUndefined = value => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}
const trustedProxies = listOf(process.env.COURSE_TRUSTED_PROXIES)
const clientIpHeader = String(process.env.COURSE_CLIENT_IP_HEADER || '').trim()
const rateLimitMax = positiveOrUndefined(process.env.COURSE_RATE_LIMIT_MAX)
const rateLimitWindowMs = positiveOrUndefined(process.env.COURSE_RATE_LIMIT_WINDOW_MS)
const maxConcurrent = positiveOrUndefined(process.env.COURSE_MAX_CONCURRENT)
const requestTimeoutMs = positiveOrUndefined(process.env.COURSE_REQUEST_TIMEOUT_MS)
const maxQueryChars = positiveOrUndefined(process.env.COURSE_MAX_QUERY_CHARS)

const { url } = await startSiteServer({
  root,
  port,
  host,
  admin: !isPublic,
  adminOrigin: isPublic ? (process.env.COURSE_ADMIN_ORIGIN || 'https://admin.law-tech.dev') : '',
  adminToken,
  scratchRoot,
  assetsDir,
  materialsRoot,
  ...(rateLimitMax || rateLimitWindowMs
    ? { rateLimit: { ...(rateLimitWindowMs ? { windowMs: rateLimitWindowMs } : {}), ...(rateLimitMax ? { max: rateLimitMax } : {}) } }
    : {}),
  ...(maxConcurrent ? { maxConcurrent } : {}),
  ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  ...(maxQueryChars ? { maxQueryChars } : {}),
  ...(trustedProxies.length ? { trustedProxies } : {}),
  ...(clientIpHeader ? { clientIpHeader } : {}),
  ...(isPublic
    ? {}
    : {
      // 管理台触发的手动运行走与定时任务完全相同的入口，避免两套行为
      workerPath: process.env.COURSE_SITE_WORKER || path.join(repoRoot, 'apps/worker/bin/course.mjs'),
      workerEnv: { COURSE_WORKER_SCRATCH_DIR: scratchRoot }
    })
})

console.log(
  `course-site listening on ${url} (role=${role}, root=${root}, ` +
  `admin=${isPublic ? 'not-mounted' : (adminToken ? 'enabled' : 'disabled')}, ` +
  // 预算配置打进日志：线上排"为什么 429/503"时要能一眼看出闸门开在哪
  `budget[max=${rateLimitMax || '默认'}, concurrency=${maxConcurrent || '默认'}, timeoutMs=${requestTimeoutMs || '默认'}, ` +
  `maxQueryChars=${maxQueryChars || '默认'}, trustedProxies=${trustedProxies.join('|') || '无（不读 XFF）'}` +
  `${clientIpHeader ? `, clientIpHeader=${clientIpHeader}` : ''}]`
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    process.exit(0)
  })
}
