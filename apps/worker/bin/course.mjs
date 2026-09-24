#!/usr/bin/env node
import fs from 'node:fs'

import { runCli } from '../src/cli.mjs'
import { applyEnvFile, resolveEnvFile } from '../src/env-file.mjs'

// 显式加载配置：旧系统靠模块 import 的副作用写 process.env，顺序错了就静默降级。
// 这里在入口处集中加载一次，并把「用了哪个文件、生效了哪些键」交给 doctor 展示。
const envFile = resolveEnvFile(process.env)
const applied = applyEnvFile(process.env, envFile)
if (applied.loaded) {
  try {
    fs.chmodSync(applied.path, 0o600)
  } catch {
    // 权限收紧失败不应阻断运行（例如文件属主不是当前用户）
  }
  // 同时写回进程环境：采集运行时与部分子模块是直接读 process.env 的，
  // 只把值留在配置对象里会导致它们看不到配置（表现为「找不到 Chrome」这类误报）。
  // 只填空缺，不覆盖已有变量，保持「shell > 文件 > 默认」的优先级。
  for (const key of applied.keys) process.env[key] = applied.env[key]
}

const exitCode = await runCli(process.argv.slice(2), {
  env: applied.env,
  envFile: { path: applied.path, loaded: applied.loaded, keys: applied.keys }
})
process.exit(exitCode)
