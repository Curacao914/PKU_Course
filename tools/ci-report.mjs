import { spawn } from 'node:child_process'

/**
 * 在 GitHub Actions 里跑测试，并把失败摘要变成**注解（annotation）**。
 *
 * 为什么需要它：Actions 的原始日志只能通过带权限的接口下载——没有 admin 权限时就是
 * 403（实测：公开仓库也一样，"Must have admin rights to Repository"）。于是"哪个用例挂了、
 * 为什么挂"只能靠人翻网页。而**注解是 check-run 的一部分，公开仓库匿名就能读**：
 *
 *   curl -s https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs
 *   # 取 output.annotations_url，再 GET 一次就能拿到下面这些消息
 *
 * 用法：node tools/ci-report.mjs <命令> [参数...]
 * 本地跑（非 Actions）时不发注解，只是原样透传命令与输出。
 */
const command = process.argv[2]
const args = process.argv.slice(3)
if (!command) {
  process.stderr.write('用法：node tools/ci-report.mjs <命令> [参数...]\n')
  process.exit(2)
}

const inActions = process.env.GITHUB_ACTIONS === 'true'
// 注解里的换行必须转义成 %0A（GitHub 的 workflow command 格式），否则只有第一行作数
const escapeData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

function failingNames(text) {
  const names = []
  // node:test 的 spec reporter 用 "✖ 用例名 (12ms)"，TAP reporter 用 "not ok 1 - 用例名"
  for (const line of text.split('\n')) {
    const spec = line.match(/^\s*✖\s+(.*?)\s*(?:\([\d.]+ms\))?\s*$/)
    if (spec && spec[1] && !names.includes(spec[1])) names.push(spec[1])
    const tap = line.match(/^not ok \d+ - (.*)$/)
    if (tap && tap[1] && !names.includes(tap[1])) names.push(tap[1])
  }
  return names.slice(0, 20)
}

function annotations(text) {
  const lines = []
  const names = failingNames(text)
  if (names.length) lines.push('测试失败（' + names.length + ' 个）：' + names.join(' | '))
  else lines.push('测试失败：没解析出用例名（可能是编译/加载错误）')
  // 末尾留 40 行：断言详情、期望值与实际值都在这里
  const tail = text.split('\n').slice(-40).join('\n')
  lines.push(tail)
  return lines
}

const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
let output = ''
child.stdout.on('data', (chunk) => { process.stdout.write(chunk); output += chunk })
child.stderr.on('data', (chunk) => { process.stderr.write(chunk); output += chunk })
child.on('error', (error) => {
  process.stderr.write('无法启动命令：' + error.message + '\n')
  process.exit(2)
})
child.on('close', (code) => {
  if ((code ?? 1) !== 0 && inActions) {
    for (const message of annotations(output)) {
      process.stdout.write('::error::' + escapeData(message) + '\n')
    }
  }
  process.exit(code ?? 1)
})
