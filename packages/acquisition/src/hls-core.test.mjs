import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseMediaPlaylist, renderLocalPlaylist } from './hls-core.mjs'

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
