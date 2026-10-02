import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkFreeSpace, createValidatedAcquisitionRuntime, formatBytes } from '@course/acquisition'
import {
  addMaterial, guessMaterialIdentity, listMaterials, ocrMaterial, parseInboxName, pendingOcrMaterials, readDecks, unassignedDir
} from '@course/materials'
import { embedTexts, loadEmbeddingIndex, splitSections } from '@course/notes-mcp'
import {
  SOURCE_MAP_SCHEMA,
  buildIntegrationPlan,
  buildPrompt,
  buildSourceMapSource,
  checkNoteQuality,
  formatQualityReport,
  normalizeSourceMapDraft,
  renderIntegrationMarkdown
} from '@course/notes'

import { formatInventory, scanArtifactInventory } from './artifact-inventory.mjs'
import {
  emptyIntegrationManifest,
  normalizeIntegrationManifest,
  selectConfiguredIntegrations,
  upsertIntegrationDefinition
} from './integration-manifest.mjs'
import { collectExceptions, formatExceptions } from './reconcile.mjs'
import { cacheUrlsFor, extractNoteMetadata, purgeCloudflareCache } from '@course/publish'

import { NOTIFY_POLICY, clearPending, pendingNotifications, planNotification, resolveNotifyPolicy } from './notify-outbox.mjs'
import { acquirePublishLock, checkRevisionUnchanged, libraryRevision, publishLockPath } from './publish-guard.mjs'
import {
  beginSiteRelease,
  copyReleaseFileIfPresent,
  discardSiteRelease,
  inspectSiteRoot,
  listReleaseFiles,
  migrateLegacySiteRoot,
  previousSiteRelease,
  promoteSiteRelease,
  sealSiteRelease,
  validateSiteRelease
} from './site-releases.mjs'

import { hashPassword, noteCostCny, resolvePricing, validatePassword } from '@course/core'

import {
  LOW_BALANCE_THRESHOLD_CNY,
  classifyProviderIssue,
  fetchAliyunBalance,
  fetchDeepseekBalance,
  renderBalanceWarning
} from './billing.mjs'
import {
  // 简报与来源正文的绑定：生成侧写字段、发布侧校验都走 @course/notes 这一套
  checkBriefBinding,
  // 同一门课此前讲到哪：从发布库提炼的受控摘要（见 course-context.mjs）
  buildCourseContext,
  callCourseModel,
  createInitialLesson,
  ONEPAGE_TARGET_CHARS,
  generateBrief,
  generateBriefFromMarkdown,
  generateOnepage,
  getCourseLlmWindowDecision,
  normalizeCourseLlmSchedule,
  pptForRange,
  renderBriefMessage,
  requestNodeRevision,
  runLessonNotes,
  splitWriteUnit
} from '@course/notes'
import {
  WECHAT_SESSION_MAX_AGE_MINUTES,
  createFallbackSender,
  createResilientSender,
  createWechatSender,
  runDeliveryCycle,
  wechatSessionState
} from '@course/notify'
import {
  SOURCE_MAP_VERSION,
  buildNoteRecord,
  buildSourceMap,
  derivedBinding,
  markdownBytesChecksum,
  markdownChecksum,
  markdownPath,
  migrateRecordTime,
  noteSlug,
  onepageBlocks,
  plainBlockText,
  readSiteIndex,
  refreshRecord,
  resolveSourceMapEntries,
  sectionTexts,
  slugify,
  sourceMapStats,
  verifyDerived,
  verifySourceMap,
  writeJsonAtomic,
  writeSite
} from '@course/publish'
import { ACTIONABLE_STAGES } from '@course/store'

import {
  collectDigest,
  collectMissingMaterials,
  dateKeyInTimeZone,
  digestSubject,
  pptReminderSubject,
  previousDateKey,
  renderDigestHtml,
  renderDigestText,
  renderPptReminderHtml,
  renderPptReminderText,
  sendResendEmail
} from './digest.mjs'
import { checkWechatActivation } from './wechat.mjs'

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

/** 从 stdin 读入（改密码用：密码不出现在命令行里，也就不会留在 ps 与 shell 历史里）。 */
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise(resolve => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
  })
}

/** 成品正文字数（用于篇幅核对）。 */
function summary0Chars(result) {
  return String(result?.lesson?.finalNote?.markdown || '').length
}

/** 读 JSON 文件，坏了就返回 null（清理这类维护命令不该因为一个坏文件整轮失败）。 */
function safeJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * 站点产品文档：docs/public/*.md。
 *
 * 仓库里的 docs/ 是设计过程，docs/public/ 是**对外契约**——发布时渲染成 /<name>/ 页面，
 * 同时原样写出 /<name>.md，并汇总进 /llms.txt。以后新增的 API 与 MCP 能力都放这里。
 */
function readPublicDocs() {
  const dir = path.join(REPO_ROOT, 'docs', 'public')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md') && !name.startsWith('_'))
    .sort()
    .map(name => {
      const markdown = fs.readFileSync(path.join(dir, name), 'utf8')
      const title = (markdown.match(/^#\s+(.+)$/m) || [, name.replace(/\.md$/, '')])[1].trim()
      const firstLine = markdown.split('\n').map(line => line.trim())
        .find(line => line && !line.startsWith('#') && !line.startsWith('`')) || ''
      return {
        pathName: name.replace(/\.md$/, ''),
        title,
        description: firstLine.replace(/\*\*/g, '').slice(0, 120),
        markdown
      }
    })
}

/**
 * `--require-materials` 的取值：默认**开启**（没有课件就不自动跑）。
 *
 * 写成显式开关而不是写死在代码里，是为了两件事：管理台的「立即跑这一节」
 * 能明确传 0（"我就是要跑"），以及以后想放开时不用改代码、只改定时任务那一行。
 */
export function parseRequireMaterials(value) {
  if (value === undefined || value === null || String(value).trim() === '') return true
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

/**
 * 自动链路的下一个候选任务。
 *
 * 为什么不直接用 `store.claimNext`：领取会把 `attempts + 1` 并占住一小时租约
 * （见 packages/store/src/ledger.mjs），而"缺课件 → 本轮不处理"必须**零副作用**——
 * 不消耗重试次数、不占租约、不写阶段事件，下一轮（或用户点「立即跑这一节」时）
 * 立刻还能跑。所以这里只做与 claimNext 相同的筛选，选中之后再 claimTask 精确领取。
 *
 * 筛选条件与 claimNext 的 SQL 一一对应：可领取阶段 + 退避到期 + 租约空闲，按 id 排序。
 */
export function nextActionableTask(store, { at = new Date(), exclude = new Set() } = {}) {
  const stamp = (at instanceof Date ? at : new Date(at)).toISOString()
  return store.listTasks({ limit: 200 })
    .filter(task => ACTIONABLE_STAGES.includes(task.stage))
    .filter(task => !task.next_attempt_at || task.next_attempt_at <= stamp)
    .filter(task => !task.lease_expires_at || task.lease_expires_at <= stamp)
    .sort((left, right) => Number(left.id) - Number(right.id))
    .find(task => !exclude.has(task.replay_key)) || null
}

export function createCommands(context) {
  const {
    config, acquire, runPython, which, openStore,
    callModel: injectedCallModel, sender: injectedSender, sleep = defaultSleep,
    // 邮件发送器可注入：测试用假 sender 核对收件人/标题/正文，绝不真发一封邮件
    emailSender: injectedEmailSender,
    env = process.env, now,
    // MCP 服务器可以被注入：测试不该真的挂起等 stdin；生产走 @course/notes-mcp 的实现
    mcpServer: injectedMcpServer,
    // 出网请求可注入：清 CDN 缓存这类调用在测试里不该真的打到 Cloudflare
    fetchImpl: injectedFetch = globalThis.fetch,
    stdout, stderr
  } = context
  const clockNow = () => (typeof now === 'function' ? now() : new Date())

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
   * 这一课次有没有课件。
   *
   * 判据只用 materials 包的 listMaterials：它已经把三种归属算在一起了——
   * 本课次的、全课程通用的（course/ 目录）、以及别的课次声明 `appliesTo` 共用的。
   * 自己再写一遍目录判断，迟早会和它分叉（"明明传了课件，系统还说没有"）。
   *
   * 读盘失败、或者任务上连课程/课次都没有（对不上归档目录）时返回 count = -1（"不知道"）：
   * 宁可让这一轮照跑，也不要因为读不出目录或认不出课次就把整条链路停住——
   * 那会变成"用户明明传了课件，系统还是不动"。
   */
  function lessonMaterials(task) {
    if (!task?.course_name || !task?.title) return { count: -1, names: [] }
    try {
      const found = listMaterials({
        root: config.materialsRoot,
        course: task.course_name,
        lesson: task.title,
        replayKey: task.replay_key
      })
      return { count: found.length, names: found.map(item => item.name) }
    } catch (error) {
      stderr(`课件归档读取失败（${error instanceof Error ? error.message : String(error)}）：本轮按"有课件"处理`)
      return { count: -1, names: [] }
    }
  }

  /**
   * 在账本里领取一条任务。
   *
   * 账本里没有这条回放时不报错——手动跑单节课仍然可用，只是不记录阶段，
   * 并且会在 stderr 明确说明，避免让人误以为进度已被记账。
   */
  /**
   * 领取这次运行要推进的课次。
   *
   * leaseSeconds 可以按阶段给：**转写**这一步的等待发生在 Python 进程里（ASR 轮询最长几十分钟），
   * JS 这侧没有续租的时机，所以只能把租约开得足够长——代价是"worker 崩了之后要等更久
   * 才会被别的 worker 接管"。笔记那一步反过来：它有十几次模型调用、每落一次状态就能续租，
   * 所以用默认租约 + renewTaskLease（见 notes 的 saveState）。两种做法各有各的适用场景，
   * 不要为了统一把转写的租约也调小——那会让长转写被第二个 worker 抢走重跑，钱付两次。
   */
  function claimForRun(store, replayKey, workerId, { leaseSeconds } = {}) {
    const existing = store.getTask(replayKey)
    if (!existing) {
      stderr(`账本中没有 ${replayKey}：本次按独立运行处理，不记录阶段。先跑 course discover 可登记回放。`)
      return null
    }
    const claim = store.claimTask({ replayKey, workerId, ...(leaseSeconds ? { leaseSeconds } : {}) })
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

    // 发现新课就提醒一件具体的事：这一节还没有课件。
    // 教学网上没有课件，课件只在用户手里，而它对笔记质量影响很大（术语对齐、结构对照、
    // 笔记里"依据第几页"）。提醒去重（每课次一条），用户回"无课件"就不再打扰。
    const created = (recorded.created || []).filter(() => !options.options['no-materials-notice'])
    const missingMaterials = created.filter(item =>
      listMaterials({ root: config.materialsRoot, course: item.courseName, lesson: item.title }).length === 0)
    if (created.length) {
      const store = openStore(config.ledgerPath)
      try {
        // 一条短消息：发现了什么、要不要你动手、去哪儿动手。
        store.enqueueDelivery({
          dedupeKey: `new-lesson:${created.map(item => item.replayKey).sort().join(',')}`,
          purpose: 'new-lesson',
          bodyText: [
            `【新课】${created.length} 节：${created.map(item => `${item.courseName} · ${item.title}`).join('；')}`,
            '',
            missingMaterials.length
              ? `其中 ${missingMaterials.length} 节还没有课件——有的话传一份，笔记会更准（术语对齐、结构对照）。`
              : '课件都在，接下来自动下载、转写、写笔记。',
            '写笔记排在低价时段，其余阶段随时进行。',
            '上传课件：https://course.law-tech.dev/admin'
          ].join('\n'),
          objectUrl: 'https://course.law-tech.dev/admin'
        })
      } finally {
        store.close()
      }
    }

    if (options.options.out) {
      fs.mkdirSync(path.dirname(path.resolve(options.options.out)), { recursive: true })
      fs.writeFileSync(path.resolve(options.options.out), `${JSON.stringify({ ...result, flattened }, null, 2)}\n`)
    }
    emit({
      loginMode: result.loginMode,
      courses: result.courses.length,
      replays: flattened.length,
      recorded,
      missingMaterials: missingMaterials.map(item => `${item.courseName}·${item.title}`),
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
    // --revise：只重写指定模块，其余模块的既有草稿原样保留。
    // 一节课的笔记动辄十几次模型调用，改一个模块却整篇重跑既慢又贵，
    // 而且会把已经定稿的段落重新掷一次骰子。这里复用人工修订入口
    // （requestNodeRevision），流水线只会重写被点名的模块。
    const reviseTarget = String(options.options.revise || '').trim()
    const resume = (Boolean(reviseTarget) || options.flags?.has('resume')) && fs.existsSync(statePath)
    if (reviseTarget && !fs.existsSync(statePath)) {
      throw new Error(`--revise 需要已有一次完整运行的中间状态：找不到 ${statePath}`)
    }
    // 课件：教学网上没有课件，只能来自用户上传（materials 命令或管理台）。
    // 有课件时它同时承担三件事：术语/ASR 对照、结构对照、笔记里"依据第几页"的可核对性。
    // 注意：续跑时不覆盖已有课件的引用——重跑中途补传课件后，用 --revise 重写受影响模块。
    let decks = readDecks({ root: config.materialsRoot, course, lesson: lessonTitle, replayKey })
    // 图片版课件（整页是图、扫描件）用 XML 与 pdftotext 都抽不出字：不补识别，笔记就会
    // 凭空少一块内容。这种课件在写笔记之前先补一次，识别结果落回归档的 json。
    // 只有"确实抽不出字"才自动跑——正常课件不该为几分钟的识别买单；--ocr 可以强制补齐。
    const needOcr = decks.filter(deck => deck.ocrPending > 0 &&
      (options.flags?.has('ocr') || deck.textLength < 200))
    if (needOcr.length) {
      stderr(`有 ${needOcr.length} 份课件几乎抽不出文字（图片版），先识别图片文字`)
      for (const deck of needOcr) {
        const entry = listMaterials({ root: config.materialsRoot, course, lesson: lessonTitle, replayKey })
          .find(item => item.name === deck.name)
        try {
          const outcome = await ocrMaterial({
            root: config.materialsRoot,
            course: entry?.course || course,
            lesson: entry?.lesson || '',
            name: deck.name,
            python: config.python,
            ocrConcurrency: Number(options.options['ocr-concurrency'] || 3),
            ocrMaxPages: Number(options.options['ocr-max-pages'] || 60)
          })
          const report = outcome.entry?.ocr || {}
          stderr(outcome.skipped
            ? `  ${deck.name}：${outcome.reason}`
            : `  ${deck.name}：识别 ${report.attempted || 0} 张图，剩 ${outcome.entry?.ocrPending || 0} 张` +
              ((report.errors || []).length ? `（${report.errors[0].error}）` : ''))
        } catch (error) {
          stderr(`  ${deck.name}：识别失败（${error instanceof Error ? error.message : String(error)}），先用现有文字继续`)
        }
      }
      decks = readDecks({ root: config.materialsRoot, course, lesson: lessonTitle, replayKey })
    }
    if (decks.length) {
      stderr(`已载入 ${decks.length} 份课件（共 ${decks.reduce((total, deck) => total + deck.slides.length, 0)} 页）`)
    } else if (!resume) {
      stderr('本课次没有课件；补齐课件后可用 --revise 重写受影响的模块（不影响其余模块）')
    }

    let lesson = resume
      ? JSON.parse(fs.readFileSync(statePath, 'utf8')).lesson
      : createInitialLesson({
        key: replayKey || `lesson-${Date.now()}`,
        title: lessonTitle,
        transcript,
        pptText: decks,
        blueprint: { mainLine: '' }
      })

    if (reviseTarget) {
      const request = String(options.options.request || '').trim()
      if (!request) throw new Error('--revise 需要同时给 --request "<要改什么>"')
      const wanted = reviseTarget.split(',').map(item => item.trim()).filter(Boolean)
      const matched = (lesson.nodes || []).filter(node => {
        const ids = [node.id, node.outlineNodeId, ...(node.outlineNodeIds || [])].filter(Boolean)
        return ids.some(id => wanted.includes(id)) || wanted.some(item => String(node.title || '').includes(item))
      })
      if (!matched.length) {
        const available = (lesson.nodes || []).map(node => `${node.id}${node.title ? `（${node.title}）` : ''}`).join('、')
        throw new Error(`--revise 没匹配到模块：${reviseTarget}；可用的模块有：${available}`)
      }
      // 补齐课件之后再重写时，把课件接进现有课次：否则"上课件改笔记"只是句空话。
      // 节点按各自大纲条的 slideRange 取对应页（与首次写作同一套规则）。
      if (decks.length) {
        const outlineById = new Map((lesson.outline || []).map(item => [item.id, item]))
        lesson = {
          ...lesson,
          pptText: decks,
          nodes: (lesson.nodes || []).map(node => ({
            ...node,
            pptText: pptForRange(decks, outlineById.get(node.outlineNodeId)?.slideRange || [])
          }))
        }
        stderr(`已把 ${decks.length} 份课件接入本次重写`)
      }
      for (const node of matched) {
        const ids = Array.isArray(node.outlineNodeIds) && node.outlineNodeIds.length
          ? node.outlineNodeIds
          : [node.outlineNodeId]
        const targeted = wanted.filter(item => ids.includes(item) || String(node.title || '').includes(item))
        // 点名的是"一个写作单元里的某个模块"：先把单元拆成模块节点，只让被点名的模块重写，
        // 其余模块原样放行。否则一次写完 8 个模块的课，改一个模块就得重写整节 1 万字。
        if (ids.length > 1 && targeted.length && targeted.length < ids.length) {
          lesson = splitWriteUnit(lesson, node.id, { keepPending: targeted })
          stderr(`已把写作单元 ${node.id} 拆成 ${ids.length} 个模块，只重写 ${targeted.join('、')}`)
          const splitTarget = (lesson.nodes || []).find(item =>
            item.splitFrom === node.id && targeted.includes(item.outlineNodeId))
          if (splitTarget) {
            stderr(`只重写模块 ${splitTarget.outlineNodeId}（${splitTarget.title}）；同一单元其余 ${ids.length - 1} 个模块原样保留`)
            lesson = requestNodeRevision(lesson, splitTarget.id, request)
          }
          continue
        }
        lesson = requestNodeRevision(lesson, node.id, request)
      }
      stderr(`只重写 ${matched.length} 个模块：${matched.map(node => node.title || node.id).join('、')}（其余模块的草稿保持不变）`)
    }
    // saveState 在 claim 之前就定义了，所以用一个 holder 把任务带进来（作用域不能跨 try 块）
    let activeTask = null
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
      /**
       * 顺手续租（C3）：笔记是整条链路里最贵、也最可能跑很久的一步（十几次模型调用）。
       * 每落一次状态就说明"这个 worker 还活着"，把租约往后推——不然租约到期后别的 worker
       * 会重新领取同一个阶段，模型被调两次、钱付两次。只续自己领的那条（见 ledger 的说明）。
       */
      if (activeTask) {
        try {
          store.renewTaskLease({ id: activeTask.id, workerId, leaseSeconds: 1800 })
        } catch (error) {
          stderr(`续租失败（不影响本次运行）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const courseSpec = {
      courseName: course,
      teacher: options.options.teacher || '',
      promptVersion: options.options['prompt-version'] || undefined,
      // 切片粒度：一个节点最多覆盖多少字/多少行转录。默认 12000 字 / 200 行（细切），
      // 调大就是粗切，用于"切得细到底有没有必要"的对比实验。
      ...(options.options['node-split-chars'] ? { nodeSplitThreshold: Number(options.options['node-split-chars']) } : {}),
      ...(options.options['node-split-lines'] ? { nodeSplitLineThreshold: Number(options.options['node-split-lines']) } : {}),
      // 篇幅预算：整节课的目标字数（默认 15000，两小时与三小时课都够用）。
      // 不设预算时模型会一路写下去；调研里"大纲太长"与成绩负相关。
      targetChars: Number(options.options['target-chars'] || config.notes?.targetChars || 15000),
      // 写作单元数：决定"分几次模型调用写完"，不影响模块结构。
      // 1 = 一次写完（模型按模块标题分段），2/3 = 分几次；不传则按模块数各写一次。
      // 写作单元默认 1：一次调用写完整节课（模块结构由大纲决定，不受影响）。
      // 切成多个单元时每个单元都会各自"收尾"，实测一节课被切成 11 个单元后成品写到 3.3 万字；
      // 单次生成还有上下文连贯的好处。需要分次时用 --write-units 显式指定。
      writeUnits: Number(options.options['write-units'] || config.notes?.writeUnits || 1),
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

    // 成本窗口：DeepSeek 有峰谷计价，写笔记（全是模型调用）安排在低价时段。
    // 到点不能写时**顺延**而不是失败——这是计划内的等待，账本按窗口开始时间重试。
    if (!options.options['ignore-cost-window']) {
      const decision = getCourseLlmWindowDecision({
        schedule: normalizeCourseLlmSchedule({
          mode: config.llm?.mode || 'economy',
          peakWindows: config.llm?.peakWindows || undefined
        }, env),
        now: clockNow()
      })
      if (!decision.allowed) {
        const nextAt = decision.nextAllowedAt
        stderr(`当前处于高峰计价时段（${decision.activeWindow?.start}-${decision.activeWindow?.end} ${decision.timezone}），笔记写作顺延到 ${nextAt}`)
        const deferredStore = openStore(config.ledgerPath)
        try {
          const deferredTask = replayKey ? deferredStore.getTask(replayKey) : null
          if (deferredTask) {
            deferredStore.reportStage({
              id: deferredTask.id,
              stage: deferredTask.stage,
              message: '顺延到低价窗口',
              nextAttemptAt: nextAt
            })
          }
        } finally {
          deferredStore.close()
        }
        emit({
          course,
          lesson: lessonTitle,
          produced: false,
          deferred: true,
          reason: 'peak-price-window',
          nextAllowedAt: nextAt,
          nodeCount: 0,
          finalChars: 0
        }, options)
        return 0
      }
    }

    const store = openStore(config.ledgerPath)
    try {
      const task = replayKey ? claimForRun(store, replayKey, workerId) : null
      activeTask = task
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
        (payload => callCourseModel({ ...payload, config: { ...modelConfig, ...(payload.config || {}) }, onRetry: onModelRetry }))

      /**
       * 跨课次上下文：同一门课此前讲到哪。
       *
       * 从**已发布的成品笔记**（站点发布库）提炼，不额外花模型调用；只取本节课之前的课次。
       * 课上讲到一半的课次（还没发布）不会出现在这里——那正是它没进发布库的原因，
       * 不是缺陷：宁可少给依据，也不给一份与成品笔记不一致的"记忆"。
       */
      const courseContext = readCourseContext({
        courseName: course,
        lessonTitle,
        lessonDate: options.options['lesson-date'] || ''
      })
      if (courseContext.text) {
        stderr(`跨课次上下文：${courseContext.lessonCount} 节（${courseContext.chars} 字）`)
      }

      const result = await runLessonNotes({
        lesson,
        courseSpec,
        courseContext: courseContext.text,
        modelConfig,
        callModel,
        autoApproveOutline,
        // 默认不设步数上限：终止由状态机负责（每节点最多重写两次、终审修订预算、空闲即停）。
        maxSteps: options.options['max-steps'] ? Number(options.options['max-steps']) : undefined,
        reviewConcurrency: Number(options.options['review-concurrency'] || config.notes?.reviewConcurrency || 2),
        totalConcurrency: Number(options.options['concurrency'] || config.notes?.concurrency || 3),
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
          // 绑定字段与简报一起落盘：目录是共享的，同一门课几节课的 brief.json 会互相覆盖，
          // 发布时靠这几个字段认出"这份简报不是给这一篇的"（见 checkBriefBinding）。
          // 指纹用生成侧给的那一个（result.sourceChecksum），不是这里另算一个——
          // briefSourceChecksum 会做换行规范化，两边必须同一套算法。
          const boundMarkdown = fs.readFileSync(notePath, 'utf8')
          fs.writeFileSync(briefPath, `${JSON.stringify({
            schemaVersion: 1,
            course,
            lesson: lessonTitle,
            replayKey,
            sourceChecksum: brief.sourceChecksum,
            sourceChars: brief.sourceChars ?? boundMarkdown.length,
            generatedAt: clockNow().toISOString(),
            briefing: brief.briefing,
            keyPoints: brief.keyPoints,
            // 首页课次表那一列用的就是这两个：写简报的这一次调用顺手产出的，不额外花钱
            theme: brief.theme || '',
            keywords: brief.keywords || [],
            detail: brief.detail,
            trace: brief.trace
          }, null, 2)}\n`)
          stderr(`简报已生成（${brief.words} 字，${brief.keyPoints.length} 条要点，${(brief.keywords || []).length} 个关键词）`)
        } catch (error) {
          briefError = error instanceof Error ? error.message : String(error)
          stderr(`简报生成失败：${briefError}（笔记本身不受影响）`)
        }
      }

      // 篇幅如实核对（不做事后压缩——超了就说超了，让下一轮的要求更准）
      const targetChars = courseSpec.targetChars || 15000
      const overBudget = produced && summary0Chars(result) > Math.round(targetChars * 1.25)
      if (overBudget) {
        stderr(`警告：成品 ${summary0Chars(result)} 字，超过目标 ${targetChars} 字的 1.25 倍（不做事后压缩，如实记录）`)
      }

      const metaCommentary = result.lesson.finalNote?.assembly?.metaCommentary?.count || 0
      if (metaCommentary) {
        stderr(`警告：成品笔记里有 ${metaCommentary} 处"写作过程"的话（本节点/写作目标/待补写…），不该出现在交付物里`)
      }

      /**
       * 内容质量检查（Phase 5.2 A8）。
       *
       * 放在成稿之后、发布之前：分类漏抽/重复、表格少一列、同一节被拼两遍、正文被截断、
       * 待核标记没有出处或没有贯通到简报/一页纸/测验——这些都能在**发布前**用纯文本发现。
       * 两条纪律：
       *   · 只报告不改写：改内容要人点头；
       *   · **不进通知**：这是给作者看的，读者那条链路只发 course-note。
       * 想让它拦住发布就设 COURSE_NOTES_QUALITY_STRICT=1（默认只提醒）。
       */
      let quality = null
      if (produced) {
        quality = checkNoteQuality({
          markdown: result.lesson.finalNote.markdown,
          metadata: extractNoteMetadata(result.lesson.finalNote.markdown),
          artifacts: {
            简报: brief ? [brief.briefing, ...(brief.keyPoints || [])].join('\n') : '',
            一页纸: ''
          }
        })
        stderr(formatQualityReport(quality))
        if (quality.counts.error && String(env.COURSE_NOTES_QUALITY_STRICT || '') === '1') {
          throw new Error(`内容质量检查发现 ${quality.counts.error} 个错误（COURSE_NOTES_QUALITY_STRICT=1）：见上面的清单`)
        }
      }

      const summary = {
        course,
        lesson: lessonTitle,
        status: result.lesson.status,
        metaCommentary,
        targetChars,
        overBudget,
        stopReason: result.stopReason,
        idleReason: result.idleDetail?.reason || null,
        nodeCount: result.lesson.nodes.length,
        finalChars: result.lesson.finalNote?.markdown?.length || 0,
        steps: result.steps,
        autoApproveOutline,
        resumed: resume,
        maxSteps: options.options['max-steps'] ? Number(options.options['max-steps']) : null,
        brief: brief ? { path: briefPath, words: brief.words, keyPoints: brief.keyPoints.length } : null,
        briefError,
        // 质量检查结果进摘要（不进通知）：发布与日报都能引用它，作者也能事后查
        quality: quality ? { counts: quality.counts, findings: quality.findings } : null
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
  /**
   * 这一节课在账本里记下的排课时间（discover 写入的 tasks.starts_at_text，形如 "2026-05-27 13:00"）。
   *
   * 用途只有一个：课次标题里没有日期时（老的"第10-12节"就是这么命名的），
   * 拿它当 lessonDate 的第二来源。读不到不是错误——没有账本、没有这条任务都只是空串。
   */
  function ledgerStartsAtText(replayKey) {
    if (!replayKey) return ''
    let store = null
    try {
      store = openStore(config.ledgerPath)
      return String(store.getTask(replayKey)?.starts_at_text || '')
    } catch {
      return ''
    } finally {
      try { store?.close() } catch {}
    }
  }

  /**
   * 模型调用的重试要看得见。
   *
   * 限流与服务端抖动本来就该自动重试，但如果日志里什么都不说，运维只会看到"这一步变慢了"，
   * 却不知道是网络在抖、还是账号被限流——两者的处理方式完全不同。
   */
  const onModelRetry = info => stderr(
    `模型调用重试（${info.role} · ${info.reason}）：第 ${info.attempt}/${info.of} 次，等待 ${(info.delayMs / 1000).toFixed(1)}s`
  )

  /**
   * 从站点发布库提炼"同一门课此前讲到哪"。
   *
   * 读不到发布库（第一次跑、或站点还没建）不算错误：返回空上下文，流水线照常走——
   * 第一讲本来就没有"之前"。读得到时按课次日期只取本节之前的课次。
   */
  function readCourseContext({ courseName = '', lessonTitle = '', lessonDate = '' } = {}) {
    const libraryPath = path.join(path.resolve(config.scratchRoot, 'site'), 'library.json')
    try {
      if (!fs.existsSync(libraryPath)) return { text: '', chars: 0, lessonCount: 0, previous: null }
      const records = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
      if (!Array.isArray(records)) return { text: '', chars: 0, lessonCount: 0, previous: null }
      return buildCourseContext({ records, courseName, lessonTitle, lessonDate })
    } catch (error) {
      stderr(`跨课次上下文读取失败（不影响笔记）：${error instanceof Error ? error.message : String(error)}`)
      return { text: '', chars: 0, lessonCount: 0, previous: null }
    }
  }

  /**
   * 发布成功后清一次 CDN 缓存。
   *
   * 边缘缓存是这个站点的命脉（读者在国内，一天 TTL 让页面快得多），但"改完要等一天"
   * 不能接受。清不掉也只是晚一点生效：这里永远返回结果，不抛错。
   */
  async function purgeCache(options, { reason, files = [] }) {
    if (options.flags?.has('no-purge')) return { ok: false, skipped: 'flag' }
    const origin = options.options.origin || 'https://course.law-tech.dev'
    /**
     * 定向清理：只清这次真的写过的那些页面（含"干净链接"与 .html 两种缓存键）。
     * law-tech.dev 这个 zone 上还有别的服务，purge_everything 会把它们的缓存一起踢掉——
     * 为发一篇笔记顺手清空整个 zone 是不礼貌的。真要全清时用 --purge-all。
     */
    const everything = Boolean(options.flags?.has('purge-all'))
    const urls = everything ? [] : cacheUrlsFor(files, origin)
    // 用注入的 env（而不是 process.env）：测试与"从 env 文件读到的配置"都走同一条路径
    const result = await purgeCloudflareCache({ urls, everything, env, fetchImpl: injectedFetch })
    if (result.ok) {
      stderr(everything
        ? `已清空整个 CDN 缓存（${reason}）`
        : `已定向清除 ${result.purged} 个缓存 URL（${reason}，${result.batches} 批）`)
    } else if (result.skipped === 'no_token') stderr('没有 CLOUDFLARE_PURGE_TOKEN，跳过清缓存（改版后可能要等边缘 TTL 到期）')
    else if (result.skipped === 'no_urls') stderr(`没有可清的 URL（${reason}）——本次没有写出文件？`)
    else stderr(`清缓存失败（${reason}）：${result.error || result.status || '原因不明'}——页面本身已经写好，只是边缘要等 TTL 到期`)
    return result
  }

  /**
   * 一页纸摘要：把一节笔记压进一张 A4（复习时只看这一页）。
   *
   * 与 course brief 一样是「只重跑一步」的入口：笔记已经跑完、只想补一页纸时用它，
   * 不必把整条流水线再走一遍。输出 onepage.json，发布时会被带进站点。
   */
  /**
   * 建立/更新语义检索的向量索引（Phase 5.2 收尾）。
   *
   * 与检索侧同一套单元定义：**一小节一条向量**（标题 + 该节正文），键是 `<slug>#<sectionId>`，
   * 值里带**内容指纹**——指纹一致的小节直接复用旧向量，所以日常增量几乎不花钱。
   * 预算纪律照旧：必须给上限（--max-cost 或 COURSE_EMBED_MAX_COST_CNY），
   * 预计花费超上限在发请求之前就停；用量以接口返回的 usage 为准。
   * 索引写进站点目录（与 library.json 同处，原子替换）——检索读它，公开进程不加载任何机密。
   */
  async function embedRun(options) {
    const siteRoot = path.resolve(options.options['site-root'] || path.join(config.scratchRoot, 'site'))
    const libraryFile = path.resolve(options.options.library || path.join(siteRoot, 'library.json'))
    if (!fs.existsSync(libraryFile)) throw new Error(`找不到发布库 ${libraryFile}（先 course publish，或用 --library 指一份）`)
    const records = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
    const indexFile = path.resolve(options.options.out || path.join(siteRoot, 'embeddings.json'))
    const apiKey = String(env.COURSE_EMBED_API_KEY || env.DASHSCOPE_API_KEY || '').trim()
    const capCny = Number(options.options['max-cost'] || env.COURSE_EMBED_MAX_COST_CNY || 0)
    const model = String(options.options.model || env.COURSE_EMBED_MODEL || 'text-embedding-v3')
    if (!apiKey) throw new Error('向量化需要 API key：配 COURSE_EMBED_API_KEY 或 DASHSCOPE_API_KEY')
    if (!(capCny > 0)) throw new Error('必须给花费上限：--max-cost <元> 或 COURSE_EMBED_MAX_COST_CNY（预算纪律）')

    // ① 收集单元（与检索侧同一套：小节 = 标题 + ownBody）
    const units = []
    for (const record of records) {
      const markdown = String(record.markdown || '')
      if (!markdown.trim()) continue
      const bodies = new Map(splitSections(markdown).map(section => [section.id, String(section.ownBody || '').trim()]))
      const sections = Array.isArray(record.sections) && record.sections.length
        ? record.sections
        : [...bodies.keys()].map(id => ({ id, title: id, fingerprint: '' }))
      for (const section of sections) {
        const body = bodies.get(section.id) || ''
        if (!body) continue
        units.push({
          key: `${record.slug}#${section.id}`,
          fingerprint: String(section.fingerprint || ''),
          text: [section.title, body].filter(Boolean).join('\n').trim()
        })
      }
    }
    if (!units.length) throw new Error('发布库里没有任何可向量化的小节（先跑一次 course publish --rebuild --write-back 让记录带上小节索引）')

    // ② 增量：指纹一致的小节复用旧向量
    const existing = loadEmbeddingIndex(indexFile).index
    const items = {}
    const todo = []
    for (const unit of units) {
      const previous = existing?.items?.get(unit.key)
      if (previous && unit.fingerprint && previous.fingerprint === unit.fingerprint) {
        items[unit.key] = { fingerprint: unit.fingerprint, vector: previous.vector }
        continue
      }
      todo.push(unit)
    }

    // ③ 只对"新出现/改过"的小节花钱
    let stats = { tokens: 0, calls: 0, hits: 0, costCny: 0 }
    if (todo.length) {
      // 缓存文件名与 tools/semantic-eval.mjs 的默认值一致（embeddings-cache-<provider>.json）：
      // 实验跑过的文本，建索引时不必再花钱
      const cacheFile = String(options.options.cache || env.COURSE_EMBED_CACHE || path.join(config.scratchRoot, 'embeddings-cache-dashscope.json'))
      const result = await embedTexts({
        texts: todo.map(unit => unit.text),
        type: 'document',
        apiKey,
        model,
        cacheFile,
        capCny,
        onProgress: progress => stderr(`  向量化 ${progress.done}/${progress.total}（已花 ¥${progress.costCny.toFixed(4)}）`)
      })
      stats = result.stats
      todo.forEach((unit, index) => {
        items[unit.key] = { fingerprint: unit.fingerprint, vector: result.vectors[index] }
      })
    }

    const payload = {
      version: 1,
      provider: 'dashscope',
      model,
      dim: Object.values(items)[0]?.vector?.length || 0,
      createdAt: new Date().toISOString(),
      cost: { tokens: stats.tokens, calls: stats.calls, cacheHits: stats.hits, cny: Number(stats.costCny.toFixed(4)), capCny },
      counts: { units: units.length, reused: units.length - todo.length, embedded: todo.length },
      items
    }
    writeJsonAtomic(indexFile, payload)

    emit({
      indexFile,
      units: units.length,
      reused: units.length - todo.length,
      embedded: todo.length,
      dim: payload.dim,
      costCny: payload.cost.cny,
      capCny,
      library: libraryFile
    }, options)
    return 0
  }

  /**
   * 只报异常的对账（Phase 5.2 C2）。
   *
   * 把"需要人做的事"从几个地方收敛成一张清单：卡住/停下的任务、失败与过期的投递、
   * 与正文不同源的派生产物、缺课件的课次、余额偏低。**没有异常时一个字都不说**，
   * 退出码也是 0——定时任务的价值在于安静；有 blocking 时才返回 1 交给 cron 告警。
   * --notify 只在有异常时排一条通知（去重键按天+内容指纹，不刷屏）。
   */
  async function reconcileRun(options) {
    const siteRoot = path.resolve(options.options['site-root'] || path.join(config.scratchRoot, 'site'))
    const libraryFile = path.resolve(options.options.library || path.join(siteRoot, 'library.json'))
    const records = fs.existsSync(libraryFile) ? JSON.parse(fs.readFileSync(libraryFile, 'utf8')) : []

    const store = openStore(config.ledgerPath)
    let stuckTasks = []
    let failedDeliveries = []
    let stuckDeliveries = 0
    try {
      stuckTasks = store.listTasks({ limit: 500 }).filter(task => String(task.stage) === 'needs_attention')
      failedDeliveries = store.listDeliveries({ status: 'failed', limit: 50 })
      stuckDeliveries = store.countStuckDeliveries()
    } finally {
      store.close()
    }

    const dirs = []
    const walk = (dir, depth) => {
      if (depth > 3 || !fs.existsSync(dir)) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      let hasArtifact = false
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          if (entry.name === 'brief.json' || entry.name === 'onepage.json') hasArtifact = true
          continue
        }
        walk(path.join(dir, entry.name), depth + 1)
      }
      if (hasArtifact) dirs.push(dir)
    }
    walk(path.resolve(config.scratchRoot), 0)
    // 期望值用**规范化**指纹（与发布时的 checkBriefBinding / verifyDerived 同一套）
    const artifacts = scanArtifactInventory({
      dirs,
      records,
      integrationDir: path.join(config.scratchRoot, 'integrations'),
      checksumOf: record => markdownChecksum(record.markdown || '')
    })

    let missingMaterials = []
    try { missingMaterials = collectMissingMaterials({ courses: [], limit: 20 }) || [] } catch { missingMaterials = [] }

    const report = collectExceptions({ stuckTasks, failedDeliveries, stuckDeliveries, artifacts, missingMaterials })
    const text = formatExceptions(report)
    // 安静：没有异常就什么都不说（连"一切正常"都不说——那种话只会训练人不看）
    if (text) stderr(text)
    else stderr('没有需要处理的事。')

    let delivery = null
    if (!report.quiet && options.flags?.has('notify')) {
      const store2 = openStore(config.ledgerPath)
      try {
        delivery = store2.enqueueDelivery({
          dedupeKey: `reconcile:${dateKeyInTimeZone(new Date(), config.timeZone || 'Asia/Shanghai')}:${report.counts.blocking}:${report.counts.warning}`,
          purpose: 'reconcile',
          bodyText: text.slice(0, 1500),
          objectUrl: config.notify.publicUrl || 'https://course.law-tech.dev'
        })
      } finally {
        store2.close()
      }
    }

    emit({
      quiet: report.quiet,
      counts: report.counts,
      exceptions: report.exceptions,
      notified: delivery ? delivery.inserted : false
    }, options)
    return report.blocking ? 1 : 0
  }

  function integrationManifestPath(options = {}) {
    return path.resolve(options.options?.manifest || path.join(config.scratchRoot, 'integration-manifest.json'))
  }

  function readIntegrationManifest(file) {
    if (!fs.existsSync(file)) return emptyIntegrationManifest()
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`整合清单不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`)
    }
    return normalizeIntegrationManifest(raw)
  }

  function writeIntegrationPlan(plan, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true })
    const base = `${slugify(plan.course, 'course')}-${slugify(plan.topic, 'topic')}`
    const markdownFile = path.join(outputDir, `${base}.md`)
    const planFile = path.join(outputDir, `${base}.json`)
    writeJsonAtomic(planFile, plan)
    fs.writeFileSync(markdownFile, renderIntegrationMarkdown(plan))
    const problems = plan.findings || []
    const errors = problems.filter(item => item.level === 'error')
    return { markdownFile, planFile, problems, errors }
  }

  function buildConfiguredIntegration({ records, definition, outputDir }) {
    const plan = buildIntegrationPlan({
      records,
      course: definition.course,
      lessons: definition.lessons,
      topic: definition.topic,
      generatedAt: clockNow().toISOString()
    })
    const written = writeIntegrationPlan(plan, outputDir)
    return {
      id: definition.id,
      course: plan.course,
      topic: plan.topic,
      lessons: plan.lessons.map(item => item.lessonTitle),
      sourceProblems: written.problems.length,
      errors: written.errors.length,
      markdownFile: written.markdownFile,
      planFile: written.planFile
    }
  }

  /**
   * 正文变化以后，只重建“明确包含这一课次”的已配置整合。
   * 这是纯规则抽取，不调模型、不花钱；失败不回滚已经正确发布的单课正文，
   * 而是把错误返回给发布结果，reconcile / artifacts 仍会把旧整合标 stale。
   */
  function refreshConfiguredIntegrations({ records, course, lessonTitle } = {}) {
    const manifestFile = path.join(config.scratchRoot, 'integration-manifest.json')
    if (!fs.existsSync(manifestFile)) return { manifestFile, configured: false, matched: 0, refreshed: [], errors: [] }
    const manifest = readIntegrationManifest(manifestFile)
    const definitions = selectConfiguredIntegrations(manifest, { course, lesson: lessonTitle })
    const outputDir = path.join(config.scratchRoot, 'integrations')
    const refreshed = []
    const errors = []
    for (const definition of definitions) {
      try {
        refreshed.push(buildConfiguredIntegration({ records, definition, outputDir }))
      } catch (error) {
        errors.push({
          id: definition.id,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return { manifestFile, configured: true, matched: definitions.length, refreshed, errors }
  }

  /**
   * 工件依赖失效记录（Phase 5.2 C1）。
   *
   * 把 scratch 目录下所有派生产物（brief.json / onepage.json / 章级整合）与**当前发布库**
   * 比一遍：新鲜 / 失效 / 未绑定 / 孤立。只报告不改写——重做要么花钱（模型）、要么要人定范围。
   */
  async function artifactsRun(options) {
    const siteRoot = path.resolve(options.options['site-root'] || path.join(config.scratchRoot, 'site'))
    const libraryFile = path.resolve(options.options.library || path.join(siteRoot, 'library.json'))
    if (!fs.existsSync(libraryFile)) throw new Error(`找不到发布库 ${libraryFile}（先 course publish，或用 --library 指一份）`)
    const records = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))

    // 产物散在各课次的输出目录里（course notes --output-dir 的产物），所以按名字找、不猜路径
    const dirs = []
    const walk = (dir, depth) => {
      if (depth > 3 || !fs.existsSync(dir)) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      let hasArtifact = false
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          if (entry.name === 'brief.json' || entry.name === 'onepage.json') hasArtifact = true
          continue
        }
        walk(path.join(dir, entry.name), depth + 1)
      }
      if (hasArtifact) dirs.push(dir)
    }
    walk(path.resolve(config.scratchRoot), 0)

    const integrationDir = path.resolve(options.options['integrations'] || path.join(config.scratchRoot, 'integrations'))
    const inventory = scanArtifactInventory({ dirs, records, integrationDir, checksumOf: record => markdownChecksum(record.markdown || '') })
    const report = formatInventory(inventory)
    stderr(report)
    emit({
      dirs: dirs.length,
      integrationDir,
      total: inventory.total,
      counts: inventory.counts,
      stale: inventory.items.filter(item => item.status === 'stale').map(item => ({ kind: item.kind, courseName: item.courseName, lessonTitle: item.lessonTitle, staleLessons: item.staleLessons || [] })),
      orphan: inventory.items.filter(item => item.status === 'orphan').map(item => ({ kind: item.kind, lessonTitle: item.lessonTitle }))
    }, options)
    return 0
  }

  /**
   * 章级整合（Phase 5.2 B2 原型）。
   *
   * 读**发布库**（不碰账本、不发通知、不花钱）：跨课次的概念对照、反复出现的问题、
   * 论证推进、待核继承、以及每一行的出处。默认只做确定性抽取（可复现、可单测）；
   * --live（让模型补连接性文字）还没接——那需要预算与一次单独的评审，别让它悄悄花钱。
   */
  async function integrateRun(options) {
    const siteRoot = path.resolve(options.options['site-root'] || path.join(config.scratchRoot, 'site'))
    const libraryFile = path.resolve(options.options.library || path.join(siteRoot, 'library.json'))
    if (!fs.existsSync(libraryFile)) throw new Error(`找不到发布库 ${libraryFile}（先 course publish，或用 --library 指一份）`)
    const records = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
    const outputDir = path.resolve(options.options['out-dir'] || path.join(config.scratchRoot, 'integrations'))
    const manifestFile = integrationManifestPath(options)

    if (options.flags?.has('live')) {
      throw new Error('--live 还没接：章级整合目前只做确定性抽取（结构 + 出处）；让模型补写正文需要单独评审与预算，见 docs/14')
    }

    /**
     * --configured：按持久化清单重建。
     * 可以 --id 精确跑一个，也可以不给 id 全部重建；范围来自 manifest，不重新猜课次。
     */
    if (options.flags?.has('configured')) {
      const manifest = readIntegrationManifest(manifestFile)
      const definitions = selectConfiguredIntegrations(manifest, {
        id: options.options.id || '',
        course: options.options.course || ''
      })
      if (!definitions.length) {
        throw new Error(
          options.options.id
            ? `整合清单里找不到启用的 id=${options.options.id}`
            : `整合清单没有匹配项：${manifestFile}`
        )
      }
      const results = []
      let errors = 0
      for (const definition of definitions) {
        try {
          const result = buildConfiguredIntegration({ records, definition, outputDir })
          results.push(result)
          errors += result.errors
        } catch (error) {
          errors += 1
          results.push({ id: definition.id, course: definition.course, topic: definition.topic, error: error instanceof Error ? error.message : String(error) })
        }
      }
      emit({
        configured: true,
        manifestFile,
        outputDir,
        count: results.length,
        errors,
        results
      }, options)
      return errors ? 1 : 0
    }

    const course = requireOption(options.options, 'course', 'integrate')
    const lessons = String(options.options.lessons || '').split(',').map(item => item.trim()).filter(Boolean)
    if (options.flags?.has('save') && !String(options.options.topic || '').trim()) {
      throw new Error('把整合写入长期清单时必须显式给 --topic：主题名是这组课次的稳定身份，不能用默认占位文字')
    }
    const plan = buildIntegrationPlan({
      records,
      course,
      lessons,
      topic: options.options.topic || '',
      generatedAt: clockNow().toISOString()
    })
    const written = writeIntegrationPlan(plan, outputDir)

    let saved = null
    if (options.flags?.has('save')) {
      const manifest = readIntegrationManifest(manifestFile)
      const next = upsertIntegrationDefinition(manifest, {
        id: options.options.id || '',
        course: plan.course,
        topic: plan.topic,
        // 永远保存本次实际解析到的明确课次，不保存“整门课”这种会随时间变宽的范围。
        lessons: plan.lessons.map(item => item.lessonTitle),
        enabled: true
      })
      writeJsonAtomic(manifestFile, next)
      saved = next.integrations.find(item => item.id === (options.options.id || `${plan.course}::${plan.topic}`)) || null
    }

    if (written.errors.length) stderr(`出处检查：${written.errors.length} 行没有出处（应当为 0）——${written.errors[0].message}`)
    emit({
      course: plan.course,
      topic: plan.topic,
      lessons: plan.lessons.map(item => ({ lessonTitle: item.lessonTitle, lessonDate: item.lessonDate, contentFingerprint: item.contentFingerprint })),
      concepts: { total: plan.concepts.length, crossLesson: plan.concepts.filter(item => item.rows.length >= 2).length },
      issues: plan.issues.length,
      openMarkers: plan.openMarkers.length,
      sourceProblems: written.problems.length,
      markdownFile: written.markdownFile,
      planFile: written.planFile,
      manifest: saved ? { file: manifestFile, id: saved.id, lessons: saved.lessons } : null
    }, options)
    return written.errors.length ? 1 : 0
  }

  /**
   * course sourcemap：给**已经发布**的一页纸补来源映射。
   *
   * 三条自律（都来自任务书）：
   *   · 只补映射：原笔记与现有一页纸正文一个字都不动（这里根本不写它们）；
   *   · 免费路径优先：只认"某句话在这一节正文里逐字出现、而且这一节明显领先"的对照，
   *     概括改写一律不猜；要判断改写需要模型，那属于按课次的映射专用调用，必须另有预算；
   *   · 覆盖率与正确率分开报：定位到几块、剩几块退回整篇入口都打出来，
   *     并且把每一对"块 ↔ 小节 + 摘录"列出来供人工逐项核对（--show）。
   */
  async function sourceMapRun(options) {
    const useModel = options.flags?.has('model') === true
    const capCny = Number(options.options['max-cost-cny'] || env.COURSE_SOURCEMAP_MAX_COST_CNY || 0)
    // 预算纪律与向量化那条命令一致：走模型就必须先给上限，没上限不开跑
    if (useModel && !(capCny > 0)) {
      throw new Error('走模型必须给花费上限：--max-cost-cny <元>（预算纪律：没有上限就不开跑）')
    }
    const siteRoot = path.resolve(options.options['site-root'] || path.join(config.scratchRoot, 'site'))
    const libraryFile = path.resolve(options.options.library || path.join(siteRoot, 'library.json'))
    if (!fs.existsSync(libraryFile)) throw new Error(`找不到发布库 ${libraryFile}`)
    const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
    const wantedCourse = String(options.options.course || '').trim()
    const wantedLesson = String(options.options.lesson || '').trim()
    const write = options.flags?.has('write') === true
    const show = options.flags?.has('show') === true

    const modelConfig = {
      apiKey: config.ai.apiKey || 'unset',
      baseUrl: config.ai.baseUrl,
      provider: config.ai.provider,
      source: 'environment',
      models: config.ai.models
    }
    const callForMap = injectedCallModel ||
      (payload => callCourseModel({ ...payload, config: { ...modelConfig, ...(payload.config || {}) }, onRetry: onModelRetry }))
    const pricing = resolvePricing(env)
    const rows = []
    let spentCny = 0
    let costStopped = false
    let next = library
    for (const record of library) {
      if (wantedCourse && !String(record.courseName || '').includes(wantedCourse)) continue
      if (wantedLesson && !String(record.lessonTitle || '').includes(wantedLesson)) continue
      if (!record.onepage || !record.onepage.markdown) continue
      // 正文从站点目录里的 .md 读（发布时同时写出的那一份），不必回 scratch 找
      const noteFile = path.resolve(siteRoot, markdownPath(record.slug))
      if (!fs.existsSync(noteFile)) {
        rows.push({ slug: record.slug, error: `找不到正文 ${noteFile}` })
        continue
      }
      const noteMarkdown = fs.readFileSync(noteFile, 'utf8')
      /**
       * 先跑**免费路径**（逐字引用 / 块里点了节名）。它便宜且只在有硬证据时才认，
       * 所以永远先跑；--model 只用来补它补不上的那些块。
       */
      const freeMap = buildSourceMap({
        slug: record.slug,
        noteMarkdown,
        onepageMarkdown: record.onepage.markdown
      })
      const covered = new Set(freeMap.entries.map(entry => entry.block))
      const sectionList = sectionTexts(noteMarkdown).map(section => ({ id: section.id, title: section.title }))
      let modelEntries = []
      let usage = null
      if (useModel && !costStopped) {
        const pending = onepageBlocks(record.onepage.markdown)
          .filter(block => block.kind !== 'heading' && !covered.has(block.id))
        /**
         * **分批**：一次让它标 12 块左右。
         *
         * 为什么：一节课 40—50 块时，一次回答的输出太长会被截断（回包解析不出来），
         * 那一次调用的钱就白花了（实测 3 个课次踩到）。分批之后每批的输出很短，
         * 截断风险小；某一批失败只重试那一批，不影响已经拿到的部分。
         */
        const chunkSize = Math.max(1, Number(options.options['chunk'] || 12))
        let lastChunkCny = 0
        for (let start = 0; start < pending.length; start += chunkSize) {
          /**
           * **开跑前预扣额度**：上限要真的挡得住，不能只在事后发现超了。
           * 单批的成本事先不知道（输出 token 波动很大），所以按"上一批实际花费 × 1.5"预留，
           * 第一批用 ¥0.03 兜底。预留之后放不下就不开这一批——宁可少标几块，也不越你给的上限。
           * （这一步是因为实测两次都越线才补的：09-07 花了 ¥0.108 而上限是 ¥0.06。）
           */
          const reserve = Math.max(lastChunkCny * 1.5, 0.03)
          if (useModel && spentCny + reserve > capCny) {
            costStopped = true
            stderr(`预算不足：已花 ¥${spentCny.toFixed(4)}，下一批预估 ¥${reserve.toFixed(4)}，上限 ¥${capCny} —— 停下，剩余块保持未定位`)
            break
          }
          const chunk = pending.slice(start, start + chunkSize)
          const beforeChunkCny = spentCny
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            let result = null
            try {
              result = await callForMap({
                config: modelConfig,
                role: 'sourcemap',
                prompt: buildPrompt({
                  role: 'sourcemap',
                  courseSpec: { courseName: record.courseName },
                  lessonBlueprint: { title: record.lessonTitle },
                  sourceText: buildSourceMapSource({
                    courseName: record.courseName,
                    lessonTitle: record.lessonTitle,
                    noteMarkdown,
                    onepageMarkdown: record.onepage.markdown,
                    sections: sectionList,
                    blocks: chunk.map(block => ({ label: plainBlockText(block.text).slice(0, 40) }))
                  }),
                  schema: SOURCE_MAP_SCHEMA
                })
              })
            } catch (error) {
              // 单批失败不拖垮整节课：记一笔，继续下一批（已经拿到的条目照旧保留）
              stderr(`  来源映射这一批失败（${record.slug} 第 ${Math.floor(start / chunkSize) + 1} 批，第 ${attempt} 次）：${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            const chunkUsage = result?.trace?.usage || null
            if (chunkUsage) {
              usage = chunkUsage
              spentCny += noteCostCny({
                inputTokens: chunkUsage.prompt_tokens ?? chunkUsage.input_tokens ?? 0,
                cachedTokens: chunkUsage.prompt_cache_hit_tokens ?? chunkUsage.prompt_cache_tokens ?? 0,
                outputTokens: chunkUsage.completion_tokens ?? chunkUsage.output_tokens ?? 0,
                pricing
              })
            }
            // 与"新一页纸"那条路同一套：块提示 → 块 ID，筛掉不存在的小节，再交给逐字核对
            const stamped = stampSourceMap(
              normalizeSourceMapDraft(result?.parsed?.entries || result?.parsed?.sourceMap || []),
              { slug: record.slug, noteMarkdown, onepageMarkdown: record.onepage.markdown }
            )
            const ids = new Set(chunk.map(block => block.id))
            const kept = (stamped ? stamped.entries : []).filter(entry => ids.has(entry.block))
            lastChunkCny = spentCny - beforeChunkCny
            if (kept.length) {
              modelEntries.push(...kept)
              break
            }
          }
          if (useModel && spentCny >= capCny) break
        }
      }
      /**
       * 已有的映射要**留住**。
       *
       * 踩过的坑：单独跑一次免费路径（不带 --model）时，这里只装了免费路径的结果，
       * 写回就把上一次模型标好的条目整份冲掉了——花了钱的成果被一次"只跑免费路径"抹掉。
       * 现在的规矩：既有条目按块保留，块还在、来源还在就继续用；新算出来的覆盖同块的新结果。
       */
      const previousEntries = Array.isArray(record.onepage?.sourceMap?.entries) ? record.onepage.sourceMap.entries : []
      const freshBlocks = new Set([...freeMap.entries, ...modelEntries].map(entry => entry.block))
      const carried = previousEntries.filter(entry => !freshBlocks.has(entry.block))
      const built = {
        ...freeMap,
        entries: [...carried, ...freeMap.entries, ...modelEntries],
        // 来源如实记：这一轮新标的算模型；这一轮没重算、但从上一版留下来的，保留它原来的来源标记
        generatedBy: modelEntries.length
          ? 'lexical-overlap+model'
          : (carried.length ? (record.onepage.sourceMap.generatedBy || 'lexical-overlap+model') : freeMap.generatedBy)
      }
      void usage
      const sectionsWithBody = sectionTexts(noteMarkdown)
      const verified = verifySourceMap(built, {
        slug: record.slug,
        noteMarkdown,
        onepageMarkdown: record.onepage.markdown,
        sections: sectionsWithBody
      })
      const stats = sourceMapStats(verified)
      rows.push({
        slug: record.slug,
        courseName: record.courseName,
        lessonTitle: record.lessonTitle,
        ...stats,
        model: modelEntries.length,
        usage: usage ? { input: usage.prompt_tokens ?? usage.input_tokens ?? null, output: usage.completion_tokens ?? usage.output_tokens ?? null } : null,
        spentCny: Number(spentCny.toFixed(4)),
        entries: verified.entries.map(entry => ({
          block: entry.block,
          label: entry.label,
          sections: entry.sections.map(section => ({ id: section.id, title: section.title, quote: section.quote, match: section.match || 'quote' }))
        }))
      })
      // 预算纪律：超了立刻停，后面的课次一课都不跑（宁可少做，也不越过你给的上限）
      if (useModel && spentCny >= capCny) {
        costStopped = true
        stderr(`已达花费上限 ¥${capCny}（实际 ¥${spentCny.toFixed(4)}），剩余课次不再调用模型`)
      }
      if (write && verified.entries.length) {
        next = next.map(item => item.slug === record.slug
          ? {
            ...item,
            onepage: {
              ...item.onepage,
              sourceMap: {
                version: SOURCE_MAP_VERSION,
                note: { slug: record.slug, checksum: markdownChecksum(noteMarkdown) },
                onepageChecksum: markdownChecksum(item.onepage.markdown),
                // 记清楚这一份是怎么来的：免费路径、模型，还是两者相加
                generatedBy: built.generatedBy || 'lexical-overlap',
                entries: verified.entries
              }
            }
          }
          : item)
      }
    }

    if (write && next !== library) {
      writeJsonAtomic(libraryFile, next)
      stderr(`已写回 ${rows.filter(row => !row.error && row.located).length} 篇的来源映射（正文与一页纸未改动）`)
      stderr('页面要重新生成才会出现"看原文"：course publish --rebuild')
    }
    emit({
      library: libraryFile,
      written: write && next !== library,
      lessons: rows.length,
      located: rows.reduce((sum, row) => sum + (row.located || 0), 0),
      unmapped: rows.reduce((sum, row) => sum + (row.unmapped || 0), 0),
      model: useModel,
      costStopped,
      spentCny: Number(spentCny.toFixed(4)),
      capCny: capCny || null,
      rows: show ? rows : rows.map(row => ({
        slug: row.slug, located: row.located, unmapped: row.unmapped, error: row.error
      }))
    }, options)
    return 0
  }

  async function onepageRun(options) {
    const from = path.resolve(requireOption(options.options, 'from', 'onepage'))
    const course = requireOption(options.options, 'course', 'onepage')
    const lesson = requireOption(options.options, 'lesson', 'onepage')
    const lessonFile = path.join(from, `${safeFileName(lesson)}.md`)
    const notePath = fs.existsSync(from) && fs.statSync(from).isFile()
      ? from
      : (fs.existsSync(lessonFile) ? lessonFile : path.join(from, 'final-note.md'))
    if (!fs.existsSync(notePath)) throw new Error(`找不到笔记正文：${notePath}`)
    const markdown = fs.readFileSync(notePath, 'utf8')

    const modelConfig = {
      apiKey: config.ai.apiKey || 'unset',
      baseUrl: config.ai.baseUrl,
      provider: config.ai.provider,
      source: 'environment',
      models: config.ai.models
    }
    const callModel = injectedCallModel ||
      (payload => callCourseModel({ ...payload, config: { ...modelConfig, ...(payload.config || {}) }, onRetry: onModelRetry }))

    const result = await generateOnepage({
      markdown,
      courseName: course,
      lessonTitle: lesson,
      courseSpec: { courseName: course },
      // 来源映射只许从这些小节里挑（模型不许自己编 id、更不许自己拼地址）
      sections: sectionTexts(markdown).map(section => ({ id: section.id, title: section.title })),
      callModel,
      modelConfig
    })
    const slug = noteSlug({ courseName: course, lessonTitle: lesson })
    const sourceMap = stampSourceMap(result.sourceMap, { slug, noteMarkdown: markdown, onepageMarkdown: result.markdown })
    const outDir = path.resolve(options.options.out || path.dirname(notePath))
    fs.mkdirSync(outDir, { recursive: true })
    const onepagePath = path.join(outDir, 'onepage.json')
    // 派生物与源正文的绑定：publish 会用这四项校验，对不上就不挂它（见 derived.mjs）
    fs.writeFileSync(onepagePath, `${JSON.stringify({
      schemaVersion: 1,
      ...derivedBinding({
        markdown,
        courseName: course,
        lessonTitle: lesson,
        replayKey: options.options['replay-key'] || '',
        generatedAt: clockNow().toISOString()
      }),
      title: result.title,
      outline: result.outline,
      markdown: result.markdown,
      chars: result.chars,
      // 来源映射：模型只给"哪一块 → 哪一节 + 摘录"，块 ID 与指纹由程序算
      ...(sourceMap ? { sourceMap } : {}),
      trace: result.trace
    }, null, 2)}\n`)
    emit({
      course,
      lesson,
      onepagePath,
      title: result.title,
      chars: result.chars,
      lists: result.lists,
      tables: result.tables,
      sourceMap: sourceMap ? { entries: sourceMap.entries.length } : { entries: 0 },
      overBudget: result.chars > ONEPAGE_TARGET_CHARS,
      usage: result.trace?.usage || null
    }, options)
    return 0
  }

  /**
   * 简报（含关键词）单独重跑。
   *
   * 为什么需要它：简报这一步的产物后来多了一列「关键词」，而笔记跑完后的中间状态通常
   * 已经被清理掉了。为了补一列关键词把笔记流水线整个重跑一遍是几十次模型调用；
   * 这里只重跑简报这一步——读成品笔记的小节标题与开头，输出几百字，一节课一次调用。
   */
  async function briefRun(options) {
    const from = path.resolve(requireOption(options.options, 'from', 'brief'))
    const course = requireOption(options.options, 'course', 'brief')
    const lesson = requireOption(options.options, 'lesson', 'brief')
    const lessonFile = path.join(from, `${safeFileName(lesson)}.md`)
    const notePath = fs.existsSync(from) && fs.statSync(from).isFile()
      ? from
      : (fs.existsSync(lessonFile) ? lessonFile : path.join(from, 'final-note.md'))
    if (!fs.existsSync(notePath)) throw new Error(`找不到笔记正文：${notePath}（--from 传笔记文件或它所在的目录）`)
    const markdown = fs.readFileSync(notePath, 'utf8')

    const modelConfig = {
      apiKey: config.ai.apiKey || 'unset',
      baseUrl: config.ai.baseUrl,
      provider: config.ai.provider,
      source: 'environment',
      models: config.ai.models
    }
    const callModel = injectedCallModel ||
      (payload => callCourseModel({ ...payload, config: { ...modelConfig, ...(payload.config || {}) }, onRetry: onModelRetry }))

    const result = await generateBriefFromMarkdown({
      markdown,
      courseName: course,
      lessonTitle: lesson,
      courseSpec: { courseName: course, teacher: options.options.teacher || '' },
      callModel,
      modelConfig
    })
    const outDir = path.resolve(options.options.out || path.dirname(notePath))
    fs.mkdirSync(outDir, { recursive: true })
    const briefPath = path.join(outDir, 'brief.json')
    const previous = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : {}
    fs.writeFileSync(briefPath, `${JSON.stringify({
      ...previous,
      schemaVersion: 1,
      // 绑定字段：course / lesson / 来源指纹（生成侧算好的那一个）+ 来源字数。
      // replayKey 没传时沿用上一次文件里的——缺了它不算冲突，真正的兜底是指纹。
      course,
      lesson,
      replayKey: options.options['replay-key'] || previous.replayKey || '',
      sourceChecksum: result.sourceChecksum,
      sourceChars: result.sourceChars ?? markdown.length,
      generatedAt: clockNow().toISOString(),
      briefing: result.briefing,
      keyPoints: result.keyPoints,
      // theme 曾经只写进了 stdout 摘要、没落盘：首页那一列于是永远空着
      theme: result.theme,
      keywords: result.keywords,
      detail: result.detail,
      trace: result.trace
    }, null, 2)}\n`)
    emit({
      course,
      lesson,
      note: notePath,
      briefPath,
      words: result.words,
      keyPoints: result.keyPoints.length,
      theme: result.theme,
      keywords: result.keywords,
      usage: result.trace?.usage || null
    }, options)
    return 0
  }

  /**
 * 给来源映射盖章：块提示 → 块 ID，并记下"这一份映射是对哪一版正文、哪一版一页纸做的"。
 *
 * 解析不出来的条目直接丢掉——模型给的块提示定位不到唯一块时，宁可没有这条映射，
 * 也不许指到别处去。返回 null 表示"这一份没有可用映射"。
 */
function stampSourceMap(draftEntries, { slug = '', noteMarkdown = '', onepageMarkdown = '' } = {}) {
  const resolved = resolveSourceMapEntries(draftEntries, onepageMarkdown)
  if (!resolved.length) return null
  /**
   * 顺手把"这一篇里根本没有的小节"筛掉。
   *
   * 模型只能从提示词给的清单里挑，但它仍可能编一个 id（实测会）。这一层筛完，落到磁盘上的
   * 映射至少指向真实存在的小节；"摘录是否真的在这一节里"由发布链路逐字核对（见下）。
   */
  const validIds = new Set(sectionTexts(noteMarkdown).map(section => section.id))
  const entries = resolved
    .map(entry => ({
      block: entry.block,
      label: entry.label,
      sections: entry.sections.filter(link => validIds.has(link.id))
        // 这一档的来源是**模型挑的**（摘录仍由发布链路逐字核对）：标注成 model，
        // 与免费路径的 quote/title 分开报，别把两种证据强度混成一个正确率
        .map(link => ({ id: link.id, title: link.title, quote: link.quote, match: 'model' }))
    }))
    .filter(entry => entry.sections.length)
  if (!entries.length) return null
  return {
    version: SOURCE_MAP_VERSION,
    note: { slug, checksum: markdownChecksum(noteMarkdown) },
    onepageChecksum: markdownChecksum(onepageMarkdown),
    generatedBy: 'model',
    entries
  }
}

/**
 * 全量核对（只有这里同时握着正文、小节切法与一页纸）。
 *
 * 核对的是四件事：身份、版本、小节存在、**摘录确实逐字出现在那一节里**。
 * 前三件只证明链接有效，第四件才是"这一节真的支持这个要点"的最低证据。
 * 核对不过的条目丢掉，整份失效（正文或一页纸改过）时一条都不留。
 */
function verifyRecordSourceMap(sourceMap, { slug = '', noteMarkdown = '', onepageMarkdown = '' } = {}) {
  if (!sourceMap || !Array.isArray(sourceMap.entries) || !sourceMap.entries.length) return { sourceMap: null, report: null }
  const verified = verifySourceMap(sourceMap, {
    slug,
    noteMarkdown,
    onepageMarkdown,
    sections: sectionTexts(noteMarkdown)
  })
  const stats = sourceMapStats(verified)
  const report = { ...stats, bound: verified.bound, problems: verified.problems.slice(0, 6) }
  if (!verified.entries.length) return { sourceMap: null, report }
  return {
    sourceMap: {
      version: SOURCE_MAP_VERSION,
      note: { slug, checksum: markdownChecksum(noteMarkdown) },
      onepageChecksum: markdownChecksum(onepageMarkdown),
      generatedBy: sourceMap.generatedBy || 'model',
      entries: verified.entries
    },
    report
  }
}


  /**
   * 构建一份完整站点快照并原子切到它。
   *
   * 只在 siteRoot 已经是本项目管理的 symlink（或全新不存在）时使用；旧式实体目录继续走
   * 兼容路径，必须显式 --migrate-site-root 才切换，避免一次普通发布偷偷改部署拓扑。
   */
  function publishViaRelease({ siteRoot, records, expectedRevision = '', origin = '', carryEmbeddings = false } = {}) {
    const transaction = beginSiteRelease({ siteRoot, now: clockNow() })
    let sealed = ''
    try {
      const site = writeSite({
        records,
        outputDir: transaction.stagingDir,
        siteOrigin: origin || 'https://course.law-tech.dev',
        docs: readPublicDocs()
      })
      writeJsonAtomic(path.join(transaction.stagingDir, 'library.json'), records)
      if (carryEmbeddings && fs.existsSync(siteRoot)) {
        copyReleaseFileIfPresent({ fromRoot: siteRoot, toRoot: transaction.stagingDir, name: 'embeddings.json' })
      }
      const validation = validateSiteRelease(transaction.stagingDir)

      // 最后一次检查必须发生在切换指针之前：读库后有人发布过，就丢掉这份快照重跑，
      // 不能把别人的新版本整个切回去。
      const revisionCheck = checkRevisionUnchanged({
        file: path.join(siteRoot, 'library.json'),
        expected: expectedRevision
      })
      if (!revisionCheck.ok) throw new Error(revisionCheck.message)

      sealed = sealSiteRelease({ siteRoot, stagingDir: transaction.stagingDir, now: clockNow() })
      const promoted = promoteSiteRelease({ siteRoot, releaseDir: sealed })
      return {
        site: { ...site, outputDir: siteRoot, releaseDir: sealed },
        release: { current: sealed, previous: promoted.previous, validation }
      }
    } catch (error) {
      // seal 之前删 staging；seal 之后但切换失败时删未上线 release。已经成功切换后不会进这里。
      if (sealed) fs.rmSync(sealed, { recursive: true, force: true })
      else discardSiteRelease(transaction.stagingDir)
      throw error
    }
  }

  function usesAtomicSiteReleases(siteRoot) {
    const state = inspectSiteRoot(siteRoot)
    return state.kind === 'missing' || (state.kind === 'symlink' && state.managed)
  }
  async function publish(options) {
    const siteRoot = path.resolve(options.options.out || path.join(config.scratchRoot, 'site'))
    const libraryForRebuild = path.join(siteRoot, 'library.json')

    /**
     * 一次性迁移旧部署：实体 site/ → site.releases/legacy-*，site 本身改成 symlink。
     * 这一步有一个无法规避的“目录改成链接”瞬间，所以不允许普通 publish 偷偷做；
     * 生产上先停 public/admin 两个站点进程，再显式 --yes。
     */
    if (options.flags?.has('rollback-site')) {
      if (!options.flags?.has('yes')) {
        throw new Error('--rollback-site 会切换正式内容版本；确认后加 --yes')
      }
      const lock = acquirePublishLock({
        lockPath: publishLockPath(siteRoot),
        info: { kind: 'rollback-site' },
        warnings: line => stderr(line)
      })
      if (!lock.ok) throw new Error(lock.message)
      try {
        const current = inspectSiteRoot(siteRoot)
        const previous = previousSiteRelease(siteRoot)
        if (!previous) throw new Error('没有可回滚的上一份内容 release')
        const validation = validateSiteRelease(previous.dir)
        const files = [...new Set([
          ...(current.target ? listReleaseFiles(current.target) : []),
          ...listReleaseFiles(previous.dir)
        ])]
        const switched = promoteSiteRelease({ siteRoot, releaseDir: previous.dir })
        const purge = await purgeCache(options, { reason: `内容回滚到 ${previous.name}`, files })
        emit({
          rolledBack: true,
          siteRoot,
          from: switched.previous,
          to: switched.releaseDir,
          validatedNotes: validation.notes,
          cachePurged: purge.ok === true,
          cache: purge
        }, options)
        return 0
      } finally {
        lock.release()
      }
    }

    if (options.flags?.has('migrate-site-root')) {
      if (!options.flags?.has('yes')) {
        throw new Error(
          '--migrate-site-root 会改变站点目录拓扑；请先停 course-site/course-admin 两个服务，确认后加 --yes'
        )
      }
      const lock = acquirePublishLock({
        lockPath: publishLockPath(siteRoot),
        info: { kind: 'migrate-site-root' },
        warnings: line => stderr(line)
      })
      if (!lock.ok) throw new Error(lock.message)
      try {
        const result = migrateLegacySiteRoot({ siteRoot, now: clockNow() })
        emit({
          migrated: result.migrated,
          alreadyManaged: result.alreadyManaged,
          siteRoot: result.live,
          releaseDir: result.releaseDir,
          next: result.migrated
            ? '迁移完成；现在可重新启动 course-site/course-admin。此后的 publish 会先构建完整快照、校验，再原子切换。'
            : '已经是 release 模式，无需重复迁移。'
        }, options)
        return 0
      } finally {
        lock.release()
      }
    }

    /**
     * 发布互斥（见 publish-guard.mjs 的说明）：两个发布同时跑会互相覆盖——
     * 后写的那个把先写的整条记录从发布库里抹掉，站点上少一整节课且没有报错。
     * --rebuild 同样持锁：它重写整个 site 目录，与正常发布并行会把产物写花。
     */
    /**
     * 便宜的输入检查放在取锁之前：参数就不对的话，不该建目录、也不该留下一把锁。
     * （取锁会 mkdir 出站点目录的父目录——在只读环境或路径写错时那会变成一句
     * "EPERM: mkdir …" 而不是"找不到 notes-run-summary.json"，让人查错方向。）
     */
    if (options.flags?.has('rebuild')) {
      if (!fs.existsSync(libraryForRebuild)) throw new Error(`找不到发布库 ${libraryForRebuild}；先发布过至少一篇笔记再 --rebuild`)
    } else {
      const checkFrom = path.resolve(requireOption(options.options, 'from', 'publish'))
      if (!fs.existsSync(path.join(checkFrom, 'notes-run-summary.json'))) {
        throw new Error(`找不到 ${path.join(checkFrom, 'notes-run-summary.json')}；--from 应指向 course notes 的输出目录`)
      }
    }

    const lock = acquirePublishLock({
      lockPath: publishLockPath(siteRoot),
      info: { slug: options.options.lesson || options.options.from || '', kind: options.flags?.has('rebuild') ? 'rebuild' : 'publish' },
      warnings: line => stderr(line)
    })
    if (!lock.ok) throw new Error(lock.message)
    try {
      return await publishLocked(options, { siteRoot, libraryForRebuild })
    } finally {
      lock.release()
    }
  }

  async function publishLocked(options, { siteRoot, libraryForRebuild }) {

    /**
     * --rebuild：只按发布库把站点重写一遍。
     *
     * 换模板、改样式、修页面脚本之后都要重新生成 HTML，而这些改动跟笔记内容无关：
     * 为了它们把模型再跑一遍既贵又慢。发布库（library.json）本来就存着每篇的完整
     * 记录，所以重建只读它——不碰账本，也不排新的微信通知（内容没变就不该再推一次）。
     */
    if (options.flags?.has('rebuild')) {
      if (!fs.existsSync(libraryForRebuild)) throw new Error(`找不到发布库 ${libraryForRebuild}；先发布过至少一篇笔记再 --rebuild`)
      const revisionBefore = libraryRevision(libraryForRebuild)
      const library = JSON.parse(fs.readFileSync(libraryForRebuild, 'utf8'))
      const writeBack = options.flags?.has('write-back')
      const recordsForLibrary = writeBack ? library.map(refreshRecord) : library
      const atomic = usesAtomicSiteReleases(siteRoot)
      let site
      let release = null

      if (atomic) {
        const outcome = publishViaRelease({
          siteRoot,
          records: recordsForLibrary,
          expectedRevision: revisionBefore.revision,
          origin: options.options.origin || 'https://course.law-tech.dev',
          // rebuild 不改正文；已有向量仍然与原正文指纹绑定，可以安全带入新 release。
          carryEmbeddings: true
        })
        site = outcome.site
        release = outcome.release
        if (writeBack) {
          const withSections = recordsForLibrary.filter(item => (item.sections || []).length).length
          stderr(
            `发布库已随新 release 写回派生字段：${recordsForLibrary.length} 条（其中 ${withSections} 条带小节索引）；` +
            `旧 release 保留作回滚：${release.previous || '（首次发布，无旧版）'}`
          )
        }
      } else {
        // 兼容旧部署：在显式迁移之前维持原来的“直接写实体 site 目录”行为。
        site = writeSite({
          records: library,
          outputDir: siteRoot,
          siteOrigin: options.options.origin || 'https://course.law-tech.dev',
          docs: readPublicDocs()
        })
        if (writeBack) {
          const check = checkRevisionUnchanged({ file: libraryForRebuild, expected: revisionBefore.revision })
          if (!check.ok) throw new Error(check.message)
          const backup = `${libraryForRebuild}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
          fs.copyFileSync(libraryForRebuild, backup)
          writeJsonAtomic(libraryForRebuild, recordsForLibrary)
          const withSections = recordsForLibrary.filter(item => (item.sections || []).length).length
          stderr(`发布库已写回派生字段：${recordsForLibrary.length} 条（其中 ${withSections} 条带小节索引）；写前备份 ${path.basename(backup)}`)
        }
      }

      const index = readSiteIndex(siteRoot)
      const purge = await purgeCache(options, { reason: '重建站点', files: site.written || [] })
      emit({
        rebuilt: true,
        notes: index.count ?? library.length,
        siteRoot,
        pages: (site.written || []).length,
        atomicRelease: Boolean(release),
        release: release ? { current: release.current, previous: release.previous, validatedNotes: release.validation.notes } : null,
        cachePurged: purge.ok === true,
        cache: purge
      }, options)
      return 0
    }

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
    const replayKey = runSummary.replayKey || options.options['replay-key'] || ''
    // 两种指纹，用途完全不同（见 @course/publish 的 derived.mjs）：
    //   contentChecksum —— 原始字节：发布库记录的 checksum（"内容变没变"、通知的幂等键）
    //   onepageChecksum —— 规范化（CRLF→LF、去掉结尾空白）：一页纸的绑定指纹，
    //                      与生成侧的 derivedBinding 同一个函数，差一个结尾换行不算改过
    const contentChecksum = markdownBytesChecksum(markdown)
    const onepageChecksum = markdownChecksum(markdown)

    // 老发布库只有 publishedAt：读进来时整体迁移成三个时间字段（幂等，见 migrateRecordTime），
    // 写回时全库一致——不会出现"老记录还带 publishedAt、新记录只有 lessonDate"的混合状态。
    // 读库前先记下版本指纹：提交前再比一次，防止"读进来之后被别的发布改过"被覆盖
    const revisionBefore = libraryRevision(libraryForRebuild)
    const library = (fs.existsSync(libraryForRebuild) ? JSON.parse(fs.readFileSync(libraryForRebuild, 'utf8')) : [])
      .map(migrateRecordTime)
    const slug = noteSlug({ courseName: course, lessonTitle })
    // 同一节的"上一次发布"：先按 slug 找，再按 replayKey 找（课次标题改过时 slug 会变）
    const previousBySlug = library.find(item => item.slug === slug) || null
    const previousByReplayKey = replayKey ? library.find(item => item.replayKey === replayKey) : null
    const previous = previousBySlug || previousByReplayKey || null
    const nowIso = clockNow().toISOString()
    // 首次进站时间一旦定下就不再动：RSS 的 pubDate 靠它，重新发布旧课不该改这个时间
    const firstPublishedAt = String(previous?.firstPublishedAt || previous?.publishedAt || '') || nowIso
    const regenerating = options.flags?.has('regenerate-derived')
    const derivedModelConfig = {
      apiKey: config.ai.apiKey || 'unset',
      baseUrl: config.ai.baseUrl,
      provider: config.ai.provider,
      source: 'environment',
      models: config.ai.models
    }
    const derivedCallModel = () => injectedCallModel ||
      (payload => callCourseModel({ ...payload, config: { ...derivedModelConfig, ...(payload.config || {}) }, onRetry: onModelRetry }))

    /**
     * 取一份派生物（简报 / 一页纸）。
     *
     * 目录是共享的：同一个 --from 目录里放过同一门课几节课的 brief.json 时，谁最后写谁生效——
     * 发布库里几节课于是共用同一段简报（真实故障：同课程第 2、3 讲的 summary 等于第 1 讲）。
     * 所以每份派生物都必须能与「这一篇、这一版正文」对上（course / lesson / sourceChecksum）：
     *   ok:false（不同源）→ **直接抛错中止发布**：宁可这次不发，也不发一篇串课的东西；
     *   bound:false（老数据没有绑定字段）→ 不拦，stderr 上提示一行；
     *   文件不存在 → 什么都不做（这一节本来就没有简报/一页纸，不是错误）；
     *   --regenerate-derived → 不同源时用模型按当前正文重做一份，并写回笔记目录。
     * 校验逻辑本身不在这里：简报用 @course/notes 的 checkBriefBinding，一页纸用
     * @course/publish 的 verifyDerived —— 两者返回同一个 { ok, bound, problems } 形状，
     * 且各自与自己的生成侧成对（指纹算法必须两边一致）。
     */
    const resolveDerived = async ({ label, file, check, regenerate }) => {
      if (!fs.existsSync(file)) return { applied: false, value: null, reason: 'missing', regenerated: false }
      let value = null
      let problems = null
      try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (error) {
        problems = [`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`]
      }
      if (!problems && (!value || typeof value !== 'object' || Array.isArray(value))) {
        problems = ['内容不是一个对象，读不出绑定信息']
      }
      const result = problems ? { ok: false, bound: false, problems } : check(value)
      if (!result.ok && !regenerating) {
        throw new Error(`${label}与要发布的这一篇不同源，已中止发布：${result.problems.join('；')}（${file}）；` +
          '确认这一节之后重跑 course brief / course onepage，或加 --regenerate-derived 自动重做')
      }
      if (!result.ok) {
        try {
          const payload = await regenerate()
          fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
          stderr(`${label}已重新生成（原文件与这一篇不同源：${result.problems.join('；')}）`)
          return { applied: true, value: payload, reason: 'regenerated', regenerated: true }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          stderr(`${label}重新生成失败：${reason}（这一轮先不挂它，发布继续）`)
          return { applied: false, value: null, reason: 'regenerate_failed', error: reason, regenerated: false }
        }
      }
      // 老数据没有绑定字段：照旧挂上，但要说一句（否则「这份简报没有出处」永远没人知道）
      if (!result.bound) stderr(`${label}未绑定来源（历史数据）：${file}`)
      return { applied: true, value, reason: result.bound ? 'ok' : 'unbound', regenerated: false }
    }

    const briefResolution = await resolveDerived({
      label: '简报',
      file: path.join(from, 'brief.json'),
      check: artifact => checkBriefBinding(artifact, { course, lesson: lessonTitle, markdown }),
      regenerate: async () => {
        const result = await generateBriefFromMarkdown({
          markdown,
          courseName: course,
          lessonTitle,
          courseSpec: { courseName: course, teacher },
          callModel: derivedCallModel(),
          modelConfig: derivedModelConfig
        })
        return {
          schemaVersion: 1,
          course,
          lesson: lessonTitle,
          replayKey,
          // 指纹用生成侧的那一个（briefSourceChecksum），不要在这里另算
          sourceChecksum: result.sourceChecksum,
          sourceChars: result.sourceChars ?? markdown.length,
          generatedAt: nowIso,
          briefing: result.briefing,
          keyPoints: result.keyPoints,
          theme: result.theme,
          keywords: result.keywords,
          detail: result.detail,
          trace: result.trace
        }
      }
    })
    const onepageResolution = await resolveDerived({
      label: '一页纸摘要',
      file: path.join(from, 'onepage.json'),
      // 一页纸同一套口径，只是指纹由发布侧算（generateOnepage 不返回指纹）
      check: artifact => verifyDerived(artifact, { courseName: course, lessonTitle, replayKey, checksum: onepageChecksum }),
      regenerate: async () => {
        const result = await generateOnepage({
          markdown,
          courseName: course,
          lessonTitle,
          courseSpec: { courseName: course },
          sections: sectionTexts(markdown).map(section => ({ id: section.id, title: section.title })),
          callModel: derivedCallModel(),
          modelConfig: derivedModelConfig
        })
        const rebuiltMap = stampSourceMap(result.sourceMap, {
          slug: noteSlug({ courseName: course, lessonTitle }),
          noteMarkdown: markdown,
          onepageMarkdown: result.markdown
        })
        return {
          schemaVersion: 1,
          ...derivedBinding({ markdown, courseName: course, lessonTitle, replayKey, generatedAt: nowIso }),
          title: result.title,
          outline: result.outline,
          markdown: result.markdown,
          chars: result.chars,
          ...(rebuiltMap ? { sourceMap: rebuiltMap } : {}),
          trace: result.trace
        }
      }
    })

    /**
     * 来源映射的全量核对：这里同时握着正文、小节切法与一页纸，是唯一能做"摘录逐字核对"的地方。
     * 核对结果写进发布库（渲染一侧只做轻核对），并单独报告定位/未定位的数量。
     */
    const recordSlug = noteSlug({ courseName: course, lessonTitle })
    const { sourceMap: verifiedSourceMap, report: sourceMapReport } = verifyRecordSourceMap(
      onepageResolution.value?.sourceMap,
      { slug: recordSlug, noteMarkdown: markdown, onepageMarkdown: onepageResolution.value?.markdown || '' }
    )
    const record = buildNoteRecord({
      courseName: course,
      teacher,
      lessonTitle,
      markdown,
      replayKey,
      // 课次日期：--lesson-date > 课次标题里的日期 > 账本里的排课时间 > 已有的 lessonDate > 首次进站日期
      lessonDate: options.options['lesson-date'] || '',
      startsAtText: ledgerStartsAtText(replayKey),
      previousLessonDate: previous?.lessonDate || '',
      firstPublishedAt,
      updatedAt: nowIso,
      brief: briefResolution.value,
      onepage: onepageResolution.value
        ? { ...onepageResolution.value, ...(verifiedSourceMap ? { sourceMap: verifiedSourceMap } : { sourceMap: null }) }
        : onepageResolution.value
    })
    // 日期只能靠首次进站时间兜底时要说出来：这个日期是猜的，页面上会照它排
    if (record.lessonDateSource === 'published' || record.lessonDateSource === 'none') {
      stderr(`这一节取不到上课日期，暂用 ${record.lessonDate || '（无）'} 当课次日期；可用 --lesson-date <YYYY-MM-DD> 指定`)
    }
    const changed = !previous || previous.checksum !== contentChecksum

    /**
     * 换掉这一节在库里的旧记录。
     *
     * 按 slug 换是常规路径；按 replayKey 换只用于"课次标题改过、slug 跟着变了"的改名场景，
     * 而且**只在 slug 找不到旧记录时才动它**。
     *
     * 不能无条件按 replayKey 删：真实数据里出过两节课共用同一个 replayKey
     * （国际刑法学 2026-09-16 与 2026-09-23 都是 replay-c6cdcf0c…），无条件删会让
     * 发布其中一节时把另一节从发布库里抹掉——站点上少一整节课，而且没有任何报错。
     */
    const staleByRename = !previousBySlug && previousByReplayKey ? previousByReplayKey : null
    /**
     * 通知策略与意图（见 notify-outbox.mjs）。
     *
     * 策略：--no-notify / --notify 显式指定；没指定时**沿用上一次的选择**——
     * 批量换排版时"这次先别推"是人的决定，不该被下一次自动重跑悄悄推翻。
     * 意图：notifyPending 跟内容在同一次原子写里落地（library.json 是提交点），
     * 提交之后才真正入队——中间崩了，下一次任何一次 publish 都会看到它并补发。
     */
    const notifyPolicy = resolveNotifyPolicy({
      flag: options.flags?.has('no-notify') ? NOTIFY_POLICY.NONE : (options.flags?.has('notify') ? NOTIFY_POLICY.CHANGED : undefined),
      stored: previous?.notifyPolicy
    })
    const origin = options.options.origin || 'https://course.law-tech.dev'
    const alreadyNotified = (() => {
      const probe = openStore(config.ledgerPath)
      try { return Boolean(probe.findDelivery(`course-note:${record.slug}:${contentChecksum.slice(0, 12)}`)) } finally { probe.close() }
    })()
    const planned = planNotification({
      changed,
      policy: notifyPolicy.policy,
      slug: record.slug,
      checksum: contentChecksum,
      // 正文用简报（一段说明 + 三条要点），不用笔记截断：截断出来的是半句话，
      // 读者无法判断这节课讲了什么。简报与当前正文对不上时这里就没有它（见 resolveDerived），
      // 退回原来的摘要——宁可退一步，也不推一条与笔记内容不符的消息。
      bodyText: briefResolution.value?.briefing
        ? renderBriefMessage({ courseName: record.courseName, lessonTitle: record.lessonTitle, brief: briefResolution.value })
        : `${record.courseName} · ${record.lessonTitle}\n${record.summary}`,
      objectUrl: `${origin}/${record.slug}.html`,
      alreadyNotified
    })
    /**
     * 还没入队的通知意图**必须带着走**：它记录的是"上一次崩在提交之后、入队之前"。
     * 重建记录时如果只放新计划、把旧的丢掉，崩溃恢复就永远看不到它——那正是这个设计要防的事。
     */
    const carriedPending = !planned && previous?.notifyPending ? previous.notifyPending : null
    const nextLibrary = [
      ...library.filter(item => item.slug !== record.slug && (!staleByRename || item.slug !== staleByRename.slug)),
      {
        ...record,
        checksum: contentChecksum,
        ...(notifyPolicy.reason === 'flag' ? { notifyPolicy: notifyPolicy.policy } : {}),
        ...(planned ? { notifyPending: planned } : (carriedPending ? { notifyPending: carriedPending } : {}))
      }
    ]
    let site
    let release = null
    const atomic = usesAtomicSiteReleases(siteRoot)

    if (atomic) {
      /**
       * release 模式：页面、Markdown、公开索引与 library.json 全部先写到新目录，
       * 校验通过以后一次切换 site symlink。旧版目录完整保留，可一键切回。
       *
       * embedding 是正文的派生物：正文一个字没变时可以原样带过去；正文变了就**不带**，
       * 让语义回退暂时关闭在“没有索引”的安全状态，等 course embed 按新指纹增量重建。
       * 宁可少一个语义结果，也不能让旧向量替新正文说话。
       */
      const outcome = publishViaRelease({
        siteRoot,
        records: nextLibrary,
        expectedRevision: revisionBefore.revision,
        origin: options.options.origin || 'https://course.law-tech.dev',
        carryEmbeddings: !changed
      })
      site = outcome.site
      release = outcome.release
    } else {
      /**
       * 旧部署兼容路径：在用户显式执行 --migrate-site-root 之前完全维持原行为。
       * 这里仍是“页面先写、library 最后提交”，至少保证公开索引不会先于页面出现。
       */
      fs.mkdirSync(siteRoot, { recursive: true })
      site = writeSite({
        records: nextLibrary,
        outputDir: siteRoot,
        siteOrigin: options.options.origin || 'https://course.law-tech.dev',
        docs: readPublicDocs()
      })
      const revisionCheck = checkRevisionUnchanged({ file: libraryForRebuild, expected: revisionBefore.revision })
      if (!revisionCheck.ok) throw new Error(revisionCheck.message)
      writeJsonAtomic(libraryForRebuild, nextLibrary)
    }

    const index = readSiteIndex(siteRoot)
    const purge = purgeCache(options, { reason: `发布 ${record.slug}`, files: site.written || [] })
    const integrationRefresh = changed
      ? refreshConfiguredIntegrations({ records: nextLibrary, course: record.courseName, lessonTitle: record.lessonTitle })
      : { configured: fs.existsSync(path.join(config.scratchRoot, 'integration-manifest.json')), matched: 0, refreshed: [], errors: [] }
    if (integrationRefresh.errors?.length) {
      stderr(
        `单课正文已发布，但有 ${integrationRefresh.errors.length} 份章级整合自动重建失败：` +
        integrationRefresh.errors.map(item => `${item.id}（${item.message}）`).join('；') +
        '。旧整合仍会被 artifacts/reconcile 标为 stale，不会伪装成新版本。'
      )
    }

    // 同一条内容只通知一次（去重键带内容指纹：改好之后重发要能再推一次）
    let delivery = null
    let recovered = []
    const store = openStore(config.ledgerPath)
    try {
      const task = replayKey ? store.getTask(replayKey) : null
      // 提交之后才入队：内容与"要通知"已经一起落地，这里失败也不会丢（下次发布补发）
      if (planned) delivery = store.enqueueDelivery(planned)
      /**
       * 崩溃恢复：库里凡是"挂了通知意图但还没入队"的记录，这一次一并补发。
       * enqueueDelivery 按 dedupeKey 去重，所以重复补发不会多发一条——
       * 这里承诺的是**至少一次 + 去重**，不是 exactly-once。
       */
      const pendingAll = pendingNotifications(nextLibrary)
      const queuedSlugs = new Set([...(delivery ? [record.slug] : []), ...pendingAll.map(item => item.slug)])
      for (const slug of queuedSlugs) {
        // 这一篇刚刚已经入队过，不必再走一遍（dedupeKey 相同，重复也只是命中已有行）
        if (slug === record.slug && delivery) { recovered.push(slug); continue }
        const item = pendingAll.find(entry => entry.slug === slug)
        if (!item) continue
        store.enqueueDelivery({
          dedupeKey: item.dedupeKey,
          purpose: item.purpose || 'course-note',
          bodyText: item.bodyText,
          objectUrl: item.objectUrl
        })
        recovered.push(slug)
      }
      if (recovered.length) {
        // 入队成功才抹掉意图；抹掉失败（进程被杀）也没关系——下次补发会被去重吃掉
        const cleared = clearPending(nextLibrary, [...new Set(recovered)], { at: clockNow().toISOString() })
        if (cleared.changed) {
          writeJsonAtomic(libraryForRebuild, cleared.records)
          if (recovered.some(slug => slug !== record.slug)) stderr(`补发了 ${recovered.length} 条此前未入队的通知：${[...new Set(recovered)].join('、')}`)
        }
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
        atomicRelease: Boolean(release),
        release: release ? {
          current: release.current,
          previous: release.previous,
          validatedNotes: release.validation.notes
        } : null,
        semanticIndex: release
          ? (changed ? 'stale_not_carried' : (fs.existsSync(path.join(siteRoot, 'embeddings.json')) ? 'carried' : 'absent'))
          : 'legacy_site',
        integrationRefresh: {
          configured: Boolean(integrationRefresh.configured),
          matched: integrationRefresh.matched || 0,
          refreshed: (integrationRefresh.refreshed || []).map(item => item.id),
          errors: integrationRefresh.errors || []
        },
        // 时间语义：lessonDate 是这节课的日期（排序与展示），firstPublishedAt 进 RSS，
        // updatedAt 供日报判断"昨天更新了什么"；lessonDateSource 说明日期是哪来的。
        lessonDate: record.lessonDate,
        lessonDateSource: record.lessonDateSource,
        firstPublishedAt: record.firstPublishedAt,
        updatedAt: record.updatedAt,
        // 派生物这一轮有没有被采纳；reason 说清为什么没挂（stale_source / missing_checksum …）
        brief: { applied: briefResolution.applied, reason: briefResolution.reason },
        onepage: { applied: onepageResolution.applied, reason: onepageResolution.reason },
        // 来源映射单独报：定位到几块、剩几块退回整篇入口、哪些条目被核对掉（原因在前几条）
        sourceMap: sourceMapReport,
        // 三件事分开报，别混成一句"已发布"：
        //   contentChanged —— 内容有没有变（决定要不要通知）
        //   notifyPolicy   —— 这次用的是哪条策略（flag / stored），为什么没发一看就知道
        //   delivery       —— 到底有没有排进队列（inserted=false 表示同样的内容早就排过）
        contentChanged: changed,
        notifyPolicy: notifyPolicy.policy,
        notifyPolicySource: notifyPolicy.reason,
        recoveredNotifications: [...new Set(recovered)],
        delivery: delivery ? { inserted: delivery.inserted, dedupeKey: delivery.delivery?.dedupeKey || null } : null,
        task: task ? { id: task.id, to: task.stage === 'published' || task.stage === 'completed' ? task.stage : 'published' } : null,
        // 首页 / 索引页每发一篇都会变，清了边缘缓存读者才立刻看得到
        cachePurged: (await purge).ok === true,
        cache: await purge
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
    const fallbackConfig = config.notify.fallback || {}
    if (!target && !fallbackConfig.kind) {
      throw new Error('缺少推送目标：请设置 COURSE_WECHAT_TARGET，或配一条备用通道（COURSE_NOTIFY_FALLBACK）')
    }

    const primary = injectedSender || (target
      ? createWechatSender({
        openclawBin: config.notify.openclawBin,
        openclawHome: config.notify.openclawHome,
        openclawStateDir: config.notify.openclawStateDir,
        target
      })
      : { send: async () => { throw new Error('没有配置微信通道') }, probe: async () => ({ ok: false, detail: '未配置 COURSE_WECHAT_TARGET' }) })

    /**
     * 微信机器人能不能自己发出去，是可以判断的：平台只在用户来信时发 context_token，
     * 出站必须带上；没有它接口也会返回成功，消息却到不了微信（实测 21 条全中）。
     * 所以这里先看会话，过期就直接改走备用通道，而不是"试一次再说"。
     */
    const fallback = fallbackConfig.kind
      ? createFallbackSender({
        kind: fallbackConfig.kind,
        url: fallbackConfig.url,
        // Server酱与 PushPlus 要的是密钥，群机器人要的是地址；一个字段两边都用
        sendKey: fallbackConfig.key || fallbackConfig.sendKey,
        token: fallbackConfig.key || fallbackConfig.token
      })
      : null
    if (fallback && !fallback.configured) {
      stderr(`备用通道 ${fallback.kind} 缺地址或密钥，本次不使用`)
    }

    const sender = createResilientSender({
      primary,
      fallback: fallback && fallback.configured ? fallback : null,
      primaryUsable: async () => {
        if (!target) return false
        const state = wechatSessionState({ stateDir: config.notify.openclawStateDir, home: config.notify.openclawHome })
        return Boolean(state.ok) && Number(state.ageMinutes || 0) <= WECHAT_SESSION_MAX_AGE_MINUTES
      },
      onFallback: reason => stderr(`改用备用通道 ${fallbackConfig.kind}：${reason}`)
    })

    // 会话过期先说清楚，并记录一次"能不能自动激活"的判定结果。
    // 结论是**不能**（需要人工给机器人发消息，或扫码登录/批准设备）——依据与出处
    // 写在 wechat.mjs 的注释里，管理台的推送通道卡片显示同一句话。
    const wechat = checkWechatActivation({
      stateDir: config.notify.openclawStateDir,
      home: config.notify.openclawHome,
      now: new Date(clockNow()).getTime()
    })
    if (wechat.needed) {
      stderr(`微信会话不可用：${wechat.reason}`)
      stderr(`处理办法：${wechat.hint}`)
    }

    if (options.flags.has('probe')) {
      const probe = await sender.probe()
      emit({ probe: true, ok: probe.ok, target: config.notify.target ? 'set' : 'missing', detail: probe.detail, wechat }, options)
      return probe.ok ? 0 : 1
    }

    const store = openStore(config.ledgerPath)
    try {
      // 发失败的通知（重试到上限后被标记 failed）不会自己回来：
      // 要么人工重发，要么永远消失。这里给一条明确的重发入口。
      if (options.flags.has('retry-failed')) {
        const revived = store.reviveFailedDeliveries()
        stderr(`已把 ${revived.revived} 条发送失败的通知放回队列`)
      }

      const cycleOptions = {
        store,
        sender,
        publicSiteUrl: config.notify.publicUrl,
        maxAttempts: config.notify.maxAttempts,
        maxItems: Number(options.options['max-items'] || 10),
        workerId: options.options['worker-id'] || `notify:${os.hostname()}`,
        onEvent: event => stderr(`  ${event.status} ${event.dedupeKey}${event.channel ? ` [${event.channel}]` : ''}${event.error ? ` — ${event.error}` : ''}`)
      }

      if (!options.flags.has('loop')) {
        const summary = await runDeliveryCycle(cycleOptions)
        emit({ mode: 'once', ...summary, wechat }, options)
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
      emit({ mode: 'loop', rounds, ...totals, wechat }, options)
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
    const providerIssues = []
    const workerId = options.options['worker-id'] || `cycle:${os.hostname()}`
    const maxTasks = Number(options.options['max-tasks'] || 5)
    const quiet = { ...options, quiet: true }
    const summary = {
      workerId, startedAt: new Date().toISOString(), discovered: null, disk: null,
      tasks: [], notification: null, errors: [], providerIssues: [], lowBalance: null,
      needsAttention: [], asrBlocked: null
    }

    // 转录通道是否因付费/凭据问题停摆：用它拦住后续下载（转录本身仍会重试）。
    // 转录跑不动时继续下载只会把盘塞满，而盘满影响的是整机。
    const asrBlocked = (() => {
      const store = openStore(config.ledgerPath)
      try {
        const blocked = store.listTasks({ limit: 200 })
          .filter(task => task.last_error && ['downloaded', 'transcribing', 'transcript_ready'].includes(task.stage))
          .map(task => ({ task, issue: classifyProviderIssue(task.last_error) }))
          .filter(item => item.issue && item.issue.provider === 'aliyun')
        return blocked[0] || null
      } catch {
        return null
      } finally {
        store.close()
      }
    })()
    if (asrBlocked) {
      stderr(`转录通道受阻（${asrBlocked.issue.title}）：本轮不再下载新课，转录仍会重试`)
    }

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

    /**
     * 「没有课件就不自动跑」。
     *
     * 用户的要求：课件没传上来，这一节先别动；除非在管理台点「立即跑这一节」——
     * 那是一次显式点击，等于"我就是要跑"。默认生效，--require-materials 0 关掉。
     *
     * 拦的只是**自动选任务**这条路（不带 --replay-key）：显式点名一节课本身就是
     * "我现在就要跑"，此时不再拦，只在结果里写清楚"无课件也照跑"。
     */
    const requireMaterials = parseRequireMaterials(options.options['require-materials'])
    const skippedNoMaterials = []
    summary.materials = { required: requireMaterials, skipped: [] }

    for (let index = 0; space.ok && index < maxTasks; ) {
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
          const candidate = nextActionableTask(store, {
            exclude: new Set(skippedNoMaterials.map(item => item.replayKey))
          })
          if (!candidate) break
          if (requireMaterials) {
            const materials = lessonMaterials(candidate)
            if (materials.count === 0) {
              // 零副作用地跳过：不领取（领取会把 attempts +1 并占住一小时租约），
              // 账本阶段原样不动——补传课件之后，这一轮或下一轮立刻就能跑。
              skippedNoMaterials.push({
                replayKey: candidate.replay_key,
                courseName: candidate.course_name,
                title: candidate.title,
                stage: candidate.stage
              })
              const label = [candidate.course_name, candidate.title].filter(Boolean).join(' · ') || candidate.replay_key
              stderr(`${label}：没有课件，本轮不跑（上传课件后会自动开始；也可以点管理台的「立即跑这一节」强制跑）`)
              summary.tasks.push({
                replayKey: candidate.replay_key, stage: candidate.stage, action: 'skip', ok: true,
                materialCount: 0, note: '没有课件，本轮不跑（不推进阶段）'
              })
              continue
            }
          }
          const claimed = store.claimTask({ replayKey: candidate.replay_key, workerId, leaseSeconds: 3600 })
          task = claimed.claimed ? claimed.task : null
          if (!task) {
            // 与别的进程撞车了（单 worker 时不该发生）：如实记一条，继续找下一个
            summary.tasks.push({
              replayKey: candidate.replay_key, stage: candidate.stage, action: 'skip', ok: true,
              note: `未领取：${claimed.reason}`
            })
            continue
          }
        }
      } finally {
        store.close()
      }
      if (!task) break
      // 只有真正领到任务才算用掉一格配额：因缺课件被拦下的课次不占额度，
      // 这一轮该跑的其它课次照样能跑。
      index += 1

      const command = stageCommands[task.stage]
      // 这一节有没有课件：显式单节或 --require-materials 0 时，无课件也照跑，
      // 但结果里要看得出来（用户点「立即跑这一节」之后，不该怀疑它到底跑没跑）。
      const materials = lessonMaterials(task)
      const materialsNote = materials.count === 0
        ? (onlyReplay ? '无课件也照跑（显式指定这一节）' : '无课件也照跑（--require-materials 0）')
        : ''

      // 转录侧的付费故障（欠费/额度/密钥）没解决之前，不再开新的下载：
      // 转录跑不动，下载下来的媒体只会躺在盘上——14 节课每节 1—2G，很快把盘吃满，
      // 而盘满了整机都受影响（swap 与数据同盘）。转录本身仍会重试。
      if (command === 'download' && asrBlocked) {
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: 'skip', ok: false,
          materialCount: materials.count,
          note: `转录通道未恢复（${asrBlocked.issue.title}），先不下载新课件以免堆满磁盘`
        })
        continue
      }

      if (!command) {
        // 可领取却没有对应命令，说明阶段映射与账本脱节——这类问题必须浮出来，
        // 不能静默跳过并让整轮看起来成功。
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: 'none', ok: false,
          materialCount: materials.count,
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
          ...(options.options['ignore-cost-window'] ? { 'ignore-cost-window': options.options['ignore-cost-window'] } : {}),
          ...(options.options['auto-approve-outline'] ? { 'auto-approve-outline': options.options['auto-approve-outline'] } : {})
        },
        publish: {
          ...common,
          from: path.dirname(artifacts.notePath || ''),
          // 站点目录只在显式指定时才传，避免与 discover 的 --out 混淆
          ...(options.options.out ? { out: options.options.out } : {}),
          // 课次日期：自动链路里通常能从课次标题解析出来，但标题没带日期时
          // （老的"第10-12节"）只有人工知道，所以让这个选项透传下去
          ...(options.options['lesson-date'] ? { 'lesson-date': options.options['lesson-date'] } : {})
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
          materialCount: materials.count,
          note: '缺少前置产物，跳过'
        })
        continue
      }

      try {
        const code = await (command === 'download' ? download(commandOptions)
          : command === 'transcribe' ? transcribe(commandOptions)
            : command === 'notes' ? notes(commandOptions)
              : publish(commandOptions))
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: command, ok: code === 0,
          materialCount: materials.count,
          ...(materialsNote ? { note: materialsNote } : {})
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 付费类故障（欠费/额度/密钥）要能被识别出来并单独提醒：它们需要用户动手，
        // 沉在日志里等于没发生——用户只会看到"转写又失败了"。
        const issue = classifyProviderIssue(message)
        if (issue && !providerIssues.some(item => item.category === issue.category)) providerIssues.push(issue)
        summary.tasks.push({
          replayKey: task.replay_key, stage: task.stage, action: command, ok: false,
          materialCount: materials.count,
          error: message,
          ...(issue ? { providerIssue: issue.category } : {})
        })
      }
    }

    // 缺课件被拦下的课次：账本原样不动，但摘要里要留下痕迹——
    // 管理台的运行历史据此能回答"这一轮为什么没动那几节"。
    summary.materials.skipped = skippedNoMaterials

    /**
     * 3. 投递已排队的通知（发之前先看一眼微信会话）。
     *
     * 这条通道要求用户最近给机器人发过消息（context_token），会话过期时接口照样
     * 返回成功、微信端却收不到。所以在这里把状态说清楚并**记录**一次判定结果：
     * 自动激活做不到（没有非交互式入口，见 wechat.mjs 的结论），就如实写下来，
     * 而不是"试一下再说"——那只会继续产生账本说成功、手机没消息的假记录。
     */
    const wechat = checkWechatActivation({
      stateDir: config.notify.openclawStateDir,
      home: config.notify.openclawHome,
      now: new Date(clockNow()).getTime()
    })
    if (wechat.needed) {
      stderr(`微信会话不可用：${wechat.reason}`)
      stderr(`处理办法：${wechat.hint}`)
    }
    summary.wechat = wechat

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

    // 反复失败的课次停下来并明确告诉用户。
    // 无限重试的代价是"一直烧钱而且没人知道"；跑不动就该出现在通知里，
    // 由人决定是修凭据、补课件还是人工重置（course retry）。
    const stuck = []
    try {
      const store = openStore(config.ledgerPath)
      try {
        const maxAttempts = Number(options.options['max-attempts'] || 5)
        for (const task of store.listTasks({ limit: 200 })) {
          if (['published', 'completed', 'needs_attention'].includes(task.stage)) continue
          if (Number(task.attempts || 0) < maxAttempts) continue
          store.reportStage({
            id: task.id,
            stage: 'needs_attention',
            message: `连续失败 ${task.attempts} 次，已停止自动重试`,
            error: task.last_error || ''
          })
          store.enqueueDelivery({
            dedupeKey: `needs-attention:${task.replay_key}`,
            purpose: 'needs-attention',
            bodyText: [
              `【停下等你】${task.course_name || ''} · ${task.title || task.replay_key}`,
              `连续失败 ${task.attempts} 次，已停止自动重试。`,
              `阶段：${task.stage}`,
              `原因：${String(task.last_error || '（未记录）').slice(0, 200)}`,
              '',
              '处理完（补凭据/补课件/手动重跑）后用 course retry --replay-key 放回队列。'
            ].join('\n'),
            objectUrl: 'https://course.law-tech.dev/admin'
          })
          stuck.push({ replayKey: task.replay_key, stage: task.stage, attempts: task.attempts })
        }
      } finally {
        store.close()
      }
    } catch (error) {
      summary.errors.push({ step: 'needs-attention', message: error instanceof Error ? error.message : String(error) })
    }
    summary.needsAttention = stuck

    // 付费故障与低余额：排一条可行动的提醒（按天去重，不重复轰炸）
    try {
      const store = openStore(config.ledgerPath)
      try {
        const day = new Date().toISOString().slice(0, 10)
        for (const issue of providerIssues) {
          store.enqueueDelivery({
            dedupeKey: `provider-issue:${issue.category}:${day}`,
            purpose: 'provider-issue',
            bodyText: [
              `【需要处理】${issue.title}`,
              '',
              issue.hint,
              issue.rechargeUrl ? `处理入口：${issue.rechargeUrl}` : '',
              '',
              `原始信息：${issue.detail}`
            ].filter(Boolean).join('\n'),
            objectUrl: issue.rechargeUrl || ''
          })
        }
        summary.providerIssues = providerIssues.map(item => item.category)

        // 余额检查：低于阈值也提醒一次（DeepSeek 有官方接口，查一次很便宜）
        try {
          const balance = await fetchDeepseekBalance({ apiKey: config.ai.apiKey })
          if (Number(balance.total) < LOW_BALANCE_THRESHOLD_CNY) {
            store.enqueueDelivery({
              dedupeKey: `balance:deepseek:${day}`,
              purpose: 'balance-warning',
              bodyText: renderBalanceWarning({ provider: 'deepseek', total: balance.total }),
              objectUrl: balance.rechargeUrl
            })
            summary.lowBalance = { provider: 'deepseek', total: balance.total }
          }
        } catch {
          // 余额查不到不该让整轮失败
        }
      } finally {
        store.close()
      }
    } catch (error) {
      summary.errors.push({ step: 'provider-notice', message: error instanceof Error ? error.message : String(error) })
    }

    summary.asrBlocked = asrBlocked
      ? { category: asrBlocked.issue.category, title: asrBlocked.issue.title, replayKey: asrBlocked.task.replay_key }
      : null

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

    /**
     * 默认只做前置检查，**要真跑必须显式 --yes**。
     *
     * 这是踩出来的：verify 会真跑一整轮完整链路（下载 → 转写 → 笔记 → 发布 → 推送），
     * 一次误调用就是真金白银——转写按小时计费、笔记是几十次模型调用，而且发布之后
     * 读者可能立刻收到一条推送。排查问题时顺手敲一下 verify，代价却是几块钱和一次打扰。
     * 所以先报告「条件齐备」，让调用方自己决定要不要真跑。
     */
    if (!options.flags?.has('yes')) {
      emit({
        ready: true,
        dryRun: true,
        criteria,
        willRun: '真跑一轮会：下载（占带宽与磁盘）→ 转写（ASR 按小时计费）→ 写笔记（多次模型调用）→ 发布 → 可能向读者推送',
        hint: '前置条件齐备。确认真跑请加 --yes；只想看条件检查就用现在这个输出。'
      }, options)
      return 0
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

  /**
   * 两个付费 API 的余额。
   *
   * 付费故障必须可行动：欠费导致的转写失败，用户要能一眼看出"是哪家、去哪儿充"。
   * DeepSeek 有官方接口（现有 key 即可）；阿里云余额属账号维度，要账号 AK/SK。
   */
  async function balance(options) {
    const threshold = Number(options.options.threshold || LOW_BALANCE_THRESHOLD_CNY)
    const balances = []
    try {
      balances.push(await fetchDeepseekBalance({ apiKey: config.ai.apiKey }))
    } catch (error) {
      balances.push({ provider: 'deepseek', error: error instanceof Error ? error.message : String(error) })
    }
    try {
      balances.push(await fetchAliyunBalance({
        accessKeyId: env.ALIYUN_ACCESS_KEY_ID || '',
        accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET || ''
      }))
    } catch (error) {
      balances.push({ provider: 'aliyun', error: error instanceof Error ? error.message : String(error) })
    }
    const low = balances.filter(item => {
      if (item.error || item.configured === false) return false
      return Number(item.total ?? item.available ?? 0) < threshold
    })
    emit({ threshold, balances, low: low.map(item => item.provider) }, options)
    return 0
  }

  /**
   * 课件管理：收件箱归档、列出现有课件。
   *
   * 教学网上没有课件，课件只在用户手里，所以这条命令要能"随手补传"：
   * 把文件丢进收件箱（或直接 --file）即可，命名约定 `课程__课次.pptx` 用来定归属。
   */
  async function materials(options) {
    const root = config.materialsRoot
    const inbox = config.inboxRoot

    if (options.flags?.has('ingest')) {
      fs.mkdirSync(inbox, { recursive: true })
      const done = path.join(inbox, 'processed')
      fs.mkdirSync(done, { recursive: true })
      const parked = unassignedDir(root)
      fs.mkdirSync(parked, { recursive: true })
      const files = fs.readdirSync(inbox).filter(name => {
        const full = path.join(inbox, name)
        return fs.statSync(full).isFile() && !name.startsWith('.')
      })
      // 账本里已知的课程与课次：用来从文件名猜归属（不必再死记命名规则）
      const known = withLedger(store => store.listTasks({ limit: 500 }).map(task => ({
        course: task.course_name,
        lesson: task.title,
        replayKey: task.replay_key
      })))
      const knownCourses = [...new Set(known.map(item => item.course).filter(Boolean))]

      const results = []
      for (const name of files) {
        // 先看严格命名（课程__课次 / 课程__ALL），没有再按账本里的课程课次去认
        const strict = parseInboxName(name)
        const guess = strict ? null : guessMaterialIdentity(name, { courses: knownCourses, lessons: known })
        const identity = strict || (guess?.canAutoAssign
          ? { course: guess.course, lesson: guess.lesson, scope: 'lesson', extension: path.extname(name) }
          : null)
        // 认不出来就**不猜**：停到 _unassigned 并说明认到了什么，让人在管理台指定。
        // 猜错的代价是笔记用错课件，比多一步人工贵得多。
        if (!identity) {
          fs.renameSync(path.join(inbox, name), path.join(parked, name))
          results.push({
            name, archived: false, parked: true,
            reason: guess ? guess.reason : '文件名里既没有 课程__课次 也没有能认出的课程与课次，已停到 _unassigned'
          })
          continue
        }
        try {
          const { entry, deck } = await addMaterial({
            root,
            course: identity.course,
            lesson: identity.lesson,
            scope: identity.scope,
            replayKey: options.options['replay-key'] || '',
            filePath: path.join(inbox, name),
            name,
            python: config.python
          })
          fs.renameSync(path.join(inbox, name), path.join(done, name))
          // 课件里有图就当场识别（这里是 CLI/定时任务上下文，等得起）：
          // "识别到有图片就自动识别"这条规则不该只在管理台上传时成立
          let ocr = null
          if (entry.ocrPending > 0) {
            stderr(`  ${name}：有 ${entry.ocrPending} 张图，正在识别图片文字`)
            try {
              const outcome = await ocrMaterial({
                root,
                course: identity.course,
                lesson: entry.lesson || '',
                name: entry.name,
                python: config.python,
                ocrMaxPages: Number(options.options['ocr-max-pages'] || 60),
                ocrConcurrency: Number(options.options['ocr-concurrency'] || 3)
              })
              ocr = { attempted: outcome.entry?.ocr?.attempted || 0, pending: outcome.entry?.ocrPending || 0, skipped: Boolean(outcome.skipped) }
            } catch (error) {
              ocr = { error: error instanceof Error ? error.message : String(error) }
              stderr(`  ${name}：图片识别失败（${ocr.error}），先用现有文字继续`)
            }
          }
          results.push({
            name, archived: true, course: identity.course,
            scope: entry.scope, lesson: entry.lesson || '（全课程通用）',
            slideCount: deck.slideCount, checksum: entry.checksum.slice(0, 12),
            imageCount: entry.imageCount || 0, ocr
          })
        } catch (error) {
          results.push({ name, archived: false, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      emit({ inbox, archived: results.filter(item => item.archived).length, results }, options)
      return results.some(item => !item.archived && !item.parked) ? 1 : 0
    }

    const file = options.options.file
    if (file) {
      const course = requireOption(options.options, 'course', 'materials')
      const lesson = requireOption(options.options, 'lesson', 'materials')
      const scope = options.options['course-scope'] ? 'course' : 'lesson'
      const appliesTo = String(options.options['applies-to'] || '').split(',').map(item => item.trim()).filter(Boolean)
      const { entry, deck } = await addMaterial({
        root, course, lesson,
        scope,
        appliesTo,
        replayKey: options.options['replay-key'] || '',
        filePath: path.resolve(file),
        name: options.options.name || path.basename(file),
        python: config.python,
        // --ocr：入库时就把图片文字识别出来（慢，但一条命令到位）
        ocr: options.flags?.has('ocr'),
        ocrMaxPages: Number(options.options['ocr-max-pages'] || 60),
        ocrConcurrency: Number(options.options['ocr-concurrency'] || 3)
      })
      emit({ ...entry, slides: deck.slides.length }, options)
      return 0
    }

    // --ocr 不带 --file：把这一课次（或整门课）里"还有图没识别"的课件补齐。
    // 单独一步的原因见 ocrMaterial：识别一张图几秒，上传请求等不起，笔记却必须等它。
    if (options.flags?.has('ocr')) {
      const course = requireOption(options.options, 'course', 'materials --ocr')
      const lesson = options.options.lesson || ''
      const pending = course && lesson
        ? pendingOcrMaterials({ root, course, lesson, replayKey: options.options['replay-key'] || '' })
        : listMaterials({ root, course })
      const targets = pending.filter(item => item.ocrPending > 0)
      const results = []
      for (const item of targets) {
        try {
          const outcome = await ocrMaterial({
            root,
            course: item.course || course,
            lesson: item.lesson || '',
            name: item.name,
            python: config.python,
            ocrMaxPages: Number(options.options['ocr-max-pages'] || 60),
            ocrConcurrency: Number(options.options['ocr-concurrency'] || 3)
          })
          results.push({
            name: item.name,
            skipped: Boolean(outcome.skipped),
            reason: outcome.reason || '',
            images: outcome.entry?.imageCount || 0,
            pending: outcome.entry?.ocrPending || 0,
            ocr: outcome.entry?.ocr || null
          })
        } catch (error) {
          results.push({ name: item.name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      emit({
        course,
        lesson,
        scanned: targets.length,
        recognized: results.filter(item => !item.error && !item.skipped).length,
        results
      }, options)
      return results.some(item => item.error) ? 1 : 0
    }

    const course = options.options.course || ''
    const lesson = options.options.lesson || ''
    if (course && lesson) {
      emit({
        root, course, lesson,
        replayKey: options.options['replay-key'] || '',
        materials: listMaterials({ root, course, lesson, replayKey: options.options['replay-key'] || '' })
      }, options)
      return 0
    }
    const courses = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name) : []
    emit({
      root,
      inbox,
      courses: courses.map(name => ({
        course: name,
        lessons: fs.readdirSync(path.join(root, name), { withFileTypes: true })
          .filter(item => item.isDirectory())
          .map(item => ({ lesson: item.name, materials: listMaterials({ root, course: name, lesson: item.name }) }))
      }))
    }, options)
    return 0
  }

  async function status(options) {
    const snapshot = withLedger(store => ({
      path: store.path,
      stages: store.countTasks(),
      tasks: store.listTasks({ stage: options.options.stage || null, limit: Number(options.options.limit || 20) }),
      // 通知发不出去不该无声无息：投递失败要在状态里看得见（管理台据此显示并支持重发）
      deliveries: store.countDeliveries(),
      failedDeliveries: store.listDeliveries({ status: 'failed', limit: 20 })
    }))
    emit(snapshot, options)
    return 0
  }

  /**
   * 管理台密码：设置 / 清除 / 查看状态。
   *
   * 这是**找回密码**的服务器侧入口：忘记密码时在这里重设，
   * 或者用环境变量里的主令牌（COURSE_ADMIN_TOKEN）先登录再去管理台改。
   * 密码只存 scrypt 哈希，所以这里也读不回明文——只能重设。
   */
  async function adminPassword(options) {
    const file = path.join(config.scratchRoot, 'admin-password.json')
    const status = () => ({
      path: file,
      passwordSet: fs.existsSync(file),
      masterTokenSet: Boolean(String(env.COURSE_ADMIN_TOKEN || '').trim()),
      updatedAt: (() => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt
        } catch {
          return null
        }
      })()
    })

    // 注意 --set-stdin 是旗标（没有值），不能从 options 里取
    const wantsStdin = Boolean(options.flags?.has('set-stdin'))
    if (options.flags?.has('status') || (!options.options.set && !wantsStdin && !options.flags?.has('clear'))) {
      emit({ ...status(), hint: '忘记密码时：course admin-passwd --set-stdin 重设，或用主令牌登录后在管理台修改' }, options)
      return 0
    }
    if (options.flags?.has('clear')) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true })
      emit({ ...status(), cleared: true, note: '已清除密码：现在只能用主令牌登录' }, options)
      return 0
    }

    let password = String(options.options.set || '')
    if (wantsStdin) password = String(await readStdin()).trim()
    if (!password) throw new Error('没有读到密码：请用 --set-stdin 通过标准输入提供，或 --set <新密码>')
    const problem = validatePassword(password)
    if (problem) throw new Error(`密码不符合要求：${problem}`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(hashPassword(password), null, 2)}\n`, { mode: 0o600 })
    stderr('密码已重设（只保存哈希，明文不落盘）。下次打开管理台用它登录即可。')
    emit({ ...status(), changed: true }, options)
    return 0
  }

  /**
   * 账本与站点库的备份：**写完要验、验完要送出这台机器**。
   *
   * 账本是整条流水线的记忆（阶段、尝试次数、事件流、投递队列），丢了不会让机器坏掉，
   * 但会让人重新付一遍钱和时间。三件事缺一不可：
   *   1. 一致性快照：用 SQLite 的 VACUUM INTO（数据库正在被写也能安全复制）；
   *   2. **验证**：快照写完立刻打开它跑 integrity_check 并清点记录数，再记一份 sha256 清单——
   *      没有验证的备份只是一种错觉：磁盘满或中断时会安静地产出一个坏文件；
   *   3. **异地**：同一块盘上的备份挡不住盘坏、误删、机器被回收。
   *      用 COURSE_BACKUP_OFFSITE 给一条命令模板（{} 会被替换成文件路径），例如
   *      rclone copy {} r2:course-backups/ 或 scp {} backup-host:/srv/course/。
   *      命令失败会如实报出来并让退出码非 0，交给 systemd/cron 报警，而不是悄悄吞掉。
   */
  async function backup(options) {
    const keep = Math.max(2, Number(options.options.keep || 7))
    const dir = path.join(config.scratchRoot, 'backups')
    fs.mkdirSync(dir, { recursive: true })

    /**
     * --drill：**恢复演练**（C3）。
     *
     * 备份的价值不在"文件在那儿"，而在"能恢复"。演练做的事：
     *   1. 找最新一份 manifest；
     *   2. 按清单逐个核对 sha256（文件被改过、被截断、被别的备份覆盖都能发现）；
     *   3. 把账本快照复制到临时目录里**真的打开一次**跑 integrity_check 并清点记录；
     *   4. 解析站点发布库、核对记录数与 manifest 记的一致。
     * 全程不碰线上数据（只看副本），因此可以随便跑、也可以放进定时任务。
     */
    if (options.flags?.has('drill')) {
      const manifests = fs.readdirSync(dir).filter(name => name.startsWith('manifest-') && name.endsWith('.json')).sort()
      if (!manifests.length) throw new Error(`没有可演练的备份：${dir} 里没有 manifest-*.json（先跑 course backup）`)
      const manifestFile = path.join(dir, manifests.at(-1))
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      const results = []
      for (const entry of manifest.files || []) {
        const file = path.join(dir, entry.file)
        if (!fs.existsSync(file)) { results.push({ file: entry.file, ok: false, detail: '文件不存在' }); continue }
        const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
        if (sha256 !== entry.sha256) { results.push({ file: entry.file, ok: false, detail: 'sha256 与清单不一致（文件被改过或截断）' }); continue }
        if (entry.kind === 'ledger') {
          // 真打开一次：复制到临时目录，避免"演练"顺手改了备份本身
          const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-drill-'))
          const copy = path.join(temp, 'ledger.sqlite')
          fs.copyFileSync(file, copy)
          const check = verifyLedgerSnapshot(copy)
          results.push({ file: entry.file, ok: check.ok, detail: check.ok ? `能打开且完整：${check.detail}` : check.detail })
          fs.rmSync(temp, { recursive: true, force: true })
          continue
        }
        if (entry.kind === 'library') {
          const check = verifyLibrarySnapshot(file)
          results.push({ file: entry.file, ok: check.ok, detail: check.ok ? `能解析：${check.detail}` : check.detail })
          continue
        }
        results.push({ file: entry.file, ok: true, detail: 'sha256 一致' })
      }
      const failed = results.filter(item => !item.ok)
      emit({
        drill: true,
        manifest: path.basename(manifestFile),
        generatedAt: manifest.generatedAt || null,
        files: results.length,
        failed: failed.length,
        results
      }, options)
      return failed.length ? 1 : 0
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const written = []

    const describe = (target, extra = {}) => {
      const bytes = fs.statSync(target).size
      const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      return { file: path.basename(target), bytes, sha256, ...extra }
    }

    // 1) 账本快照 + 立刻验证（能不能打开、完整不完整、有多少条记录）
    const ledgerTarget = path.join(dir, `ledger-${stamp}.sqlite`)
    const store = openStore(config.ledgerPath)
    let sourceCounts = null
    try {
      store.db.exec(`VACUUM INTO '${ledgerTarget.replace(/'/g, "''")}'`)
      sourceCounts = {
        tasks: Number(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n || 0),
        deliveries: Number(store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n || 0)
      }
    } finally {
      store.close()
    }
    const ledgerCheck = verifyLedgerSnapshot(ledgerTarget)
    written.push(describe(ledgerTarget, { kind: 'ledger', verified: ledgerCheck.ok, detail: ledgerCheck.detail, source: sourceCounts }))

    // 2) 站点发布库（发过哪些课次、内容指纹是什么，都在这里）
    const libraryPath = path.join(config.scratchRoot, 'site', 'library.json')
    if (fs.existsSync(libraryPath)) {
      const target = path.join(dir, `library-${stamp}.json`)
      fs.copyFileSync(libraryPath, target)
      const check = verifyLibrarySnapshot(target)
      written.push(describe(target, { kind: 'library', verified: check.ok, detail: check.detail }))
    }

    // 3) 清单：有了它，日后任意时刻都能回答这份备份还是不是好的
    const manifestPath = path.join(dir, `manifest-${stamp}.json`)
    const manifest = { generatedAt: new Date().toISOString(), host: os.hostname(), files: written }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    // 4) 异地：没配就明说（本地备份不叫备份），配了就必须成功
    const offsiteTemplate = String(env.COURSE_BACKUP_OFFSITE || '').trim()
    const offsite = { configured: Boolean(offsiteTemplate), command: offsiteTemplate, copied: [], failed: [] }
    if (offsiteTemplate) {
      for (const entry of [...written.map(item => path.join(dir, item.file)), manifestPath]) {
        const result = runOffsiteCopy(offsiteTemplate, entry)
        if (result.ok) offsite.copied.push(path.basename(entry))
        else offsite.failed.push({ file: path.basename(entry), detail: result.detail })
      }
    }

    // 5) 本地轮转：只留最近 keep 份（按文件名里的时间戳排序即按时间排序）
    const all = fs.readdirSync(dir)
      .filter(name => /^(ledger|library|manifest)-/.test(name))
      .sort()
    const removed = []
    const stamps = [...new Set(all.map(name => name.replace(/^(ledger|library|manifest)-/, '').replace(/\.(sqlite|json)$/, '')))].sort()
    for (const old of stamps.slice(0, Math.max(0, stamps.length - keep))) {
      for (const name of all.filter(item => item.includes(old))) {
        fs.rmSync(path.join(dir, name), { force: true })
        removed.push(name)
      }
    }

    const broken = written.filter(entry => entry.verified !== true)
    emit({
      dir,
      keep,
      written,
      removed,
      offsite: { ...offsite, hint: offsite.configured ? '' : '本地备份挡不住磁盘故障与误删：用 COURSE_BACKUP_OFFSITE 指向异地（rclone / scp / 对象存储）' },
      ok: broken.length === 0 && offsite.failed.length === 0
    }, options)
    return broken.length === 0 && offsite.failed.length === 0 ? 0 : 1
  }

  /** 打开快照验证它真的可用：完整性 + 能不能读出记录数。 */
  function verifyLedgerSnapshot(file) {
    try {
      const snapshot = openStore(file)
      try {
        const integrity = String(snapshot.db.prepare('PRAGMA integrity_check').get()?.integrity_check || '')
        const tasks = Number(snapshot.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n || 0)
        const deliveries = Number(snapshot.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n || 0)
        return { ok: integrity === 'ok', detail: `integrity=${integrity} tasks=${tasks} deliveries=${deliveries}` }
      } finally {
        snapshot.close()
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 发布库快照：能解析成数组、且每条记录都有 slug。 */
  function verifyLibrarySnapshot(file) {
    try {
      const records = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(records)) return { ok: false, detail: '不是记录数组' }
      const withSlug = records.filter(record => record && record.slug).length
      return { ok: withSlug === records.length, detail: `${withSlug}/${records.length} 条带 slug` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 把一份文件送到异地：模板里的 {} 替换成文件路径；超时或非零退出都算失败。 */
  function runOffsiteCopy(template, file) {
    const quoted = `'${file.replace(/'/g, "'\\''")}'`
    const command = template.split('{}').join(quoted)
    const result = spawnSync('/bin/sh', ['-c', command], { timeout: 120_000, encoding: 'utf8' })
    if (result.error) return { ok: false, detail: result.error.message }
    if (result.status !== 0) {
      return { ok: false, detail: `退出码 ${result.status}：${String(result.stderr || '').trim().slice(0, 200)}` }
    }
    return { ok: true, detail: '' }
  }

  /**
   * 清理：只删"原件"，而且必须在纯文本产物**通过校验**之后。
   *
   * 保留策略（用户的明确要求）：
   *   · 纯文本永久保留——转录稿、课件抽出的文字、笔记、简报、课次状态。它们小、可检索、是真正的资产。
   *   · 原件（视频/音频/PPT/PDF）只在**转换成功且校验通过**之后才删：
   *       - 媒体：转录稿存在、非空、且 sha256 与转录摘要里记录的一致；
   *       - 课件：slides.json 存在、页数 > 0、且确实抽到了文字。
   *     校验不通过一律保留，并在结果里说明原因——宁可占盘，不可丢原件。
   * 默认**只报告不删除**（dry-run），加 --apply 才真的删。
   */
  async function prune(options) {
    const apply = Boolean(options.flags?.has('apply'))
    const keepOriginals = Boolean(options.flags?.has('keep-originals'))
    const report = { apply, replays: [], materials: [], freedBytes: 0, keptBytes: 0, skipped: [] }
    const sizeOf = target => {
      try {
        const stat = fs.statSync(target)
        if (stat.isFile()) return stat.size
        return fs.readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0)
      } catch {
        return 0
      }
    }
    const remove = target => {
      const bytes = sizeOf(target)
      if (apply) fs.rmSync(target, { recursive: true, force: true })
      report.freedBytes += bytes
      return bytes
    }

    // 1) 课次目录里的媒体与分片
    const replaysRoot = path.join(config.scratchRoot, 'replays')
    for (const replayKey of fs.existsSync(replaysRoot) ? fs.readdirSync(replaysRoot) : []) {
      const dir = path.join(replaysRoot, replayKey)
      if (!fs.statSync(dir).isDirectory()) continue
      const transcriptPath = path.join(dir, 'transcript', 'raw-transcript.md')
      const summaryPath = path.join(dir, 'transcript', 'run-summary.json')
      const targets = [path.join(dir, 'output', 'media.mp4'), path.join(dir, 'fragments')].filter(item => fs.existsSync(item))
      if (!targets.length) continue

      if (keepOriginals) {
        report.skipped.push({ replayKey, reason: '配置为保留原件（COURSE_KEEP_MEDIA=1 或 --keep-originals）' })
        report.keptBytes += targets.reduce((total, item) => total + sizeOf(item), 0)
        continue
      }
      if (!fs.existsSync(transcriptPath) || !fs.existsSync(summaryPath)) {
        report.skipped.push({ replayKey, reason: '还没有转录稿，原件保留' })
        report.keptBytes += targets.reduce((total, item) => total + sizeOf(item), 0)
        continue
      }
      const transcript = fs.readFileSync(transcriptPath)
      const summary = safeJsonFile(summaryPath) || {}
      const actual = createHash('sha256').update(transcript).digest('hex')
      const expected = String(summary.transcriptChecksum || '')
      if (transcript.length < 500) {
        report.skipped.push({ replayKey, reason: `转录稿只有 ${transcript.length} 字节，不像完整结果，原件保留` })
        report.keptBytes += targets.reduce((total, item) => total + sizeOf(item), 0)
        continue
      }
      if (expected && actual !== expected) {
        report.skipped.push({ replayKey, reason: '转录稿校验和不符（文件被改过），原件保留' })
        report.keptBytes += targets.reduce((total, item) => total + sizeOf(item), 0)
        continue
      }
      const freed = targets.reduce((total, item) => total + remove(item), 0)
      report.replays.push({ replayKey, freedBytes: freed, verified: expected ? 'checksum' : 'size-only' })
    }

    // 2) 课件原件（文字已经抽出来并存成 slides/*.json）
    const materialsRoot = config.materialsRoot
    const walk = (dir, out = []) => {
      if (!fs.existsSync(dir)) return out
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, out)
        else out.push(full)
      }
      return out
    }
    const parsed = new Map(walk(materialsRoot).filter(file => file.endsWith('.json') && file.includes(`${path.sep}slides${path.sep}`))
      .map(file => [path.basename(file).replace(/\.json$/, ''), file]))
    for (const file of walk(materialsRoot)) {
      const ext = path.extname(file).toLowerCase()
      if (!['.pptx', '.ppt', '.pdf'].includes(ext)) continue
      const name = path.basename(file)
      const parsedPath = parsed.get(name)
      const deck = parsedPath ? safeJsonFile(parsedPath) : null
      const textLength = (deck?.slides || []).reduce((total, slide) => total + String(slide.text || '').length, 0)
      if (!deck || !deck.slideCount || textLength < 20) {
        report.skipped.push({ file: name, reason: '还没抽出可用文字，原件保留' })
        report.keptBytes += sizeOf(file)
        continue
      }
      const freed = remove(file)
      report.materials.push({ file: name, freedBytes: freed, slides: deck.slideCount, textChars: textLength })
    }

    report.freedHuman = formatBytes(report.freedBytes)
    report.keptHuman = formatBytes(report.keptBytes)
    if (apply) stderr(`已清理 ${report.freedHuman}（原件），保留纯文本产物与 ${report.keptHuman} 待确认原件`)
    else stderr(`预演：可清理 ${report.freedHuman}；加 --apply 才会真的删`)
    emit(report, options)
    return 0
  }

  /**
   * 人工恢复：把停下不动的课次放回可领取状态。
   *
   * 阶段不能"就地留着"：needs_attention 是终态，原地重置等于没恢复。
   * 没显式给 --stage 时按**已有产物**推断该回到哪一步——媒体在就回 downloaded，
   * 转录稿在就回 transcript_ready，笔记在就回 notes_ready。已经做过的活不重做。
   */
  function inferResumeStage(task = {}) {
    const artifacts = task.artifacts || {}
    if (artifacts.notePath) return 'notes_ready'
    if (artifacts.transcriptPath) return 'transcript_ready'
    if (artifacts.mediaPath) return 'downloaded'
    return 'discovered'
  }

  async function retry(options) {
    const replayKey = requireOption(options.options, 'replay-key', 'retry')
    const explicit = options.options.stage || ''
    const current = withLedger(store => store.getTask(replayKey))
    if (!current) throw new Error(`账本里没有这个课次：${replayKey}`)
    const stage = explicit || inferResumeStage(current)
    const task = withLedger(store => store.resetTask({ replayKey, stage }))
    stderr(`已重置 ${replayKey}：${current.stage} → ${task.stage}（按已有产物推断），失败计数归零，下一轮 cycle 会重新领取`)
    emit({ replayKey, from: current.stage, stage: task.stage, attempts: task.attempts }, options)
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
      // 转写：ASR 轮询在 Python 里，最长可能几十分钟，JS 侧没有续租时机 → 开长租约（见 claimForRun）
      const task = replayKey ? claimForRun(store, replayKey, workerId, { leaseSeconds: 5400 }) : null
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


  /**
   * 每日邮件日报。
   *
   * 用户的要求很具体：「每天早上 7 点告诉我前一天更新了哪些课程；没有更新就不发」，
   * 且「邮件的内容呈现要求更高」——所以正文只有表格与列表，没有长段摘要。
   * 它不依赖微信通道：那条路要用户先给机器人发消息，日报不该被一起拖死。
   */
  async function digest(options) {
    const date = options.options.date || previousDateKey(clockNow(), config.digest.timeZone)
    const store = openStore(config.ledgerPath)
    let tasks = []
    try {
      tasks = store.listTasks({ limit: 200 }).map(task => ({
        courseName: task.course_name,
        title: task.title,
        stage: task.stage,
        attempts: task.attempts,
        lastError: task.last_error,
        updatedAt: task.updated_at
      }))
      if (options.flags.has('retry-failed')) store.reviveFailedDeliveries()
    } finally {
      store.close()
    }
    let index = {}
    try { index = readSiteIndex(config.siteRoot) } catch { index = {} }

    const report = collectDigest({ date, index, tasks, timeZone: config.digest.timeZone })
    const html = renderDigestHtml(report, { siteOrigin: config.notify.publicUrl })
    const text = renderDigestText(report, { siteOrigin: config.notify.publicUrl })
    const subject = digestSubject(report)

    if (options.flags.has('dry-run')) {
      emit({ dryRun: true, subject, to: config.digest.to ? 'set' : 'missing', ...report, html, text }, options)
      return 0
    }
    if (!report.hasNews && !options.flags.has('force')) {
      emit({ skipped: true, reason: '昨天没有更新', date, subject }, options)
      stderr('昨天没有更新，按约定不发邮件。')
      return 0
    }
    const to = options.options.to || config.digest.to
    const result = await sendResendEmail({
      apiKey: config.digest.resendApiKey,
      from: config.digest.from,
      to,
      subject,
      html,
      text
    })
    emit({ sent: true, id: result.id, to: to ? 'set' : 'missing', subject, date, published: report.published.length }, options)
    return 0
  }

  /**
   * 缺课件提醒（每晚 20:00）。
   *
   * 与 07:00 日报同一条原则：**没有缺的就不发**。为什么单独一封：自动链路现在
   * "没有课件就不跑这一节"，课件缺不缺直接决定今晚会不会动——20:00 发出去，
   * 用户还有时间上传。正文只有一张表（课程 · 课次 · 状态 · 去上传）。
   *
   * 判据与 cycle 的拦截判据**是同一个**（materials 包的 listMaterials），
   * 否则会出现"邮件说缺、链路照跑"这种自相矛盾的状态。
   */
  async function pptReminder(options) {
    const store = openStore(config.ledgerPath)
    let tasks = []
    try {
      tasks = store.listTasks({ limit: 500 }).map(task => ({
        replayKey: task.replay_key,
        courseName: task.course_name,
        title: task.title,
        stage: task.stage
      }))
    } finally {
      store.close()
    }

    const missing = collectMissingMaterials({
      tasks,
      hasMaterials: task => lessonMaterials({
        course_name: task.courseName, title: task.title, replay_key: task.replayKey
      }).count !== 0
    })
    const date = dateKeyInTimeZone(clockNow(), config.digest.timeZone)
    const adminUrl = `${String(config.notify.publicUrl || '').replace(/\/+$/, '')}/admin`
    const subject = pptReminderSubject(missing, { date })
    const html = renderPptReminderHtml(missing, { adminUrl, date })
    const text = renderPptReminderText(missing, { adminUrl, date })

    if (options.flags.has('dry-run')) {
      emit({ dryRun: true, subject, to: config.digest.to ? 'set' : 'missing', missing, html, text }, options)
      return 0
    }
    if (!missing.length) {
      emit({ sent: false, skipped: true, reason: '没有缺课件的课次', date, checked: tasks.length }, options)
      stderr('没有缺课件的课次，按约定不发邮件。')
      return 0
    }

    const to = options.options.to || config.digest.to
    // 发送器可注入：测试用假 sender 核对收件人/标题/正文，不会真发一封邮件
    const send = injectedEmailSender || sendResendEmail
    const result = await send({
      apiKey: config.digest.resendApiKey,
      from: config.digest.from,
      to,
      subject,
      html,
      text
    })
    emit({
      sent: true, id: result.id, to: to ? 'set' : 'missing', subject, date,
      lessons: missing.length, missing
    }, options)
    stderr(`已发出缺课件提醒：${missing.length} 节`)
    return 0
  }

  /**
   * 以 stdio 启动课程笔记 MCP 服务器（给 Claude Code / DSH 等 AI 客户端挂载，见 docs/12）。
   *
   * 为什么挂在 CLI 上而不是单独再发一个可执行文件：客户端配置里只写
   * `course mcp --library ~/.course-worker/site/library.json` 一行就够了，
   * systemd / 进程管理器也是托管同一条命令；协议与数据分层都在 @course/notes-mcp，
   * 这里只做两件事——把配置解析出来、把 stdio 接上。
   *
   * 这个命令会一直运行，直到客户端关闭 stdin（正常退出码 0）。
   */
  async function mcp(options) {
    const { createNotesService, createSource, resolveSettings, runStdioServer } = await import('@course/notes-mcp')
    const settings = resolveSettings({
      env,
      overrides: {
        library: options.options.library,
        origin: options.options.origin,
        ttl: options.options.ttl
      }
    })
    const runServer = injectedMcpServer || runStdioServer
    const exitCode = await runServer({
      settings,
      service: createNotesService({ source: createSource(settings) })
    })
    return Number.isInteger(exitCode) ? exitCode : 0
  }

  // 键名必须与 CLI 命令名一致：'admin-passwd' 带连字符，不能用标识符简写
  return {
    doctor, discover, download, transcribe, notes, materials, balance, publish,
    notify, cycle, verify, status, retry, prune, backup, digest, 'ppt-reminder': pptReminder,
    brief: briefRun, onepage: onepageRun, sourcemap: sourceMapRun, integrate: integrateRun,
    artifacts: artifactsRun, reconcile: reconcileRun, embed: embedRun,
    'admin-passwd': adminPassword, mcp
  }
}

export const USAGE = `用法：course <命令> [选项]

命令：
  doctor                                   检查依赖与凭据是否齐备
  status     [--stage <阶段>] [--limit <条数>]
                                           查看账本：各阶段任务数与任务明细
  discover   [--course <名称>] [--course-key <键>] [--out <文件>] [--no-materials-notice]
                                           登录教学网，列出本学期课程与课堂实录
  download   --course-key <键> --replay-key <键> [--course <名称>] [--title <标题>]
                                           下载一条回放的媒体（HLS 分片 → MP4）
  transcribe --media <文件> --course <名称> --lesson <课次> [--replay-key <键>] [--chunk-minutes <分钟>] [--output-dir <目录>]
                                           调用 Paraformer 转录（分片 + R2 中转 + 断点续跑）
  notes      --transcript <文件> --course <名称> --lesson <课次> [--replay-key <键>] [--output-dir <目录>]
             [--auto-approve-outline 0|1] [--max-steps <步数>] [--resume]
             [--concurrency <条数>] [--review-concurrency <条数>]
             [--node-split-chars <字数>] [--node-split-lines <行数>] [--outline-nodes <个数>]
             [--write-units <次数>（默认 1：一次写完）] [--target-chars <字数>]
             [--revise <模块 id 或标题>] [--request <修改要求>] [--ignore-cost-window 1] [--ocr]
                                           从转录稿生成单课笔记（大纲 → 节点 → 写作 → 审查 → 拼装 → 终审）
                                           每步把课次状态写入 <输出目录>/lesson-state.json；--resume 从该状态续跑
                                           默认不设步数上限；并发默认写 1 + 审 2（合计 3 条）
                                           模块结构由大纲决定（两小时课 5—8 个模块）；
                                           --write-units 只决定分几次模型调用写完（1 = 一次写完）；
                                           --revise 只重写指定模块（其余模块草稿保留），需配合 --request
                                           --ocr 强制先补课件的图片文字（图片版课件会自动补，不必加）
  materials  --file <课件> --course <名称> --lesson <课次> [--name <文件名>]
             [--course-scope] [--applies-to <课次,课次>] [--replay-key <键>]
             [--ocr] [--ocr-max-pages <张数>] [--ocr-concurrency <条数>]
                                           归档并解析课件；--ocr 同时识别图片里的文字
             --ocr --course <名称> [--lesson <课次>]  把还有图没识别的课件补齐
                                           （图片版课件：整页是图或扫描件，xml 里没有文字）
             [--course <名称> --lesson <课次>] [--replay-key <键>]   列出该课次会用到的课件
             --ingest                                 归档收件箱里的文件（认得出课程与课次就归档，
                                           认不出停到 _unassigned；不必记命名规则）
                                           教学网上没有课件：课件由用户上传。归属三种：
                                           本课次（默认）／--course-scope 全课程通用／
                                           --applies-to 跨课次共用（上一讲的 PPT 这讲接着用）。
                                           认不出归属的进 _unassigned，不猜，等你在管理台指定。
                                           （更省事的方式是直接在管理台上传：那里从账本
                                           列出课程与课次，选一下就行，文件名随便叫）
  admin-passwd [--set <新密码> | --set-stdin] [--clear] [--status]
                                           管理台密码：重设 / 清除 / 查看状态。
                                           忘记密码时在服务器上跑这个（见 docs/10）
  balance    [--threshold <元>]                   查两个付费 API 的余额（DeepSeek 官方接口；
                                           阿里云余额需账号 AK/SK，见 docs/07）
  onepage    --from <笔记.md 或所在目录> --course <名称> --lesson <课次> [--out <目录>]
                                           生成一页纸摘要（A4 一张，模型写，输出 onepage.json）
  reconcile  [--notify] [--site-root <站点目录>] [--library <library.json>]
                                           只报异常的对账：卡住的任务 / 失败或过期的通知 / 与正文不同源的
                                           派生产物 / 缺课件 / 余额偏低。没有异常时一个字都不说；
                                           有阻塞项才返回 1（交给 cron 告警），--notify 才排通知
  embed      [--site-root <站点目录>] [--library <library.json>] [--out <embeddings.json>]
             --max-cost <元> [--model <名称>]
                                           建立/更新语义检索的向量索引（一小节一条向量，带内容指纹）：
                                           指纹没变的小节复用旧向量，只对新出现/改过的小节花钱；
                                           必须给 --max-cost（预算纪律），实际用量以接口返回为准
  artifacts  [--site-root <站点目录>] [--library <library.json>] [--integrations <目录>]
                                           列出所有派生产物（简报/一页纸/章级整合）与当前正文的同源情况：
                                           新鲜 / 失效 / 未绑定 / 孤立。只报告，不自动重做
  integrate  --course <名称> [--lessons <课次,课次>] [--topic <主题>]
             [--library <library.json>] [--out-dir <目录>]
             [--save [--id <稳定ID>] [--manifest <清单.json>]]
                                           章级整合：确定性抽取跨课次概念 / 问题线 / 论证推进 / 待核继承；
                                           每一行都带出处，不花钱、不发通知。
                                           --save 把“本次实际解析到的明确课次”写入长期清单；
                                           必须显式给 --topic，后续不会因同课程新增课次而自动扩张范围
             --configured [--id <稳定ID>] [--course <名称>] [--manifest <清单.json>]
                                           按长期清单重建整合；不给 --id 时重建所有启用项。
                                           普通 publish 修改正文后，也会免费重建包含该课次的配置项
  sourcemap  [--course <名称>] [--lesson <课次>] [--site-root <站点目录>] [--library <library.json>]
             [--write] [--show] [--model --max-cost-cny <元>]
                                           给已发布的一页纸补来源映射（只补映射，正文一个字不动）。
                                           默认免费路径：只认逐字引用 / 块里点了节名的对照。
                                           --model 按**课次**各调一次模型补剩下的块，必须给 --max-cost-cny，
                                           超上限立刻停；摘录仍逐字核对，抄错的那条作废
  brief      --from <笔记.md 或所在目录> --course <名称> --lesson <课次> [--out <目录>]
             [--replay-key <键>]
                                           只重跑简报这一步：产出简报与首页用的关键词
                                           （笔记跑完后再补关键词时用，不必重跑整条流水线）
                                           产物带 sourceChecksum（所依据正文的 SHA-256），发布时校验
  publish    --from <笔记目录> [--course <名称>] [--lesson <课次>] [--out <站点目录>] [--origin <域名>] [--no-purge]
             [--replay-key <键>] [--lesson-date <YYYY-MM-DD>]
             --rebuild [--write-back]      只按发布库重写站点（换模板/改样式后重建，
                                           不跑模型、不发通知；--write-back 同时把派生字段写回库）
             --migrate-site-root --yes      一次性把旧实体 site/ 迁成 versioned release + symlink。
                                           生产上先停 public/admin 两个站点进程再执行；
                                           完成后每次发布均“完整快照校验 → 原子切换”，旧版可回滚
             --no-notify                   更新站点但这一次不排推送
             --regenerate-derived          简报/一页纸与当前正文对不上时用模型重新生成
                                           （默认：直接中止发布——串课的简报比发布失败更糟；
                                           原因与输出 JSON 里的 reason 都会写明）
                                           把笔记发布到站点，内容变化时排入一条微信通知
             --lesson-date                 这一节实际是哪天上的（排序、日期列、上一讲/下一讲都按它）；
                                           不传时依次取课次标题里的日期、账本里的排课时间、
                                           已有的 lessonDate，最后才用首次发布那天（会标注来源）
  notify     [--probe] [--loop] [--max-items <条数>] [--retry-failed]
                                           把账本里排队的通知发到微信；--probe 只验证通道；
                                           --retry-failed 把发送失败的通知放回队列重发
  retry      --replay-key <键> [--stage <阶段>]    人工恢复：清空失败计数并等待重新领取。
                                           不给 --stage 时按已有产物推断回到哪一步
                                           （媒体在→downloaded，转录稿在→transcript_ready）
  digest     [--date <YYYY-MM-DD>] [--to <邮箱>] [--dry-run] [--force]
                                           每日邮件日报：前一天新发布/更新的课次、需要处理的
                                           课次。**没有更新就不发**（--force 可强制）。
                                           走 Resend；与微信通道相互独立
  ppt-reminder [--to <邮箱>] [--dry-run]
                                           缺课件提醒：列出所有还没有课件的课次
                                           （课程 · 课次 · 状态 · 管理台链接），每天 20:00 发。
                                           **一节都不缺就不发**。与 07:00 日报同一套邮件样式
  backup     [--keep <份数>]                     账本与站点库的一致性快照：写完即验证（integrity
                                           + sha256 清单）；配 COURSE_BACKUP_OFFSITE 时同步送异地
                                           （模板里的 {} 会替换成文件路径，失败则退出码非 0）
  prune      [--apply] [--keep-originals]         清理原件：纯文本（转录稿/课件文字/笔记）
                                           永久保留；视频、音频、PPT 原文件只在转换成功
                                           且校验通过之后才删。默认只报告不删除
  cycle      [--max-tasks <条数>] [--course <名称>] [--replay-key <键>] [--max-steps <步数>]
             [--auto-approve-outline 0|1] [--require-materials 0|1]
                                           一轮完整链路：扫描 → 逐条推进各阶段 → 投递通知
                                           --max-steps / --auto-approve-outline 会透传给 notes 阶段
                                           --require-materials 默认 1：自动选任务时跳过
                                           "该课次没有任何课件"的课次（不推进阶段，只留一行日志）；
                                           0 = 无课件也照跑。指定 --replay-key 的单节课
                                           不受这条限制（显式点名就是"我现在就要跑"）
  verify     [--course <名称>] [--replay-key <键>] [--out <站点目录>] [--yes]
                                           验收：默认只检查前置条件；加 --yes 才真跑一轮
                                           完整链路（下载、转写计费、写笔记、可能推送读者）
  mcp        [--library <发布库.json>] [--origin <站点域名>] [--ttl <秒>]
                                           以 stdio 启动课程笔记 MCP 服务器，供 Claude Code /
                                           DSH 等客户端挂载：课程 → 课次 → 检索 → 正文
                                           分层取用，避免把全部笔记灌进上下文。
                                           默认读本地发布库（COURSE_LIBRARY 指向
                                           site/library.json，优先）；没配时走远程站点
                                           （COURSE_SITE_ORIGIN，默认 course.law-tech.dev）。
                                           命令会一直运行到客户端关闭 stdin；见 docs/12

账本：download / transcribe 若带 --replay-key 且账本中已有该回放，会先领取任务，
成功后推进阶段；失败则记录原因并退避 5 分钟。账本没有该回放时按独立运行处理。

通用选项：
  --json                                   以 JSON 输出（默认即为 JSON）
  --help                                   显示本帮助

环境变量：见 docs/01-模块化方案.md。密钥只从环境读取，不接受命令行传入。
`