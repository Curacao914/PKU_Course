/**
 * 查询解析：把"人会怎么问"变成"拿什么去比"。
 *
 * 旧实现拿整条查询当**一个字符串**去正文里 indexOf，于是只有"原话里恰好连着出现"才命中：
 *   · "交易成本 资产专用性"（两个词）→ 零命中；
 *   · "为什么审判威廉二世的构想落空了"（自然语言）→ 零命中；
 *   · "罪刑法定主意"（错别字）→ 零命中。
 * 而中文没有空格，也不该为了切词引入分词库（零依赖、可预测优先）。这里的做法：
 *
 *   1. 先去掉疑问词与虚词，**在虚词处切开**而不是把虚词删掉——
 *      "资本维持与抽逃出资" 于是变成 ["资本维持", "抽逃出资"] 两个词，而不是一团糊；
 *   2. 切出来的片段：短的整段当一个词（"资本维持"），长的既留整段也补 2—4 字 n-gram
 *      （"为什么审判威廉二世的构想落空了" → "审判威廉二世" + "威廉二世"/"构想"/"落空"…）；
 *   3. 每个词带一个基础权重（整段 > n-gram），真正的区分度交给 IDF（见 search.mjs）。
 *
 * 错别字靠 editDistance：一个词的**逐字替换/增删**（主义→主意）在距离 1 之内。
 * 只在"零命中"时才启用，避免把正常查询也搅浑。
 */

/** 疑问词与常见的"问法壳子"：它们说明人在问什么，不说明内容里写了什么。 */
const QUESTION_WORDS = [
  '为什么', '为何', '是什么', '什么是', '怎么样', '怎样', '怎么', '如何', '哪些', '哪个', '哪一种', '是否',
  '多少', '请问', '介绍一下', '讲讲', '说说', '是什么意思'
]

/** 虚词：在这些字的位置切开。留一个字的残片没有意义，切完再过滤。 */
const PARTICLES = new Set([...'的了是在和与及或为对被把有会能要这那之其也就都又还更最着过吗呢啊嘛吧哦呀'])

/** 片段里允许留下的最小长度（中文 2 字起：一个字的片段几乎全是噪声）。 */
const MIN_RUN = 2

export function normalizeText(value = '') {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
}

/** 词面里是否出现虚词（n-gram 里带虚词的直接丢：它们匹配到的多是"顺带连着"的位置）。 */
function hasParticle(text) {
  return [...text].some(char => PARTICLES.has(char))
}

/**
 * 查询 → 词与权重。
 *
 * 返回 [{ term, weight }]：weight 只表达"这个词本身有多可信"（整段短语 > n-gram），
 * 与它在语料里有多稀有（IDF）相乘才是最终权重。
 */
export function queryTerms(rawQuery = '') {
  let text = normalizeText(rawQuery)
  if (!text) return []
  for (const word of QUESTION_WORDS) text = text.split(word).join(' ')

  const terms = new Map()
  const add = (term, weight) => {
    const value = String(term || '').trim()
    if ([...value].length < MIN_RUN && !/^[a-z0-9]/.test(value)) return
    if (hasParticle(value)) return
    if (!terms.has(value) || terms.get(value) < weight) terms.set(value, weight)
  }

  // 先按标点/空格切段，再按虚词切段：两层都是"切开"而不是"删掉"
  for (const chunk of text.split(/[\s\p{P}\p{S}]+/u).filter(Boolean)) {
    if (/^[a-z0-9]/.test(chunk)) {
      add(chunk, 1.2) // 拉丁词/数字（z值、atr、2026）本身就很区分
      continue
    }
    const runs = []
    let current = ''
    for (const char of chunk) {
      if (PARTICLES.has(char)) {
        if (current) runs.push(current)
        current = ''
        continue
      }
      current += char
    }
    if (current) runs.push(current)
    for (const run of runs) {
      const length = [...run].length
      if (length < MIN_RUN) continue
      add(run, length <= 6 ? 1.5 : 1.1) // 整段：短的更可能是术语，长的更像一句话
      // 长片段补 n-gram：自然语言问句靠它们才能落到"威廉二世""构想""落空"这些真词上
      if (length >= 4) {
        for (const size of [2, 3, 4]) {
          if (size > length) continue
          for (let index = 0; index + size <= length; index += 1) {
            add([...run].slice(index, index + size).join(''), 0.8)
          }
        }
      }
    }
  }
  return [...terms.entries()].map(([term, weight]) => ({ term, weight }))
}

/** 编辑距离（带上限，超了立刻返回 max+1）：错别字容错只需要"差一个字符"这一档。 */
export function editDistanceWithin(left = '', right = '', max = 1) {
  const a = [...String(left)]
  const b = [...String(right)]
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = b.map((_, index) => index + 1)
  previous.unshift(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    previous = current
  }
  return previous[b.length]
}

/**
 * 错别字回退：在**语料里真实出现过的词**（标题/关键词/概念等）中找编辑距离 ≤1 的近邻。
 * 只跟语料里的词比，不凭空造词——"主意"能对上"主义"，是因为语料里有"罪刑法定主义"。
 */
export function fuzzyTerms(term = '', candidates = [], { maxDistance = 1, limit = 3 } = {}) {
  const value = normalizeText(term)
  if ([...value].length < 3) return []
  const out = []
  for (const candidate of candidates) {
    const text = normalizeText(candidate)
    if (text === value) continue
    if (Math.abs([...text].length - [...value].length) > maxDistance) continue
    if (editDistanceWithin(value, text, maxDistance) <= maxDistance) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** 从记录里收集"语料词表"：只取人来命名过的地方（标题、主题、关键词、概念/法条/案例）。 */
export function corpusTerms(records = []) {
  const terms = new Set()
  for (const record of records) {
    const push = value => {
      const text = normalizeText(value)
      if ([...text].length >= 2) terms.add(text)
    }
    ;[record.lessonTitle, record.theme, record.courseName].forEach(push)
    ;(record.headings || []).forEach(head => push(head.text))
    ;(record.keywords || []).forEach(push)
    ;(record.metadata?.concepts || []).forEach(push)
    ;(record.metadata?.statutes || []).forEach(push)
    ;(record.metadata?.cases || []).forEach(push)
  }
  return [...terms]
}
