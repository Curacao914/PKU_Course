import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAcquisitionProxy, acquisitionDispatcher } from './proxy.mjs'

test('acquisition proxy must be explicit, loopback-only and credential-free', () => {
  assert.equal(resolveAcquisitionProxy({}), '')
  assert.equal(resolveAcquisitionProxy({COURSE_ACQUISITION_HTTP_PROXY:'http://127.0.0.1:19091'}), 'http://127.0.0.1:19091')
  assert.equal(resolveAcquisitionProxy({COURSE_ACQUISITION_HTTP_PROXY:'http://localhost:19091'}), 'http://localhost:19091')
  for (const url of [
    'socks5://127.0.0.1:19089', 'https://127.0.0.1:19091',
    'http://example.com:19091', 'http://192.168.1.1:19091',
    'http://user:pass@127.0.0.1:19091','http://127.0.0.1',
    'http://127.0.0.1:19091?a=1','bad-url'
  ]) assert.throws(()=>resolveAcquisitionProxy({COURSE_ACQUISITION_HTTP_PROXY:url}))
})

test('acquisition dispatcher is optional and cached only for selected proxy', () => {
  assert.equal(acquisitionDispatcher({}), undefined)
  const env={COURSE_ACQUISITION_HTTP_PROXY:'http://127.0.0.1:19091'}
  const first=acquisitionDispatcher(env)
  assert.ok(first)
  assert.equal(acquisitionDispatcher(env),first)
  assert.equal(acquisitionDispatcher({}),undefined)
})
