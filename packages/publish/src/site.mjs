import fs from 'node:fs'
import path from 'node:path'

import { escapeHtml, extractHeadings, renderMarkdown, slugify, summarizeMarkdown } from './markdown.mjs'

/**
 * 站点生成：把已完成的笔记变成可以对外阅读的页面。
 *
 * 与旧系统的差别：旧实现把笔记写进 Supabase 的 content 四张表，再靠 Next.js 的
 * ISR 按需重建。新系统不需要那套机制——笔记本身就是文件，站点是静态页面加一个
 * 极小的服务器，读完即走，没有数据库、没有缓存失效问题。
 *
 * 站点视觉沿用旧仓库的取向：暖白底、淡青绿、深墨绿、衬线排版、大圆角、柔和阴影。
 */

export const SITE_NAME = '课程笔记'

export const SITE_CSS = `
:root {
  --paper: #fbfaf7;
  --paper-soft: #f3f6f4;
  --ink: #16302b;
  --ink-soft: #3d5b54;
  --muted: #6b827c;
  --line: #dde5e1;
  --accent: #2f6f61;
  --radius: 18px;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif;
  line-height: 1.85; -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(47,111,97,.28); }
a:hover { border-bottom-color: var(--accent); }
.wrap { max-width: 760px; margin: 0 auto; padding: 48px 22px 96px; }
header.site { border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 34px; }
header.site .brand { font-size: 15px; letter-spacing: .18em; color: var(--muted); }
header.site h1 { margin: 10px 0 0; font-size: 26px; font-weight: 600; }
.meta { color: var(--muted); font-size: 14px; margin-top: 8px; }
article h1 { font-size: 28px; margin: 0 0 6px; }
article h2 { font-size: 21px; margin: 40px 0 12px; padding-top: 12px; border-top: 1px solid var(--line); }
article h3 { font-size: 17px; margin: 28px 0 10px; color: var(--ink-soft); }
article p { margin: 12px 0; }
article blockquote {
  margin: 18px 0; padding: 12px 18px; background: var(--paper-soft);
  border-left: 3px solid var(--accent); border-radius: 0 var(--radius) var(--radius) 0; color: var(--ink-soft);
}
article blockquote p { margin: 4px 0; }
article hr { border: 0; border-top: 1px solid var(--line); margin: 34px 0; }
article code { background: var(--paper-soft); padding: 1px 6px; border-radius: 6px; font-size: .9em; }
article pre { background: var(--paper-soft); padding: 14px 16px; border-radius: var(--radius); overflow-x: auto; }
article pre code { background: none; padding: 0; }
/* 本课简报：笔记页顶部先给"基本印象"，再进正文细节 */
article .brief { background: var(--paper-soft); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 22px; margin: 0 0 28px; }
article .brief h2 { margin: 0 0 10px; font-size: 17px; border: 0; padding: 0; color: var(--accent); letter-spacing: .04em; }
article .brief p { margin: 0 0 10px; }
article .brief ul { margin: 0; padding-left: 20px; }
article .brief li { margin: 4px 0; }
/* Mermaid 图：图宽时横向滚动而不是撑破版面 */
.diagram { margin: 20px 0; padding: 8px 4px; overflow-x: auto; background: var(--paper-soft); border-radius: var(--radius); }
.diagram svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
article table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 15px; }
article th, article td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; }
article th { background: var(--paper-soft); font-weight: 600; }
article ul, article ol { padding-left: 22px; }
article li { margin: 6px 0; }
article li.task { list-style: none; margin-left: -20px; }
details.note-meta { margin-top: 46px; color: var(--muted); font-size: 14px; }
details.note-meta summary { cursor: pointer; }
details.note-meta pre { background: var(--paper-soft); border-radius: var(--radius); padding: 12px 14px; overflow-x: auto; }
.toc { background: var(--paper-soft); border-radius: var(--radius); padding: 16px 20px; margin: 26px 0; }
.toc h2 { border: 0; margin: 0 0 8px; padding: 0; font-size: 15px; letter-spacing: .08em; color: var(--muted); }
.toc ol { margin: 0; padding-left: 20px; font-size: 15px; }
.toc li { margin: 4px 0; }
.card {
  display: block; padding: 18px 20px; margin: 14px 0; background: #fff;
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: 0 1px 2px rgba(22,48,43,.04), 0 8px 24px -18px rgba(22,48,43,.35);
}
.card:hover { border-color: var(--accent); }
.card h3 { margin: 0 0 6px; font-size: 17px; color: var(--ink); }
.card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.7; }
.course-group { margin-top: 34px; }
.course-group > h2 { font-size: 17px; color: var(--ink-soft); border-bottom: 1px solid var(--line); padding-bottom: 8px; }
footer.site { margin-top: 60px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
.empty { color: var(--muted); background: var(--paper-soft); border-radius: var(--radius); padding: 22px; }
`

export function noteSlug({ courseName, lessonTitle }) {
  return `notes/${slugify(courseName, 'course')}/${slugify(lessonTitle, 'lesson')}`
}

/** 从笔记目录读取记录（course notes 命令的产物）。 */
export function buildNoteRecord({
  courseName, teacher = '', lessonTitle, markdown, replayKey = '', publishedAt = new Date().toISOString(), source = 'course-worker',
  brief = null
}) {
  const body = String(markdown ?? '')
  if (!body.trim()) throw new Error('笔记正文为空，不能发布')
  const slug = noteSlug({ courseName, lessonTitle })
  const briefing = String(brief?.briefing || '').trim()
  return {
    slug,
    courseName: String(courseName || '').trim(),
    teacher: String(teacher || '').trim(),
    lessonTitle: String(lessonTitle || '').trim(),
    replayKey,
    source,
    publishedAt,
    // 简报：首页与笔记页顶部先用它给读者一个基本印象，再进入正文的细节。
    // 列表页也用它当摘要——比截断正文前 120 字有用得多。
    brief: briefing
      ? { briefing, keyPoints: (brief.keyPoints || []).filter(Boolean).slice(0, 5) }
      : null,
    summary: briefing ? summarizeMarkdown(briefing) : summarizeMarkdown(body),
    headings: extractHeadings(body),
    markdown: body
  }
}

/**
 * 笔记里有 Mermaid 代码块时才加载绘图库。
 *
 * 库是自托管的（站点服务器的 /assets/mermaid.min.js），不走 CDN：读者在国内，
 * 而且笔记页不该依赖第三方可用性。渲染失败时保留原始代码块，图看不成至少能读源码。
 */
const MERMAID_LOADER = `<script type="module">
const blocks = [...document.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid')]
if (blocks.length) {
  const load = () => new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/assets/mermaid.min.js'
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
  load().then(() => {
    const mermaid = window.mermaid
    if (!mermaid) return
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' })
    blocks.forEach((code, index) => {
      const source = code.textContent || ''
      const holder = document.createElement('div')
      holder.className = 'diagram'
      holder.id = \`mermaid-\${index}\`
      code.parentElement.replaceWith(holder)
      mermaid.render(\`mermaid-svg-\${index}\`, source)
        .then(result => { holder.innerHTML = result.svg })
        .catch(() => { holder.innerHTML = \`<pre><code>\${source.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</code></pre>\` })
    })
  }).catch(() => {})
}
</script>`

function pageShell({ title, description, body, canonical = '', scripts = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<style>${SITE_CSS}</style>
</head>
<body>
<div class="wrap">
${body}
<footer class="site">${escapeHtml(SITE_NAME)} · course.law-tech.dev</footer>
</div>
${scripts}
</body>
</html>
`
}

/** 笔记正文里是否真的有 Mermaid 图（没有就不加载 3.5MB 的绘图库）。 */
function hasMermaid(markdown = '') {
  return /```mermaid/.test(String(markdown))
}

export function renderNotePage(record, { siteOrigin = '' } = {}) {
  const toc = record.headings?.length
    ? `<nav class="toc"><h2>本课目录</h2><ol>${record.headings
      .map(heading => `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`)
      .join('')}</ol></nav>`
    : ''
  const meta = [record.courseName, record.teacher].filter(Boolean).join(' · ')
  return pageShell({
    title: `${record.lessonTitle} · ${SITE_NAME}`,
    description: record.summary,
    canonical: siteOrigin ? `${siteOrigin}/${record.slug}` : '',
    scripts: hasMermaid(record.markdown) ? MERMAID_LOADER : '',
    body: [
      '<header class="site">',
      `<div class="brand">${escapeHtml(SITE_NAME)}</div>`,
      `<h1>${escapeHtml(record.lessonTitle)}</h1>`,
      meta ? `<div class="meta">${escapeHtml(meta)}</div>` : '',
      '</header>',
      '<article>',
      record.brief?.briefing ? renderBriefBlock(record.brief) : '',
      toc,
      renderMarkdown(record.markdown),
      '</article>'
    ].filter(Boolean).join('\n')
  })
}

/** 简报块：笔记页顶部的一段"先看这里"，含三条要点。 */
function renderBriefBlock(brief = {}) {
  const points = (brief.keyPoints || []).filter(Boolean)
  return [
    '<section class="brief">',
    '<h2>本课简报</h2>',
    `<p>${escapeHtml(brief.briefing || '')}</p>`,
    points.length ? `<ul>${points.map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul>` : '',
    '</section>'
  ].filter(Boolean).join('\n')
}

export function renderIndexPage(records, { siteOrigin = '' } = {}) {
  const groups = new Map()
  for (const record of [...records].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))) {
    const key = record.courseName || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }

  const body = [
    '<header class="site">',
    `<div class="brand">${escapeHtml(SITE_NAME)}</div>`,
    '<h1>课程笔记</h1>',
    `<div class="meta">共 ${records.length} 篇</div>`,
    '</header>',
    records.length
      ? [...groups.entries()].map(([course, items]) => [
        '<section class="course-group">',
        `<h2>${escapeHtml(course)}</h2>`,
        items.map(record => [
          `<a class="card" href="${escapeHtml(record.slug)}.html">`,
          `<h3>${escapeHtml(record.lessonTitle)}</h3>`,
          `<p>${escapeHtml(record.summary)}</p>`,
          '</a>'
        ].join('\n')).join('\n'),
        '</section>'
      ].join('\n')).join('\n')
      : '<div class="empty">还没有已发布的笔记。完成一节课的笔记后运行 course publish。</div>'
  ].join('\n')

  return pageShell({
    title: SITE_NAME,
    description: '北大课程笔记：按课程与课次整理，含课程概览、章节总结、自测与知识连接。',
    canonical: siteOrigin || '',
    body
  })
}

/**
 * 写出整个站点。
 *
 * 每次都是全量重写：笔记数量以百计，全量写比增量同步简单得多，也不会出现
 * "删掉的笔记还挂在索引里"这类状态漂移。返回写入的文件清单便于核对。
 */
export function writeSite({ records = [], outputDir, siteOrigin = '' } = {}) {
  if (!outputDir) throw new Error('写站点需要 outputDir')
  const root = path.resolve(outputDir)
  fs.mkdirSync(root, { recursive: true })

  const written = []
  const write = (relative, content) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    written.push(relative)
  }

  const sorted = [...records].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
  write('index.html', renderIndexPage(sorted, { siteOrigin }))
  for (const record of sorted) {
    write(`${record.slug}.html`, renderNotePage(record, { siteOrigin }))
  }
  write('notes.json', `${JSON.stringify({
    siteName: SITE_NAME,
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    notes: sorted.map(({ markdown, ...rest }) => rest)
  }, null, 2)}\n`)

  return { outputDir: root, count: sorted.length, written }
}

/** 从磁盘读取已生成的笔记记录（站点服务器用它响应 API）。 */
export function readSiteIndex(outputDir) {
  const file = path.join(path.resolve(outputDir), 'notes.json')
  if (!fs.existsSync(file)) return { siteName: SITE_NAME, count: 0, notes: [], generatedAt: null }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`站点索引损坏：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
}
