#!/usr/bin/env node
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3'

const endpoint = process.env.R2_ENDPOINT
const bucket = process.env.R2_BUCKET
const accessKeyId = process.env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 必须先配置')
  process.exit(2)
}

const origins = String(process.env.COURSE_UPLOAD_ORIGINS || 'https://law-tech.dev')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey }
})

await client.send(new PutBucketCorsCommand({
  Bucket: bucket,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: origins,
      AllowedMethods: ['PUT', 'HEAD'],
      AllowedHeaders: ['content-type', 'x-amz-*'],
      ExposeHeaders: ['etag'],
      MaxAgeSeconds: 3600
    }]
  }
}))

console.log('R2 CORS 已更新：' + origins.join(', '))
