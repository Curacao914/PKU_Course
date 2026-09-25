import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  addMaterial,
  extractSlides,
  listMaterials,
  materialDir,
  normalizeDeck,
  parseInboxName,
  readDecks,
  safeSegment
} from './store.mjs'

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

function pythonAvailable() {
  return spawnSync('python3', ['-c', 'import sys;print(sys.version)'], { encoding: 'utf8' }).status === 0
}

/** 造一个最小但结构合法的 pptx（zip + DrawingML），用来验证解析器真的能读 pptx。 */
function writeMinimalPptx(target, slides) {
  const script = `
import sys, zipfile
target = sys.argv[1]
slides = sys.argv[2:]
ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
with zipfile.ZipFile(target, 'w') as zf:
    for index, text in enumerate(slides, start=1):
        xml = f'<?xml version="1.0" encoding="UTF-8"?><p:sld {ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
        zf.writestr(f'ppt/slides/slide{index}.xml', xml)
    zf.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
`
  execFileSync('python3', ['-c', script, target, ...slides], { stdio: 'pipe' })
}

test('safeSegment keeps CJK and strips path-hostile characters', () => {
  assert.equal(safeSegment('法律实证分析'), '法律实证分析')
  assert.equal(safeSegment('2026-09-23第1-2节'), '2026-09-23第1-2节')
  assert.equal(safeSegment('a/b:c*d'), 'a b c d')
  assert.equal(safeSegment('   '), 'unnamed')
})

test('parseInboxName reads the course__lesson convention', () => {
  assert.deepEqual(
    parseInboxName('法律实证分析__2026-09-23第1-2节.pptx'),
    { course: '法律实证分析', lesson: '2026-09-23第1-2节', scope: 'lesson', extension: '.pptx' }
  )
  assert.deepEqual(
    parseInboxName('法律实证分析__ALL.pptx'),
    { course: '法律实证分析', lesson: '', scope: 'course', extension: '.pptx' },
    '课程__ALL 表示全课程通用（例如术语表、课程大纲）'
  )
  assert.equal(parseInboxName('随便一个名字.pptx'), null, '命名不合约定就不猜归属')
})

test('a lesson loads course-wide decks plus its own, and only the shared ones it declares', async () => {
  const root = tmp('course-materials-scope-')
  const make = async (payload, name) => {
    const file = path.join(root, `${name}.json`)
    fs.writeFileSync(file, JSON.stringify({ slides: [{ slideNumber: 1, text: name }] }))
    return file
  }

  await addMaterial({ root: path.join(root, 'archive'), course: '刑法分论', lesson: '第10-12节', filePath: await make({}, '本讲'), name: '本讲.json' })
  await addMaterial({ root: path.join(root, 'archive'), course: '刑法分论', lesson: '', scope: 'course', filePath: await make({}, '术语表'), name: '术语表.json' })
  await addMaterial({
    root: path.join(root, 'archive'), course: '刑法分论', lesson: '第7-9节',
    appliesTo: ['第7-9节', '第10-12节'], filePath: await make({}, '上一讲'), name: '上一讲.json'
  })
  await addMaterial({ root: path.join(root, 'archive'), course: '刑法分论', lesson: '第13-15节', filePath: await make({}, '下一讲'), name: '下一讲.json' })

  const names = listMaterials({ root: path.join(root, 'archive'), course: '刑法分论', lesson: '第10-12节' }).map(item => item.name).sort()
  // 排序按码点：上(U+4E0A) < 本(U+672C) < 术(U+672F)
  assert.deepEqual(names, ['上一讲.json', '本讲.json', '术语表.json'], '全课程通用 + 本课次 + 声明适用本课次的跨课次课件')

  const decks = readDecks({ root: path.join(root, 'archive'), course: '刑法分论', lesson: '第10-12节' })
  assert.equal(decks.length, 3)
  assert.ok(decks.some(deck => deck.scope === 'course'), '全课程通用的课件要标明作用域')
})

test('normalizeDeck drops empty slides and sorts by slide number', () => {
  const deck = normalizeDeck({
    slides: [
      { slideNumber: 3, text: '  ' },
      { slideNumber: 2, text: ' 第二页 ' },
      { slideNumber: 1, text: '第一页' }
    ]
  })
  assert.deepEqual(deck.slides.map(slide => slide.slideNumber), [1, 2])
  assert.equal(deck.slides[1].text, '第二页')
  assert.equal(deck.slideCount, 2)
})

test('a deck can be archived and read back as model material', async () => {
  const root = tmp('course-materials-')
  const archive = path.join(root, 'archive')
  const deckPath = path.join(root, 'deck.json')
  fs.writeFileSync(deckPath, JSON.stringify({
    slides: [{ slideNumber: 2, text: '第二页' }, { slideNumber: 1, text: '第一页' }, { slideNumber: 3, text: ' ' }]
  }))

  const { entry, deck } = await addMaterial({
    root: archive, course: '法律实证分析', lesson: '2026-09-23第1-2节', filePath: deckPath, name: '第3讲.json'
  })
  assert.equal(deck.slideCount, 2)
  assert.equal(entry.slideCount, 2)
  assert.match(entry.checksum, /^[0-9a-f]{64}$/)

  const listed = listMaterials({ root: archive, course: '法律实证分析', lesson: '2026-09-23第1-2节' })
  assert.equal(listed.length, 1)

  const decks = readDecks({ root: archive, course: '法律实证分析', lesson: '2026-09-23第1-2节' })
  assert.equal(decks.length, 1)
  assert.equal(decks[0].slides[1].text, '第二页')
  assert.ok(materialDir({ root: archive, course: '法律实证分析', lesson: '2026-09-23第1-2节' }).endsWith(path.join('法律实证分析', '2026-09-23第1-2节')))
})

test('re-uploading the same deck replaces it instead of piling up', async () => {
  const root = tmp('course-materials-')
  const archive = path.join(root, 'archive')
  const deckPath = path.join(root, 'deck.json')
  fs.writeFileSync(deckPath, JSON.stringify({ slides: [{ slideNumber: 1, text: '旧版' }] }))
  await addMaterial({ root: archive, course: 'c', lesson: 'l', filePath: deckPath, name: 'slides.json' })
  fs.writeFileSync(deckPath, JSON.stringify({ slides: [{ slideNumber: 1, text: '新版' }] }))
  await addMaterial({ root: archive, course: 'c', lesson: 'l', filePath: deckPath, name: 'slides.json' })

  const listed = listMaterials({ root: archive, course: 'c', lesson: 'l' })
  assert.equal(listed.length, 1, '同名课件只保留一条')
  assert.equal(readDecks({ root: archive, course: 'c', lesson: 'l' })[0].slides[0].text, '新版')
})

test('a real pptx is parsed into per-slide text', { skip: pythonAvailable() ? false : '未安装 python3' }, async () => {
  const root = tmp('course-pptx-')
  const pptx = path.join(root, '第3讲.pptx')
  writeMinimalPptx(pptx, ['数据评价的四个方面', '抽样方法与时间维度'])

  const deck = await extractSlides({ filePath: pptx })
  assert.equal(deck.slideCount, 2)
  assert.equal(deck.slides[0].text, '数据评价的四个方面')
  assert.equal(deck.slides[1].slideNumber, 2)

  const { entry } = await addMaterial({ root: path.join(root, 'archive'), course: '法律实证分析', lesson: '第1-2节', filePath: pptx })
  assert.equal(entry.slideCount, 2)
  assert.equal(entry.name, '第3讲.pptx')
})

test('a broken pptx fails loudly instead of yielding an empty deck', { skip: pythonAvailable() ? false : '未安装 python3' }, async () => {
  const root = tmp('course-pptx-bad-')
  const broken = path.join(root, 'broken.pptx')
  fs.writeFileSync(broken, '这不是一个 pptx')
  await assert.rejects(() => extractSlides({ filePath: broken }), /课件解析失败/)
})

test('extraction refuses a missing file', async () => {
  await assert.rejects(() => extractSlides({ filePath: '/nonexistent/slides.pptx' }), /找不到课件文件/)
})
