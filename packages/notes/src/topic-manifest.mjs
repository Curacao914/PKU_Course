const str = value => String(value ?? '').trim()

function unique(values = []) {
  return [...new Set(values.map(str).filter(Boolean))]
}

export function emptyTopicManifest() {
  return { version: 1, topics: [] }
}

export function normalizeTopicDefinition(value = {}, index = 0) {
  const course = str(value.course)
  const title = str(value.title || value.topic)
  const lessons = unique(Array.isArray(value.lessons) ? value.lessons : [])
  if (!course) throw new Error(`专题定义 #${index + 1} 缺课程名 course`)
  if (!title) throw new Error(`专题定义 #${index + 1} 缺标题 title`)
  if (!lessons.length) throw new Error(`专题「${course} · ${title}」至少要固定一个课次`)
  return {
    id: str(value.id) || `${course}::${title}`,
    course,
    title,
    ...(str(value.summary) ? { summary: str(value.summary) } : {}),
    lessons,
    enabled: value.enabled !== false
  }
}

export function normalizeTopicManifest(value) {
  const raw = value && typeof value === 'object' ? value : emptyTopicManifest()
  const list = Array.isArray(raw.topics) ? raw.topics : []
  const topics = list.map(normalizeTopicDefinition)
  const ids = new Set()
  for (const item of topics) {
    if (ids.has(item.id)) throw new Error(`专题清单里 id 重复：${item.id}`)
    ids.add(item.id)
  }
  return { version: 1, topics }
}

export function replaceCourseTopics(manifest, course, definitions = []) {
  const current = normalizeTopicManifest(manifest)
  const wanted = str(course)
  const topics = definitions.map((item, index) => normalizeTopicDefinition({ ...item, course: wanted }, index))
  return normalizeTopicManifest({
    version: 1,
    topics: [...current.topics.filter(item => item.course !== wanted), ...topics]
  })
}

export function upsertTopicDefinition(manifest, definition) {
  const current = normalizeTopicManifest(manifest)
  const normalized = normalizeTopicDefinition(definition, current.topics.length)
  return normalizeTopicManifest({
    version: 1,
    topics: [...current.topics.filter(item => item.id !== normalized.id), normalized]
  })
}

export function removeTopicDefinition(manifest, id) {
  const current = normalizeTopicManifest(manifest)
  const wanted = str(id)
  if (!wanted) throw new Error('删除专题定义需要 id')
  const topics = current.topics.filter(item => item.id !== wanted)
  return { version: 1, topics, removed: topics.length !== current.topics.length }
}

export function selectConfiguredTopics(manifest, { id = '', course = '', lesson = '', enabledOnly = true } = {}) {
  const current = normalizeTopicManifest(manifest)
  const wantedId = str(id)
  const wantedCourse = str(course)
  const wantedLesson = str(lesson)
  return current.topics.filter(item => {
    if (enabledOnly && !item.enabled) return false
    if (wantedId && item.id !== wantedId) return false
    if (wantedCourse && item.course !== wantedCourse) return false
    if (wantedLesson && !item.lessons.includes(wantedLesson)) return false
    return true
  })
}
