import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkFreeSpace, createValidatedAcquisitionRuntime, formatBytes } from '@course/acquisition'
import { callCourseModel, createInitialLesson, runLessonNotes } from '@course/notes'
import { createWechatSender, runDeliveryCycle } from '@course/notify'
import { buildNoteRecord, readSiteIndex, writeSite } from '@course/publish'

/**
 * 只保留最近 N 次运行摘要。
 *
 * 定时任务每天跑三轮，不清理的话 runs/ 会无限增长；运行摘要只对"最近发生了什么"
 * 有用，历史价值有限。
 */
function pruneRunHistory(runsDir, keep) {
  if (!fs.existsSync(runsDir)) return
  const entries = fs.readdirSync(runsDir)
    .map(name => ({ name, at: fs.statSync(path.join(runsDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const entry of entries.slice(keep)) {
    fs.rmSync(path.join(runsDir, entry.name), { recursive: true, force: true })
  }
}

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
  const {
    config, acquire, runPython, which, openStore,
    callModel: injectedCallModel, sender: injectedSender, sleep = defaultSleep,
    stdout, stderr
  } = context

  function defaultSleep(ms, signal) {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(); return }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

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

  /**
   * 下载前的磁盘检查。放在真正开始拉流之前，而不是等写失败——
   * 一节课媒体 1—2G，中途失败会留下半截分片还要清理。
   */
  function requireDiskSpace(stageLabel) {
    const space = checkFreeSpace({ path: config.scratchRoot, minFreeBytes: config.minFreeBytes })
    if (!space.ok) {
      throw new Error(
        `磁盘可用空间不足，已停止${stageLabel}：当前 ${formatBytes(space.freeBytes)}，` +
        `低于下限 ${formatBytes(space.minFreeBytes)}（差 ${formatBytes(space.shortfallBytes)}）`
      )
    }
    return space
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
    // cycle 会调用这些子命令；给它一个静默模式，避免同一条链路上打出多份 JSON
    if (options?.quiet) return
    stdout(JSON.stringify(payload, null, 2))
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
    const space = checkFreeSpace({ path: config.scratchRoot, minFreeBytes: config.minFreeBytes })
    const report = {
      config: summary,
      binaries: { ...binaries, chrome },
      disk: {
        free: formatBytes(space.freeBytes),
        minFree: formatBytes(space.minFreeBytes),
        ok: space.ok
      },
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
        chrome: chrome !== 'missing',
        disk: space.ok
      }
    }
    emit(report, options)
    return report.ready.ffmpeg && report.ready.python && report.ready.disk ? 0 : 1
  }

  async function discover(options) {
    const runtime = await acquire({ log: message => stderr(String(message)), config })
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

  /**
   * 把账本里排队的通知发到微信。
   *
   * 队列来自本机账本，不依赖任何远端接口——旧 relay 每 30 秒去轮询 Vercel 的
   * 三个端点，一旦那边不可用就只剩日志里的 "fetch failed"。
   * --probe 用 openclaw 的 dry-run 验证通道与目标，不会真的发消息。
   */
  async function notify(options) {
    const target = config.notify.target
    if (!target) throw new Error('缺少推送目标：请在 ~/.course-worker/env 设置 COURSE_WECHAT_TARGET')

    const sender = injectedSender || createWechatSender({
      openclawBin: config.notify.openclawBin,
      openclawHome: config.notify.openclawHome,
      openclawStateDir: config.notify.openclawStateDir,
      target
    })

    if (options.flags.has('probe')) {
      const probe = await sender.probe()
      emit({ probe: true, ok: probe.ok, target: config.notify.target ? 'set' : 'missing', detail: probe.detail }, options)
      return probe.ok ? 0 : 1
    }

    const store = openStore(config.ledgerPath)
    try {
      const cycleOptions = {
        store,
        sender,
        publicSiteUrl: config.notify.publicUrl,
        maxAttempts: config.notify.maxAttempts,
        maxItems: Number(options.options['max-items'] || 10),
        workerId: options.options['worker-id'] || `notify:${os.hostname()}`,
        onEvent: event => stderr(`  ${event.status} ${event.dedupeKey}${event.error ? ` — ${event.error}` : ''}`)
      }

      if (!options.flags.has('loop')) {
        const summary = await runDeliveryCycle(cycleOptions)
        emit({ mode: 'once', ...summary }, options)
        return summary.failed > 0 ? 1 : 0
      }

      // 常驻循环：间隔可配；每轮都是独立事务，中断不会丢状态
      const signal = options.signal
      let rounds = 0
      let totals = { sent: 0, retried: 0, failed: 0 }
      while (!signal?.aborted) {
        const summary = await runDeliveryCycle(cycleOptions)
        rounds += 1
        totals = {
          sent: totals.sent + summary.sent,
          retried: totals.retried + summary.retried,
          failed: totals.failed + summary.failed
        }
        if (summary.results.length) stderr(`第 ${rounds} 轮：发送 ${summary.sent}，重试 ${summary.retried}，失败 ${summary.failed}`)
        await sleep(config.notify.pollSeconds * 1000, signal)
      }
      emit({ mode: 'loop', rounds, ...totals }, options)
      return 0
    } finally {
      store.close()
    }
  }

  /**
   * 一轮完整链路：扫描 → 逐条推进各阶段 → 投递通知。
   *
   * 它不自己实现任何一步，只是按账本里的阶段调用既有命令：每个阶段成功就推进，
   * 失败就由账本记录原因与退避时间，下一轮从最近成功的阶段继续。
   * 因此中断、部分失败、重复运行都是安全的。
   */
  async function cycle(options) {
    const workerId = options.options['worker-id'] || `cycle:${os.hostname()}`
    const maxTasks = Number(options.options['max-tasks'] || 5)
    const quiet = { ...options, quiet: true }
    const summary = { workerId, startedAt: new Date().toISOString(), discovered: null, disk: null, tasks: [], notification: null, errors: [] }

    // 先把磁盘看清：空间不足时连扫描都不必做，但仍要把已排队的通知发出去
    const space = checkFreeSpace({ path: config.scratchRoot, minFreeBytes: config.minFreeBytes })
    summary.disk = {
      free: formatBytes(space.freeBytes),
      minFree: formatBytes(space.minFreeBytes),
      ok: space.ok
    }
    if (!space.ok) {
      summary.errors.push({
        step: 'disk',
        message: `可用空间 ${formatBytes(space.freeBytes)} 低于下限 ${formatBytes(space.minFreeBytes)}，本轮跳过媒体处理`
      })
    }

    // 1. 扫描并登记（幂等）；磁盘不足时跳过，避免登记完却下不动
    if (space.ok) {
      try {
        await discover({ ...quiet, options: { ...options.options } })
      } catch (error) {
        summary.errors.push({ step: 'discover', message: error instanceof Error ? error.message : String(error) })
      }
    }

    // 2. 逐条推进：每次领取一条，按当前阶段调用对应命令
    const stageCommands = {
      discovered: 'download',
      queued: 'download',
      downloading: 'download',
      downloaded: 'transcribe',
      transcribing: 'transcribe',
      transcript_ready: 'notes',
      building_textpack: 'notes',
      writing: 'notes',
      notes_ready: 'publish',
      publishing: 'publish'
    }

    for (let index = 0; space.ok && index < maxTasks; index += 1) {
      const store = openStore(config.ledgerPath)
      let task = null
      try {
        task = store.claimNext({ workerId, leaseSeconds: 3600 })
      } finally {
        store.close()
      }
      if (!task) break

      const command = stageCommands[task.stage]
      if (!command) {
        // 可领取却没有对应命令，说明阶段映射与账本脱节——这类问题必须浮出来，
        // 不能静默跳过并让整轮看起来成功。
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: 'none', ok: false,
          note: '该阶段没有对应的处理命令'
        })
        continue
      }

      const commandOptions = {
        ...quiet,
        options: {
          ...options.options,
          'replay-key': task.replay_key,
          'course-key': task.course_key,
          course: task.course_name,
          title: task.title,
          lesson: task.title,
          'worker-id': workerId
        }
      }
      // 各阶段需要的前置产物路径从账本里取
      const artifacts = task.artifacts || {}
      if (command === 'transcribe') commandOptions.options.media = artifacts.mediaPath
      if (command === 'notes') commandOptions.options.transcript = artifacts.transcriptPath
      if (command === 'publish') commandOptions.options.from = path.dirname(artifacts.notePath || '')

      const missing = command === 'transcribe' ? !commandOptions.options.media
        : command === 'notes' ? !commandOptions.options.transcript
          : command === 'publish' ? !commandOptions.options.from
            : false
      if (missing) {
        // 跳过不是成功：前置产物缺失意味着上一阶段的结果没落下来，需要人工看一眼
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: command, ok: false,
          note: '缺少前置产物，跳过'
        })
        continue
      }

      try {
        const code = await (command === 'download' ? download(commandOptions)
          : command === 'transcribe' ? transcribe(commandOptions)
            : command === 'notes' ? notes(commandOptions)
              : publish(commandOptions))
        summary.tasks.push({ replayKey: task.replay_key, stage: task.stage, action: command, ok: code === 0 })
      } catch (error) {
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: command, ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // 3. 投递已排队的通知
    try {
      const store = openStore(config.ledgerPath)
      try {
        const sender = injectedSender || createWechatSender({
          openclawBin: config.notify.openclawBin,
          openclawHome: config.notify.openclawHome,
          openclawStateDir: config.notify.openclawStateDir,
          target: config.notify.target
        })
        const delivered = await runDeliveryCycle({
          store, sender,
          publicSiteUrl: config.notify.publicUrl,
          maxAttempts: config.notify.maxAttempts,
          workerId: `${workerId}:notify`
        })
        summary.notification = { sent: delivered.sent, retried: delivered.retried, failed: delivered.failed }
      } finally {
        store.close()
      }
    } catch (error) {
      summary.errors.push({ step: 'notify', message: error instanceof Error ? error.message : String(error) })
    }

    summary.finishedAt = new Date().toISOString()
    summary.exitCode = summary.errors.length || summary.tasks.some(task => task.ok === false) ? 1 : 0

    // 落盘运行摘要：管理台的历史面板读的就是这里。不写的话那个面板永远是空的。
    try {
      const stamp = summary.startedAt.replace(/[:.]/g, '-')
      const runDir = path.join(config.scratchRoot, 'runs', `cycle-${stamp}`)
      fs.mkdirSync(runDir, { recursive: true })
      fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      pruneRunHistory(path.join(config.scratchRoot, 'runs'), 50)
    } catch (error) {
      // 摘要写不进去不该让整轮失败——它只是观测，不是产物
      stderr(`运行摘要写入失败（不影响本轮结果）：${error instanceof Error ? error.message : String(error)}`)
    }

    emit(summary, options)
    return summary.exitCode
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
    requireDiskSpace('下载')
    const store = openStore(config.ledgerPath)
    try {
      const task = claimForRun(store, replayKey, workerId)
      const previousStage = task?.stage || 'discovered'
      let result
      try {
        const runtime = await acquire({ log: message => stderr(String(message)), config })
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

  return { doctor, discover, download, transcribe, notes, publish, notify, cycle, status }
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
  notify     [--probe] [--loop] [--max-items <条数>]
                                           把账本里排队的通知发到微信；--probe 只验证通道不发消息
  cycle      [--max-tasks <条数>] [--course <名称>]
                                           一轮完整链路：扫描 → 逐条推进各阶段 → 投递通知

账本：download / transcribe 若带 --replay-key 且账本中已有该回放，会先领取任务，
成功后推进阶段；失败则记录原因并退避 5 分钟。账本没有该回放时按独立运行处理。

通用选项：
  --json                                   以 JSON 输出（默认即为 JSON）
  --help                                   显示本帮助

环境变量：见 docs/01-模块化方案.md。密钥只从环境读取，不接受命令行传入。
`
