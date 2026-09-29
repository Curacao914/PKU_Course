/**
 * 阅读页的工具栏、课程导航与客户端脚本。
 *
 * 单独一个文件：site.mjs 已经很长，而这些是"读者端交互"一件事，
 * 放在一起读起来才连贯；也免得在 site.mjs 的模板字符串里跟转义打架。
 *
 * 三条来自用户的要求（2026-09-27）：
 *   1. 工具栏全部用 SVG 图标，**不要文字、不要 emoji**；点开是一个窄窄的小框，不要笨重面板；
 *   2. 深浅色要**全局**生效（换页、回首页都还在），底色可选豆沙绿/牛皮纸这类护眼色，字号用滑块；
 *   3. 划词之后在选中处浮出一小条工具（下划线/高亮/复制），**加粗不做**；
 *      写上之后要能留住（存浏览器），并且下划线"从左到右画出来"、高亮"从左到右刷过去"。
 */

import * as anchors from './anchors.mjs'
import { markdownUrl, onePageMarkdownUrl } from './markdown-path.mjs'

/**
 * 把 anchors.mjs 的**源码原文**内联进页面脚本。
 *
 * 为什么要这么绕：定位逻辑必须只有一份实现——页面上跑的和单测里跑的是同一段代码，
 * 否则"测试过了、线上还是贴错位置"。这里用的都是无闭包的纯函数，序列化函数源码即可，
 * 不需要打包器（这个项目全站零依赖、没有构建步骤）。
 */
const ANCHOR_RUNTIME = [
  'var A = (function () {',
  `var CONTEXT_LENGTH = ${anchors.CONTEXT_LENGTH}`,
  `var OFFSET_TOLERANCE = ${anchors.OFFSET_TOLERANCE}`,
  'const str = value => String(value == null ? \'\' : value)',
  String(anchors.annotationId),
  String(anchors.anchorFromSelection),
  String(anchors.normalizeAnchor),
  String(anchors.collectText),
  String(anchors.piecesForRange),
  String(anchors.findAnchor),
  'return { annotationId: annotationId, anchorFromSelection: anchorFromSelection, normalizeAnchor: normalizeAnchor, collectText: collectText, piecesForRange: piecesForRange, findAnchor: findAnchor }',
  '})();'
].join('\n')

export const READER_ICONS = {
  // 批注的导出/导入：一个"带箭头的框"，方向区分出/入
  annotExport: '<path d="M12 3v10M8.5 9.5L12 13l3.5-3.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  annotImport: '<path d="M12 13V3M8.5 6.5L12 3l3.5 3.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  font: '<path d="M5 19l5.5-14h1L17 19M7.6 14h7"/><path d="M3 5h4M17 5h4"/>',
  palette: '<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="9.5" r="1.1"/><circle cx="15" cy="9.5" r="1.1"/><circle cx="9.5" cy="15" r="1.1"/>',
  export: '<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 19h16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  focus: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  underline: '<path d="M7 4v6a5 5 0 0 0 10 0V4"/><path d="M6 20h12"/>',
  mark: '<path d="M4 20h16"/><path d="M6 16l3.5-11 4 8 4.5-5.5"/>',
  // 加粗与下划线照 Word 的样子画：B 用两段实心笔画，U 用一根底线，扫一眼就认得出
  bold: '<path d="M7 4h6.2a3.9 3.9 0 0 1 0 7.8H7z" stroke-width="2"/><path d="M7 11.8h7.1a4.1 4.1 0 0 1 0 8.2H7z" stroke-width="2"/>',
  // 打印机：看得出是打印——上半是机身，下半吐出一张纸
  printer: '<path d="M7 9V3.8h10V9"/><rect x="3.5" y="9" width="17" height="7.2" rx="1.6"/><path d="M7 14.2h10V20H7z"/>',
  arrowUp: '<path d="M12 19V6"/><path d="M6.5 11.5L12 6l5.5 5.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  // 阅读设置：两根带滑块的横杆。齿轮在这个尺寸下会糊成一团，滑杆一眼就是"可调"
  sliders: '<path d="M4 8h5M15 8h5M4 16h7M17 16h3"/><circle cx="12" cy="8" r="2.2"/><circle cx="14" cy="16" r="2.2"/>',
  // 一页纸摘要：一张带折角的纸加几道横线（首页表格里"一页纸"三个字会被挤换行，所以用图标）
  sheet: '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16.5h4"/>'
}

export function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${READER_ICONS[name] || ''}</svg>`
}

// 划词工具条的四个图标：**必须定义在 READER_SCRIPT 之前**——脚本是模板字符串，
// ${...} 在模块加载时就求值，写在后面会直接 TDZ 报错（原来的写法干脆没插值，
// 于是那排按钮在浏览器里根本画不出来）。
const ICON_BOLD = `<svg viewBox="0 0 24 24" aria-hidden="true">${READER_ICONS.bold}</svg>`
const ICON_UNDERLINE = `<svg viewBox="0 0 24 24" aria-hidden="true">${READER_ICONS.underline}</svg>`
const ICON_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true">${READER_ICONS.mark}</svg>`
const ICON_COPY = `<svg viewBox="0 0 24 24" aria-hidden="true">${READER_ICONS.copy}</svg>`

/**
 * 深浅 / 底色 / 字号：阅读页工具栏与顶栏"阅读设置"下拉**共用同一段脚本**。
 *
 * 为什么抽出来：这两处各写一份必然漂移。它们是同一批 localStorage 键
 * （course.theme / course.paper / course.fontScale），逻辑写岔了就会出现
 * "在首页调好的底色，点进笔记又变回去"这种谁都说不清的问题。
 * 键名与 <head> 里的预置脚本（site.mjs 的 PREF_SCRIPT）必须一致。
 */
const PREF_CORE = String.raw`
  var root = document.documentElement
  var store = {
    get: function (key, fallback) { try { return localStorage.getItem(key) || fallback } catch (e) { return fallback } },
    set: function (key, value) { try { localStorage.setItem(key, value) } catch (e) {} }
  }

  // ── 深浅 / 底色 / 字号（与每页开头的预置脚本共用同一批键）──
  function applyTheme (dark) {
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
    if (dark) root.removeAttribute('data-paper')
    else if (store.get('course.paper', '')) root.setAttribute('data-paper', store.get('course.paper', ''))
    store.set('course.theme', dark ? 'dark' : 'light')
    // 工具栏里的日/夜按钮与设置下拉里的那个按钮都跟着亮起来（同一页只有一个）
    document.querySelectorAll('#toolTheme, [data-pref="theme"]').forEach(function (button) {
      button.setAttribute('aria-pressed', dark ? 'true' : 'false')
    })
  }
  function applyPaper (paper) {
    store.set('course.paper', paper || '')
    if (!paper || root.getAttribute('data-theme') === 'dark') root.removeAttribute('data-paper')
    else root.setAttribute('data-paper', paper)
    document.querySelectorAll('button.paper[data-paper]').forEach(function (dot) {
      dot.setAttribute('aria-pressed', dot.getAttribute('data-paper') === (paper || '') ? 'true' : 'false')
    })
  }
  function applyFont (scale) {
    var value = Math.min(1.4, Math.max(0.85, Number(scale) || 1))
    root.style.setProperty('--font-scale', String(value))
    store.set('course.fontScale', String(value))
    var range = document.getElementById('fontRange')
    if (range) range.value = String(value)
  }

  // 进来先按本地存的偏好刷一遍。<head> 里那段已经刷过一次（那一次是为了不闪白），
  // 这一次补的是按钮/滑块自己的状态。
  applyTheme(store.get('course.theme', 'light') === 'dark')
  applyPaper(store.get('course.paper', ''))
  applyFont(store.get('course.fontScale', '1'))
`

/**
 * 右上角工具栏。
 *
 * 导出两件事：**下载 Markdown**（发布时会为每篇笔记同时写出 .md）与打印成 PDF
 * （走浏览器自带的打印，页面上有打印样式）。刻意不做服务端 PDF 生成——
 * 那要在这台 2 核机器上装一套排版引擎，而读者的浏览器本来就会排版。
 */
export function toolBar(record = {}) {
  // 一页纸页面上下载的是那一页纸本身，笔记页下载的是整篇笔记。
  // 判据是页面类型（onepagePage），而不是"这节课有没有一页纸"——旧写法用后者，
  // 于是凡是有过一页纸的课次，笔记页上的下载按钮给出的都是一页纸。
  // 路径本身来自 markdown-path.mjs：与写文件、llms.txt、MCP 取正文是同一条。
  const href = record.onepagePage ? onePageMarkdownUrl(record) : markdownUrl(record)
  return [
    '<div class="tools" id="tools">',
    `<a href="${href}" download title="下载 Markdown" aria-label="下载 Markdown">${svgIcon('export')}</a>`,
    `<button type="button" data-tool="print" title="打印 / 存为 PDF" aria-label="打印或存为 PDF">${svgIcon('printer')}</button>`,
    `<button type="button" data-tool="copy" title="复制 Markdown" aria-label="复制 Markdown">${svgIcon('copy')}</button>`,
    `<button type="button" data-tool="focus" title="专注模式" aria-label="专注模式">${svgIcon('focus')}</button>`,
    // 批注只存在这台浏览器里（没有服务端）：换设备、清缓存前导出一份带走。
    // 导入按 id 合并，不会重复。
    `<button type="button" data-tool="annot-export" title="导出划词批注（JSON）" aria-label="导出划词批注">${svgIcon('annotExport')}</button>`,
    `<button type="button" data-tool="annot-import" title="导入划词批注（JSON）" aria-label="导入划词批注">${svgIcon('annotImport')}</button>`,
    // 日/夜各一个图标，用当前主题决定显示哪个（CSS 切，不在 JS 里换 innerHTML）
    `<button type="button" data-tool="theme" id="toolTheme" title="深浅色" aria-label="深浅色">` +
      `<span class="icon-sun">${svgIcon('sun')}</span><span class="icon-moon">${svgIcon('moon')}</span></button>`,
    '<div class="tool-wrap">',
    // 底色按钮就是一个调色盘图标：当前选中的颜色由弹出小框里的圆点标出来
    `<button type="button" data-tool="paper" title="背景色" aria-label="背景色">${svgIcon('palette')}</button>`,
    '<div class="pop" id="paperPop"><div class="dot-row">',
    '<button class="paper" type="button" data-paper="" style="background:#ffffff" title="纸白" aria-label="纸白"></button>',
    '<button class="paper" type="button" data-paper="green" style="background:#c7edcc" title="豆沙绿" aria-label="豆沙绿"></button>',
    '<button class="paper" type="button" data-paper="kraft" style="background:#f4ecd8" title="牛皮纸" aria-label="牛皮纸"></button>',
    '<button class="paper" type="button" data-paper="gray" style="background:#f2f3f5" title="浅灰" aria-label="浅灰"></button>',
    '</div></div></div>',
    '<div class="tool-wrap">',
    `<button type="button" data-tool="font" title="字号" aria-label="字号">${svgIcon('font')}</button>`,
    '<div class="pop" id="fontPop"><input type="range" id="fontRange" min="0.9" max="1.4" step="0.05" aria-label="字号"></div>',
    '</div></div>'
  ].join('')
}

/**
 * 顶栏右侧的「阅读设置」下拉：深浅 / 背景色 / 字号。
 *
 * 非阅读页（首页、索引、地图、文档、搜索）顶栏没有工具栏图标，这三项以前一个都改不了；
 * 现在收进一个下拉，挂在那一排导航的最右边，样式与站点导航下拉完全一致
 * （点开、点外面收起、Esc 收起、键盘可达）。
 * 阅读页与一页纸页不挂它——那两页顶栏本来就有工具栏图标排，多一个入口只会让人犹豫点哪个。
 */
export function settingsMenu() {
  return [
    '<details class="navmenu prefmenu" id="prefmenu">',
    `<summary title="阅读设置" aria-label="阅读设置">${svgIcon('sliders')}</summary>`,
    '<div class="nav-pop pref-pop">',
    // 日/夜各一个图标，由当前主题决定显示哪个（与工具栏同一套 class，CSS 也共用）
    '<button type="button" data-pref="theme" title="深浅色" aria-label="深浅色">' +
      `<span class="icon-sun">${svgIcon('sun')}</span><span class="icon-moon">${svgIcon('moon')}</span></button>`,
    '<div class="dot-row">',
    '<button class="paper" type="button" data-paper="" style="background:#ffffff" title="纸白" aria-label="纸白"></button>',
    '<button class="paper" type="button" data-paper="green" style="background:#c7edcc" title="豆沙绿" aria-label="豆沙绿"></button>',
    '<button class="paper" type="button" data-paper="kraft" style="background:#f4ecd8" title="牛皮纸" aria-label="牛皮纸"></button>',
    '<button class="paper" type="button" data-paper="gray" style="background:#f2f3f5" title="浅灰" aria-label="浅灰"></button>',
    '</div>',
    '<input type="range" id="fontRange" min="0.9" max="1.4" step="0.05" aria-label="字号">',
    '</div></details>'
  ].join('')
}

/**
 * 设置下拉的交互。
 *
 * <details>/<summary> 原生就支持鼠标点击与键盘（Tab 到、Enter/Space 开合），所以这里只补三件
 * 原生不管的事：点外面收起、Esc 收起、以及三个控件自己的行为。
 * 三个控件走的还是 PREF_CORE 里的 applyTheme / applyPaper / applyFont——
 * 与阅读页工具栏是同一份实现、同一批 localStorage 键，两边不会各说各话。
 */
export const PREF_MENU_SCRIPT = '<script>' + String.raw`
(function () {
  var menu = document.getElementById('prefmenu')
  if (!menu) return
` + PREF_CORE + String.raw`
  menu.addEventListener('click', function (event) {
    if (!event.target.closest) return
    // 色板判定必须限定成 button.paper[data-paper]：<html> 自己也带 data-paper，
    // 用 closest('[data-paper]') 会把「点这个下拉里的任意位置」都当成选颜色。
    var dot = event.target.closest('button.paper[data-paper]')
    // 选完颜色就收起：留着它会在窄屏上盖住下面的内容
    if (dot) { applyPaper(dot.getAttribute('data-paper') || ''); menu.open = false; return }
    var button = event.target.closest('[data-pref="theme"]')
    if (button) applyTheme(root.getAttribute('data-theme') !== 'dark')
  })
  var range = document.getElementById('fontRange')
  if (range) {
    range.value = store.get('course.fontScale', '1')
    range.addEventListener('input', function () { applyFont(range.value) })
  }
  document.addEventListener('click', function (event) {
    if (!event.target.closest || !event.target.closest('#prefmenu')) menu.open = false
  }, true)
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu.open) menu.open = false
  })
})();
</script>`

/** 左栏：本课程全部课次，点着就能换课。 */
/**
 * 本课次的三个固定入口：原笔记 / 一页纸 / 我的标记。
 *
 * 三个入口在**同一位置**（标题下的同一行）出现，笔记页与一页纸页都一样——
 * 读者不必先想"我现在在哪张页面上、另一个入口藏在哪"。当前所在的那个用 aria-current 标出。
 * 一页纸还没生成时如实写"暂无"，不做成一个点了没反应的链接。
 */
export function lessonDock(record = {}, { current = 'note' } = {}) {
  const slug = String(record.slug || '').replace(/^\/+/, '')
  if (!slug) return ''
  const noteHref = `/${slug}.html`
  const onepageHref = `/${slug.replace(/^notes\//, 'onepage/')}.html`
  const hasOnepage = Boolean(record.onepage && record.onepage.markdown)
  const items = [
    `<a href="${escapeAttr(noteHref)}"${current === 'note' ? ' aria-current="page"' : ''}>原笔记</a>`,
    hasOnepage
      ? `<a href="${escapeAttr(onepageHref)}"${current === 'onepage' ? ' aria-current="page"' : ''}>一页纸</a>`
      : '<span class="dock-off">一页纸（暂无）</span>',
    // 标记是拿正文里的句子做的，所以"我的标记"永远指向笔记页那一块（一页纸页转过去）
    current === 'note'
      ? '<button type="button" data-dock="marks">我的标记</button>'
      : `<a href="${escapeAttr(noteHref)}#railMarks">我的标记</a>`
  ]
  // 「返回一页纸」：从一页纸点"看原文"过来时才出现（脚本校验过地址才显示）。
  // 直接打开原文、或上下文对不上这一篇时，这里什么都没有——不显示一个点不动的按钮。
  if (current === 'note') items.push('<a class="dock-back" id="obBack" hidden>返回一页纸</a>')
  return `<nav class="lesson-dock" aria-label="本课次入口">${items.join('')}</nav>`
}

export function courseNav(record = {}, courseLessons = []) {
  if (!courseLessons.length) return ''
  const items = courseLessons.map(item => {
    const current = String(item.slug) === String(record.slug)
    return `<li><a href="/${escapeAttr(item.slug)}.html"${current ? ' aria-current="page"' : ''}>${escapeAttr(item.lessonTitle)}</a></li>`
  }).join('')
  return `<nav aria-label="本课程课次"><div class="rail-title">${escapeAttr(record.courseName || '本课程')}</div>` +
    `<ol class="lessons">${items}</ol></nav>`
}

function escapeAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
}

/**
 * 阅读页客户端脚本。
 *
 * 四件事：工具栏（深浅/底色/字号/专注/复制/打印）、锚点高亮、划词批注、目录跟随。
 * 全部原生 JS，没有依赖——站点没有构建步骤，这段就是它全部的交互。
 */
// 深浅 / 底色 / 字号不在这里再写一遍：与顶栏的阅读设置下拉共用 PREF_CORE（见上）
export const READER_SCRIPT = '<script>' + ANCHOR_RUNTIME + String.raw`
(function () {
  var reading = document.getElementById('reading')
  var tools = document.getElementById('tools')
` + PREF_CORE + String.raw`

  /**
   * 收起浮层。**先播 180ms 的收起过渡再真正隐藏**：
   * 闭着的浮层若留在布局里（opacity:0）会把手机整页撑出横向滚动，所以隐藏仍然是
   * display:none，只是推迟到动画播完；"少动"偏好下直接隐藏。
   */
  function reduceMotion () {
    try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (error) { return false }
  }
  function closePops (immediate) {
    document.querySelectorAll('.tool-wrap.open').forEach(function (node) {
      clearTimeout(node.__closeTimer)
      if (immediate || reduceMotion()) { node.classList.remove('open', 'closing'); return }
      node.classList.add('closing')
      node.__closeTimer = setTimeout(function () { node.classList.remove('open', 'closing') }, 180)
    })
  }
  // 顶栏的站点导航是个 <details>：原生不会"点别处就收起"，点开之后会一直盖在
  // 工具栏的小框上。这里手动收——点外面、按 Esc、或打开别的浮层时都收起。
  var navMenu = document.querySelector('.navmenu')
  function closeNav () { if (navMenu && navMenu.open) navMenu.open = false }
  if (navMenu) navMenu.addEventListener('toggle', function () { if (navMenu.open) closePops() })

  /**
   * 手机端"本页目录"的折叠状态：**默认折叠**（几十条链接展开着会把正文顶出屏幕一千多像素），
   * 但记住读者的选择——开过一次就一直开着，别每次进页面都替他合上。
   */
  // 简报开合也记在浏览器里：收起过就一直收着（收起不改写内容，只是不占首屏）
  var brief = document.getElementById('brief')
  if (brief) {
    var briefPref = store.get('course.briefOpen', '')
    if (briefPref === '0') brief.open = false
    else if (briefPref === '1') brief.open = true
    brief.addEventListener('toggle', function () { store.set('course.briefOpen', brief.open ? '1' : '0') })
  }
  var tocDetails = document.querySelector('.rail-toggle details')
  if (tocDetails) {
    var tocPref = store.get('course.tocOpen', '')
    if (tocPref === '1') tocDetails.open = true
    else if (tocPref === '0') tocDetails.open = false
    tocDetails.addEventListener('toggle', function () {
      store.set('course.tocOpen', tocDetails.open ? '1' : '0')
    })
  }

  /**
   * 临时提示条：异步动作（复制 / 导出 / 导入）必须当场有反馈——点了没反应，读者只会怀疑
   * "是不是没点到"。需要人工兜底时（剪贴板被浏览器拒绝）把文本放进一个**已选中**的
   * textarea：按 ⌘C 就能拿走，不用再点一次。
   */
  function toast (message, fallbackText) {
    var box = document.getElementById('toast')
    if (!box) {
      box = document.createElement('div')
      box.id = 'toast'
      box.setAttribute('role', 'status')
      box.setAttribute('aria-live', 'polite')
      box.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;' +
        'max-width:min(90vw,560px);padding:10px 14px;border-radius:10px;background:rgba(20,20,20,.92);' +
        'color:#fff;font-size:14px;line-height:1.5;opacity:0;transition:opacity .18s ease;pointer-events:none'
      document.body.appendChild(box)
    }
    box.innerHTML = ''
    box.style.pointerEvents = fallbackText ? 'auto' : 'none'
    var line = document.createElement('div')
    line.textContent = message
    box.appendChild(line)
    if (fallbackText) {
      var area = document.createElement('textarea')
      area.value = fallbackText
      area.setAttribute('readonly', 'readonly')
      area.rows = 3
      area.style.cssText = 'width:100%;margin-top:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace'
      box.appendChild(area)
      var tip = document.createElement('div')
      tip.style.cssText = 'margin-top:6px;opacity:.8;font-size:12px'
      tip.textContent = '按 ⌘C / Ctrl+C 复制上面这段'
      box.appendChild(tip)
      setTimeout(function () { area.focus(); area.select() }, 0)
    }
    box.style.opacity = '1'
    clearTimeout(box.__timer)
    box.__timer = setTimeout(function () { box.style.opacity = '0' }, fallbackText ? 12000 : 2600)
  }

  /**
   * 复制到剪贴板：**成功与失败只有这一处判断**。
   *
   * 整篇 Markdown 与小节链接都走它——两处各写一套的结果，就是一边如实报失败、
   * 另一边不等结果就报"已复制"（审计 R2）。失败时把文本放进可选中的 textarea 兜底。
   * 返回 Promise<boolean>：调用方据此决定要不要改按钮状态。
   */
  function copyToClipboard (text, okMessage) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast('复制失败：这个浏览器不给用剪贴板', text)
      return Promise.resolve(false)
    }
    return navigator.clipboard.writeText(text).then(function () {
      toast(okMessage || '已复制')
      return true
    }).catch(function (error) {
      toast('复制失败：' + ((error && error.message) || '浏览器拒绝了剪贴板权限'), text)
      return false
    })
  }

  if (tools) {
    // 挂在 document 上而不是 #tools 上：即使某次重绘换掉了按钮节点，点击也仍然能被接住
    document.addEventListener('click', function (event) {
      if (!event.target || !event.target.closest) return
      if (!event.target.closest('#tools')) return
      var button = event.target.closest('[data-tool]')
      // 必须限定成"色板按钮"：<html> 自己也带 data-paper（底色就是挂在根元素上的），
      // 用 closest('[data-paper]') 会把每一次点击都当成"选了某个颜色"——
      // 于是换成米黄色之后，整排工具栏全部失灵（只有原生行为的链接和折叠面板还活着）。
      var dot = event.target.closest('button.paper[data-paper]')
      // 选完颜色就把小浮层收起来：留着它会在某些窗口尺寸下盖住别的按钮
      if (dot) { applyPaper(dot.getAttribute('data-paper') || ''); closePops(); return }
      if (!button) return
      var tool = button.getAttribute('data-tool')
      var wrap = button.parentElement
      if (tool === 'theme') { applyTheme(root.getAttribute('data-theme') !== 'dark'); return }
      if (tool === 'focus') {
        // 一页纸页面没有 #reading：没有可收起的侧栏，直接忽略而不是抛错
        if (!reading) return
        var on = reading.classList.toggle('focus')
        button.setAttribute('aria-pressed', on ? 'true' : 'false')
        store.set('course.focus', on ? '1' : '')
        return
      }
      if (tool === 'print') { window.print(); return }
      if (tool === 'copy') {
        // 正文全文不内嵌在页面里（那会让 HTML 翻倍）：从发布时同时写出的 .md 取
        var link = document.querySelector('#tools a[download]')
        var done = function () {
          button.setAttribute('aria-pressed', 'true')
          setTimeout(function () { button.setAttribute('aria-pressed', 'false') }, 1200)
        }
        // 复制是异步的：先看状态码（404/503 的响应体是一段错误页，塞进剪贴板等于把错误页
        // 复制走），再看剪贴板权限（可能被拒）。两种情况都要当场说清楚，并给出人工兜底。
        var copyText = function (text) {
          return copyToClipboard(text, '已复制 Markdown').then(function (ok) { if (ok) done(); return ok })
        }
        if (link && window.fetch) {
          fetch(link.getAttribute('href')).then(function (res) {
            if (!res.ok) throw new Error('取正文失败（HTTP ' + res.status + '）')
            return res.text()
          }).then(copyText).catch(function (error) {
            toast((error && error.message) || '复制失败，稍后再试')
          })
        } else {
          copyText(document.querySelector('article').innerText)
        }
        return
      }
      if (tool === 'annot-export' || tool === 'annot-import') {
        var api = window.__courseAnnots
        if (!api) return
        if (tool === 'annot-export') api.exportAll()
        else api.importAll()
        return
      }
      if (tool === 'paper' || tool === 'font') {
        var open = wrap.classList.contains('open')
        closePops(true)
        closeNav()
        if (!open) {
          clearTimeout(wrap.__closeTimer)
          wrap.classList.remove('closing')
          wrap.classList.add('open')
        }
      }
    }, true)
  }
  var range = document.getElementById('fontRange')
  if (range) {
    range.value = store.get('course.fontScale', '1')
    range.addEventListener('input', function () { applyFont(range.value) })
  }
  if (store.get('course.focus', '') === '1' && reading) {
    reading.classList.add('focus')
    var focusButton = document.querySelector('[data-tool="focus"]')
    if (focusButton) focusButton.setAttribute('aria-pressed', 'true')
  }
  document.addEventListener('click', function (event) {
    if (!event.target.closest('#tools')) closePops()
    if (!event.target.closest('.navmenu')) closeNav()
  }, true)
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closeNav(); closePops() }
  })

  // ── 锚点高亮：跳过去、闪一下、底色留着 ──
  var HASH_KEY = 'course.marks:' + location.pathname
  function flash (node) {
    if (!node) return
    node.classList.remove('anchor-flash')
    // 强制重排再加类：重复点同一条目录时动画要能重放，不然第二次看不出闪
    void node.offsetWidth
    node.classList.add('anchor-flash')
    clearTimeout(node.__flashTimer)
    node.__flashTimer = setTimeout(function () { node.classList.remove('anchor-flash') }, 2600)
  }
  function goHash (smooth) {
    var id = decodeURIComponent(location.hash.replace(/^#/, ''))
    if (!id) return
    var node = document.getElementById(id)
    if (!node) return
    node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
    flash(node)
    highlightMarks(id)
  }

  /**
   * 锚点所在的"这一节"。
   *
   * 标题上的锚点拿到的是 <h2> 本身，只在那几个字里找术语等于白找：范围要扩到
   * 标题之后、下一个同级或更高级标题之前——这才是读者理解的"这一节"。
   */
  function sectionNodes (heading) {
    var level = Number(String(heading.tagName || '').replace('H', '')) || 6
    var nodes = [heading]
    var node = heading.nextElementSibling
    while (node) {
      var tag = String(node.tagName || '')
      if (/^H[1-6]$/.test(tag) && Number(tag.replace('H', '')) <= level) break
      nodes.push(node)
      node = node.nextElementSibling
    }
    return nodes
  }

  /** 概念高亮：从索引页跳进来时带着 ?mark=概念名，在正文里把命中的词标出来（不消失）。 */
  function highlightMarks (id) {
    var params = new URLSearchParams(location.search)
    var mark = params.get('mark')
    document.querySelectorAll('.mark-hit').forEach(function (node) {
      node.replaceWith(document.createTextNode(node.textContent))
    })
    if (!mark) return
    var anchor = id ? document.getElementById(id) : null
    var roots = anchor ? sectionNodes(anchor) : [document.querySelector('article')]
    var targets = []
    roots.forEach(function (root) {
      if (!root || !root.nodeType) return
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      while (walker.nextNode()) {
        var text = walker.currentNode.nodeValue || ''
        var parent = walker.currentNode.parentElement
        if (text.indexOf(mark) >= 0 && parent && ['A', 'CODE', 'SCRIPT', 'STYLE'].indexOf(parent.tagName) < 0) {
          targets.push(walker.currentNode)
        }
      }
    })
    targets.slice(0, 12).forEach(function (node) {
      var parts = node.nodeValue.split(mark)
      var fragment = document.createDocumentFragment()
      parts.forEach(function (part, index) {
        if (index) {
          var span = document.createElement('span')
          span.className = 'mark-hit'
          span.textContent = mark
          fragment.appendChild(span)
        }
        if (part) fragment.appendChild(document.createTextNode(part))
      })
      node.parentNode.replaceChild(fragment, node)
    })
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href^="#"]')
    if (link) {
      setTimeout(function () { goHash(true) }, 0)
      return
    }
    var tocLink = event.target.closest('.rail nav.toc a')
    if (tocLink) setTimeout(function () { goHash(true) }, 0)
  })
  window.addEventListener('hashchange', function () { goHash(true) })
  // 进来时定位要"钉住"：正文里有表格与图，字体与图落位后高度会变，
  // 只跳一次常会停在错的地方——所以再补两次（load 之后、以及稍晚一点）
  if (location.hash) {
    setTimeout(function () { goHash(true) }, 120)
    window.addEventListener('load', function () { setTimeout(function () { goHash(false) }, 60) })
    setTimeout(function () { goHash(false) }, 900)
  }

  // ── 划词批注：下划线 / 高亮 / 复制；存浏览器，下次进来还在 ──
  var ANNOT_KEY = 'course.annots:' + location.pathname
  var selbar = document.getElementById('selbar')
  var marks = []
  try { marks = JSON.parse(store.get(ANNOT_KEY, '[]')) || [] } catch (e) { marks = [] }
  // 批注锚定的全部算术都在 anchors.mjs 里（单测覆盖），这里只是把它接上 DOM。
  // 页面第一次拿到正文的版本号：正文重发之后值会变，用来在导出里说明"这条批注是对哪一版写的"。
  var REVISION = (document.querySelector('meta[name="course-revision"]') || {}).content || ''
  var unresolved = []

  function saveMarks () { store.set(ANNOT_KEY, JSON.stringify(marks)) }

  /**
   * 参与定位的文本节点：正文里除去链接/代码/脚本，以及**已经被批注包住**的片段
   * （不排除的话，第二次批注会把上一层的文本也数进去，区间整体偏移）。
   */
  function anchorNodes (root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
    var nodes = []
    while (walker.nextNode()) {
      var node = walker.currentNode
      var parent = node.parentElement
      if (!parent) continue
      if (['A', 'CODE', 'SCRIPT', 'STYLE'].indexOf(parent.tagName) >= 0) continue
      if (parent.closest && parent.closest('.annot')) continue
      nodes.push(node)
    }
    return nodes
  }

  /** 选区所在的小节根：往上找第一个带 id 的祖先（目录锚点），找不到就用整篇。 */
  function sectionRootOf (node) {
    var element = node && node.nodeType === 3 ? node.parentElement : node
    while (element && element !== document.body) {
      // 只认**正文小节**的 id：目录/侧栏里的 a 也带 id（那正是锚点跳到的地方），
      // 认了它就会把批注锚到"目录那一条"上——正文改版、目录重排之后就再也找不回来。
      var inChrome = element.closest && element.closest('nav, .rail, .toc, #tools, #selbar')
      if (element.id && element.tagName !== 'ARTICLE' && element.tagName !== 'A' && !inChrome) return element
      element = element.parentElement
    }
    return document.querySelector('article')
  }

  /** (container, offset) → 该小节文本里的绝对偏移。 */
  function offsetIn (nodes, container, offset) {
    var total = 0
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      if (node === container) return total + offset
      total += (node.nodeValue || '').length
    }
    // container 是元素节点时的兜底：取区间起点之前所有节点的长度
    return total
  }

  /** 造锚点：这是"下次能不能贴回原处"的全部依据。 */
  function anchorOf (range) {
    var root = sectionRootOf(range.startContainer)
    var nodes = anchorNodes(root || document.querySelector('article'))
    var collected = A.collectText(nodes.map(function (node) { return node.nodeValue || '' }))
    var start = offsetIn(nodes, range.startContainer, range.startOffset)
    var end = offsetIn(nodes, range.endContainer, range.endOffset)
    if (range.startContainer !== range.endContainer && start >= end) {
      // 跨节点选区：用 range.toString() 的长度兜底，至少别存成空区间
      end = start + range.toString().length
    }
    return A.anchorFromSelection({
      text: range.toString(),
      prefix: collected.text.slice(Math.max(0, start - 32), start),
      suffix: collected.text.slice(end, end + 32),
      sectionId: root && root.id ? root.id : '',
      start: start,
      end: end,
      kind: 'mark',
      revision: REVISION
    })
  }

  var KINDS = { underline: 'underline', mark: 'mark', bold: 'bold' }

  /**
   * 把一段区间包上批注。
   *
   * 跨行内元素的选择（一句话里夹着 strong 或链接）没法整段 surroundContents，
   * 旧实现直接放弃（collapse 一下什么都不标）。现在按文本节点切成若干片段，每段各包一个
   * span，全部带同一个 data-annot-id 属性——一条批注可以由多个片段组成，
   * 删除时按 id 一起删（不再靠"文字包含"猜）。
   */
  function wrapRange (range, kind, id, animate) {
    var root = sectionRootOf(range.startContainer) || document.querySelector('article')
    var nodes = anchorNodes(root)
    var collected = A.collectText(nodes.map(function (node) { return node.nodeValue || '' }))
    var start = offsetIn(nodes, range.startContainer, range.startOffset)
    var end = offsetIn(nodes, range.endContainer, range.endOffset)
    if (end <= start) end = start + range.toString().length
    var pieces = A.piecesForRange(collected.index, start, end)
    if (!pieces.length) {
      var single = document.createElement('span')
      single.className = 'annot annot-' + (KINDS[kind] || 'underline')
      single.setAttribute('data-annot-id', id)
      try { range.surroundContents(single); return single } catch (error) { return null }
    }
    var first = null
    // 从后往前包：替换节点会让后面片段的偏移失效
    pieces.slice().reverse().forEach(function (piece) {
      var node = nodes[piece.nodeIndex]
      if (!node || piece.end <= piece.start) return
      var target = document.createRange()
      target.setStart(node, piece.start)
      target.setEnd(node, piece.end)
      var span = document.createElement('span')
      span.className = 'annot annot-' + (KINDS[kind] || 'underline') + (animate ? ' animate' : '')
      span.setAttribute('data-annot-id', id)
      try { target.surroundContents(span); first = span } catch (error) {}
    })
    return first
  }

  /**
   * 选区里有没有这一类批注——有就是"再按一次取消"。
   *
   * 两种情况都要认：①选区落在批注内部（往上找祖先）；②选区把批注整个包住
   * （选中一整段时就是这种，祖先只是 <p>，只看祖先会漏，表现为"取消不掉"）。
   */
  function annotsInRange (range, kind) {
    var found = []
    var node = range.commonAncestorContainer
    if (node && node.nodeType === 3) node = node.parentNode
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('annot-' + kind)) {
        if (node.contains(range.startContainer) && node.contains(range.endContainer)) found.push(node)
        break
      }
      node = node.parentNode
    }
    var article = document.querySelector('article')
    if (article) {
      [].slice.call(article.querySelectorAll('.annot-' + kind)).forEach(function (element) {
        if (found.indexOf(element) >= 0) return
        // intersectsNode 对"选区包含批注"和"批注包含选区"都返回 true，正好是要的语义
        try { if (range.intersectsNode(element)) found.push(element) } catch (error) {}
      })
    }
    return found
  }

  function applyAnnotation (kind) {
    var selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    var text = selection.toString().trim()
    if (!text) return
    var range = selection.getRangeAt(0)

    // 同一个按钮再按一次 = 取消：把包着的 span 拆掉，并从本地记录里删掉
    var existing = annotsInRange(range, kind)
    if (existing.length) {
      var removedIds = []
      existing.forEach(function (element) {
        var id = element.getAttribute && element.getAttribute('data-annot-id')
        if (id && removedIds.indexOf(id) < 0) removedIds.push(id)
        var parent = element.parentNode
        if (!parent) return
        while (element.firstChild) parent.insertBefore(element.firstChild, element)
        parent.removeChild(element)
        parent.normalize()
      })
      // 按 id 删。旧实现按"文字包含"删：同一句话有两处批注时会一次删掉两条，
      // 而且删的可能是别处那条——读者看到的是"取消一条，另一条也没了"。
      marks = marks.filter(function (mark) {
        if (mark.kind !== kind) return true
        if (!mark.id) return true
        return removedIds.indexOf(mark.id) < 0
      })
      saveMarks()
      selection.removeAllRanges()
      hideSelbar()
      return
    }

    var anchor = anchorOf(range)
    anchor.kind = kind
    var span = wrapRange(range, kind, anchor.id, true)
    selection.removeAllRanges()
    if (!span) return
    marks.push({ kind: kind, anchor: anchor })
    saveMarks()
    hideSelbar()
  }

  /**
   * 按锚点把批注贴回正文。
   *
   * 四级定位（上下文 → 唯一出现 → 记录位置 → 空白归一）都在 anchors.mjs 里，这里只做
   * "文本区间 → DOM 节点片段"的映射。两条铁律：
   *   · 用了回退策略就标出来（data-reanchored + tooltip），读者知道这条批注的位置是猜的；
   *   · **找不到就保留记录**，只在工具栏上提示有几条没贴回来——批注是读者自己写的东西，
   *     不该因为一次正文改版被悄悄删掉。
   */
  function restore () {
    if (!marks.length) return
    var article = document.querySelector('article')
    if (!article) return
    var dirty = false
    marks.forEach(function (mark) {
      if (!mark.id) { mark.id = A.annotationId(); mark.kind = mark.kind || 'mark'; dirty = true }
      var anchor = A.normalizeAnchor(mark.anchor || {})
      var root = (anchor.sectionId && document.getElementById(anchor.sectionId)) || article
      var nodes = anchorNodes(root)
      var collected = A.collectText(nodes.map(function (node) { return node.nodeValue || '' }))
      var found = A.findAnchor(collected.text, anchor)
      if (!found) {
        if (unresolved.indexOf(mark.id) < 0) unresolved.push(mark.id)
        mark.unresolved = true
        dirty = true
        return
      }
      mark.unresolved = false
      mark.reanchored = found.reanchored === true
      var pieces = A.piecesForRange(collected.index, found.start, found.end)
      pieces.slice().reverse().forEach(function (piece) {
        var node = nodes[piece.nodeIndex]
        if (!node || piece.end <= piece.start) return
        var target = document.createRange()
        target.setStart(node, piece.start)
        target.setEnd(node, piece.end)
        var span = document.createElement('span')
        span.className = 'annot annot-' + (KINDS[mark.kind] || 'underline')
        span.setAttribute('data-annot-id', mark.id)
        if (found.reanchored) {
          span.setAttribute('data-reanchored', '1')
          span.title = '正文改过，这条批注按上下文重新定位'
        }
        try { target.surroundContents(span) } catch (error) {}
      })
    })
    if (dirty) saveMarks()
    if (unresolved.length && tools) {
      var note = document.createElement('span')
      note.className = 'annot-note'
      note.setAttribute('role', 'status')
      note.textContent = unresolved.length + ' 条批注没能在这一版正文里定位（记录已保留）'
      tools.appendChild(note)
    }
    renderMarkList()
  }

  /**
   * 「我的标记」列表：这一页的批注在哪、是什么、怎么回去。
   *
   * 批注是读过一趟留下的东西，没有列表就只能在正文里碰运气找回来。三条规矩：
   *   · 定位不到的那几条**照样列出来**（标"待重新定位"），它们仍在 localStorage 里，
   *     不该因为一次正文改版从读者眼前消失；
   *   · 删除按 id 走：同一句话在两处各有一条标记时，删一条不能连坐（旧实现按文字删过）；
   *   · 摘录用锚点里记下的原话，不改写、不上传。
   */
  function escHtml (value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    })
  }
  /** 标题里那个"#"是复制锚点的按钮，不是标题的一部分：取文字前先把它摘掉。 */
  function headingText (node) {
    if (!node) return ''
    var clone = node.cloneNode(true)
    var link = clone.querySelector ? clone.querySelector('a') : null
    if (link && link.parentNode) link.parentNode.removeChild(link)
    return String(clone.textContent || '').replace(/\s+/g, ' ').trim()
  }
  function sectionTitleById (id) {
    return id ? headingText(document.getElementById(id)) : ''
  }
  function sectionTitleOf (mark) {
    var node = document.querySelector('[data-annot-id="' + mark.id + '"]')
    if (!node) return ''
    var headings = document.querySelectorAll('article h2, article h3, article h4')
    var found = null
    for (var i = 0; i < headings.length; i += 1) {
      if (headings[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = headings[i]
    }
    return headingText(found)
  }
  function renderMarkList () {
    var panel = document.getElementById('railMarks')
    var list = document.getElementById('marksList')
    if (!panel || !list) return
    if (!marks.length) { panel.hidden = true; list.innerHTML = ''; return }
    panel.hidden = false
    var count = document.getElementById('marksCount')
    if (count) count.textContent = String(marks.length)
    list.innerHTML = marks.map(function (mark) {
      var anchor = mark.anchor || {}
      var text = String(anchor.text || '').replace(/\s+/g, ' ').trim()
      var excerpt = text.length > 48 ? text.slice(0, 48) + '…' : text
      var where = mark.unresolved ? '待重新定位' : (sectionTitleOf(mark) || sectionTitleById(anchor.sectionId) || '本页')
      return '<li' + (mark.unresolved ? ' class="mark-lost"' : '') + '>' +
        '<button type="button" class="mark-jump" data-mark-id="' + escHtml(mark.id) + '">' +
        '<span class="mark-kind">' + (mark.kind === 'mark' ? '高亮' : '下划线') + '</span>' +
        '<span class="mark-excerpt">' + escHtml(excerpt || '（没有摘录）') + '</span>' +
        '<span class="mark-where">' + escHtml(where) + '</span>' +
        '</button>' +
        '<button type="button" class="mark-drop" data-mark-id="' + escHtml(mark.id) + '" aria-label="删除这条标记">×</button>' +
        '</li>'
    }).join('')
  }
  function jumpToMark (id) {
    var node = document.querySelector('[data-annot-id="' + id + '"]')
    if (!node) { toast('这条标记还没能在这一版正文里定位，记录仍留在这台浏览器里'); return }
    try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (error) { node.scrollIntoView() }
    flash(node)
  }
  /** 删一条：按 id 删记录、按 id 拆 DOM，别的标记一条都不动。 */
  function dropMark (id) {
    var node = document.querySelector('[data-annot-id="' + id + '"]')
    if (node && node.parentNode) {
      // 保留正文本身：把标记用的 span 拆掉，文字还给段落
      while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node)
      node.parentNode.removeChild(node)
    }
    marks = marks.filter(function (mark) { return mark.id !== id })
    unresolved = unresolved.filter(function (item) { return item !== id })
    saveMarks()
    renderMarkList()
    toast('已删除这条标记')
  }
  var marksPanel = document.getElementById('railMarks')
  if (marksPanel) {
    marksPanel.addEventListener('click', function (event) {
      var jump = event.target.closest ? event.target.closest('.mark-jump') : null
      if (jump) { jumpToMark(jump.getAttribute('data-mark-id')); return }
      var drop = event.target.closest ? event.target.closest('.mark-drop') : null
      if (drop) dropMark(drop.getAttribute('data-mark-id'))
    })
  }

  /**
   * 「我的标记」入口：从标题下那一排点，或者从一页纸带 #railMarks 进来。
   *
   * 没有标记时**必须说一句**：列表在没标记时是隐藏的，跳到隐藏区域等于什么都没发生
   * （审计 R1 要的就是这个空状态）。所以先看面板在不在，再决定滚过去还是解释一句。
   */
  function revealMarks (scroll) {
    var panel = document.getElementById('railMarks')
    if (!panel || panel.hidden) { toast('这一页还没有标记：选中正文里的一句话就能做标记'); return }
    if (scroll !== false) {
      try { panel.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (error) { panel.scrollIntoView() }
    }
    var first = panel.querySelector('.mark-jump')
    if (first) first.focus()
  }
  var dockMarks = document.querySelector('[data-dock="marks"]')
  if (dockMarks) dockMarks.addEventListener('click', function () { revealMarks(true) })

  /**
   * 「返回一页纸」：**只接受已确认的站内页面**。
   *
   * 上下文是"上一步从一页纸点看原文"时写下的（见 onepage.mjs）。这里逐条校验：
   * 必须是 /onepage/ 开头的站内路径、不能带协议或双斜杠、而且要和**当前这一篇**对得上
   * （/onepage/X.html ↔ /notes/X.html）。任何一条不满足就不显示——宁愿少一个入口，
   * 也不要给一个跳去别处或死掉的返回按钮。
   */
  var obBack = document.getElementById('obBack')
  if (obBack) {
    var obContext = null
    try { obContext = JSON.parse(localStorage.getItem('course.obReturn') || 'null') } catch (error) { obContext = null }
    var noteTail = location.pathname.replace(/^\/notes\//, '').replace(/\.html$/, '')
    var onepagePath = obContext && typeof obContext.onepagePath === 'string' ? obContext.onepagePath : ''
    var validOnepage = onepagePath.indexOf('/onepage/') === 0 &&
      onepagePath.indexOf('//') < 0 && onepagePath.indexOf(':') < 0 &&
      onepagePath === '/onepage/' + noteTail + '.html'
    if (validOnepage) {
      var backBlock = String(obContext.block || '')
      obBack.setAttribute('href', onepagePath + (backBlock ? '#' + encodeURIComponent(backBlock) : ''))
      obBack.hidden = false
    }
  }

  /**
   * 标题上的"#"：把「页面地址 + 小节」复制走。
   *
   * 地址栏先改（保留阅读位置），按钮文字**等复制结果回来再改**：剪贴板被拒时保持 "#"，
   * 并把链接放进 toast 里的 textarea，读者按 ⌘C 就能自己拿走。
   */
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('[data-anchor-copy]') : null
    if (!link) return
    event.preventDefault()
    var id = link.getAttribute('data-anchor-copy') || ''
    var url = location.origin + location.pathname + '#' + id
    try { history.replaceState(null, '', '#' + id) } catch (error) {}
    copyToClipboard(url, '已复制小节链接').then(function (ok) {
      if (!ok) return
      link.textContent = '已复制'
      setTimeout(function () { link.textContent = '#' }, 1200)
    })
  })

  restore()
  // 从一页纸的「我的标记」跳进来：goHash 已经滚过去并闪了一下，这里只补空状态与焦点
  if (decodeURIComponent(location.hash.replace(/^#/, '')) === 'railMarks') revealMarks(false)

  /**
   * 导出 / 导入批注。
   *
   * 批注只存在这台浏览器的 localStorage 里（**不上传**：这是读者自己的批注，服务端没有
   * 也不该有）。换设备或清缓存之前可以导出一份 JSON 带走；导入按 id 合并，重复导入不会翻倍。
   */
  window.__courseAnnots = {
    // 排障用：把每条批注的锚点原样吐出来（哪一节、什么区间、有没有 reanchored/未定位）
    debug: function () {
      return marks.map(function (mark) {
        return {
          id: mark.id,
          kind: mark.kind,
          text: (mark.anchor && mark.anchor.text) || '',
          sectionId: (mark.anchor && mark.anchor.sectionId) || '',
          start: mark.anchor && mark.anchor.start,
          end: mark.anchor && mark.anchor.end,
          prefix: (mark.anchor && mark.anchor.prefix) || '',
          suffix: (mark.anchor && mark.anchor.suffix) || '',
          reanchored: mark.reanchored === true,
          unresolved: mark.unresolved === true
        }
      })
    },
    exportAll: function () {
      var payload = {
        kind: 'course-annotations',
        version: 1,
        page: location.pathname,
        revision: REVISION,
        exportedAt: new Date().toISOString(),
        unresolved: unresolved.length,
        marks: marks
      }
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      var url = URL.createObjectURL(blob)
      var link = document.createElement('a')
      link.href = url
      link.download = 'course-annotations' + location.pathname.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + '.json'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
    },
    importAll: function () {
      var input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.addEventListener('change', function () {
        var file = input.files && input.files[0]
        if (!file) return
        var reader = new FileReader()
        reader.onload = function () {
          var payload = null
          try { payload = JSON.parse(String(reader.result || '')) } catch (error) { payload = null }
          var incoming = payload && Array.isArray(payload.marks) ? payload.marks : null
          if (!incoming) { window.alert('这个文件里没有可导入的批注（期望 course-annotations 的 JSON）'); return }
          var known = {}
          marks.forEach(function (mark) { known[mark.id] = true })
          var added = 0
          incoming.forEach(function (mark) {
            if (!mark || !mark.anchor) return
            var id = mark.id || A.annotationId()
            if (known[id]) return
            known[id] = true
            marks.push({ id: id, kind: mark.kind || 'mark', anchor: mark.anchor })
            added += 1
          })
          saveMarks()
          // 重新贴一遍：新导入的批注只有立即显示出来，读者才知道导入成功了几条
          location.reload()
          void added
        }
        reader.readAsText(file)
      })
      input.click()
    }
  }

  function hideSelbar () { if (selbar) selbar.classList.remove('show') }
  function showSelbar (rect) {
    if (!selbar) return
    selbar.innerHTML = [
      '<button type="button" data-annot="bold" title="加粗（⌘B）" aria-label="加粗">' + ${JSON.stringify(ICON_BOLD)} + '</button>',
      '<button type="button" data-annot="underline" title="下划线（⌘U）" aria-label="下划线">' + ${JSON.stringify(ICON_UNDERLINE)} + '</button>',
      '<button type="button" data-annot="mark" title="高亮（⌘H）" aria-label="高亮">' + ${JSON.stringify(ICON_MARK)} + '</button>',
      '<button type="button" data-annot="copy" title="复制" aria-label="复制">' + ${JSON.stringify(ICON_COPY)} + '</button>'
    ].join('')
    selbar.classList.add('show')
    var top = rect.top + window.scrollY - selbar.offsetHeight - 8
    var left = rect.left + window.scrollX + rect.width / 2 - selbar.offsetWidth / 2
    selbar.style.top = Math.max(8, top) + 'px'
    selbar.style.left = Math.max(8, left) + 'px'
  }

  document.addEventListener('mouseup', function (event) {
    if (event.target.closest('#selbar') || event.target.closest('.tools')) return
    setTimeout(function () {
      var selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.toString().trim()) { hideSelbar(); return }
      var range = selection.getRangeAt(0)
      var article = document.querySelector('article')
      if (!article || !article.contains(range.commonAncestorContainer)) { hideSelbar(); return }
      showSelbar(range.getBoundingClientRect())
    }, 10)
  })
  document.addEventListener('mousedown', function (event) {
    if (!event.target.closest('#selbar')) hideSelbar()
  })
  if (selbar) {
    selbar.addEventListener('click', function (event) {
      var button = event.target.closest('[data-annot]')
      if (!button) return
      var kind = button.getAttribute('data-annot')
      if (kind === 'copy') {
        // 选区复制没有网络请求，但**剪贴板权限仍可能被拒**（http 页面、无用户手势、企业策略）。
        // 旧实现不接 Promise：被拒时一点反应都没有，读者以为复制成功了。
        var selected = window.getSelection().toString()
        if (!selected) { hideSelbar(); return }
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          toast('这个浏览器不给用剪贴板，请手动选择后按 ⌘C / Ctrl+C', selected)
          hideSelbar()
          return
        }
        navigator.clipboard.writeText(selected).then(function () {
          toast('已复制所选文字')
        }).catch(function (error) {
          toast('复制失败：' + ((error && error.message) || '浏览器拒绝了剪贴板权限'), selected)
        })
        hideSelbar()
        return
      }
      applyAnnotation(kind)
    })
  }
  document.addEventListener('keydown', function (event) {
    var meta = event.metaKey || event.ctrlKey
    if (!meta) return
    // 用 event.code 兜底：中文输入法下 event.key 可能不是 'b'（某些键盘布局/输入源尤其明显），
    // 快捷键"有时灵有时不灵"多半就是这里
    var key = (event.key || '').toLowerCase()
    var code = String(event.code || '')
    var hit = function (letter) { return key === letter || code === 'Key' + letter.toUpperCase() }
    if (hit('b')) { event.preventDefault(); applyAnnotation('bold') }
    else if (hit('u')) { event.preventDefault(); applyAnnotation('underline') }
    else if (hit('h')) { event.preventDefault(); applyAnnotation('mark') }
  })
})();
</script>`

