import { createHash } from 'node:crypto'

/**
 * 派生物（brief.json / onepage.json）与源正文的绑定。
 *
 * 问题有两层，都是真实发生过的：
 *   1. 派生物是模型基于**当时那一版**正文生成的，正文后来改了，旧文件还是旧说法；
 *   2. 它们是按**目录**存放的：同一个 --from 目录里放过几门课/几节课的 brief.json 时，
 *      谁最后写谁生效——发布库里几节课于是共用了同一段简报（现象：同课程第 2、3 讲的
 *      summary 等于第 1 讲）。
 * 两者都靠同一件事兜住：文件里写清"我是给哪一篇、哪一版正文生成的"。
 *
 * 形态与 @course/notes 的 checkBriefBinding 对齐（同一个 { ok, bound, problems }）：
 * 简报的写入与校验都在 @course/notes 那一侧，一页纸的写入（derivedBinding）与校验
 * （verifyDerived）都在本文件这一侧——各自成对，且两侧的指纹算法互相一致（见下）。
 *
 * ── 两个文件的校验入口（以后不要各改各的）────────────────────────────
 *   brief.json   → @course/notes 的 checkBriefBinding（指纹 = briefSourceChecksum）
 *   onepage.json → 本文件的 verifyDerived（指纹 = markdownChecksum）
 * 这两个指纹**算法已经对齐**：都是"CRLF→LF、去掉结尾空白，再取 SHA-256"
 * （见 normalizeMarkdown / markdownChecksum）。任何一侧要改口径，必须同时改另一侧，
 * 否则会出现"自己生成的派生物自己不敢挂"，或者更糟——校验开始误伤，人就把校验关掉。
 *
 * 校验口径（发布侧据此决定"中止"还是"提示"）：
 *   ok:false        → 与要发布的这一篇不同源：**中止发布**（串课的简报比发布失败更糟）
 *   ok:true, bound:false → 老数据没有绑定字段：不拦，调用方打一行提示即可
 */

/**
 * 绑定指纹的预处理：与 @course/notes 的 briefSourceChecksum 完全一致。
 *
 * 为什么要规范化，而不是直接对原始字节取散列（真实故障，不是假想）：
 * 生成侧读的是**笔记文件**，校验侧用发布库里的 **markdown 字段**，两边可能差一个结尾换行
 * ——运维脚本写过 `record.markdown + '\n'`，scp / 编辑器也可能补一个换行。
 * 原始字节的散列会把"同一段文字的轻微差别"判成不同源，于是发布被 stale_source 直接中止，
 * 或者要人肉加 --regenerate-derived。校验一旦开始误伤，人就会把它关掉，比不加还糟。
 */
export function normalizeMarkdown(markdown = '') {
  return String(markdown || '').replace(/\r\n?/g, '\n').trimEnd()
}

/**
 * 绑定指纹（派生物 ↔ 正文同源判定）：规范化后取 SHA-256。
 * 生成侧（derivedBinding / course onepage 写文件）与校验侧（verifyDerived）都走这一个函数。
 */
export function markdownChecksum(markdown = '') {
  return createHash('sha256').update(normalizeMarkdown(markdown), 'utf8').digest('hex')
}

/**
 * 原始字节的 SHA-256：发布库记录的 `checksum`（"内容变没变"、通知的幂等键）用它。
 *
 * 与绑定指纹分开是有意的：那个字段是**变更判定**，历史库里存的是原始字节的散列，
 * 换成规范化口径会让整库在下次发布时集体变成 changed=true（每节都会重推一条）。
 * 用途不同、口径不同，所以两个名字分开写清楚，而不是复用同一个函数。
 */
export function markdownBytesChecksum(markdown = '') {
  return createHash('sha256').update(String(markdown ?? ''), 'utf8').digest('hex')
}

/** 生成侧写进 onepage.json 的那几个字段。 */
export function derivedBinding({
  markdown = '', courseName = '', lessonTitle = '', replayKey = '', generatedAt = new Date().toISOString()
} = {}) {
  return {
    course: String(courseName || '').trim(),
    lesson: String(lessonTitle || '').trim(),
    replayKey: String(replayKey || '').trim(),
    sourceChecksum: markdownChecksum(markdown),
    generatedAt
  }
}

const emptyChecks = () => ({ course: 'absent', lesson: 'absent', replayKey: 'absent', sourceChecksum: 'absent' })

/**
 * 校验一份派生物能不能挂到这一版正文上。
 *
 * 返回 { ok, bound, reason, problems, checks }：
 *   ok        能不能用；false 时调用方应当中止发布
 *   bound     文件里有没有绑定字段（course + lesson + sourceChecksum 三者齐全）
 *   problems  人话，直接拼进错误信息
 *   checks    逐项 match / mismatch / absent，便于把"到底是哪一项对不上"看明白
 */
export function verifyDerived(artifact, { courseName = '', lessonTitle = '', replayKey = '', checksum = '' } = {}) {
  const expectedCourse = String(courseName || '').trim()
  const expectedLesson = String(lessonTitle || '').trim()
  const expectedReplay = String(replayKey || '').trim()
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, bound: false, reason: 'unreadable', problems: ['文件内容不是对象，读不出绑定信息'], checks: emptyChecks() }
  }

  const course = String(artifact.course ?? '').trim()
  const lesson = String(artifact.lesson ?? '').trim()
  const replay = String(artifact.replayKey ?? '').trim()
  const sourceChecksum = String(artifact.sourceChecksum ?? '').trim()
  const bound = Boolean(course && lesson && sourceChecksum)

  const checks = {
    course: course ? (course === expectedCourse ? 'match' : 'mismatch') : 'absent',
    lesson: lesson ? (lesson === expectedLesson ? 'match' : 'mismatch') : 'absent',
    // 空 replayKey 不算不一致：它只是没被记录（老文件、或生成时没传 --replay-key），
    // 真正兜底的是指纹——正文对不上就一定拦。
    replayKey: replay ? (replay === expectedReplay ? 'match' : 'mismatch') : 'absent',
    sourceChecksum: sourceChecksum ? (sourceChecksum === String(checksum || '') ? 'match' : 'mismatch') : 'absent'
  }

  const problems = []
  if (checks.course === 'mismatch') problems.push(`课程不符（文件是 ${course}，要发布的是 ${expectedCourse}）`)
  if (checks.lesson === 'mismatch') problems.push(`课次不符（文件是 ${lesson}，要发布的是 ${expectedLesson}）`)
  if (checks.replayKey === 'mismatch') problems.push(`回放键不符（文件是 ${replay}，要发布的是 ${expectedReplay}）`)
  if (checks.sourceChecksum === 'mismatch') problems.push('来源指纹与要发布的笔记正文不符')

  if (problems.length) {
    const reason = checks.course === 'mismatch' || checks.lesson === 'mismatch' ? 'identity_mismatch'
      : checks.replayKey === 'mismatch' ? 'replaykey_mismatch'
        : 'stale_source'
    return { ok: false, bound, reason, problems, checks }
  }
  return { ok: true, bound, reason: bound ? 'ok' : 'unbound', problems: [], checks }
}
