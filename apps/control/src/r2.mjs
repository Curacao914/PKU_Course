import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

function safeName(value) {
  return String(value || 'material.bin').normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'material.bin'
}

export function createR2(env = process.env, { client: injectedClient, sign = getSignedUrl } = {}) {
  const endpoint = env.COURSE_MEMBER_R2_ENDPOINT
  const bucket = env.COURSE_MEMBER_R2_BUCKET
  const accessKeyId = env.COURSE_MEMBER_R2_ACCESS_KEY_ID
  const secretAccessKey = env.COURSE_MEMBER_R2_SECRET_ACCESS_KEY
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('R2 未配置')

  const client = injectedClient || new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey }
  })

  async function usage(ownerId) {
    let token
    let bytes = 0
    let objects = 0
    assertOwner(ownerId)
    const prefix = 'users/' + ownerId + '/'
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token
      }))
      for (const item of page.Contents || []) {
        bytes += Number(item.Size || 0)
        objects += 1
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return { bytes, objects }
  }

  async function presignUpload(ownerId, fileName, mimeType, fileSize, maxBytes, quotaBytes) {
    const bytes = Number(fileSize || 0)
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('文件大小无效')
    if (!Number.isSafeInteger(Number(maxBytes)) || Number(maxBytes) <= 0 || !Number.isSafeInteger(Number(quotaBytes)) || Number(quotaBytes) <= 0) throw new Error('配额无效')
    if (bytes > Number(maxBytes)) throw new Error('文件超过单文件上限')

    const current = await usage(ownerId)
    if (current.bytes + bytes > Number(quotaBytes)) throw new Error('存储空间不足')

    const key =
      'users/' + ownerId + '/materials/' + crypto.randomUUID() + '/' + safeName(fileName)
    const contentType = String(mimeType || 'application/octet-stream')
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes,
      Metadata: { owner: ownerId }
    })
    const url = await sign(client, command, { expiresIn: 15 * 60, signableHeaders: new Set(['content-length', 'content-type']) })
    return {
      key,
      url,
      expiresIn: 900,
      contentType,
      expectedBytes: bytes,
      maxBytes: Number(maxBytes),
      usedBytes: current.bytes,
      quotaBytes: Number(quotaBytes)
    }
  }

  async function head(ownerId, key) {
    assertMaterialKey(ownerId, key)
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { bytes: Number(result.ContentLength || 0), contentType: result.ContentType || '' }
  }

  async function remove(ownerId, key) {
    assertMaterialKey(ownerId, key)
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  }

  async function download(ownerId, key, destination) {
    assertMaterialKey(ownerId, key)
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    await pipeline(result.Body, fs.createWriteStream(destination, { mode: 0o600 }))
    return destination
  }

  return { usage, presignUpload, head, remove, download }
}

function assertOwner(ownerId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) throw new Error('INVALID_OWNER')
}
export function assertMaterialKey(ownerId, key) {
  assertOwner(ownerId)
  if (typeof key !== 'string' || !key.startsWith('users/' + ownerId + '/materials/') ||
    key.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(key)) throw new Error('INVALID_STORAGE_KEY')
}
