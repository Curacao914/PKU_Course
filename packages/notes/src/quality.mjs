/**
 * 内容质量检查：把"这一篇笔记哪里不对"变成可以自动发现、能指出证据的清单。
 *
 * 为什么要单独一层：笔记是模型写的、还要经过切片与拼接（splicer），出错的方式很有限——
 * 分类漏了/重了、表格列数对不上、同一节出现两个"思考题"、正文被截断、待核标记没有出处。
 * 这些都能在**发布之前**用纯文本检查发现，比等读者看到再回滚便宜得多。
 *
 * 三条纪律：
 *   1. 只报告、不改写：质量检查不替作者做决定（改内容要人点头）；
 *   2. 每条发现都带证据（原文片段 + 行号），否则等于"我觉得不对"；
 *   3. 不产生通知：这些是给作者看的，不是给读者推的——通知只走 course-note 那一条链路。
 */

const str = value => String(value ?? '')
const lines = text => str(text).split('\n')

/** 收集"待核"类标记：正文里作者自己标出来"这里我拿不准"的地方。 */
// 只认"作者明确标出来拿不准"的写法。"不确定"这类词在法学正文里是术语
// （"不确定刑"就是不定刑期），把它当标记会在真实笔记里刷出一屏假阳性——实测 34 条里
// 大多数是它。
const OPEN_MARKER = /(待核|待确认|待补|TODO|FIXME|\?\?\?)/

export function findOpenMarkers(markdown = '') {
  const found = []
  lines(markdown).forEach((line, index) => {
    if (!OPEN_MARKER.test(line)) return
    // 出处 = 同一行里有没有括号说明 / 来源引用；只写"待核"两个字的，读者与后续流程都不知道核什么
    const hasSource = /[（(][^）)]{2,}[）)]/.test(line) || /来源|出处|转录|第\s*\d+\s*段|\d{2}-\d{2}/.test(line)
    found.push({ line: index + 1, text: line.trim().slice(0, 120), hasSource })
  })
  return found
}

/** 表格：列数一致性（拼接出错最常见的形状就是某一行少一列）。 */
export function checkTables(markdown = '') {
  const rows = lines(markdown)
  const findings = []
  let header = null
  let startLine = 0
  rows.forEach((line, index) => {
    const isRow = /^\s*\|/.test(line)
    if (!isRow) { header = null; return }
    const cells = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
    if (!header) { header = cells.length; startLine = index + 1; return }
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return   // 分隔行
    if (cells.length !== header) {
      findings.push({
        level: 'error',
        code: 'table-columns',
        message: `表格第 ${index + 1} 行有 ${cells.length} 列，表头是 ${header} 列`,
        evidence: line.trim().slice(0, 120),
        line: index + 1
      })
    }
  })
  return findings
}

/** 标题：同一节里出现重复的小节标题（同一份内容被拼了两次的典型症状）。 */
export function checkHeadings(markdown = '') {
  const seen = new Map()
  const findings = []
  lines(markdown).forEach((line, index) => {
    const match = line.match(/^(#{2,4})\s+(.+?)\s*$/)
    if (!match) return
    const text = match[2].trim()
    if (!seen.has(text)) { seen.set(text, index + 1); return }
    findings.push({
      level: 'warn',
      code: 'duplicate-heading',
      message: `标题「${text}」出现两次（第 ${seen.get(text)} 行与第 ${index + 1} 行）——同一节被拼了两遍？`,
      evidence: text,
      line: index + 1
    })
  })
  // 思考题通常是三级标题（### 思考题），所以要认带井号的行，而不是只认光秃秃那两个字
  const markers = (markdown.match(/^\s*#{0,6}\s*(思考题|问题|练习)\s*$/gm) || []).length
  if (markers > 1) {
    findings.push({
      level: 'warn',
      code: 'duplicate-quiz',
      message: `正文里有 ${markers} 处"思考题/问题/练习"标题`,
      evidence: '思考题',
      line: 0
    })
  }
  return findings
}

/** 截断：结尾是半句话、代码围栏没闭合、details 块没闭合。 */
export function checkTruncation(markdown = '') {
  const text = str(markdown).trimEnd()
  const found = []
  if (text) {
    const lastLine = text.split('\n').pop().trim()
    // 表格行只剩半个（"| 1"）也是截断的典型形状：列数检查只看得出"少了一列"，
    // 但"连收尾的竖线都没了"说明是写到一半断的。
    // 结构性结尾不算"半句话"：笔记末尾本来就是 </details>、META: … 这类收尾
    // （实测 11 篇真实笔记全被误报过，就因为它们以 </details> 结束）。
    const structural = /^<\/?[a-z]/i.test(lastLine) || /^META\s*:/i.test(lastLine)
    const halfTable = /^\|/.test(lastLine) && !/\|$/.test(lastLine)
    const dangling = !structural && (halfTable || /[,，、；;:：]$/.test(lastLine) ||
      // 8 个字以上、又没有结束标点，就当半句话（中文一行 8 字已经是一句了）
      (lastLine.length >= 8 && !/[。！？!?）」》….”"']$/.test(lastLine) && !/^\|/.test(lastLine) && !/^#/.test(lastLine) && !/^-/.test(lastLine)))
    if (dangling) {
      found.push({
        level: 'error',
        code: 'truncated-tail',
        message: '正文结尾像是半句话（没有结束标点）',
        evidence: lastLine.slice(0, 120),
        line: text.split('\n').length
      })
    }
  }
  const fences = (str(markdown).match(/^```/gm) || []).length
  if (fences % 2 !== 0) {
    found.push({ level: 'error', code: 'unbalanced-fence', message: `代码围栏有 ${fences} 个（应当是偶数）`, evidence: '```', line: 0 })
  }
  const open = (str(markdown).match(/<details/g) || []).length
  const close = (str(markdown).match(/<\/details>/g) || []).length
  if (open !== close) {
    found.push({ level: 'error', code: 'unbalanced-details', message: `<details> 开 ${open} 个、闭 ${close} 个`, evidence: '<details>', line: 0 })
  }
  return found
}

/** 分类：桶内重复，以及"正文里有法条/案例但桶是空的"这种明显漏抽。 */
export function checkMetadata(markdown = '', metadata = {}) {
  const found = []
  const buckets = ['concepts', 'statutes', 'cases']
  for (const bucket of buckets) {
    const values = Array.isArray(metadata[bucket]) ? metadata[bucket].map(item => str(item).trim()).filter(Boolean) : []
    const seen = new Map()
    for (const value of values) {
      const key = value.normalize('NFKC').toLowerCase()
      if (seen.has(key)) {
        found.push({ level: 'warn', code: 'duplicate-term', message: `${bucket} 里「${value}」重复`, evidence: value, line: 0 })
      }
      seen.set(key, true)
    }
  }
  const body = str(markdown)
  // 笔记里的法条是带空格的写法（"第 78 条"），正则必须容得下空格——
  // 第一版写死了"第78条"，于是真实笔记里一处都匹配不到，检查形同虚设。
  const statuteHits = (body.match(/第\s*[一二三四五六七八九十百零\d]+\s*条/g) || []).length
  const caseHits = (body.match(/案(?:\b|）|\)|，|。|、|；)/g) || []).length
  if (statuteHits >= 3 && (metadata.statutes || []).length === 0) {
    found.push({ level: 'warn', code: 'statutes-missing', message: `正文提到 ${statuteHits} 处"第 N 条"，但法条分类是空的`, evidence: '第…条', line: 0 })
  }
  if (caseHits >= 3 && (metadata.cases || []).length === 0) {
    found.push({ level: 'warn', code: 'cases-missing', message: `正文提到 ${caseHits} 处案例，但案例分类是空的`, evidence: '…案', line: 0 })
  }
  return found
}

/**
 * 待核标记的贯通：正文里标了"待核"，摘要 / 一页纸 / 测验里却像是已经确定的知识——
 * 读者只看到后者，于是把作者都不确定的东西当结论背下来。
 */
export function checkMarkerPropagation(markdown = '', artifacts = {}) {
  const markers = findOpenMarkers(markdown)
  if (!markers.length) return []
  const missing = []
  for (const [name, text] of Object.entries(artifacts)) {
    if (!str(text).trim()) continue          // 这一篇本来就没有这份产物，不算漏
    if (findOpenMarkers(text).length) continue
    missing.push(name)
  }
  if (!missing.length) return []
  return [{
    level: 'warn',
    code: 'marker-not-propagated',
    message: `正文有 ${markers.length} 处待核标记，但 ${missing.join(' / ')} 里没有提示`,
    evidence: markers[0].text,
    line: markers[0].line
  }]
}

/** 待核标记本身有没有出处（只写"待核"两个字，之后没人知道要核什么）。 */
export function checkMarkerProvenance(markdown = '') {
  return findOpenMarkers(markdown)
    .filter(marker => !marker.hasSource)
    .map(marker => ({
      level: 'info',
      code: 'marker-without-source',
      message: '待核标记没有出处说明（写成「待核：转录不清（09-07 第 3 段）」更好）',
      evidence: marker.text,
      line: marker.line
    }))
}

/** 全部检查跑一遍。artifacts 传 { '简报': briefMarkdown, '一页纸': onepageMarkdown, '测验': quizMarkdown }。 */
export function checkNoteQuality({ markdown = '', metadata = {}, artifacts = {} } = {}) {
  const findings = [
    ...checkTruncation(markdown),
    ...checkTables(markdown),
    ...checkHeadings(markdown),
    ...checkMetadata(markdown, metadata),
    ...checkMarkerProvenance(markdown),
    ...checkMarkerPropagation(markdown, artifacts)
  ]
  const order = { error: 0, warn: 1, info: 2 }
  findings.sort((left, right) => (order[left.level] - order[right.level]) || (left.line - right.line))
  return {
    findings,
    counts: {
      error: findings.filter(item => item.level === 'error').length,
      warn: findings.filter(item => item.level === 'warn').length,
      info: findings.filter(item => item.level === 'info').length
    }
  }
}

/** 给人看的一行行报告（stderr / 运行摘要里用；不进通知）。 */
export function formatQualityReport(result = { findings: [], counts: {} }) {
  if (!result.findings.length) return '内容质量检查：没有发现问题。'
  const head = `内容质量检查：${result.counts.error} 个错误 / ${result.counts.warn} 个提醒 / ${result.counts.info} 条提示`
  const body = result.findings.map(item =>
    `  [${item.level}] ${item.code}${item.line ? ' 第 ' + item.line + ' 行' : ''}：${item.message}${item.evidence ? '｜证据：' + item.evidence : ''}`)
  return [head, ...body].join('\n')
}
