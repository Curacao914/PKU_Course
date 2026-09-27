import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { createNotesService } from '../service.mjs'
import { createSource } from '../sources.mjs'
import { noteFileName } from '../records.mjs'

/**
 * 测试夹具：一份 fixture library.json + 一个"假站点"。
 *
 * 假站点直接从同一份 fixture 现算 /api/notes（去掉正文）与 /md/*.md，
 * 这样远程测试与本地测试共享同一份数据，不会出现"两边夹具不一致"的假绿。
 * 全程监听 127.0.0.1 的随机端口，不联外网。
 */

export const LIBRARY_PATH = fileURLToPath(new URL('./library.json', import.meta.url))

export function readLibrary() {
  return JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'))
}

export function createFixtureService(overrides = {}) {
  return createNotesService({ source: createSource({ library: LIBRARY_PATH, ...overrides }) })
}

export async function startFakeSite({ records = readLibrary() } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    requests.push(url.pathname)
    if (url.pathname === '/api/notes') {
      const notes = records.map(({ markdown, ...rest }) => rest)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ siteName: '课程笔记', count: notes.length, notes }))
      return
    }
    const match = url.pathname.match(/^\/md\/(.+)$/)
    if (match) {
      const name = decodeURIComponent(match[1]).replace(/\.md$/i, '')
      const record = records.find(item => noteFileName(item.slug) === name)
      if (!record) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
      res.end(record.markdown)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve))
  }
}
