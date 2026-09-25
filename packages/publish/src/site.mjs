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
/* ── 设计令牌 ───────────────────────────────────────────────
   外壳用现代无衬线、正文用衬线：界面元素用无衬线是当下默认，
   而长篇中文阅读仍然衬线更省力。两套字体分工，是"不显旧"的关键。 */
:root {
  --bg: #ffffff;
  --bg-soft: #f6f7f8;
  --bg-sunken: #f1f3f4;
  --ink: #16191d;
  --ink-soft: #454b52;
  --muted: #787f87;
  --line: #e7e9ec;
  --line-strong: #d5d9dd;
  --accent: #2f6f61;
  --accent-ink: #245a4f;
  --accent-soft: #eef4f2;
  --warn: #a8641b;
  --warn-soft: #fdf5e9;
  --danger: #a33a3a;
  --danger-soft: #fbeeee;
  --ok: #2f7d52;
  --radius: 12px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(16, 24, 32, .05);
  --shadow-md: 0 10px 30px -18px rgba(16, 24, 32, .28);
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --serif: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif;
  --rail-w: 236px;
  --measure: 38em;            /* 约 38 个汉字一行：西文 65ch 的等效体验 */
  --header-h: 52px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 16px; line-height: 1.6;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-ink); }
::selection { background: var(--accent-soft); }

/* ── 顶部条：一条、薄、粘性；不与左栏目录争抢注意力 ── */
.topbar { position: sticky; top: 0; z-index: 40; height: var(--header-h); background: rgba(255,255,255,.86);
  backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid var(--line); }
.topbar .inner { max-width: 1140px; margin: 0 auto; padding: 0 24px; height: 100%;
  display: flex; align-items: center; gap: 20px; }
.topbar .brand { font-weight: 600; letter-spacing: .02em; color: var(--ink); }
.topbar .spacer { flex: 1; }
.topbar nav { display: flex; gap: 18px; font-size: 14px; }
.topbar nav a { color: var(--muted); }
.topbar nav a:hover { color: var(--ink); }

.wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 96px; }
/* 长文页：左栏目录 + 正文 */
.shell { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); gap: 56px;
  max-width: 1140px; margin: 0 auto; padding: 36px 24px 112px; }
.shell.single { grid-template-columns: minmax(0, 1fr); max-width: 760px; }
.col { min-width: 0; }
.col > * { max-width: var(--measure); }
.rail { position: sticky; top: calc(var(--header-h) + 20px); align-self: start;
  max-height: calc(100vh - var(--header-h) - 40px); overflow-y: auto; }
.rail nav.toc { padding: 0; margin: 0; }
.rail nav.toc h2 { margin: 0 0 10px; padding: 0; font-size: 12px; letter-spacing: .14em;
  color: var(--muted); font-weight: 600; text-transform: uppercase; }
.rail nav.toc ol { list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 1.5; }
.rail nav.toc li { margin: 0; }
.rail nav.toc li.lv3 { padding-left: 14px; }
.rail nav.toc a { display: block; padding: 5px 10px; color: var(--ink-soft); border-radius: 8px; }
.rail nav.toc a:hover { background: var(--bg-soft); color: var(--ink); }
.rail nav.toc a.active { color: var(--accent-ink); background: var(--accent-soft); font-weight: 600; }
.rail .rail-extra { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);
  font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
.rail .rail-extra .prevnext { display: flex; flex-direction: column; gap: 6px; }
.rail .rail-extra .prevnext a { color: var(--ink-soft); }
.rail-toggle { display: none; }
@media (max-width: 980px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 22px 18px 96px; }
  .rail { position: static; max-height: none; order: -1; }
  .rail-toggle { display: block; }
  .rail details { background: var(--bg-soft); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; }
  .rail details summary { cursor: pointer; font-size: 14px; color: var(--accent-ink); font-weight: 600; font-weight: 600; }
  .rail details nav.toc { margin-top: 12px; }
  .rail .rail-extra { display: none; }
  body { font-size: 17px; }
}

/* ── 正文：这里是唯一用衬线的地方 ── */
header.site { padding-bottom: 18px; margin-bottom: 30px; border-bottom: 1px solid var(--line); }
header.site .eyebrow { font-size: 13px; color: var(--muted); letter-spacing: .04em; }
header.site h1 { margin: 8px 0 0; font-size: 32px; line-height: 1.25; font-weight: 650; letter-spacing: -.015em; }
.meta { color: var(--muted); font-size: 14px; margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  background: var(--bg-soft); border: 1px solid var(--line); color: var(--ink-soft); font-size: 13px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.danger { background: var(--danger); }
article { font-family: var(--serif); font-size: 18px; line-height: 1.85; }
article h1, article h2, article h3, article h4 { font-family: var(--sans); letter-spacing: -.01em; }
article h1 { font-size: 28px; margin: 0 0 8px; }
article h2 { font-size: 21px; line-height: 1.35; margin: 44px 0 14px; padding-top: 14px;
  border-top: 1px solid var(--line); scroll-margin-top: calc(var(--header-h) + 16px); }
article h3 { font-size: 17px; line-height: 1.45; margin: 30px 0 10px; color: var(--ink-soft);
  scroll-margin-top: calc(var(--header-h) + 16px); }
article h4 { font-size: 16px; margin: 22px 0 8px; color: var(--ink-soft); }
article p { margin: 14px 0; }
article blockquote { margin: 20px 0; padding: 12px 18px; background: var(--bg-soft);
  border-left: 3px solid var(--accent); border-radius: 0 var(--radius) var(--radius) 0; color: var(--ink-soft); }
article blockquote p { margin: 4px 0; }
article hr { border: 0; border-top: 1px solid var(--line); margin: 38px 0; }
article code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg-sunken);
  padding: 1px 6px; border-radius: 6px; font-size: .86em; }
article pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg-sunken);
  padding: 14px 16px; border-radius: var(--radius); overflow-x: auto; font-size: 14px; line-height: 1.6; }
article pre code { background: none; padding: 0; }
article pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
article .brief { font-family: var(--sans); background: var(--bg-soft); border: 1px solid var(--line);
  border-radius: var(--radius-lg); padding: 20px 24px; margin: 0 0 30px; box-shadow: var(--shadow-sm); }
article .brief h2 { margin: 0 0 10px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase;
  border: 0; padding: 0; color: var(--muted); }
article .brief p { margin: 0 0 10px; font-size: 16px; line-height: 1.8; }
article .brief ul { margin: 0; padding-left: 20px; font-size: 15px; }
article .brief li { margin: 5px 0; }
.diagram { margin: 22px 0; padding: 12px 8px; overflow-x: auto; background: var(--bg-soft);
  border: 1px solid var(--line); border-radius: var(--radius); }
.diagram svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
/* ── 索引页：条目 + 出处 ── */
.index-list { margin-top: 8px; }
.index-row { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px;
  padding: 14px 0; border-bottom: 1px solid var(--line); align-items: start; }
.index-term { font-weight: 600; color: var(--ink); }
.index-article { margin-left: 8px; font-weight: 400; font-size: 13px; color: var(--muted); }
.index-notes { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 14px; }
.index-notes a { color: var(--ink-soft); border-bottom: 1px solid var(--line); }
.index-notes a:hover { color: var(--accent-ink); border-bottom-color: var(--accent); }
@media (max-width: 720px) { .index-row { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--bg-sunken); border: 1px solid var(--line-strong); border-bottom-width: 2px;
  border-radius: 6px; padding: 1px 6px; color: var(--ink-soft); }
.hero { padding: 8px 0 26px; border-bottom: 1px solid var(--line); margin-bottom: 26px; }
.hero h1 { margin: 0 0 10px; font-size: 34px; letter-spacing: -.02em; }
.hero p { margin: 0 0 18px; color: var(--ink-soft); font-size: 16px; max-width: 46em; }
article table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 15px;
  font-family: var(--sans); line-height: 1.6; }
article th, article td { border: 1px solid var(--line); padding: 9px 11px; text-align: left; vertical-align: top; }
article th { background: var(--bg-soft); font-weight: 600; color: var(--ink-soft); }
article tbody tr:hover { background: #fcfcfd; }
article ul, article ol { padding-left: 24px; }
article li { margin: 6px 0; }
article li.task { list-style: none; margin-left: -20px; }
article details { margin: 16px 0; }
article details summary { cursor: pointer; color: var(--accent-ink); font-family: var(--sans); font-size: 15px; }
article details[open] summary { margin-bottom: 8px; }
.anchor { margin-left: 8px; color: var(--line-strong); font-size: .7em; opacity: 0; border: 0; }
article h2:hover .anchor, article h3:hover .anchor, .anchor:focus-visible { opacity: 1; }
details.note-meta { margin-top: 50px; font-family: var(--sans); color: var(--muted); font-size: 13px; }
details.note-meta pre { background: var(--bg-soft); border-radius: var(--radius); padding: 12px 14px; overflow-x: auto; }

/* ── 卡片（首页、课程页） ── */
.card { display: block; padding: 20px 22px; margin: 12px 0; background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-md); }
.card h3 { margin: 0 0 6px; font-size: 17px; color: var(--ink); }
.card p { margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.7; }
.card .card-meta { margin-top: 10px; color: var(--muted); font-size: 13px; display: flex; gap: 12px; flex-wrap: wrap; }
.course-group { margin-top: 34px; }
.course-group > h2 { font-size: 15px; letter-spacing: .06em; color: var(--muted); text-transform: uppercase;
  border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 14px; font-weight: 600; }
.search { width: 100%; padding: 12px 16px; font-size: 16px; font-family: var(--sans);
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--bg); color: var(--ink); }
.search:focus { outline: 3px solid var(--accent-soft); outline-offset: 1px; border-color: var(--accent); }
.search-hint { color: var(--muted); font-size: 13px; margin: 10px 2px 0; }
.empty { color: var(--muted); background: var(--bg-soft); border: 1px dashed var(--line-strong);
  border-radius: var(--radius); padding: 22px; text-align: center; }
footer.site { max-width: 1140px; margin: 64px auto 0; padding: 20px 24px 40px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 13px; display: flex; gap: 16px; flex-wrap: wrap; }

/* 阅读进度与回到顶部 */
.progress { position: fixed; top: 0; left: 0; height: 3px; width: 0; background: var(--accent); z-index: 60; }
.totop { position: fixed; right: 22px; bottom: 22px; z-index: 60; border: 1px solid var(--line-strong);
  background: var(--bg); color: var(--ink-soft); border-radius: 999px; padding: 9px 16px;
  font-family: var(--sans); font-size: 14px; cursor: pointer; opacity: 0; pointer-events: none;
  transition: opacity .18s ease; box-shadow: var(--shadow-md); }
.totop.show { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) { .totop { transition: none; } }

/* 打印只留最朴素的兜底（用户明确说复习不靠打印） */
@media print {
  .rail, .progress, .totop, .topbar, footer.site { display: none; }
  .shell { display: block; max-width: none; padding: 0; }
  .col > * { max-width: none; }
  article { font-size: 11pt; }
}
`
export function noteSlug({ courseName, lessonTitle }) {
  return `notes/${slugify(courseName, 'course')}/${slugify(lessonTitle, 'lesson')}`
}

/** 从笔记目录读取记录（course notes 命令的产物）。 */
/**
 * 从笔记的元数据块里抽出概念 / 法条 / 案例。
 *
 * 笔记末尾的 `<details>` 里有一份 `META: TYPE: value` 清单（由 notes 阶段从节点正文抽取）。
 * 这里只按行解析，不依赖 @course/notes——publish 只面对"文件"，
 * 这样索引页与笔记生成彼此独立，任何一边改了都不会把另一边弄坏。
 */
export function extractNoteMetadata(markdown = '') {
  const buckets = { concepts: [], statutes: [], cases: [] }
  const kindOf = { CONCEPT: 'concepts', PROVISION: 'statutes', CASE: 'cases' }
  const seen = new Set()
  for (const line of String(markdown ?? '').split('\n')) {
    const match = line.match(/^\s*META:\s*(CONCEPT|PROVISION|CASE):\s*(.+?)\s*$/)
    if (!match) continue
    const bucket = kindOf[match[1]]
    const value = match[2].trim()
    const key = `${bucket}:${value}`
    if (!value || seen.has(key)) continue
    seen.add(key)
    buckets[bucket].push(value)
  }
  return buckets
}

/** 从《法律名》第 N 条 这类写法里拆出法律名与条号，用于法条索引分组排序。 */
export function parseStatute(value = '') {
  const text = String(value || '').replace(/[《》]/g, ' ').replace(/\s+/g, ' ').trim()
  const match = text.match(/^(.+?)\s*第\s*([0-9０-９一二三四五六七八九十百零两]+)\s*条/)
  if (!match) return { law: text || '未标注法律', article: '' }
  return { law: match[1].trim(), article: match[2].trim() }
}

const ARTICLE_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 条号排序：中文数字与阿拉伯数字都要能比大小（"第二十五条" 排在 "第十条" 之后）。 */
export function articleNumber(article = '') {
  const text = String(article || '')
  if (/^[0-9０-９]+$/.test(text)) return Number(text.replace(/[０-９]/g, ch => String('０１２３４５６７８９'.indexOf(ch))))
  let total = 0
  let section = 0
  for (const char of text) {
    if (char === '十') section = (section || 1) * 10
    else if (char === '百') section = (section || 1) * 100
    else if (ARTICLE_DIGITS[char] !== undefined) section = ARTICLE_DIGITS[char]
    else return Number.MAX_SAFE_INTEGER
    total += section
    section = 0
  }
  return total || Number.MAX_SAFE_INTEGER
}

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
    // 阅读时长与结构化元数据都进索引：前者显示在页面上，后者供索引页与站内搜索使用
    readMinutes: estimateReadMinutes(body),
    metadata: extractNoteMetadata(body),
    markdown: body
  }
}

/**
 * 笔记里有 Mermaid 代码块时才加载绘图库。
 *
 * 库是自托管的（站点服务器的 /assets/mermaid.min.js），不走 CDN：读者在国内，
 * 而且笔记页不该依赖第三方可用性。渲染失败时保留原始代码块，图看不成至少能读源码。
 */
// 资源带版本号：CDN/边缘缓存不会因为文件内容变了就失效，换版本必须换 URL。
const MERMAID_VERSION = '11.17.2'

const MERMAID_LOADER = `<script type="module">
const blocks = [...document.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid')]
if (blocks.length) {
  const load = () => new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/assets/mermaid.min.js?v=${MERMAID_VERSION}'
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

function pageShell({ title, description, body, canonical = '', scripts = '', layout = 'page' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<style>${SITE_CSS}</style>
</head>
<body>
<header class="topbar"><div class="inner">
  <a class="brand" href="/">课程笔记</a>
  <span class="spacer"></span>
  <nav>
    <a href="/">全部课次</a>
    <a href="/concepts/">概念索引</a>
    <a href="/statutes/">法条索引</a>
    <a href="/search/">搜索</a>
  </nav>
</div></header>
${layout === 'shell' ? '<div class="shell">' : '<div class="wrap">'}
${body}
</div>
<footer class="site">
  <span>${escapeHtml(SITE_NAME)} · course.law-tech.dev</span>
  <span>笔记由课堂转录与课件自动生成，逐节点经独立审查；发现错误请以课堂原音为准。</span>
</footer>
${scripts}
</body>
</html>
`
}

/** 笔记正文里是否真的有 Mermaid 图（没有就不加载 3.5MB 的绘图库）。 */
function hasMermaid(markdown = '') {
  return /```mermaid/.test(String(markdown))
}

/** 中文阅读时长：约 400 字/分钟；表格与图另外加权（表格扫读快，图要停下来看）。 */
export function estimateReadMinutes(markdown = '') {
  const text = String(markdown || '')
  const chars = text.replace(/\s/g, '').length
  const tables = (text.match(/^\s*\|/gm) || []).length / 6
  const diagrams = (text.match(/```mermaid/g) || []).length
  return Math.max(1, Math.round(chars / 400 + tables * 0.1 + diagrams * 0.5))
}

/**
 * 笔记页上的交互脚本。
 *
 * 三件事：左栏目录随阅读高亮、顶部进度条、回到顶部。
 * 刻意保持很小：站点没有框架也没有构建步骤，这段就是原生 JS。
 * 高亮用 IntersectionObserver（而不是滚动位置算术）——正反向滚动都对。
 */
const NOTE_SCRIPT = `<script>
(function () {
  var links = new Map();
  document.querySelectorAll('.rail nav.toc a').forEach(function (a) { links.set(a.hash.slice(1), a) })
  var headings = [].slice.call(document.querySelectorAll('article h2[id], article h3[id]'));

  function setActive (id) {
    var current = document.querySelector('.rail nav.toc a.active');
    if (current) current.classList.remove('active');
    var next = links.get(id);
    if (next) next.classList.add('active');
  }
  if (headings.length && links.size) {
    var io = new IntersectionObserver(function () {
      var mid = window.scrollY + window.innerHeight * 0.25;
      var current = headings[0];
      for (var i = 0; i < headings.length; i += 1) {
        if (headings[i].offsetTop <= mid) current = headings[i]; else break;
      }
      if (current) setActive(current.id);
    }, { rootMargin: '-25% 0px -50% 0px', threshold: 0 });
    headings.forEach(function (h) { io.observe(h) });
    setActive(headings[0].id);
  }

  var bar = document.getElementById('progress');
  var top = document.getElementById('totop');
  function onScroll () {
    var doc = document.documentElement;
    var max = doc.scrollHeight - doc.clientHeight;
    if (bar) bar.style.width = (max > 0 ? Math.min(100, (doc.scrollTop / max) * 100) : 0) + '%';
    if (top) top.classList.toggle('show', doc.scrollTop > 700);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (top) top.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }) });

  // 小节锚点：悬停显示 #，点一下把「页面地址 + 小节」复制到剪贴板
  headings.forEach(function (h) {
    var a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.textContent = '#';
    a.setAttribute('aria-label', '复制这一节的链接');
    a.addEventListener('click', function (event) {
      event.preventDefault();
      var url = location.origin + location.pathname + '#' + h.id;
      if (navigator.clipboard) navigator.clipboard.writeText(url);
      history.replaceState(null, '', '#' + h.id);
      a.textContent = '已复制';
      setTimeout(function () { a.textContent = '#' }, 1200);
    });
    h.appendChild(a);
  });
})();
</script>`

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

export function renderNotePage(record, { siteOrigin = '', neighbours = {} } = {}) {
  const headings = record.headings || []
  const tocList = headings.length
    ? `<ol>${headings.map(heading => `<li class="${heading.level === 3 ? 'lv3' : 'lv2'}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`).join('')}</ol>`
    : '<p class="search-hint">这篇笔记没有分节标题。</p>'
  const toc = `<nav class="toc" aria-label="本页目录"><h2>本页目录</h2>${tocList}</nav>`
  const readMinutes = record.readMinutes || estimateReadMinutes(record.markdown)
  const meta = [
    record.courseName ? `<a href="/courses/${escapeHtml(slugify(record.courseName))}/">${escapeHtml(record.courseName)}</a>` : '',
    record.teacher ? escapeHtml(record.teacher) : '',
    `约 ${readMinutes} 分钟`,
    record.publishedAt ? `${escapeHtml(String(record.publishedAt).slice(0, 10))} 发布` : ''
  ].filter(Boolean).join(' · ')

  const railExtra = [
    neighbours.previous ? `<div class="prevnext"><span>上一讲</span><a href="${escapeHtml(neighbours.previous.slug)}.html">${escapeHtml(neighbours.previous.lessonTitle)}</a></div>` : '',
    neighbours.next ? `<div class="prevnext"><span>下一讲</span><a href="${escapeHtml(neighbours.next.slug)}.html">${escapeHtml(neighbours.next.lessonTitle)}</a></div>` : ''
  ].filter(Boolean).join('')

  return pageShell({
    title: `${record.lessonTitle} · ${SITE_NAME}`,
    description: record.summary,
    canonical: siteOrigin ? `${siteOrigin}/${record.slug}` : '',
    layout: 'shell',
    scripts: [hasMermaid(record.markdown) ? MERMAID_LOADER : '', NOTE_SCRIPT].filter(Boolean).join('\n'),
    body: [
      '<div class="progress" id="progress"></div>',
      '<aside class="rail">',
      `<div class="rail-toggle"><details><summary>本页目录</summary>${toc}</details></div>`,
      `<div class="rail-desktop">${toc}</div>`,
      railExtra ? `<div class="rail-extra">${railExtra}</div>` : '',
      '</aside>',
      '<div class="col">',
      '<header class="site">',
      record.courseName ? `<div class="eyebrow">${escapeHtml(record.courseName)}</div>` : '',
      `<h1>${escapeHtml(record.lessonTitle)}</h1>`,
      meta ? `<div class="meta">${meta}</div>` : '',
      '</header>',
      '<article>',
      record.brief?.briefing ? renderBriefBlock(record.brief) : '',
      renderMarkdown(record.markdown),
      '</article>',
      '</div>',
      '<button class="totop" id="totop" type="button">回到顶部</button>'
    ].filter(Boolean).join('\n')
  })
}

/**
 * 索引页：概念 / 法条 / 案例。
 *
 * 这是"治割裂"最实际的一页——复习时真正会问的是"这个概念老师在哪几讲讲讲过、
 * 每次讲法有什么不同"，而不是"这节课讲了什么"。数据全部来自各篇笔记的元数据块，
 * 不需要重跑模型。
 */
export function renderTermIndexPage({ title, description, kind, notes = [], siteOrigin = '' } = {}) {
  const kindOf = { concepts: 'concepts', statutes: 'statutes', cases: 'cases' }
  const bucket = kindOf[kind] || 'concepts'
  const entries = new Map()
  for (const note of notes) {
    for (const value of (note.metadata?.[bucket] || [])) {
      const key = String(value).trim()
      if (!key) continue
      if (!entries.has(key)) entries.set(key, [])
      entries.get(key).push(note)
    }
  }

  const items = [...entries.entries()]
  const list = bucket === 'statutes'
    ? items.sort((left, right) => {
      const a = parseStatute(left[0]); const b = parseStatute(right[0])
      return a.law.localeCompare(b.law, 'zh') || articleNumber(a.article) - articleNumber(b.article)
    })
    : items.sort((left, right) => left[0].localeCompare(right[0], 'zh'))

  const body = [
    '<header class="site">',
    `<div class="eyebrow">索引</div>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="meta">${list.length} 条 · ${notes.length} 篇笔记</div>`,
    `<p class="search-hint">${escapeHtml(description)}</p>`,
    '</header>',
    list.length
      ? `<div class="index-list">${list.map(([term, used]) => [
        '<div class="index-row">',
        `<div class="index-term">${escapeHtml(term)}${bucket === 'statutes' && parseStatute(term).article ? `<span class="index-article">第 ${escapeHtml(parseStatute(term).article)} 条</span>` : ''}</div>`,
        '<div class="index-notes">',
        used.map(note => `<a href="/${escapeHtml(note.slug)}.html">${escapeHtml(note.courseName || '')} · ${escapeHtml(note.lessonTitle)}</a>`).join(''),
        '</div>',
        '</div>'
      ].join('\n')).join('\n')}</div>`
      : '<div class="empty">还没有索引数据。发布过带元数据的笔记之后这里会自动出现。</div>'
  ].join('\n')

  return pageShell({
    title: `${title} · ${SITE_NAME}`,
    description,
    canonical: siteOrigin ? `${siteOrigin}/${kind}/` : '',
    body
  })
}

/** 站内搜索页：纯客户端，索引就是 notes.json（不含正文，体积可控）。 */
export function renderSearchPage({ siteOrigin = '' } = {}) {
  const body = [
    '<header class="site">',
    '<div class="eyebrow">搜索</div>',
    '<h1>搜索笔记</h1>',
    '<div class="meta">按小节标题、概念、法条、案例与摘要检索</div>',
    '</header>',
    '<input class="search" id="q" type="search" placeholder="例如：众数、第 25 条、抽样、共犯" autocomplete="off">',
    '<div class="search-hint" id="hint">输入两个字以上开始搜索。按 <kbd>/</kbd> 聚焦，<kbd>Esc</kbd> 清空。</div>',
    '<div id="results"></div>',
    SEARCH_SCRIPT
  ].join('\n')
  return pageShell({
    title: `搜索 · ${SITE_NAME}`,
    description: '在全部课程笔记里检索小节标题、概念、法条与案例。',
    canonical: siteOrigin ? `${siteOrigin}/search/` : '',
    body
  })
}

/**
 * 搜索脚本：中文用字符二元组（bigram）匹配，不引入分词库。
 *
 * 打分：小节标题 > 概念/法条/案例 > 摘要。命中片段高亮，
 * 结果里显示"课程 · 课次 · 命中在哪一节"，让人判断要不要点进去。
 */
const SEARCH_SCRIPT = `<script>
(function () {
  var input = document.getElementById('q');
  var results = document.getElementById('results');
  var hint = document.getElementById('hint');
  var index = null;

  function bigrams (text) {
    var s = String(text || '').toLowerCase().replace(/\s+/g, '');
    var out = new Set();
    if (s.length === 1) out.add(s);
    for (var i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  }

  function score (note, query) {
    var grams = bigrams(query);
    if (!grams.size) return 0;
    var fields = [
      { text: note.lessonTitle, weight: 6 },
      { text: (note.headings || []).map(function (h) { return h.text }).join(' '), weight: 4 },
      { text: (note.metadata && note.metadata.concepts || []).join(' '), weight: 5 },
      { text: (note.metadata && note.metadata.statutes || []).join(' '), weight: 5 },
      { text: (note.metadata && note.metadata.cases || []).join(' '), weight: 4 },
      { text: note.courseName, weight: 3 },
      { text: note.summary, weight: 1 }
    ];
    var total = 0;
    fields.forEach(function (field) {
      var hay = bigrams(field.text);
      var hit = 0;
      grams.forEach(function (g) { if (hay.has(g)) hit += 1; });
      total += (hit / grams.size) * field.weight;
    });
    return total;
  }

  function render (query) {
    if (!index) return;
    if (String(query).trim().length < 2) { results.innerHTML = ''; return; }
    var hits = index.notes
      .map(function (note) { return { note: note, s: score(note, query) } })
      .filter(function (hit) { return hit.s > 1.2 })
      .sort(function (a, b) { return b.s - a.s })
      .slice(0, 20);
    hint.textContent = hits.length ? '命中 ' + hits.length + ' 篇' : '没有命中。换个说法，或试试概念名与条号。';
    results.innerHTML = hits.map(function (hit) {
      var note = hit.note;
      var heads = (note.headings || []).slice(0, 6).map(function (h) { return h.text }).join('、');
      return '<a class="card" href="/' + note.slug + '.html">' +
        '<h3>' + escapeHtml(note.lessonTitle) + '</h3>' +
        '<p>' + escapeHtml(note.summary || '') + '</p>' +
        '<div class="card-meta"><span>' + escapeHtml(note.courseName || '') + '</span><span>约 ' + (note.readMinutes || 0) + ' 分钟</span></div>' +
        (heads ? '<div class="card-meta"><span>小节：' + escapeHtml(heads) + '</span></div>' : '') +
        '</a>';
    }).join('');
  }

  function escapeHtml (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] }) }

  fetch('/api/notes').then(function (r) { return r.json() }).then(function (data) {
    index = data;
    hint.textContent = '已索引 ' + (data.count || 0) + ' 篇笔记。输入两个字以上开始搜索。';
    var initial = new URLSearchParams(location.search).get('q');
    if (initial) { input.value = initial; render(initial) }
  }).catch(function () { hint.textContent = '索引加载失败。' });

  input.addEventListener('input', function () { render(input.value) });
  document.addEventListener('keydown', function (event) {
    if (event.key === '/' && document.activeElement !== input) { event.preventDefault(); input.focus() }
    if (event.key === 'Escape' && document.activeElement === input) { input.value = ''; render('') }
  });
})();
</script>`

export function renderIndexPage(records, { siteOrigin = '' } = {}) {
  const groups = new Map()
  for (const record of [...records].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))) {
    const key = record.courseName || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }

  const courses = [...groups.keys()]
  const body = [
    '<section class="hero">',
    '<h1>课程笔记</h1>',
    '<p>课堂录音自动转录、按知识体系整理的法学课程笔记。每篇都有体系层（知识地图与体系线索）、逐节正文与复习层（概念 / 法条 / 案例索引）。</p>',
    `<div class="meta">共 ${records.length} 篇 · ${courses.length} 门课</div>`,
    records.length ? '<div style="margin-top:18px"><a href="/search/" class="pill">搜索笔记：概念、条号、案例…</a></div>' : '',
    '</section>',
    records.length
      ? [...groups.entries()].map(([course, items]) => [
        '<section class="course-group">',
        `<h2>${escapeHtml(course)} · ${items.length} 讲</h2>`,
        items.map(record => [
          `<a class="card" href="${escapeHtml(record.slug)}.html">`,
          `<h3>${escapeHtml(record.lessonTitle)}</h3>`,
          `<p>${escapeHtml(record.summary)}</p>`,
          '<div class="card-meta">',
          record.readMinutes ? `<span>约 ${record.readMinutes} 分钟</span>` : '',
          record.metadata ? `<span>${(record.metadata.concepts || []).length} 个概念 · ${(record.metadata.statutes || []).length} 条法条 · ${(record.metadata.cases || []).length} 个案例</span>` : '',
          record.publishedAt ? `<span>${escapeHtml(String(record.publishedAt).slice(0, 10))}</span>` : '',
          '</div>',
          '</a>'
        ].join('\n')).join('\n'),
        '</section>'
      ].join('\n')).join('\n')
      : '<div class="empty">还没有已发布的笔记。完成一节课的笔记后运行 course publish。</div>'
  ].filter(Boolean).join('\n')

  return pageShell({
    title: SITE_NAME,
    description: '北大课程笔记：按课程与课次整理，含体系层、逐节正文与概念 / 法条 / 案例索引。',
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

  // 上一讲 / 下一讲：同一门课内按发布时间排序后的相邻两篇
  const neighboursOf = record => {
    const sameCourse = sorted.filter(item => item.courseName === record.courseName)
      .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
    const at = sameCourse.findIndex(item => item.slug === record.slug)
    return { previous: at > 0 ? sameCourse[at - 1] : null, next: at >= 0 && at < sameCourse.length - 1 ? sameCourse[at + 1] : null }
  }

  write('index.html', renderIndexPage(sorted, { siteOrigin }))
  for (const record of sorted) {
    write(`${record.slug}.html`, renderNotePage(record, { siteOrigin, neighbours: neighboursOf(record) }))
  }

  // 索引页与搜索页：数据全部来自各篇笔记的元数据块，不重新跑模型
  write('concepts/index.html', renderTermIndexPage({
    title: '概念索引', kind: 'concepts', notes: sorted, siteOrigin,
    description: '同一个概念在不同课次里怎么讲、讲到哪一步。复习时按概念查，比重读整篇快。'
  }))
  write('statutes/index.html', renderTermIndexPage({
    title: '法条索引', kind: 'statutes', notes: sorted, siteOrigin,
    description: '按法律名与条号排列，显示每个条号在哪几节课出现过。'
  }))
  write('cases/index.html', renderTermIndexPage({
    title: '案例索引', kind: 'cases', notes: sorted, siteOrigin,
    description: '课堂上讲过的案例，以及它出现在哪些课次。'
  }))
  write('search/index.html', renderSearchPage({ siteOrigin }))
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
