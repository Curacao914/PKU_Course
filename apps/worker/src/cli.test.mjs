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
    // 固定时钟：成本窗口按"现在几点"决定是否顺延，测试不能跟着挂钟走。
    // 2026-09-25T00:30:00Z = 北京时间 08:30，在 09:00—12:00 峰段之前。
    now: () => new Date('2026-09-25T00:30:00Z'),
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

/** 与 pipeline 测试同构的假模型：按角色分发。 */
function fakeModel() {
  const calls = []
  let writerCount = 0
  let revisionCount = 0
  const callModel = async ({ role }) => {
    calls.push(role)
    if (role === 'outline') {
      return { parsed: {
        mainLine: '主线',
        // 覆盖全部 6 行（标题行 + 5 句），避免触发覆盖修复，保持这一步只验证主干
        outline: [{ id: 'o1', title: '一、甲', lineRange: [1, 6] }]
      }, trace: { role, model: 'fake' } }
    }
    if (role === 'writer') return { parsed: { markdown: `第 ${++writerCount} 段正文` }, trace: { role } }
    if (role === 'reviewer') {
      return { parsed: {
        decision: 'approve', coverage: 90, grounding: 90, logic: 90, detail: 90, sourceCoverage: 90,
        summary: '通过', issues: []
      }, trace: { role } }
    }
    if (role === 'splicer') {
      return { parsed: { courseOverview: {}, sectionSummaries: {}, sectionQuizzes: {}, knowledgeLink: {}, appendix: {} }, trace: { role } }
    }
    if (role === 'finalReview') {
      return { parsed: {
        decision: 'approve', coverage: 90, grounding: 90, logic: 90, detail: 90, sourceCoverage: 90,
        summary: '可靠', issues: []
      }, trace: { role } }
    }
    if (role === 'revision') {
      return { parsed: { markdown: `修订后的第 ${++revisionCount} 段正文，补上了法条依据。` }, trace: { role } }
    }
    if (role === 'brief') {
      return { parsed: {
        briefing: '本节从共同故意的认定讲到共同行为的边界，老师用两个例子说明片面共犯为何不成立共同犯罪，并强调判断顺序是先看共同故意再看行为分担。',
        keyPoints: ['共同故意是成立前提', '片面共犯不成立共犯', '判断顺序不可颠倒'],
        detail: '## 本课主线\n\n从共犯的成立条件展开。'
      }, trace: { role } }
    }
    throw new Error(`未预期的角色：${role}`)
  }
  return { callModel, calls }
}

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

test('notes turns a transcript file into a completed note and a ledger stage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const transcriptPath = path.join(dir, 'raw-transcript.md')
  fs.writeFileSync(transcriptPath, [
    '# 刑法分论 · 第10-12节 · 原始课堂转录',
    '',
    '[00:00:01 – 00:00:05] 第一句课堂内容',
    '[00:00:06 – 00:00:10] 第二句课堂内容',
    '[00:00:11 – 00:00:15] 第三句课堂内容',
    '[00:00:16 – 00:00:20] 第四句课堂内容',
    '[00:00:21 – 00:00:25] 第五句课堂内容'
  ].join('\n'))

  const model = fakeModel()
  const { deps, lines, errors, ledger } = harness({ callModel: model.callModel })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'transcript_ready' })

  const code = await runCli([
    'notes', '--transcript', transcriptPath, '--course', '刑法分论', '--lesson', '第10-12节',
    '--replay-key', 'replay-1', '--output-dir', path.join(dir, 'notes')
  ], deps)

  const payload = parse(lines.at(-1))
  assert.equal(code, 0, errors.join('\n'))
  assert.equal(payload.produced, true)
  assert.equal(payload.status, 'completed')
  assert.equal(payload.task.to, 'notes_ready')

  const written = fs.readFileSync(payload.notePath, 'utf8')
  assert.match(written, /^# 第10-12节/m)
  assert.match(written, /第 1 段正文/)
  assert.equal(ledger.getTask('replay-1').stage, 'notes_ready')
  assert.ok(ledger.getTask('replay-1').artifacts.notePath)

  const summary = JSON.parse(fs.readFileSync(payload.summaryPath, 'utf8'))
  assert.equal(summary.stopReason, 'completed')
  // brief 是笔记完成后额外的一次调用：推送消息要用它，不属于流水线状态机的一部分。
  assert.deepEqual(model.calls, ['outline', 'writer', 'reviewer', 'splicer', 'finalReview', 'brief'])

  const brief = JSON.parse(fs.readFileSync(summary.brief.path, 'utf8'))
  assert.ok(brief.briefing.length >= 60, '简报要有实质内容')
  assert.ok(brief.keyPoints.length >= 1, '简报要给出要点')
})

test('notes defers to the off-peak window instead of paying peak prices', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const transcriptPath = path.join(dir, 'raw-transcript.md')
  fs.writeFileSync(transcriptPath, '[00:00:01 – 00:00:05] 内容')
  const model = fakeModel()
  // 北京时间 10:00：落在 09:00—12:00 峰段
  const { deps, lines, ledger } = harness({ callModel: model.callModel, now: () => new Date('2026-09-25T02:00:00Z') })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'transcript_ready' })

  const code = await runCli([
    'notes', '--transcript', transcriptPath, '--course', '刑法分论', '--lesson', '第10-12节',
    '--replay-key', 'replay-1', '--output-dir', path.join(dir, 'notes')
  ], deps)

  const payload = parse(lines.at(-1))
  assert.equal(code, 0, '顺延是计划内的等待，不是失败')
  assert.equal(payload.deferred, true)
  assert.equal(payload.produced, false)
  assert.equal(model.calls.length, 0, '峰段一次模型调用都不该发')
  const task = ledger.getTask('replay-1')
  assert.equal(task.stage, 'transcript_ready', '阶段不推进，等窗口开了再来')
  assert.ok(task.next_attempt_at > '2026-09-25T02:00:00', '退避到低价窗口开始时间')
})

test('--revise rewrites only the named module and keeps the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const transcriptPath = path.join(dir, 'raw-transcript.md')
  fs.writeFileSync(transcriptPath, [
    '# 刑法分论 · 第10-12节 · 原始课堂转录', '',
    '[00:00:01 – 00:00:05] 第一句', '', '[00:00:06 – 00:00:10] 第二句'
  ].join('\n'))
  const outputDir = path.join(dir, 'notes')
  const baseArgs = ['notes', '--transcript', transcriptPath, '--course', '刑法分论', '--lesson', '第10-12节', '--output-dir', outputDir]

  const first = fakeModel()
  const { deps, lines } = harness({ callModel: first.callModel })
  assert.equal(await runCli(baseArgs, deps), 0, '第一次要跑完整流程')
  const statePath = path.join(outputDir, 'lesson-state.json')
  const stateBefore = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(stateBefore.lesson.nodes.length, 1)

  // 第二次只重写被点名的模块
  const second = fakeModel()
  const code = await runCli([
    ...baseArgs, '--revise', 'o1', '--request', '把法条依据补上'
  ], { ...deps, callModel: second.callModel, stdout: line => lines.push(String(line)) })

  const payload = parse(lines.at(-1))
  assert.equal(code, 0)
  assert.equal(payload.produced, true)
  assert.ok(second.calls.includes('revision'), '走的是修订通道')
  assert.ok(!second.calls.includes('outline'), '不重新切大纲')
  const stateAfter = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(stateAfter.lesson.nodes.filter(node => node.revisionCount > 0).length, 1, '只有被点名的模块被重写')
  assert.match(stateAfter.lesson.finalNote.markdown, /补上了法条依据/, '重新拼装后的成品包含修订内容')
})

test('notes stops at the outline gate in manual mode and records why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const transcriptPath = path.join(dir, 'raw-transcript.md')
  fs.writeFileSync(transcriptPath, '[00:00:01 – 00:00:05] 内容')
  const model = fakeModel()
  const { deps, lines, ledger } = harness({ callModel: model.callModel })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])

  const code = await runCli([
    'notes', '--transcript', transcriptPath, '--course', '刑法分论', '--lesson', '第10-12节',
    '--replay-key', 'replay-1', '--auto-approve-outline', '0', '--output-dir', path.join(dir, 'notes')
  ], deps)

  const payload = parse(lines.at(-1))
  assert.equal(code, 1, '未产出完整笔记时应以非零退出')
  assert.equal(payload.produced, false)
  assert.equal(payload.idleReason ?? payload.stopReason, 'idle')
  const stored = ledger.getTask('replay-1')
  assert.equal(stored.stage, 'discovered', '未完成时应保持在原阶段，不得推进')
  assert.match(stored.last_error, /waiting-outline-approval/)
  assert.ok(stored.next_attempt_at, '未完成时应写入退避时间，避免立刻重复消费')
})

test('publish builds the site, dedupes the notification and advances the stage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({
    course: '刑法分论', lesson: '第10-12节', status: 'completed', stopReason: 'completed'
  }))
  fs.writeFileSync(path.join(notesDir, '第10-12节.md'), [
    '# 第10-12节',
    '',
    '## 课程概览',
    '',
    '共犯的成立需要共同故意与共同行为。'
  ].join('\n'))

  const siteDir = path.join(dir, 'site')
  const { deps, lines, ledger } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'notes_ready' })

  const args = [
    'publish', '--from', notesDir, '--out', siteDir,
    '--replay-key', 'replay-1', '--origin', 'https://course.law-tech.dev'
  ]
  assert.equal(await runCli(args, deps), 0)
  const payload = parse(lines.at(-1))
  assert.equal(payload.changed, true)
  assert.equal(payload.notes, 1)
  assert.equal(payload.delivery.inserted, true)
  assert.equal(payload.task.to, 'published')
  assert.ok(fs.existsSync(path.join(siteDir, 'index.html')))
  assert.ok(fs.existsSync(path.join(siteDir, 'notes/刑法分论/第10-12节.html')))
  assert.equal(ledger.getTask('replay-1').stage, 'published')

  // 内容没变时重复发布：站点照样重写，但不再通知
  assert.equal(await runCli(args, deps), 0)
  const second = parse(lines.at(-1))
  assert.equal(second.changed, false)
  assert.equal(second.delivery, null)
  assert.equal(second.notes, 1, '笔记不应重复累加')

  // 内容变了才重新通知
  fs.writeFileSync(path.join(notesDir, '第10-12节.md'), '# 第10-12节\n\n## 课程概览\n\n补充一句新的内容。')
  assert.equal(await runCli(args, deps), 0)
  assert.equal(parse(lines.at(-1)).changed, true)

  const queued = ledger.claimDelivery({ workerId: 'relay-1' })
  assert.equal(queued.purpose, 'course-note')
  assert.match(queued.object_url, /^https:\/\/course.law-tech.dev\/notes\//)
  assert.match(queued.body_text, /刑法分论 · 第10-12节/)
})

test('publish pushes the briefing, not a truncated note', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({
    course: '法律实证分析', lesson: '2026-09-23第1-2节', status: 'completed', stopReason: 'completed'
  }))
  fs.writeFileSync(path.join(notesDir, '2026-09-23第1-2节.md'), '# 2026-09-23第1-2节\n\n## 课程概览\n\n正文。')
  fs.writeFileSync(path.join(notesDir, 'brief.json'), JSON.stringify({
    schemaVersion: 1,
    briefing: '本节从数据评价的宏观维度讲到变量的测量水平，老师强调先确定分析单元再谈变量。',
    keyPoints: ['分析单元决定数据结构', '定性变量也能数字化', '测量水平决定可用统计量']
  }))

  const siteDir = path.join(dir, 'site')
  const { deps, lines, ledger } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'notes_ready' })

  const code = await runCli([
    'publish', '--from', notesDir, '--out', siteDir,
    '--replay-key', 'replay-1', '--origin', 'https://course.law-tech.dev'
  ], deps)
  assert.equal(code, 0)

  const queued = ledger.claimDelivery({ workerId: 'relay-1' })
  assert.match(queued.body_text, /本节从数据评价的宏观维度讲到变量的测量水平/, '消息正文应当是简报')
  assert.match(queued.body_text, /· 分析单元决定数据结构/, '要点要逐条列出')
  assert.ok(!/正文。/.test(queued.body_text), '不该把笔记正文截断塞进消息')
  assert.match(queued.dedupe_key, /[0-9a-f]{12}$/, '幂等键带内容指纹，内容变了才会重新推')

  const page = fs.readFileSync(path.join(siteDir, 'notes/法律实证分析/2026-09-23第1-2节.html'), 'utf8')
  assert.match(page, /本课简报/, '笔记页顶部要有简报，读者先建立基本印象')
})

test('publish refuses a directory without a notes run summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const { deps, errors } = harness()
  assert.equal(await runCli(['publish', '--from', dir], deps), 1)
  assert.match(errors.join('\n'), /找不到 .*notes-run-summary\.json/)
})

test('notify probes the channel without sending and reports missing targets', async () => {
  const probes = []
  const sender = {
    target: 'wxid_test',
    probe: async () => { probes.push(1); return { ok: true, detail: 'dry-run 成功' } },
    send: async () => { throw new Error('不应被调用') }
  }
  const { deps, lines } = harness({ sender })
  const withTarget = { ...deps, env: { ...deps.env, COURSE_WECHAT_TARGET: 'wxid_test' } }

  assert.equal(await runCli(['notify', '--probe'], withTarget), 0)
  assert.equal(parse(lines.at(-1)).ok, true)
  assert.equal(probes.length, 1)

  // 未配置目标时直接报错，不静默什么也不做
  const bare = harness({ sender })
  assert.equal(await runCli(['notify', '--probe'], bare.deps), 1)
  assert.match(bare.errors.join('\n'), /缺少推送目标/)
})

test('notify refuses to run without a configured target', async () => {
  const { deps, errors } = harness({ sender: { target: 'x', probe: async () => ({ ok: true }), send: async () => ({}) } })
  assert.equal(await runCli(['notify'], deps), 1)
  assert.match(errors.join('\n'), /缺少推送目标/)
})

test('notify sends queued deliveries and reports the counts', async () => {
  const sentMessages = []
  const sender = {
    target: 'wxid_test',
    probe: async () => ({ ok: true, detail: 'ok' }),
    send: async message => { sentMessages.push(message); return { externalId: `wx-${sentMessages.length}` } }
  }
  const { deps, lines, ledger } = harness({ sender })
  const env = { ...deps.env, COURSE_WECHAT_TARGET: 'wxid_test' }
  ledger.enqueueDelivery({
    dedupeKey: 'course-note:notes/刑法分论/第10-12节',
    purpose: 'course-note',
    bodyText: '刑法分论 · 第10-12节\n摘要若干。',
    objectUrl: '/notes/刑法分论/第10-12节.html',
    // 已到期的排队项（默认情况下 scheduled_for 为入队时刻）
    scheduledFor: '2026-01-01T00:00:00.000Z'
  })

  assert.equal(await runCli(['notify'], { ...deps, env }), 0)
  const payload = parse(lines.at(-1))
  assert.equal(payload.sent, 1)
  assert.equal(sentMessages.length, 1)
  assert.match(sentMessages[0], /打开课程笔记/)
  assert.match(sentMessages[0], /https:\/\/course.law-tech.dev\/notes\//, '相对路径应补成绝对地址')
  assert.equal(ledger.claimDelivery({ workerId: 'w', now: '2026-09-25T01:00:00.000Z' }), null, '发送后不再排队')
})

test('cycle drives one task through every stage and delivers the notification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const model = fakeModel()
  const sent = []
  const sender = {
    target: 'wxid_test',
    probe: async () => ({ ok: true }),
    send: async message => { sent.push(message); return { externalId: `wx-${sent.length}` } }
  }

  const { deps, lines, ledger } = harness({
    callModel: model.callModel,
    sender,
    // 转录阶段：真实产出转录稿，路径由命令自己推导
    runPython: async payload => {
      const outputDir = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'raw-transcript.md'), '[00:00:01 – 00:00:05] 第一句\n[00:00:06 – 00:00:10] 第二句')
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 2 }))
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  const env = { ...deps.env, COURSE_WECHAT_TARGET: 'wxid_test', COURSE_WORKER_SCRATCH_DIR: dir }
  const scratch = dir

  // 媒体与转录产物预备好，让 cycle 从 downloaded 阶段开始推进
  const mediaPath = path.join(scratch, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'fake media')

  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '第10-12节' }])
  ledger.reportStage({
    id: ledger.getTask('replay-1').id,
    stage: 'downloaded',
    data: { artifacts: { mediaPath } }
  })

  const code = await runCli(['cycle', '--max-tasks', '8'], { ...deps, env })
  const summary = parse(lines.at(-1))

  assert.equal(summary.tasks.length >= 3, true, `应推进多个阶段，实际 ${JSON.stringify(summary.tasks)}`)
  assert.deepEqual(summary.tasks.map(task => task.action), ['transcribe', 'notes', 'publish'])
  assert.equal(summary.tasks.every(task => task.ok === true), true)
  assert.equal(summary.notification.sent, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /打开课程笔记|course\.law-tech\.dev/)
  assert.equal(ledger.getTask('replay-1').stage, 'published')
  assert.equal(code, 0)
})

test('cycle reports a missing prerequisite instead of crashing', async () => {
  // 注入一个可用发送器，避免把「未配置微信」的错误混进这条断言
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({ sender: okSender })
  // 阶段是 transcript_ready，但没有 transcriptPath 产物
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'transcript_ready' })

  const code = await runCli(['cycle', '--max-tasks', '2'], deps)
  const summary = parse(lines.at(-1))
  assert.equal(summary.tasks[0].note, '缺少前置产物，跳过')
  assert.equal(code, 1, '跳过不等于成功')
  assert.equal(ledger.getTask('replay-1').stage, 'transcript_ready', '不得在缺产物时推进阶段')
})

test('cycle records a discovery failure and still finishes', async () => {
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines } = harness({
    sender: okSender,
    acquire: async () => ({ discover: async () => { throw new Error('AUTH_EXPIRED：教学网会话失效') } })
  })
  const code = await runCli(['cycle'], deps)
  const summary = parse(lines.at(-1))
  assert.deepEqual(summary.errors.map(item => item.step), ['discover'], '只记录发现问题，不应连带其它错误')
  assert.match(summary.errors[0].message, /AUTH_EXPIRED/)
  assert.equal(code, 1)
})

test('cycle does not spin on a finished task', async () => {
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({ sender: okSender })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'published' })

  const code = await runCli(['cycle', '--max-tasks', '5'], deps)
  const summary = parse(lines.at(-1))
  assert.deepEqual(summary.tasks, [], '已完成的任务不应被反复领取')
  assert.equal(code, 0)
})

test('download refuses to start when free space is below the floor', async () => {
  const { deps, errors, ledger, lines } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])

  // 把下限设成不可能满足的值，等价于"磁盘快满了"
  const env = { ...deps.env, COURSE_WORKER_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }
  assert.equal(await runCli(['download', '--course-key', 'course-abc', '--replay-key', 'replay-1'], { ...deps, env }), 1)
  assert.match(errors.join('\n'), /磁盘可用空间不足，已停止下载/)
  assert.match(errors.join('\n'), /低于下限/)

  const stored = ledger.getTask('replay-1')
  assert.equal(stored.stage, 'discovered', '磁盘不足时不得推进阶段')
  assert.equal(stored.attempts, 0, '更不该消耗重试次数——这是环境问题，不是任务问题')
  assert.equal(lines.length, 0, '不应有任何成功输出')
})

test('verify reports every unmet prerequisite instead of pretending to run', async () => {
  // 用一个没有任何凭据的环境：harness 默认会塞满凭据，掩盖"未配置"这条路径
  const { deps, lines } = harness()
  const code = await runCli(['verify'], { ...deps, env: {} })
  const report = parse(lines.at(-1))

  assert.equal(code, 1)
  assert.equal(report.ready, false)
  assert.deepEqual(report.criteria.map(item => item.ok), [true, false, false, false], '磁盘正常，三项凭据缺失')
  assert.match(report.criteria[1].name, /教学网凭据/)
  assert.match(report.criteria[3].name, /AI 凭据/)
  assert.ok(report.hint, '应给出下一步提示')
})

test('verify runs a real cycle and asserts each acceptance criterion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const model = fakeModel()
  const sent = []
  const sender = {
    target: 'wxid', probe: async () => ({ ok: true }),
    send: async message => { sent.push(message); return { externalId: 'wx-1' } }
  }
  const { deps, lines, ledger } = harness({
    callModel: model.callModel,
    sender,
    runPython: async payload => {
      const outputDir = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'raw-transcript.md'), '[00:00:01 – 00:00:05] 第一句\n[00:00:06 – 00:00:10] 第二句')
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 2 }))
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  const env = {
    ...deps.env,
    COURSE_WECHAT_TARGET: 'wxid_test',
    COURSE_WORKER_SCRATCH_DIR: dir,
    PKU_USERNAME: 'u', PKU_PASSWORD: 'p',
    DASHSCOPE_API_KEY: 'sk-x', R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
    COURSE_AI_API_KEY: 'sk-ai'
  }

  // 预备一节课：媒体已下载，等转录
  const mediaPath = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'fake media')
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '第10-12节' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'downloaded', data: { artifacts: { mediaPath } } })

  const code = await runCli(['verify', '--out', path.join(dir, 'site'), '--max-tasks', '8'], { ...deps, env })
  const report = parse(lines.at(-1))

  assert.equal(report.ready, true)
  assert.equal(report.passed, true, JSON.stringify({ criteria: report.criteria, cycle: report.cycle.tasks, errors: report.cycle.errors }, null, 1))
  assert.equal(report.criteria.every(item => item.ok), true)
  assert.equal(code, 0)
  assert.equal(sent.length, 1)

  const published = report.criteria.find(item => item.name === '笔记已发布到站点')
  assert.match(published.evidence, /站点索引 [1-9]/)
  const delivered = report.criteria.find(item => item.name === '通知已投递到微信')
  assert.match(delivered.evidence, /course-note:/)
})

test('a replay-key filter limits the cycle to exactly that lesson', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({ sender: okSender })

  // 账本里有两节课，都等着处理
  for (const key of ['replay-a', 'replay-b']) {
    ledger.discoverReplays([{ replay_key: key, course_key: 'course-' + key, course_name: '刑法分论', title: key }])
  }

  const env = { ...deps.env, COURSE_WORKER_SCRATCH_DIR: dir }
  await runCli(['cycle', '--replay-key', 'replay-b', '--max-tasks', '5'], { ...deps, env })
  const summary = parse(lines.at(-1))

  assert.deepEqual([...new Set(summary.tasks.map(task => task.replayKey))], ['replay-b'], '只应处理指定的那一条')
  assert.equal(ledger.getTask('replay-a').stage, 'discovered', '未被指定的课次不得被推进')
  assert.equal(ledger.getTask('replay-a').attempts, 0, '更不得消耗它的重试次数')
})

test('an already-finished lesson counts as done, not as a failure', async () => {
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({ sender: okSender })
  ledger.discoverReplays([{ replay_key: 'replay-a', course_key: 'course-a' }])
  ledger.reportStage({ id: ledger.getTask('replay-a').id, stage: 'published' })

  const code = await runCli(['cycle', '--replay-key', 'replay-a', '--max-tasks', '3'], deps)
  const summary = parse(lines.at(-1))
  assert.equal(summary.tasks.length, 1, '完成即结束，不应空转到 max-tasks')
  assert.equal(summary.tasks[0].action, 'done')
  assert.equal(summary.tasks[0].ok, true)
  assert.equal(code, 0, '已完成不是失败——否则验收永远显示不通过')
})

test('a replay-key filter reports why it could not claim a blocked lesson', async () => {
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({ sender: okSender })
  ledger.discoverReplays([{ replay_key: 'replay-a', course_key: 'course-a' }])
  ledger.claimTask({ replayKey: 'replay-a', workerId: 'someone-else' })

  await runCli(['cycle', '--replay-key', 'replay-a'], deps)
  const summary = parse(lines.at(-1))
  assert.equal(summary.tasks[0].ok, false)
  assert.match(summary.tasks[0].note, /未领取：leased/)
})

test('cycle writes a run summary and prunes old ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const runsDir = path.join(dir, 'runs')
  fs.mkdirSync(runsDir, { recursive: true })
  // 预置 3 个很旧的运行目录
  for (const name of ['cycle-old-1', 'cycle-old-2', 'cycle-old-3']) {
    fs.mkdirSync(path.join(runsDir, name), { recursive: true })
    fs.writeFileSync(path.join(runsDir, name, 'summary.json'), '{}')
    const past = new Date(Date.now() - 86400000)
    fs.utimesSync(path.join(runsDir, name), past, past)
  }

  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines } = harness({ sender: okSender })
  const env = { ...deps.env, COURSE_WORKER_SCRATCH_DIR: dir }
  await runCli(['cycle', '--max-tasks', '1'], { ...deps, env })

  const summary = parse(lines.at(-1))
  assert.equal(typeof summary.exitCode, 'number')

  const written = fs.readdirSync(runsDir).filter(name => !name.startsWith('cycle-old-'))
  assert.equal(written.length, 1, '本轮应写入且只写入一个运行摘要')
  const saved = JSON.parse(fs.readFileSync(path.join(runsDir, written[0], 'summary.json'), 'utf8'))
  assert.equal(saved.workerId, summary.workerId)
  assert.equal(saved.disk.ok, true)
})

test('run history keeps only the most recent entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const runsDir = path.join(dir, 'runs')
  fs.mkdirSync(runsDir, { recursive: true })
  for (let index = 0; index < 5; index += 1) {
    const target = path.join(runsDir, `cycle-${index}`)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'summary.json'), '{}')
    const at = new Date(Date.now() - index * 1000)
    fs.utimesSync(target, at, at)
  }

  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps } = harness({ sender: okSender })
  await runCli(['cycle', '--max-tasks', '1'], { ...deps, env: { ...deps.env, COURSE_WORKER_SCRATCH_DIR: dir } })

  // 本次运行又加了一个；上限 50，因此 5 个旧目录应全部保留
  assert.equal(fs.readdirSync(runsDir).length, 6)
})

test('cycle skips media work when the disk is full but still delivers notifications', async () => {
  const sent = []
  const sender = {
    target: 'wxid', probe: async () => ({ ok: true }),
    send: async message => { sent.push(message); return { externalId: 'wx-1' } }
  }
  const { deps, lines, ledger } = harness({ sender })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.enqueueDelivery({
    dedupeKey: 'course-note:x', purpose: 'course-note', bodyText: '正文', objectUrl: '/n.html',
    scheduledFor: '2026-01-01T00:00:00.000Z'
  })

  const env = { ...deps.env, COURSE_WECHAT_TARGET: 'wxid', COURSE_WORKER_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }
  const code = await runCli(['cycle', '--max-tasks', '3'], { ...deps, env })
  const summary = parse(lines.at(-1))

  assert.equal(summary.disk.ok, false)
  assert.deepEqual(summary.errors.map(item => item.step), ['disk'], '只记录磁盘问题，不应连带扫描失败')
  assert.deepEqual(summary.tasks, [], '磁盘不足时不应领取任务')
  assert.equal(summary.notification.sent, 1, '投递不占磁盘，仍应把已排队的通知发出去')
  assert.equal(sent.length, 1)
  assert.equal(code, 1)
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

test('transcribe deletes the media and fragments once the transcript exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const replayDir = path.join(dir, 'replays', 'replay-1')
  const media = path.join(replayDir, 'output', 'media.mp4')
  const fragments = path.join(replayDir, 'fragments', 'primary')
  fs.mkdirSync(path.dirname(media), { recursive: true })
  fs.mkdirSync(fragments, { recursive: true })
  fs.writeFileSync(media, Buffer.alloc(2048))
  fs.writeFileSync(path.join(fragments, 'segment-000001.ts'), Buffer.alloc(4096))

  const outputDir = path.join(replayDir, 'transcript')
  const { deps, lines } = harness({
    runPython: async payload => {
      const target = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'raw-transcript.md'), '[00:00:01 – 00:00:03] 正文')
      fs.writeFileSync(path.join(target, 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 1 }))
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  const code = await runCli([
    'transcribe', '--media', media, '--course', '刑法分论', '--lesson', '第1-2节', '--output-dir', outputDir
  ], deps)
  const payload = parse(lines.at(-1))

  assert.equal(code, 0)
  assert.equal(payload.mediaCleanup.removedBytes, 2048 + 4096)
  assert.equal(fs.existsSync(media), false, '媒体应被删除')
  assert.equal(fs.existsSync(path.join(replayDir, 'fragments')), false, '分片目录应被删除')
  assert.equal(fs.existsSync(path.join(outputDir, 'raw-transcript.md')), true, '转录稿必须保留')
})

test('COURSE_KEEP_MEDIA=1 keeps the media for a re-run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const media = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(media), { recursive: true })
  fs.writeFileSync(media, Buffer.alloc(1024))

  const { deps, lines } = harness({
    runPython: async payload => {
      const target = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'raw-transcript.md'), '正文')
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  await runCli(
    ['transcribe', '--media', media, '--course', 'c', '--lesson', 'l'],
    { ...deps, env: { ...deps.env, COURSE_KEEP_MEDIA: '1' } }
  )
  assert.equal(fs.existsSync(media), true, '显式保留时不得删除')
  assert.equal(parse(lines.at(-1)).mediaCleanup, null)
})

test('a failed transcription keeps the media so it can be retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const media = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(media), { recursive: true })
  fs.writeFileSync(media, Buffer.alloc(1024))

  const { deps } = harness({ runPython: async () => ({ code: 3, stdout: '', stderr: 'ASR down' }) })
  await runCli(['transcribe', '--media', media, '--course', 'c', '--lesson', 'l'], deps)
  assert.equal(fs.existsSync(media), true, '失败时必须保留媒体，否则重试要重新下载几 GB')
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
