import { escapeHtml, extractHeadings, renderMarkdown, summarizeMarkdown } from './markdown.mjs'
// 课次先后按上课日期，Markdown 地址与站点写出的文件同源（两个唯一实现都在这里引）
import { compareLessonAscending } from './lesson-date.mjs'
import { markdownPath, onePageMarkdownPath } from './markdown-path.mjs'

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
export function renderLlmsTxt({ records = [], topics = [], siteOrigin = '', pages = [] } = {}) {
  const base = String(siteOrigin || '').replace(/\/+$/, '')
  const absolute = value => (base ? `${base}${value}` : value)
  const courses = new Map()
  for (const record of records) {
    const course = record.courseName || '未分类'
    if (!courses.has(course)) courses.set(course, [])
    courses.get(course).push(record)
  }
  const topicsByCourse = new Map()
  for (const topic of topics || []) {
    const course = topic.course || '未分类'
    if (!topicsByCourse.has(course)) topicsByCourse.set(course, [])
    topicsByCourse.get(course).push(topic)
  }

  const lines = [
    '# 课程笔记 · course.law-tech.dev',
    '',
    '> 北大法学课程笔记。单课笔记是事实源；每节另有 A4「一页纸」用于快速复习，课程级索引与知识地图用于建立中观和宏观结构。',
    '> AI 应先用结构、摘要和索引缩小范围，再按需读取原笔记小节；不要把整门课全文一次灌入上下文。',
    '',
    '## 机器可读入口',
    ...pages.map(page => `- [${page.title}](${absolute(`/${page.pathName}.md`)})${page.description ? `：${page.description}` : ''}`),
    `- [笔记索引（JSON）](${absolute('/api/notes')})：全部笔记的主题、关键词、摘要与目录，不含正文`,
    `- [专题索引（JSON）](${absolute('/topics.json')})：当前有效专题的标题、覆盖课次与机器可读地址`,
    `- [RSS](${absolute('/feed.xml')})`,
    '',
    '## 课程与课次',
    ...[...courses.entries()].map(([course, items]) => [
      `- ${course}（${items.length} 讲）`,
      ...((topicsByCourse.get(course) || []).length ? [
        `  - 专题整合（${(topicsByCourse.get(course) || []).length} 个）`,
        ...(topicsByCourse.get(course) || []).map(topic =>
          `    - [${topic.title}](${absolute(topic.markdownPath || topic.pagePath || '')})${topic.summary ? `：${topic.summary}` : ''}`)
      ] : []),
      ...items
        .slice()
        .sort(compareLessonAscending)
        .map(item => {
          const theme = item.theme ? `主题 — ${item.theme}` : ''
          const keywords = (item.keywords || []).length ? `关键词 — ${item.keywords.join('、')}` : ''
          const detail = [theme, keywords].filter(Boolean).join('｜')
          const lines = [`  - [${item.lessonTitle}](${absolute(`/${item.slug}.html`)})${detail ? `：${detail}` : ''}`]
          // 顺带给出 Markdown 原文地址：AI 取全文不必再解析 HTML。
          // 地址与站点写出的文件同源（markdown-path.mjs），不会出现"链接指向一个不存在的文件"
          lines.push(`    - [Markdown 全文](${absolute(`/${markdownPath(item)}`)})`)
          if (item.onepage?.markdown) lines.push(`    - [一页纸 Markdown](${absolute(`/${onePageMarkdownPath(item)}`)})`)
          return lines.join('\n')
        })
    ].join('\n')),
    '',
    '## 跨课次的索引',
    `- [概念索引](${absolute('/concepts/')})：按课程 → 课次分组的核心概念`,
    `- [法条索引](${absolute('/statutes/')})`,
    `- [案例索引](${absolute('/cases/')})`,
    `- [知识地图](${absolute('/map/')})：课次骨架与跨课次出现的概念`,
    '',
    '## AI 最短读取路径',
    '- 不知道课程范围：先看本文件课程清单，或用 MCP `list_courses`；用户已经点名课程时不要多走这一层。',
    '- 已知课程、要挑课次：用 MCP `get_course` 看 theme / keywords / 摘要；只有需要目录时再取 outline。',
    '- 单节快速复习：优先上方对应的「一页纸 Markdown」；需要引用、核实或完整论证时再回原笔记。',
    '- 盘点一门课的概念/法条/案例：用 MCP `list_terms`；跨课次找具体问题的落点：`search_notes`。',
    '- 读取依据：MCP `get_note` 优先传 `section` 只取相关小节；不要习惯性读取整篇或先开启全文扫描。',
    '- 中观/宏观复习：先看知识地图、概念/法条/案例索引及已发布的专题类视图，再沿落点回具体课次/小节。',
    '- 证据边界：单课笔记是事实源；一页纸、知识地图、索引与专题类内容是派生/导航视图，不把同一结论当成多份独立证据。',
    // 路径带课程：只按课次命名的话，两门课同一天同名课次会互相覆盖
    '- 直接地址：原笔记 `/md/<课程>/<课次>.md`；一页纸 `/md/<课程>/<课次>-一页纸.md`。'
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
