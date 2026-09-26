import fs from 'node:fs'
const f = '/Users/curacao/Desktop/研一/研一下/国际法学/haoke_国际法学/output/notes/第2课.md'
const text = fs.readFileSync(f, 'utf8')
const lines = text.split('\n')
console.log('===== 第2课 前 150 行 =====')
console.log(lines.slice(0, 150).join('\n'))