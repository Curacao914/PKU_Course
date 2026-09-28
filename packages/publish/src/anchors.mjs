/**
 * 划词批注的定位（纯函数，不碰 DOM——DOM 那一层在 reader.mjs 里，这里只做"文本 ↔ 区间"的算术）。
 *
 * 为什么要重写：旧实现保存的是 { text, before, after }，恢复时在整篇里做
 * `node.nodeValue.indexOf(text)`。两件事会错：
 *   1. **同一个词出现两次**（"共同故意"在一篇里出现三回）时，第二次的批注会被贴到第一处；
 *   2. 没有任何上下文校验——正文改版后只要这个词还在，批注就会贴到一句完全无关的话上。
 * 现在存的是**完整锚点**：所属小节、精确文本、前后各 32 字上下文、小节内字符区间、以及
 * 批注 id 与记录时的正文版本。恢复时按"上下文 → 唯一出现 → 记录位置 → 空白归一"四级
 * 依次尝试，每一级都说明自己用了哪一级（reanchored），找不到就**保留记录不删**——
 * 批注是读者自己写的东西，宁可留在本地等下次，也不能因为一次改版就悄悄丢掉。
 */

export const CONTEXT_LENGTH = 32
/** 记录位置附近的容忍范围：重新生成正文时前面多几百字很正常，但落点要能对上上下文。 */
export const OFFSET_TOLERANCE = 400

const str = value => String(value ?? '')

/** 生成一个 id（浏览器与 node 都有 randomUUID 时用它，否则退回时间戳 + 随机）。 */
export function annotationId(seed = '') {
  const random = Math.random().toString(36).slice(2, 10)
  return `a${Date.now().toString(36)}${random}${seed ? '-' + String(seed).slice(0, 6) : ''}`
}

/** 从选区信息造锚点。sectionId 是小节锚点（与页面 #id 一致），用来限定在哪一节里找。 */
export function anchorFromSelection({ text, prefix = '', suffix = '', sectionId = '', start = 0, end = 0, id = '', kind = 'mark', revision = '', at = '' } = {}) {
  return {
    id: id || annotationId(),
    kind,
    text: str(text),
    prefix: str(prefix).slice(-CONTEXT_LENGTH),
    suffix: str(suffix).slice(0, CONTEXT_LENGTH),
    sectionId: str(sectionId),
    start: Number.isFinite(start) ? Math.max(0, Math.trunc(start)) : 0,
    end: Number.isFinite(end) ? Math.max(0, Math.trunc(end)) : 0,
    revision: str(revision),
    at: at || new Date().toISOString()
  }
}

/** 老记录（{text, before, after}）也能用：转成同一形状，缺的字段留空。 */
export function normalizeAnchor(anchor = {}) {
  if (anchor.prefix !== undefined || anchor.suffix !== undefined || anchor.sectionId !== undefined) return { ...anchor }
  return {
    ...anchor,
    prefix: str(anchor.before || ''),
    suffix: str(anchor.after || ''),
    sectionId: str(anchor.sectionId || ''),
    start: 0,
    end: 0
  }
}

/**
 * 把一串文本节点拼成一篇文本，并记住每个节点在全文里的起点。
 * nodes 只要求是字符串数组（浏览器里由 TreeWalker 收集，测试里直接给字符串）。
 */
export function collectText(nodes = []) {
  let text = ''
  const index = []
  nodes.forEach((value, nodeIndex) => {
    const piece = str(value)
    index.push({ nodeIndex, start: text.length, length: piece.length })
    text += piece
  })
  return { text, index }
}

/** 全文区间 → 每个文本节点上的一段（跨节点、跨行内元素都能包）。 */
export function piecesForRange(index = [], start = 0, end = 0) {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(start, end)
  if (to <= from) return []
  const pieces = []
  for (const node of index) {
    const nodeStart = node.start
    const nodeEnd = node.start + node.length
    if (nodeEnd <= from || nodeStart >= to) continue
    pieces.push({ nodeIndex: node.nodeIndex, start: Math.max(from, nodeStart) - nodeStart, end: Math.min(to, nodeEnd) - nodeStart })
  }
  return pieces
}

/**
 * 定位锚点。返回 { start, end, strategy, reanchored } 或 null。
 * 四级：context（前后文都对得上）→ unique（全文只出现一次）→ offset（记录位置附近）→
 * fuzzy（空白归一后再找）。只有 context 算"精确"，其余都会把 reanchored 标成 true。
 */
export function findAnchor(text, input, { tolerance = OFFSET_TOLERANCE } = {}) {
  // 这两个小函数只在这里用，所以放在函数体里：页面上是**内联 findAnchor 的源码**
  // 来跑定位的（见 reader.mjs 的 ANCHOR_RUNTIME），依赖放在外面就会漏进页面，
  // 表现为运行时 "withPrefix is not defined"——浏览器审计抓到过一次。
  const withPrefix = (haystack, at, prefix) => prefix ? str(prefix).slice(-CONTEXT_LENGTH) === haystack.slice(Math.max(0, at - prefix.length), at) : true
  const withSuffix = (haystack, at, needle, suffix) => suffix ? str(suffix).slice(0, CONTEXT_LENGTH) === haystack.slice(at + needle.length, at + needle.length + suffix.length) : true
  const anchor = normalizeAnchor(input)
  const needle = str(anchor.text)
  const haystack = str(text)
  if (!needle || !haystack) return null

  const occurrences = []
  let from = 0
  while (occurrences.length < 50) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    occurrences.push(at)
    from = at + Math.max(1, needle.length)
  }

  // ① 前后文都对得上的那一处（最可靠；同一个词出现多次也能分清）
  const contextual = occurrences.filter(at => withPrefix(haystack, at, anchor.prefix) && withSuffix(haystack, at, needle, anchor.suffix))
  if (contextual.length === 1) return { start: contextual[0], end: contextual[0] + needle.length, strategy: 'context', reanchored: false }
  if (contextual.length > 1 && anchor.start) {
    // 上下文重复（比如同一个小节里重复的排版短语）：取离记录位置最近的那一处
    const best = contextual.reduce((left, right) =>
      Math.abs(right - anchor.start) < Math.abs(left - anchor.start) ? right : left)
    return { start: best, end: best + needle.length, strategy: 'context', reanchored: false }
  }

  // ② 只出现一次：不用上下文也敢认
  if (occurrences.length === 1) return { start: occurrences[0], end: occurrences[0] + needle.length, strategy: 'unique', reanchored: false }

  // ③ 记录位置附近（正文重新生成后位置会挪，落到附近仍然算同一次批注，但要标记出来）
  if (anchor.start) {
    const near = occurrences.filter(at => Math.abs(at - anchor.start) <= tolerance)
    if (near.length >= 1) {
      const best = near.reduce((left, right) => Math.abs(right - anchor.start) < Math.abs(left - anchor.start) ? right : left)
      return { start: best, end: best + needle.length, strategy: 'offset', reanchored: true }
    }
  }

  // ④ 空白归一后再找（排版把换行/空格改了）
  const squash = value => value.replace(/\s+/g, '')
  const flatNeedle = squash(needle)
  if (flatNeedle && flatNeedle !== needle) {
    const map = []
    for (let i = 0; i < haystack.length; i += 1) if (!/\s/.test(haystack[i])) map.push(i)
    const flatHay = squash(haystack)
    const at = flatHay.indexOf(flatNeedle)
    if (at >= 0 && map[at] !== undefined) {
      const start = map[at]
      const last = map[Math.min(map.length - 1, at + flatNeedle.length - 1)]
      return { start, end: (last === undefined ? start : last) + 1, strategy: 'fuzzy', reanchored: true }
    }
  }

  // ⑤ 多处且没有上下文：拒绝猜（猜错比找不到更糟），保留记录等下次
  return null
}
