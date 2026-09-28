import fs from 'node:fs'
import path from 'node:path'

/**
 * 工件依赖失效记录（Phase 5.2 C1）。
 *
 * 每次生成派生视图（简报 / 一页纸 / 章级整合）时，它都记下了"我绑在哪一版正文上"。
 * 但**发布时的校验只在发布那一刻生效**：正文后来重写了、一节笔记重跑了，那些旧产物
 * 就静静地烂在磁盘上，没人知道它们已经与正文不一致——直到某次发布被"不同源"卡住，
 * 或者更糟：它们已经不参与发布了，但人还在看。
 *
 * 这个模块做的事只有一件：**把账算清楚**——现在有哪些产物、各自绑在哪一版、还新不新鲜。
 * 它只报告不改写、不自动重生成（重做要花钱或要人定范围，那是人的决定）。
 *
 * 四种状态：
 *   fresh   —— 绑定指纹与当前正文一致
 *   stale   —— 正文变了（这是要人看一眼的）
 *   unbound —— 老数据没有绑定字段（历史遗留，提示但不拦）
 *   orphan  —— 库里已经没有这一节课了（删课/改名留下的产物）
 */

const str = value => String(value ?? '')

/** 从一个目录里找产物文件：<目录>/brief.json、<目录>/onepage.json。 */
function findInDirs (dirs, fileName) {
  const found = []
  for (const dir of dirs) {
    const file = path.join(dir, fileName)
    if (fs.existsSync(file)) found.push(file)
  }
  return found
}

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 扫描产物并与当前发布库比对。
 *
 * dirs 是"可能放产物的目录"（笔记输出目录、scratch 根下的各个课次目录…）；
 * records 是发布库（含每节课的 checksum）。两者都传进来，函数本身不猜路径。
 */
export function scanArtifactInventory ({ dirs = [], records = [], integrationDir = '' } = {}) {
  const bySlug = new Map(records.map(record => [record.slug, record]))
  const byLesson = new Map()
  for (const record of records) {
    byLesson.set(`${str(record.courseName)}|${str(record.lessonTitle)}`, record)
  }
  const items = []

  const push = (kind, file, artifact, match) => {
    const current = match ? str(match.checksum) : ''
    const bound = str(artifact?.sourceChecksum || artifact?.checksum || '')
    let status = 'fresh'
    if (!match) status = 'orphan'
    else if (!bound) status = 'unbound'
    else if (bound !== current) status = 'stale'
    items.push({
      kind,
      file,
      courseName: match?.courseName || str(artifact?.course) || '',
      lessonTitle: match?.lessonTitle || str(artifact?.lesson) || '',
      slug: match?.slug || '',
      boundChecksum: bound.slice(0, 12),
      currentChecksum: current.slice(0, 12),
      status
    })
  }

  const matchOf = artifact => {
    if (!artifact) return null
    if (artifact.slug && bySlug.has(artifact.slug)) return bySlug.get(artifact.slug)
    return byLesson.get(`${str(artifact.course)}|${str(artifact.lesson)}`) || null
  }

  for (const file of findInDirs(dirs, 'brief.json')) push('brief', file, readJson(file), matchOf(readJson(file)))
  for (const file of findInDirs(dirs, 'onepage.json')) push('onepage', file, readJson(file), matchOf(readJson(file)))

  // 章级整合：绑定的是"每个课次的内容指纹"，所以逐个课次比
  if (integrationDir && fs.existsSync(integrationDir)) {
    for (const name of fs.readdirSync(integrationDir).filter(item => item.endsWith('.json'))) {
      const file = path.join(integrationDir, name)
      const plan = readJson(file)
      if (!plan || plan.kind !== 'course-integration') continue
      const lessons = Array.isArray(plan.lessons) ? plan.lessons : []
      const staleLessons = lessons.filter(item => {
        const record = byLesson.get(`${str(plan.course)}|${str(item.lessonTitle)}`)
        return !record || str(record.checksum) !== str(item.checksum)
      })
      items.push({
        kind: 'integration',
        file,
        courseName: str(plan.course),
        lessonTitle: lessons.map(item => item.lessonTitle).join(' / '),
        slug: '',
        boundChecksum: lessons.map(item => str(item.contentFingerprint)).join(','),
        currentChecksum: lessons.map(item => {
          const record = byLesson.get(`${str(plan.course)}|${str(item.lessonTitle)}`)
          return record ? 'ok' : 'missing'
        }).join(','),
        status: staleLessons.length ? 'stale' : 'fresh',
        staleLessons: staleLessons.map(item => item.lessonTitle)
      })
    }
  }

  const counts = { fresh: 0, stale: 0, unbound: 0, orphan: 0 }
  for (const item of items) counts[item.status] += 1
  return { items, counts, total: items.length }
}

/** 给人看的一行行报告。 */
export function formatInventory (inventory = { items: [], counts: {} }) {
  if (!inventory.items.length) return '工件依赖：还没发现任何派生视图（简报/一页纸/整合）。'
  const lines = [`工件依赖：共 ${inventory.total} 件——新鲜 ${inventory.counts.fresh}，失效 ${inventory.counts.stale}，未绑定 ${inventory.counts.unbound}，孤立 ${inventory.counts.orphan}`]
  for (const item of inventory.items) {
    const where = [item.courseName, item.lessonTitle].filter(Boolean).join(' · ')
    const detail = item.status === 'stale' && item.staleLessons?.length
      ? `（${item.staleLessons.join('、')} 的正文变了）`
      : (item.status === 'fresh' ? '' : `（绑定 ${item.boundChecksum || '无'}，当前 ${item.currentChecksum || '无'}）`)
    lines.push(`  [${item.status}] ${item.kind} ${where} ${detail}｜${item.file}`)
  }
  return lines.join('\n')
}
