#!/usr/bin/env node
/**
 * 用已有状态重新拼装成品笔记（不调用任何模型）。
 *
 *   node tools/reassemble-note.mjs <lesson-state.json> [...] [--write]
 *
 * 为什么需要它：成品的**结构**（顶部是课程概览还是五个并列装置、小节是标题还是加粗行、
 * 复习层要不要、索引表放哪）由拼装代码决定，跟正文内容无关。改了排版之后，
 * 为了让它生效而把整节课重跑一遍模型，既贵又慢，而且新一版正文未必更好。
 *
 * 节点的草稿、审查记录与接缝段数据都躺在 lesson-state.json 里
 * （lesson.nodes[].draft 与 lesson.finalNote.assembly.spliceData），
 * 所以可以直接重拼。默认只报告差异，加 --write 才落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { buildFinalNoteMarkdown, normalizedSpliceData } from '@course/notes'

function parseArgs(argv) {
  const files = []
  let write = false
  let course = ''
  let teacher = ''
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--write') write = true
    else if (token === '--course') course = argv[++index] || ''
    else if (token === '--teacher') teacher = argv[++index] || ''
    else files.push(token)
  }
  return { files, write, course, teacher }
}

/** 统计成品的结构指纹：改排版前后一眼能看出差别。 */
export function structureOf(markdown = '') {
  const count = pattern => (markdown.match(pattern) || []).length
  return {
    chars: markdown.replace(/\s/g, '').length,
    h2: count(/^##\s/gm),
    h3: count(/^###\s/gm),
    h4: count(/^####\s/gm),
    boldSections: count(/^\*\*[（(]/gm),
    teacherCues: count(/^>\s*老师强调/gm),
    pitfallCues: count(/易混提醒/g),
    difficultyCues: count(/理解难点/g),
    sections: (markdown.match(/^##\s+(.+)$/gm) || []).map(line => line.replace(/^##\s+/, ''))
  }
}

function reassembleOne(file, options) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const lesson = state.lesson || {}
  if (!lesson.nodes?.length) throw new Error(`${file} 里没有节点：这份状态不是笔记阶段产出的`)
  const spliceData = lesson.finalNote?.assembly?.spliceData
  if (!spliceData) throw new Error(`${file} 里没有接缝段数据（finalNote.assembly.spliceData），无法离线重拼`)

  const before = lesson.finalNote?.markdown || ''
  const after = buildFinalNoteMarkdown({
    courseSpec: { courseName: options.course || lesson.courseName || '', teacher: options.teacher || '' },
    lesson,
    spliceData: normalizedSpliceData(lesson, spliceData)
  })
  const notePath = path.join(path.dirname(file), `${lesson.title}.md`)
  return { notePath, before, after }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.files.length) {
    console.error('用法：node tools/reassemble-note.mjs <lesson-state.json> [...] [--course 名称] [--teacher 姓名] [--write]')
    process.exit(2)
  }
  let changed = 0
  for (const file of options.files) {
    try {
      const { notePath, before, after } = reassembleOne(file, options)
      const from = structureOf(before)
      const to = structureOf(after)
      console.log(`\n=== ${notePath}`)
      console.log(`  结构：h2 ${from.h2}→${to.h2} · h3 ${from.h3}→${to.h3} · h4 ${from.h4}→${to.h4} · 加粗小节 ${from.boldSections}→${to.boldSections}`)
      console.log(`  字数：${from.chars} → ${to.chars}`)
      console.log(`  ## 小节：${to.sections.join(' / ')}`)
      if (options.write) {
        fs.writeFileSync(notePath, after.endsWith('\n') ? after : `${after}\n`)
        console.log('  已写入')
        changed += 1
      } else if (after !== before) {
        console.log('  （未写入，加 --write 落盘）')
      }
    } catch (error) {
      console.error(`\n✖ ${file}：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
  if (options.write) console.log(`\n共写入 ${changed} 篇`)
}

main()
