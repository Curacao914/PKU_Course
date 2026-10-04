const str = value => String(value ?? '').trim()

function uniqueBy (items, keyOf) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

/**
 * 所有“派生内容 → 原笔记”的通用最小引用。
 *
 * 一页纸现有 SourceMap 还有 block/quote 等自己的校验信息；专题、知识地图只需要把
 * 最终落点统一成 slug + sectionId。title/quote 是给人看的辅助信息，不参与身份判断。
 */
export function normalizeSourceRef (value = {}) {
  const slug = str(value.slug)
  const sectionId = str(value.sectionId || value.anchor || value.id)
  if (!slug) throw new Error('sourceRef 缺课次 slug')
  if (!sectionId) throw new Error(`sourceRef（${slug}）缺 sectionId`)
  return {
    slug,
    sectionId,
    ...(str(value.title) ? { title: str(value.title) } : {}),
    ...(str(value.quote) ? { quote: str(value.quote).slice(0, 160) } : {})
  }
}

export function normalizeSourceRefs (values = []) {
  if (!Array.isArray(values)) throw new Error('sourceRefs 必须是数组')
  return uniqueBy(values.map(normalizeSourceRef), item => `${item.slug}#${item.sectionId}`)
}

export function sourceRefHref (value = {}) {
  const ref = normalizeSourceRef(value)
  const slug = ref.slug.replace(/^\/+/, '')
  return `/${slug}.html#${encodeURIComponent(ref.sectionId)}`
}

const RELATIONS = new Set(['hierarchy', 'parallel', 'condition', 'sequence', 'exception', 'contrast'])

function normalizeNode (value = {}, path = []) {
  const title = str(value.title)
  if (!title) throw new Error(`专题节点 ${path.join('.') || 'root'} 缺标题`)
  const children = Array.isArray(value.children)
    ? value.children.map((child, index) => normalizeNode(child, [...path, index + 1]))
    : []
  const relation = RELATIONS.has(str(value.relation)) ? str(value.relation) : 'hierarchy'
  const sourceRefs = normalizeSourceRefs(value.sourceRefs || [])
  const id = str(value.id) || `node-${path.join('-') || '1'}`
  return {
    id,
    title,
    relation,
    ...(str(value.note) ? { note: str(value.note) } : {}),
    sourceRefs,
    children
  }
}

/**
 * 专题整合的唯一内容模型。
 *
 * 三种前台视图都从 nodes 派生：
 * - 框架：按 relation 渲染树 / 条件 / 例外 / 对照；
 * - 提纲：把同一棵树线性展开；
 * - 自测：隐藏同一棵树的若干 title/note，再点击揭示。
 *
 * AI 不分别生成三份内容。
 */
export function normalizeTopicArtifact (value = {}) {
  const course = str(value.course)
  const title = str(value.title || value.topic)
  if (!course) throw new Error('专题缺课程 course')
  if (!title) throw new Error('专题缺标题 title')
  const lessons = uniqueBy((Array.isArray(value.lessons) ? value.lessons : []).map(item => {
    if (typeof item === 'string') return { slug: str(item) }
    return {
      slug: str(item?.slug),
      ...(str(item?.lessonTitle) ? { lessonTitle: str(item.lessonTitle) } : {}),
      ...(str(item?.lessonDate) ? { lessonDate: str(item.lessonDate) } : {}),
      ...(str(item?.checksum) ? { checksum: str(item.checksum) } : {}),
      ...(str(item?.contentFingerprint) ? { contentFingerprint: str(item.contentFingerprint) } : {})
    }
  }).filter(item => item.slug), item => item.slug)
  if (!lessons.length) throw new Error(`专题「${course} · ${title}」至少要覆盖一个课次`)
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.map((node, index) => normalizeNode(node, [index + 1]))
    : []
  if (!nodes.length) throw new Error(`专题「${course} · ${title}」至少要有一个框架节点`)
  return {
    kind: 'course-topic',
    version: 1,
    id: str(value.id) || `${course}::${title}`,
    course,
    title,
    ...(str(value.summary) ? { summary: str(value.summary) } : {}),
    ...(str(value.generatedAt) ? { generatedAt: str(value.generatedAt) } : {}),
    lessons,
    nodes
  }
}

function recordSections (record = {}) {
  return new Map((Array.isArray(record.sections) ? record.sections : []).map(section => [
    str(section.id),
    section
  ]).filter(([id]) => id))
}

/**
 * 检查专题所有实质节点能否回到当前单课笔记。
 * 分组节点可以自己不挂出处，但叶节点必须至少有一处；这样“标题框”不必伪造来源，
 * 真正承载知识判断的末端节点则一定能钻回课堂原文。
 */
export function checkTopicSources (topic, records = []) {
  const normalized = normalizeTopicArtifact(topic)
  const bySlug = new Map(records.map(record => [str(record.slug), record]))
  const problems = []

  function walk (node, trail) {
    const where = [...trail, node.title].join(' › ')
    if (!node.children.length && !node.sourceRefs.length) {
      problems.push({ level: 'error', code: 'missing-source', nodeId: node.id, message: `叶节点「${where}」没有原笔记出处` })
    }
    for (const ref of node.sourceRefs) {
      const record = bySlug.get(ref.slug)
      if (!record) {
        problems.push({ level: 'error', code: 'missing-lesson', nodeId: node.id, ref, message: `「${where}」指向不存在的课次 ${ref.slug}` })
        continue
      }
      const sections = recordSections(record)
      if (!sections.has(ref.sectionId)) {
        problems.push({ level: 'error', code: 'missing-section', nodeId: node.id, ref, message: `「${where}」指向不存在的小节 #${ref.sectionId}` })
      }
    }
    node.children.forEach(child => walk(child, [...trail, node.title]))
  }

  normalized.nodes.forEach(node => walk(node, []))
  return problems
}

export function topicSourceStats (topic) {
  const normalized = normalizeTopicArtifact(topic)
  let nodes = 0
  let sourcedNodes = 0
  let refs = 0
  function walk (node) {
    nodes += 1
    if (node.sourceRefs.length) sourcedNodes += 1
    refs += node.sourceRefs.length
    node.children.forEach(walk)
  }
  normalized.nodes.forEach(walk)
  return {
    nodes,
    sourcedNodes,
    refs,
    coverage: nodes ? sourcedNodes / nodes : 0
  }
}
