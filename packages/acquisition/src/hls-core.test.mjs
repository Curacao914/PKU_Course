import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertStateHasNoSecrets,
  buildSafeState,
  chooseAudioRendition,
  chooseVariant,
  extensionForUrl,
  fileComplete,
  parseAttributeList,
  parseMasterPlaylist,
  parseMediaPlaylist,
  redactText,
  renderLocalPlaylist,
  safeName,
  selectSampleResources,
  writeJsonAtomic
} from './hls-core.mjs'

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="中文",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="zh",URI="audio/main.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud1"',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1800000,RESOLUTION=1280x720',
  'high/index.m3u8'
].join('\n')

const MEDIA_BASE = 'https://media.pku.edu.cn/course/primary/index.m3u8'

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:9.009,',
  'seg-1.ts',
  '#EXTINF:9.009,',
  'seg-2.ts',
  '#EXT-X-ENDLIST'
].join('\n')

test('removes upstream byte range instructions from local playlists', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:200@100',
    'video.mp4',
    '#EXT-X-ENDLIST'
  ].join('\n')
  const track = parseMediaPlaylist(playlist, 'https://media.example/playlist.m3u8')
  const local = renderLocalPlaylist(track, path.join(os.tmpdir(), 'track'))
  assert.equal(local.includes('BYTERANGE'), false)
  assert.equal(local.includes('https://'), false)
})

test('parseMasterPlaylist resolves variants and audio renditions against the base url', () => {
  const master = parseMasterPlaylist(MASTER, 'https://media.pku.edu.cn/course/master.m3u8')
  assert.equal(master.isMaster, true)
  assert.equal(master.variants.length, 2)
  assert.equal(master.variants[0].url, 'https://media.pku.edu.cn/course/low/index.m3u8')
  assert.equal(master.variants[0].audioGroup, 'aud1')
  assert.equal(master.media.length, 1)
  assert.equal(master.media[0].type, 'AUDIO')
  assert.equal(master.media[0].default, true)
  assert.equal(master.media[0].url, 'https://media.pku.edu.cn/course/audio/main.m3u8')
})

test('chooseVariant prefers the highest average bandwidth and tolerates a media playlist', () => {
  const master = parseMasterPlaylist(MASTER, 'https://media.pku.edu.cn/course/master.m3u8')
  assert.equal(chooseVariant(master).resolution, '1280x720')
  assert.equal(chooseVariant({ variants: [{ bandwidth: 500 }, { bandwidth: 900 }] }).bandwidth, 900)
  assert.equal(chooseVariant({ variants: [] }), null)
  assert.equal(chooseVariant(parseMediaPlaylist(MEDIA, MEDIA_BASE)), null)
})

test('chooseAudioRendition matches the variant audio group and falls back sensibly', () => {
  const master = parseMasterPlaylist(MASTER, 'https://media.pku.edu.cn/course/master.m3u8')
  const low = master.variants.find(variant => variant.audioGroup === 'aud1')
  assert.equal(chooseAudioRendition(master, low).groupId, 'aud1')
  assert.equal(chooseAudioRendition(master, master.variants[1]), null)
  const noDefault = {
    media: [
      { type: 'AUDIO', groupId: 'g', default: false, autoselect: false, name: 'a' },
      { type: 'AUDIO', groupId: 'g', default: false, autoselect: true, name: 'b' }
    ]
  }
  assert.equal(chooseAudioRendition(noDefault, { audioGroup: 'g' }).name, 'b')
})

test('parseMediaPlaylist indexes segments, keys and init maps', () => {
  const track = parseMediaPlaylist(MEDIA, MEDIA_BASE)
  assert.equal(track.trackKey, 'primary')
  assert.equal(track.targetDuration, 10)
  assert.equal(track.segmentCount, 2)
  assert.ok(Math.abs(track.totalDuration - 18.018) < 1e-9)

  assert.deepEqual(track.resources.map(resource => resource.kind).sort(), ['key', 'map', 'segment', 'segment'])

  const key = track.resources.find(resource => resource.kind === 'key')
  assert.equal(key.fileName, 'key-001.bin')
  assert.match(key.urlHash, /^[0-9a-f]{64}$/)
  assert.match(key.id, /^primary-key-[0-9a-f]{16}$/)

  const map = track.resources.find(resource => resource.kind === 'map')
  assert.equal(map.fileName, 'init-001.mp4')

  const first = track.resources.find(resource => resource.kind === 'segment')
  assert.equal(first.fileName, 'segment-000001.ts')
  assert.equal(first.duration, 9.009)
  assert.equal(first.url, 'https://media.pku.edu.cn/course/primary/seg-1.ts')

  assert.equal(track.entries.filter(entry => entry.type === 'uri-attribute').length, 2)
  assert.equal(track.entries.filter(entry => entry.type === 'segment').length, 2)
})

test('parseMediaPlaylist handles implicit byte ranges for the same url', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:1000@0',
    'seg.ts',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:1000',
    'seg.ts'
  ].join('\n')
  const track = parseMediaPlaylist(playlist, 'https://media.pku.edu.cn/course/primary/index.m3u8')
  assert.equal(track.segmentCount, 2)
  assert.deepEqual(
    track.resources.filter(resource => resource.kind === 'segment').map(resource => resource.range),
    [
      { start: 0, end: 999, length: 1000 },
      { start: 1000, end: 1999, length: 1000 }
    ]
  )
  assert.deepEqual(
    track.resources.filter(resource => resource.kind === 'segment').map(resource => resource.fileName),
    ['segment-000001.ts', 'segment-000002.ts']
  )
})

test('renderLocalPlaylist rewrites every upstream reference to a local file', () => {
  const track = parseMediaPlaylist(MEDIA, MEDIA_BASE)
  const text = renderLocalPlaylist(track, '/tmp/fragments')
  assert.ok(!/https?:\/\//i.test(text), 'local playlist must not leak upstream urls')
  assert.match(text, /#EXT-X-KEY:METHOD=AES-128,URI="key-001\.bin"/)
  assert.match(text, /#EXT-X-MAP:URI="init-001\.mp4"/)
  assert.match(text, /^segment-000001\.ts$/m)
  assert.match(text, /^segment-000002\.ts$/m)
  assert.ok(!/BYTERANGE/i.test(text))
  assert.ok(text.endsWith('#EXT-X-ENDLIST\n'))
})

test('renderLocalPlaylist truncates at the selected sequence and refuses to emit urls', () => {
  const track = parseMediaPlaylist(MEDIA, MEDIA_BASE)
  const partial = renderLocalPlaylist(track, '/tmp/fragments', 1)
  assert.match(partial, /segment-000001\.ts/)
  assert.ok(!partial.includes('segment-000002.ts'))

  assert.throws(
    () => renderLocalPlaylist({ resources: [], entries: [{ type: 'raw', value: '#EXT-X-X:https://a/b' }] }, '/tmp'),
    /upstream URL/
  )
})

test('selectSampleResources walks until the requested duration', () => {
  const track = parseMediaPlaylist(
    ['#EXTM3U', '#EXTINF:100,', 'a.ts', '#EXTINF:100,', 'b.ts', '#EXTINF:100,', 'c.ts'].join('\n'),
    MEDIA_BASE
  )
  const sample = selectSampleResources(track, 180)
  assert.equal(sample.maxSequence, 2)
  assert.equal(sample.duration, 200)
  assert.equal(sample.selectedIds.size, 2)
})

test('buildSafeState strips urls so the on-disk state cannot leak a signed link', () => {
  const track = parseMediaPlaylist(MEDIA, MEDIA_BASE)
  const state = buildSafeState({ lessonName: '刑法分论', playlistFingerprint: 'abc', tracks: [track], concurrency: 6 })
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.tracks[0].resources.length, 4)
  assert.equal('url' in state.tracks[0].resources[0], false)
  assert.equal(assertStateHasNoSecrets(state), true)
  assert.throws(() => assertStateHasNoSecrets({ page: 'https://course.pku.edu.cn/x' }), /URL/)
  assert.throws(() => assertStateHasNoSecrets({ headers: { cookie: 'x' } }), /authentication/)
})

test('redactText removes credentials and urls from logs', () => {
  assert.equal(redactText('see https://media.pku.edu.cn/a/b.ts now'), 'see <REDACTED_URL> now')
  assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /Authorization: Bearer <REDACTED>/)
  assert.match(redactText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'), /<REDACTED>/)
})

test('safeName and extensionForUrl keep generated file names inside the whitelist', () => {
  assert.equal(safeName('刑法分论/2026-06-03: 第5-6节'), '刑法分论-2026-06-03-第5-6节')
  assert.equal(safeName('', 'fallback'), 'fallback')
  assert.equal(extensionForUrl('https://x/y/z.ts?a=1'), 'ts')
  assert.equal(extensionForUrl('https://x/y/z.exe'), 'ts')
  assert.equal(extensionForUrl('nonsense'), 'ts')
  assert.equal(extensionForUrl('https://x/y/init.mp4', 'bin'), 'mp4')
})

test('parseAttributeList handles quoted and bare values', () => {
  assert.deepEqual(parseAttributeList('METHOD=AES-128,URI="key.bin",IV=0x1'), {
    METHOD: 'AES-128',
    URI: 'key.bin',
    IV: '0x1'
  })
  assert.deepEqual(parseAttributeList('BANDWIDTH=800000,RESOLUTION=640x360'), {
    BANDWIDTH: '800000',
    RESOLUTION: '640x360'
  })
})

test('fileComplete and writeJsonAtomic report real on-disk state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-hls-'))
  const file = path.join(dir, 'nested', 'state.json')
  assert.equal(fileComplete(file), false)
  writeJsonAtomic(file, { ok: true })
  assert.equal(fileComplete(file), true)
  assert.equal(fs.existsSync(`${file}.part`), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true })

  const ranged = path.join(dir, 'chunk.bin')
  fs.writeFileSync(ranged, Buffer.alloc(10))
  assert.equal(fileComplete(ranged, { length: 10 }), true)
  assert.equal(fileComplete(ranged, { length: 11 }), false)
})
