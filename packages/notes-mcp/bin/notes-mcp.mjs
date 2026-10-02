#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'

import { createNotesService, createSemanticFallback, createSource, parseServerArgv, resolveSettings, runStdioServer, USAGE } from '../src/index.mjs'

// 客户端会把这条命令当子进程拉起（command + args + env），所以配置解析失败要立刻
// 以非零码退出并把用法写到 stderr——静默启动一个读不到数据的服务器最难排查。
let settings
try {
  const argv = parseServerArgv(process.argv.slice(2))
  if (argv.help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  settings = resolveSettings({ env: process.env, overrides: argv })
} catch (error) {
  process.stderr.write(`notes-mcp：${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`)
  process.exit(2)
}

/**
 * 语义回退（可选）：配了 COURSE_EMBED_API_KEY（或 DASHSCOPE_API_KEY）才开。
 * 索引默认放在发布库旁边（course embed 就写在那里）；没配就静默关闭——
 * stdio 场景下"能查字面"本身已经是可用状态，不该因为没配向量而报错。
 */
const semantic = createSemanticFallback({
  indexFile: String(process.env.COURSE_EMBED_INDEX || (settings.library ? path.join(path.dirname(settings.library), 'embeddings.json') : '')),
  libraryFile: String(settings.library || ''),
  apiKey: String(process.env.COURSE_EMBED_API_KEY || process.env.DASHSCOPE_API_KEY || ''),
  model: String(process.env.COURSE_EMBED_MODEL || 'text-embedding-v3'),
  timeoutMs: Number(process.env.COURSE_EMBED_TIMEOUT_MS || 1000),
  minScore: Number(process.env.COURSE_EMBED_MIN_SCORE || 0.55)
})
const service = createNotesService({ source: createSource(settings), semantic })
const exitCode = await runStdioServer({ service })
process.exit(exitCode ?? 0)
