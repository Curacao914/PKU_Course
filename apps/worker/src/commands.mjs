import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkFreeSpace, createValidatedAcquisitionRuntime, formatBytes } from '@course/acquisition'
import { callCourseModel, createInitialLesson, generateBrief, renderBriefMessage, runLessonNotes } from '@course/notes'
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

  // 命令的返回值即退出码（CLI 约定），因此跨命令传递"上一轮摘要"需要单独的槽位
  const state = { lastCycle: null }

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
   * 删除一节课的原始媒体与 HLS 分片，保留转录稿。
   *
   * 只删我们自己下载的东西（media.mp4 与 fragments 目录），且限定在该回放的
   * 目录之内——不做"按文件名模式删除"这种会误伤的操作。
   */
  function cleanupMedia(mediaPath) {
    const replayDir = path.dirname(path.dirname(mediaPath))   // <replay>/output/media.mp4 → <replay>
    const targets = [mediaPath, path.join(replayDir, 'fragments')]
    let removedBytes = 0
    const removed = []
    for (const target of targets) {
      if (!fs.existsSync(target)) continue
      removedBytes += directorySize(target)
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(path.relative(replayDir, target))
    }
    return { removed, removedBytes }
  }

  function directorySize(target) {
    const stat = fs.statSync(target)
    if (stat.isFile()) return stat.size
    let total = 0
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name)
      total += entry.isDirectory() ? directorySize(child) : fs.statSync(child).size
    }
    return total
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

    // 中间状态落盘：模型调用是这条链路里最贵的资源，而 runLessonNotes 全程在内存里。
    // 每一步都把课次状态写成 JSON，崩了、超步数了、机器重启了都能从最近一步续跑；
    // 同时也是事后唯一能拿到的评审报告与节点草稿（笔记成品只保留最终稿）。
    const statePath = path.join(outputDir, 'lesson-state.json')
    const resume = options.flags?.has('resume') && fs.existsSync(statePath)
    const lesson = resume
      ? JSON.parse(fs.readFileSync(statePath, 'utf8')).lesson
      : createInitialLesson({
        key: replayKey || `lesson-${Date.now()}`,
        title: lessonTitle,
        transcript,
        blueprint: { mainLine: '' }
      })
    const saveState = (current, step) => {
      const payload = {
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        step,
        lesson: current
      }
      const tempPath = `${statePath}.tmp`
      fs.writeFileSync(tempPath, `${JSON.stringify(payload)}`)
      fs.renameSync(tempPath, statePath)
    }
    const courseSpec = {
      courseName: course,
      teacher: options.options.teacher || '',
      promptVersion: options.options['prompt-version'] || undefined,
      // 切片粒度：一个节点最多覆盖多少字/多少行转录。默认 12000 字 / 200 行（细切），
      // 调大就是粗切，用于"切得细到底有没有必要"的对比实验。
      ...(options.options['node-split-chars'] ? { nodeSplitThreshold: Number(options.options['node-split-chars']) } : {}),
      ...(options.options['node-split-lines'] ? { nodeSplitLineThreshold: Number(options.options['node-split-lines']) } : {}),
      // 目标节点数：1 = 整节课一个节点一次写完，2/3 = 粗切。
      // 指定目标节点数时，默认关闭"按体量再切分"——否则大纲给一个节点、程序又把它
      // 按 12000 字阈值切成十几个，等于没粗切。要保留再切分就显式给 --node-split-*。
      ...(options.options['outline-nodes']
        ? {
          targetOutlineNodes: Number(options.options['outline-nodes']),
          ...(options.options['node-split-chars'] || options.options['node-split-lines']
            ? {}
            : { nodeSplitThreshold: Number.MAX_SAFE_INTEGER, nodeSplitLineThreshold: Number.MAX_SAFE_INTEGER })
        }
        : {})
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
        // 默认不设步数上限：终止由状态机负责（每节点最多重写两次、终审修订预算、空闲即停）。
        maxSteps: options.options['max-steps'] ? Number(options.options['max-steps']) : undefined,
        reviewConcurrency: Number(options.options['review-concurrency'] || 2),
        totalConcurrency: Number(options.options['concurrency'] || 3),
        onEvent: step => stderr(`  [${step.index + 1}] ${step.taskType} → ${step.action || '-'} (${step.note})`),
        onState: saveState
      })

      const produced = result.lesson.status === 'completed' && Boolean(result.lesson.finalNote?.markdown)
      const notePath = path.join(outputDir, `${safeFileName(lessonTitle)}.md`)
      const summaryPath = path.join(outputDir, 'notes-run-summary.json')
      const briefPath = path.join(outputDir, 'brief.json')
      if (produced) fs.writeFileSync(notePath, `${result.lesson.finalNote.markdown}\n`)

      // 简报：推送消息里要放的"这节课大概在讲什么"。它只基于已成稿的笔记，
      // 因此与笔记不会互相矛盾；生成失败不影响笔记——简报是锦上添花，不是交付物。
      let brief = null
      let briefError = null
      if (produced) {
        try {
          brief = await generateBrief({ lesson: result.lesson, courseSpec, callModel, modelConfig })
          fs.writeFileSync(briefPath, `${JSON.stringify({
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            course,
            lesson: lessonTitle,
            briefing: brief.briefing,
            keyPoints: brief.keyPoints,
            detail: brief.detail,
            trace: brief.trace
          }, null, 2)}\n`)
          stderr(`简报已生成（${brief.words} 字，${brief.keyPoints.length} 条要点）`)
        } catch (error) {
          briefError = error instanceof Error ? error.message : String(error)
          stderr(`简报生成失败：${briefError}（笔记本身不受影响）`)
        }
      }

      const summary = {
        course,
        lesson: lessonTitle,
        status: result.lesson.status,
        stopReason: result.stopReason,
        idleReason: result.idleDetail?.reason || null,
        nodeCount: result.lesson.nodes.length,
        finalChars: result.lesson.finalNote?.markdown?.length || 0,
        steps: result.steps,
        autoApproveOutline,
        resumed: resume,
        maxSteps: options.options['max-steps'] ? Number(options.options['max-steps']) : null,
        brief: brief ? { path: briefPath, words: brief.words, keyPoints: brief.keyPoints.length } : null,
        briefError
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
    // 简报（notes 阶段的产物）：放消息正文与笔记页顶部。
    const briefPath = path.join(from, 'brief.json')
    const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : null

    const siteRoot = path.resolve(options.options.out || path.join(config.scratchRoot, 'site'))
    const libraryPath = path.join(siteRoot, 'library.json')
    const library = fs.existsSync(libraryPath) ? JSON.parse(fs.readFileSync(libraryPath, 'utf8')) : []
    const record = buildNoteRecord({
      courseName: course,
      teacher,
      lessonTitle,
      markdown,
      replayKey: runSummary.replayKey || options.options['replay-key'] || '',
      publishedAt: options.options['published-at'] || new Date().toISOString(),
      brief
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
          // 幂等键带上内容指纹：同一课次内容变了要重新推一次，
          // 否则"改好之后再发一遍"会被去重规则静默吃掉（旧实现就是只按 slug 去重）。
          dedupeKey: `course-note:${record.slug}:${checksum.slice(0, 12)}`,
          purpose: 'course-note',
          // 正文用简报（一段说明 + 三条要点），不用笔记截断：截断出来的是半句话，
          // 读者无法判断这节课讲了什么。没有简报时退回原来的摘要。
          bodyText: brief?.briefing
            ? renderBriefMessage({ courseName: record.courseName, lessonTitle: record.lessonTitle, brief })
            : `${record.courseName} · ${record.lessonTitle}\n${record.summary}`,
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

    // 1. 扫描并登记（幂等）；磁盘不足时跳过，避免登记完却下不动。
    // 只传 course：discover 的 --out 是"目录清单文件"，与 publish 的站点目录同名不同义。
    if (space.ok) {
      try {
        await discover({
          ...quiet,
          options: options.options.course ? { course: options.options.course } : {}
        })
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

    // 指定 replay-key 时只处理这一条：验收与手动重跑都必须是"就这一节课"，
    // 否则一次调用会顺着账本把多节课全跑一遍——而每节课都要真花钱转写。
    const onlyReplay = String(options.options['replay-key'] || '').trim()

    for (let index = 0; space.ok && index < maxTasks; index += 1) {
      const store = openStore(config.ledgerPath)
      let task = null
      try {
        if (onlyReplay) {
          const claimed = store.claimTask({ replayKey: onlyReplay, workerId, leaseSeconds: 3600 })
          task = claimed.claimed ? claimed.task : null
          if (!claimed.claimed) {
            // "已完成"不是失败：指定单节课时，跑完自然就领不到了。
            // 把这种情况报成失败会让验收永远显示不通过。
            const finished = ['published', 'completed'].includes(claimed.task?.stage)
            summary.tasks.push({
              replayKey: onlyReplay,
              stage: claimed.task?.stage || 'unknown',
              action: finished ? 'done' : 'skip',
              ok: finished,
              note: finished ? '该课次已完成' : `未领取：${claimed.reason}`
            })
            if (finished) break
          }
        } else {
          task = store.claimNext({ workerId, leaseSeconds: 3600 })
        }
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

      const artifacts = task.artifacts || {}
      const common = {
        'replay-key': task.replay_key,
        course: task.course_name,
        'worker-id': workerId,
        ...(options.options['prompt-version'] ? { 'prompt-version': options.options['prompt-version'] } : {})
      }

      // 每个子命令只拿它自己认识的参数。
      // 早先是把 options.options 整体透传的，结果 --out 冲突：discover 把目录清单
      // 写成"站点目录"那个路径上的一个文件，publish 再去建同名目录就 EEXIST。
      // 同名旗标在不同命令里含义不同时，透传必然出这种事。
      const perCommand = {
        download: { ...common, 'course-key': task.course_key, title: task.title },
        transcribe: { ...common, media: artifacts.mediaPath, lesson: task.title },
        notes: {
          ...common,
          transcript: artifacts.transcriptPath,
          lesson: task.title,
          // 这条链路里最贵的两步（写作、审查）都是模型调用，因此"跑一半停下"的代价
          // 由这两个旗标决定：步数上限要够走完最坏路径，中止后要能续跑。
          ...(options.options['max-steps'] ? { 'max-steps': options.options['max-steps'] } : {}),
          ...(options.options['auto-approve-outline'] ? { 'auto-approve-outline': options.options['auto-approve-outline'] } : {})
        },
        publish: {
          ...common,
          from: path.dirname(artifacts.notePath || ''),
          // 站点目录只在显式指定时才传，避免与 discover 的 --out 混淆
          ...(options.options.out ? { out: options.options.out } : {})
        }
      }
      const commandOptions = {
        ...quiet,
        options: perCommand[command] || { ...common },
        // 自动链路默认续跑：笔记阶段每一步都落了盘，重跑一次要花真钱真时间，
        // 没有理由从第一个节点重来。手工跑 notes 时仍要求显式 --resume。
        flags: command === 'notes' ? new Set([...(quiet.flags || []), 'resume']) : quiet.flags
      }

      const missing = command === 'transcribe' ? !commandOptions.options.media
        : command === 'notes' ? !commandOptions.options.transcript
          : command === 'publish' ? !artifacts.notePath
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

    state.lastCycle = summary
    emit(summary, options)
    return summary.exitCode
  }

  /**
   * 验收：把「六步验收条件」变成可执行的检查，而不是文档里的一段话。
   *
   * 做法是先跑一轮真实 cycle，再对**结果**断言：任务是否真的走到了 published、
   * 笔记文件是否真的存在、站点是否真的能打开、通知是否真的发出去了。
   * 每一环都需要真实凭据与真实数据——没有 mock，也不会把"没跑"报成"通过"。
   */
  async function verify(options) {
    const replayKey = options.options['replay-key'] || ''
    const criteria = []
    const check = (name, ok, evidence) => criteria.push({ name, ok: Boolean(ok), evidence })

    // 前置条件
    const space = checkFreeSpace({ path: config.scratchRoot, minFreeBytes: config.minFreeBytes })
    check('磁盘可用空间充足', space.ok, `${formatBytes(space.freeBytes)} / 下限 ${formatBytes(space.minFreeBytes)}`)
    check('教学网凭据已配置', Boolean(config.sources.PKU_USERNAME && config.sources.PKU_PASSWORD), 'PKU_USERNAME / PKU_PASSWORD')
    check('转录凭据已配置', Boolean(config.sources.DASHSCOPE_API_KEY && config.sources.R2_ENDPOINT), 'DASHSCOPE_API_KEY / R2_*')
    check('AI 凭据已配置', Boolean(config.ai.apiKey), 'COURSE_AI_API_KEY')
    const ready = criteria.every(item => item.ok)
    if (!ready) {
      emit({ ready: false, criteria, hint: '补齐上面未通过的前置条件后重新运行' }, options)
      return 1
    }

    // 真实跑一轮（命令返回退出码，摘要从共享槽位取）
    const cycleCode = await cycle({ ...options, quiet: true, options: { ...options.options, 'replay-key': replayKey } })
    const cycleResult = state.lastCycle || {}
    void cycleCode

    // 对结果断言
    const store = openStore(config.ledgerPath)
    let tasks = []
    let deliveries = []
    try {
      tasks = store.listTasks({ limit: 50 })
      deliveries = store.db.prepare('SELECT dedupe_key, status, sent_at FROM deliveries ORDER BY id DESC LIMIT 10').all()
    } finally {
      store.close()
    }

    const published = tasks.filter(task => task.stage === 'published')
    check('回放被登记进账本', tasks.length > 0, `${tasks.length} 条任务`)
    check('笔记撰写完成', tasks.some(task => ['notes_ready', 'published'].includes(task.stage)), tasks.map(t => `${t.replay_key}:${t.stage}`).join(', '))

    const siteDir = path.resolve(options.options.out || path.join(config.scratchRoot, 'site'))
    let siteNotes = []
    try {
      siteNotes = readSiteIndex(siteDir).notes || []
    } catch (error) {
      siteNotes = []
    }
    check('笔记已发布到站点', siteNotes.length > 0 || published.length > 0, `站点索引 ${siteNotes.length} 篇`)

    const noteFileExists = siteNotes.some(note => fs.existsSync(path.join(siteDir, `${note.slug}.html`)))
    check('站点页面文件存在', noteFileExists, siteNotes[0] ? `${siteNotes[0].slug}.html` : '（无）')

    const sent = deliveries.filter(row => row.status === 'sent')
    if (config.notify.target) {
      check('通知已投递到微信', sent.length > 0, sent[0] ? `${sent[0].dedupe_key} → ${sent[0].sent_at}` : '尚无已发送记录')
    } else {
      check('通知通道已配置', false, '未设置 COURSE_WECHAT_TARGET')
    }

    const report = {
      ready: true,
      passed: criteria.every(item => item.ok),
      criteria,
      cycle: {
        disk: cycleResult.disk ?? null,
        tasks: cycleResult.tasks ?? [],
        notification: cycleResult.notification ?? null,
        errors: cycleResult.errors ?? []
      }
    }
    emit(report, options)
    return report.passed ? 0 : 1
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

      // 转写成功即清理原始媒体与分片。视频在教学平台本来就有，留着只会吃满盘；
      // 转录稿与后续笔记才是要长期保存的东西。失败时保留以便重试。
      let cleanup = null
      if (produced && !config.keepMedia) {
        cleanup = cleanupMedia(media)
        if (cleanup.removedBytes > 0) {
          stderr(`已清理媒体与分片，释放 ${formatBytes(cleanup.removedBytes)}`)
        }
      }

      if (task) {
        if (produced) {
          store.reportStage({
            id: task.id,
            stage: 'transcript_ready',
            message: '转录完成',
            data: {
              artifacts: {
                transcriptPath,
                summaryPath,
                chunkCount: summary?.chunkCount ?? null,
                mediaPath: cleanup ? '' : media,
                mediaCleaned: Boolean(cleanup)
              },
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
        mediaCleanup: cleanup,
        task: task ? { id: task.id, from: previousStage, to: produced ? 'transcript_ready' : previousStage } : null,
        summary
      }, options)
      return produced ? 0 : (result.code || 1)
    } finally {
      store.close()
    }
  }

  return { doctor, discover, download, transcribe, notes, publish, notify, cycle, verify, status }
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
             [--auto-approve-outline 0|1] [--max-steps <步数>] [--resume]
             [--concurrency <条数>] [--review-concurrency <条数>]
             [--node-split-chars <字数>] [--node-split-lines <行数>] [--outline-nodes <个数>]
                                           从转录稿生成单课笔记（大纲 → 节点 → 写作 → 审查 → 拼装 → 终审）
                                           每步把课次状态写入 <输出目录>/lesson-state.json；--resume 从该状态续跑
                                           默认不设步数上限；并发默认写 1 + 审 2（合计 3 条）
  publish    --from <笔记目录> [--course <名称>] [--lesson <课次>] [--out <站点目录>] [--origin <域名>]
                                           把笔记发布到站点，内容变化时排入一条微信通知
  notify     [--probe] [--loop] [--max-items <条数>]
                                           把账本里排队的通知发到微信；--probe 只验证通道不发消息
  cycle      [--max-tasks <条数>] [--course <名称>] [--replay-key <键>] [--max-steps <步数>]
             [--auto-approve-outline 0|1]
                                           一轮完整链路：扫描 → 逐条推进各阶段 → 投递通知
                                           --max-steps / --auto-approve-outline 会透传给 notes 阶段
  verify     [--course <名称>] [--replay-key <键>] [--out <站点目录>]
                                           验收：跑一轮真实链路并按验收条件逐项断言

账本：download / transcribe 若带 --replay-key 且账本中已有该回放，会先领取任务，
成功后推进阶段；失败则记录原因并退避 5 分钟。账本没有该回放时按独立运行处理。

通用选项：
  --json                                   以 JSON 输出（默认即为 JSON）
  --help                                   显示本帮助

环境变量：见 docs/01-模块化方案.md。密钥只从环境读取，不接受命令行传入。
`
