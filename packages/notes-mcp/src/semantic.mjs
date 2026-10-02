import fs from 'node:fs'

/**
 * 语义回退（Phase 5.2 收尾：把 docs/13 的实验结论落成产品）。
 *
 * 定位先说清楚：**它不是默认检索，只在字面检索答不上来时才上场**。理由有三条，
 * 都是实验里量出来的：
 *   · 词面检索零成本、零延迟、可解释（能说清"为什么是它"），绝大多数查询够用；
 *   · 语义检索每次要多一次网络往返（实测热路径 254ms），而且结果无法解释；
 *   · 它确实能接住"换个说法"的问题（冻结留出集 top1 从 0/4 提到 3/4，见 docs/13）。
 * 所以：字面命中就用字面；字面零命中才问一次向量，并把"这是按意思找的"标出来。
 *
 * 四件必须做对的事（每件都有测试）：
 *   1. **指纹校验**：向量绑在小节指纹上，指纹对不上（正文改过、索引过期）就不用那条向量；
 *   2. **门槛**：相似度低于 minScore 的不报——不能因为"总得给点什么"就报一堆不相干的；
 *   3. **降级**：embedding 服务慢/挂/超时，静默退回"没有结果"，绝不阻塞、绝不抛错到上层；
 *   4. **标注**：命中带 similarity 与 semantic:true，调用方据此告诉读者"这是按语义近似召回"。
 */

/** 单位向量化（接口返回的向量未必要归一，余弦相似度自己算一遍更稳）。 */
function normalize (vector) {
  const values = Array.isArray(vector) ? vector.map(Number) : []
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map(value => value / norm)
}

function cosine (left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index]
  return sum
}

/**
 * 解析 embeddings.json。
 *
 * 形状：{ version, provider, model, dim, createdAt, cost, items: { "<slug>#<sectionId>": { fingerprint, vector } } }
 * 任何一条不合法（缺向量、维度不一致）都**跳过那一条**，而不是整份索引作废——
 * 一份索引里有几条例外，不该让整个回退能力失效。
 */
export function parseEmbeddingIndex (raw, options = {}) {
  const payload = typeof raw === 'string' ? safeJson(raw) : raw
  if (!payload || typeof payload !== 'object' || !payload.items || typeof payload.items !== 'object') return null
  const items = new Map()
  let skipped = 0
  const expectedDim = Number(payload.dim || options.dim || 0)
  for (const [key, value] of Object.entries(payload.items)) {
    const vector = Array.isArray(value) ? value : value?.vector
    const fingerprint = Array.isArray(value) ? '' : String(value?.fingerprint || '')
    if (!Array.isArray(vector) || !vector.length) { skipped += 1; continue }
    if (expectedDim && vector.length !== expectedDim) { skipped += 1; continue }
    items.set(key, { fingerprint, vector: normalize(vector) })
  }
  return {
    libraryRevision: String(payload.libraryRevision || ''),
    provider: String(payload.provider || ''),
    model: String(payload.model || ''),
    dim: expectedDim || (items.size ? items.values().next().value.vector.length : 0),
    createdAt: String(payload.createdAt || ''),
    cost: payload.cost || null,
    items,
    skipped
  }
}

/** 磁盘向量缓存：键 = 文本 sha256。重跑不花钱，也是"只重算改动内容"的落点。 */
function loadVectorCache (file) {
  let data = { items: {} }
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = { items: {} } }
  if (!data.items || typeof data.items !== 'object') data.items = {}
  let dirty = false
  const keyOf = text => {
    // 这里不引 node:crypto 以免和浏览器侧的用法混淆：FNV-1a 足够当缓存键
    let hash = 0x811c9dc5
    const value = String(text)
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0') + '-' + value.length
  }
  return {
    get (text) { return data.items[keyOf(text)] || null },
    set (text, vector) { data.items[keyOf(text)] = vector; dirty = true },
    flush () {
      if (!dirty) return
      const dir = file.slice(0, file.lastIndexOf('/'))
      if (dir) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data))
      dirty = false
    },
    get size () { return Object.keys(data.items).length }
  }
}

function safeJson (text) {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * 读索引文件（按 mtime 缓存：发布写完 embeddings.json 之后不必重启进程）。
 * 文件不存在 → null（回退能力关闭，而不是报错）。
 */
export function loadEmbeddingIndex (
  file,
  {
    now = () => Date.now(),
    expectedLibraryRevision = '',
    allowRevisionMismatch = false
  } = {}
) {
  if (!file) return { index: null, reason: 'no_index_file' }
  let stat
  try { stat = fs.statSync(file) } catch { return { index: null, reason: 'missing' } }

  const expected = String(expectedLibraryRevision || '')
  const validate = (index, sourceReason) => {
    if (!index) return { index: null, reason: 'unreadable' }
    if (expected) {
      if (!index.libraryRevision) {
        if (!allowRevisionMismatch) return { index: null, reason: 'library_revision_unbound' }
        return { index, reason: sourceReason, revisionMatch: false, bindingReason: 'library_revision_unbound' }
      }
      if (index.libraryRevision !== expected) {
        if (!allowRevisionMismatch) return { index: null, reason: 'library_revision_mismatch' }
        return { index, reason: sourceReason, revisionMatch: false, bindingReason: 'library_revision_mismatch' }
      }
      return { index, reason: sourceReason, revisionMatch: true, bindingReason: '' }
    }
    return { index, reason: sourceReason, revisionMatch: null, bindingReason: '' }
  }

  const cached = loadEmbeddingIndex.cache?.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return validate(cached.index, 'cached')
  }
  const index = parseEmbeddingIndex(fs.readFileSync(file, 'utf8'))
  if (!index) return { index: null, reason: 'unreadable' }
  if (!loadEmbeddingIndex.cache) loadEmbeddingIndex.cache = new Map()
  loadEmbeddingIndex.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, index })
  void now
  return validate(index, 'loaded')
}

/**
 * 查询向量化：一次网络往返，必须**有硬超时**（默认 1 秒）且失败即静默降级。
 * 同一句话在进程内缓存（同一轮对话里反复问同一句很常见）。
 */
export function createQueryEmbedder ({
  provider = 'dashscope',
  apiKey = '',
  model = 'text-embedding-v3',
  timeoutMs = 1000,
  fetchImpl = globalThis.fetch,
  cacheLimit = 200
} = {}) {
  const cache = new Map()
  const state = { calls: 0, hits: 0, failures: 0, lastError: '' }

  async function embed (text) {
    const key = String(text || '').trim()
    if (!key) return null
    if (cache.has(key)) { state.hits += 1; return cache.get(key) }
    if (!apiKey) { state.failures += 1; state.lastError = 'no_api_key'; return null }
    const controller = new AbortController()
    const limit = Math.max(100, Number(timeoutMs) || 1000)
    const timer = setTimeout(() => controller.abort(), limit)
    const TIMEOUT = Symbol('timeout')
    try {
      state.calls += 1
      /**
       * 硬超时**不能只靠 signal**：signal 只是"请求客户端"的礼貌约定，
       * 真正要保证的是"到点就返回"。所以这里用 Promise.race 兜底——
       * 无论 fetchImpl 是否尊重 signal（断网、DNS 卡住、自定义实现），
       * 到时间一定返回 null，绝不把上层请求挂住。（第一次写漏了这层，测试直接挂住。）
       */
      const work = (async () => {
        const response = await fetchImpl('https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: { texts: [key] }, parameters: { text_type: 'query' } }),
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        const vector = payload?.output?.embeddings?.[0]?.embedding
        if (!Array.isArray(vector) || !vector.length) throw new Error('返回里没有向量')
        return normalize(vector)
      })()
      // 迟到的失败不要变成未处理的拒绝
      work.catch(() => {})
      const raced = await Promise.race([work, new Promise(resolve => setTimeout(() => resolve(TIMEOUT), limit))])
      if (raced === TIMEOUT) throw new Error(`查询向量化超时（>${limit}ms）`)
      const normalized = raced
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value)
      cache.set(key, normalized)
      return normalized
    } catch (error) {
      // 降级：慢、挂、限流、断网都只记一笔，返回 null —— 调用方按"没有语义结果"处理
      state.failures += 1
      state.lastError = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return { embed, stats: () => ({ ...state, cached: cache.size }), provider, model, enabled: Boolean(apiKey) }
}

/**
 * 批量向量化（索引侧的写路径：course embed 用它，实验工具也用它）。
 *
 * 与查询侧共享同一套纪律：**先算钱再花**（超上限当场拒绝，未发出的批次不花钱）、
 * 用量以接口返回的 usage 为准、按文本 sha256 缓存在磁盘上（第二次不再花钱，
 * 也是"只重算改动小节"的落点）。
 */
export async function embedTexts ({
  texts = [],
  type = 'document',
  apiKey = '',
  model = 'text-embedding-v3',
  provider = 'dashscope',
  cacheFile = '',
  capCny = 0,
  batchSize = 10,
  fetchImpl = globalThis.fetch,
  onProgress = () => {}
} = {}) {
  if (!apiKey) throw new Error('向量化需要 API key（DASHSCOPE_API_KEY / COURSE_EMBED_API_KEY）')
  const cache = cacheFile ? loadVectorCache(cacheFile) : null
  const stats = { tokens: 0, calls: 0, hits: 0, cacheSize: cache ? cache.size : 0, costCny: 0, projectedCny: 0 }
  const price = provider === 'dashscope' ? 0.5 / 1_000_000 : 0   // 元 / token

  const vectors = new Array(texts.length).fill(null)
  const missing = []
  texts.forEach((text, index) => {
    const hit = cache?.get(text)
    if (hit) { vectors[index] = hit; stats.hits += 1 } else missing.push({ index, text })
  })

  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize)
    // 保守估：1 token ≈ 1.5 字。超上限就拒绝——**在发请求之前**，所以没花出去的钱不会花
    stats.projectedCny = (stats.tokens + batch.reduce((sum, item) => sum + Math.ceil(String(item.text).length / 1.5), 0)) * price
    if (capCny > 0 && stats.projectedCny > capCny) {
      throw new Error(`预计花费 ¥${stats.projectedCny.toFixed(4)} 超过上限 ¥${capCny}：已停止，未发出的批次不花钱`)
    }
    let payload = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl('https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: { texts: batch.map(item => item.text) }, parameters: { text_type: type } })
      })
      if (response.ok) { payload = await response.json(); break }
      const detail = await response.text().catch(() => '')
      if (response.status === 429 || response.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
        continue
      }
      throw new Error(`向量化接口返回 ${response.status}：${String(detail).slice(0, 200)}`)
    }
    if (!payload) throw new Error('向量化接口连续失败三次，本次中止（已花的钱在缓存里，重跑不用再花）')
    stats.calls += 1
    stats.tokens += Number(payload?.usage?.total_tokens || batch.reduce((sum, item) => sum + Math.ceil(String(item.text).length / 1.5), 0))
    stats.costCny = stats.tokens * price
    for (const item of payload?.output?.embeddings || []) {
      const target = batch[Number(item.text_index)]
      if (!target) continue
      vectors[target.index] = normalize(item.embedding)
      cache?.set(target.text, vectors[target.index])
    }
    cache?.flush()
    stats.cacheSize = cache ? cache.size : 0
    onProgress({ done: Math.min(start + batchSize, missing.length), total: missing.length, costCny: stats.costCny })
  }
  if (vectors.some(vector => !vector)) throw new Error('有文本没有拿到向量（接口返回不完整），本次中止')
  return { vectors, stats }
}

/**
 * 用向量索引做一次回退检索。
 *
 * records 用来做两件事：过滤（索引里可能有已经不在库里的课次）与取片段（调用方给 snippetOf）。
 * 门槛 minScore 是"宁可少报也不要瞎报"的那道线：默认 0.55，比它低的一律不报。
 */
export function semanticHits ({ index, queryVector, records = [], limit = 5, minScore = 0.55, snippetOf = null } = {}) {
  if (!index || !queryVector || !index.items?.size) return []
  const bySlug = new Map(records.map(record => [record.slug, record]))
  const bySection = new Map()
  for (const [key, entry] of index.items) {
    const hash = key.lastIndexOf('#')
    const slug = hash > 0 ? key.slice(0, hash) : key
    const sectionId = hash > 0 ? key.slice(hash + 1) : ''
    const record = bySlug.get(slug)
    if (!record) continue   // 课次已经不在库里：这条向量作废
    // 指纹校验：小节还在、且指纹一致才用（正文改过而索引没更新的，直接跳过）
    const section = (record.sections || []).find(item => item.id === sectionId)
    if (!section) continue
    if (entry.fingerprint && section.fingerprint && entry.fingerprint !== section.fingerprint) continue
    const similarity = cosine(queryVector, entry.vector)
    if (similarity < minScore) continue
    const current = bySection.get(slug)
    if (current && current.similarity >= similarity) continue
    bySection.set(slug, { slug, sectionId, similarity, record })
  }
  return [...bySection.values()]
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit)
    .map(item => ({
      slug: item.slug,
      courseName: item.record.courseName || '',
      lessonTitle: item.record.lessonTitle || '',
      lessonDate: item.record.lessonDate || '',
      theme: item.record.theme || '',
      keywords: (item.record.keywords || []).slice(0, 6),
      kind: '语义',
      kinds: ['语义'],
      location: { id: item.sectionId, title: sectionTitleOf(item.record, item.sectionId) },
      snippets: snippetOf ? [snippetOf(item.record, item.sectionId)].filter(Boolean) : [],
      score: Math.round(item.similarity * 1000) / 1000,
      similarity: Math.round(item.similarity * 1000) / 1000,
      // 这一条是"猜着找的"：调用方必须把它标给读者/模型看
      semantic: true
    }))
}

function sectionTitleOf (record, sectionId) {
  const section = (record.sections || []).find(item => item.id === sectionId)
  return section?.title || ''
}

/**
 * 把"索引 + 查询向量化 + 门槛"打包成检索层用的一个对象。
 * enabled=false 时 search() 直接返回空数组——调用方不必到处写 if。
 */
export function createSemanticFallback ({
  indexFile = '',
  apiKey = '',
  model = 'text-embedding-v3',
  getLibraryRevision = null,
  timeoutMs = 1000,
  minScore = 0.55,
  limit = 5,
  fetchImpl,
  /** 失败时的回调（每进程只报第一次）：线上排"为什么回退没生效"全靠它。 */
  onFailure = () => {}
} = {}) {
  const embedder = createQueryEmbedder({ apiKey, model, timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) })
  let reported = false
  const report = reason => {
    if (reported) return
    reported = true
    onFailure(reason)
  }
  const loadBoundIndex = () => {
    const expected = typeof getLibraryRevision === 'function'
      ? String(getLibraryRevision() || '')
      : ''
    return loadEmbeddingIndex(indexFile, { expectedLibraryRevision: expected })
  }
  return {
    get enabled () { return embedder.enabled },
    stats: () => embedder.stats(),
    status: () => {
      const loaded = loadBoundIndex()
      return {
        enabled: embedder.enabled,
        available: Boolean(loaded.index),
        reason: loaded.reason,
        libraryRevision: loaded.index?.libraryRevision || ''
      }
    },
    async search ({ query, records = [], snippetOf = null, limit: asked } = {}) {
      const loaded = loadBoundIndex()
      if (!loaded.index) { report(`索引不可用（${loaded.reason}）：${indexFile}`); return [] }
      const vector = await embedder.embed(query)
      if (!vector) {
        const stats = embedder.stats()
        report(`查询向量化失败：${stats.lastError || '未知'}（调用 ${stats.calls} 次，失败 ${stats.failures} 次）`)
        return []
      }
      return semanticHits({ index: loaded.index, queryVector: vector, records, limit: asked || limit, minScore, snippetOf })
    }
  }
}
