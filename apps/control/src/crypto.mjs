import crypto from 'node:crypto'

function resolveKey(raw = process.env.COURSE_ACCOUNT_ENCRYPTION_KEY || '') {
  const value = String(raw).trim()
  let key
  if (/^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, 'hex')
  else {
    try { key = Buffer.from(value, 'base64') } catch {}
  }
  if (!key || key.length !== 32) {
    throw new Error('COURSE_ACCOUNT_ENCRYPTION_KEY 必须是 32 字节（64 位 hex 或 base64）')
  }
  return key
}

export function encryptSecret(value, rawKey, aad) {
  if (typeof aad !== 'string' || !aad) throw new Error('AAD is required')
  const key = resolveKey(rawKey)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64')
  }
}

export function decryptSecret(record, rawKey, aad) {
  if (!record?.ciphertext) return ''
  if (typeof aad !== 'string' || !aad) throw new Error('AAD is required')
  const key = resolveKey(rawKey)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(record.authTag || record.auth_tag, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final()
  ])
  return plain.toString('utf8')
}

export function encryptFields(prefix, value, rawKey, ownerId) {
  if (!ownerId) throw new Error('AAD owner is required')
  const encrypted = encryptSecret(value, rawKey, `${ownerId}:pku:${prefix}`)
  return {
    [prefix + '_ciphertext']: encrypted.ciphertext,
    [prefix + '_iv']: encrypted.iv,
    [prefix + '_tag']: encrypted.authTag
  }
}

export function decryptFields(prefix, row, rawKey, ownerId) {
  if (!row?.[prefix + '_ciphertext']) return ''
  if (!ownerId) throw new Error('AAD owner is required')
  return decryptSecret({
    ciphertext: row[prefix + '_ciphertext'],
    iv: row[prefix + '_iv'],
    authTag: row[prefix + '_tag']
  }, rawKey, `${ownerId}:pku:${prefix}`)
}
