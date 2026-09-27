import fs from 'node:fs'
import path from 'node:path'

import { escapeHtml, extractHeadings, renderMarkdown, slugify, summarizeMarkdown } from './markdown.mjs'
import { READER_SCRIPT, courseNav, toolBar } from './reader.mjs'

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
/* 阅读控制：字号 / 主题 / 继续上次阅读。放在左栏底部，不抢正文注意力 */
.rail-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.rail-controls button { font: inherit; font-size: 13px; padding: 4px 9px; border-radius: 8px;
  border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink-soft); cursor: pointer; }
.rail-controls button:hover { border-color: var(--accent); color: var(--accent-ink); }
.resume { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 20px; padding: 8px 14px;
  border-radius: 999px; background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent-ink);
  font-family: var(--sans); font-size: 14px; cursor: pointer; }
.resume:hover { border-color: var(--accent); }
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
.index-list { margin-top: 8px; }
.index-row { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px;
  padding: 14px 0; border-bottom: 1px solid var(--line); align-items: start; }
.index-term { font-weight: 600; color: var(--ink); }
.index-article { margin-left: 8px; font-weight: 400; font-size: 13px; color: var(--muted); }
.index-notes { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 14px; }
.index-notes a { color: var(--ink-soft); border-bottom: 1px solid var(--line); }
.index-notes a:hover { color: var(--accent-ink); border-bottom-color: var(--accent); }
/* ── 索引页：左边挑课程，右边条目一次列到底（不折叠） ── */
.index-shell { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 30px; align-items: start; }
.filter-rail { position: sticky; top: calc(var(--header-h) + 20px); display: flex; flex-direction: column; gap: 2px;
  font-family: var(--sans); }
.filter-rail button { display: flex; justify-content: space-between; gap: 10px; font: inherit; font-size: 14px;
  padding: 7px 10px; border: 0; border-radius: 8px; background: none; color: var(--ink-soft); cursor: pointer; text-align: left; }
.filter-rail button:hover { background: var(--bg-soft); color: var(--ink); }
.filter-rail button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
.filter-rail .filter-count { color: var(--muted); font-size: 12.5px; }
.index-group { margin-bottom: 28px; }
.index-group > h2 { font-size: 16px; margin: 0 0 2px; color: var(--ink-soft); }
.index-row[hidden], .index-group[hidden], .index-notes a[hidden] { display: none; }

/* ── 首页：一门课一行，课次横向排开 ── */
.band { border-top: 1px solid var(--line); padding: 22px 0 18px; }
.band-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.band-head h2 { margin: 0; padding: 0; border: 0; font-size: 18px; text-transform: none; letter-spacing: -.01em; color: var(--ink); }
.strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(228px, 264px); gap: 14px;
  overflow-x: auto; padding: 2px 2px 12px; scroll-snap-type: x proximity; }
.strip .card { margin: 0; scroll-snap-align: start; display: flex; flex-direction: column; height: 212px; }
.strip .card p { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.strip .card .card-meta { margin-top: auto; padding-top: 10px; }
@media (max-width: 720px) {
  .index-row { grid-template-columns: minmax(0, 1fr); gap: 6px; }
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
.card h3 { margin: 0 0 6px; font-size: 17px; color: var(--ink); }
.card p { margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.7; }
.card .card-meta { margin-top: 10px; color: var(--muted); font-size: 13px; display: flex; gap: 12px; flex-wrap: wrap; }
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
.reading.focus { grid-template-columns: 0 minmax(0, 1fr) 0; gap: 0; }
.reading.focus .rail { display: none; }

/* 窄屏：先读正文，本课程课次挪到正文下面，本页目录再往后 */
@media (max-width: 900px) {
  .reading, .reading.focus { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 20px 16px 84px; }
  .reading .rail { position: static; max-height: none; overflow: visible; }
  .reading .col { order: 0; }
  .reading .rail-left { order: 1; }
  .reading .rail-right { order: 2; }
  .rail nav.toc ol, .rail ol.lessons { max-height: none; overflow: visible; }
}

/* ── 右上角工具栏：全部是图标，点开一个小窄框 ── */
.tools { position: fixed; top: calc(var(--header-h) + 10px); right: 18px; z-index: 40; display: flex; gap: 4px;
  padding: 4px; border-radius: 999px; border: 1px solid var(--line); background: var(--card-bg);
  box-shadow: var(--shadow-md); }
.tools button, .tools a { width: 32px; height: 32px; border-radius: 50%; border: 0; background: none; color: var(--ink-soft);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; position: relative; }
.tools button:hover, .tools a:hover { background: var(--bg-soft); color: var(--ink); }
.tools button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); }
.tools svg { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.tools .pop { position: absolute; top: 40px; right: 0; min-width: 150px; padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--card-bg); box-shadow: var(--shadow-md); display: none; }
.tools .open .pop { display: block; }
.tools .dot-row { display: flex; gap: 8px; }
.tools .paper { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-strong); cursor: pointer; padding: 0; }
.tools .paper[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 2px; }
.tools input[type="range"] { width: 130px; }
.tools .pop a { width: auto; height: auto; border-radius: 8px; padding: 6px 8px; justify-content: flex-start; gap: 8px; font-size: 13.5px; color: var(--ink-soft); }

/* ── 锚点高亮：跳过去闪一下，然后留着底色 ── */
.anchor-flash { animation: anchorFlash 1.6s ease-out 1; }
@keyframes anchorFlash { 0% { background: var(--accent-soft); box-shadow: 0 0 0 6px var(--accent-soft); }
  100% { background: transparent; box-shadow: 0 0 0 0 transparent; } }
.mark-hit { background: var(--accent-soft); border-radius: 4px; }

/* ── 划词批注 ── */
.annot { border-radius: 3px; padding: 0 1px; }
.annot-underline { background-image: linear-gradient(currentColor, currentColor); background-repeat: no-repeat;
  background-position: 0 100%; background-size: 100% 2px; padding-bottom: 1px; }
.annot-underline.animate { animation: drawLine .5s ease-out 1; }
@keyframes drawLine { from { background-size: 0 2px; } to { background-size: 100% 2px; } }
.annot-mark { background-image: linear-gradient(var(--mark), var(--mark)); background-repeat: no-repeat;
  background-size: 100% 100%; }
.annot-mark.animate { animation: sweep .55s ease-out 1; }
@keyframes sweep { from { background-size: 0 100%; } to { background-size: 100% 100%; } }
.selbar { position: absolute; z-index: 60; display: none; gap: 2px; padding: 4px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--card-bg); box-shadow: var(--shadow-md); }
.selbar.show { display: flex; }
.selbar button { width: 30px; height: 30px; border-radius: 8px; border: 0; background: none; color: var(--ink-soft); cursor: pointer; }
.selbar button:hover { background: var(--bg-soft); color: var(--ink); }
.selbar svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; }

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
    // 索引页点进来要落在正文里那一节，而不是笔记开头
    anchors: termAnchors(body),
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
<link rel="alternate" type="application/rss+xml" title="课程笔记" href="/feed.xml">
<style>${SITE_CSS}</style>
${PREF_SCRIPT}
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
${layout === 'shell' ? '<div class="shell">' : layout === 'reading' ? '<div class="reading" id="reading">' : '<div class="wrap">'}
${body}
</div>
<footer class="site">
  <span>${escapeHtml(SITE_NAME)} · course.law-tech.dev</span>
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
    followActive(next[0])
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

  // ── 阅读控制：字号、深色、位置记忆 ──
  var root = document.documentElement
  var FONT_KEY = 'course.fontScale'
  var THEME_KEY = 'course.theme'
  var POS_KEY = 'course.readPos:' + location.pathname

  function applyFont (scale) {
    var value = Math.min(1.4, Math.max(0.85, scale || 1))
    root.style.setProperty('--font-scale', String(value))
    try { localStorage.setItem(FONT_KEY, String(value)) } catch (e) {}
  }
  function applyTheme (theme) {
    var dark = theme === 'dark'
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
    var toggle = document.getElementById('themeToggle')
    if (toggle) toggle.textContent = dark ? '浅色' : '深色'
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light') } catch (e) {}
  }
  try {
    applyFont(parseFloat(localStorage.getItem(FONT_KEY) || '1'))
    applyTheme(localStorage.getItem(THEME_KEY) || 'light')
  } catch (e) { applyFont(1); applyTheme('light') }

  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-read]')
    if (!btn) return
    var action = btn.dataset.read
    var current = parseFloat(root.style.getPropertyValue('--font-scale') || '1') || 1
    if (action === 'font-up') applyFont(current + 0.1)
    if (action === 'font-down') applyFont(current - 0.1)
    if (action === 'theme') applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
  })

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
    record.publishedAt ? `${escapeHtml(String(record.publishedAt).slice(0, 10))} 发布` : ''
  ].filter(Boolean).join(' · ')

  const railExtra = [
    neighbours.previous ? `<div class="prevnext"><span>上一讲</span><a href="${escapeHtml(neighbours.previous.slug)}.html">${escapeHtml(neighbours.previous.lessonTitle)}</a></div>` : '',
    neighbours.next ? `<div class="prevnext"><span>下一讲</span><a href="${escapeHtml(neighbours.next.slug)}.html">${escapeHtml(neighbours.next.lessonTitle)}</a></div>` : '',
    // 读长文真正会用到的三个开关：字号、深浅、位置。都记在本地，不需要账号。
    `<div class="rail-controls">
      <button type="button" data-read="font-down" aria-label="缩小字号">A−</button>
      <button type="button" data-read="font-up" aria-label="放大字号">A+</button>
      <button type="button" data-read="theme" id="themeToggle">深色</button>
    </div>`
  ].filter(Boolean).join('')

  return pageShell({
    title: `${record.lessonTitle} · ${SITE_NAME}`,
    description: record.summary,
    canonical: siteOrigin ? `${siteOrigin}/${record.slug}` : '',
    layout: 'reading',
    scripts: [hasMermaid(record.markdown) ? MERMAID_LOADER : '', NOTE_SCRIPT, READER_SCRIPT].filter(Boolean).join('\n'),
    body: [
      '<div class="progress" id="progress"></div>',
      toolBar(record),
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
      '<button class="totop" id="totop" type="button">回到顶部</button>',
      '<div class="selbar" id="selbar"></div>'
    ].filter(Boolean).join('\n')
  })
}

/**
 * 索引页：概念 / 法条 / 案例。
 *
 * 这是"治割裂"最实际的一页——复习时真正会问的是"这个概念老师在哪几讲讲讲过、
 * 每次讲法有什么不同"，而不是"这节课讲了什么"。数据全部来自各篇笔记的元数据块，
 * 不需要重跑模型。
 *
 * 左侧按课程过滤，右侧条目一次列到底：不折叠，条目直接落到笔记正文的那一节。
 */
export function renderTermIndexPage({ title, description, kind, notes = [], siteOrigin = '' } = {}) {
  const kindOf = { concepts: 'concepts', statutes: 'statutes', cases: 'cases' }
  const bucket = kindOf[kind] || 'concepts'
  const entries = new Map()
  const courses = []
  for (const note of notes) {
    const course = note.courseName || '未分类'
    if (!courses.includes(course)) courses.push(course)
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

  // 条目落到"这条术语在笔记正文里的那一节"，不是笔记开头——否则复习时还得自己再找一遍
  const anchorOf = (note, term) => ((note.anchors && note.anchors[bucket]) || {})[term] || ''
  const rowOf = ([term, used]) => [
    `<div class="index-row" data-courses="${escapeHtml([...new Set(used.map(note => note.courseName || '未分类'))].join('|'))}">`,
    `<div class="index-term">${escapeHtml(term)}${bucket === 'statutes' && parseStatute(term).article ? `<span class="index-article">第 ${escapeHtml(parseStatute(term).article)} 条</span>` : ''}</div>`,
    '<div class="index-notes">',
    used.map(note => {
      const anchor = anchorOf(note, term)
      return `<a data-course="${escapeHtml(note.courseName || '未分类')}" href="/${escapeHtml(note.slug)}.html${anchor ? `#${escapeHtml(anchor)}` : ''}">${escapeHtml(note.courseName || '')} · ${escapeHtml(note.lessonTitle)}</a>`
    }).join(''),
    '</div>',
    '</div>'
  ].join('\n')

  // 法条索引按法律名分段（《刑法》《民法典》…）；概念与案例就是一整张表
  const groups = []
  for (const item of list) {
    const law = bucket === 'statutes' ? (parseStatute(item[0]).law || '未标注法律') : ''
    if (!groups.length || groups[groups.length - 1].law !== law) groups.push({ law, rows: [] })
    groups[groups.length - 1].rows.push(rowOf(item))
  }

  const filterRail = [
    `<aside class="filter-rail" id="filter-rail" data-kind="${bucket}">`,
    `<button type="button" data-course="" aria-pressed="true">全部<span class="filter-count">${list.length}</span></button>`,
    courses.map(course => {
      const count = list.filter(([, used]) => used.some(note => (note.courseName || '未分类') === course)).length
      return count
        ? `<button type="button" data-course="${escapeHtml(course)}" aria-pressed="false">${escapeHtml(course)}<span class="filter-count">${count}</span></button>`
        : ''
    }).filter(Boolean).join('\n'),
    '</aside>'
  ].join('\n')

  const body = [
    '<header class="site">',
    `<h1>${escapeHtml(title)}</h1>`,
    '</header>',
    list.length
      ? [
        '<div class="index-shell">',
        filterRail,
        '<div class="index-body">',
        groups.map(group => [
          '<section class="index-group">',
          group.law ? `<h2>《${escapeHtml(group.law)}》</h2>` : '',
          `<div class="index-list">${group.rows.join('\n')}</div>`,
          '</section>'
        ].filter(Boolean).join('\n')).join('\n'),
        '</div>',
        '</div>',
        INDEX_FILTER_SCRIPT
      ].join('\n')
      : '<div class="empty">还没有条目。</div>'
  ].join('\n')

  return pageShell({
    title: `${title} · ${SITE_NAME}`,
    description,
    canonical: siteOrigin ? `${siteOrigin}/${kind}/` : '',
    body
  })
}

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
    var rows = document.querySelectorAll('.index-row');
    for (var j = 0; j < rows.length; j += 1) {
      var courses = (rows[j].getAttribute('data-courses') || '').split('|');
      rows[j].hidden = !!course && courses.indexOf(course) < 0;
      var links = rows[j].querySelectorAll('a[data-course]');
      for (var k = 0; k < links.length; k += 1) {
        links[k].hidden = !!course && links[k].getAttribute('data-course') !== course;
      }
    }
    var groups = document.querySelectorAll('.index-group');
    for (var g = 0; g < groups.length; g += 1) {
      groups[g].hidden = !groups[g].querySelector('.index-row:not([hidden])');
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

/** 站内搜索页：纯客户端，索引就是 notes.json（不含正文，体积可控）。 */
export function renderSearchPage({ siteOrigin = '' } = {}) {
  const body = [
    '<header class="site">',
    '<h1>搜索笔记</h1>',
    '</header>',
    '<input class="search" id="q" type="search" placeholder="例如：众数、第 25 条、抽样、共犯" autocomplete="off">',
    '<div class="search-hint" id="hint"></div>',
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
    hint.textContent = hits.length ? '' : '没有找到。换个词试试。';
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
  // 一门课一行、课次在行内横向排开：一屏就能看出"这门课讲到哪儿了"，
  // 比一列到底的长清单更接近翻课件的手感（窄屏时行内左右滑）。
  const body = [
    '<section class="hero">',
    '<h1>课程笔记</h1>',
    `<div class="meta">共 ${records.length} 篇 · ${courses.length} 门课</div>`,
    '</section>',
    records.length
      ? [...groups.entries()].map(([course, items]) => [
        '<section class="band">',
        `<div class="band-head"><h2>${escapeHtml(course)} · ${items.length} 讲</h2></div>`,
        '<div class="strip">',
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
        '</div>',
        '</section>'
      ].join('\n')).join('\n')
      : '<div class="empty">还没有已发布的笔记。</div>'
  ].filter(Boolean).join('\n')

  return pageShell({
    title: SITE_NAME,
    description: '北大法学课程笔记',
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
    .sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)))
    .slice(0, 50)
    .map(record => [
      '    <item>',
      `      <title>${esc(`${record.courseName ? `${record.courseName} · ` : ''}${record.lessonTitle}`)}</title>`,
      `      <link>${esc(`${base}/${record.slug}.html`)}</link>`,
      `      <guid isPermaLink="true">${esc(`${base}/${record.slug}.html`)}</guid>`,
      `      <pubDate>${new Date(record.publishedAt || now).toUTCString()}</pubDate>`,
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
export function refreshRecord(record = {}) {
  const markdown = String(record.markdown ?? '')
  if (!markdown.trim()) return record
  return {
    ...record,
    headings: extractHeadings(markdown),
    readMinutes: record.readMinutes || estimateReadMinutes(markdown),
    metadata: extractNoteMetadata(markdown),
    anchors: termAnchors(markdown)
  }
}

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

  // 全量重写时顺手把派生字段按正文重算：模板与解析规则改了，重建出来的站点才是新的
  const sorted = records.map(refreshRecord)
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))

  // 上一讲 / 下一讲：同一门课内按发布时间排序后的相邻两篇
  const neighboursOf = record => {
    const sameCourse = sorted.filter(item => item.courseName === record.courseName)
      .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
    const at = sameCourse.findIndex(item => item.slug === record.slug)
    return { previous: at > 0 ? sameCourse[at - 1] : null, next: at >= 0 && at < sameCourse.length - 1 ? sameCourse[at + 1] : null }
  }

  // 同一门课的全部课次：阅读页左栏要列出来（点着就能换课）
  const lessonsOfCourse = record => sorted
    .filter(item => item.courseName === record.courseName)
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
    .map(item => ({ slug: item.slug, lessonTitle: item.lessonTitle }))

  write('index.html', renderIndexPage(sorted, { siteOrigin }))
  for (const record of sorted) {
    write(`${record.slug}.html`, renderNotePage(record, {
      siteOrigin,
      neighbours: neighboursOf(record),
      courseLessons: lessonsOfCourse(record)
    }))
    // 同时写出一份 Markdown：页面上的「下载 / 复制 Markdown」直接取它，
    // 正文全文就不必再内嵌进 HTML（那会让每页翻一倍）
    const fileName = String(record.slug).split('/').pop()
    write(`md/${fileName}.md`, `${record.markdown || ''}\n`)
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
  write('search/index.html', renderSearchPage({ siteOrigin }))
  write('feed.xml', renderFeed(sorted, { siteOrigin }))
  write('notes.json', `${JSON.stringify({
    siteName: SITE_NAME,
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    // 索引里带一个 chars：日报与列表页要显示"多少字"，而 markdown 本身不进索引（太大）
    notes: sorted.map(({ markdown, ...rest }) => ({ ...rest, chars: String(markdown || '').length }))
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