#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { startSiteServer } from '../src/server.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// 站点目录与端口都可配置；默认只监听回环地址，对外由 Cloudflare Tunnel 暴露。
const root = process.env.COURSE_SITE_ROOT || path.join(os.homedir(), '.course-worker', 'site')
const port = Number(process.env.COURSE_SITE_PORT || 3100)
const host = process.env.COURSE_SITE_HOST || '127.0.0.1'
const adminToken = process.env.COURSE_ADMIN_TOKEN || ''
const scratchRoot = process.env.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.course-worker')
// 站点目录之外的自有静态资源（Mermaid 等）。站点目录每次发布全量重写，不适合放这些。
const assetsDir = process.env.COURSE_ASSETS_DIR || path.join(os.homedir(), '.course-worker', 'assets')
// 课件归档目录：管理台上传的课件落到这里，notes 阶段从这里取
const materialsRoot = process.env.COURSE_MATERIALS_DIR || path.join(os.homedir(), '.course-worker', 'materials')

const { url } = await startSiteServer({
  root,
  port,
  host,
  adminToken,
  scratchRoot,
  assetsDir,
  materialsRoot,
  // 管理台触发的手动运行走与定时任务完全相同的入口，避免两套行为
  workerPath: process.env.COURSE_SITE_WORKER || path.join(repoRoot, 'apps/worker/bin/course.mjs'),
  workerEnv: { COURSE_WORKER_SCRATCH_DIR: scratchRoot }
})

console.log(`course-site listening on ${url} (root=${root}, admin=${adminToken ? 'enabled' : 'disabled'})`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    process.exit(0)
  })
}
