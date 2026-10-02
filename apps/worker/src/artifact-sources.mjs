import fs from 'node:fs'
import path from 'node:path'

/**
 * Active brief/onepage files live in replay output trees.
 *
 * Do not scan the whole scratch root: experiments and source-sync/source-revision
 * backups intentionally contain historical copies of brief.json/onepage.json.
 * Treating those copies as live artifacts makes inventory noisy and can hide the
 * one thing the command is supposed to answer: "what derived views are active now?"
 */
export function activeArtifactDirs(scratchRoot) {
  const root = path.join(path.resolve(String(scratchRoot)), 'replays')
  if (!fs.existsSync(root)) return []

  const dirs = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    let hasArtifact = false
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(path.join(dir, entry.name), depth + 1)
        continue
      }
      if (entry.name === 'brief.json' || entry.name === 'onepage.json') hasArtifact = true
    }
    if (hasArtifact) dirs.push(dir)
  }
  walk(root, 0)
  return dirs.sort()
}
