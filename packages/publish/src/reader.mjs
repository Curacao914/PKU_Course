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

export const READER_ICONS = {
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
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
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
 * 右上角工具栏。
 *
 * 导出两件事：**下载 Markdown**（发布时会为每篇笔记同时写出 .md）与打印成 PDF
 * （走浏览器自带的打印，页面上有打印样式）。刻意不做服务端 PDF 生成——
 * 那要在这台 2 核机器上装一套排版引擎，而读者的浏览器本来就会排版。
 */
export function toolBar(record = {}) {
  const fileName = `${String(record.slug || '').split('/').pop()}.md`
  return [
    '<div class="tools" id="tools">',
    `<a href="/md/${encodeURIComponent(fileName)}" download title="下载 Markdown" aria-label="下载 Markdown">${svgIcon('export')}</a>`,
    `<button type="button" data-tool="print" title="打印 / 存为 PDF" aria-label="打印或存为 PDF">${svgIcon('printer')}</button>`,
    `<button type="button" data-tool="copy" title="复制 Markdown" aria-label="复制 Markdown">${svgIcon('copy')}</button>`,
    `<button type="button" data-tool="focus" title="专注模式" aria-label="专注模式">${svgIcon('focus')}</button>`,
    // 日/夜各一个图标，用当前主题决定显示哪个（CSS 切，不在 JS 里换 innerHTML）
    `<button type="button" data-tool="theme" id="toolTheme" title="深浅色" aria-label="深浅色">` +
      `<span class="icon-sun">${svgIcon('sun')}</span><span class="icon-moon">${svgIcon('moon')}</span></button>`,
    '<div class="tool-wrap">',
    // 调色盘按钮里直接显示当前底色：不用点开就知道现在是什么颜色
    `<button type="button" data-tool="paper" title="背景色" aria-label="背景色">` +
      `<span class="swatch" id="paperSwatch"></span>${svgIcon('palette')}</button>`,
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

/** 左栏：本课程全部课次，点着就能换课。 */
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
export const READER_SCRIPT = '<script>' + String.raw`
(function () {
  var root = document.documentElement
  var reading = document.getElementById('reading')
  var tools = document.getElementById('tools')
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
    var button = document.getElementById('toolTheme')
    if (button) button.setAttribute('aria-pressed', dark ? 'true' : 'false')
  }
  function applyPaper (paper) {
    store.set('course.paper', paper || '')
    if (!paper || root.getAttribute('data-theme') === 'dark') root.removeAttribute('data-paper')
    else root.setAttribute('data-paper', paper)
    document.querySelectorAll('[data-paper]').forEach(function (dot) {
      dot.setAttribute('aria-pressed', dot.getAttribute('data-paper') === (paper || '') ? 'true' : 'false')
    })
    paintSwatch()
  }
  /** 调色盘按钮里的圆点 = 当前实际底色。取算出来的值，免得色板和页面各说各话。 */
  function paintSwatch () {
    var swatch = document.getElementById('paperSwatch')
    if (!swatch) return
    var value = getComputedStyle(root).getPropertyValue('--bg').trim()
    swatch.style.background = value || '#ffffff'
  }
  window.addEventListener('resize', function () { setTimeout(paintSwatch, 0) })
  function applyFont (scale) {
    var value = Math.min(1.4, Math.max(0.85, Number(scale) || 1))
    root.style.setProperty('--font-scale', String(value))
    store.set('course.fontScale', String(value))
    var range = document.getElementById('fontRange')
    if (range) range.value = String(value)
  }

  applyTheme(store.get('course.theme', 'light') === 'dark')
  applyPaper(store.get('course.paper', ''))
  applyFont(store.get('course.fontScale', '1'))
  paintSwatch()

  function closePops () {
    document.querySelectorAll('.tool-wrap.open').forEach(function (node) { node.classList.remove('open') })
  }
  // 顶栏的站点导航是个 <details>：原生不会"点别处就收起"，点开之后会一直盖在
  // 工具栏的小框上。这里手动收——点外面、按 Esc、或打开别的浮层时都收起。
  var navMenu = document.querySelector('.navmenu')
  function closeNav () { if (navMenu && navMenu.open) navMenu.open = false }
  if (navMenu) navMenu.addEventListener('toggle', function () { if (navMenu.open) closePops() })

  if (tools) {
    tools.addEventListener('click', function (event) {
      var button = event.target.closest('[data-tool]')
      var dot = event.target.closest('[data-paper]')
      if (dot) { applyPaper(dot.getAttribute('data-paper') || ''); return }
      if (!button) return
      var tool = button.getAttribute('data-tool')
      var wrap = button.parentElement
      if (tool === 'theme') { applyTheme(root.getAttribute('data-theme') !== 'dark'); paintSwatch(); return }
      if (tool === 'focus') {
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
        if (link && window.fetch) {
          fetch(link.getAttribute('href')).then(function (res) { return res.text() }).then(function (text) {
            if (navigator.clipboard) navigator.clipboard.writeText(text)
            done()
          }).catch(function () { done() })
        } else {
          if (navigator.clipboard) navigator.clipboard.writeText(document.querySelector('article').innerText)
          done()
        }
        return
      }
      if (tool === 'paper' || tool === 'font') {
        var open = wrap.classList.contains('open')
        closePops()
        closeNav()
        if (!open) wrap.classList.add('open')
      }
    })
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

  function saveMarks () { store.set(ANNOT_KEY, JSON.stringify(marks)) }

  /** 用"文本 + 前后文"定位：笔记将来重新生成、文字略有变动时也能大概率找回。 */
  function anchorOf (range) {
    var article = document.querySelector('article')
    var full = article.innerText
    var text = range.toString()
    var index = full.indexOf(text)
    return {
      text: text,
      before: index > 0 ? full.slice(Math.max(0, index - 24), index) : '',
      after: index >= 0 ? full.slice(index + text.length, index + text.length + 24) : ''
    }
  }

  var KINDS = { underline: 'underline', mark: 'mark', bold: 'bold' }

  function wrapRange (range, kind, animate) {
    var span = document.createElement('span')
    span.className = 'annot annot-' + (KINDS[kind] || 'underline') + (animate ? ' animate' : '')
    try { range.surroundContents(span) } catch (e) {
      // 跨元素的选择没法整段包起来：退化成"只标记首段"，总比丢掉强
      try { range.collapse(true); return null } catch (e2) { return null }
    }
    return span
  }

  function applyAnnotation (kind) {
    var selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    var text = selection.toString().trim()
    if (!text) return
    var range = selection.getRangeAt(0)
    var anchor = anchorOf(range)
    var span = wrapRange(range, kind, true)
    selection.removeAllRanges()
    if (!span) return
    marks.push({ kind: kind, anchor: anchor })
    saveMarks()
    hideSelbar()
  }

  function restore () {
    if (!marks.length) return
    var article = document.querySelector('article')
    if (!article) return
    marks.forEach(function (mark) {
      var needle = (mark.anchor && mark.anchor.text) || ''
      if (!needle) return
      var walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null)
      while (walker.nextNode()) {
        var node = walker.currentNode
        var value = node.nodeValue || ''
        var at = value.indexOf(needle)
        if (at < 0) continue
        if (node.parentElement && node.parentElement.classList.contains('annot')) break
        var range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        wrapRange(range, mark.kind, false)
        break
      }
    })
  }
  restore()

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
        var text = window.getSelection().toString()
        if (navigator.clipboard) navigator.clipboard.writeText(text)
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

