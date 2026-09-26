/**
 * 极简 Markdown 渲染器：只覆盖课程笔记实际用到的语法，且默认转义一切。
 *
 * 为什么不引第三方渲染库：
 *   1. 笔记的语法面很窄（标题、段落、引用、列表、任务项、表格、代码块、分隔线）；
 *   2. 这一层的输入是**模型输出**，必须假设它可能包含恶意 HTML。自己渲染可以把
 *      "先转义、再只放行我们认识的语法"作为默认，而不是依赖库的配置开关；
 *   3. 服务器可用内存只有 1.2G，少一个依赖少一份风险。
 *
 * 明确不支持：原始 HTML 透传。笔记里的元数据 <details> 块由渲染器自己识别并重建，
 * 因此不存在"模型在正文里写一段 <script> 就被执行"的可能。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char])
}

/** 只允许安全协议，挡掉 javascript: / data: 这类链接。 */
function safeUrl(raw) {
  const url = String(raw || '').trim()
  if (/^(https?:|mailto:|\/|#)/i.test(url)) return url
  return ''
}

export function renderInline(text) {
  let html = escapeHtml(text)
  // 行内代码优先，避免其中的 * 被当成强调
  const codes = []
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000CODE${codes.length - 1}\u0000`
  })
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeUrl(url)
    return href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`
      : label
  })
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`)
  return html
}

const METADATA_OPEN = /^<details><summary>📑 笔记元数据/
const FENCE = /^```/
const HEADING = /^(#{1,6})\s+(.*)$/
const HR = /^(\*\s*){3,}$|^-{3,}$|^_{3,}$/
const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/
const UL = /^\s*[-*]\s+(.*)$/
const OL = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/

const tableCells = row => row.split('|').slice(1, -1).map(cell => cell.trim())
const tableAlign = row => tableCells(row).map(cell => {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  return right ? 'right' : left ? 'left' : ''
})

function renderTable(rows, aligns) {
  const [head, ...body] = rows
  const cell = (value, index, tag) => {
    const align = aligns[index] ? ` style="text-align:${aligns[index]}"` : ''
    return `<${tag}${align}>${renderInline(value)}</${tag}>`
  }
  const headHtml = `<thead><tr>${tableCells(head).map((value, index) => cell(value, index, 'th')).join('')}</tr></thead>`
  const bodyHtml = body.length
    ? `<tbody>${body.map(row => `<tr>${tableCells(row).map((value, index) => cell(value, index, 'td')).join('')}</tr>`).join('')}</tbody>`
    : ''
  return `<table>${headHtml}${bodyHtml}</table>`
}

function renderList(items) {
  const ordered = items[0].ordered
  const tag = ordered ? 'ol' : 'ul'
  const body = items.map(item => {
    if (item.task) {
      const checked = item.checked ? ' checked' : ''
      return `<li class="task"><input type="checkbox" disabled${checked}> ${renderInline(item.text)}</li>`
    }
    return `<li>${renderInline(item.text)}</li>`
  }).join('')
  return `<${tag}>${body}</${tag}>`
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) { index += 1; continue }

    // 元数据块：识别后自行重建，内容整体转义
    if (METADATA_OPEN.test(line.trim())) {
      const collected = []
      index += 1
      while (index < lines.length && !/^<\/details>\s*$/.test(lines[index].trim())) {
        collected.push(lines[index])
        index += 1
      }
      index += 1
      const text = collected
        .join('\n')
        .replace(/^<pre><code>\s*$/, '')
        .replace(/^<\/code><\/pre>\s*$/, '')
        .trim()
      blocks.push(`<details class="note-meta"><summary>📑 笔记元数据（用于跨课整合）</summary><pre><code>${escapeHtml(text)}</code></pre></details>`)
      continue
    }

    /**
     * 折叠块：<details><summary>标题</summary> … </details>。
     *
     * 之前只认「📑 笔记元数据」那一种，其余（知识地图、参考答案）会被**转义成字面量**
     * 显示在页面上——读者看到的就是「<details><summary>知识地图</summary>」这一行原文。
     * 现在按结构识别：summary 文字转义、内部按 Markdown 递归渲染，仍然不放行任意 HTML。
     */
    const fold = line.trim().match(/^<details>\s*<summary>([\s\S]*?)<\/summary>\s*$/)
    if (fold) {
      const inner = []
      index += 1
      while (index < lines.length && !/^<\/details>\s*$/.test(lines[index].trim())) {
        inner.push(lines[index])
        index += 1
      }
      index += 1
      const title = fold[1].replace(/<[^>]+>/g, '').trim()
      const body = renderMarkdown(inner.join('\n'))
      blocks.push(`<details class="note-fold"><summary>${escapeHtml(title)}</summary><div class="fold-body">${body}</div></details>`)
      continue
    }

    const fenceMatch = line.match(FENCE)
    if (fenceMatch) {
      const language = line.slice(fenceMatch[0].length).trim()
      const code = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1
      const cls = language ? ` class="language-${escapeHtml(language)}"` : ''
      blocks.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const level = heading[1].length
      // 标题要带 id：目录链接、滚动高亮、锚点跳转全靠它。
      // 此前只渲染 <h2>文本</h2>，目录里的 #锚点 实际是死链——点了不动，
      // 而且"当前小节高亮"无从实现。
      const text = heading[2].trim()
      const id = slugify(text)
      const idAttribute = id ? ` id="${escapeHtml(id)}"` : ''
      blocks.push(`<h${level}${idAttribute}>${renderInline(text)}</h${level}>`)
      index += 1
      continue
    }

    if (HR.test(line.trim())) {
      blocks.push('<hr>')
      index += 1
      continue
    }

    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SEP.test(lines[index + 1])) {
      const aligns = tableAlign(lines[index + 1])
      const rows = [line]
      index += 2
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(lines[index])
        index += 1
      }
      blocks.push(renderTable(rows, aligns))
      continue
    }

    if (QUOTE.test(line)) {
      const inner = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        inner.push(lines[index].match(QUOTE)[1])
        index += 1
      }
      blocks.push(`<blockquote>${renderMarkdown(inner.join('\n'))}</blockquote>`)
      continue
    }

    if (TASK.test(line) || UL.test(line) || OL.test(line)) {
      const items = []
      while (index < lines.length) {
        const current = lines[index]
        const task = current.match(TASK)
        const ul = current.match(UL)
        const ol = current.match(OL)
        if (task) items.push({ ordered: false, task: true, checked: task[1].toLowerCase() === 'x', text: task[2] })
        else if (ul) items.push({ ordered: false, task: false, text: ul[1] })
        else if (ol) items.push({ ordered: true, task: false, text: ol[1] })
        else break
        index += 1
      }
      blocks.push(renderList(items))
      continue
    }

    // 段落：连续非空行合并
    const paragraph = []
    while (index < lines.length && lines[index].trim() &&
      !HEADING.test(lines[index]) && !FENCE.test(lines[index]) && !HR.test(lines[index].trim()) &&
      !QUOTE.test(lines[index]) && !UL.test(lines[index]) && !OL.test(lines[index]) &&
      !TABLE_ROW.test(lines[index]) && !METADATA_OPEN.test(lines[index].trim())) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length) blocks.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
    else index += 1
  }

  return blocks.join('\n')
}

/** 从 Markdown 提取纯文本摘要，用于列表页与推送正文。 */
export function summarizeMarkdown(markdown, limit = 150) {
  const text = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<details>[\s\S]*?<\/details>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+\[?[ xX]?\]?\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[\s]+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 从 Markdown 抽标题，用于目录与页面标题。
 *
 * 收到 h4：模块分节是 h3，模块内部的小节是 h4——目录要显示到这一级才有"分级"，
 * 否则读者看到的是几十个平铺的标题。
 */
export function extractHeadings(markdown) {
  const headings = []
  for (const line of String(markdown ?? '').split('\n')) {
    const match = line.match(/^(#{2,4})\s+(.*)$/)
    if (match) headings.push({ level: match[1].length, text: match[2].trim(), id: slugify(match[2]) })
  }
  return headings
}

export function slugify(value, fallback = 'section') {
  const slug = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || fallback
}
