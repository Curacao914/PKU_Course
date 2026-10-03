#!/usr/bin/env node
import { createControlServer } from '../src/server.mjs'

const port = Number(process.env.COURSE_CONTROL_PORT || 3102)
const host = process.env.COURSE_CONTROL_HOST || '127.0.0.1'
const server = createControlServer({ env: process.env })
server.listen(port, host, () => {
  process.stderr.write('course-control listening on http://' + host + ':' + port + '\n')
})
