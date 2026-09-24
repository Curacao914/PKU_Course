import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createValidatedAcquisitionRuntime } from '@course/acquisition'
import { callCourseModel, createInitialLesson, runLessonNotes } from '@course/notes'
import { buildNoteRecord, readSiteIndex, writeSite } from '@course/publish'

/** 文件名安全化：课程名与课次里常有斜杠与冒号。 */
function safeFileName(value) {
  return String(value || 'note')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'note'
}

import { requireOption } from './args.mjs'
import { describeConfig, pythonEnvironment } from './config.mjs'

/**
 * 每个命令都接收同一个上下文，所有外部世界（浏览器、子进程、文件系统）都从
 * 上下文进入，因此命令本身可以在没有 Chrome、没有网络、没有凭据的情况下测试。
 */
export function createCommands(context) {
  const { config, acquire, runPython, which, openStore, callModel: injectedCallModel, stdout, stderr } = context

  function withLedger(work) {
    const store = openStore(config.ledgerPath)
    try {
      return work(store)
    } finally {
      store.close()
    }
  }

  function defaultWorkerId() {
    return `cli:${os.hostname()}:${process.pid}`
  }

  /** 失败后延迟重试的间隔：与旧系统一致，避免坏任务被反复消费。 */
  const RETRY_DELAY_MS = 5 * 60 * 1000

  /**
   * 在账本里领取一条任务。
   *
   * 账本里没有这条回放时不报错——手动跑单节课仍然可用，只是不记录阶段，
   * 并且会在 stderr 明确说明，避免让人误以为进度已被记账。
   */
  function claimForRun(store, replayKey, workerId) {
    const existing = store.getTask(replayKey)
    if (!existing) {
      stderr(`账本中没有 ${replayKey}：本次按独立运行处理，不记录阶段。先跑 course discover 可登记回放。`)
      return null
    }
    const claim = store.claimTask({ replayKey, workerId })
    if (!claim.claimed) {
      throw new Error(`无法领取 ${replayKey}：${claim.reason}（当前阶段 ${claim.task?.stage}）`)
    }
    return claim.task
  }

  function emit(payload, options) {
    const text = JSON.stringify(payload, null, 2)
    if (options.flags.has('json')) {
      stdout(text)
      return
    }
    stdout(text)
  }

  async function doctor(options = { flags: new Set() }) {
    const summary = describeConfig(config)
    const binaries = {}
    for (const [name, command] of [
      ['ffmpeg', config.ffmpeg],
      ['ffprobe', config.ffprobe],
      ['python', config.python]
    ]) {
      const found = await which(command)
      binaries[name] = found || 'missing'
    }
    const chrome = config.chromePath || (await which('google-chrome')) || (await which('chromium')) || 'missing'
    const report = {
      config: summary,
      binaries: { ...binaries, chrome },
      ready: {
        pkuCredentials: summary.credentials.PKU_USERNAME === 'set' && summary.credentials.PKU_PASSWORD === 'set',
        asrCredentials:
          summary.credentials.DASHSCOPE_API_KEY === 'set' &&
          summary.credentials.R2_ACCESS_KEY_ID === 'set' &&
          summary.credentials.R2_SECRET_ACCESS_KEY === 'set' &&
          Boolean(config.sources.R2_ENDPOINT) &&
          Boolean(config.sources.R2_BUCKET),
        ffmpeg: binaries.ffmpeg !== 'missing',
        python: binaries.python !== 'missing',
        chrome: chrome !== 'missing'
      }
    }
    emit(report, options)
    return report.ready.ffmpeg && report.ready.python ? 0 : 1
  }

  async function discover(options) {
    const runtime = await acquire({ log: message => stderr(String(message)) })
    const result = await runtime.discover({
      courseName: options.options.course || '',
      courseKey: options.options['course-key'] || ''
    })
    const flattened = result.courses.flatMap(course =>
      course.recordings.map(recording => ({
        courseKey: course.courseKey,
        courseName: course.courseName,
        teacher: recording.teacher,
        startsAtText: recording.startsAtText,
        title: recording.title,
        replayKey: recording.replayKey
      }))
    )
    const recorded = withLedger(store => store.discoverReplays(flattened))
    if (options.options.out) {
      fs.mkdirSync(path.dirname(path.resolve(options.options.out)), { recursive: true })
      fs.writeFileSync(path.resolve(options.options.out), `${JSON.stringify({ ...result, flattened }, null, 2)}\n`)
    }
    emit({
      loginMode: result.loginMode,
      courses: result.courses.length,
      replays: flattened.length,
      recorded,
      recordings: flattened
    }, options)
    return flattened.length > 0 ? 0 : 1
  }

  /**
   * 从转录稿生成单课笔记。
   *
   * 输入是转录稿文本文件（transcribe 命令的产物），输出是拼装好的 Markdown
   * 与一份运行摘要。带 --replay-key 且账本中有该回放时，成功后推进到 notes_ready。
   */
  async function notes(options) {
    const transcriptPath = path.resolve(requireOption(options.options, 'transcript', 'notes'))
    if (!fs.existsSync(transcriptPath)) throw new Error(`找不到转录稿：${transcriptPath}`)
    const course = requireOption(options.options, 'course', 'notes')
    const lessonTitle = requireOption(options.options, 'lesson', 'notes')
    const transcript = fs.readFileSync(transcriptPath, 'utf8')

    const replayKey = options.options['replay-key'] || ''
    const workerId = options.options['worker-id'] || defaultWorkerId()
    const autoApproveOutline = options.options['auto-approve-outline'] !== '0'
    const outputDir = path.resolve(options.options['output-dir'] || path.dirname(transcriptPath))
    fs.mkdirSync(outputDir, { recursive: true })

    const lesson = createInitialLesson({
      key: replayKey || `lesson-${Date.now()}`,
      title: lessonTitle,
      transcript,
      blueprint: { mainLine: '' }
    })
    const courseSpec = {
      courseName: course,
      teacher: options.options.teacher || '',
      promptVersion: options.options['prompt-version'] || undefined
    }

    const store = openStore(config.ledgerPath)
    try {
      const task = replayKey ? claimForRun(store, replayKey, workerId) : null
      const previousStage = task?.stage || 'transcript_ready'
      const modelConfig = {
        apiKey: config.ai.apiKey || 'unset',
        baseUrl: config.ai.baseUrl,
        provider: config.ai.provider,
        source: 'environment',
        models: config.ai.models,
        deadlineAt: Number(options.options['deadline-ms'] || 0) > 0
          ? Date.now() + Number(options.options['deadline-ms'])
          : undefined
      }
      const callModel = injectedCallModel ||
        (payload => callCourseModel({ ...payload, config: { ...modelConfig, ...(payload.config || {}) } }))

      const result = await runLessonNotes({
        lesson,
        courseSpec,
        modelConfig,
        callModel,
        autoApproveOutline,
        maxSteps: Number(options.options['max-steps'] || 40),
        onEvent: step => stderr(`  [${step.index + 1}] ${step.taskType} → ${step.action || '-'} (${step.note})`)
      })

      const produced = result.lesson.status === 'completed' && Boolean(result.lesson.finalNote?.markdown)
      const notePath = path.join(outputDir, `${safeFileName(lessonTitle)}.md`)
      const summaryPath = path.join(outputDir, 'notes-run-summary.json')
      if (produced) fs.writeFileSync(notePath, `${result.lesson.finalNote.markdown}\n`)

      const summary = {
        course,
        lesson: lessonTitle,
        status: result.lesson.status,
        stopReason: result.stopReason,
        idleReason: result.idleDetail?.reason || null,
        nodeCount: result.lesson.nodes.length,
        finalChars: result.lesson.finalNote?.markdown?.length || 0,
        steps: result.steps,
        autoApproveOutline
      }
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

      if (task) {
        if (produced) {
          store.reportStage({
            id: task.id,
            stage: 'notes_ready',
            message: '笔记撰写完成',
            data: {
              artifacts: { notePath, summaryPath, noteChars: summary.finalChars },
              runtime: { nodeCount: summary.nodeCount, stepCount: result.steps.length }
            }
          })
        } else {
          store.reportStage({
            id: task.id,
            stage: previousStage,
            message: '笔记撰写未完成',
            error: `流水线停在 ${result.stopReason}${result.idleDetail?.reason ? `：${result.idleDetail.reason}` : ''}`,
            nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString()
          })
        }
      }

      emit({
        course,
        lesson: lessonTitle,
        produced,
        status: result.lesson.status,
        stopReason: result.stopReason,
        notePath: produced ? notePath : null,
        summaryPath,
        nodeCount: summary.nodeCount,
        finalChars: summary.finalChars,
        task: task ? { id: task.id, from: previousStage, to: produced ? 'notes_ready' : previousStage } : null
      }, options)
      return produced ? 0 : 1
    } finally {
      store.close()
    }
  }

  /**
   * 把已完成的笔记发布到站点。
   *
   * 站点是全量重写的：笔记以百计，全量写比为每篇记忆"已发布/已删除"简单得多，
   * 也不会出现删掉的笔记还挂在索引里的状态漂移。发布库本身是一份 JSON，
   * 因此重新生成站点不需要重新跑模型。
   */
  async function publish(options) {
    const from = path.resolve(requireOption(options.options, 'from', 'publish'))
    const summaryPath = path.join(from, 'notes-run-summary.json')
    if (!fs.existsSync(summaryPath)) {
      throw new Error(`找不到 ${summaryPath}；--from 应指向 course notes 的输出目录`)
    }
    const runSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    const course = options.options.course || runSummary.course
    const lessonTitle = options.options.lesson || runSummary.lesson
    const teacher = options.options.teacher || runSummary.teacher || ''
    const notePath = path.join(from, `${safeFileName(lessonTitle)}.md`)
    if (!fs.existsSync(notePath)) throw new Error(`找不到笔记正文：${notePath}`)
    const markdown = fs.readFileSync(notePath, 'utf8')

    const siteRoot = path.resolve(options.options.out || path.join(config.scratchRoot, 'site'))
    const libraryPath = path.join(siteRoot, 'library.json')
    const library = fs.existsSync(libraryPath) ? JSON.parse(fs.readFileSync(libraryPath, 'utf8')) : []
    const record = buildNoteRecord({
      courseName: course,
      teacher,
      lessonTitle,
      markdown,
      replayKey: runSummary.replayKey || options.options['replay-key'] || '',
      publishedAt: options.options['published-at'] || new Date().toISOString()
    })
    const checksum = createHash('sha256').update(record.markdown).digest('hex')
    const previous = library.find(item => item.slug === record.slug)
    const changed = !previous || previous.checksum !== checksum

    const nextLibrary = [...library.filter(item => item.slug !== record.slug), { ...record, checksum }]
    fs.mkdirSync(siteRoot, { recursive: true })
    fs.writeFileSync(libraryPath, `${JSON.stringify(nextLibrary, null, 2)}\n`)

    const site = writeSite({
      records: nextLibrary,
      outputDir: siteRoot,
      siteOrigin: options.options.origin || 'https://course.law-tech.dev'
    })
    const index = readSiteIndex(siteRoot)

    // 同一条笔记只通知一次；内容变化时才重新通知
    let delivery = null
    const replayKey = record.replayKey || options.options['replay-key'] || ''
    const store = openStore(config.ledgerPath)
    try {
      const task = replayKey ? store.getTask(replayKey) : null
      if (changed) {
        delivery = store.enqueueDelivery({
          dedupeKey: `course-note:${record.slug}`,
          purpose: 'course-note',
          bodyText: `${record.courseName} · ${record.lessonTitle}\n${record.summary}`,
          objectUrl: `${options.options.origin || 'https://course.law-tech.dev'}/${record.slug}.html`
        })
      }
      if (task && task.stage !== 'published' && task.stage !== 'completed') {
        store.reportStage({
          id: task.id,
          stage: 'published',
          message: '已发布到站点',
          data: { artifacts: { slug: record.slug, siteDir: site.outputDir } }
        })
      }
      emit({
        slug: record.slug,
        url: `${options.options.origin || 'https://course.law-tech.dev'}/${record.slug}.html`,
        changed,
        notes: index.count,
        siteDir: site.outputDir,
        written: site.written,
        delivery: delivery ? { inserted: delivery.inserted, dedupeKey: `course-note:${record.slug}` } : null,
        task: task ? { id: task.id, to: task.stage === 'published' || task.stage === 'completed' ? task.stage : 'published' } : null
      }, options)
      return 0
    } finally {
      store.close()
    }
  }

  async function status(options) {
    const snapshot = withLedger(store => ({
      path: store.path,
      stages: store.countTasks(),
      tasks: store.listTasks({ stage: options.options.stage || null, limit: Number(options.options.limit || 20) })
    }))
    emit(snapshot, options)
    return 0
  }

  async function download(options) {
    const replayKey = requireOption(options.options, 'replay-key', 'download')
    const courseKey = requireOption(options.options, 'course-key', 'download')
    const workerId = options.options['worker-id'] || defaultWorkerId()
    const store = openStore(config.ledgerPath)
    try {
      const task = claimForRun(store, replayKey, workerId)
      const previousStage = task?.stage || 'discovered'
      let result
      try {
        const runtime = await acquire({ log: message => stderr(String(message)) })
        result = await runtime.download(
          {
            replay_key: replayKey,
            course_key: courseKey,
            course_name: options.options.course || '',
            title: options.options.title || ''
          },
          { log: message => stderr(String(message)) }
        )
      } catch (error) {
        if (task) {
          store.reportStage({
            id: task.id,
            stage: previousStage,
            message: '下载失败',
            error: error instanceof Error ? error.message : String(error),
            nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString()
          })
        }
        throw error
      }

      const mediaPath = path.join(config.mediaRoot, replayKey, 'output', 'media.mp4')
      const present = fs.existsSync(mediaPath)
      if (task && present) {
        store.reportStage({
          id: task.id,
          stage: 'downloaded',
          message: '媒体就绪',
          data: {
            artifacts: { mediaPath, mediaChecksum: result?.artifacts?.mediaChecksum || '' },
            runtime: result?.runtime || {}
          }
        })
      }
      emit({
        replayKey,
        mediaPath,
        present,
        task: task ? { id: task.id, from: previousStage, to: present ? 'downloaded' : previousStage } : null,
        ...result
      }, options)
      return present ? 0 : 1
    } finally {
      store.close()
    }
  }

  async function transcribe(options) {
    const media = path.resolve(requireOption(options.options, 'media', 'transcribe'))
    const course = requireOption(options.options, 'course', 'transcribe')
    const lesson = requireOption(options.options, 'lesson', 'transcribe')
    if (!fs.existsSync(media)) throw new Error(`找不到媒体文件：${media}`)
    const outputDir = path.resolve(
      options.options['output-dir'] || path.join(path.dirname(media), '..', 'transcript')
    )
    const args = [
      config.asr.entry,
      '--source', media,
      '--output-dir', outputDir,
      '--course', course,
      '--lesson', lesson,
      '--chunk-minutes', String(options.options['chunk-minutes'] || config.asr.chunkMinutes)
    ]
    const replayKey = options.options['replay-key'] || ''
    const workerId = options.options['worker-id'] || defaultWorkerId()
    const store = openStore(config.ledgerPath)
    try {
      const task = replayKey ? claimForRun(store, replayKey, workerId) : null
      const previousStage = task?.stage || 'discovered'

      const result = await runPython({
        python: config.python,
        args,
        env: pythonEnvironment(config)
      })
      if (result.stdout) stderr(result.stdout.trim())
      if (result.stderr) stderr(result.stderr.trim())

      const summaryPath = path.join(outputDir, 'run-summary.json')
      const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null
      const transcriptPath = path.join(outputDir, 'raw-transcript.md')
      const produced = result.code === 0 && fs.existsSync(transcriptPath)

      if (task) {
        if (produced) {
          store.reportStage({
            id: task.id,
            stage: 'transcript_ready',
            message: '转录完成',
            data: {
              artifacts: { transcriptPath, summaryPath, chunkCount: summary?.chunkCount ?? null },
              runtime: {
                videoDurationSeconds: summary?.videoDurationSeconds ?? null,
                sentenceCount: summary?.sentenceCount ?? null,
                estimatedCostCny: summary?.estimatedCostCnyBeforeFreeQuota ?? null
              }
            }
          })
        } else {
          store.reportStage({
            id: task.id,
            stage: previousStage,
            message: '转录失败',
            error: result.stderr?.trim() || `python 退出码 ${result.code}`,
            nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString()
          })
        }
      }

      emit({
        outputDir,
        transcript: transcriptPath,
        produced,
        task: task ? { id: task.id, from: previousStage, to: produced ? 'transcript_ready' : previousStage } : null,
        summary
      }, options)
      return produced ? 0 : (result.code || 1)
    } finally {
      store.close()
    }
  }

  return { doctor, discover, download, transcribe, notes, publish, status }
}

export const USAGE = `用法：course <命令> [选项]

命令：
  doctor                                   检查依赖与凭据是否齐备
  status     [--stage <阶段>] [--limit <条数>]
                                           查看账本：各阶段任务数与任务明细
  discover   [--course <名称>] [--course-key <键>] [--out <文件>]
                                           登录教学网，列出本学期课程与课堂实录
  download   --course-key <键> --replay-key <键> [--course <名称>] [--title <标题>]
                                           下载一条回放的媒体（HLS 分片 → MP4）
  transcribe --media <文件> --course <名称> --lesson <课次> [--replay-key <键>] [--chunk-minutes <分钟>] [--output-dir <目录>]
                                           调用 Paraformer 转录（分片 + R2 中转 + 断点续跑）
  notes      --transcript <文件> --course <名称> --lesson <课次> [--replay-key <键>] [--output-dir <目录>]
             [--auto-approve-outline 0|1] [--max-steps <步数>]
                                           从转录稿生成单课笔记（大纲 → 节点 → 审查 → 拼装 → 终审）
  publish    --from <笔记目录> [--course <名称>] [--lesson <课次>] [--out <站点目录>] [--origin <域名>]
                                           把笔记发布到站点，内容变化时排入一条微信通知

账本：download / transcribe 若带 --replay-key 且账本中已有该回放，会先领取任务，
成功后推进阶段；失败则记录原因并退避 5 分钟。账本没有该回放时按独立运行处理。

通用选项：
  --json                                   以 JSON 输出（默认即为 JSON）
  --help                                   显示本帮助

环境变量：见 docs/01-模块化方案.md。密钥只从环境读取，不接受命令行传入。
`
