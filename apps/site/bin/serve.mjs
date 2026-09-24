#!/usr/bin/env node
import process from 'node:process'

import { startSiteServer } from '../src/server.mjs'

// 站点目录与端口都可配置；默认只监听回环地址，对外由 Cloudflare Tunnel 暴露。
const root = process.env.COURSE_SITE_ROOT || new URL('../../../data/site', import.meta.url).pathname
const port = Number(process.env.COURSE_SITE_PORT || 3100)
const host = process.env.COURSE_SITE_HOST || '127.0.0.1'
const adminToken = process.env.COURSE_ADMIN_TOKEN || ''

const { url, port: actualPort } = await startSiteServer({ root, port, host, adminToken })
console.log(`course-site listening on ${url} (root=${root}, admin=${adminToken ? 'enabled' : 'disabled'})`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    process.exit(0)
  })
}
