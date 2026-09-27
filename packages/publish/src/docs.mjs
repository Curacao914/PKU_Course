import { escapeHtml, extractHeadings, renderMarkdown, summarizeMarkdown } from './markdown.mjs'

/**
 * 站点上的产品文档：给人和给 AI 读的同一份内容。
 *
 * 为什么放在站点上而不是只留在仓库里：AI 要能"读一个 URL 就知道这个站点有什么、怎么调用"。
 * 仓库里的 docs/ 是设计过程，这里是**对外契约**——新加的 API 与 MCP 能力都按同一约定追加。
 *
 * 同时产出三种形态：
 *   /<path>/    渲染给人看的页面（带目录）
 *   /<path>.md  原文（AI 直接 fetch，不必解析 HTML）
 *   /llms.txt   站点摘要与入口清单（AI 的第一站）
 */

export function renderDocPage({ title, description = '', markdown = '', siteOrigin = '', pathName = '' } = {}) {
  const headings = extractHeadings(markdown).filter(heading => heading.level >= 2 && heading.level <= 3)
  const toc = headings.length
    ? `<nav class="toc" aria-label="本页目录"><h2>本页目录</h2><ol>${headings
      .map(heading => `<li class="lv${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`)
      .join('')}</ol></nav>`
    : ''
  const body = [
    '<aside class="rail">' + toc + '</aside>',
    '<div class="col">',
    `<header class="site"><h1>${escapeHtml(title)}</h1></header>`,
    `<article>${renderMarkdown(markdown)}</article>`,
    '</div>'
  ].join('\n')

  return pageShellCompat({
    title: `${title} · 文档`,
    description: description || summarizeMarkdown(markdown),
    canonical: siteOrigin ? `${siteOrigin}/${pathName}/` : '',
    body
  })
}

/**
 * llms.txt：站点摘要 + 机器可读入口清单。
 *
 * 约定（llms.txt 提案）：H1 项目名、一段 blockquote 摘要、然后按小节列 markdown 链接。
 * 内容要短——它是"第一站"，不是把整站搬过来；具体内容让 AI 顺着链接去取。
 */
export function renderLlmsTxt({ records = [], siteOrigin = '', pages = [] } = {}) {
  const base = String(siteOrigin || '').replace(/\/+$/, '')
  const absolute = value => (base ? `${base}${value}` : value)
  const courses = new Map()
  for (const record of records) {
    const course = record.courseName || '未分类'
    if (!courses.has(course)) courses.set(course, [])
    courses.get(course).push(record)
  }

  const lines = [
    '# 课程笔记 · course.law-tech.dev',
    '',
    '> 北大法学课程笔记。每节课一篇结构化中文笔记（课程概览、分节要点、案例与法条、知识连接、易混辨析），',
    '> 另外每节有一张 A4 的「一页纸摘要」用于快速复习。全部内容可按课程 → 课次分层取用。',
    '',
    '## 机器可读入口',
    ...pages.map(page => `- [${page.title}](${absolute(`/${page.pathName}.md`)})${page.description ? `：${page.description}` : ''}`),
    `- [笔记索引（JSON）](${absolute('/api/notes')})：全部笔记的主题、关键词、摘要与目录，不含正文`,
    `- [RSS](${absolute('/feed.xml')})`,
    '',
    '## 课程与课次',
    ...[...courses.entries()].map(([course, items]) => [
      `- ${course}（${items.length} 讲）`,
      ...items
        .slice()
        .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
        .map(item => {
          const theme = item.theme ? `主题 — ${item.theme}` : ''
          const keywords = (item.keywords || []).length ? `关键词 — ${item.keywords.join('、')}` : ''
          const detail = [theme, keywords].filter(Boolean).join('｜')
          return `  - [${item.lessonTitle}](${absolute(`/${item.slug}.html`)})${detail ? `：${detail}` : ''}`
        })
    ].join('\n')),
    '',
    '## 跨课次的索引',
    `- [概念索引](${absolute('/concepts/')})：按课程 → 课次分组的核心概念`,
    `- [法条索引](${absolute('/statutes/')})`,
    `- [案例索引](${absolute('/cases/')})`,
    `- [知识地图](${absolute('/map/')})：课次骨架与跨课次出现的概念`,
    '',
    '## 怎么用',
    '- 只想知道"有哪些课"：读上面这份清单即可，不必抓页面。',
    '- 要按主题取用内容：用笔记 MCP（见「机器可读入口」第一条），它按 课程 → 课次 → 正文 分层返回，避免一次灌进过多文本。',
    '- 要全文：`/md/<课次>.md`（每篇笔记发布时同时写出一份 Markdown），一页纸则是 `/md/<课次>-一页纸.md`。'
  ]
  return lines.join('\n')
}

/** pageShell 由 site.mjs 注入：docs 模块不反向依赖整站，方便单测。 */
let pageShellImpl = null
export function usePageShell(impl) { pageShellImpl = impl }
function pageShellCompat(options) {
  if (!pageShellImpl) throw new Error('docs 模块还没有拿到 pageShell')
  return pageShellImpl(options)
}
