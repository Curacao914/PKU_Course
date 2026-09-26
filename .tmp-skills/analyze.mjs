import fs from 'node:fs'
const f = '/Users/curacao/Desktop/研一/研一下/国际法学/haoke_国际法学/output/notes/第1课.md'
const text = fs.readFileSync(f, 'utf8')
const chars = text.replace(/\s/g, '').length
console.log('总字符（去空白）:', chars, '| 行数:', text.split('\n').length)
const heads = {}
for (const m of text.matchAll(/^(#{1,6}) (.+)$/gm)) { const lvl = m[1].length; heads[lvl] = (heads[lvl] || 0) + 1 }
console.log('标题层级:', JSON.stringify(heads))
const paras = text.split(/\n\s*\n/).filter(p => p.trim() && !/^[#|>\-*0-9]/.test(p.trim().slice(0, 2)))
const lens = paras.map(p => p.replace(/\s/g, '').length).sort((a, b) => b - a)
console.log('段落数:', paras.length, '| 最长:', lens[0], '| 中位:', lens[Math.floor(lens.length/2)], '| 前五:', lens.slice(0, 5).join(','))
console.log('表格行:', (text.match(/^\s*\|/gm) || []).length, '| 列表项:', (text.match(/^\s*[-*] /gm) || []).length, '| 引用块行:', (text.match(/^\s*>/gm) || []).length)
console.log('加粗次数:', (text.match(/\*\*/g) || []).length, '| 星级:', (text.match(/★/g) || []).length, '| Mermaid:', (text.match(/```mermaid/g) || []).length)
console.log()
console.log('===== 结构骨架（所有标题）=====')
for (const m of text.matchAll(/^(#{1,4}) (.+)$/gm)) console.log('  '.repeat(m[1].length - 1) + m[2].slice(0, 60))