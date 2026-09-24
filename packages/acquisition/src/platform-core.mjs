import crypto from 'node:crypto'

export const REPLAY_IDENTITY_VERSION = 'semantic-v2'

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

export function normalizeCourseName(value) {
  return String(value || '')
    .normalize('NFKC')
    // 学期后缀的年份位数兼容两位与四位：原实现写死 \d{2}-\d{2}，
    // 与同文件 parseCourseLabel 的宽松匹配（[^()（）]*?学年第\d学期）不一致，
    // 导致 "（2025-2026学年第1学期）" 这类真实标签不会被剥除。
    .replace(/[（(]\s*\d{2,4}-\d{2,4}学年第\d+学期[^()（）]*[）)]\s*$/u, '')
    .replace(/^\s*[^:：]{3,120}[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseCourseLabel(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim()
  const chineseColon = raw.indexOf('：')
  const asciiColon = raw.indexOf(': ')
  const colonIndex = chineseColon >= 0
    ? chineseColon
    : asciiColon
  const prefix = colonIndex >= 0 ? raw.slice(0, colonIndex).trim() : ''
  const remainder = colonIndex >= 0
    ? raw.slice(colonIndex + (raw[colonIndex] === '：' ? 1 : 2)).trim()
    : raw
  const termMatch = remainder.match(/[（(]([^()（）]*?学年第\d学期[^()（）]*)[）)]\s*$/u)
  const term = termMatch?.[1]?.trim() || ''
  const name = termMatch
    ? remainder.slice(0, termMatch.index).trim()
    : remainder
  const termCodeMatch = prefix.match(/^(\d{5})-/)
  return {
    rawLabel: raw,
    platformDisplayCode: prefix,
    termCode: termCodeMatch?.[1] || '',
    name: name || normalizeCourseName(raw),
    normalizedName: normalizeCourseName(name || raw),
    term
  }
}

export function chooseCurrentCourses(courses) {
  const explicitlyCurrent = courses.filter(course => course.section === 'current')
  if (explicitlyCurrent.length) return explicitlyCurrent

  const codes = courses.map(course => course.termCode).filter(Boolean).sort().reverse()
  if (codes.length) {
    const latest = codes[0]
    return courses.filter(course => course.termCode === latest)
  }
  return courses
}

export function courseKey(identity) {
  return `course-${sha256(identity).slice(0, 24)}`
}

export function semanticReplayIdentity(recording) {
  return [
    String(recording?.title || '').replace(/\s+/g, ' ').trim(),
    String(recording?.startsAtText || '').replace(/\s+/g, ' ').trim(),
    String(recording?.teacher || '').replace(/\s+/g, ' ').trim()
  ].join('|')
}

export function replayKey(courseIdentity, recordingOrIdentity) {
  const replayIdentity = typeof recordingOrIdentity === 'string'
    ? recordingOrIdentity
    : semanticReplayIdentity(recordingOrIdentity)
  return `replay-${sha256(`${courseIdentity}|${replayIdentity}`).slice(0, 24)}`
}

export function normalizeRecordingRow(cells) {
  const values = (cells || []).map(value => String(value || '').replace(/\s+/g, ' ').trim())
  return {
    title: values[0] || '',
    startsAtText: values[1] || '',
    teacher: values[2] || '',
    operation: values[3] || ''
  }
}

export function dedupeRecordings(recordings) {
  const map = new Map()
  for (const recording of recordings || []) {
    const key = recording.replayKey ||
      semanticReplayIdentity(recording)
    if (!map.has(key)) map.set(key, recording)
  }
  return [...map.values()]
}

export function compareWithState(catalog, previousState, now = new Date().toISOString()) {
  const compatiblePrevious = previousState?.replayIdentityVersion === REPLAY_IDENTITY_VERSION
    ? previousState
    : null
  const firstRun = !compatiblePrevious?.courses

  const nextState = {
    schemaVersion: 2,
    replayIdentityVersion: REPLAY_IDENTITY_VERSION,
    updatedAt: now,
    courses: {}
  }
  let newReplayCount = 0

  const courses = catalog.map(course => {
    const oldCourse = compatiblePrevious?.courses?.[course.courseKey] || { replays: {} }
    const replayMap = {}
    const recordings = dedupeRecordings(course.recordings).map(recording => {
      const oldReplay = oldCourse.replays?.[recording.replayKey]
      const isNew = !firstRun && !oldReplay
      if (isNew) newReplayCount += 1
      replayMap[recording.replayKey] = {
        firstSeenAt: oldReplay?.firstSeenAt || now,
        lastSeenAt: now
      }
      return { ...recording, isNew }
    })

    nextState.courses[course.courseKey] = {
      firstSeenAt: oldCourse.firstSeenAt || now,
      lastSeenAt: now,
      replays: replayMap
    }
    return {
      ...course,
      recordingCount: recordings.length,
      recordings
    }
  })

  return {
    courses,
    nextState,
    baselineInitialized: firstRun,
    baselineResetReason: previousState && !compatiblePrevious
      ? 'replay-identity-version-upgrade'
      : null,
    newReplayCount
  }
}

const FORBIDDEN_OUTPUT_KEY = /^(authorization|cookie|cookies|bearer|password|passwd|pwd|pku_username|pku_password|token|access_token|refresh_token|course_id|auth_data)$/i
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?$/
const BEARER_VALUE = /^Bearer\s+\S+/i

export function assertNoSecrets(value) {
  function visit(node, path = '$') {
    if (node == null) return

    if (typeof node === 'string') {
      if (/https?:\/\//i.test(node)) {
        throw new Error(`Output contains URL at ${path}`)
      }
      if (JWT_VALUE.test(node) || BEARER_VALUE.test(node)) {
        throw new Error(`Output contains credential value at ${path}`)
      }
      if (/[?&](token|course_id|auth_data)=/i.test(node)) {
        throw new Error(`Output contains platform identifier at ${path}`)
      }
      return
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }

    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_OUTPUT_KEY.test(key)) {
          throw new Error(`Output contains forbidden field: ${path}.${key}`)
        }
        visit(child, `${path}.${key}`)
      }
    }
  }

  visit(value)
  return true
}
