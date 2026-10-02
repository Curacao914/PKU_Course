const str = value => String(value ?? '').trim()

function unique(values = []) {
  return [...new Set(values.map(str).filter(Boolean))]
}

export function emptyIntegrationManifest() {
  return { version: 1, integrations: [] }
}

export function normalizeIntegrationDefinition(value = {}, index = 0) {
  const course = str(value.course)
  const topic = str(value.topic)
  const lessons = unique(Array.isArray(value.lessons) ? value.lessons : [])
  if (!course) throw new Error(`整合定义 #${index + 1} 缺课程名 course`)
  if (!topic) throw new Error(`整合定义 #${index + 1} 缺主题 topic`)
  if (!lessons.length) throw new Error(`整合定义「${course} · ${topic}」至少要固定一个课次`)
  const id = str(value.id) || `${course}::${topic}`
  return {
    id,
    course,
    topic,
    lessons,
    enabled: value.enabled !== false
  }
}

export function normalizeIntegrationManifest(value) {
  const raw = value && typeof value === 'object' ? value : emptyIntegrationManifest()
  const list = Array.isArray(raw.integrations) ? raw.integrations : []
  const integrations = list.map(normalizeIntegrationDefinition)
  const ids = new Set()
  for (const item of integrations) {
    if (ids.has(item.id)) throw new Error(`整合清单里 id 重复：${item.id}`)
    ids.add(item.id)
  }
  return { version: 1, integrations }
}

export function upsertIntegrationDefinition(manifest, definition) {
  const current = normalizeIntegrationManifest(manifest)
  const normalized = normalizeIntegrationDefinition(definition, current.integrations.length)
  return {
    version: 1,
    integrations: [
      ...current.integrations.filter(item => item.id !== normalized.id),
      normalized
    ]
  }
}

export function selectConfiguredIntegrations(manifest, { id = '', course = '', lesson = '', enabledOnly = true } = {}) {
  const current = normalizeIntegrationManifest(manifest)
  const wantedId = str(id)
  const wantedCourse = str(course)
  const wantedLesson = str(lesson)
  return current.integrations.filter(item => {
    if (enabledOnly && !item.enabled) return false
    if (wantedId && item.id !== wantedId) return false
    if (wantedCourse && item.course !== wantedCourse) return false
    if (wantedLesson && !item.lessons.includes(wantedLesson)) return false
    return true
  })
}
