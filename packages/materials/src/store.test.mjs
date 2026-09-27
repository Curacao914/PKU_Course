import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  addMaterial,
  extractSlides,
  guessMaterialIdentity,
  listMaterials,
  materialDir,
  normalizeDeck,
  ocrMaterial,
  parseInboxName,
  pendingOcrMaterials,
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

test('file names are matched against the known courses and lessons', () => {
  const known = {
    courses: ['法律实证分析', '刑事执行法'],
    lessons: [
      { course: '法律实证分析', lesson: '2026-09-23第1-2节', replayKey: 'r1' },
      { course: '法律实证分析', lesson: '2026-09-30第3-4节', replayKey: 'r2' }
    ]
  }
  // 从微信/邮箱下载下来的那种文件名：只有日期与节次
  const byDate = guessMaterialIdentity('法律实证分析 2026-09-30 第3-4节.pptx', known)
  assert.equal(byDate.canAutoAssign, true)
  assert.equal(byDate.replayKey, 'r2')

  const loose = guessMaterialIdentity('实证分析_09-30_课件.pptx', known)
  assert.equal(loose.canAutoAssign, true, '只写月-日也能认出来')

  const courseOnly = guessMaterialIdentity('法律实证分析 课件打包.zip', known)
  assert.equal(courseOnly.canAutoAssign, false, '认得出课程但认不出课次时不自动归档')
  assert.match(courseOnly.reason, /认不出是哪个课次/)

  const nothing = guessMaterialIdentity('课件.pptx', known)
  assert.equal(nothing.canAutoAssign, false)
  assert.match(nothing.reason, /认不出课程/)
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

/** 假的 python 调用：记下参数，按脚本返回一份"带图片与 OCR 状态"的解析结果。 */
function fakePython(deck) {
  const calls = []
  const runPython = async ({ args }) => {
    calls.push(args)
    const ocr = args.includes('--ocr')
    return {
      code: 0,
      stdout: JSON.stringify(ocr
        ? { ...deck, slides: deck.slides.map(slide => ({ ...slide, text: slide.text + '\n【图片文字】\n公司人格否认' })), ocr: { pending: 0, attempted: 2, engine: 'PaddleOCR-VL-1.6', errors: [] } }
        : deck),
      stderr: ''
    }
  }
  return { runPython, calls }
}

const DECK_WITH_IMAGES = {
  slideCount: 2,
  slides: [
    { slideNumber: 1, text: '第一页：正文' },
    { slideNumber: 2, text: '第二页：整页是图' }
  ],
  images: [
    { path: 'ppt/media/image1.png', bytes: 194436, width: 2360, height: 1800, slides: [2], needsOcr: true },
    { path: 'ppt/media/image2.png', bytes: 126, width: 48, height: 48, slides: [1], needsOcr: false }
  ],
  ocr: { pending: 1, attempted: 0, engine: '', errors: [] }
}

test('parsing counts the images that need OCR without calling the API', async () => {
  const root = tmp('course-ocr-')
  const { runPython, calls } = fakePython(DECK_WITH_IMAGES)
  fs.writeFileSync(path.join(root, 'deck.pptx'), 'x')
  const deck = await extractSlides({ filePath: path.join(root, 'deck.pptx'), runPython })
  assert.ok(!calls[0].includes('--ocr'), '默认不识别：上传要秒回')
  assert.equal(deck.ocrPending, 1)
  assert.equal(deck.images.length, 2)
  assert.equal(deck.textLength > 0, true)

  // --ocr 时把开关与上限透传给 python
  await extractSlides({ filePath: path.join(root, 'deck.pptx'), runPython, ocr: true, ocrMaxPages: 12, ocrConcurrency: 5 })
  assert.ok(calls[1].includes('--ocr'))
  assert.ok(calls[1].includes('--ocr-max-pages'))
  assert.equal(calls[1][calls[1].indexOf('--ocr-max-pages') + 1], '12')
  assert.equal(calls[1][calls[1].indexOf('--ocr-concurrency') + 1], '5')
})

test('image text is written back into the archived deck and its metadata', async () => {
  const root = tmp('course-ocr-')
  const archive = path.join(root, 'archive')
  const { runPython } = fakePython(DECK_WITH_IMAGES)
  const file = path.join(root, '第5讲.pptx')
  fs.writeFileSync(file, 'pptx-bytes')

  await addMaterial({ root: archive, course: '商法概论', lesson: '第1-2节', filePath: file, name: '第5讲.pptx', runPython })
  const before = listMaterials({ root: archive, course: '商法概论', lesson: '第1-2节' })[0]
  assert.equal(before.ocrPending, 1, '入库时不识别，只记下"有 1 张待识别"')
  assert.equal(pendingOcrMaterials({ root: archive, course: '商法概论', lesson: '第1-2节' }).length, 1)

  const outcome = await ocrMaterial({ root: archive, course: '商法概论', lesson: '第1-2节', name: '第5讲.pptx', runPython })
  assert.equal(outcome.skipped, false)
  assert.equal(outcome.entry.ocrPending, 0)
  assert.equal(outcome.entry.ocr.engine, 'PaddleOCR-VL-1.6')

  // 归档的 json 里要有识别出来的文字：笔记阶段读的就是它
  const parsed = JSON.parse(fs.readFileSync(outcome.entry.parsedPath, 'utf8'))
  assert.match(parsed.slides[1].text, /【图片文字】/)
  assert.equal(readDecks({ root: archive, course: '商法概论', lesson: '第1-2节' })[0].ocrPending, 0)
  assert.equal(pendingOcrMaterials({ root: archive, course: '商法概论', lesson: '第1-2节' }).length, 0)
})

test('a deck whose original file is gone says so instead of pretending it worked', async () => {
  const root = tmp('course-ocr-')
  const archive = path.join(root, 'archive')
  const { runPython } = fakePython(DECK_WITH_IMAGES)
  const file = path.join(root, '第6讲.pptx')
  fs.writeFileSync(file, 'pptx-bytes')
  await addMaterial({ root: archive, course: '商法概论', lesson: '第1-2节', filePath: file, name: '第6讲.pptx', runPython })
  fs.rmSync(path.join(materialDir({ root: archive, course: '商法概论', lesson: '第1-2节' }), '第6讲.pptx'))

  const outcome = await ocrMaterial({ root: archive, course: '商法概论', lesson: '第1-2节', name: '第6讲.pptx', runPython })
  assert.equal(outcome.skipped, true)
  assert.match(outcome.reason, /原件已删除/)
  assert.match(outcome.entry.ocr.skipped, /原件已删除/)
})
