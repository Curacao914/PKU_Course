import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openLedger } from '@course/store'

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
  // 每个 harness 自带独立内存账本：测试之间不共享状态，避免顺序污染
  const ledger = openLedger(':memory:')
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
    // 原型继承真实账本，仅屏蔽 close：新增的账本方法无需在测试里逐个转发
    openStore: () => Object.create(ledger, { close: { value: () => {} } }),
    ...overrides
  }
  return { deps, lines, errors, calls, ledger }
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

test('discover records replays into the ledger idempotently', async () => {
  const { deps, lines } = harness()
  assert.equal(await runCli(['discover'], deps), 0)
  assert.deepEqual(parse(lines.at(-1)).recorded, { inserted: 1, existing: 0 })

  assert.equal(await runCli(['discover'], deps), 0)
  assert.deepEqual(parse(lines.at(-1)).recorded, { inserted: 0, existing: 1 }, '重复发现不得重复登记')
})

test('status reports stage counts and task rows', async () => {
  const { deps, lines } = harness()
  await runCli(['discover'], deps)
  lines.length = 0
  assert.equal(await runCli(['status'], deps), 0)
  const snapshot = parse(lines.at(-1))
  assert.equal(snapshot.path, ':memory:')
  assert.ok(snapshot.stages.some(row => row.stage === 'discovered' && row.n >= 1))
  const task = snapshot.tasks.find(row => row.replay_key === 'replay-1')
  assert.equal(task.course_name, '刑法分论')
  assert.equal(task.stage, 'discovered')
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

test('download claims the ledger task, advances the stage and records an event', async () => {
  const { deps, lines, ledger } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论' }])

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  // 媒体路径由 scratchRoot 推导：<scratchRoot>/replays/<replayKey>/output/media.mp4
  const mediaPath = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'fake media')

  const code = await runCli(
    ['download', '--course-key', 'course-abc', '--replay-key', 'replay-1'],
    { ...deps, configOverrides: { scratchRoot: dir } }
  )
  const payload = parse(lines.at(-1))
  assert.equal(payload.task.from, 'discovered')
  assert.equal(payload.task.to, 'downloaded')
  assert.equal(code, 0)

  const stored = ledger.getTask('replay-1')
  assert.equal(stored.stage, 'downloaded')
  assert.equal(stored.claimed_by, '', '提交后应释放租约')
  assert.equal(stored.artifacts.mediaChecksum, 'deadbeef')
  assert.equal(ledger.events(payload.task.id).at(-1).stage, 'downloaded')
})

test('a failed download keeps the previous stage and backs off', async () => {
  const { deps, errors, ledger } = harness({
    acquire: async () => ({ download: async () => { throw new Error('upstream 503') } })
  })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])

  assert.equal(await runCli(['download', '--course-key', 'course-abc', '--replay-key', 'replay-1'], deps), 1)
  assert.match(errors.join('\n'), /upstream 503/)

  const stored = ledger.getTask('replay-1')
  assert.equal(stored.stage, 'discovered', '失败不得推进阶段')
  assert.equal(stored.last_error, 'upstream 503')
  assert.ok(stored.next_attempt_at, '失败应写入退避时间')
  assert.equal(ledger.claimTask({ replayKey: 'replay-1', workerId: 'w9' }).claimed, false)
})

test('a task already leased by someone else refuses the run', async () => {
  const { deps, errors, ledger } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.claimTask({ replayKey: 'replay-1', workerId: 'other-worker' })

  assert.equal(await runCli(['download', '--course-key', 'course-abc', '--replay-key', 'replay-1'], deps), 1)
  assert.match(errors.join('\n'), /无法领取 replay-1：leased/)
})

test('transcribe calls the python worker with the resolved paths and only ASR env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const media = path.join(dir, 'media.mp4')
  fs.writeFileSync(media, 'fake')
  const outputDir = path.join(dir, 'transcript')
  const { deps, lines, calls } = harness({
    runPython: async payload => {
      calls.python.push(payload)
      const target = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(target, { recursive: true })
      // 转录稿与汇总都要真实产出：命令以"是否真的产出转录稿"判定成功，而非仅看退出码
      fs.writeFileSync(path.join(target, 'raw-transcript.md'), '[00:00:01 – 00:00:03] 正文')
      fs.writeFileSync(path.join(target, 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 2 }))
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

test('transcribe advances the ledger task to transcript_ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const media = path.join(dir, 'media.mp4')
  fs.writeFileSync(media, 'fake')
  const outputDir = path.join(dir, 'transcript')
  const { deps, lines, ledger } = harness({
    runPython: async () => {
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'raw-transcript.md'), '[00:00:01 – 00:00:03] 正文')
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify({ chunkCount: 2, sentenceCount: 42, videoDurationSeconds: 5400 }))
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'downloaded' })

  const code = await runCli([
    'transcribe', '--media', media, '--course', '刑法分论', '--lesson', '第10-12节',
    '--replay-key', 'replay-1', '--output-dir', outputDir
  ], deps)
  assert.equal(code, 0)
  assert.equal(parse(lines.at(-1)).task.to, 'transcript_ready')

  const stored = ledger.getTask('replay-1')
  assert.equal(stored.stage, 'transcript_ready')
  assert.equal(stored.artifacts.chunkCount, 2)
  assert.equal(stored.runtime.sentenceCount, 42)
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
