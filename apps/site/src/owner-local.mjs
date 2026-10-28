import fs from 'node:fs'
import path from 'node:path'

let cached = null

/** The OWNER's already-published local snapshot is the fast read source.
 * A release-symlink switch must invalidate the cache even if file timestamps match.
 * Private routes authenticate BEFORE calling this function.
 */
export function readOwnerLocalState(root) {
  const resolvedRoot = fs.realpathSync(root)
  const library = path.join(resolvedRoot, 'library.json')
  const topicIndex = path.join(resolvedRoot, 'topics.json')
  const lst = fs.statSync(library)
  const tst = fs.existsSync(topicIndex) ? fs.statSync(topicIndex) : null
  // Stable OWNER-only overlay lives outside versioned site releases and survives publish.
  const overlay = path.join(path.dirname(root), 'owner-content', 'topics.json')
  const ost = fs.existsSync(overlay) ? fs.statSync(overlay) : null
  const fingerprint = [
    resolvedRoot, lst.mtimeMs, lst.size, tst?.mtimeMs ?? '', tst?.size ?? '',
    ost?.mtimeMs ?? '', ost?.size ?? ''
  ].join('|')
  if (cached?.fingerprint === fingerprint) return cached.state

  const records = JSON.parse(fs.readFileSync(library, 'utf8'))
  if (!Array.isArray(records)) throw new Error('OWNER 发布库应当是笔记记录数组')
  const topics = []
  if (tst) {
    const index = JSON.parse(fs.readFileSync(topicIndex, 'utf8'))
    for (const item of Array.isArray(index.topics) ? index.topics : []) {
      const name = String(item.json || '').replace(/^\/+/, '')
      if (!name) continue
      const file = path.resolve(resolvedRoot, name)
      if (!file.startsWith(resolvedRoot + path.sep)) continue
      try {
        const artifact = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (artifact.kind === 'course-topic' && artifact.id === item.id) topics.push(artifact)
      } catch {} // A stale or missing topic index entry is skipped; notes remain readable.
    }
  }
  if (ost) {
    const overlayTopics = JSON.parse(fs.readFileSync(overlay, 'utf8'))
    if (!Array.isArray(overlayTopics.topics)) throw new Error('OWNER 专题备份格式错误')
    for (const item of overlayTopics.topics) {
      const topic = item?.artifact
      if (!topic || topic.kind !== 'course-topic' || !topic.id) continue
      const index = topics.findIndex(existing => existing.id === topic.id)
      if (index >= 0) topics[index] = topic
      else topics.push(topic)
    }
  }
  const state = { source: 'owner-local', notes: records, records, topics }
  cached = { fingerprint, state }
  return state
}
