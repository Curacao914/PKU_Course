#!/usr/bin/env node
/**
 * 发布库体检：把"一条记录该有的自我一致性"一次性查完。
 *
 * 为什么要单独有个工具：发布库（site/library.json）是站点的唯一数据源，而它由好几步
 * 分别写过——笔记正文来自 course publish，简报与一页纸是派生物，日期与校验和是后补的。
 * 出过的真实故障全部发生在这里：同一门课几节课共用一段简报（派生物按目录存放，串课）、
 * 日期被重新发布刷成当天、派生物与正文对不上却照样挂上站点。
 * 这几件事都不是"看一眼就知道"的，所以做成可重复跑的体检，而不是靠人肉抽查。
 *
 * 用法：
 *   node tools/verify-library.mjs [library.json 路径]
 * 退出码：0 = 全部通过；1 = 有硬错误。软提示（历史数据未绑定）只打印，不影响退出码。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_LIBRARY = path.join(process.env.HOME || '', '.course-worker', 'site', 'library.json')
const file = path.resolve(process.argv[2] || process.env.COURSE_LIBRARY || DEFAULT_LIBRARY)

const checksumOf = markdown => crypto.createHash('sha256').update(String(markdown || ''), 'utf8').digest('hex')
const short = value => String(value || '').slice(0, 36)

function load() {
  if (!fs.existsSync(file)) {
    console.error(`找不到发布库：${file}`)
    console.error('提示：`scp ubuntu@<host>:~/.course-worker/site/library.json .` 之后再跑，或把路径作为参数传入。')
    process.exit(1)
  }
  const records = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(records)) {
    console.error('发布库应当是一个数组')
    process.exit(1)
  }
  return records
}

const errors = []
const notes = []
const records = load()

console.log(`发布库：${file}`)
console.log(`记录数：${records.length}`)
console.log('')

for (const record of records) {
  const label = `${record.courseName || '（课程缺名）'} · ${record.lessonTitle || '（课次缺名）'}`
  // 1) 身份与正文
  for (const field of ['slug', 'courseName', 'lessonTitle', 'markdown']) {
    if (!record[field]) errors.push(`${label}：缺少 ${field}`)
  }
  // "课程："是空的说明正文是在拿不到课程身份的那一步拼出来的（真实出现过）
  if (record.markdown && /^>\s*课程：\s*·/m.test(record.markdown)) {
    errors.push(`${label}：正文前言里的课程名是空的`)
  }
  // 2) 校验和与正文一致
  if (record.markdown && record.checksum && record.checksum !== checksumOf(record.markdown)) {
    errors.push(`${label}：checksum 与正文不符（派生物与站点可能已经不同源）`)
  }
  // 3) 简报与这一篇绑定
  const brief = record.brief || {}
  if (!brief.briefing) {
    errors.push(`${label}：没有简报`)
  } else {
    const bound = Boolean(brief.course && brief.lesson && brief.sourceChecksum)
    if (!bound) notes.push(`${label}：简报未绑定来源（历史数据）`)
    if (brief.course && brief.course !== record.courseName) errors.push(`${label}：简报来自别的课程（${brief.course}）`)
    if (brief.lesson && brief.lesson !== record.lessonTitle) errors.push(`${label}：简报来自别的课次（${brief.lesson}）`)
    if (brief.sourceChecksum && record.markdown && brief.sourceChecksum !== checksumOf(record.markdown)) {
      errors.push(`${label}：简报的来源指纹与正文不符`)
    }
  }
  // 4) 一页纸：容量与来源绑定
  // 2600 是"最好再压一压"的经验线，页面上真放不下与否由排版实测决定（见 publish 的适配检查），
  // 所以这里只把明显失控当硬错误，把偏长当提示——体检工具喊狼来了就没人看了。
  if (record.onepage) {
    const chars = String(record.onepage.markdown || '').length
    if (chars > 3200) errors.push(`${label}：一页纸 ${chars} 字，明显超出一页的容量`)
    else if (chars > 2600) notes.push(`${label}：一页纸 ${chars} 字，偏长（建议复核排版）`)
    if (record.onepage.sourceChecksum && record.markdown && record.onepage.sourceChecksum !== checksumOf(record.markdown)) {
      errors.push(`${label}：一页纸的来源指纹与正文不符`)
    }
  }
  // 5) 首页那一列
  if (!record.theme) errors.push(`${label}：首页缺主题句`)
  if (!Array.isArray(record.keywords) || record.keywords.length === 0) errors.push(`${label}：缺关键词`)
}

// 6) 发布日期：整批刷成同一个时刻，说明是重发布把首发时间冲掉了（真实发生过）
const stampCount = new Map()
for (const record of records) {
  const stamp = String(record.publishedAt || '')
  if (stamp) stampCount.set(stamp, [...(stampCount.get(stamp) || []), record.lessonTitle])
}
for (const [stamp, lessons] of stampCount) {
  if (lessons.length > 1) notes.push(`${lessons.length} 节课的发布时间完全相同（${stamp}）：确认这是同一批首发，而不是重发布冲掉了首发时间`)
}

// 7) 同课程不许串课：几节课共用同一段摘要/主题/关键词，是"派生物串了目录"的典型症状
const byCourse = new Map()
for (const record of records) {
  if (!byCourse.has(record.courseName)) byCourse.set(record.courseName, [])
  byCourse.get(record.courseName).push(record)
}
console.log('各课程自检：')
for (const [course, list] of byCourse) {
  const briefings = new Map()
  const themes = new Map()
  const keywordSets = new Map()
  for (const record of list) {
    const briefing = String(record.brief?.briefing || '')
    const theme = String(record.theme || '')
    const keywords = (record.keywords || []).join('、')
    if (briefing) briefings.set(briefing, [...(briefings.get(briefing) || []), record.lessonTitle])
    if (theme) themes.set(theme, [...(themes.get(theme) || []), record.lessonTitle])
    if (keywords) keywordSets.set(keywords, [...(keywordSets.get(keywords) || []), record.lessonTitle])
  }
  for (const [text, lessons] of briefings) {
    if (lessons.length > 1) errors.push(`${course}：${lessons.join('、')} 共用了同一段简报（${short(text)}…）`)
  }
  for (const [text, lessons] of themes) {
    if (lessons.length > 1) errors.push(`${course}：${lessons.join('、')} 共用了同一句主题（${short(text)}）`)
  }
  for (const [text, lessons] of keywordSets) {
    if (lessons.length > 1) notes.push(`${course}：${lessons.join('、')} 的关键词完全相同（${short(text)}）`)
  }
  console.log(`  ${course}：${list.length} 节，简报 ${briefings.size} 种、主题 ${themes.size} 种${briefings.size === list.length ? ' ✓' : ' ← 有重复'}`)
}

console.log('')
for (const note of notes) console.log(`提示：${note}`)
for (const error of errors) console.log(`错误：${error}`)
console.log('')
console.log(errors.length === 0 ? `体检通过（${records.length} 篇，无硬错误）` : `体检未通过：${errors.length} 项`)
process.exit(errors.length === 0 ? 0 : 1)
