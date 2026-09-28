import { escapeHtml, renderMarkdown } from './markdown.mjs'
import { svgIcon } from './reader.mjs'

/**
 * 一页纸视图：左侧同一课程的课次（点着换页），右侧一张 A4。
 *
 * 三条硬要求（都来自用户）：
 *   1. **放得下**：只能是一张 A4 的量。模型那边按字数写，页面这边再做一次自动缩放兜底，
 *      两边都不许出现"内容被裁掉半截"。
 *   2. **不是一篇文章**：列表、表格为主，所以正文按三栏排（窄屏两栏），像复习卡而不像稿纸。
 *   3. **打印出来就是一张 A4**：@page 尺寸写死 A4，打印时隐掉导航与工具，纸上只有这一页。
 */
export function renderOnepagePage(record = {}, { siteOrigin = '', courseLessons = [] } = {}) {
  const onepage = record.onepage || {}
  const sheetTitle = onepage.title || record.lessonTitle || ''
  const rail = courseLessons.length
    ? `<nav aria-label="本课程课次"><div class="rail-title">${escapeHtml(record.courseName || '本课程')}</div>` +
      `<ol class="lessons">${courseLessons.map(item => {
        const slug = String(item.slug || '')
        const onepageSlug = slug.replace(/^notes\//, 'onepage/')
        const current = slug === record.slug
        return `<li><a href="/${escapeHtml(onepageSlug)}.html"${current ? ' aria-current="page"' : ''}>` +
          `${escapeHtml(item.lessonTitle)}${item.chars ? `<span class="onepage-chars">${item.chars} 字</span>` : ''}</a></li>`
      }).join('')}</ol></nav>`
    : ''

  const body = [
    '<aside class="rail rail-left">',
    rail || `<div class="rail-title">${escapeHtml(record.courseName || '')}</div>`,
    '</aside>',
    '<div class="sheet-wrap">',
    '<article class="sheet" id="sheet">',
    `<h1 class="sheet-title">${escapeHtml(sheetTitle)}</h1>`,
    `<div class="sheet-body" id="sheetBody">${renderMarkdown(onepage.markdown || '')}</div>`,
    `<div class="sheet-foot">${escapeHtml(record.courseName || '')} · ${escapeHtml(record.lessonTitle || '')}</div>`,
    '</article>',
    '</div>',
    ONEPAGE_SCRIPT
  ].join('\n')

  return { body }
}

/**
 * 自动缩放：以"放得下"为第一优先级。
 *
 * 三栏排版里内容溢出时会在右边"长出第四栏"（scrollWidth 变大），所以宽高都要看。
 * 缩到 0.72 还放不下就停手并标记出来——那时候该做的是回去删内容，而不是继续缩成蚂蚁字。
 */
export const ONEPAGE_SCRIPT = `<script>
(function () {
  var sheet = document.getElementById('sheet')
  var body = document.getElementById('sheetBody')
  if (!sheet || !body) return
  function overflows () {
    return body.scrollWidth > body.clientWidth + 2 || body.scrollHeight > body.clientHeight + 2
  }
  function fit () {
    // 起始字号跟随全局字号（读者在工具栏调的），但**限制在 0.85—1.15**：
    // 一页纸是"一页 A4"，读者把它调到 1.4 倍时不该假装还能一页装下——
    // 这时候正确的行为是照常自动缩、缩不动就标出"内容超出 A4"，而不是静默裁掉。
    var user = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1
    var scale = Math.max(0.85, Math.min(1.15, user))
    sheet.style.setProperty('--sheet-scale', scale.toFixed(2))
    var guard = 0
    while (overflows() && scale > 0.72 && guard < 24) {
      scale -= 0.03
      guard += 1
      sheet.style.setProperty('--sheet-scale', scale.toFixed(2))
    }
    var tight = overflows()
    sheet.classList.toggle('sheet-tight', tight)
    if (tight) sheet.setAttribute('data-overflow', '1')
    else sheet.removeAttribute('data-overflow')
    return { scale: scale, tight: tight }
  }
  fit()
  // 打印前重新量一次：纸上的列宽与屏幕不同，屏幕上刚好放得下不代表纸上也是
  window.addEventListener('beforeprint', fit)
})();
</script>`

/** 一页纸专用样式：A4 比例、三栏、打印就是一页纸。 */
export const ONEPAGE_CSS = `
/* ── 一页纸：左侧课次 + 右侧一张 A4 ── */
.onepage { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); gap: 26px;
  max-width: 1320px; margin: 0 auto; padding: 22px 22px 60px; align-items: start; }
.onepage .rail { position: sticky; top: calc(var(--header-h) + 18px); align-self: start;
  max-height: calc(100vh - var(--header-h) - 36px); overflow-y: auto; }
.onepage-chars { color: var(--muted); font-size: 11.5px; margin-left: 6px; }
.sheet-wrap { min-width: 0; }
.sheet { --sheet-scale: 1; width: 100%; max-width: 210mm; margin: 0 auto; aspect-ratio: 210 / 297;
  background: var(--card-bg); border: 1px solid var(--line); border-radius: 6px; box-shadow: var(--shadow-md);
  padding: 12mm 11mm 9mm; display: flex; flex-direction: column; overflow: hidden; font-family: var(--sans); }
.sheet-title { margin: 0 0 4mm; font-size: calc(17px * var(--sheet-scale)); line-height: 1.35; letter-spacing: -.01em; }
.sheet-body { flex: 1; min-height: 0; column-count: 3; column-gap: 6mm; font-size: calc(11.5px * var(--sheet-scale));
  line-height: 1.62; overflow: hidden; }
.sheet-body h2 { font-size: calc(13px * var(--sheet-scale)); margin: 0 0 2mm; padding-bottom: 1mm;
  border-bottom: 1px solid var(--line); break-after: avoid; }
.sheet-body h3 { font-size: calc(12px * var(--sheet-scale)); margin: 2.5mm 0 1mm; color: var(--ink-soft); break-after: avoid; }
.sheet-body p { margin: 0 0 1.6mm; }
.sheet-body ul, .sheet-body ol { margin: 0 0 2mm; padding-left: 4.6mm; }
.sheet-body li { margin: 0 0 .8mm; }
.sheet-body table { width: 100%; border-collapse: collapse; margin: 0 0 2.4mm; font-size: calc(10.5px * var(--sheet-scale)); }
.sheet-body th, .sheet-body td { border: 1px solid var(--line); padding: .9mm 1.4mm; text-align: left; vertical-align: top; }
.sheet-body th { background: var(--bg-soft); font-weight: 600; }
.sheet-body blockquote { margin: 0 0 2mm; padding: 1.4mm 2.4mm; background: var(--bg-soft);
  border-left: 2px solid var(--accent); font-size: calc(11px * var(--sheet-scale)); }
.sheet-body code { font-family: ui-monospace, Menlo, monospace; background: var(--bg-sunken); padding: 0 1mm; border-radius: 3px; }
.sheet-foot { margin-top: 3mm; padding-top: 1.6mm; border-top: 1px solid var(--line);
  color: var(--muted); font-size: calc(10px * var(--sheet-scale)); }
/* 缩到底还是放不下：如实标出来（该回去删内容，而不是继续缩成蚂蚁字） */
.sheet[data-overflow="1"] { border-color: var(--warn); }
.sheet[data-overflow="1"] .sheet-foot::after { content: " · 内容超出 A4，请精简"; color: var(--warn); }
@media (max-width: 1100px) { .sheet-body { column-count: 2; } }
@media (max-width: 900px) {
  .onepage { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px 14px 60px; }
  .onepage .rail { position: static; max-height: none; order: 2; }
  .sheet { aspect-ratio: auto; }
  .sheet-body { column-count: 1; }
}
@media print {
  @page { size: A4; margin: 8mm; }
  .topbar, .rail, .tools, .totop { display: none !important; }
  .onepage { display: block; max-width: none; padding: 0; }
  .sheet { max-width: none; width: auto; aspect-ratio: auto; border: 0; box-shadow: none; padding: 0;
    background: #fff; }
  .sheet-body { column-count: 3; overflow: visible; }
  body { background: #fff; }
}
`;
