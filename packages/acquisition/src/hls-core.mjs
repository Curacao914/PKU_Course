import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g,
  /(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi,
  /(cookie\s*[:=]\s*)[^\n]+/gi
]

const SAFE_EXTENSIONS = new Set([
  'aac', 'ac3', 'bin', 'cmfa', 'cmfv', 'ec3', 'fmp4', 'key', 'm3u8',
  'm4a', 'm4s', 'm4v', 'mp3', 'mp4', 'mpeg', 'mpegts', 'mpg', 'oga',
  'ogg', 'ogv', 'ts', 'vtt', 'wav', 'webvtt'
])

export function redactText(value) {
  let text = String(value || '')
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_, prefix = '') => `${prefix}<REDACTED>`)
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '<REDACTED_URL>')
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

export function safeName(value, fallback = 'course-replay') {
  return String(value || fallback)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || fallback
}

export function extensionForUrl(rawUrl, fallback = 'ts') {
  try {
    const pathname = new URL(rawUrl).pathname
    const match = pathname.match(/\.([A-Za-z0-9]{1,8})$/)
    const extension = match?.[1]?.toLowerCase() || ''
    return SAFE_EXTENSIONS.has(extension) ? extension : fallback
  } catch {
    return fallback
  }
}

export function parseAttributeList(raw) {
  const result = {}
  const input = String(raw || '')
  const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi
  let match
  while ((match = regex.exec(input))) {
    const key = match[1].toUpperCase()
    let value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"')
    }
    result[key] = value
  }
  return result
}

export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/)
  const variants = []
  const media = []
  let pendingVariant = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length))
      if (attributes.URI) {
        media.push({
          type: String(attributes.TYPE || '').toUpperCase(),
          groupId: attributes['GROUP-ID'] || '',
          name: attributes.NAME || '',
          default: String(attributes.DEFAULT || '').toUpperCase() === 'YES',
          autoselect: String(attributes.AUTOSELECT || '').toUpperCase() === 'YES',
          language: attributes.LANGUAGE || '',
          url: new URL(attributes.URI, baseUrl).href,
          attributes
        })
      }
      continue
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length))
      continue
    }
    if (pendingVariant && !line.startsWith('#')) {
      variants.push({
        bandwidth: Number(pendingVariant.BANDWIDTH || 0),
        averageBandwidth: Number(pendingVariant['AVERAGE-BANDWIDTH'] || 0),
        resolution: pendingVariant.RESOLUTION || '',
        codecs: pendingVariant.CODECS || '',
        audioGroup: pendingVariant.AUDIO || '',
        url: new URL(line, baseUrl).href,
        attributes: pendingVariant
      })
      pendingVariant = null
    }
  }

  return { variants, media, isMaster: variants.length > 0 }
}

export function chooseVariant(master) {
  if (!master?.variants?.length) return null
  return [...master.variants].sort((a, b) => {
    const left = a.averageBandwidth || a.bandwidth
    const right = b.averageBandwidth || b.bandwidth
    return right - left
  })[0]
}

export function chooseAudioRendition(master, variant) {
  if (!variant?.audioGroup) return null
  const candidates = (master.media || []).filter(item =>
    item.type === 'AUDIO' && item.groupId === variant.audioGroup
  )
  return candidates.find(item => item.default) ||
    candidates.find(item => item.autoselect) ||
    candidates[0] ||
    null
}

function parseByteRange(raw, previousEnd = 0) {
  const match = String(raw || '').trim().match(/^(\d+)(?:@(\d+))?$/)
  if (!match) return null
  const length = Number(match[1])
  const start = match[2] != null ? Number(match[2]) : previousEnd
  return { start, end: start + length - 1, length }
}

function replaceUriAttribute(line, replacement) {
  let next = /URI="[^"]+"/.test(line)
    ? line.replace(/URI="[^"]+"/, `URI="${replacement}"`)
    : line.replace(/URI=([^,\s]+)/, `URI=${replacement}`)
  next = next
    .replace(/,?BYTERANGE="[^"]+"/gi, '')
    .replace(/,?BYTERANGE=[^,\s]+/gi, '')
    .replace(/:{1},/, ':')
  return next
}

export function parseMediaPlaylist(text, baseUrl, trackKey = 'primary') {
  const lines = String(text || '').split(/\r?\n/)
  const entries = []
  const resources = []
  const resourceByKey = new Map()
  const previousRangeEndByUrl = new Map()
  let pendingDuration = 0
  let pendingByteRangeRaw = ''
  let segmentIndex = 0
  let keyIndex = 0
  let mapIndex = 0
  let targetDuration = 0

  function registerResource({ kind, rawUri, fallback, range = null, sequence = 0 }) {
    const url = new URL(rawUri, baseUrl).href
    const rangeKey = range ? `${range.start}-${range.end}` : ''
    const key = `${kind}|${url}|${rangeKey}`
    if (resourceByKey.has(key)) return resourceByKey.get(key)

    const extension = extensionForUrl(url, fallback)
    const prefix = kind === 'segment'
      ? `segment-${String(sequence).padStart(6, '0')}`
      : kind === 'key'
        ? `key-${String(++keyIndex).padStart(3, '0')}`
        : `init-${String(++mapIndex).padStart(3, '0')}`
    const fileName = `${prefix}.${extension}`
    const resource = {
      id: `${trackKey}-${kind}-${sha256(key).slice(0, 16)}`,
      kind,
      fileName,
      url,
      urlHash: sha256(url),
      range,
      duration: kind === 'segment' ? pendingDuration : 0,
      sequence
    }
    resources.push(resource)
    resourceByKey.set(key, resource)
    return resource
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1] || 0)
      entries.push({ type: 'raw', value: rawLine })
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice('#EXTINF:'.length).split(',')[0] || 0)
      entries.push({ type: 'raw', value: rawLine })
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRangeRaw = line.slice('#EXT-X-BYTERANGE:'.length).trim()
      entries.push({ type: 'raw', value: rawLine })
      continue
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-KEY:'.length))
      if (attributes.URI) {
        const resource = registerResource({
          kind: 'key',
          rawUri: attributes.URI,
          fallback: 'key'
        })
        entries.push({ type: 'uri-attribute', original: rawLine, resourceId: resource.id })
      } else {
        entries.push({ type: 'raw', value: rawLine })
      }
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length))
      if (attributes.URI) {
        const absolute = new URL(attributes.URI, baseUrl).href
        const range = attributes.BYTERANGE
          ? parseByteRange(attributes.BYTERANGE, previousRangeEndByUrl.get(absolute) || 0)
          : null
        if (range) previousRangeEndByUrl.set(absolute, range.end + 1)
        const resource = registerResource({
          kind: 'map',
          rawUri: attributes.URI,
          fallback: 'mp4',
          range
        })
        entries.push({ type: 'uri-attribute', original: rawLine, resourceId: resource.id })
      } else {
        entries.push({ type: 'raw', value: rawLine })
      }
      continue
    }
    if (line && !line.startsWith('#')) {
      segmentIndex += 1
      const absolute = new URL(line, baseUrl).href
      const range = pendingByteRangeRaw
        ? parseByteRange(pendingByteRangeRaw, previousRangeEndByUrl.get(absolute) || 0)
        : null
      if (range) previousRangeEndByUrl.set(absolute, range.end + 1)
      const resource = registerResource({
        kind: 'segment',
        rawUri: line,
        fallback: 'ts',
        range,
        sequence: segmentIndex
      })
      entries.push({
        type: 'segment',
        resourceId: resource.id,
        sequence: segmentIndex,
        duration: pendingDuration
      })
      pendingDuration = 0
      pendingByteRangeRaw = ''
      continue
    }
    entries.push({ type: 'raw', value: rawLine })
  }

  const segmentCount = resources.filter(item => item.kind === 'segment').length
  const totalDuration = resources
    .filter(item => item.kind === 'segment')
    .reduce((sum, item) => sum + Number(item.duration || 0), 0)

  return {
    trackKey,
    entries,
    resources,
    segmentCount,
    totalDuration,
    targetDuration
  }
}

export function selectSampleResources(track, seconds = 180) {
  let elapsed = 0
  let maxSequence = 0
  for (const resource of track.resources.filter(item => item.kind === 'segment')) {
    elapsed += Number(resource.duration || 0)
    maxSequence = resource.sequence
    if (elapsed >= seconds) break
  }
  const selectedIds = new Set()
  for (const resource of track.resources) {
    if (resource.kind !== 'segment' || resource.sequence <= maxSequence) {
      selectedIds.add(resource.id)
    }
  }
  return { selectedIds, maxSequence, duration: elapsed }
}

export function renderLocalPlaylist(track, trackDir, selectedMaxSequence = Infinity) {
  const byId = new Map(track.resources.map(item => [item.id, item]))
  const output = []
  let stopped = false

  for (const entry of track.entries) {
    if (stopped) break

    if (entry.type === 'segment') {
      if (entry.sequence > selectedMaxSequence) {
        stopped = true
        break
      }
      const resource = byId.get(entry.resourceId)
      output.push(resource.fileName)
      continue
    }

    if (entry.type === 'uri-attribute') {
      const resource = byId.get(entry.resourceId)
      output.push(replaceUriAttribute(entry.original, resource.fileName))
      continue
    }

    if (entry.type === 'raw') {
      const trimmed = entry.value.trim()
      if (trimmed === '#EXT-X-ENDLIST') continue
      if (trimmed.startsWith('#EXT-X-BYTERANGE:')) continue
      output.push(entry.value)
    }
  }

  output.push('#EXT-X-ENDLIST')
  const text = output.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
  if (/https?:\/\//i.test(text)) throw new Error('Local playlist unexpectedly contains an upstream URL')
  return text
}

export function buildSafeState({ lessonName, playlistFingerprint, tracks, concurrency }) {
  return {
    schemaVersion: 1,
    lessonName,
    playlistFingerprint,
    concurrency,
    updatedAt: new Date().toISOString(),
    tracks: tracks.map(track => ({
      trackKey: track.trackKey,
      segmentCount: track.segmentCount,
      totalDuration: track.totalDuration,
      resources: track.resources.map(resource => ({
        id: resource.id,
        kind: resource.kind,
        fileName: resource.fileName,
        urlHash: resource.urlHash,
        range: resource.range,
        duration: resource.duration,
        sequence: resource.sequence
      }))
    }))
  }
}

export function assertStateHasNoSecrets(state) {
  const serialized = JSON.stringify(state)
  if (/https?:\/\//i.test(serialized)) throw new Error('State contains URL')
  if (/authorization|cookie|bearer|referer|origin/i.test(serialized)) {
    throw new Error('State contains authentication fields')
  }
  return true
}

export function fileComplete(filePath, range = null) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0) return false
    if (range?.length && stat.size !== range.length) return false
    return true
  } catch {
    return false
  }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.part`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temp, filePath)
}
