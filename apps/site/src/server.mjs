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
  '.txt': 'text/plain; charset=utf-8',
  // Markdown 是给人和 AI 读的正文（/md/<课程>/<课次>.md）：不声明类型的话浏览器与
  // 抓取方都只能拿到 application/octet-stream，既不能就地预览，也拿不到字符集。
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
}

/**
 * 每个响应都带上的安全头。
 *
 * CSP 里的 'unsafe-inline' 是**刻意**的：站点的阅读脚本、工具栏、管理台都是内联脚本
 * （全站零依赖、没有构建步骤，这是这个项目的取舍）。它挡不住内联注入，但仍然
 * 挡住了"从外部域加载一段脚本"这类最常见的注入路径，而且不改变站点行为。
 * 真要收紧到 nonce，得让 publish 的每个页面生成器都带一个 nonce——那是另一件事。
 */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    // 站内搜索与阅读进度都走本站接口；不放开任何外部连接
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ')
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    ...SECURITY_HEADERS,
    ...headers
  })
  res.end(payload)
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, `${JSON.stringify(value, null, 2)}\n`, {
    'content-type': 'application/json; charset=utf-8',
    // 接口一律不进缓存、不进搜索引擎：里面的东西是给程序与本人看的
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    ...headers
  })
}

/** 规范化后必须仍在 root 之内，否则视为非法路径。 */
export function resolveInsideRoot(root, requestPath) {
  // 坏的百分号编码（/%E5%）会让 decodeURIComponent 抛异常——那是一段**用户输入**，
  // 绝不能让它逃逸出去变成 500/未捕获异常。这里当作非法路径返回 null（调用方按 400 处理）。
  let decoded = ''
  try {
    decoded = decodeURIComponent(String(requestPath || '/').split('?')[0])
  } catch {
    return null
  }
  const relative = decoded.replace(/^\/+/, '')
  const target = path.resolve(root, relative)
  const normalizedRoot = path.resolve(root)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) return null
  return target
}

export function createRequestHandler({
  root,
  /**
   * 管理台是否挂在这个进程上。
   *
   * 公开站点与管理台是**两个进程、两份环境**：公开进程只读站点目录与静态资源，
   * 不加载 PKU / AI / R2 / 管理令牌这些机密；管理进程才拿完整环境、才能跑 worker。
   * 这样"公开接口被攻破"与"管理凭据泄露"不再是同一件事。
   */
  admin: adminEnabled = true,
  // 公开进程上访问管理路径时，把浏览器导向管理台域名（API 调用则明确 404）
  adminOrigin = '',
  adminToken = '',
  scratchRoot = '',
  workerPath = '',
  workerEnv = {},
  assetsDir = '',
  materialsRoot = '',
  runCommand,
  siteOrigin = 'https://course.law-tech.dev',
  /**
   * Remote MCP：把笔记 MCP 挂到 `POST /mcp`。
   *
   * 数据源就是**同一个发布库**（站点根目录下的 library.json，由 course publish 写出）：
   * 没有第二份数据、不需要人工同步。本地库数据源按 mtime 判断是否重读，所以新笔记发布后
   * 不用重启服务、不用重新部署，最多等一个短缓存周期就能被 AI 看到。
   */
  mcp = true,
  mcpOrigin = siteOrigin,
  // MCP 的安全边界：默认只认自己的域名 + 本机（名单同时用于比对 Origin 与 Host，端口会被忽略）。
  // 额外域名/端口用下面两个选项加，不要为了省事把名单清空——那等于把接口交给任意站点调用。
  mcpOrigins = [],
  mcpHosts = [],
  /**
   * 公开接口共用的请求预算（限流 / 并发 / 墙钟时间 / 查询长度）。
   *
   * /api/search（站内搜索）与 /mcp（AI 客户端）用**同一个实例**：两个入口的账合在一起算。
   * 以前只有 MCP 有闸门，站内搜索一个都没有——同一台机器，绕开 MCP 打搜索一样能打满。
   *
   *   rateLimit        每 IP 每窗口的请求数（超了回 429）
   *   maxConcurrent    全局同时在处理的请求数（超了回 503）
   *   requestTimeoutMs 单次请求的墙钟预算（超了回 504，并中止后台检索）
   *   maxQueryChars    查询串长度上限（超了回 400）
   *   trustedProxies   可信代理名单：只有直连方在名单里时才读 X-Forwarded-For
   *   clientIpHeader   额外信任的单值头（Cloudflare 的 CF-Connecting-IP 这类）
   *
   * mcpRateLimit / mcpMaxConcurrent 是这两个开关的旧名字，给了就覆盖前两项。
   */
  rateLimit = { windowMs: 60_000, max: 300 },
  maxConcurrent = 8,
  requestTimeoutMs = 20_000,
  maxQueryChars,
  trustedProxies = [],
  clientIpHeader = '',
  mcpRateLimit = null,
  mcpMaxConcurrent = null
} = {}) {
  const normalizedRoot = path.resolve(root)
  const normalizedAssets = assetsDir ? path.resolve(assetsDir) : ''
  const admin = adminEnabled
    ? createAdminHandler({
      root: normalizedRoot,
      scratchRoot: scratchRoot || normalizedRoot,
      ...(materialsRoot ? { materialsRoot } : {}),
      workerPath,
      workerEnv,
      runCommand
    })
    : null

  /**
   * 笔记服务单例：MCP 与站内搜索**共用同一个**。
   *
   * 共用的理由不只是省内存：站内搜索与 AI 检索必须是同一套打分，
   * 否则同一句话在页面上和在 MCP 里给出不同的结果，人就没法判断该信哪个。
   * 懒加载：没装 notes-mcp 包（或明确关掉 MCP）时，站点照常工作。
   */
  let notesService = null
  let serviceFailed = ''
  const ensureService = async () => {
    if (notesService || serviceFailed) return { service: notesService, failed: serviceFailed }
    try {
      const { createNotesService, createLocalLibrarySource, createSemanticFallback } = await import('@course/notes-mcp')
      const libraryPath = path.join(normalizedRoot, 'library.json')
      /**
       * 语义回退（Phase 5.2 收尾）：字面检索零命中时才用，见 packages/notes-mcp/src/semantic.mjs。
       *
       * 默认**关闭**：公开进程刻意不加载任何机密，而查询向量化要一次带 key 的网络调用。
       * 要用就在公开环境里放一把**只给 embedding 用**的 key（COURSE_EMBED_API_KEY）；
       * 没配就静默关闭——而不是让公开进程去读 DASHSCOPE_API_KEY（那是整条流水线的 key）。
       */
      const semanticKey = String(process.env.COURSE_EMBED_API_KEY || '')
      const semanticIndex = String(process.env.COURSE_EMBED_INDEX || path.join(normalizedRoot, 'embeddings.json'))
      const source = createLocalLibrarySource({ file: libraryPath })
      const semantic = createSemanticFallback({
        indexFile: semanticIndex,
        apiKey: semanticKey,
        model: String(process.env.COURSE_EMBED_MODEL || 'text-embedding-v3'),
        timeoutMs: Number(process.env.COURSE_EMBED_TIMEOUT_MS || 1000),
        minScore: Number(process.env.COURSE_EMBED_MIN_SCORE || 0.55),
        // 每次语义回退前都取当前发布库 revision。site symlink 原子切换后无需重启进程，
        // 旧 embeddings 会立刻因 revision 不匹配而安全失效，直到 course embed 重绑。
        getLibraryRevision: () => source.revision(),
        // 第一次失败就写一行日志：线上排"回退为什么没生效"只能靠它（不然只能看到 used:false）
        onFailure: reason => process.stderr.write(`[site] 语义回退失败：${reason}\n`)
      })
      process.stderr.write(`[site] 语义回退：${semantic.enabled ? '已启用' : '未启用（没配 COURSE_EMBED_API_KEY）'}；索引 ${semanticIndex}\n`)
      notesService = createNotesService({
        source,
        siteOrigin: mcpOrigin,
        semantic
      })
    } catch (error) {
      serviceFailed = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[site] 笔记服务不可用：${serviceFailed}\n`)
    }
    return { service: notesService, failed: serviceFailed }
  }

  /**
   * 平铺 md 文件名 → 规范路径。按发布库现算，mtime 不变就复用。
   *
   * 课次文件名来自 slug 的最后一段（= 课次标题），所以老链接的 <课次>.md 能对上；
   * 标题被清洗过（含斜杠等）时再用 lessonTitle 兜一道。
   */
  let flatCache = { mtimeMs: 0, map: null }
  const flatMarkdownTargets = () => {
    const libraryFile = path.join(normalizedRoot, 'library.json')
    let stat
    try {
      stat = fs.statSync(libraryFile)
    } catch {
      return null
    }
    if (flatCache.map && flatCache.mtimeMs === stat.mtimeMs) return flatCache.map
    try {
      const records = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
      const map = new Map()
      for (const record of records) {
        const parts = String(record.slug || '').split('/').filter(Boolean)
        const rest = parts[0] === 'notes' ? parts.slice(1) : parts
        if (rest.length < 2) continue
        const course = rest[0]
        const lesson = rest[rest.length - 1]
        map.set(`${lesson}.md`, `md/${course}/${lesson}.md`)
        map.set(`${lesson}-一页纸.md`, `md/${course}/${lesson}-一页纸.md`)
        const title = String(record.lessonTitle || '').trim()
        if (title && title !== lesson) map.set(`${title}.md`, `md/${course}/${lesson}.md`)
      }
      flatCache = { mtimeMs: stat.mtimeMs, map }
      return map
    } catch {
      return null
    }
  }

  /**
   * 请求预算实例：/api/search 与 /mcp 共用同一个。
   *
   * 懒加载的理由与 notesService 相同：没装 @course/notes-mcp 时站点照常工作
   * （只是没有站内检索与 MCP），而不是整个进程起不来。
   */
  let requestBudget = null
  let budgetFailed = ''
  // 归还/取消的生命周期接线也来自同一个包：这套语义只有一份实现（budget.mjs）
  let bindRequestLifecycle = null
  const ensureBudget = async () => {
    if (requestBudget || budgetFailed) return requestBudget
    try {
      const { createRequestBudget, bindRequestLifecycle: bind } = await import('@course/notes-mcp')
      bindRequestLifecycle = bind
      requestBudget = createRequestBudget({
        windowMs: (mcpRateLimit || rateLimit)?.windowMs,
        max: (mcpRateLimit || rateLimit)?.max,
        maxConcurrent: mcpMaxConcurrent || maxConcurrent,
        timeoutMs: requestTimeoutMs,
        maxQueryChars,
        trustedProxies,
        clientIpHeader
      })
    } catch (error) {
      budgetFailed = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[site] 请求预算不可用：${budgetFailed}\n`)
    }
    return requestBudget
  }

  let mcpHandler = null
  let mcpFailed = ''
  const mcpPath = '/mcp'
  const ensureMcp = async () => {
    if (mcpHandler || mcpFailed) return mcpHandler
    const { service, failed } = await ensureService()
    if (!service) {
      mcpFailed = failed || 'MCP 未启用'
      return null
    }
    try {
      const budget = await ensureBudget()
      if (!budget) {
        mcpFailed = budgetFailed || '请求预算不可用'
        return null
      }
      const { createMcpHttpHandler } = await import('@course/notes-mcp')
      const siteHost = (() => {
        try {
          return new URL(siteOrigin).hostname
        } catch {
          return ''
        }
      })()
      mcpHandler = createMcpHttpHandler({
        service,
        log: line => process.stderr.write(`${line}\n`),
        allowedOrigins: [siteOrigin, 'https://admin.' + siteHost, ...mcpOrigins].filter(Boolean),
        allowedHosts: [siteHost, 'localhost', '127.0.0.1', ...mcpHosts].filter(Boolean),
        // 与 /api/search 共用同一个预算实例：账只有一本
        budget
      })
    } catch (error) {
      mcpFailed = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[site] MCP 不可用：${mcpFailed}\n`)
    }
    return mcpHandler
  }

  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(res, 400, 'bad request')
      return
    }
    const pathname = url.pathname

    // Remote MCP：长期在线的 HTTP 入口（POST 为主，所以必须在方法检查之前）
    if (mcp && (pathname === mcpPath || pathname === `${mcpPath}/`)) {
      const handler = await ensureMcp()
      if (!handler) {
        sendJson(res, 503, { ok: false, error: 'mcp_unavailable', message: mcpFailed || 'MCP 未启用' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        process.stderr.write(`[site] MCP 处理失败：${error instanceof Error ? error.message : String(error)}\n`)
        if (!res.headersSent) {
          sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: '服务器内部错误' } })
        }
      }
      return
    }

    // 管理台先接管：它要处理 POST，因此必须排在方法检查之前
    if (admin) {
      try {
        if (await admin.handle(req, res, pathname, url, { adminToken })) return
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'admin_failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
    } else if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/')) {
      /**
       * 公开进程上**没有**管理台：这不是"被拦住"，而是这里根本没有那些路由。
       *   · 浏览器访问 /admin → 302 到管理台域名（它由另一个进程提供）；
       *   · 接口调用 /api/admin/* → 明确 404，别让客户端以为"再试一次就能进"。
       */
      if (pathname.startsWith('/api/admin/')) {
        sendJson(res, 404, { ok: false, error: 'not_found', message: '管理接口不在公开站点上；请访问管理台域名' })
        return
      }
      if (adminOrigin) {
        res.writeHead(302, { location: `${String(adminOrigin).replace(/\/+$/, '')}${pathname}`, 'cache-control': 'no-store' })
        res.end()
        return
      }
      send(res, 404, 'not found', { 'cache-control': 'no-store' })
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

    /**
     * 站内搜索：与 MCP 用**同一套检索**（同一服务实例、同一打分）与**同一本预算**。
     *
     * 以前搜索页在浏览器里自己算 bigram 覆盖度：没有 IDF，泛词会把专名压下去，
     * 多词查询与整句问句也处理不了。现在页面只负责展示，检索在服务端做——
     * 同时也就能搜正文（浏览器里没有正文），并与其他入口共用限流/并发/超时预算。
     */
    if (pathname === '/api/search') {
      const query = String(url.searchParams.get('q') || '').trim()
      // 课程筛选：与 MCP 的 search_notes 一样按课程名收窄（搜索页左侧筛选栏用它）
      const course = String(url.searchParams.get('course') || '').trim()
      const rawLimit = Number(url.searchParams.get('limit'))
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 12, 1), 30)
      if (!query) {
        sendJson(res, 400, { ok: false, error: 'missing_query', message: '给一个查询词：/api/search?q=…' })
        return
      }
      const { service, failed } = await ensureService()
      if (!service) {
        sendJson(res, 503, { ok: false, error: 'search_unavailable', message: failed || '检索服务不可用' })
        return
      }
      const budget = await ensureBudget()
      if (!budget || !bindRequestLifecycle) {
        sendJson(res, 503, { ok: false, error: 'search_unavailable', message: budgetFailed || '请求预算不可用' })
        return
      }
      // 长度预算：超长查询既不是有效查询，也会炸出成千上万个 n-gram（纯 CPU 成本）。
      // 放在取槽位之前：这种请求不该占用限流额度。
      const tooLong = budget.queryProblem(query)
      if (tooLong) {
        sendJson(res, 400, { ok: false, error: 'query_too_long', message: tooLong })
        return
      }
      // 与 /mcp 同一本账：绕开 MCP 直接刷搜索一样能把这台 1.2G 的机器打满
      const slot = budget.acquire({ key: budget.addressOf(req), label: 'search' })
      if (!slot.ok) {
        sendJson(res, slot.status, { ok: false, error: slot.code, message: slot.message }, { 'retry-after': String(slot.retryAfter) })
        return
      }
      const lifecycle = bindRequestLifecycle(req, res, slot)
      try {
        // 超时 / 客户端断开都会中止检索本身（signal 一路传到检索的记录循环）
        // 不再写死 includeBody:true：覆盖策略由检索层统一决定（coverage='auto'），
        // 站点搜索与 MCP 所以及标准 search 三个入口因此拿到**同一批结果**。
        const outcome = await lifecycle.race(service.searchNotes({ query, course, limit }, { signal: slot.signal }))
        if (outcome.kind === 'gone') return
        if (outcome.kind === 'timeout') {
          if (lifecycle.canWrite()) {
            sendJson(res, 504, {
              ok: false,
              error: 'search_timeout',
              message: `检索超时（超过 ${budget.limits.timeoutMs}ms）：已中止本次检索，请换更具体的词或缩小范围后重试。`
            }, { 'retry-after': '1' })
          }
          return
        }
        const found = outcome.result
        sendJson(res, 200, {
          ok: true,
          query: found.query,
          total: found.total,
          // coverage/escalated 分开报：前者说"用没用正文"，后者说"索引答不上来才翻的正文"，
          // 页面上那行提示说的是后者（本地库正文就在内存里，auto 每句都会用到它）
          coverage: found.coverage,
          escalated: found.escalated,
          // 语义回退：字面一条都没命中时才会 used=true。页面上必须把它标出来——
          // "按意思找的"和"字面对上的"可信度不一样，读者有权知道。
          semantic: found.semantic || { used: false, enabled: false },
          lexicalTotal: found.lexicalTotal ?? found.total,
          bodyScanned: found.bodyScanned,
          fuzzy: found.fuzzy,
          terms: found.terms,
          hits: found.hits.map(hit => ({
            slug: hit.slug,
            url: `/${String(hit.slug).replace(/^\/+/, '')}.html`,
            // 小节锚点统一百分号编码：站点链接、MCP canonical URL、fetch 证据指向同一处
            anchor: hit.location?.id
              ? `/${String(hit.slug).replace(/^\/+/, '')}.html#${encodeURIComponent(hit.location.id)}`
              : '',
            courseName: hit.courseName,
            lessonTitle: hit.lessonTitle,
            lessonDate: hit.lessonDate,
            theme: hit.theme || '',
            keywords: (hit.keywords || []).slice(0, 6),
            section: hit.location?.title || '',
            sectionId: hit.location?.id || '',
            // 一篇里命中的多个小节（去重、配额）：页面可以显示"本文命中 2 处"
            sections: (hit.sections || []).map(item => ({ id: item.id, title: item.title, score: item.score })),
            // 语义命中的条目带 similarity，前端据此显示"像到什么程度"
            ...(hit.semantic ? { semantic: true, similarity: hit.similarity } : {}),
            snippets: hit.snippets
          }))
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 取消（客户端走了 / 预算到点）不是"查询写错了"，单独回 504
        if (error?.name === 'CancelledError') {
          if (lifecycle.canWrite()) {
            sendJson(res, 504, { ok: false, error: 'search_timeout', message: '检索已中止（超时或客户端断开）。' }, { 'retry-after': '1' })
          }
          return
        }
        if (!lifecycle.canWrite()) return
        // 区分"查询本身没词/不合法"与"发布库读不到"：前者是调用方的问题（400），
        // 后者是站点的问题（503）——都报 400 会让人去改查询，白费功夫。
        const serverSide = /读不到发布库|发布库不是合法 JSON|发布库格式不对/.test(message)
        sendJson(res, serverSide ? 503 : 400, {
          ok: false,
          error: serverSide ? 'library_unavailable' : 'search_failed',
          message
        })
      }
      return
    }

    if (pathname === '/favicon.ico') {
      send(res, 204, '')
      return
    }

    // 第三方静态资源（Mermaid 等）。放在站点目录之外：站点是全量重写的，
    // 把这些库混在里面迟早被一次发布覆盖掉；而且它们不需要每次重新生成。
    if (normalizedAssets && pathname.startsWith('/assets/')) {
      const asset = resolveInsideRoot(normalizedAssets, pathname.slice('/assets/'.length))
      if (!asset || !fs.existsSync(asset) || !fs.statSync(asset).isFile()) {
        // 静态资源的 404 必须明确禁止缓存：Cloudflare 对 .js/.css 这类扩展名会按默认
        // 规则缓存响应，一个"当时还不存在"的 404 会被边缘缓存住，之后文件放上去了
        // 仍然返回 404（本次实测：cf-cache-status: HIT，age 50，max-age=14400）。
        send(res, 404, 'not found', { 'cache-control': 'no-store' })
        return
      }
      const type = CONTENT_TYPES[path.extname(asset).toLowerCase()] || 'application/octet-stream'
      send(res, 200, req.method === 'HEAD' ? '' : fs.readFileSync(asset), {
        'content-type': type,
        'cache-control': 'public, max-age=86400'
      })
      return
    }

    // 坏的百分号编码（/%E5%）是一段**用户输入**：明确回 400，而不是让它变成 500。
    // resolveInsideRoot 现在也不会因它抛错（返回 null），但这里要给出准确的语义。
    try {
      decodeURIComponent(pathname)
    } catch {
      send(res, 400, 'bad request: malformed percent-encoding', { 'cache-control': 'no-store' })
      return
    }

    let candidate = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    if (candidate.endsWith('/')) candidate += 'index.html'
    const target = resolveInsideRoot(normalizedRoot, candidate)
    if (!target) {
      send(res, 403, 'forbidden')
      return
    }

    // 站点内部产物不给静态下载：library.json 是发布库（几 MB，含全部正文），
    // 对外已经有 /api/notes（索引）、/md/*.md（单篇正文）与 /mcp 三个正当入口。
    if (/^(library|\.?[^/]*\.tmp)\.json$/.test(candidate) || candidate.startsWith('library.json')) {
      send(res, 404, 'not found', { 'cache-control': 'no-store' })
      return
    }

    /**
     * 旧链接兼容：/md/<课次>.md → /md/<课程>/<课次>.md。
     *
     * 平铺路径是路径规则改版前的形状（那时两门课同一天同名课次会互相覆盖，所以改成了
     * 带课程目录）。收藏夹、聊天记录、别人转发的链接里还留着老地址，直接 404 不友好；
     * 这里按发布库把它们 302 到规范路径——只认库里真实存在的课次，不做模糊猜测。
     */
    let decodedCandidate = ''
    try {
      decodedCandidate = decodeURIComponent(candidate)
    } catch {
      decodedCandidate = ''
    }
    if (decodedCandidate.startsWith('md/') && !decodedCandidate.slice(3).includes('/')) {
      const flat = flatMarkdownTargets()
      const canonical = flat?.get(decodedCandidate.slice(3))
      if (canonical) {
        const location = `/${canonical.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
        res.writeHead(302, {
          location,
          'cache-control': 'public, max-age=3600',
          'content-length': 0
        })
        res.end()
        return
      }
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
  // 角色相关的三项必须透传下去：否则"公开进程"照样会挂上管理台（实测踩到：以为设了
  // admin:false，结果 /api/admin 仍然按"未配置令牌"回 503，而不是根本不存在的 404）。
  admin = true, adminOrigin = '',
  mcp = true, mcpOrigins = [], mcpHosts = [],
  // 公开接口共用的预算（/api/search 与 /mcp 同一本账）：整块透传，避免只改了一半
  rateLimit = undefined, maxConcurrent = undefined, requestTimeoutMs = undefined, maxQueryChars = undefined,
  trustedProxies = undefined, clientIpHeader = undefined,
  mcpRateLimit = undefined, mcpMaxConcurrent = undefined,
  siteOrigin = 'https://course.law-tech.dev',
  scratchRoot = '', workerPath = '', workerEnv = {}, assetsDir = '', materialsRoot = '', runCommand
} = {}) {
  const server = createSiteServer({
    root, adminToken, admin, adminOrigin, mcp, mcpOrigins, mcpHosts, siteOrigin,
    ...(rateLimit ? { rateLimit } : {}),
    ...(maxConcurrent ? { maxConcurrent } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    ...(maxQueryChars ? { maxQueryChars } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(clientIpHeader ? { clientIpHeader } : {}),
    // 旧名字：仍然接受，语义不变（只是现在两边共用同一个上限）
    ...(mcpRateLimit ? { mcpRateLimit } : {}),
    ...(mcpMaxConcurrent ? { mcpMaxConcurrent } : {}),
    scratchRoot, workerPath, workerEnv, assetsDir, materialsRoot, runCommand
  })
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
