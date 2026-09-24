import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { readSiteIndex } from '@course/publish'

import { createAdminHandler } from './admin.mjs'

/**
 * course.law-tech.dev 的站点服务器。
 *
 * 用原生 node:http 而不是框架：这台服务器可用内存只有 1.2G，而站点要做的只有
 * "把已经生成好的静态页面发出去"。一个常驻 50M 的进程比 300M 的框架更合适。
 *
 * 两条安全约定：
 *   1. 只服务 root 目录内的文件——路径先规范化再比对前缀，挡掉 ../../ 穿越；
 *   2. /api/admin/* 在未配置令牌时**一律拒绝**（fail closed），
 *      而不是"没配就等于开放"。
 */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'x-content-type-options': 'nosniff',
    ...headers
  })
  res.end(payload)
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, `${JSON.stringify(value, null, 2)}\n`, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  })
}

/** 规范化后必须仍在 root 之内，否则视为非法路径。 */
export function resolveInsideRoot(root, requestPath) {
  const decoded = decodeURIComponent(String(requestPath || '/').split('?')[0])
  const relative = decoded.replace(/^\/+/, '')
  const target = path.resolve(root, relative)
  const normalizedRoot = path.resolve(root)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) return null
  return target
}

export function createRequestHandler({
  root,
  adminToken = '',
  scratchRoot = '',
  workerPath = '',
  workerEnv = {},
  runCommand
} = {}) {
  const normalizedRoot = path.resolve(root)
  const admin = createAdminHandler({
    root: normalizedRoot,
    scratchRoot: scratchRoot || normalizedRoot,
    workerPath,
    workerEnv,
    runCommand
  })

  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(res, 400, 'bad request')
      return
    }
    const pathname = url.pathname

    // 管理台先接管：它要处理 POST，因此必须排在方法检查之前
    try {
      if (await admin.handle(req, res, pathname, url, { adminToken })) return
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'admin_failed', message: error instanceof Error ? error.message : String(error) })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }

    if (pathname === '/healthz') {
      let index = { count: 0, generatedAt: null }
      try {
        index = readSiteIndex(normalizedRoot)
      } catch {
        sendJson(res, 503, { ok: false, error: 'index_unreadable' })
        return
      }
      sendJson(res, 200, { ok: true, notes: index.count ?? 0, generatedAt: index.generatedAt ?? null })
      return
    }

    if (pathname === '/api/notes') {
      try {
        sendJson(res, 200, readSiteIndex(normalizedRoot))
      } catch (error) {
        sendJson(res, 503, { ok: false, error: 'index_unreadable', message: String(error.message) })
      }
      return
    }

    if (pathname === '/favicon.ico') {
      send(res, 204, '')
      return
    }

    let candidate = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    if (candidate.endsWith('/')) candidate += 'index.html'
    const target = resolveInsideRoot(normalizedRoot, candidate)
    if (!target) {
      send(res, 403, 'forbidden')
      return
    }

    // 无扩展名时补 .html，让 /notes/课程/课次 这种干净链接也能用
    const withExtension = path.extname(target) ? target : `${target}.html`

    for (const file of [target, withExtension]) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
      const body = fs.readFileSync(file)
      send(res, 200, req.method === 'HEAD' ? '' : body, {
        'content-type': type,
        'cache-control': path.extname(file) === '.html' ? 'public, max-age=60' : 'public, max-age=3600'
      })
      return
    }

    send(res, 404, 'not found')
  }
}

export function createSiteServer(options = {}) {
  return http.createServer(createRequestHandler(options))
}

/** 启动服务器；port 传 0 时由系统分配（测试用）。 */
export function startSiteServer({
  root, port = 3100, host = '127.0.0.1', adminToken = '',
  scratchRoot = '', workerPath = '', workerEnv = {}, runCommand
} = {}) {
  const server = createSiteServer({ root, adminToken, scratchRoot, workerPath, workerEnv, runCommand })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolve({
        server,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise(done => server.close(() => done()))
      })
    })
  })
}
