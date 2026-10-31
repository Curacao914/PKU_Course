#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { createEnrollmentCode } from '../src/passkey-auth.mjs'

const root = process.env.COURSE_WORKER_SCRATCH_DIR || path.join(os.homedir(), '.course-worker')
const { code, expiresAt } = createEnrollmentCode({ root })

// This output is a one-time owner-only credential; do not log it in CI or MCP.
process.stdout.write('课程站通行密钥一次性登记码（请仅在本人终端查看，不要截图或转发）：\n')
process.stdout.write(code + '\n')
process.stdout.write('过期时间（UTC）：' + expiresAt + '\n')
process.stdout.write('打开 https://course.law-tech.dev/login，在“首次设置”输入登记码。\n')
