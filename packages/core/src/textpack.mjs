import fs from 'node:fs'
import path from 'node:path'

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u0000/g, '').trim()
}

function safeName(value, fallback = '未命名') {
  return cleanText(value).normalize('NFKC').replace(/[<>:"|?*]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || fallback
}

function checksum(text) {
  let hash = 2166136261
  for (let index = 0; index < String(text || '').length; index += 1) {
    hash ^= String(text).charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function splitTranscript(transcript, linesPerSegment = 500) {
  const lines = cleanText(transcript).split('\n').filter(Boolean)
  const segments = []
  for (let index = 0; index < lines.length && segments.length < 80; index += linesPerSegment) {
    const chunk = lines.slice(index, index + linesPerSegment)
    segments.push({
      key: `segment-${String(segments.length + 1).padStart(2, '0')}`,
      startLine: index + 1,
      endLine: index + chunk.length,
      charCount: chunk.join('\n').length
    })
  }
  return segments
}

function sourceMap(transcript, sourceFile) {
  return cleanText(transcript).split('\n').map((line, index) => ({
    line: index + 1,
    sourceLine: index + 1,
    time: line.match(/^\[([^\]]+)\]/)?.[1] || null,
    file: sourceFile
  }))
}

export function buildTranscriptTextPack(input = {}) {
  const transcript = cleanText(input.transcript)
  if (!transcript) throw new Error('Transcript is required')
  if (transcript.length > 220_000) throw new Error('Transcript exceeds the per-lesson TextPack limit')

  const courseName = safeName(input.courseName, '未命名课程')
  const lessonTitle = safeName(input.lessonTitle, '未命名课次')
  const sourceFile = safeName(input.sourceFile || `${lessonTitle}-raw-transcript.md`)
  const lessonKey = String(input.lessonKey || '').replace(/[^A-Za-z0-9._:-]/g, '-') ||
    `lesson-${checksum(lessonTitle).replace('fnv1a-', '')}`
  const lesson = {
    order: Number(input.order || 1),
    key: lessonKey,
    title: lessonTitle,
    sourceFile,
    transcript,
    transcriptCharCount: transcript.length,
    transcriptLineCount: transcript.split('\n').length,
    segments: splitTranscript(transcript),
    materials: [],
    sourceMap: sourceMap(transcript, sourceFile),
    warnings: []
  }
  const sourceHash = checksum(JSON.stringify({ courseName, lessonTitle, transcriptChecksum: checksum(transcript) }))

  return {
    schemaVersion: 'course-textpack.v1',
    manifest: {
      createdAt: new Date().toISOString(),
      sourceHash,
      lessonCount: 1,
      deckCount: 0,
      transcriptChars: transcript.length,
      pptChars: 0,
      totalChars: transcript.length,
      quotas: {
        maxLessons: 80,
        maxTranscriptCharsPerLesson: 220000,
        maxPptCharsPerDeck: 160000,
        maxCourseChars: 1800000,
        maxSegmentsPerLesson: 80
      }
    },
    course: {
      name: courseName,
      teacher: cleanText(input.teacher),
      lessonRange: lessonTitle
    },
    preferences: input.preferences && typeof input.preferences === 'object' ? input.preferences : {},
    lessons: [lesson],
    ppt_text: [],
    source_maps: {
      transcripts: [{ lessonKey, sourceFile, lines: lesson.sourceMap }],
      slides: []
    },
    checksums: {
      sourceHash,
      lessons: { [lessonKey]: checksum(transcript) },
      decks: {}
    },
    warnings: ['当前为 transcript-only TextPack；教师课件可在工作台后续补充并重新校准笔记。']
  }
}

export function writeTranscriptTextPack(input, outputPath) {
  const textPack = buildTranscriptTextPack(input)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const partPath = `${outputPath}.part`
  fs.writeFileSync(partPath, `${JSON.stringify(textPack, null, 2)}\n`)
  fs.renameSync(partPath, outputPath)
  return textPack
}
