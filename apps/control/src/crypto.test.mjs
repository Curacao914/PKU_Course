import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecret, decryptSecret, encryptFields, decryptFields } from './crypto.mjs'
const key = '01'.repeat(32)
test('AAD roundtrip, owner/provider substitution and ciphertext/tag tampering', () => {
  const aad = 'owner-a:provider:deepseek'
  const record = encryptSecret('member-secret', key, aad)
  assert.equal(decryptSecret(record, key, aad), 'member-secret')
  for (const other of ['owner-b:provider:deepseek', 'owner-a:provider:ocr']) {
    assert.throws(() => decryptSecret(record, key, other))
  }
  for (const field of ['ciphertext', 'authTag']) {
    const bytes = Buffer.from(record[field], 'base64'); bytes[0] ^= 1
    assert.throws(() => decryptSecret({ ...record, [field]: bytes.toString('base64') }, key, aad))
  }
  assert.throws(() => encryptSecret('secret', key), /AAD/)
})
test('PKU fields and session bind owner and field', () => {
  const row = encryptFields('password', 'secret', key, 'a')
  assert.equal(decryptFields('password', row, key, 'a'), 'secret')
  assert.throws(() => decryptFields('password', row, key, 'b'))
  const swapped = Object.fromEntries(Object.entries(row).map(([k,v]) => [k.replace('password', 'session'),v]))
  assert.throws(() => decryptFields('session', swapped, key, 'a'))
})
