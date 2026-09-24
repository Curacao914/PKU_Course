import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './cli.mjs'

const SECRETS = {
  PKU_USERNAME: 'student-id-2026',
  PKU_PASSWORD: 'pku-password-value',
  DASHSCOPE_API_KEY: 'sk-dashscope-secret',
  R2_ACCESS_KEY_ID: 'r2-access-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret-key',
  R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_BUCKET: 'law-tech-assets'
}

/** 真正的密钥：绝不允许出现在任何输出里。R2 端点与桶名不属于此列。 */
const TRUE_SECRETS = [
  'PKU_USERNAME',
  'PKU_PASSWORD',
  'DASHSCOPE_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY'
]

function harness(overrides = {}) {
  const lines = []
  const errors = []
  const calls = { which: [], python: [], acquire: [] }
  const deps = {
    env: { ...SECRETS },
    stdout: line => lines.push(String(line)),
    stderr: line => errors.push(String(line)),
    which: async command => {
      calls.which.push(command)
      return command === 'ffmpeg' || command === 'ffprobe' || command === 'python3' ? `/usr/bin/${command}` : ''
    },
    runPython: async payload => {
      calls.python.push(payload)
      return { code: 0, stdout: 'transcribed', stderr: '' }
    },
    acquire: async () => ({
      discover: async options => {
        calls.acquire.push(options)
        return {
          loginMode: 'existing-session',
          courses: [{
            courseKey: 'course-abc',
            courseName: '刑法分论',
            normalizedName: '刑法分论',
            recordings: [{ replayKey: 'replay-1', title: '2026-05-27第10-12节', startsAtText: '2026-05-27', teacher: '车浩' }]
          }]
        }
      },
      download: async task => {
        calls.acquire.push(task)
        return { artifacts: { mediaScratchKey: 'media.mp4', mediaChecksum: 'deadbeef' }, runtime: { durationSeconds: 10785.6 } }
      }
    }),
    ...overrides
  }
  return { deps, lines, errors, calls }
}

const parse = line => JSON.parse(line)

test('help prints usage without touching dependencies', async () => {
  const { deps, lines, calls } = harness()
  assert.equal(await runCli(['help'], deps), 0)
  assert.match(lines.join('\n'), /用法：course <命令>/)
  assert.deepEqual(calls.which, [])
})

test('unknown command exits 2 with usage', async () => {
  const { deps, errors } = harness()
  assert.equal(await runCli(['explode'], deps), 2)
  assert.match(errors[0], /未知命令/)
})

test('doctor reports presence of credentials without ever printing them', async () => {
  const { deps, lines } = harness()
  const code = await runCli(['doctor'], deps)
  const report = parse(lines.at(-1))
  assert.equal(report.ready.pkuCredentials, true)
  assert.equal(report.ready.asrCredentials, true)
  assert.equal(report.ready.ffmpeg, true)
  assert.equal(report.ready.python, true)
  assert.equal(report.ready.chrome, false)
  assert.equal(report.config.credentials.PKU_PASSWORD, 'set')
  assert.equal(code, 0)

  const printed = lines.join('\n')
  for (const key of TRUE_SECRETS) {
    assert.ok(!printed.includes(SECRETS[key]), `doctor 输出泄露了 ${key}`)
  }
  // R2 端点与桶名不是密钥，应当照常显示出来便于排查
  assert.equal(report.config.storage.bucket, 'law-tech-assets')
  assert.equal(report.config.storage.endpoint, SECRETS.R2_ENDPOINT)
  assert.match(printed, /law-tech-assets/)
})

test('doctor exits 1 when a required binary is missing', async () => {
  const { deps, lines } = harness({ which: async () => '' })
  assert.equal(await runCli(['doctor'], deps), 1)
  assert.equal(parse(lines.at(-1)).ready.ffmpeg, false)
})

test('discover flattens recordings and forwards the filters', async () => {
  const { deps, lines, calls } = harness()
  const code = await runCli(['discover', '--course', '刑法分论'], deps)
  const payload = parse(lines.at(-1))
  assert.equal(code, 0)
  assert.equal(payload.replays, 1)
  assert.deepEqual(payload.recordings[0], {
    courseKey: 'course-abc',
    courseName: '刑法分论',
    teacher: '车浩',
    startsAtText: '2026-05-27',
    title: '2026-05-27第10-12节',
    replayKey: 'replay-1'
  })
  assert.deepEqual(calls.acquire[0], { courseName: '刑法分论', courseKey: '' })
})

test('discover exits 1 when the term has no recordings', async () => {
  const { deps } = harness({
    acquire: async () => ({ discover: async () => ({ loginMode: 'existing-session', courses: [] }) })
  })
  assert.equal(await runCli(['discover'], deps), 1)
})

test('discover writes the full payload when --out is given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const out = path.join(dir, 'nested', 'catalog.json')
  const { deps } = harness()
  assert.equal(await runCli(['discover', '--out', out], deps), 0)
  const written = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(written.flattened.length, 1)
  assert.equal(written.courses[0].courseName, '刑法分论')
})

test('download requires both keys and reports the media path', async () => {
  const { deps, errors } = harness()
  assert.equal(await runCli(['download', '--course-key', 'course-abc'], deps), 2)
  assert.match(errors.join('\n'), /download 缺少必填选项 --replay-key/)

  const ok = harness()
  const code = await runCli(['download', '--course-key', 'course-abc', '--replay-key', 'replay-1'], ok.deps)
  const payload = parse(ok.lines.at(-1))
  assert.equal(payload.replayKey, 'replay-1')
  assert.match(payload.mediaPath, /replay-1\/output\/media\.mp4$/)
  // 媒体文件在本测试中并不存在，因此退出码应是 1（命令如实报告未产出文件）
  assert.equal(code, 1)
})

test('transcribe calls the python worker with the resolved paths and only ASR env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const media = path.join(dir, 'media.mp4')
  fs.writeFileSync(media, 'fake')
  const outputDir = path.join(dir, 'transcript')
  const { deps, lines, calls } = harness({
    runPython: async payload => {
      calls.python.push(payload)
      fs.mkdirSync(payload.args[payload.args.indexOf('--output-dir') + 1], { recursive: true })
      fs.writeFileSync(path.join(dir, 'transcript', 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 2 }))
      return { code: 0, stdout: 'done', stderr: '' }
    }
  })

  const code = await runCli(['transcribe', '--media', media, '--course', '刑法分论', '--lesson', '第10-12节', '--output-dir', outputDir], deps)
  assert.equal(code, 0)
  const call = calls.python[0]
  assert.match(call.args[0], /paraformer_worker\.py$/)
  assert.deepEqual(call.args.slice(1, 3), ['--source', media])
  assert.equal(call.args[call.args.indexOf('--course') + 1], '刑法分论')
  assert.equal(call.args[call.args.indexOf('--chunk-minutes') + 1], '45')
  assert.equal(call.env.DASHSCOPE_API_KEY, SECRETS.DASHSCOPE_API_KEY)
  assert.equal(call.env.R2_BUCKET, SECRETS.R2_BUCKET)

  const payload = parse(lines.at(-1))
  assert.equal(payload.summary.sentenceCount, 2)
  assert.match(payload.transcript, /raw-transcript\.md$/)
})

test('transcribe refuses a missing media file and propagates worker failures', async () => {
  const { deps, errors } = harness()
  assert.equal(await runCli(['transcribe', '--media', '/nope/missing.mp4', '--course', 'c', '--lesson', 'l'], deps), 1)
  assert.match(errors.join('\n'), /找不到媒体文件/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const media = path.join(dir, 'media.mp4')
  fs.writeFileSync(media, 'fake')
  const failing = harness({ runPython: async () => ({ code: 3, stdout: '', stderr: 'ASR down' }) })
  assert.equal(await runCli(['transcribe', '--media', media, '--course', 'c', '--lesson', 'l'], failing.deps), 3)
  assert.match(failing.errors.join('\n'), /ASR down/)
})

test('a crashing command exits 1 and reports the message without a stack dump', async () => {
  const { deps, errors } = harness({
    acquire: async () => ({ discover: async () => { throw new Error('AUTH_EXPIRED：教学网会话失效') } })
  })
  assert.equal(await runCli(['discover'], deps), 1)
  assert.match(errors.join('\n'), /命令 discover 失败：AUTH_EXPIRED/)
})
