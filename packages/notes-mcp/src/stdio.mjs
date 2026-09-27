import { createInterface } from 'node:readline'

import { createProtocolServer } from './protocol.mjs'

/**
 * stdio 传输：一行一条 JSON-RPC，stdout 只许出现协议消息，日志一律走 stderr。
 *
 * 关闭 stdin（客户端断开）就是退出信号——规范把这条定为唯一可移植的优雅停机方式，
 * systemd 托管时也是这样收工的。
 *
 * 消息顺序处理：stdio 是单连接、单通道，顺序处理保证响应顺序与日志可读；
 * 我们的工具都是毫秒级（最坏情况是远程正文检索），不值得为并发引入乱序风险。
 */
export function runStdioServer({
  service,
  input = process.stdin,
  output = process.stdout,
  log = line => process.stderr.write(`${line}\n`),
  serverInfo,
  instructions
} = {}) {
  const server = createProtocolServer({ service, serverInfo, instructions, logger: log })
  const reader = createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()
  let closed = false

  const write = message => {
    try {
      output.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      // 客户端已经走了：写不进去不是错误，安静收工
      log(`[notes-mcp] 写 stdout 失败（客户端可能已断开）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleLine = async rawLine => {
    const text = String(rawLine ?? '').trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
      return
    }
    const response = await server.handleMessage(message)
    if (response) write(response)
  }

  reader.on('line', rawLine => {
    chain = chain.then(() => handleLine(rawLine)).catch(error => {
      log(`[notes-mcp] 处理消息失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })

  const finished = new Promise(resolve => {
    const done = () => {
      if (closed) return
      closed = true
      chain.then(resolve)
    }
    reader.on('close', done)
    input.on?.('end', done)
    output.on?.('error', done)
  })

  const target = service.describe?.()
  log(`[notes-mcp] 就绪：${target?.label || '数据源'}${target?.location ? `（${target.location}）` : ''}，等待 stdin 上的 JSON-RPC`)
  return finished
}
