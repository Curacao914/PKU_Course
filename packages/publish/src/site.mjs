import fs from 'node:fs'
import path from 'node:path'

import { escapeHtml, extractHeadings, renderMarkdown, slugify, summarizeMarkdown } from './markdown.mjs'
import { PREF_MENU_SCRIPT, READER_SCRIPT, courseNav, settingsMenu, svgIcon, toolBar } from './reader.mjs'
import { ONEPAGE_CSS, renderOnepagePage } from './onepage.mjs'
import { renderDocPage, renderLlmsTxt, usePageShell } from './docs.mjs'
// 时间语义（lessonDate / firstPublishedAt / updatedAt）与 Markdown 路径各有一个唯一实现，
// 站内所有排序、日期列、下载链接、llms.txt 都从这里取，不再各自拼。
import {
  compareFirstPublishedDescending, compareLessonAscending, compareLessonDescending,
  firstPublishedAtOf, lessonDateOf, resolveLessonDate
} from './lesson-date.mjs'
import { markdownPath, onePageMarkdownPath } from './markdown-path.mjs'

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
  --font-scale: 1;            /* 阅读字号倍率，由右上角工具栏控制 */
  --topbar-bg: rgba(255, 255, 255, .86);
  --card-bg: #ffffff;
  --mark: rgba(255, 226, 108, .55);   /* 划词高亮的底色：以前这个变量没定义，高亮一直是透明的 */
}
/* 护眼背景：豆沙绿与牛皮纸。只换底色与纸面层次，不动正文颜色对比度——
   "护眼"要的是少一点蓝光，不是把字变灰。 */
:root[data-paper="green"] { --bg: #c7edcc; --bg-soft: #bfe7c5; --bg-sunken: #b6e0bd; --card-bg: #d6f2da; --topbar-bg: rgba(199, 237, 204, .88); }
:root[data-paper="kraft"] { --bg: #f4ecd8; --bg-soft: #efe5cd; --bg-sunken: #e8dcc0; --card-bg: #f8f2e3; --topbar-bg: rgba(244, 236, 216, .9); }
:root[data-paper="gray"] { --bg: #f2f3f5; --bg-soft: #eceef1; --bg-sunken: #e5e8ec; --card-bg: #ffffff; --topbar-bg: rgba(242, 243, 245, .9); }
/* 深色：默认仍是浅色（浅色在小字号与正常视力下阅读表现更好），
   深色是给夜间阅读的开关，选择记在本地。 */
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #14171a; --bg-soft: #1b1f23; --bg-sunken: #22272c;
  --ink: #e8eaed; --ink-soft: #c3c9d0; --muted: #8b939c;
  --line: #2a2f34; --line-strong: #3a4046;
  --accent: #79b8a8; --accent-ink: #9ccfc2; --accent-soft: #1d2b28;
  --warn: #d9a05b; --warn-soft: #2a2318; --danger: #d97b7b; --danger-soft: #2b1c1c; --ok: #6dbb8e;
  --topbar-bg: rgba(20, 23, 26, .88);
  --card-bg: #1b1f23;
  --mark: rgba(255, 214, 92, .32);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .4);
  --shadow-md: 0 10px 30px -18px rgba(0, 0, 0, .8);
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
.topbar { position: sticky; top: 0; z-index: 40; height: var(--header-h); background: var(--topbar-bg);
  backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid var(--line); }
.topbar .inner { max-width: 1140px; margin: 0 auto; padding: 0 24px; height: 100%;
  display: flex; align-items: center; gap: 20px; }
.topbar .brand { font-weight: 600; letter-spacing: .02em; color: var(--ink); }
.topbar .spacer { flex: 1; }
.topbar nav { display: flex; gap: 18px; font-size: 14px; }
.topbar nav a { color: var(--muted); }
.topbar nav a:hover { color: var(--ink); }

.wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 96px; }
/* 内容区的基准字号跟着阅读设置走（宽版的首页/索引/地图也用 .wrap）：里面的字号都写成
   em，字号滑块才真的改得动表格、词条与搜索结果——否则它只是改了一个没人看的变量。
   1em 取父级（body）的字号，窄屏那处 17px 的上调不会被这里吃掉。 */
.wrap { font-size: calc(1em * var(--font-scale)); }
/* 表格页（首页/索引/地图）用宽版：一行里有课次、关键词、时长、日期，760px 会挤成一团 */
.wrap.wide { max-width: 1360px; padding: 30px 22px 96px; }
.wrap.wide .index-shell { grid-template-columns: 164px minmax(0, 1fr); gap: 22px; }
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
.rail nav.toc li.lv4 { padding-left: 28px; font-size: 13.5px; }
.rail nav.toc li.lv4 a { color: var(--muted); }
.rail nav.toc a { display: block; padding: 5px 10px; color: var(--ink-soft); border-radius: 8px; }
.rail nav.toc a:hover { background: var(--bg-soft); color: var(--ink); }
.rail nav.toc a.active { color: var(--accent-ink); background: var(--accent-soft); font-weight: 600; }
.rail .rail-extra { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);
  font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
.rail .rail-extra .prevnext { display: flex; flex-direction: column; gap: 6px; }
.rail .rail-extra .prevnext a { color: var(--ink-soft); }
.resume { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 20px; padding: 8px 14px;
  border-radius: 999px; background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent-ink);
  font-family: var(--sans); font-size: 14px; cursor: pointer; }
.resume:hover { border-color: var(--accent); }
.rail-toggle { display: none; }
/* 只给读屏软件的文本：视觉上不出现，但输入框/按钮就有了可读的名字 */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 980px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 22px 18px 96px; }
  /**
   * 手机上把左栏拆开：目录放正文**之前**，课程课次导航放正文**之后**。
   *
   * 以前整栏用 order:-1 顶到最前、并且把 rail-extra（上下讲/课次导航）直接 display:none。
   * 后果是手机读者打开一节长笔记时，第一个能点的"跳到某小节"要往下翻过整篇；
   * 而"这是哪节课、上一节是什么"反而消失了。
   * display:contents 让 .rail 的孩子们直接参与 .shell 的网格排序，于是可以：
   *   目录(1) → 正文(2) → 课次导航(3)。
   */
  .shell { display: flex; flex-direction: column; }
  .rail { display: contents; }
  .rail-toggle { display: block; order: 1; }
  .rail nav.toc { order: 1; }
  .shell > .col { order: 2; }
  .rail .rail-extra { order: 3; display: block; margin-top: 4px; padding-top: 16px; border-top: 1px solid var(--line); }
  .rail details { background: var(--bg-soft); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; }
  .rail details summary { cursor: pointer; font-size: 14px; color: var(--accent-ink); font-weight: 600; }
  .rail details nav.toc { margin-top: 12px; }
  body { font-size: 17px; }
  /* 移动端点击区稍大：目录与课次链接至少 40px 高 */
  .rail nav.toc a, .rail .rail-extra a { display: block; padding: 10px; min-height: 40px; }
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
article { font-family: var(--serif); font-size: calc(18px * var(--font-scale)); line-height: 1.85; }
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
/* 索引按 课程 → 课次 切分，每条术语只是一个可点的词 */
.term-course { margin: 0 0 30px; }
.term-course > h2 { margin: 0 0 10px; font-size: 1.06em; }
.term-group { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--card-bg); }
.term-group > h3 { margin: 0 0 8px; font-size: .875em; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.term-group > h3 a { color: var(--ink); }
.term-group > h3 a:hover { color: var(--accent-ink); }
.term-count { color: var(--muted); font-size: .78em; font-weight: 400; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-block; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--bg-soft); color: var(--ink-soft); font-size: .84em; line-height: 1.6; }
.chip:hover { border-color: var(--accent); color: var(--accent-ink); background: var(--accent-soft); }
/* 知识地图 */
.map-head { margin: 0 0 14px; }
.map-head h2 { margin: 0 0 4px; font-size: 1.06em; }
.map-legend { margin: 0; color: var(--muted); font-size: .78em; }
.map-holder { overflow-x: auto; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--card-bg); }
.map-holder svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }

/* 不止一节讲过的术语：复习时最该先看的那些 */
.chip-shared { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-ink); }
.index-row[hidden], .index-group[hidden], .term-course[hidden], .index-notes a[hidden] { display: none; }
/* ── 索引页：左边挑课程，右边条目一次列到底（不折叠） ── */
.index-shell { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 30px; align-items: start; }
.filter-rail { position: sticky; top: calc(var(--header-h) + 20px); display: flex; flex-direction: column; gap: 2px;
  font-family: var(--sans); }
.filter-rail button { display: flex; justify-content: space-between; gap: 10px; font: inherit; font-size: .875em;
  padding: 7px 10px; border: 0; border-radius: 8px; background: none; color: var(--ink-soft); cursor: pointer; text-align: left; }
.filter-rail button:hover { background: var(--bg-soft); color: var(--ink); }
.filter-rail button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
.filter-rail .filter-count { color: var(--muted); font-size: .78em; }
.index-group { margin-bottom: 28px; }
.index-group > h2 { font-size: 1em; margin: 0 0 2px; color: var(--ink-soft); }
.index-row[hidden], .index-group[hidden], .index-notes a[hidden] { display: none; }

/* ── 首页：一门课一张表，一行一节课 ── */
.band { margin: 0 0 30px; }
.band > h2 { margin: 0 0 10px; font-size: 1.06em; letter-spacing: -.01em; }
.lesson-table { width: 100%; border-collapse: collapse; font-family: var(--sans); }
.lesson-table th { text-align: left; font-size: .75em; font-weight: 500; color: var(--muted);
  letter-spacing: .06em; padding: 0 10px 8px; border-bottom: 1px solid var(--line-strong); }
.lesson-table th.num, .lesson-table td.num { text-align: right; }
.lesson-table td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: baseline; }
.lesson-table tbody tr:hover { background: var(--bg-soft); }
.lesson-table .lesson-title a { color: var(--ink); font-size: .97em; }
.lesson-table .lesson-title a:hover { color: var(--accent-ink); }
.lesson-keywords { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.lesson-table .lesson-keywords { border-bottom: 1px solid var(--line); }
.kw { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--bg-soft);
  color: var(--ink-soft); font-size: .78em; line-height: 1.7; }
/* 主题句：一行说清这节课在讲什么，关键词跟在它后面 */
.lesson-theme { display: block; color: var(--ink); font-size: .84em; margin-bottom: 5px; }
/* 一页纸入口：一张带折角的纸。原来写的是「一页纸」三个字，在这张表里会被挤成两行 */
.onepage-link { display: inline-flex; align-items: center; vertical-align: -3px; margin-left: 6px; color: var(--accent); }
.onepage-link:hover { color: var(--accent-ink); }
.onepage-link svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round; }
.onepage-row .lesson-title a { font-weight: 600; }
.onepage-row td { background: var(--bg-soft); }
.lesson-meta, .lesson-date { color: var(--muted); font-size: .78em; text-align: right; white-space: nowrap; }
@media (max-width: 720px) {
  /* 窄屏先保课次与关键词：时长与日期可以点进去看 */
  .lesson-table .lesson-meta, .lesson-table .lesson-date,
  .lesson-table th:nth-child(3), .lesson-table th:nth-child(4) { display: none; }
}
@media (max-width: 720px) {
  .index-shell { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .filter-rail { position: static; flex-direction: row; flex-wrap: wrap; }
  .index-body { min-width: 0; }
  .strip { grid-auto-columns: minmax(200px, 76%); }
}
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
.card { display: block; padding: 20px 22px; margin: 12px 0; background: var(--card-bg);
  border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-md); }
.card h3 { margin: 0 0 6px; font-size: 1.06em; color: var(--ink); }
.card p { margin: 0; color: var(--muted); font-size: .9em; line-height: 1.7; }
.card .card-meta { margin-top: 10px; color: var(--muted); font-size: .81em; display: flex; gap: 12px; flex-wrap: wrap; }
.search { width: 100%; padding: 12px 16px; font-size: 1em; font-family: var(--sans);
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--bg); color: var(--ink); }
.search:focus { outline: 3px solid var(--accent-soft); outline-offset: 1px; border-color: var(--accent); }
.search-hint { color: var(--muted); font-size: .81em; margin: 10px 2px 0; }
.empty { color: var(--muted); background: var(--bg-soft); border: 1px dashed var(--line-strong);
  border-radius: var(--radius); padding: 22px; text-align: center; }
/* 阅读进度与回到顶部 */
.progress { position: fixed; top: 0; left: 0; height: 3px; width: 0; background: var(--accent); z-index: 60; }
/* 回到顶部：圆形图标按钮，位置让开右侧目录栏（--rail-w 之外再留 12px），
   否则宽屏上它会压在目录条目上 */
.totop { position: fixed; right: calc(var(--rail-w) + 34px); bottom: 24px; z-index: 60;
  width: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink-soft);
  border-radius: 50%; cursor: pointer; opacity: 0; pointer-events: none;
  transition: opacity .18s ease; box-shadow: var(--shadow-md); }
.totop svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
@media (max-width: 900px) { .totop { right: 18px; } }
.reading.focus ~ .totop, .focus .totop { right: 24px; }
.totop.show { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) { .totop { transition: none; } }

/* 打印只留最朴素的兜底（用户明确说复习不靠打印） */

/* ── 阅读页三栏：左=本课程课次，中=正文，右=本页目录 ── */
.reading { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--rail-w); gap: 28px;
  max-width: 1320px; margin: 0 auto; padding: 24px 22px 96px; align-items: start; }
.reading .col { min-width: 0; max-width: none; }
.reading .rail { position: sticky; top: calc(var(--header-h) + 20px); align-self: start;
  max-height: calc(100vh - var(--header-h) - 40px); overflow-y: auto; }
.reading .rail-left { order: -1; }
.rail nav.toc { padding: 0; margin: 0; }
.rail nav.toc h2, .rail .rail-title { margin: 0 0 10px; padding: 0; font-size: 12px; letter-spacing: .14em;
  color: var(--muted); font-weight: 600; text-transform: uppercase; }
.rail nav.toc ol, .rail ol.lessons { list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 1.5; }
.rail ol.lessons li { margin: 0 0 2px; }
.rail ol.lessons a { display: block; padding: 5px 10px; border-radius: 8px; color: var(--ink-soft); }
.rail ol.lessons a:hover { background: var(--bg-soft); color: var(--ink); }
.rail ol.lessons a[aria-current="page"] { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
/* 专注模式：把两侧收起来，正文居中放宽 */
/* 专注模式：两栏 rail 一 display:none，正文就成了第一个网格项，会被塞进
   0 宽的第一列——表现是"所有文字被压成最左边一列"。所以专注模式直接换成单列。 */
.reading.focus { grid-template-columns: minmax(0, 1fr); gap: 0; }
.reading.focus .rail { display: none; }
.reading.focus .col { max-width: calc(var(--measure) + 8em); margin: 0 auto; }

/**
 * 窄屏（≤900px）：**目录在前、正文居中、课次导航在后**。
 *
 * 原来的顺序是"正文 → 课次导航 → 本页目录"：手机读者打开一节两万字的笔记，
 * 想跳到某一小节得先翻过整篇；而"本页目录"这个折叠块偏偏落在最底下。
 * 现在把右栏拆开（display:contents 让它的孩子直接参与网格排序）：
 *   本页目录(1) → 正文(2) → 课次导航与其余信息(3)。
 */
@media (max-width: 900px) {
  .reading, .reading.focus { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 20px 16px 84px; }
  .reading .rail { position: static; max-height: none; overflow: visible; }
  .reading .rail-right { display: contents; }
  .reading .rail-right .rail-toggle { order: 1; }
  .reading .rail-right .rail-desktop { display: none; }
  .reading .col { order: 2; }
  .reading .rail-left { order: 3; }
  .reading .rail-right .rail-extra { order: 4; }
  .rail nav.toc ol, .rail ol.lessons { max-height: none; overflow: visible; }
  /* 手机上手指点的目标：目录与课次链接至少 40px 高 */
  .rail nav.toc a, .rail ol.lessons a { display: block; padding: 10px; min-height: 40px; }
}

/* ── 顶栏工具栏：全部是图标，点开一个小窄框 ──
   放在顶栏这一排（而不是悬浮在正文右上角）：正文区域不该被浮层盖住，
   而顶栏本来就有位置，读者也习惯在那里找工具。 */
.tools { display: flex; gap: 2px; align-items: center; }
@media (max-width: 720px) { .tools { gap: 0; } .tools button, .tools a { width: 30px; height: 30px; } }
.tools button, .tools a { width: 32px; height: 32px; border-radius: 50%; border: 0; background: none; color: var(--ink-soft);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; position: relative;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
/* 小浮层的定位基准：少了这一条，浮层会以整条顶栏为基准，跑到屏幕另一头去 */
.tools .tool-wrap { position: relative; display: inline-flex; }
.tools button:hover, .tools a:hover { background: var(--bg-soft); color: var(--ink); }
.tools button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); }
.tools svg { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* 小浮层挂在按钮正下方：贴 right:0 会跑到屏幕最右边，和按钮对不上 */
.tools .pop { position: absolute; top: 38px; left: 50%; transform: translateX(-50%); min-width: 150px; padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--card-bg); box-shadow: var(--shadow-md); display: none; z-index: 70; }
.tools .open .pop { display: block; }
.tools .dot-row { display: flex; gap: 8px; }
.tools .paper { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-strong); cursor: pointer; padding: 0; }
.tools .paper[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 2px; }
.tools input[type="range"] { width: 130px; }
/* 当前是白天就显示太阳、夜间显示月亮：图标自己说状态，不用点开猜 */
:root[data-theme="dark"] .tools [data-tool="theme"] .icon-sun { display: none; }
:root:not([data-theme="dark"]) .tools [data-tool="theme"] .icon-moon { display: none; }
.tools .swatch { width: 13px; height: 13px; border-radius: 50%; border: 1px solid var(--line-strong); display: inline-block;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .5); }

/* ── 顶栏里的站点导航：阅读页收进一个下拉，和工具栏图标并排 ── */
.navmenu { position: relative; font-family: var(--sans); }
.navmenu > summary { list-style: none; cursor: pointer; width: 32px; height: 32px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center; color: var(--ink-soft); }
.navmenu > summary::-webkit-details-marker { display: none; }
.navmenu > summary:hover { background: var(--bg-soft); color: var(--ink); }
.navmenu svg { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; }
.navmenu[open] > summary { background: var(--accent-soft); color: var(--accent-ink); }
.navmenu .nav-pop { position: absolute; top: 38px; right: 0; display: flex; flex-direction: column; gap: 2px;
  min-width: 132px; padding: 6px; border-radius: 12px; border: 1px solid var(--line);
  background: var(--card-bg); box-shadow: var(--shadow-md); z-index: 50; }
.navmenu .nav-pop a { padding: 7px 10px; border-radius: 8px; font-size: 14px; color: var(--ink-soft); }
.navmenu .nav-pop a:hover { background: var(--bg-soft); color: var(--ink); }
/* 阅读设置下拉：与站点导航共用 .navmenu 的下拉样式，内容换成三个控件。
   非阅读页（首页 / 索引 / 地图 / 文档 / 搜索）顶栏没有工具栏图标，这三项就靠它。 */
.prefmenu .pref-pop { min-width: 168px; gap: 10px; padding: 10px 12px; }
.pref-pop [data-pref="theme"] { width: 100%; height: 30px; border: 0; border-radius: 8px; background: none;
  color: var(--ink-soft); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.pref-pop [data-pref="theme"]:hover { background: var(--bg-soft); color: var(--ink); }
.pref-pop [data-pref="theme"][aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); }
.pref-pop .dot-row { display: flex; gap: 8px; justify-content: space-between; }
.pref-pop .paper { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-strong); cursor: pointer; padding: 0; }
.pref-pop .paper[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 2px; }
.pref-pop input[type="range"] { width: 100%; }
/* 当前是白天显示太阳、夜间显示月亮：与工具栏那两个按钮同一套 class，规则各写一条 */
:root[data-theme="dark"] .pref-pop [data-pref="theme"] .icon-sun { display: none; }
:root:not([data-theme="dark"]) .pref-pop [data-pref="theme"] .icon-moon { display: none; }
/* 窄屏：顶栏那一排本来就挤，收紧间距免得把最右边的设置按钮挤出屏幕；
   下拉自身也要收在视口内（它靠右对齐在按钮下方，一旦按钮出屏下拉就跟着出屏） */
@media (max-width: 720px) {
  .topbar .inner { gap: 10px; padding: 0 12px; }
  .topbar .brand { font-size: 15px; }
  .topbar nav { gap: 10px; font-size: 12.5px; }
  .navmenu .nav-pop { max-width: calc(100vw - 24px); }
  .prefmenu .pref-pop { min-width: 0; width: min(170px, calc(100vw - 24px)); }
}
.tools .pop a { width: auto; height: auto; border-radius: 8px; padding: 6px 8px; justify-content: flex-start; gap: 8px; font-size: 13.5px; color: var(--ink-soft); }

/* ── 锚点高亮：跳过去闪一下，然后留着底色 ── */
/* 从索引跳进来时，落点要让人一眼看见：整行扫过一道底色 + 左侧竖条，再慢慢褪掉 */
.anchor-flash { animation: anchorFlash 2.6s ease-out 1; border-radius: 6px;
  box-shadow: inset 3px 0 0 0 var(--accent); padding-left: 10px; margin-left: -10px; }
@keyframes anchorFlash {
  0% { background: var(--accent-soft); box-shadow: inset 3px 0 0 0 var(--accent); }
  60% { background: var(--accent-soft); }
  100% { background: transparent; box-shadow: inset 3px 0 0 0 transparent; } }
.mark-hit { background: var(--accent-soft); border-radius: 4px; }

/* ── 划词批注 ── */
.annot { border-radius: 3px; padding: 0 1px; }
.annot-underline { background-image: linear-gradient(currentColor, currentColor); background-repeat: no-repeat;
  background-position: 0 100%; background-size: 100% 2px; padding-bottom: 1px; }
.annot-underline.animate { animation: drawLine .5s ease-out 1; }
@keyframes drawLine { from { background-size: 0 2px; } to { background-size: 100% 2px; } }
.annot-mark { background-image: linear-gradient(var(--mark), var(--mark)); background-repeat: no-repeat;
  background-size: 100% 100%; }
.annot-bold { font-weight: 700; }
.annot-bold.animate { animation: boldPulse .4s ease-out 1; }
@keyframes boldPulse { from { font-weight: 400; } to { font-weight: 700; } }
.annot-mark.animate { animation: sweep .55s ease-out 1; }
@keyframes sweep { from { background-size: 0 100%; } to { background-size: 100% 100%; } }
.selbar { position: absolute; z-index: 60; display: none; gap: 2px; padding: 4px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--card-bg); box-shadow: var(--shadow-md); }
.selbar.show { display: flex; }
.selbar button { width: 30px; height: 30px; border-radius: 8px; border: 0; background: none; color: var(--ink-soft); cursor: pointer; }
.selbar button:hover { background: var(--bg-soft); color: var(--ink); }
.selbar svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; }

${ONEPAGE_CSS}
@media print {
  .rail, .progress, .totop, .topbar { display: none; }
  .shell { display: block; max-width: none; padding: 0; }
  .col > * { max-width: none; }
  article { font-size: 11pt; }
}
`
// 文档模块要复用站点外壳，但不想反向依赖整站；这里把外壳交给它。
// 函数声明有提升，模块顶层就能拿到。
usePageShell(pageShell)

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
  const buckets = { concepts: [], statutes: [], cases: [], keywords: [] }
  // KEYWORD 是留给"模型自己挑关键词"的口子：写了就用它的判断，没写就按概念排序挑
  const kindOf = { CONCEPT: 'concepts', PROVISION: 'statutes', CASE: 'cases', KEYWORD: 'keywords' }
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

const CN_DIGITS = '零一二三四五六七八九'

/**
 * 阿拉伯数字条号转中文写法。
 *
 * 同一件事在笔记里有两种写法：元数据写"刑法第25条"，正文写"《刑法》第二十五条"。
 * 索引跳转要把两种写法对上，否则一半法条条目会退化成"点回笔记开头"。
 */
export function toArticleChinese(article = '') {
  const value = String(article || '').trim()
  if (!/^[0-9０-９]+$/.test(value)) return ''
  const n = Number(value.replace(/[０-９]/g, ch => String('０１２３４５６７８９'.indexOf(ch))))
  if (!Number.isFinite(n) || n <= 0 || n > 9999) return ''
  if (n < 10) return CN_DIGITS[n]
  if (n < 20) return `十${n % 10 ? CN_DIGITS[n % 10] : ''}`
  if (n < 100) return `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ''}`
  const base = n < 1000 ? [Math.floor(n / 100), 100, '百'] : [Math.floor(n / 1000), 1000, '千']
  const rest = n % base[1]
  const out = `${CN_DIGITS[base[0]]}${base[2]}`
  if (!rest) return out
  if (rest < 10) return `${out}零${CN_DIGITS[rest]}`
  return out + toArticleChinese(String(rest))
}

/**
 * 概念 / 法条 / 案例在正文里的落点。
 *
 * 索引页原来只能点回"这篇笔记的开头"，复习时还得自己在长文里再找一遍——等于没做。
 * 这里把正文按标题切段，术语第一次出现在哪一段，就记下那一段的标题锚点。
 * 元数据块本身（文末那份 META 清单）要排除：否则每个术语都会"命中"文末，
 * 锚点全部指向最后一节，反而指错地方。
 */
export function termAnchors(markdown = '') {
  const body = String(markdown ?? '')
  const metadata = extractNoteMetadata(body)
  // 只把那份 META 清单剔掉，别拿 details 当分界：笔记里还有"知识地图"这类
  // 正常的折叠块，按第一个 <details> 截断会把整篇正文都切掉（锚点于是全落到概览上）。
  const searchable = body.split('\n').filter(line => !/^\s*META:\s/.test(line)).join('\n')
  const sections = []
  let current = { id: '', level: 9, title: '', text: [] }
  for (const line of searchable.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (heading) {
      sections.push(current)
      current = { id: slugify(heading[2]), level: heading[1].length, title: heading[2], text: [] }
      continue
    }
    current.text.push(line)
  }
  sections.push(current)

  // 术语在笔记里常常写成简称、带注解或一串并列词，逐个放宽：
  // 全称 → 括号前的主干 → 拆出的实词 → 条号。宁可多试几个写法，也别让条目只能点回开头。
  const needlesOf = term => {
    const out = [term]
    const text = String(term)
    const stem = text.split(/[（(]/)[0].trim()
    if (stem && stem !== term) out.push(stem)
    const stripped = stem.replace(/[\s·・、，,；;：:\/／"'"'「」《》]/g, '')
    if (stripped && stripped !== stem) out.push(stripped)
    // "被害人身份与立功认定"这类并列术语：整串找不到时，用其中最长的一段去撞
    const pieces = stem.split(/[·・、，,；;：:\/／与和及]/).map(item => item.trim()).filter(item => item.length >= 3)
    for (const piece of pieces.sort((left, right) => right.length - left.length)) {
      if (piece !== stem) out.push(piece)
    }
    // 条号的两种写法都要试：元数据写"第25条"，正文里往往写"第二十五条"
    const article = parseStatute(term).article
    if (article) {
      out.push(`第${article}条`)
      const chinese = toArticleChinese(article)
      if (chinese && chinese !== article) out.push(`第${chinese}条`)
      const numeric = articleNumber(article)
      if (!/^[0-9０-９]+$/.test(article) && numeric < Number.MAX_SAFE_INTEGER) out.push(`第${numeric}条`)
    }
    return out
  }

  // "概览 / 核心问题 / 应当能够 / 知识连接"这些小节本身会罗列一大串术语，
  // 但那里不是讲它的地方：落点要落在真正展开讲的那一节，所以这些节只当兜底。
  const SUMMARY_SECTION = /概览|核心问题|应当能够|课程脉络|知识连接|附录|复习/
  const candidates = sections.filter(section => section.level > 1 && section.id)

  const anchors = { concepts: {}, statutes: {}, cases: {} }
  for (const [bucket, terms] of Object.entries(metadata)) {
    for (const term of terms) {
      const needles = needlesOf(term)
      // 标题里就写着这个术语的那一节最准
      const titleHit = candidates.find(section => section.title && needles.some(needle => section.title.includes(needle)))
      if (titleHit) {
        anchors[bucket][term] = titleHit.id
        continue
      }
      // 否则挑"提得最多"的那一节：术语在概览里出现一次、在正文某节出现五次，
      // 要跳的是后者。同分时优先非概览节，再优先靠前的。
      let best = null
      for (const section of candidates) {
        const text = section.text.join('\n')
        let count = 0
        for (const needle of needles) count += text.split(needle).length - 1
        if (!count) continue
        const summary = SUMMARY_SECTION.test(section.title || '') ? 1 : 0
        const better = !best || count > best.count || (count === best.count && summary < best.summary)
        if (better) best = { section, count, summary }
      }
      if (best) anchors[bucket][term] = best.section.id
    }
  }
  return anchors
}

/**
 * 派生物的出处字段：原样带进发布库（缺哪个就不带哪个，老数据不受影响）。
 *
 * 只挑这几个字段，不整份复制：brief.json / onepage.json 里还有 trace（模型调用记录），
 * 那是生成过程的账，不该塞进发布库。
 */
function bindingFields(artifact = {}) {
  const fields = {
    course: artifact.course,
    lesson: artifact.lesson,
    replayKey: artifact.replayKey,
    sourceChecksum: artifact.sourceChecksum,
    sourceChars: artifact.sourceChars,
    generatedAt: artifact.generatedAt
  }
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => [key, typeof value === 'number' ? value : String(value)]))
}

export function buildNoteRecord({
  courseName, teacher = '', lessonTitle, markdown, replayKey = '', source = 'course-worker',
  // 三个时间各管一件事（见 lesson-date.mjs）：publishedAt 一个字段扛四件事的老写法已经拆掉。
  // lessonDate 优先显式传入（--lesson-date），其次课次标题里的日期，再次账本里的 starts_at_text，
  // 再退到记录里已有的那一天，最后才是首次发布的日期（这种兜底会在记录里标注来源）。
  lessonDate = '', startsAtText = '', previousLessonDate = '',
  firstPublishedAt = new Date().toISOString(), updatedAt = '',
  brief = null, onepage = null
}) {
  const body = String(markdown ?? '')
  if (!body.trim()) throw new Error('笔记正文为空，不能发布')
  const slug = noteSlug({ courseName, lessonTitle })
  const briefing = String(brief?.briefing || '').trim()
  const published = String(firstPublishedAt || '') || new Date().toISOString()
  const resolved = resolveLessonDate({ explicit: lessonDate, lessonTitle, startsAtText, previousLessonDate, fallbackAt: published })
  return {
    slug,
    courseName: String(courseName || '').trim(),
    teacher: String(teacher || '').trim(),
    lessonTitle: String(lessonTitle || '').trim(),
    replayKey,
    source,
    lessonDate: resolved.lessonDate,
    // 来源要落盘：这样"这个日期是猜的"在记录里看得见，展示时不再临时猜
    lessonDateSource: resolved.lessonDateSource,
    firstPublishedAt: published,
    updatedAt: String(updatedAt || '') || published,
    // 简报：首页与笔记页顶部先用它给读者一个基本印象，再进入正文的细节。
    // 列表页也用它当摘要——比截断正文前 120 字有用得多。
    // 出处（course / lesson / sourceChecksum…）一并留在发布库里：这份简报是给哪一篇、
    // 哪一版正文生成的，是事后追查串课的唯一线索（tools/verify-library.mjs 就查它）。
    brief: briefing
      ? { briefing, keyPoints: (brief.keyPoints || []).filter(Boolean).slice(0, 5), ...bindingFields(brief) }
      : null,
    summary: briefing ? summarizeMarkdown(briefing) : summarizeMarkdown(body),
    headings: extractHeadings(body),
    // 阅读时长与结构化元数据都进索引：前者显示在页面上，后者供索引页与站内搜索使用
    readMinutes: estimateReadMinutes(body),
    metadata: extractNoteMetadata(body),
    // 索引页点进来要落在正文里那一节，而不是笔记开头
    anchors: termAnchors(body),
    // 首页表格里那列：主题句 + 关键词。首选写笔记时模型自己产出的（简报那一步顺手），
    // 老笔记没有这份判断时，退回到"从概念清单里按出现频次与标题命中排序"。
    theme: String(brief?.theme || '').trim(),
    // 一页纸摘要（course onepage 的产物）：有就带着，页面与首页入口都靠它
    onepage: onepage && String(onepage.markdown || '').trim()
      ? {
        title: String(onepage.title || '').trim(),
        markdown: String(onepage.markdown).trim(),
        chars: Number(onepage.chars || String(onepage.markdown).replace(/\s/g, '').length),
        ...bindingFields(onepage)
      }
      : null,
    ...keywordFields({
      brief,
      markdown: body,
      concepts: extractNoteMetadata(body).keywords.length ? extractNoteMetadata(body).keywords : extractNoteMetadata(body).concepts,
      courseName: String(courseName || '').trim()
    }),
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
// 绘图库 3.5MB，而我们这台机器到读者的路只有 100—250KB/s：**等读者真的展开知识地图再下载**。
// 折叠块没打开之前一个字节都不下，页面其余部分该多快就多快。
const blocks = [...document.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid')]
if (blocks.length) {
  const load = () => new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/assets/mermaid.min.js?v=${MERMAID_VERSION}'
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
  const start = () => load().then(() => {
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

  // 折叠块展开时才下载：没展开就是一个字节都不下
  const fold = blocks[0].closest('details')
  if (!fold || fold.open) start()
  else fold.addEventListener('toggle', function () { if (fold.open) start() })
}
</script>`

/**
 * 阅读偏好（深浅 / 底色 / 字号）。
 *
 * 用户的原话是「这个最好是全局适用，而不是点进一个笔记设置成夜间之后返回回去还是白天」，
 * 所以这段脚本放在**每一页**的外壳里，并且在样式之后立刻执行——先应用再绘制，
 * 否则深色用户每次翻页都要被闪一下白。
 */
const PREF_SCRIPT = '<script>' + [
  '(function () {',
  '  var root = document.documentElement',
  '  function read (key, fallback) { try { return localStorage.getItem(key) || fallback } catch (e) { return fallback } }',
  '  var theme = read("course.theme", "light")',
  '  var paper = read("course.paper", "")',
  '  var scale = parseFloat(read("course.fontScale", "1")) || 1',
  '  root.setAttribute("data-theme", theme === "dark" ? "dark" : "light")',
  '  if (paper && theme !== "dark") root.setAttribute("data-paper", paper); else root.removeAttribute("data-paper")',
  '  root.style.setProperty("--font-scale", String(Math.min(1.4, Math.max(0.85, scale))))',
  '})();',
  '</script>'].join('\n')
function pageShell({ title, description, body, canonical = '', scripts = '', layout = 'page', topRight = '' }) {
  const navLinks = [
    '<a href="/">全部课次</a>',
    '<a href="/map/">知识地图</a>',
    '<a href="/concepts/">概念索引</a>',
    '<a href="/statutes/">法条索引</a>',
    '<a href="/search/">搜索</a>'
  ].join('')
  // 阅读页顶栏要放工具栏，站点导航就收进一个下拉（读者在正文页最不需要的就是这四个链接）；
  // 其余页面照旧平铺，末尾挂一个「阅读设置」下拉——深浅/底色/字号在这几页以前完全没有入口。
  // 排序上它就是这一排的最后一项，也就是页面右上角。
  const navHtml = topRight
    ? `<details class="navmenu"><summary title="站点导航" aria-label="站点导航">${svgIcon('menu')}</summary>` +
      `<div class="nav-pop">${navLinks}</div></details>`
    : `<nav>${navLinks}</nav>` + settingsMenu()
  // 阅读页/一页纸页的这三个设置由工具栏图标排负责，不再挂第二个入口（否则一页上有两套同样的控件）
  const shellScripts = topRight ? scripts : [scripts, PREF_MENU_SCRIPT].filter(Boolean).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<link rel="alternate" type="application/rss+xml" title="课程笔记" href="/feed.xml">
<style>${SITE_CSS}</style>
${PREF_SCRIPT}
</head>
<body>
<header class="topbar"><div class="inner">
  <a class="brand" href="/">课程笔记</a>
  <span class="spacer"></span>
  ${topRight}
  ${navHtml}
</div></header>
${layout === 'shell' ? '<div class="shell">' : layout === 'reading' ? '<div class="reading" id="reading">'
    : layout === 'wide' ? '<div class="wrap wide">'
    : layout === 'onepage' ? '<div class="onepage">' : '<div class="wrap">'}
${body}
</div>
${shellScripts}
</body>
</html>
`
}

/** 笔记正文里是否真的有 Mermaid 图（没有就不加载 3.5MB 的绘图库）。 */
function hasMermaid(markdown = '') {
  return /```mermaid/.test(String(markdown))
}

/** 泛得没信息量的词：单拎出来当关键词等于没说。 */
const GENERIC_TERMS = new Set([
  '概念', '问题', '内容', '理论', '制度', '方法', '原则', '分析', '研究', '总结', '概述', '介绍',
  '其他', '相关', '基本', '一般', '主要', '特点', '意义', '作用', '关系', '区别', '比较', '案例',
  '法条', '要点', '重点', '难点', '背景', '现状', '发展', '影响', '评价', '讨论', '思考', '复习'
])

/**
 * 与课堂内容无关的杂项：开学第一节课的概念清单里常混着这些（教室、考核、助教……）。
 * 它们确实是那节课讲过的事，但放在"关键词"这一列毫无信息量——读者要的是这节课讲了什么。
 */
const ADMIN_TERMS = /教室|地点|课程安排|课程大纲|考核|签到|点名|考试|开卷|闭卷|助教|参考书目|教材|推荐书|选修|学分|作业|预习|上课|课间|通知|设备|教学网|知识库|回放|录制|时间安排|成绩|分组|自我介绍|课程介绍/

/**
 * 骨架型小节标题：它们说明的是"这一页长什么样"，不是"这节课讲了什么"。
 * 概念不够时用它兜底，就得把这些先剔掉，否则关键词会变成一串目录名。
 */
const STRUCTURE_HEADINGS = /核心问题|应当能够|课程脉络|概览|知识连接|附录|术语汇总|时间轴|课堂事务|课间|杂音|课程定位|课程性质|教师信息|学习方法|下节预告|承接/

/**
 * 关键词：从这篇笔记已有的概念清单里挑最重要的几个。
 *
 * 关键取舍：**不再拉一次模型调用**。每节课的概念本来就是模型在写作时按节点抽出来的
 * （task-runner 的 concepts → 文末 META 清单），再让它"挑 5 个"是花两份钱买同一件事。
 * 这里只做筛选与排序：
 *   排除课程名（"商法"之于《商法概论》）、泛词、行政杂项、以及过长的句子片段；
 *   然后按 标题里出现过 > 正文里反复出现 > 更具体 排序。
 * 概念实在太少时（有的课第一节只抽到一两条）退回到小节标题——标题同样说明这节课讲了什么。
 * 已发布的笔记重建时会重算，所以老笔记一样有效果。
 *
 * 若将来模型自己在 META 里写了 KEYWORD 行，那份判断优先——见 extractNoteMetadata。
 */
export function deriveKeywords(markdown = '', { concepts = [], courseName = '', limit = 6 } = {}) {
  const body = String(markdown ?? '').split('\n').filter(line => !/^\s*META:\s/.test(line)).join('\n')
  const headings = extractHeadings(body)
  const headingText = headings.map(heading => heading.text).join(' ')
  const course = String(courseName || '').trim()

  const countOf = needle => {
    if (!needle) return 0
    let count = 0
    let at = body.indexOf(needle)
    while (at >= 0) { count += 1; at = body.indexOf(needle, at + needle.length) }
    return count
  }

  /** 能不能当关键词：短、像术语、不是杂项。 */
  const usable = term => {
    const value = String(term || '').trim()
    if (value.length < 2 || value.length > 12) return ''
    if (/[：:，,。；;、！？\[\]（）()「」《》"'']/.test(value)) return ''
    // 整词是泛词，或者"去掉泛词后不剩什么"（法律制度、重点内容）——但
    // "犯罪记录封存制度"这类真术语要留下：它去掉"制度"还剩五个字
    let rest = value
    for (const word of GENERIC_TERMS) rest = rest.split(word).join('')
    if (rest.length < 3) return ''
    if (ADMIN_TERMS.test(value)) return ''
    if (course && (value === course || course.includes(value))) return ''
    return value
  }

  const ranked = new Map()
  for (const raw of concepts) {
    const term = usable(String(raw || '').split(/[（(]/)[0])
    if (!term) continue
    const entry = {
      term,
      occurrences: countOf(term),
      inHeading: headingText.includes(term),
      detail: Math.min(term.length, 8)
    }
    const previous = ranked.get(term)
    if (!previous || entry.occurrences > previous.occurrences) ranked.set(term, entry)
  }

  const list = [...ranked.values()].sort((a, b) =>
    Number(b.inHeading) - Number(a.inHeading) ||
    b.occurrences - a.occurrences ||
    b.detail - a.detail ||
    a.term.localeCompare(b.term, 'zh'))
  // 正文里一次都没提到的概念多半是顺手写上的，只在前面的词够用时排除
  const mentioned = list.filter(item => item.occurrences > 0)
  const chosen = (mentioned.length >= 3 ? mentioned : list).map(item => item.term)

  // 概念太少时（例如开学第一节课）用小节标题补：标题同样说明这节课讲了什么
  if (chosen.length < 3) {
    const fromHeadings = headings
      // 二级标题也算：概念一条都没有时（有的课第一节只抽到"教室安排"），
      // 话题名是唯一能说明这节课讲了什么的东西
      .filter(heading => !STRUCTURE_HEADINGS.test(String(heading.text || '')))
      .map(heading => usable(String(heading.text)
        .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.]?\s*/, '')
        .replace(/[★☆]+\s*$/, '')
        .split(/[：:]/)[0]
        .trim()))
      .filter(Boolean)
    for (const term of fromHeadings) {
      if (chosen.includes(term)) continue
      chosen.push(term)
      if (chosen.length >= limit) break
    }
  }

  return chosen.slice(0, limit)
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
  // 目录锚点与标题 id 的对应关系。**必须解码**：中文标题的 id 是原文（一-执行程序总论），
  // 而 a.hash 是百分号编码后的形式（%E4%B8%80-…），两者直接比较永远对不上——
  // 表现为"读了半天，目录里一条都不高亮，继续阅读的入口也永远不出现"。
  var links = new Map();
  document.querySelectorAll('.rail nav.toc a').forEach(function (a) {
    var id = fragmentId(a.getAttribute('href'))
    if (!id) return
    if (!links.has(id)) links.set(id, [])
    links.get(id).push(a)
  })
  function fragmentId (href) {
    var raw = String(href || '').replace(/^#/, '')
    try { return decodeURIComponent(raw) } catch (e) { return raw }
  }
  // 窄屏与宽屏各有一份目录（一份在折叠面板里），高亮要同时落到两份上
  var headings = [].slice.call(document.querySelectorAll('article h2[id], article h3[id], article h4[id]'));

  function setActive (id) {
    document.querySelectorAll('.rail nav.toc a.active').forEach(function (a) { a.classList.remove('active') })
    var next = links.get(id) || [];
    next.forEach(function (a) { a.classList.add('active') })
    // 窄屏那份目录在宽屏上是 display:none：拿它算位置会得到全 0 的矩形，
    // 结果 target 被夹到 0——表现就是"正文往下读，右侧目录反而被滚回顶部"。
    var visible = null;
    for (var i = 0; i < next.length; i += 1) {
      if (next[i].getBoundingClientRect().height > 0) { visible = next[i]; break }
    }
    followActive(visible || next[0])
  }

  /**
   * 目录跟着正文滚。
   *
   * 长笔记的目录条目比屏幕还多，当前小节一旦滚出目录可视区，读者就"不知道自己在哪"——
   * 高亮明明在动，但看不见等于没有。所以把目录栏自己也滚一下，让当前条目始终在视野里。
   * 只在偏离较远时才滚（否则每滚一点就抖一下）。
   */
  function followActive (link) {
    // 阅读页有两栏（左=课程课次、右=本页目录）：认"当前条目所在的那一栏"，
    // 否则会把左栏当成目录栏去滚，右栏的目录反而一直不动
    var rail = link && link.closest ? link.closest('.rail') : document.querySelector('.rail')
    if (!rail || !link) return
    if (rail.scrollHeight <= rail.clientHeight + 8) return
    var railTop = rail.getBoundingClientRect().top
    var linkTop = link.getBoundingClientRect().top - railTop + rail.scrollTop
    var target = Math.max(0, Math.min(linkTop - rail.clientHeight / 2 + link.offsetHeight / 2, rail.scrollHeight - rail.clientHeight))
    if (Math.abs(rail.scrollTop - target) > Math.max(24, link.offsetHeight * 1.5)) {
      rail.scrollTo({ top: target, behavior: 'smooth' })
    }
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

  // ── 阅读控制：字号、深色（顶栏工具栏）、位置记忆 ──
  var root = document.documentElement
  var POS_KEY = 'course.readPos:' + location.pathname

  // 字号与深浅由每页开头的预置脚本负责（先应用再绘制），顶栏工具栏再改它们，
  // 这里不再重复一份——两处开关容易各说各话。

  // 位置记忆：记住读到哪一小节，回来时给一个"继续"入口
  var resume = document.getElementById('resume')
  var saved = null
  try { saved = localStorage.getItem(POS_KEY) } catch (e) {}
  if (resume && saved && links.has(saved)) {
    var target = links.get(saved)[0]
    resume.hidden = false
    resume.textContent = '继续上次阅读：' + target.textContent
    resume.addEventListener('click', function () {
      var node = document.getElementById(saved)
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
  var lastSaved = ''
  setInterval(function () {
    var active = document.querySelector('.rail nav.toc a.active')
    if (!active) return
    var id = fragmentId(active.getAttribute('href'))
    if (!id || id === lastSaved) return
    lastSaved = id
    try { localStorage.setItem(POS_KEY, id) } catch (e) {}
  }, 1500)

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

export function renderNotePage(record, { siteOrigin = '', neighbours = {}, courseLessons = [] } = {}) {
  const headings = record.headings || []
  const tocList = headings.length
    ? `<ol>${headings.map(heading => `<li class="lv${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`).join('')}</ol>`
    : '<p class="search-hint">这篇笔记没有分节标题。</p>'
  const toc = `<nav class="toc" aria-label="本页目录"><h2>本页目录</h2>${tocList}</nav>`
  const readMinutes = record.readMinutes || estimateReadMinutes(record.markdown)
  const meta = [
    record.courseName ? `<a href="/courses/${escapeHtml(slugify(record.courseName))}/">${escapeHtml(record.courseName)}</a>` : '',
    record.teacher ? escapeHtml(record.teacher) : '',
    `约 ${readMinutes} 分钟`,
    // 这里写的是**这节课是哪天上的**（读者关心的），不是"哪天发布的"——
    // 旧课重新发布不该让页面上出现一个与课程内容无关的新日期。
    lessonDateOf(record) ? `${escapeHtml(lessonDateOf(record))} 课次` : ''
  ].filter(Boolean).join(' · ')

  const railExtra = [
    neighbours.previous ? `<div class="prevnext"><span>上一讲</span><a href="${escapeHtml(neighbours.previous.slug)}.html">${escapeHtml(neighbours.previous.lessonTitle)}</a></div>` : '',
    neighbours.next ? `<div class="prevnext"><span>下一讲</span><a href="${escapeHtml(neighbours.next.slug)}.html">${escapeHtml(neighbours.next.lessonTitle)}</a></div>` : ''
    // 字号 / 深浅 / 底色已经在顶栏工具栏里，这里不再重复一份
  ].filter(Boolean).join('')

  return pageShell({
    title: `${record.lessonTitle} · ${SITE_NAME}`,
    description: record.summary,
    canonical: siteOrigin ? `${siteOrigin}/${record.slug}` : '',
    layout: 'reading',
    // 工具（导出/复制/打印/专注/日夜/底色/字号）放顶栏，正文区右上角不再有浮层
    topRight: toolBar(record),
    scripts: [hasMermaid(record.markdown) ? MERMAID_LOADER : '', NOTE_SCRIPT, READER_SCRIPT].filter(Boolean).join('\n'),
    body: [
      '<div class="progress" id="progress"></div>',
      // 左：本课程全部课次（点着就能换课，不用回首页）
      '<aside class="rail rail-left">',
      courseNav(record, courseLessons),
      '</aside>',
      '<div class="col">',
      '<header class="site">',
      record.courseName ? `<div class="eyebrow">${escapeHtml(record.courseName)}</div>` : '',
      `<h1>${escapeHtml(record.lessonTitle)}</h1>`,
      meta ? `<div class="meta">${meta}</div>` : '',
      '</header>',
      '<article>',
      // 位置记忆：进来时给一个"继续上次阅读"的入口，点了才滚（自动滚会让人失去方位感）
      '<button class="resume" id="resume" type="button" hidden></button>',
      record.brief?.briefing ? renderBriefBlock(record.brief) : '',
      renderMarkdown(record.markdown),
      '</article>',
      '</div>',
      // 右：本页目录
      '<aside class="rail rail-right">',
      `<div class="rail-toggle"><details open><summary>本页目录</summary>${toc}</details></div>`,
      `<div class="rail-desktop">${toc}</div>`,
      railExtra ? `<div class="rail-extra">${railExtra}</div>` : '',
      '</aside>',
      `<button class="totop" id="totop" type="button" title="回到顶部" aria-label="回到顶部">${svgIcon('arrowUp')}</button>`,
      '<div class="selbar" id="selbar"></div>'
    ].filter(Boolean).join('\n')
  })
}

/**
 * 索引页：概念 / 法条 / 案例。
 *
 * "一条术语一行、两列排开"在两百多条时没法读：复习时真正要问的是
 * "这门课的哪一节讲了哪些概念"。所以按 **课程 → 课次** 切分，每条只是一个可点的词；
 * 点进去带 ?mark=，笔记页会把该术语在正文里标出来并滚到那一节。
 */
/**
 * 知识地图：把"哪几节课在讲同一批概念"画出来。
 *
 * 索引页解决的是"这门课这一节有哪些概念"，地图解决的是另一个问题：**哪些概念反复出现**。
 * 只有在一门课里出现两次以上的概念才进图——它们才是把这门课串起来的东西，
 * 全都画上去只会得到一团毛线。
 *
 * 图是客户端按需渲染的：绘图库 3.5MB，进页面就下载太贵；也只在选中某门课时画那一门。
 */
export function renderKnowledgeMapPage({ notes = [], siteOrigin = '' } = {}) {
  // 图里画三样东西：课次的先后、每节课的骨架（二级标题）、以及跨课次重复出现的概念。
  // 只画"反复出现的概念"是因为实测：224 个概念里只有 7 个跨了两节课——全都画上去，
  // 得到的不是知识图谱，而是一团毛线。
  const courses = new Map()
  for (const note of notes) {
    const course = note.courseName || '未分类'
    const terms = [...new Set((note.metadata?.concepts || []).map(term => String(term).trim()).filter(Boolean))]
    const sections = (note.headings || []).filter(heading => heading.level === 2 && heading.text)
      .map(heading => String(heading.text).trim()).filter(Boolean).slice(0, 6)
    if (!courses.has(course)) courses.set(course, [])
    courses.get(course).push({
      slug: note.slug,
      lessonTitle: note.lessonTitle,
      lessonDate: lessonDateOf(note),
      sections,
      terms
    })
  }

  const payload = JSON.stringify({
    courses: [...courses.entries()].map(([course, lessons]) => ({ course, lessons }))
  })

  const rail = [
    '<aside class="filter-rail" id="map-rail" data-kind="map">',
    [...courses.entries()].map(([course, lessons], index) =>
      `<button type="button" data-course="${escapeHtml(course)}" aria-pressed="${index === 0 ? 'true' : 'false'}">` +
      `${escapeHtml(course)}<span class="filter-count">${new Set(lessons.flatMap(lesson => lesson.terms)).size}</span></button>`
    ).join('\n'),
    '</aside>'
  ].join('\n')

  const body = [
    '<header class="site"><h1>知识地图</h1></header>',
    courses.size
      ? [
        '<div class="index-shell">',
        rail,
        '<div class="index-body">',
        '<div class="map-head"><h2 id="map-title"></h2><p class="map-legend">实线连接的是同一门课里出现过两次以上的概念</p></div>',
        '<div class="map-holder" id="map-holder"></div>',
        '<div class="map-fallback" id="map-fallback" hidden></div>',
        '</div></div>',
        `<script id="map-data" type="application/json">${payload}</script>`,
        MAP_SCRIPT
      ].join('\n')
      : '<div class="empty">还没有条目。</div>'
  ].join('\n')

  return pageShell({
    title: `知识地图 · ${SITE_NAME}`,
    description: '课程概念之间的关系',
    canonical: siteOrigin ? `${siteOrigin}/map/` : '',
    layout: 'wide',
    body
  })
}

/** 绘图库按需加载：只有真的画图时才下载那 3.5MB。 */
const MAP_SCRIPT = `<script type="module">
const data = JSON.parse(document.getElementById('map-data').textContent)
const holder = document.getElementById('map-holder')
const title = document.getElementById('map-title')
const fallback = document.getElementById('map-fallback')
const rail = document.getElementById('map-rail')
const MERMAID_VERSION = '${MERMAID_VERSION}'

function sourceFor (course) {
  const clean = value => String(value).replace(/["\\[\\](){}|]/g, '').slice(0, 28)
  const lessons = course.lessons.slice(0, 14)
  if (!lessons.length) return ''
  const counts = new Map()
  for (const lesson of lessons) {
    for (const term of new Set(lesson.terms)) counts.set(term, (counts.get(term) || 0) + 1)
  }
  const shared = [...counts.entries()].filter(pair => pair[1] > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, 20)
  const lines = ['graph LR']
  lessons.forEach(function (lesson, index) {
    lines.push('  L' + index + '["' + clean(lesson.lessonTitle) + '"]')
    // 课次先后：这节课接在下节课前面
    if (index) lines.push('  L' + (index - 1) + ' --> L' + index)
    ;(lesson.sections || []).forEach(function (section, at) {
      lines.push('  S' + index + '_' + at + '["' + clean(section) + '"]')
      lines.push('  L' + index + ' --> S' + index + '_' + at)
    })
  })
  shared.forEach(function (pair, index) {
    lines.push('  C' + index + '(["' + clean(pair[0]) + '"])')
  })
  lessons.forEach(function (lesson, lessonIndex) {
    shared.forEach(function (pair, termIndex) {
      if (lesson.terms.indexOf(pair[0]) >= 0) lines.push('  C' + termIndex + ' -.-> L' + lessonIndex)
    })
  })
  return lines.join('\\n')
}

async function loadMermaid () {
  if (window.mermaid) return window.mermaid
  await new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/assets/mermaid.min.js?v=' + MERMAID_VERSION
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
  window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' })
  return window.mermaid
}

async function draw (courseName) {
  const course = data.courses.find(item => item.course === courseName) || data.courses[0]
  if (!course) return
  title.textContent = course.course
  const source = sourceFor(course)
  holder.innerHTML = ''
  fallback.hidden = true
  const explain = () => {
    fallback.hidden = false
    fallback.innerHTML = '<p class="small muted">这门课里还没有跨课次重复出现的概念：每一节的概念都只在自己那节讲过。</p>'
  }
  if (!source) { explain(); return }
  try {
    const mermaid = await loadMermaid()
    const result = await mermaid.render('map-svg-' + Date.now(), source)
    holder.innerHTML = result.svg
  } catch (error) {
    explain()
  }
}

rail.addEventListener('click', event => {
  const button = event.target.closest('button[data-course]')
  if (!button) return
  rail.querySelectorAll('button[data-course]').forEach(node =>
    node.setAttribute('aria-pressed', node === button ? 'true' : 'false'))
  draw(button.getAttribute('data-course'))
})
draw(rail.querySelector('button[data-course]')?.getAttribute('data-course'))
</script>`

/**
 * 一页纸摘要页：/onepage/<课程>/<课次>.html
 *
 * 与笔记页共用顶栏工具（底色/打印/复制/字号），但正文换成一张 A4：
 * 左侧列同一课程的课次，点一下换一节的一页纸。
 */
export function renderOnepagePageHtml(record, { siteOrigin = '', courseLessons = [] } = {}) {
  const { body } = renderOnepagePage(record, { siteOrigin, courseLessons })
  return pageShell({
    title: `${record.onepage?.title || record.lessonTitle} · 一页纸 · ${SITE_NAME}`,
    description: record.summary || '',
    canonical: siteOrigin ? `${siteOrigin}/${onepageSlug(record.slug)}` : '',
    layout: 'onepage',
    // onepagePage 是页面类型标记：工具栏据此下载这一页纸而不是整篇笔记
    topRight: toolBar({ ...record, onepagePage: true }),
    // 顶栏工具（底色/打印/复制/字号）的交互在阅读页脚本里：不带上它，这一排按钮就是死的
    scripts: READER_SCRIPT,
    body
  })
}

/** notes/<课程>/<课次> → onepage/<课程>/<课次>：同一套目录结构，两套页面。 */
export function onepageSlug(slug = '') {
  return String(slug).replace(/^notes\//, 'onepage/')
}

export function renderTermIndexPage({ title, description, kind, notes = [], siteOrigin = '' } = {}) {
  const kindOf = { concepts: 'concepts', statutes: 'statutes', cases: 'cases' }
  const bucket = kindOf[kind] || 'concepts'

  // 课次 → 术语。同一术语出现在两节课里就出现两次：这正是"跨课次"的线索。
  const courses = new Map()
  for (const note of notes) {
    const course = note.courseName || '未分类'
    const terms = []
    for (const value of (note.metadata?.[bucket] || [])) {
      const term = String(value).trim()
      if (term && !terms.includes(term)) terms.push(term)
    }
    if (!terms.length) continue
    if (!courses.has(course)) courses.set(course, [])
    courses.get(course).push({ note, terms })
  }

  // 每条术语出现在几节课里：跨课次的词是复习时最该先看的，单独标出来。
  // 这里数的是**课次**不是课程——原先按课程计数，同一门课里跨了两节的词反而标不出来。
  const spread = new Map()
  for (const lessons of courses.values()) {
    for (const lesson of lessons) {
      for (const term of new Set(lesson.terms)) spread.set(term, (spread.get(term) || 0) + 1)
    }
  }

  const chipOf = (note, term) => {
    const anchor = ((note.anchors && note.anchors[bucket]) || {})[term] || ''
    const href = `/${escapeHtml(note.slug)}.html?mark=${encodeURIComponent(term)}` + (anchor ? `#${escapeHtml(anchor)}` : '')
    const shared = (spread.get(term) || 0) > 1
    return `<a class="chip${shared ? ' chip-shared' : ''}" href="${href}"${shared ? ' title="不止一节课讲过"' : ''}>${escapeHtml(term)}</a>`
  }

  const sections = [...courses.entries()].map(([course, lessons]) => [
    `<section class="term-course" data-course="${escapeHtml(course)}">`,
    `<h2>${escapeHtml(course)}</h2>`,
    lessons.map(lesson => [
      '<div class="term-group">',
      `<h3><a href="/${escapeHtml(lesson.note.slug)}.html">${escapeHtml(lesson.note.lessonTitle)}</a>` +
        `<span class="term-count">${lesson.terms.length}</span></h3>`,
      '<div class="chips">',
      lesson.terms.map(term => chipOf(lesson.note, term)).join(''),
      '</div></div>'
    ].join('\n')).join('\n'),
    '</section>'
  ].join('\n')).join('\n')

  const totalTerms = new Set([...courses.values()].flatMap(lessons => lessons.flatMap(lesson => lesson.terms))).size
  const rail = [
    `<aside class="filter-rail" id="filter-rail" data-kind="${bucket}">`,
    `<button type="button" data-course="" aria-pressed="true">全部<span class="filter-count">${totalTerms}</span></button>`,
    [...courses.entries()].map(([course, lessons]) =>
      `<button type="button" data-course="${escapeHtml(course)}" aria-pressed="false">${escapeHtml(course)}` +
      `<span class="filter-count">${new Set(lessons.flatMap(lesson => lesson.terms)).size}</span></button>`
    ).join('\n'),
    '</aside>'
  ].join('\n')

  const body = [
    `<header class="site"><h1>${escapeHtml(title)}</h1></header>`,
    totalTerms
      ? ['<div class="index-shell">', rail, '<div class="index-body">', sections, '</div></div>', INDEX_FILTER_SCRIPT].join('\n')
      : '<div class="empty">还没有条目。</div>'
  ].join('\n')

  return pageShell({
    title: `${title} · ${SITE_NAME}`,
    description,
    canonical: siteOrigin ? `${siteOrigin}/${kind}/` : '',
    layout: 'wide',
    body
  })
}

/** 首页的课程过滤：与索引页同一套交互（点一下只看这门课，选择记在本地）。 */
const HOME_SCRIPT = `<script>
(function () {
  var rail = document.getElementById('course-rail');
  var body = document.getElementById('course-body');
  if (!rail || !body) return;
  var key = 'course.homeFilter';
  var saved = '';
  try { saved = localStorage.getItem(key) || '' } catch (e) { saved = '' }

  function apply (course) {
    var buttons = rail.querySelectorAll('button[data-course]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-course') === course ? 'true' : 'false');
    }
    var bands = body.querySelectorAll('.band');
    for (var j = 0; j < bands.length; j += 1) {
      bands[j].hidden = !!course && bands[j].getAttribute('data-course') !== course;
    }
    try { localStorage.setItem(key, course) } catch (e) {}
  }

  rail.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button[data-course]') : null;
    if (button) apply(button.getAttribute('data-course') || '');
  });
  if (saved) apply(saved);
})();
</script>`

/**
 * 课程过滤：一学期几十个概念，不过滤就只是一张更长的清单。
 *
 * 纯客户端做：条目全在页面里，切换只是显示与隐藏，点了立刻有反应，也不多发请求。
 * 选择记在本地，下次打开还是上次那门课。
 */
const INDEX_FILTER_SCRIPT = `<script>
(function () {
  var rail = document.getElementById('filter-rail');
  if (!rail) return;
  var key = 'course.termFilter:' + (rail.getAttribute('data-kind') || '');
  var saved = '';
  try { saved = localStorage.getItem(key) || '' } catch (e) { saved = '' }

  function apply (course) {
    var buttons = rail.querySelectorAll('button[data-course]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-course') === course ? 'true' : 'false');
    }
    var sections = document.querySelectorAll('.term-course');
    for (var j = 0; j < sections.length; j += 1) {
      sections[j].hidden = !!course && sections[j].getAttribute('data-course') !== course;
    }
    try { localStorage.setItem(key, course) } catch (e) {}
  }

  rail.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button[data-course]') : null;
    if (button) apply(button.getAttribute('data-course') || '');
  });
  if (saved) apply(saved);
})();
</script>`

/**
 * 公开索引里允许出现的字段（/api/notes 与 notes.json 共用）。
 *
 * 白名单而不是黑名单：发布库是内部数据结构，往里加字段的人不会想到"它会不会被公网看到"。
 * 要新增公开字段，就在这份列表里加一条——这是一次有意识的决定，而不是一次顺手的展开。
 */
export function publicIndexFields(record = {}) {
  return {
    slug: record.slug,
    courseName: record.courseName || '',
    teacher: record.teacher || '',
    lessonTitle: record.lessonTitle || '',
    lessonDate: record.lessonDate || '',
    firstPublishedAt: record.firstPublishedAt || '',
    updatedAt: record.updatedAt || '',
    theme: record.theme || '',
    keywords: record.keywords || [],
    keywordsSource: record.keywordsSource || '',
    summary: record.summary || '',
    brief: record.brief ? { briefing: record.brief.briefing || '', keyPoints: record.brief.keyPoints || [] } : null,
    readMinutes: record.readMinutes || 0,
    chars: String(record.markdown || '').length,
    headings: record.headings || [],
    metadata: record.metadata || { concepts: [], statutes: [], cases: [], keywords: [] },
    anchors: record.anchors || {},
    onepage: record.onepage ? { title: record.onepage.title || '', chars: record.onepage.chars || 0 } : null
  }
}

/** 站内搜索页：纯客户端，索引就是 notes.json（不含正文，体积可控）。 */
export function renderSearchPage({ siteOrigin = '' } = {}) {
  const body = [
    '<header class="site">',
    '<h1>搜索笔记</h1>',
    '</header>',
    // 无障碍：只靠 placeholder 的输入框对读屏软件等于没有名字；检索状态要能被播报
    '<label class="sr-only" for="q">检索全部课程笔记</label>',
    '<input class="search" id="q" type="search" placeholder="例如：众数、第 25 条、抽样、共犯" autocomplete="off" aria-describedby="hint">',
    '<div class="search-hint" id="hint" role="status" aria-live="polite"></div>',
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
/**
 * 搜索脚本：只负责展示，检索在服务端做（/api/search）。
 *
 * 为什么不再在浏览器里算：以前这里自己算 bigram 覆盖度——没有 IDF，泛词会把专名压下去，
 * 多词查询与整句问句也处理不了，而且浏览器里只有元数据、搜不了正文。
 * 现在页面把查询交给服务端，服务端用的是**与 MCP 完全相同的那套检索**：
 * 同一个服务实例、同一个打分。同一句话在页面上和在 AI 那边给出同一批结果，人才知道该信哪个。
 */
const SEARCH_SCRIPT = `<script>
(function () {
  var input = document.getElementById('q');
  var results = document.getElementById('results');
  var hint = document.getElementById('hint');
  var timer = null;
  var controller = null;
  var seq = 0;

  function esc (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] }) }

  function card (hit) {
    var meta = [hit.courseName, hit.lessonDate, hit.section].filter(Boolean)
      .map(function (text) { return '<span>' + esc(text) + '</span>' }).join('');
    var snippets = (hit.snippets || []).slice(0, 2)
      .map(function (text) { return '<p>' + esc(text) + '</p>' }).join('');
    var keywords = (hit.keywords || []).slice(0, 6).join('、');
    return '<a class="card" href="' + esc(hit.anchor || hit.url) + '">' +
      '<h3>' + esc(hit.lessonTitle) + '</h3>' +
      (hit.theme ? '<p>' + esc(hit.theme) + '</p>' : '') +
      '<div class="card-meta">' + meta + '</div>' +
      snippets +
      (keywords ? '<div class="card-meta"><span>' + esc(keywords) + '</span></div>' : '') +
      '</a>';
  }

  function show (message) { hint.textContent = message || '' }

  function sync (text) {
    try { history.replaceState(null, '', text ? '/search/?q=' + encodeURIComponent(text) : '/search/') } catch (error) {}
  }

  function run (value) {
    var text = String(value || '').trim();
    sync(text);
    if (!text) { results.innerHTML = ''; show(''); return }
    var mine = (seq += 1);
    if (controller) controller.abort();
    controller = new AbortController();
    show('检索中…');
    fetch('/api/search?q=' + encodeURIComponent(text) + '&limit=20', { signal: controller.signal })
      .then(function (response) { return response.json() })
      .then(function (data) {
        if (mine !== seq) return;
        if (!data.ok) { results.innerHTML = ''; show(data.message || '检索失败。'); return }
        var hits = data.hits || [];
        if (!hits.length) {
          results.innerHTML = '';
          show('没有找到。换个更具体的术语、法条或人名试试（问句里的疑问词会被自动去掉）。');
          return;
        }
        var notes = [];
        if (data.fuzzy && data.fuzzy.length) {
          notes.push('按近似词检索：' + data.fuzzy.map(function (item) { return item.from + '→' + item.to }).join('、'));
        }
        if (data.bodyScanned) notes.push('本次连正文一起检索');
        show(hits.length + ' 条命中' + (notes.length ? '（' + notes.join('；') + '）' : ''));
        results.innerHTML = hits.map(card).join('');
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return;
        if (mine !== seq) return;
        results.innerHTML = '';
        show('检索服务暂时不可用，稍后再试。');
      });
  }

  function schedule (value) { clearTimeout(timer); timer = setTimeout(function () { run(value) }, 160) }

  var initial = new URLSearchParams(location.search).get('q');
  if (initial) { input.value = initial; run(initial) }

  input.addEventListener('input', function () { schedule(input.value) });
  document.addEventListener('keydown', function (event) {
    if (event.key === '/' && document.activeElement !== input) { event.preventDefault(); input.focus() }
    if (event.key === 'Escape' && document.activeElement === input) { input.value = ''; run('') }
  });
})();
</script>`

export function renderIndexPage(records, { siteOrigin = '' } = {}) {
  const groups = new Map()
  // "最新"= 最近上过的一节课（lessonDate），不是最近发布过一次的笔记
  for (const record of [...records].sort(compareLessonDescending)) {
    const key = record.courseName || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }

  // 表格：一行一节课，列是 课次 | 关键词 | 时长 | 日期。关键词是「这节课讲了什么」的最短
  // 表达——写笔记时由模型顺手挑出来的那五六个词，没有它这一页就只是一串标题。
  const courses = [...groups.keys()]
  const rail = [
    '<aside class="filter-rail" id="course-rail" data-kind="home">',
    `<button type="button" data-course="" aria-pressed="true">全部<span class="filter-count">${records.length}</span></button>`,
    courses.map(course =>
      `<button type="button" data-course="${escapeHtml(course)}" aria-pressed="false">${escapeHtml(course)}<span class="filter-count">${groups.get(course).length}</span></button>`
    ).join('\n'),
    '</aside>'
  ].join('\n')

  /** 每门课表格的第一行：这门课的一页纸摘要（从最新一节的开始看）。 */
  const onepageRowOf = (course, items) => {
    const withOnepage = items.filter(item => item.onepage?.markdown)
    if (!withOnepage.length) return ''
    const newest = withOnepage[0]
    return [
      '<tr class="onepage-row">',
      `<td class="lesson-title"><a href="/${escapeHtml(onepageSlug(newest.slug))}.html">一页纸摘要</a></td>`,
      // 这一格只说清"这门课有几节配了一页纸"。原来那句排版说明与总字数是在解释
      // 我们自己怎么排的，读者要的是入口，不是说明书。
      `<td class="lesson-keywords" colspan="3"><span class="kw">共 ${withOnepage.length} 节</span></td>`,
      '</tr>'
    ].join('')
  }

  const rowOf = record => [
    '<tr>',
    `<td class="lesson-title"><a href="${escapeHtml(record.slug)}.html">${escapeHtml(record.lessonTitle)}</a>` +
      `${record.onepage ? ` <a class="onepage-link" href="/${escapeHtml(onepageSlug(record.slug))}.html" title="一页纸摘要" aria-label="一页纸摘要">${svgIcon('sheet')}</a>` : ''}</td>`,
    `<td class="lesson-keywords">${record.theme ? `<span class="lesson-theme">${escapeHtml(record.theme)}</span>` : ''}${(record.keywords || []).map(term => `<span class="kw">${escapeHtml(term)}</span>`).join('')}</td>`,
    record.readMinutes ? `<td class="lesson-meta">约 ${record.readMinutes} 分钟</td>` : '<td class="lesson-meta"></td>',
    lessonDateOf(record) ? `<td class="lesson-date">${escapeHtml(lessonDateOf(record))}</td>` : '<td class="lesson-date"></td>',
    '</tr>'
  ].join('')

  const body = [
    '<div class="index-shell">',
    rail,
    '<div class="index-body" id="course-body">',
    records.length
      ? [...groups.entries()].map(([course, items]) => [
        `<section class="band" data-course="${escapeHtml(course)}">`,
        `<h2>${escapeHtml(course)}</h2>`,
        '<table class="lesson-table"><thead><tr><th>课次</th><th>关键词</th><th class="num">时长</th><th class="num">日期</th></tr></thead><tbody>',
        // 第一行就是这门课的一页纸入口：复习时先看这一页，再决定翻不翻原文
        onepageRowOf(course, items),
        items.map(rowOf).join('\n'),
        '</tbody></table>',
        '</section>'
      ].join('\n')).join('\n')
      : '<div class="empty">还没有已发布的笔记。</div>',
    '</div></div>',
    HOME_SCRIPT
  ].filter(Boolean).join('\n')

  return pageShell({
    title: SITE_NAME,
    description: '北大法学课程笔记',
    canonical: siteOrigin || '',
    layout: 'wide',
    body
  })
}

/**
 * 写出整个站点。
 *
 * 每次都是全量重写：笔记数量以百计，全量写比增量同步简单得多，也不会出现
 * "删掉的笔记还挂在索引里"这类状态漂移。返回写入的文件清单便于核对。
 */
/**
 * RSS：有新笔记时不用自己来刷。
 *
 * 个人站点最容易做、也最实用的一项"推送之外的推送"——它不需要任何第三方服务，
 * 读者（包括未来的自己）用任意阅读器订阅即可。只输出摘要，正文留在站上。
 */
export function renderFeed(records = [], { siteOrigin = '', siteName = SITE_NAME, now = new Date() } = {}) {
  const base = String(siteOrigin || '').replace(/\/+$/, '')
  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const items = [...records]
    // 订阅器里"新"的判据是**首次进站时间**：重新发布一节旧课不该让它跳回列表顶部
    .sort(compareFirstPublishedDescending)
    .slice(0, 50)
    .map(record => [
      '    <item>',
      `      <title>${esc(`${record.courseName ? `${record.courseName} · ` : ''}${record.lessonTitle}`)}</title>`,
      `      <link>${esc(`${base}/${record.slug}.html`)}</link>`,
      `      <guid isPermaLink="true">${esc(`${base}/${record.slug}.html`)}</guid>`,
      `      <pubDate>${new Date(firstPublishedAtOf(record) || now).toUTCString()}</pubDate>`,
      `      <description>${esc(record.summary || '')}</description>`,
      '    </item>'
    ].join('\n')).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${esc(siteName)}</title>`,
    `    <link>${esc(base)}/</link>`,
    `    <description>北大法学课程笔记</description>`,
    `    <lastBuildDate>${now.toUTCString()}</lastBuildDate>`,
    items,
    '  </channel>',
    '</rss>',
    ''
  ].filter(Boolean).join('\n')
}

/**
 * 重新推导记录的派生字段。
 *
 * 发布库里存的是发布那一刻算好的记录；后来给页面加了新东西（比如"索引条目落到哪一节"），
 * --rebuild 只读发布库，不重跑模型——那就得在这里把派生字段按正文重算一遍，
 * 否则模板改了、字段加了，重建出来的站点却还是老的。
 */
/** 关键词的两个字段：词本身，以及它是谁挑的（模型挑的下次重建不能被排序结果覆盖）。 */
export function keywordFields({ brief = null, markdown = '', concepts = [], courseName = '', limit = 6 } = {}) {
  const chosen = (Array.isArray(brief?.keywords) ? brief.keywords : [])
    .map(term => String(term || '').trim()).filter(Boolean).slice(0, limit)
  if (chosen.length) return { keywords: chosen, keywordsSource: 'brief' }
  return { keywords: deriveKeywords(markdown, { concepts, courseName, limit }), keywordsSource: 'ranked' }
}

/**
 * 把老记录的时间字段迁移成 lessonDate / firstPublishedAt / updatedAt 三元组。
 *
 * 旧发布库里只有 publishedAt 一个字段（既当课次日期、又当发布时间）。读进来时：
 *   firstPublishedAt ← publishedAt（那确实是它第一次进站的时间）
 *   updatedAt        ← publishedAt
 *   lessonDate       ← 课次标题里的日期 → 已有值 → publishedAt 的日期
 * 迁移是幂等的，而且**只在记录里没有这些字段时**才推导：已经落盘的 lessonDate
 * 不再被重算，否则一次 --rebuild 就会把补写过的日期改回去。
 * 迁移后不再保留 publishedAt——它一个字段扛四件事正是这次要拆掉的东西。
 */
export function migrateRecordTime(record = {}) {
  const { publishedAt, ...rest } = record
  const firstPublishedAt = String(rest.firstPublishedAt || '') || String(publishedAt || '')
  const updatedAt = String(rest.updatedAt || '') || firstPublishedAt
  const stored = String(rest.lessonDate || '')
  const resolved = stored
    ? { lessonDate: stored, lessonDateSource: rest.lessonDateSource || 'stored' }
    : resolveLessonDate({ lessonTitle: rest.lessonTitle, startsAtText: rest.startsAtText, fallbackAt: firstPublishedAt })
  return {
    ...rest,
    lessonDate: resolved.lessonDate,
    lessonDateSource: resolved.lessonDateSource,
    firstPublishedAt,
    updatedAt
  }
}

export function refreshRecord(record = {}) {
  const withTime = migrateRecordTime(record)
  const markdown = String(withTime.markdown ?? '')
  if (!markdown.trim()) return withTime
  return {
    ...withTime,
    headings: extractHeadings(markdown),
    onepage: record.onepage || null,
    readMinutes: record.readMinutes || estimateReadMinutes(markdown),
    metadata: extractNoteMetadata(markdown),
    anchors: termAnchors(markdown),
    // 模型挑过的关键词是判断，不是可重算的派生值——重建时原样保留
    ...(record.keywordsSource === 'brief' && record.keywords?.length
      ? { keywords: record.keywords, keywordsSource: 'brief' }
      : keywordFields({
        markdown,
        concepts: (record.metadata?.keywords?.length ? record.metadata.keywords : (record.metadata?.concepts || [])),
        courseName: record.courseName || ''
      }))
  }
}

/** 文档页：markdown 由仓库里的 docs/public/*.md 提供，发布时渲染成页面与 .md 两份。 */
export function writeDocs({ outputDir, siteOrigin = '', pages = [] } = {}) {
  const root = path.resolve(outputDir)
  const written = []
  for (const page of pages) {
    const pathName = String(page.pathName || '').replace(/^\/+|\/+$/g, '')
    if (!pathName) continue
    const html = renderDocPage({ ...page, siteOrigin, pathName })
    const htmlPath = path.join(root, pathName, 'index.html')
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
    fs.writeFileSync(htmlPath, html)
    written.push(`${pathName}/index.html`)
    // 原文同时落盘：AI 取 /<path>.md 比解析 HTML 省事得多
    fs.writeFileSync(path.join(root, `${pathName}.md`), `${String(page.markdown || '').trim()}\n`)
    written.push(`${pathName}.md`)
  }
  return written
}

export function writeSite({ records = [], outputDir, siteOrigin = '', docs = [] } = {}) {
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

  // 全量重写时顺手把派生字段按正文重算：模板与解析规则改了，重建出来的站点才是新的
  const sorted = records.map(refreshRecord)
    .sort(compareLessonDescending)

  // 上一讲 / 下一讲：同一门课内按**上课日期**排序后的相邻两篇
  const neighboursOf = record => {
    const sameCourse = sorted.filter(item => item.courseName === record.courseName)
      .sort(compareLessonAscending)
    const at = sameCourse.findIndex(item => item.slug === record.slug)
    return { previous: at > 0 ? sameCourse[at - 1] : null, next: at >= 0 && at < sameCourse.length - 1 ? sameCourse[at + 1] : null }
  }

  // 同一门课的全部课次：阅读页左栏要列出来（点着就能换课）。
  // 带上一页纸有没有、多少字——一页纸页面的左栏会顺带标出来。
  const lessonsOfCourse = record => sorted
    .filter(item => item.courseName === record.courseName)
    .sort(compareLessonAscending)
    .map(item => ({
      slug: item.slug,
      lessonTitle: item.lessonTitle,
      chars: item.onepage?.chars || 0
    }))

  write('index.html', renderIndexPage(sorted, { siteOrigin }))
  for (const record of sorted) {
    write(`${record.slug}.html`, renderNotePage(record, {
      siteOrigin,
      neighbours: neighboursOf(record),
      courseLessons: lessonsOfCourse(record)
    }))
    // 同时写出一份 Markdown：页面上的「下载 / 复制 Markdown」直接取它，
    // 正文全文就不必再内嵌进 HTML（那会让每页翻一倍）。
    // 路径必须带课程：只按课次命名的话，两门课同一天同名课次会互相覆盖
    // （后发布的那节把先发布的正文顶掉）。唯一实现见 markdown-path.mjs。
    write(markdownPath(record), `${record.markdown || ''}\n`)
    // 一页纸：有就写出来（没有的课次不占位，页面上的入口只在有时出现）
    if (record.onepage?.markdown) {
      write(`${onepageSlug(record.slug)}.html`, renderOnepagePageHtml(record, {
        siteOrigin,
        courseLessons: lessonsOfCourse(record)
      }))
      write(onePageMarkdownPath(record), `${record.onepage.markdown || ''}\n`)
    }
  }

  // 索引页与搜索页：数据全部来自各篇笔记的元数据块，不重新跑模型
  write('concepts/index.html', renderTermIndexPage({
    title: '概念索引', kind: 'concepts', notes: sorted, siteOrigin,
    description: '概念索引'
  }))
  write('statutes/index.html', renderTermIndexPage({
    title: '法条索引', kind: 'statutes', notes: sorted, siteOrigin,
    description: '按法律名与条号排列，显示每个条号在哪几节课出现过。'
  }))
  write('cases/index.html', renderTermIndexPage({
    title: '案例索引', kind: 'cases', notes: sorted, siteOrigin,
    description: '课堂上讲过的案例，以及它出现在哪些课次。'
  }))
  write('map/index.html', renderKnowledgeMapPage({ notes: sorted, siteOrigin }))
  // 文档页与 llms.txt：AI 的第一站。文档内容来自仓库里的 docs/public/*.md
  for (const relative of writeDocs({ outputDir: root, siteOrigin, pages: docs })) written.push(relative)
  write('llms.txt', renderLlmsTxt({ records: sorted, siteOrigin, pages: docs }))
  write('search/index.html', renderSearchPage({ siteOrigin }))
  write('feed.xml', renderFeed(sorted, { siteOrigin }))
  write('notes.json', `${JSON.stringify({
    siteName: SITE_NAME,
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    // 公开索引**只列出明确允许的字段**（白名单），不再用 { markdown, ...rest } 那种写法：
    // 发布库记录里以后再加什么内部字段（派生物指纹、重放键、抓取元数据），
    // 都会因为"顺手展开"而自动出现在公网索引里。chars 是日报与列表页要显示的"多少字"。
    notes: sorted.map(record => publicIndexFields(record))
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