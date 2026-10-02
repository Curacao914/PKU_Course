import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const str = value => String(value ?? '').trim()

export function safeNoteFileName(value) {
  return String(value || 'note')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'note'
}

export function normalizedMarkdown(markdown = '') {
  return String(markdown)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\s+$/g, '')
}

export function sourceRevisionChecksum(markdown = '') {
  return crypto.createHash('sha256').update(normalizedMarkdown(markdown), 'utf8').digest('hex')
}

export function sourceRevisionPaths({ scratchRoot, record } = {}) {
  const replayKey = str(record?.replayKey)
  const lessonTitle = str(record?.lessonTitle)
  if (!replayKey || !lessonTitle) return null
  const outputDir = path.join(path.resolve(String(scratchRoot)), 'replays', replayKey, 'transcript')
  return {
    replayKey,
    outputDir,
    notePath: path.join(outputDir, safeNoteFileName(lessonTitle) + '.md'),
    statePath: path.join(outputDir, 'lesson-state.json'),
    summaryPath: path.join(outputDir, 'notes-run-summary.json')
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Compare the three copies that matter for a republish:
 *   published = current library fact source
 *   source    = the Markdown that course publish --from will actually read
 *   state     = lesson-state.finalNote, i.e. the notes pipeline's latest final note
 *
 * source-state-drift is the dangerous state: the file publish reads does not even
 * match the pipeline state that supposedly produced it. unpublished-change is
 * different: source == state, but both differ from production — likely an intentional
 * revision waiting to be published.
 */
export function inspectSourceRevision({ scratchRoot, record } = {}) {
  const paths = sourceRevisionPaths({ scratchRoot, record })
  if (!paths) {
    return {
      status: 'untracked',
      replayKey: str(record?.replayKey),
      courseName: str(record?.courseName),
      lessonTitle: str(record?.lessonTitle),
      slug: str(record?.slug)
    }
  }

  const source = readText(paths.notePath)
  const state = readJson(paths.statePath)
  const finalNote = state?.lesson?.finalNote?.markdown
  const published = String(record?.markdown ?? '')
  const sourceChecksum = source == null ? '' : sourceRevisionChecksum(source)
  const stateChecksum = typeof finalNote === 'string' && finalNote.trim() ? sourceRevisionChecksum(finalNote) : ''
  const publishedChecksum = sourceRevisionChecksum(published)

  let status = 'fresh'
  if (source == null) status = 'source-missing'
  else if (stateChecksum && sourceChecksum !== stateChecksum) status = 'source-state-drift'
  else if (sourceChecksum !== publishedChecksum) status = 'unpublished-change'

  return {
    status,
    replayKey: paths.replayKey,
    courseName: str(record?.courseName),
    lessonTitle: str(record?.lessonTitle),
    slug: str(record?.slug),
    notePath: paths.notePath,
    statePath: paths.statePath,
    sourceChecksum,
    stateChecksum,
    publishedChecksum,
    sourceMatchesState: Boolean(sourceChecksum && stateChecksum && sourceChecksum === stateChecksum),
    sourceMatchesPublished: Boolean(sourceChecksum && sourceChecksum === publishedChecksum),
    stateMatchesPublished: Boolean(stateChecksum && stateChecksum === publishedChecksum)
  }
}

export function scanSourceRevisions({ scratchRoot, records = [] } = {}) {
  const items = records.map(record => inspectSourceRevision({ scratchRoot, record }))
  const counts = {}
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1
  return { items, counts, total: items.length }
}

export function formatSourceRevisions(report = {}) {
  const items = report.items || []
  const problems = items.filter(item => item.status !== 'fresh' && item.status !== 'untracked')
  if (!problems.length) return '单课源一致性：没有发现可再发布源文件漂移。'
  const lines = ['单课源一致性：' + problems.length + ' 篇需要看一眼']
  for (const item of problems) {
    const label = item.status === 'source-state-drift'
      ? '危险：发布文件与 lesson-state 不一致'
      : item.status === 'unpublished-change'
        ? '待发布：源与 state 一致，但不同于正式正文'
        : '源文件缺失'
    lines.push('  [' + item.status + '] ' + item.courseName + '·' + item.lessonTitle + ' — ' + label)
  }
  return lines.join('\n')
}
