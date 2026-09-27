/**
 * 每日邮件日报。
 *
 * 用户的原话：「每天早上 7 点定时发送消息给我，告诉我前一天更新了哪些课程；
 * 如果没有更新课程，就不用发」。以及「邮件这种呈现内容的要求会更高」——
 * 所以正文只用列表与表格，不写长段摘要。
 *
 * 为什么单独一个模块：它不该依赖微信通道是否可用。微信机器人那条路要求
 * "用户最近给机器人发过消息"，发不出去时不该把日报也一起拖死。
 *
 * 发信走 Resend（用户旧系统就用它，law-tech.dev 的域名已经验证过）。
 */
/** 北京时间（用户在中国，日报也按北京时间算"昨天"）。 */
export const DIGEST_TIME_ZONE = 'Asia/Shanghai'

export function dateKeyInTimeZone(date = new Date(), timeZone = DIGEST_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
}

/** 用固定时区算「昨天」，而不是用本机时区——服务器在 UTC 跑时不该差一天。 */
export function previousDateKey(now = new Date(), timeZone = DIGEST_TIME_ZONE, offsetDays = 1) {
  const shifted = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000)
  return dateKeyInTimeZone(shifted, timeZone)
}

const localDay = (value, timeZone = DIGEST_TIME_ZONE) => {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return dateKeyInTimeZone(date, timeZone)
}

/**
 * 汇总某一天的变化。
 *
 * 只统计**读者能感知到的事**：新发布的笔记、新发现的课次、卡住需要人处理的课次。
 * 运行日志、阶段计数这些我们自己看的东西不进日报。
 */
export function collectDigest({ date, index = {}, tasks = [], timeZone = DIGEST_TIME_ZONE } = {}) {
  const notes = Array.isArray(index.notes) ? index.notes : []
  const published = notes
    .filter(note => localDay(note.publishedAt, timeZone) === date)
    .map(note => ({
      courseName: note.courseName || '',
      lessonTitle: note.lessonTitle || '',
      slug: note.slug || '',
      chars: Number(note.chars ?? String(note.markdown || '').length) || 0,
      readMinutes: note.readMinutes || 0,
      briefing: (note.brief && note.brief.briefing) || note.summary || '',
      keyPoints: (note.brief && note.brief.keyPoints) || []
    }))

  const discovered = tasks
    .filter(task => localDay(task.updatedAt, timeZone) === date && task.stage === 'discovered')
    .map(task => ({ courseName: task.courseName || '', title: task.title || '' }))

  const problems = tasks
    .filter(task => (task.stage === 'needs_attention' || task.stage === 'failed'))
    .map(task => ({
      courseName: task.courseName || '',
      title: task.title || '',
      stage: task.stage,
      attempts: task.attempts || 0,
      lastError: String(task.lastError || '').slice(0, 160)
    }))

  const inFlight = tasks.filter(task => !['published', 'discovered', 'completed', 'needs_attention', 'failed'].includes(task.stage)).length
  const waiting = tasks.filter(task => task.stage === 'discovered').length

  return { date, published, discovered, problems, inFlight, waiting, hasNews: published.length + discovered.length > 0 }
}

const escapeHtml = value => String(value == null ? '' : value)
  .replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))

/** 一句话摘要压到 60 字：邮件里不需要整段简报。 */
const shortBrief = value => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= 96) return text
  const cut = text.slice(0, 96)
  const stop = cut.lastIndexOf('。')
  return `${stop > 60 ? cut.slice(0, stop + 1) : cut}…`
}

export function renderDigestText(digest, { siteOrigin = 'https://course.law-tech.dev' } = {}) {
  const lines = [`课程笔记日报 · ${digest.date}`, '']
  if (!digest.hasNews) {
    lines.push('昨天没有新的课次或笔记更新。')
  }
  if (digest.published.length) {
    lines.push(`新笔记 ${digest.published.length} 篇：`)
    for (const note of digest.published) {
      lines.push(`- ${note.courseName} · ${note.lessonTitle}（${note.chars} 字 · 约 ${note.readMinutes} 分钟）`)
      if (note.briefing) lines.push(`  ${shortBrief(note.briefing)}`)
      lines.push(`  ${siteOrigin}/${note.slug}.html`)
    }
    lines.push('')
  }
  if (digest.discovered.length) {
    lines.push(`新发现待处理 ${digest.discovered.length} 节：`)
    digest.discovered.forEach(item => lines.push(`- ${item.courseName} · ${item.title}`))
    lines.push('')
  }
  if (digest.problems.length) {
    lines.push(`需要处理 ${digest.problems.length} 节：`)
    digest.problems.forEach(item => lines.push(`- ${item.courseName} · ${item.title}（${item.stage}，已尝试 ${item.attempts} 次）${item.lastError ? `：${item.lastError}` : ''}`))
    lines.push('')
  }
  lines.push(`队列：${digest.waiting} 节待处理 · ${digest.inFlight} 节进行中`)
  return lines.join('\n')
}

/**
 * 邮件表格样式。
 *
 * 邮件客户端对 CSS 支持有限，所以用最朴素的内联样式与 table 布局——
 * 花哨的东西在 Gmail / QQ 邮箱 / 微信内置浏览器里表现不一致。
 * 日报与缺课件提醒共用这一份，避免两封邮件的表格长得不一样。
 */
const EMAIL_CELL = 'padding:8px 10px;border-bottom:1px solid #e8e8ed;vertical-align:top;font-size:14px'
const EMAIL_HEAD = 'padding:8px 10px;border-bottom:1px solid #d2d2d7;text-align:left;font-size:12px;color:#6e6e73;font-weight:600'

/** HTML 版：只用列表与表格。 */
export function renderDigestHtml(digest, { siteOrigin = 'https://course.law-tech.dev' } = {}) {
  const cell = EMAIL_CELL
  const head = EMAIL_HEAD
  const rows = digest.published.map(note => `
    <tr>
      <td style="${cell}">${escapeHtml(note.courseName)}</td>
      <td style="${cell}"><a href="${escapeHtml(`${siteOrigin}/${note.slug}.html`)}" style="color:#2f6f61">${escapeHtml(note.lessonTitle)}</a></td>
      <td style="${cell};color:#6e6e73;white-space:nowrap">${note.chars} 字</td>
      <td style="${cell};color:#6e6e73;white-space:nowrap">约 ${note.readMinutes} 分钟</td>
    </tr>`).join('')

  const points = digest.published
    .filter(note => note.keyPoints.length)
    .map(note => `<li style="margin:0 0 6px"><strong>${escapeHtml(note.lessonTitle)}</strong><ul style="margin:4px 0 0;padding-left:18px;color:#454b52">${
      note.keyPoints.map(point => `<li style="margin:0 0 2px">${escapeHtml(point)}</li>`).join('')
    }</ul></li>`).join('')

  const problems = digest.problems.map(item => `
    <tr>
      <td style="${cell}">${escapeHtml(item.courseName)}</td>
      <td style="${cell}">${escapeHtml(item.title)}</td>
      <td style="${cell};color:#b3261e">${escapeHtml(item.stage)}（${item.attempts} 次）</td>
      <td style="${cell};color:#6e6e73">${escapeHtml(item.lastError)}</td>
    </tr>`).join('')

  return `<!doctype html><html><body style="margin:0;background:#fbfbfd;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1d1d1f">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px">
    <h1 style="font-size:20px;margin:0 0 4px">课程笔记日报</h1>
    <p style="margin:0 0 20px;color:#6e6e73;font-size:13px">${escapeHtml(digest.date)} · 共 ${digest.published.length} 篇新笔记 · 队列 ${digest.waiting} 节待处理</p>
    ${digest.published.length ? `<table style="width:100%;border-collapse:collapse;margin-bottom:22px"><thead><tr><th style="${head}">课程</th><th style="${head}">课次</th><th style="${head}">篇幅</th><th style="${head}">阅读</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${points ? `<h2 style="font-size:15px;margin:0 0 10px">每篇的三条要点</h2><ul style="margin:0 0 22px;padding-left:18px;font-size:14px">${points}</ul>` : ''}
    ${digest.discovered.length ? `<h2 style="font-size:15px;margin:0 0 8px">新发现待处理 ${digest.discovered.length} 节</h2><ul style="margin:0 0 22px;padding-left:18px;font-size:14px">${digest.discovered.map(item => `<li style="margin:0 0 4px">${escapeHtml(item.courseName)} · ${escapeHtml(item.title)}</li>`).join('')}</ul>` : ''}
    ${digest.problems.length ? `<h2 style="font-size:15px;margin:0 0 8px">需要处理 ${digest.problems.length} 节</h2><table style="width:100%;border-collapse:collapse;margin-bottom:22px"><thead><tr><th style="${head}">课程</th><th style="${head}">课次</th><th style="${head}">状态</th><th style="${head}">原因</th></tr></thead><tbody>${problems}</tbody></table>` : ''}
    <p style="margin:0;color:#86868b;font-size:12px">没有更新就不发这封邮件。管理台：<a href="${escapeHtml(`${siteOrigin}/admin`)}" style="color:#2f6f61">${escapeHtml(siteOrigin)}/admin</a></p>
  </div></body></html>`
}

/** 通过 Resend 发信。返回 { id } 或抛错（错误信息里不带密钥）。 */
export async function sendResendEmail({
  apiKey, from, to, subject, html, text, fetchImpl = fetch, timeoutMs = 20_000
} = {}) {
  if (!apiKey) throw new Error('未配置 RESEND_API_KEY')
  if (!from) throw new Error('未配置发件人（COURSE_DIGEST_FROM）')
  const recipients = (Array.isArray(to) ? to : [to]).map(item => String(item || '').trim()).filter(Boolean)
  if (!recipients.length) throw new Error('未配置收件人（COURSE_DIGEST_TO）')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: recipients, subject, html, text }),
      signal: controller.signal
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}：${body.slice(0, 300)}`)
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}
    return { id: parsed?.id || '', raw: body.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 缺课件提醒（每晚 20:00）。
 *
 * 为什么单独一封：自动链路现在是"没有课件就不跑这一节"，课件缺不缺直接决定
 * 这一节今晚会不会动。20:00 发出，留出上传的时间。
 *
 * 与 07:00 日报同一条原则：**没有缺的就不发**（宁可不打扰，也不发一封空邮件）。
 * 正文与日报同一套表格样式，只有"课程 · 课次 · 状态 · 去上传"四列，
 * 不写解释系统自身的元文案。
 */

/** 跑完的课次不再提醒：补课件对已经发布/完成的课次没有意义。 */
const REMINDER_DONE_STAGES = ['published', 'completed']

/** 阶段 → 人话。账本里的阶段名是我们自己的词汇，邮件里要写用户看得懂的。 */
export const STAGE_LABELS = {
  discovered: '已发现，等待处理',
  queued: '排队中',
  downloading: '下载中',
  downloaded: '已下载，等转录',
  transcribing: '转录中',
  transcript_ready: '已转写，等写笔记',
  building_textpack: '整理文本中',
  writing: '写笔记中',
  notes_ready: '笔记已就绪，等发布',
  publishing: '发布中',
  needs_attention: '需要人工处理',
  failed: '失败',
  notifying: '通知中',
  completed: '已完成',
  published: '已发布'
}

export function stageLabel(stage) {
  return STAGE_LABELS[String(stage || '')] || String(stage || '未知')
}

/**
 * 挑出"还没有课件、且还没跑完"的课次。
 *
 * @param hasMaterials 由调用方注入（materials 包的 listMaterials）；全课程通用与
 *                     跨课次共用的课件在那边已经算作"有"，这里不重复判断。
 */
export function collectMissingMaterials({ tasks = [], hasMaterials = () => false } = {}) {
  return tasks
    .filter(task => task && task.replayKey && task.courseName && task.title)
    .filter(task => !REMINDER_DONE_STAGES.includes(task.stage))
    .filter(task => !hasMaterials(task))
    .map(task => ({
      replayKey: task.replayKey,
      courseName: task.courseName || '',
      lessonTitle: task.title || '',
      stage: task.stage || '',
      stageLabel: stageLabel(task.stage)
    }))
    .sort((left, right) => String(`${left.courseName}${left.lessonTitle}`)
      .localeCompare(String(`${right.courseName}${right.lessonTitle}`), 'zh'))
}

/** 提醒标题：几节、哪天，一眼够用。 */
export function pptReminderSubject(list, { date = '' } = {}) {
  const items = Array.isArray(list) ? list : []
  return `缺课件提醒${date ? ` · ${date}` : ''} · ${items.length} 节待上传`
}

export function renderPptReminderText(list, { adminUrl = '', date = '' } = {}) {
  const items = Array.isArray(list) ? list : []
  const lines = [`缺课件提醒${date ? ` · ${date}` : ''}`, '']
  lines.push(`这 ${items.length} 节还没有课件，补齐后夜里才会自动跑笔记：`, '')
  for (const item of items) {
    lines.push(`- ${item.courseName} · ${item.lessonTitle}（${item.stageLabel || stageLabel(item.stage)}）`)
  }
  if (adminUrl) lines.push('', `上传课件：${adminUrl}`)
  return lines.join('\n')
}

/** HTML 版：与日报同一套表格样式（内联样式 + table，邮件客户端才认）。 */
export function renderPptReminderHtml(list, { adminUrl = '', date = '' } = {}) {
  const items = Array.isArray(list) ? list : []
  const rows = items.map(item => `
    <tr>
      <td style="${EMAIL_CELL}">${escapeHtml(item.courseName)}</td>
      <td style="${EMAIL_CELL}">${escapeHtml(item.lessonTitle)}</td>
      <td style="${EMAIL_CELL};color:#6e6e73;white-space:nowrap">${escapeHtml(item.stageLabel || stageLabel(item.stage))}</td>
      <td style="${EMAIL_CELL}">${adminUrl ? `<a href="${escapeHtml(adminUrl)}" style="color:#2f6f61">去上传</a>` : ''}</td>
    </tr>`).join('')

  return `<!doctype html><html><body style="margin:0;background:#fbfbfd;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1d1d1f">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px">
    <h1 style="font-size:20px;margin:0 0 4px">缺课件提醒</h1>
    <p style="margin:0 0 20px;color:#6e6e73;font-size:13px">${escapeHtml(date)} · 这 ${items.length} 节还没有课件，补齐后夜里才会自动跑笔记</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:22px">
      <thead><tr><th style="${EMAIL_HEAD}">课程</th><th style="${EMAIL_HEAD}">课次</th><th style="${EMAIL_HEAD}">状态</th><th style="${EMAIL_HEAD}">管理台</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${adminUrl ? `<p style="margin:0;color:#86868b;font-size:12px">管理台：<a href="${escapeHtml(adminUrl)}" style="color:#2f6f61">${escapeHtml(adminUrl)}</a></p>` : ''}
  </div></body></html>`
}

/** 日报标题：一眼看出昨天值不值得点开。 */
export function digestSubject(digest) {
  if (!digest.hasNews) return `课程笔记日报 · ${digest.date}（无更新）`
  const parts = []
  if (digest.published.length) parts.push(`${digest.published.length} 篇新笔记`)
  if (digest.discovered.length) parts.push(`${digest.discovered.length} 节新课`)
  return `课程笔记日报 · ${digest.date} · ${parts.join(' · ')}`
}
