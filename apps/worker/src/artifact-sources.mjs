import fs from 'node:fs'
import path from 'node:path'

/**
 * Active brief/onepage files live in:
 *   <scratchRoot>/replays/<replayKey>/transcript/
 *
 * Do not recursively scan the whole replay tree. Real replay directories also keep
 * experiment outputs under replays/<key>/experiments/**, and those historical copies
 * intentionally contain brief.json/onepage.json. Counting them as active artifacts
 * makes inventory noisy and can obscure the actual publishable copy.
 */
export function activeArtifactDirs(scratchRoot) {
  const root = path.join(path.resolve(String(scratchRoot)), 'replays')
  if (!fs.existsSync(root)) return []

  const dirs = []
  let replayDirs = []
  try { replayDirs = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  for (const replay of replayDirs) {
    if (!replay.isDirectory() || replay.name.startsWith('.')) continue
    const transcriptDir = path.join(root, replay.name, 'transcript')
    let entries = []
    try { entries = fs.readdirSync(transcriptDir, { withFileTypes: true }) } catch { continue }
    if (entries.some(entry => entry.isFile() && (entry.name === 'brief.json' || entry.name === 'onepage.json'))) {
      dirs.push(transcriptDir)
    }
  }
  return dirs.sort()
}
