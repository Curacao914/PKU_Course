#!/usr/bin/env node
import process from 'node:process'

import { createNotesService, createSource, parseServerArgv, resolveSettings, runStdioServer, USAGE } from '../src/index.mjs'

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

const service = createNotesService({ source: createSource(settings) })
const exitCode = await runStdioServer({ service })
process.exit(exitCode ?? 0)
