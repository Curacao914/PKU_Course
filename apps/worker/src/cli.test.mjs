import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { briefSourceChecksum } from '@course/notes'
import { markdownChecksum } from '@course/publish'
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

/**
 * 造一份归档课件（meta.json + 解析结果），供课件相关的断言使用。
 *
 * 形状与 packages/materials 的归档一致：<root>/<课程>/<课次>/meta.json 里一条记录，
 * slides/<名>.json 是解析出来的文字。列表判据（listMaterials）与笔记读盘（readDecks）
 * 走的都是这两个文件，所以夹具必须是这个形状，不能只丢一个空目录。
 */
function writeDeckFixture(scratchRoot, {
  course = '刑法分论', lesson = '第10-12节', replayKey = 'replay-1', name = '讲座课件.pptx', scope = 'lesson'
} = {}) {
  const dir = scope === 'course'
    ? path.join(scratchRoot, 'materials', course, 'course')
    : path.join(scratchRoot, 'materials', course, lesson)
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
  const parsedPath = path.join(dir, 'slides', `${name}.json`)
  fs.writeFileSync(parsedPath, JSON.stringify({
    slideCount: 2,
    slides: [{ slideNumber: 1, text: '共同故意' }, { slideNumber: 2, text: '共同行为' }],
    images: [],
    ocr: { pending: 0 }
  }))
  const metaPath = path.join(dir, 'meta.json')
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { materials: [] }
  meta.materials = [...(meta.materials || []), {
    name, scope, course, lesson: scope === 'course' ? '' : lesson,
    replayKey: scope === 'course' ? '' : replayKey, appliesTo: [],
    bytes: 4, checksum: `fixture-${name}`, slideCount: 2, imageCount: 0, ocrPending: 0,
    parsedPath, addedAt: '2026-09-25T00:00:00.000Z'
  }]
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  return { dir, metaPath, parsedPath }
}

test('brief --from 把主题与关键词写进 brief.json（曾经只进了 stdout，页面那一列一直是空的）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-brief-'))
  const notePath = path.join(dir, '第10-12节.md')
  fs.writeFileSync(notePath, [
    '# 第10-12节 共犯与罪数',
    '',
    '## 一、共犯的成立条件',
    '',
    '共同故意是共犯成立的主观要件，共同行为是客观要件，二者缺一不可。',
    '',
    '<details><summary>元数据</summary>',
    '<pre><code>',
    'META: CONCEPT: 共同故意',
    '</code></pre>',
    '</details>'
  ].join('\n'))

  const model = fakeModel()
  const { deps } = harness({ callModel: model.callModel })
  const code = await runCli(['brief', '--from', dir, '--course', '刑法分论', '--lesson', '第10-12节'], deps)
  assert.equal(code, 0)

  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'))
  assert.equal(brief.theme, '共犯成立的条件与判断顺序', '主题必须落盘')
  assert.deepEqual(brief.keywords, ['共同故意', '共同行为', '片面共犯', '共犯成立'], '关键词必须落盘')
  assert.equal(brief.course, '刑法分论')
  assert.ok(brief.briefing.length >= 60)
  // 绑定字段：这份简报是给哪一门课、哪一节、哪一版正文生成的（发布时要靠它认出串课）
  assert.equal(brief.lesson, '第10-12节')
  assert.equal(brief.sourceChecksum, briefSourceChecksum(fs.readFileSync(notePath, 'utf8')), '指纹来自生成侧')
  assert.equal(brief.sourceChars, fs.readFileSync(notePath, 'utf8').length)
  assert.ok(brief.generatedAt, '生成时间也要落盘')
  // 简报输入只要标题与每节开头：不该把整篇笔记喂进去
  const payload = model.payloads.find(item => item.role === 'brief')
  const sent = JSON.stringify(payload.prompt)
  assert.ok(sent.includes('各节标题与开头'), '简报输入应当是成品正文的小节标题与开头')
  assert.ok(!sent.includes('META: CONCEPT'), 'META 原始行不进简报输入')
})

const parse = line => JSON.parse(line)

/**
 * 指纹一律引真实实现，不在测试里自己算一个"看起来一样"的：
 *   简报 → `briefSourceChecksum`（@course/notes）
 *   一页纸 → `markdownChecksum`（@course/publish）
 * 两者现已同口径（CRLF→LF、去掉结尾空白再取 SHA-256）；测试自己实现一份的话，
 * 两边算法一旦漂移，测试会跟着一起漂。
 */

/** 与 pipeline 测试同构的假模型：按角色分发。 */
function fakeModel() {
  const calls = []
  const payloads = []
  let writerCount = 0
  let revisionCount = 0
  const callModel = async payload => {
    const { role } = payload
    calls.push(role)
    payloads.push(payload)
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
        theme: '共犯成立的条件与判断顺序',
        keywords: ['共同故意', '共同行为', '片面共犯', '共犯成立'],
        detail: '## 本课主线\n\n从共犯的成立条件展开。'
      }, trace: { role } }
    }
    throw new Error(`未预期的角色：${role}`)
  }
  return { callModel, calls, payloads }
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
  assert.deepEqual(parse(lines.at(-1)).recorded, {
    inserted: 1,
    existing: 0,
    created: [{ replayKey: 'replay-1', courseName: '刑法分论', title: '2026-05-27第10-12节' }]
  })

  assert.equal(await runCli(['discover'], deps), 0)
  assert.deepEqual(parse(lines.at(-1)).recorded, { inserted: 0, existing: 1, created: [] }, '重复发现不得重复登记')
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

test('prune deletes originals only after the text is verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const scratch = path.join(dir, 'scratch')
  const replay = path.join(scratch, 'replays', 'replay-1')
  fs.mkdirSync(path.join(replay, 'transcript'), { recursive: true })
  fs.mkdirSync(path.join(replay, 'output'), { recursive: true })
  fs.mkdirSync(path.join(replay, 'fragments', 'primary'), { recursive: true })
  const transcript = `# 转录\n\n${'[00:00:01 – 00:00:05] 一句话。\n'.repeat(60)}`
  fs.writeFileSync(path.join(replay, 'transcript', 'raw-transcript.md'), transcript)
  fs.writeFileSync(path.join(replay, 'output', 'media.mp4'), Buffer.alloc(2048, 7))
  fs.writeFileSync(path.join(replay, 'fragments', 'primary', 'seg.ts'), Buffer.alloc(512, 3))
  const checksum = crypto.createHash('sha256').update(transcript).digest('hex')
  fs.writeFileSync(path.join(replay, 'transcript', 'run-summary.json'), JSON.stringify({ transcriptChecksum: checksum }))

  const { deps, lines } = harness({ configOverrides: { scratchRoot: scratch } })

  // 预演：只报告，不删
  assert.equal(await runCli(['prune'], deps), 0)
  const dry = parse(lines.at(-1))
  assert.ok(dry.freedBytes > 2000, '预演要算出可清理的字节数')
  assert.ok(fs.existsSync(path.join(replay, 'output', 'media.mp4')), '预演不得删除任何东西')

  // 真删：转录稿校验通过才动
  assert.equal(await runCli(['prune', '--apply'], deps), 0)
  assert.ok(!fs.existsSync(path.join(replay, 'output', 'media.mp4')), '校验通过后删除原件')
  assert.ok(!fs.existsSync(path.join(replay, 'fragments')), '分片一并清理')
  assert.ok(fs.existsSync(path.join(replay, 'transcript', 'raw-transcript.md')), '纯文本永久保留')
  assert.ok(fs.existsSync(path.join(replay, 'transcript', 'run-summary.json')))
})

test('prune keeps the original when the transcript does not match its checksum', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const scratch = path.join(dir, 'scratch')
  const replay = path.join(scratch, 'replays', 'replay-2')
  fs.mkdirSync(path.join(replay, 'transcript'), { recursive: true })
  fs.mkdirSync(path.join(replay, 'output'), { recursive: true })
  fs.writeFileSync(path.join(replay, 'transcript', 'raw-transcript.md'), '正文'.repeat(400))
  fs.writeFileSync(path.join(replay, 'output', 'media.mp4'), Buffer.alloc(2048, 1))
  fs.writeFileSync(path.join(replay, 'transcript', 'run-summary.json'), JSON.stringify({ transcriptChecksum: 'deadbeef' }))

  const { deps, lines } = harness({ configOverrides: { scratchRoot: scratch } })
  assert.equal(await runCli(['prune', '--apply'], deps), 0)
  const report = parse(lines.at(-1))
  assert.equal(report.freedBytes, 0, '校验和不符时一个字节都不删')
  assert.ok(fs.existsSync(path.join(replay, 'output', 'media.mp4')))
  assert.match(report.skipped[0].reason, /校验和不符/)
})

test('materials archives a deck and notes uses it as writing material', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const archive = path.join(dir, 'materials')
  const deckPath = path.join(dir, '第4讲.json')
  fs.writeFileSync(deckPath, JSON.stringify({
    slides: [{ slideNumber: 1, text: '第四讲 变量测量水平' }, { slideNumber: 2, text: '定类 定序 定距 定比' }]
  }))

  const model = fakeModel()
  const { deps, lines } = harness({ callModel: model.callModel, configOverrides: { materialsRoot: archive } })

  const archived = await runCli(['materials', '--file', deckPath, '--course', '刑法分论', '--lesson', '第10-12节'], deps)
  assert.equal(archived, 0)
  assert.equal(parse(lines.at(-1)).slideCount, 2)

  const listed = await runCli(['materials', '--course', '刑法分论', '--lesson', '第10-12节'], deps)
  assert.equal(listed, 0)
  assert.equal(parse(lines.at(-1)).materials.length, 1)

  // 笔记流程必须真的把课件带进提示词，否则"课件参与写作"只是文档里的一句话
  const transcriptPath = path.join(dir, 'raw-transcript.md')
  fs.writeFileSync(transcriptPath, '[00:00:01 – 00:00:05] 内容')
  await runCli([
    'notes', '--transcript', transcriptPath, '--course', '刑法分论', '--lesson', '第10-12节',
    '--output-dir', path.join(dir, 'notes')
  ], deps)

  const outlineCall = model.payloads.find(payload => payload.role === 'outline')
  assert.ok(outlineCall, '大纲调用应当发生')
  assert.match(outlineCall.prompt.user, /变量测量水平/, '课件文字必须出现在大纲材料里')
  assert.match(outlineCall.prompt.user, /PptAndSupplementSource/)
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

test('notes 阶段写出的 brief.json 与成品正文绑定，publish 认它（自己产的东西自己敢挂）', async () => {
  // 这条把生成侧与校验侧连起来测：两边的指纹算法必须成对（一个 trimEnd、一个不 trimEnd，
  // 就会变成"自己生成的简报自己不敢挂"）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const transcriptPath = path.join(dir, 'raw-transcript.md')
  fs.writeFileSync(transcriptPath, '[00:00:01 – 00:00:05] 内容')
  const notesDir = path.join(dir, 'notes')
  const model = fakeModel()
  const { deps, lines, errors, ledger } = harness({ callModel: model.callModel })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])

  assert.equal(await runCli([
    'notes', '--transcript', transcriptPath, '--course', '刑法分论', '--lesson', '第10-12节',
    '--replay-key', 'replay-1', '--output-dir', notesDir
  ], deps), 0, 'stderr: ' + errors.join(' | '))

  const noteText = fs.readFileSync(path.join(notesDir, '第10-12节.md'), 'utf8')
  const brief = JSON.parse(fs.readFileSync(path.join(notesDir, 'brief.json'), 'utf8'))
  assert.equal(brief.course, '刑法分论')
  assert.equal(brief.lesson, '第10-12节')
  assert.equal(brief.replayKey, 'replay-1')
  assert.equal(brief.sourceChecksum, briefSourceChecksum(noteText), '指纹按生成侧那套算（会做换行规范化）')
  assert.equal(brief.sourceChars, noteText.length)
  assert.ok(brief.generatedAt)

  // 发布这一份：必须被采纳——不是 unbound，更不是中止发布
  const siteDir = path.join(dir, 'site')
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--replay-key', 'replay-1', '--no-notify'], deps), 0, 'stderr: ' + errors.join(' | '))
  assert.deepEqual(parse(lines.at(-1)).brief, { applied: true, reason: 'ok' })
  assert.match(fs.readFileSync(path.join(siteDir, 'notes/刑法分论/第10-12节.html'), 'utf8'), /本课简报/, '简报要真的挂到页面上')
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
  const noteText = '# 2026-09-23第1-2节\n\n## 课程概览\n\n正文。'
  fs.writeFileSync(path.join(notesDir, '2026-09-23第1-2节.md'), noteText)
  // 简报必须带 sourceChecksum：它是"生成时刻那一版正文"的指纹，
  // 对不上（正文改过、或老文件根本没有指纹）就不挂它（见 publish 的 resolveDerived）
  fs.writeFileSync(path.join(notesDir, 'brief.json'), JSON.stringify({
    schemaVersion: 1,
    course: '法律实证分析',
    lesson: '2026-09-23第1-2节',
    replayKey: 'replay-1',
    sourceChecksum: briefSourceChecksum(noteText),
    sourceChars: noteText.length,
    generatedAt: '2026-09-25T00:00:00.000Z',
    briefing: '本节从数据评价的宏观维度讲到变量的测量水平，老师强调先确定分析单元再谈变量。',
    keyPoints: ['分析单元决定数据结构', '定性变量也能数字化', '测量水平决定可用统计量']
  }))

  const siteDir = path.join(dir, 'site')
  const { deps, lines, ledger, errors } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'notes_ready' })

  const code = await runCli([
    'publish', '--from', notesDir, '--out', siteDir,
    '--replay-key', 'replay-1', '--origin', 'https://course.law-tech.dev'
  ], deps)
  assert.equal(code, 0, 'stderr: ' + errors.join(' | '))

  const queued = ledger.claimDelivery({ workerId: 'relay-1' })
  assert.match(queued.body_text, /本节从数据评价的宏观维度讲到变量的测量水平/, '消息正文应当是简报')
  assert.match(queued.body_text, /· 分析单元决定数据结构/, '要点要逐条列出')
  assert.ok(!/正文。/.test(queued.body_text), '不该把笔记正文截断塞进消息')
  assert.match(queued.dedupe_key, /[0-9a-f]{12}$/, '幂等键带内容指纹，内容变了才会重新推')

  const page = fs.readFileSync(path.join(siteDir, 'notes/法律实证分析/2026-09-23第1-2节.html'), 'utf8')
  assert.match(page, /本课简报/, '笔记页顶部要有简报，读者先建立基本印象')
})

/**
 * 假模型：只回答派生物那两种角色（brief / onepage）。
 * publish 的 --regenerate-derived 走这条路验证"自动重新生成"，绝不真调 API。
 */
function fakeDerivedModel() {
  const calls = []
  const callModel = async payload => {
    calls.push(payload.role)
    if (payload.role === 'brief') {
      return {
        parsed: {
          briefing: '重新生成后的简报：这一版正文把分析单元与变量测量分开讲，先说清分析单元决定了数据结构，' +
            '再讲定性变量同样可以数字化，最后落到测量水平决定能用哪些统计量。',
          keyPoints: ['要点一', '要点二', '要点三'],
          theme: '重新生成的主题',
          keywords: ['甲', '乙'],
          detail: '## 主线'
        },
        trace: { role: 'brief' }
      }
    }
    if (payload.role === 'onepage') {
      return { parsed: { title: '重新生成的一页纸', markdown: ONEPAGE_MARKDOWN, outline: ['一、体系', '二、要点'] }, trace: { role: 'onepage' } }
    }
    throw new Error('未预期的角色：' + payload.role)
  }
  return { callModel, calls }
}

/** 一张合法的一页纸：够 400 字、不超上限、没有"长墙"段落（validateOnepage 的三条硬要求）。 */
const ONEPAGE_MARKDOWN = ['## 一、体系', '', ...Array.from({ length: 30 }, (_, index) => '- 要点 ' + (index + 1) + '：' + '内容'.repeat(5))].join('\n')

test('正文改一个字符之后，旧简报与旧一页纸都被拦下（中止发布）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '法律实证分析', lesson: '2026-09-23第1-2节', status: 'completed' }))
  const firstText = '# 2026-09-23第1-2节\n\n## 课程概览\n\n第一版正文。'
  const changedText = firstText.replace('第一版正文。', '第一版正文！')
  const notePath = path.join(notesDir, '2026-09-23第1-2节.md')
  fs.writeFileSync(notePath, firstText)
  const briefPath = path.join(notesDir, 'brief.json')
  const onepagePath = path.join(notesDir, 'onepage.json')
  // 简报与一页纸各自用自己那套指纹：简报是 briefSourceChecksum（会做换行规范化），
  // 一页纸是发布侧算的原始 SHA-256（generateOnepage 不返回指纹）
  const boundBrief = text => JSON.stringify({
    schemaVersion: 1, course: '法律实证分析', lesson: '2026-09-23第1-2节', replayKey: 'replay-1',
    sourceChecksum: briefSourceChecksum(text), sourceChars: text.length, generatedAt: '2026-09-25T00:00:00.000Z',
    briefing: '这一版正文的简报，说的是第一版里的事。', keyPoints: ['要点']
  })
  fs.writeFileSync(briefPath, boundBrief(firstText))
  fs.writeFileSync(onepagePath, JSON.stringify({
    schemaVersion: 1, course: '法律实证分析', lesson: '2026-09-23第1-2节', replayKey: 'replay-1',
    // 生成侧看到的是"末尾多一个换行"的那一份（运维脚本会写 record.markdown + '\n'）：
    // 指纹必须仍然算作同一段文字，不然这一条会被判 stale_source 白白中止
    sourceChecksum: markdownChecksum(firstText + '\n'), generatedAt: '2026-09-25T00:00:00.000Z',
    title: '第一版的一页纸', markdown: '第一版的一页纸内容', chars: 10
  }))

  const siteDir = path.join(dir, 'site')
  const { deps, lines: output, errors } = harness()
  const args = ['publish', '--from', notesDir, '--out', siteDir, '--replay-key', 'replay-1']
  const notePage = () => fs.readFileSync(path.join(siteDir, 'notes/法律实证分析/2026-09-23第1-2节.html'), 'utf8')

  // ① 对得上：正常采纳（CLI 生成的派生物走的就是这条路）
  assert.equal(await runCli(args, deps), 0, 'stderr: ' + errors.join(' | '))
  assert.deepEqual(parse(output.at(-1)).brief, { applied: true, reason: 'ok' })
  assert.deepEqual(parse(output.at(-1)).onepage, { applied: true, reason: 'ok' })
  assert.match(notePage(), /这一版正文的简报，说的是第一版里的事。/)

  // ② 正文改一个字符：直接中止发布——宁可这次不发，也不发一篇与正文不符的简报
  fs.writeFileSync(notePath, changedText)
  assert.equal(await runCli(args, deps), 1, '不同源时必须失败，而不是悄悄不挂')
  assert.match(errors.join('\n'), /简报与要发布的这一篇不同源，已中止发布/)
  assert.match(errors.join('\n'), /来源指纹与要发布的笔记正文不符/, '错误信息里要带上 problems')
  assert.match(errors.join('\n'), /--regenerate-derived/, '并给出怎么补')
  assert.match(notePage(), /这一版正文的简报，说的是第一版里的事。/,
    '中止得彻底：站点还是上一次发布的内容，没有被写坏')

  // 一页纸同样是硬拦：把简报换成对得上的，只留一页纸过期
  fs.writeFileSync(briefPath, boundBrief(changedText))
  assert.equal(await runCli(args, deps), 1)
  assert.match(errors.join('\n'), /一页纸摘要与要发布的这一篇不同源，已中止发布/)
  assert.match(errors.join('\n'), /来源指纹与要发布的笔记正文不符/)

  // ③ 老数据（没有绑定字段）：不拦，但要在 stderr 上说清这是历史数据
  fs.rmSync(onepagePath)
  fs.writeFileSync(briefPath, JSON.stringify({ schemaVersion: 1, course: '法律实证分析', lesson: '2026-09-23第1-2节', briefing: '老格式的简报' }))
  assert.equal(await runCli(args, deps), 0, 'stderr: ' + errors.join(' | '))
  assert.deepEqual(parse(output.at(-1)).brief, { applied: true, reason: 'unbound' })
  assert.match(errors.join('\n'), /简报未绑定来源（历史数据）/)
  assert.match(notePage(), /老格式的简报/)

  // ④ 重新绑定之后：又回到 ok
  fs.writeFileSync(notePath, firstText)
  fs.writeFileSync(briefPath, boundBrief(firstText))
  assert.equal(await runCli(args, deps), 0)
  assert.deepEqual(parse(output.at(-1)).brief, { applied: true, reason: 'ok' })
  assert.match(notePage(), /这一版正文的简报，说的是第一版里的事。/)
})

test('同一个 --from 目录里留着上一讲的 brief.json：发布这一讲直接中止（串课简报的真实故障）', async () => {
  // 现象：同课程第 2、3 讲的 summary 等于第 1 讲——brief.json 按目录存放，谁最后写谁生效。
  // 绑定字段就是为了在发布前当场认出「这份简报不是给这一讲的」。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '商法概论', lesson: '2026-09-20第2-4节', status: 'completed' }))
  const noteText = '# 2026-09-20第2-4节\n\n## 课程概览\n\n第二讲正文。'
  fs.writeFileSync(path.join(notesDir, '2026-09-20第2-4节.md'), noteText)
  const briefPath = path.join(notesDir, 'brief.json')
  fs.writeFileSync(briefPath, JSON.stringify({
    schemaVersion: 1,
    course: '商法概论',
    lesson: '2026-09-07第5-6节',
    sourceChecksum: briefSourceChecksum('# 2026-09-07第5-6节\n\n## 课程概览\n\n第一讲正文。'),
    generatedAt: '2026-09-08T00:00:00.000Z',
    briefing: '这是第一讲的简报，正被错误地挂到第二讲上。',
    keyPoints: ['第一讲要点']
  }))

  const siteDir = path.join(dir, 'site')
  const { deps, lines: output, errors } = harness()
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 1)
  assert.match(errors.join('\n'), /课次不符（简报是 2026-09-07第5-6节，要发布的是 2026-09-20第2-4节）/)
  assert.ok(!fs.existsSync(path.join(siteDir, 'library.json')), '中止得彻底：一个字都不写进发布库')

  // 补上这一讲自己的简报（course brief 的产物）之后发布成功，页面上的简报是这一讲的
  fs.writeFileSync(briefPath, JSON.stringify({
    schemaVersion: 1, course: '商法概论', lesson: '2026-09-20第2-4节',
    sourceChecksum: briefSourceChecksum(noteText), sourceChars: noteText.length,
    generatedAt: '2026-09-21T00:00:00.000Z',
    briefing: '第二讲自己的简报，讲的是第二讲的内容。', keyPoints: ['第二讲要点']
  }))
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 0, 'stderr: ' + errors.join(' | '))
  assert.deepEqual(parse(output.at(-1)).brief, { applied: true, reason: 'ok' })
  const page = fs.readFileSync(path.join(siteDir, 'notes/商法概论/2026-09-20第2-4节.html'), 'utf8')
  assert.match(page, /第二讲自己的简报，讲的是第二讲的内容。/)
  assert.ok(!page.includes('这是第一讲的简报'), '第一讲的简报绝不能出现在第二讲的页面上')
})

test('--regenerate-derived：按当前正文重做派生物、写回文件，下一次直接用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '法律实证分析', lesson: '2026-09-23第1-2节', status: 'completed' }))
  const noteText = '# 2026-09-23第1-2节\n\n## 课程概览\n\n第一版正文，随后又改过一次。'
  fs.writeFileSync(path.join(notesDir, '2026-09-23第1-2节.md'), noteText)
  const briefPath = path.join(notesDir, 'brief.json')
  const onepagePath = path.join(notesDir, 'onepage.json')
  fs.writeFileSync(briefPath, JSON.stringify({ schemaVersion: 1, course: '法律实证分析', lesson: '2026-09-23第1-2节', replayKey: 'replay-1', sourceChecksum: briefSourceChecksum('更早的正文'), briefing: '过期的简报' }))
  fs.writeFileSync(onepagePath, JSON.stringify({ schemaVersion: 1, course: '法律实证分析', lesson: '2026-09-23第1-2节', replayKey: 'replay-1', sourceChecksum: 'deadbeef', markdown: '过期的一页纸', title: '旧的' }))

  const siteDir = path.join(dir, 'site')
  const model = fakeDerivedModel()
  const { deps, lines: output, errors } = harness({ callModel: model.callModel })
  const args = ['publish', '--from', notesDir, '--out', siteDir, '--replay-key', 'replay-1', '--regenerate-derived']
  assert.equal(await runCli(args, deps), 0, 'stderr: ' + errors.join(' | '))
  const payload = parse(output.at(-1))
  assert.deepEqual(payload.brief, { applied: true, reason: 'regenerated' }, 'stderr: ' + errors.join(' | '))
  assert.deepEqual(payload.onepage, { applied: true, reason: 'regenerated' }, 'stderr: ' + errors.join(' | '))
  assert.deepEqual(model.calls.slice().sort(), ['brief', 'onepage'], '两份派生物各重新生成一次')

  // 重新生成的结果写回笔记目录：带上与当前正文一致的指纹，并注明是给哪一节生成的
  const rewrittenBrief = JSON.parse(fs.readFileSync(briefPath, 'utf8'))
  assert.equal(rewrittenBrief.sourceChecksum, briefSourceChecksum(noteText), '简报的指纹来自生成侧')
  assert.equal(rewrittenBrief.sourceChars, noteText.length)
  assert.equal(rewrittenBrief.replayKey, 'replay-1')
  assert.equal(rewrittenBrief.course, '法律实证分析')
  assert.equal(rewrittenBrief.lesson, '2026-09-23第1-2节')
  assert.match(rewrittenBrief.briefing, /重新生成后的简报/)
  assert.equal(JSON.parse(fs.readFileSync(onepagePath, 'utf8')).sourceChecksum, markdownChecksum(noteText), '一页纸的指纹由发布侧按同一个函数算')


  const page = fs.readFileSync(path.join(siteDir, 'notes/法律实证分析/2026-09-23第1-2节.html'), 'utf8')
  assert.match(page, /重新生成后的简报/, '重新生成的简报这一轮就挂上了')
  assert.ok(payload.written.includes('onepage/法律实证分析/2026-09-23第1-2节.html'), '重新生成的一页纸写成了页面')
  assert.ok(payload.written.includes('md/法律实证分析/2026-09-23第1-2节-一页纸.md'), '一页纸的 Markdown 也写出来了')

  // 下一次发布：文件已经对得上，直接用，不再花模型调用
  model.calls.length = 0
  assert.equal(await runCli(args.slice(0, -1), deps), 0)
  assert.deepEqual(parse(output.at(-1)).brief, { applied: true, reason: 'ok' })
  assert.deepEqual(model.calls, [], '对得上的派生物不再重新生成')

  // 本来就没有一页纸的课次：--regenerate-derived 不会凭空生成一份（不发多出来的模型调用）
  fs.rmSync(onepagePath)
  assert.equal(await runCli(args, deps), 0)
  const missing = parse(output.at(-1))
  assert.deepEqual(missing.onepage, { applied: false, reason: 'missing' })
  assert.deepEqual(model.calls, [], '不存在就是不存在，不自动生成')
})

test('老发布库（只有 publishedAt）在下次发布时整体迁移成三个时间字段', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const siteDir = path.join(dir, 'site')
  fs.mkdirSync(siteDir, { recursive: true })
  // 老库：只有 publishedAt，课次标题里带日期
  fs.writeFileSync(path.join(siteDir, 'library.json'), JSON.stringify([{
    slug: 'notes/商法概论/2026-09-07第5-6节',
    courseName: '商法概论',
    lessonTitle: '2026-09-07第5-6节',
    replayKey: 'old-1',
    publishedAt: '2026-09-10T00:00:00.000Z',
    checksum: 'old-checksum',
    markdown: '# 2026-09-07第5-6节\n\n## 课程概览\n\n老记录。'
  }], null, 2))

  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '商法概论', lesson: '2026-09-20第2-4节', status: 'completed' }))
  fs.writeFileSync(path.join(notesDir, '2026-09-20第2-4节.md'), '# 2026-09-20第2-4节\n\n## 课程概览\n\n新一课。')

  const { deps, errors } = harness()
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 0, 'stderr: ' + errors.join(' | '))
  const library = JSON.parse(fs.readFileSync(path.join(siteDir, 'library.json'), 'utf8'))
  assert.equal(library.length, 2)
  const legacy = library.find(item => item.replayKey === 'old-1')
  assert.equal(legacy.lessonDate, '2026-09-07', '课次日期从标题迁移出来')
  assert.equal(legacy.firstPublishedAt, '2026-09-10T00:00:00.000Z', 'publishedAt 就是它第一次进站的时间')
  assert.equal(legacy.updatedAt, '2026-09-10T00:00:00.000Z')
  assert.equal('publishedAt' in legacy, false)
  assert.equal(library.some(item => 'publishedAt' in item), false, '整库迁移，不留混合状态')
  assert.match(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), /<td class="lesson-date">2026-09-07<\/td>/,
    '老记录重建后首页日期列也是课次日期')
})

test('两节课共用同一个 replayKey 时，发布其中一节不得把另一节从发布库里删掉', async () => {
  // 真实数据里出现过：国际刑法学 2026-09-16 与 2026-09-23 的 replayKey 相同。
  // 按 replayKey 无条件替换旧记录，会在发布其中一节时把另一节一起抹掉——
  // 站点上凭空少一整节课，而且没有任何报错，只有翻发布库才发现。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const siteDir = path.join(dir, 'site')
  fs.mkdirSync(siteDir, { recursive: true })
  const shared = 'replay-shared'
  const legacy = (title, date, checksum) => ({
    slug: `notes/国际刑法学/${title}`,
    courseName: '国际刑法学',
    lessonTitle: title,
    replayKey: shared,
    lessonDate: date,
    firstPublishedAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
    checksum,
    markdown: `# ${title}\n\n## 课程概览\n\n正文。`
  })
  fs.writeFileSync(path.join(siteDir, 'library.json'), JSON.stringify([
    legacy('2026-09-16第10-12节', '2026-09-16', 'checksum-a'),
    legacy('2026-09-23第10-12节', '2026-09-23', 'checksum-b')
  ], null, 2))

  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({
    course: '国际刑法学', lesson: '2026-09-16第10-12节', replayKey: shared, status: 'completed'
  }))
  fs.writeFileSync(path.join(notesDir, '2026-09-16第10-12节.md'), ['# 2026-09-16第10-12节', '', '## 课程概览', '', '改过一遍的正文。'].join('\n'))

  const { deps, errors } = harness()
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 0, 'stderr: ' + errors.join(' | '))
  const library = JSON.parse(fs.readFileSync(path.join(siteDir, 'library.json'), 'utf8'))
  assert.equal(library.length, 2, '发布一节不能把共用 replayKey 的另一节删掉')
  assert.ok(library.some(item => item.lessonTitle === '2026-09-23第10-12节'), '另一节必须还在库里')
  assert.match(library.find(item => item.lessonTitle === '2026-09-16第10-12节').markdown, /改过一遍的正文/)
})

test('课次标题改了（slug 跟着变）时，旧记录按 replayKey 换掉，不留重复的一节', async () => {
  // 这是 replayKey 兜底的**唯一**用途：改名之后 slug 变了，按 slug 找不到旧记录，
  // 若不换掉它，站点上会同时出现改名前后两节。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const siteDir = path.join(dir, 'site')
  fs.mkdirSync(siteDir, { recursive: true })
  fs.writeFileSync(path.join(siteDir, 'library.json'), JSON.stringify([{
    slug: 'notes/国际刑法学/第10-12节',
    courseName: '国际刑法学',
    lessonTitle: '第10-12节',
    replayKey: 'replay-rename',
    lessonDate: '2026-09-16',
    firstPublishedAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    checksum: 'old',
    markdown: '# 第10-12节\n\n## 课程概览\n\n旧标题下的正文。'
  }], null, 2))

  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({
    course: '国际刑法学', lesson: '2026-09-16第10-12节', replayKey: 'replay-rename', status: 'completed'
  }))
  fs.writeFileSync(path.join(notesDir, '2026-09-16第10-12节.md'), ['# 2026-09-16第10-12节', '', '## 课程概览', '', '新标题下的正文。'].join('\n'))

  const { deps, errors } = harness()
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 0, 'stderr: ' + errors.join(' | '))
  const library = JSON.parse(fs.readFileSync(path.join(siteDir, 'library.json'), 'utf8'))
  assert.equal(library.length, 1, '改名不留下重复的一节')
  assert.equal(library[0].slug, 'notes/国际刑法学/2026-09-16第10-12节')
  assert.equal(library[0].firstPublishedAt, '2026-09-16T00:00:00.000Z', '改名不重置首次进站时间')
})

test('publish --rebuild rewrites the site from the library without touching the ledger', async () => {
  // 换模板、改样式之后要重生成 HTML，但这些跟笔记内容无关：不该为了它们再跑一遍模型，
  // 也不该因为"重新生成"而再推一次微信。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '刑法分论', lesson: '第10-12节', status: 'completed' }))
  fs.writeFileSync(path.join(notesDir, '第10-12节.md'), '# 第10-12节\n\n## 课程概览\n\n正文。')

  const siteDir = path.join(dir, 'site')
  const { deps, lines, ledger } = harness()
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'notes_ready' })
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--replay-key', 'replay-1', '--origin', 'https://course.law-tech.dev'], deps), 0)
  const page = path.join(siteDir, 'notes/刑法分论/第10-12节.html')
  assert.ok(fs.existsSync(page))

  // 假装模板变了：把生成好的页面删掉，--rebuild 应当把它重新写回来
  fs.rmSync(page)
  fs.rmSync(path.join(siteDir, 'search/index.html'))
  assert.equal(await runCli(['publish', '--rebuild', '--out', siteDir, '--origin', 'https://course.law-tech.dev'], deps), 0)
  const rebuilt = parse(lines.at(-1))
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.notes, 1)
  assert.ok(rebuilt.pages >= 8, '索引页、搜索页、feed 都要一起重写')
  assert.ok(fs.existsSync(page), '笔记页要重新生成')
  assert.ok(fs.existsSync(path.join(siteDir, 'search/index.html')))
  assert.equal(ledger.countDeliveries().pending, 1, '重建不该再排一条通知（内容没变）')
  assert.equal(ledger.getTask('replay-1').stage, 'published', '重建不碰账本阶段')
})

test('publish --no-notify updates the site without queueing another push', async () => {
  // 换排版之后要批量重发：内容确实变了，但每篇都推一条对读者是骚扰。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const notesDir = path.join(dir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '刑法分论', lesson: '第10-12节', status: 'completed' }))
  fs.writeFileSync(path.join(notesDir, '第10-12节.md'), '# 第10-12节\n\n## 课程概览\n\n正文。')
  const siteDir = path.join(dir, 'site')
  const { deps, lines } = harness()
  assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 0)
  const payload = parse(lines.at(-1))
  assert.equal(payload.changed, true)
  assert.equal(payload.delivery, null, '--no-notify 不该排队')
  assert.ok(fs.existsSync(path.join(siteDir, 'notes/刑法分论/第10-12节.html')), '站点照样要更新')
})

test('重新发布一节旧课：课次日期与首次进站时间不变、updatedAt 变新，首页顺序不动', async () => {
  // 用户报的正是这件事：旧课改个错字重新发布，它就变成"最新一课"。
  // 现在排序只看 lessonDate，发布时间另有两个字段各管一件事。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const siteDir = path.join(dir, 'site')
  let clock = new Date('2026-09-25T00:30:00Z')
  const { deps, lines: output } = harness({ now: () => clock })
  const publishLesson = async (lesson, markdown) => {
    const notesDir = fs.mkdtempSync(path.join(dir, 'notes-'))
    fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '商法概论', lesson, status: 'completed' }))
    fs.writeFileSync(path.join(notesDir, lesson + '.md'), markdown)
    assert.equal(await runCli(['publish', '--from', notesDir, '--out', siteDir, '--no-notify'], deps), 0)
    return parse(output.at(-1))
  }

  const earlier = await publishLesson('2026-09-07第5-6节', '# 2026-09-07第5-6节\n\n## 课程概览\n\n第一版。')
  clock = new Date('2026-09-26T00:30:00Z')
  await publishLesson('2026-09-20第2-4节', '# 2026-09-20第2-4节\n\n## 课程概览\n\n第二版。')
  clock = new Date('2026-10-01T00:30:00Z')
  const again = await publishLesson('2026-09-07第5-6节', '# 2026-09-07第5-6节\n\n## 课程概览\n\n改了个错字。')

  assert.equal(earlier.lessonDate, '2026-09-07')
  assert.equal(earlier.lessonDateSource, 'title', '课次标题里的日期就是这一节的日期')
  assert.equal(again.changed, true, '正文变了')
  assert.equal(again.lessonDate, '2026-09-07', '重新发布不改课次日期')
  assert.equal(again.firstPublishedAt, earlier.firstPublishedAt, '首次进站时间保持不变')
  assert.equal(again.firstPublishedAt, '2026-09-25T00:30:00.000Z')
  assert.equal(again.updatedAt, '2026-10-01T00:30:00.000Z', '最近一次重新发布的时间')

  const home = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8')
  assert.ok(home.indexOf('2026-09-20第2-4节') < home.indexOf('2026-09-07第5-6节'),
    '最新一课仍是 09-20 那节，重新发布的那节不会窜上去')
  assert.match(home, /<td class="lesson-date">2026-09-07<\/td>/, '首页日期列也是课次日期')

  const library = JSON.parse(fs.readFileSync(path.join(siteDir, 'library.json'), 'utf8'))
  assert.equal(library.length, 2, '同一节重新发布不该在发布库里留下两条')
  const stored = library.find(item => item.lessonTitle === '2026-09-07第5-6节')
  assert.equal(stored.firstPublishedAt, '2026-09-25T00:30:00.000Z')
  assert.equal(stored.updatedAt, '2026-10-01T00:30:00.000Z')
  assert.equal(stored.lessonDate, '2026-09-07')
  assert.equal('publishedAt' in stored, false, 'publishedAt 已经拆成三个字段')
  // 发布库是原子替换的：临时文件不残留，目录里只有一份 library.json
  assert.deepEqual(fs.readdirSync(siteDir).filter(name => name.startsWith('library.json')), ['library.json'])
})

test('课次日期：--lesson-date 优先，账本排课时间兜底，取不到时如实标注来源', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  // 笔记文件名与 publish 的 safeFileName 同规则：空格换成短横
  const writeNotes = (lesson, markdown) => {
    const notesDir = fs.mkdtempSync(path.join(dir, 'notes-'))
    fs.writeFileSync(path.join(notesDir, 'notes-run-summary.json'), JSON.stringify({ course: '商法概论', lesson, status: 'completed' }))
    fs.writeFileSync(path.join(notesDir, lesson.replace(/\s+/g, '-') + '.md'), markdown)
    return notesDir
  }

  // ① 老式标题（第10-12节）里没有日期：用账本里 discover 记下的排课时间
  const withLedger = harness()
  withLedger.ledger.discoverReplays([{
    replay_key: 'replay-1', course_key: 'course-abc', title: '第10-12节 共犯与罪数', starts_at_text: '2026-05-27 13:00'
  }])
  const fromLedger = writeNotes('第10-12节 共犯与罪数', '# 第10-12节 共犯与罪数\n\n## 课程概览\n\n正文。')
  assert.equal(await runCli(['publish', '--from', fromLedger, '--out', path.join(dir, 'site-a'), '--replay-key', 'replay-1', '--no-notify'], withLedger.deps), 0, 'stderr: ' + withLedger.errors.join(' | '))
  const ledgerPayload = parse(withLedger.lines.at(-1))
  assert.equal(ledgerPayload.lessonDate, '2026-05-27')
  assert.equal(ledgerPayload.lessonDateSource, 'ledger')

  // ② 显式 --lesson-date 压过标题里的日期
  const explicitHarness = harness()
  const withTitle = writeNotes('2026-09-20第2-4节', '# 2026-09-20第2-4节\n\n## 课程概览\n\n正文。')
  assert.equal(await runCli(['publish', '--from', withTitle, '--out', path.join(dir, 'site-b'), '--lesson-date', '2026-09-19', '--no-notify'], explicitHarness.deps), 0)
  const explicitPayload = parse(explicitHarness.lines.at(-1))
  assert.equal(explicitPayload.lessonDate, '2026-09-19')
  assert.equal(explicitPayload.lessonDateSource, 'explicit')

  // ③ 什么线索都没有：退回首次发布的日期，并且**在输出里标注这是猜的**
  const bare = harness()
  const noClue = writeNotes('补课', '# 补课\n\n## 课程概览\n\n正文。')
  assert.equal(await runCli(['publish', '--from', noClue, '--out', path.join(dir, 'site-c'), '--no-notify'], bare.deps), 0)
  const barePayload = parse(bare.lines.at(-1))
  assert.equal(barePayload.lessonDate, '2026-09-25', '退回首次发布那一天（harness 的固定时钟）')
  assert.equal(barePayload.lessonDateSource, 'published')
  assert.match(bare.errors.join('\n'), /取不到上课日期/, '要让运维看得出这个日期是兜底的')
  assert.match(bare.errors.join('\n'), /--lesson-date/)
})

test('the daily digest lists what changed yesterday and stays silent when nothing did', async () => {
  const { collectDigest, digestSubject, renderDigestHtml, renderDigestText, sendResendEmail } = await import('./digest.mjs')
  const index = { notes: [
    // 昨天第一次进站的一节
    { courseName: '商法概论', lessonTitle: '2026-09-20第2-4节', slug: 'notes/商法概论/2026-09-20第2-4节', markdown: 'x'.repeat(18000), readMinutes: 45,
      lessonDate: '2026-09-20', firstPublishedAt: '2026-09-25T23:43:00.000Z', updatedAt: '2026-09-25T23:43:00.000Z',
      brief: { briefing: '本讲从为什么要有企业推进到为什么要有公司。', keyPoints: ['交易成本', '有限责任', '刺破面纱'] } },
    // 上周就发布过的旧课，昨天只是又没动过：不进日报
    { courseName: '刑事执行法', lessonTitle: '旧课', slug: 'notes/x', markdown: 'x',
      lessonDate: '2026-09-14', firstPublishedAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' },
    // 旧课改错字重新发布：日报问的是"昨天更新了什么"，所以它照样要出现
    { courseName: '国际法学', lessonTitle: '第一课 国家责任的构成', slug: 'notes/国际法学/第一课-国家责任的构成', markdown: 'x',
      lessonDate: '2026-09-08', firstPublishedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-25T20:00:00.000Z' }
  ] }
  const tasks = [
    { courseName: '普通法专题', title: '2026-09-24第7-9节', stage: 'discovered', updatedAt: '2026-09-25T23:31:00.000Z' },
    { courseName: '刑事执行法', title: '2026-09-14第5-6节', stage: 'published', updatedAt: '2026-09-25T11:35:00.000Z' },
    { courseName: '国际刑法学', title: '2026-09-23第10-12节', stage: 'needs_attention', attempts: 5, lastError: '模型连续返回空结果', updatedAt: '2026-09-26T01:00:00.000Z' }
  ]
  // 北京时间 2026-09-26 的「昨天」= 09-25（UTC 的 09-25 16:00 之后也算 09-26，按东八区算）
  const report = collectDigest({ date: '2026-09-26', index, tasks, timeZone: 'Asia/Shanghai' })
  assert.equal(report.published.length, 2,
    '昨天更新过的都算：09-25T23:43Z 首次进站的那节 + 09-25T20:00Z 重新发布的那节（旧课首发在 09-09，不算）')
  assert.deepEqual(report.published.map(note => note.lessonTitle).sort(), ['2026-09-20第2-4节', '第一课 国家责任的构成'])
  assert.equal(report.hasNews, true)
  assert.match(digestSubject(report), /2 篇新笔记/)
  assert.equal(report.problems.length, 1)
  assert.equal(report.waiting, 1)

  const html = renderDigestHtml(report)
  assert.match(html, /<table/, '邮件正文用表格，不写长段摘要')
  assert.match(html, /商法概论/)
  assert.match(html, /交易成本/, '三条要点要列出来')
  assert.ok(!/本讲从为什么要有企业推进到为什么要有公司。.*本讲从为什么要有企业推进到为什么要有公司。/s.test(html))
  const text = renderDigestText(report)
  assert.match(text, /课程笔记日报 · 2026-09-26/)

  const quiet = collectDigest({ date: '2026-09-01', index, tasks, timeZone: 'Asia/Shanghai' })
  assert.equal(quiet.hasNews, false)
  assert.match(digestSubject(quiet), /无更新/)

  // 发信：不真的联网，只核对请求体
  const calls = []
  const fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, text: async () => '{"id":"abc"}' } }
  const sent = await sendResendEmail({ apiKey: 're_test', from: 'course@law-tech.dev', to: 'me@example.com', subject: 'x', html: '<p>x</p>', text: 'x', fetchImpl: fakeFetch })
  assert.equal(sent.id, 'abc')
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.match(calls[0].options.headers.authorization, /Bearer re_test/)
  assert.match(calls[0].options.body, /course@law-tech\.dev/)
  await assert.rejects(() => sendResendEmail({ from: 'a@b.c', to: 'x@y.z', subject: 's' }), /RESEND_API_KEY/)
  await assert.rejects(() => sendResendEmail({ apiKey: 'k', from: '', to: 'x@y.z', subject: 's' }), /发件人/)
  await assert.rejects(() => sendResendEmail({ apiKey: 'k', from: 'a@b.c', to: '', subject: 's' }), /收件人/)
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
  // 这一节有课件：默认规则（--require-materials 1）下，没课件的课次整轮不跑。
  // 课次要写 discover 之后的标题（cycle 会先扫描一遍，用教学网上的标题刷新账本），
  // 归档是按课次标题找的——写错标题就等于"没传课件"。
  writeDeckFixture(scratch, { lesson: '2026-05-27第10-12节' })

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
  // 自动链路里课次日期来自标题（discover 刷新过的那一个），首页日期列与排序都用它
  const home = fs.readFileSync(path.join(scratch, 'site', 'index.html'), 'utf8')
  assert.match(home, /<td class="lesson-date">2026-05-27<\/td>/)
  const library = JSON.parse(fs.readFileSync(path.join(scratch, 'site', 'library.json'), 'utf8'))
  assert.equal(library[0].lessonDate, '2026-05-27')
  assert.equal(library[0].lessonDateSource, 'title')
  assert.equal(library[0].firstPublishedAt, library[0].updatedAt, '首次发布时两个时间相同')
})

test('cycle reports a missing prerequisite instead of crashing', async () => {
  // 注入一个可用发送器，避免把「未配置微信」的错误混进这条断言
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({ sender: okSender })
  // 阶段是 transcript_ready，但没有 transcriptPath 产物（课件齐备，走的才是"缺前置产物"这条路）
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  writeDeckFixture(scratch, { lesson: '2026-05-27第10-12节' })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '2026-05-27第10-12节' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'transcript_ready' })

  const code = await runCli(['cycle', '--max-tasks', '2'], { ...deps, env: { ...deps.env, COURSE_WORKER_SCRATCH_DIR: scratch } })
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

test('verify 不加 --yes 只做前置检查：绝不下载、不转写、不发推送', async () => {
  // 真实教训：排查问题时顺手敲了一下 verify，它真跑了一整轮——下载 1.3G、开始转写
  // （按小时计费），跑下去还会写笔记并可能给读者推一条。这个闸门就是为此加的。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const env = {
    PKU_USERNAME: 'u', PKU_PASSWORD: 'p',
    DASHSCOPE_API_KEY: 'k', R2_ENDPOINT: 'https://r2.example.com',
    COURSE_AI_API_KEY: 'sk-test'
  }
  const { deps, lines } = harness()
  const code = await runCli(['verify', '--out', path.join(dir, 'site')], { ...deps, env })
  assert.equal(code, 0)
  const payload = parse(lines.at(-1))
  assert.equal(payload.ready, true)
  assert.equal(payload.dryRun, true, '默认只报告条件是否齐备')
  assert.match(payload.willRun, /转写|模型调用|推送/, '要说清真跑会花什么')
  assert.match(payload.hint, /--yes/)
  assert.ok(Array.isArray(payload.criteria) && payload.criteria.length > 0)
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

  // 预备一节课：媒体已下载，等转录；课件也已上传（否则默认规则会让 cycle 跳过它）
  const mediaPath = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'fake media')
  writeDeckFixture(dir, { lesson: '2026-05-27第10-12节' })
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '第10-12节' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'downloaded', data: { artifacts: { mediaPath } } })

  const code = await runCli(['verify', '--yes', '--out', path.join(dir, 'site'), '--max-tasks', '8'], { ...deps, env })
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

test('没有课件就不自动跑：跳过、留一行日志、账本一点都不动', async () => {
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, errors, lines, ledger } = harness({ sender: okSender })
  // 账本里有这节课，但课件归档里一份都没有（默认规则下就该整轮不处理）
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc' }])
  const before = ledger.getTask('replay-1')

  const code = await runCli(['cycle', '--max-tasks', '3'], deps)
  const summary = parse(lines.at(-1))

  assert.equal(summary.materials.required, true, '默认 --require-materials 1')
  assert.deepEqual(summary.materials.skipped.map(item => item.replayKey), ['replay-1'])
  assert.equal(summary.tasks.length, 1)
  assert.equal(summary.tasks[0].action, 'skip')
  assert.equal(summary.tasks[0].note, '没有课件，本轮不跑（不推进阶段）')
  assert.match(errors.join('\n'), /没有课件，本轮不跑/, 'stderr 要留下一行可见痕迹')
  assert.match(errors.join('\n'), /立即跑这一节/, '要告诉用户怎么强制跑')

  const after = ledger.getTask('replay-1')
  assert.equal(after.stage, before.stage, '阶段不得推进（只是本轮不处理）')
  assert.equal(after.attempts, 0, '也不得消耗重试次数——否则几轮之后它会被误判成"停下等你"')
  assert.equal(after.lease_expires_at, before.lease_expires_at, '不该领取（否则会占住一小时租约）')
  assert.equal(code, 0, '缺课件跳过是策略，不是失败')
})

test('--require-materials 0：无课件也照跑，结果里写明是显式放开的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({
    sender: okSender,
    runPython: async payload => {
      const outputDir = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'raw-transcript.md'), '[00:00:01 – 00:00:05] 第一句')
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 1 }))
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const env = { ...deps.env, COURSE_WORKER_SCRATCH_DIR: dir }
  const mediaPath = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'fake media')
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '2026-05-27第10-12节' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'downloaded', data: { artifacts: { mediaPath } } })

  const code = await runCli(['cycle', '--max-tasks', '1', '--require-materials', '0'], { ...deps, env })
  const summary = parse(lines.at(-1))

  assert.equal(summary.materials.required, false)
  assert.deepEqual(summary.materials.skipped, [])
  const transcribe = summary.tasks.find(item => item.action === 'transcribe')
  assert.ok(transcribe, '关掉开关后应当照跑：' + JSON.stringify(summary.tasks))
  assert.equal(transcribe.ok, true)
  assert.equal(transcribe.materialCount, 0)
  assert.equal(transcribe.note, '无课件也照跑（--require-materials 0）', '结果里要看得出来是"无课件也照跑"')
  assert.equal(ledger.getTask('replay-1').stage, 'transcript_ready', '真的往前走了')
  assert.equal(code, 0)
})

test('指定 --replay-key 的单节课不受"缺课件"限制（显式点名就是"我现在就要跑"）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, lines, ledger } = harness({
    sender: okSender,
    runPython: async payload => {
      const outputDir = payload.args[payload.args.indexOf('--output-dir') + 1]
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'raw-transcript.md'), '[00:00:01 – 00:00:05] 第一句')
      fs.writeFileSync(path.join(outputDir, 'run-summary.json'), JSON.stringify({ chunkCount: 1, sentenceCount: 1 }))
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const env = { ...deps.env, COURSE_WORKER_SCRATCH_DIR: dir }
  const mediaPath = path.join(dir, 'replays', 'replay-1', 'output', 'media.mp4')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'fake media')
  ledger.discoverReplays([{ replay_key: 'replay-1', course_key: 'course-abc', course_name: '刑法分论', title: '2026-05-27第10-12节' }])
  ledger.reportStage({ id: ledger.getTask('replay-1').id, stage: 'downloaded', data: { artifacts: { mediaPath } } })

  // 默认的 --require-materials 还是 1，但显式点名这一节时不再拦
  const code = await runCli(['cycle', '--replay-key', 'replay-1', '--max-tasks', '1'], { ...deps, env })
  const summary = parse(lines.at(-1))

  assert.equal(summary.materials.required, true, '开关本身还是默认值')
  const transcribe = summary.tasks.find(item => item.action === 'transcribe')
  assert.ok(transcribe, '显式点名必须照跑：' + JSON.stringify(summary.tasks))
  assert.equal(transcribe.note, '无课件也照跑（显式指定这一节）')
  assert.equal(ledger.getTask('replay-1').stage, 'transcript_ready')
  assert.equal(code, 0)
})

test('微信会话过期时如实记录"不能自动激活"，不假装试过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-state-'))
  const accounts = path.join(stateDir, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  const tokens = path.join(accounts, 'bot.context-tokens.json')
  fs.writeFileSync(tokens, JSON.stringify({ 'user@im.wechat': 'token' }))
  // 固定时钟 + 23 小时前的互动记录：超过 12 小时的阈值就是"已过期"
  const fixed = new Date('2026-09-25T00:30:00Z')
  fs.utimesSync(tokens, new Date(fixed.getTime() - 23 * 3600 * 1000), new Date(fixed.getTime() - 23 * 3600 * 1000))

  const okSender = { target: 'wxid', probe: async () => ({ ok: true }), send: async () => ({ externalId: 'x' }) }
  const { deps, errors, lines } = harness({ sender: okSender, now: () => fixed })
  const env = {
    ...deps.env,
    COURSE_WORKER_SCRATCH_DIR: dir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_HOME: stateDir
  }

  const code = await runCli(['cycle', '--max-tasks', '1'], { ...deps, env })
  const summary = parse(lines.at(-1))

  assert.equal(summary.wechat.expired, true)
  assert.equal(summary.wechat.needed, true)
  assert.equal(summary.wechat.attempted, false, '没有可用的非交互式入口，就不要假装试过')
  assert.equal(summary.wechat.ok, false)
  assert.match(summary.wechat.session.summary, /已过期（超过 12 小时）：最近互动 23 小时前/)
  assert.match(errors.join('\n'), /微信会话不可用/)
  assert.match(errors.join('\n'), /给微信机器人发一条消息/)
  assert.equal(code, 0)
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
