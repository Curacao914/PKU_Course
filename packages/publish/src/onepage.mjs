import { escapeHtml, renderMarkdown } from './markdown.mjs'
import { lessonDock, svgIcon } from './reader.mjs'
import { onepageBlocks, verifySourceMap } from './sourcemap.mjs'

/**
 * 一页纸视图：左侧同一课程的课次（点着换页），右侧同一份内容，两种看法。
 *
 * 三条硬要求（都来自用户）：
 *   1. **阅读模式是默认**：手机上自然纵排、正文 17px 基准，字号**跟随全局滑块即时变化**。
 *      一页纸首先是给人读的；把手机上读的字缩成 11.5px 去凑一张纸的版式，是把版式的重要性
 *      放在了读者前面。
 *   2. **A4 预览是另一种看法，不是唯一看法**：纸张尺寸写死 A4、按纸张自动缩放，
 *      缩到底还放不下就**如实标出来**（该回去删内容，而不是继续缩成蚂蚁字，也不是裁掉半截）。
 *   3. **两者共用同一份内容**：切换显示方式不重新请求、不改写正文，只换样式与量尺。
 *
 * 旧实现的问题（审计实测）：手机单栏但正文仍是 11.5px * --sheet-scale，fit() 只在初始化与
 * 打印前跑，且把用户字号限制在 0.85—1.15。于是"页面里把字号调到 140%"对正文毫无影响。
 */
export function renderOnepagePage(record = {}, { siteOrigin = '', courseLessons = [] } = {}) {
  const onepage = record.onepage || {}
  const sheetTitle = onepage.title || record.lessonTitle || ''
  const noteHref = `/${String(record.slug || '').replace(/^\/+/, '')}.html`
  const blocks = onepageBlocks(onepage.markdown || '')
  /**
   * 渲染这一侧只做**轻核对**：块还在不在、小节还在不在（发布库里有 sections，没有正文）。
   * 逐字核对"摘录确实在这一节里"发生在发布链路里——那里才有正文（见 commands.mjs）。
   * 任何一条对不上就退回整篇入口，绝不显示一个看着精确的错误链接。
   */
  const sourceMap = verifySourceMap(onepage.sourceMap || null, {
    slug: record.slug || '',
    onepageMarkdown: onepage.markdown || '',
    sections: (record.sections || []).map(section => ({ id: section.id, title: section.title }))
  })
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
    '<div class="sheet-wrap" id="sheetWrap" data-sheet-mode="read">',
    '<div class="onepage-actions">',
    // 本课次入口与显示方式属于同一层控制，宽屏放在同一行，窄屏自然换行。
    lessonDock(record, { current: 'onepage' }),
    '<div class="sheet-tools" id="sheetTools" role="group" aria-label="一页纸显示方式">',
    '<button type="button" data-sheet-mode="read" aria-pressed="true">阅读模式</button>',
    '<button type="button" data-sheet-mode="a4" aria-pressed="false">A4 预览</button>',
    '<span class="sheet-state" id="sheetState" aria-live="polite"></span>',
    '</div>',
    '</div>',
    '<article class="sheet" id="sheet" data-mode="read">',
    `<h1 class="sheet-title">${escapeHtml(sheetTitle)}</h1>`,
    `<div class="sheet-body" id="sheetBody">${renderOnepageBody(blocks, sourceMap, { noteHref })}</div>`,
    `<div class="sheet-foot">${escapeHtml(record.courseName || '')} · ${escapeHtml(record.lessonTitle || '')}</div>`,
    '</article>',
    unmappedNote({ total: blocks.length, located: sourceMap.located, noteHref }),
    '</div>',
    ONEPAGE_SCRIPT
  ].filter(Boolean).join('\n')

  return { body }
}

/**
 * 一页纸正文：**每块一个 data-ob**，有来源的块跟一条"看原文"。
 *
 * 为什么要有块这一层：来源映射是"块 → 小节"的关系，回跳也要能落回**具体的块**而不是
 * 页首。块的切法与映射共用 onepageBlocks()，所以页面上的 data-ob 与映射里的 block
 * 一定对得上（对不上就说明正文改过，那时映射已经整体失效）。
 *
 * 入口刻意做得小：它是"想深究时的一条路"，不是这页纸上的按钮墙。
 */
function renderOnepageBody(blocks = [], sourceMap = {}, { noteHref = '' } = {}) {
  const byBlock = new Map((sourceMap.entries || []).map(entry => [entry.block, entry]))
  const usedHeadingIds = new Map()
  return blocks.map(block => {
    const html = dedupeHeadingIds(renderMarkdown(block.text), usedHeadingIds)
    // 标题块不配入口：标题本身就是结构，给它挂"看原文"会让每一节都长出一排链接
    const entry = block.kind === 'heading' ? null : byBlock.get(block.id)
    return `<div class="ob ob-${escapeHtml(block.kind)}" data-ob="${escapeHtml(block.id)}">` +
      html + sourceEntry(entry, { noteHref, blockId: block.id }) + '</div>'
  }).join('\n')
}

/** 同一页里重复的小节标题：第二个起加 -2/-3，与整篇笔记的规则一致（否则锚点只能落到第一处）。 */
function dedupeHeadingIds(html, used) {
  return String(html).replace(/<h([1-6]) id="([^"]+)"/g, (match, level, id) => {
    const seen = (used.get(id) || 0) + 1
    used.set(id, seen)
    return seen === 1 ? match : `<h${level} id="${escapeHtml(id)}-${seen}"`
  })
}

/** 一条（或几条）来源。多来源用紧凑弹出列表：真综合了几节时给出选择，不随意挑一节代表全部。 */
function sourceEntry(entry, { noteHref = '', blockId = '' } = {}) {
  if (!entry || !Array.isArray(entry.sections) || !entry.sections.length) return ''
  const linkOf = section => {
    const href = `${noteHref}#${encodeURIComponent(section.id)}`
    const title = section.title || section.id
    return `<a class="ob-link" href="${escapeHtml(href)}" data-ob-from="${escapeHtml(blockId)}" ` +
      `data-ob-section="${escapeHtml(section.id)}">${escapeHtml(title)}` +
      (section.excerpt ? `<span class="ob-quote">${escapeHtml(section.excerpt)}</span>` : '') +
      '</a>'
  }
  if (entry.sections.length === 1) {
    return `<p class="ob-source"><span class="ob-label">看原文</span>${linkOf(entry.sections[0])}</p>`
  }
  return `<details class="ob-source ob-multi"><summary>看原文 · ${entry.sections.length} 处</summary>` +
    `<ol class="ob-list">${entry.sections.map(section => `<li>${linkOf(section)}</li>`).join('')}</ol></details>`
}

/**
 * 没定位到的块：**说清楚**，并给整篇入口。
 *
 * 一页纸上大部分块都能定位时不该出现这一行；出现时它说的是"这几个要点我没能确认依据在哪"——
 * 读者据此决定要不要翻整篇，而不是被一个看着精确的链接骗过去。
 */
function unmappedNote({ total = 0, located = 0, noteHref = '' } = {}) {
  const missing = Math.max(0, Number(total) - Number(located))
  if (!missing) return ''
  return `<p class="ob-unmapped">本页有 ${missing} 个要点未能定位到具体小节（未做依据核对），` +
    `<a href="${escapeHtml(noteHref)}">查看整篇笔记</a>。</p>`
}

/**
 * 显示方式与量尺。
 *
 * 阅读模式**不需要脚本**：字号就是 `calc(17px * var(--font-scale))`，读者拖滑块时浏览器
 * 自己就重算了，没有"监听字号变化"这一层可以漏。
 *
 * 纸张模式才有算术：A4 是固定的，内容要迁就纸——缩到 0.72 还放不下就停手并标记出来。
 * 字号变、窗口大小变、打印前都要重新量一次；打印时无论当前是哪种模式，都按纸张输出。
 */
export const ONEPAGE_SCRIPT = `<script>
(function () {
  var sheet = document.getElementById('sheet')
  var body = document.getElementById('sheetBody')
  var tools = document.getElementById('sheetTools')
  var state = document.getElementById('sheetState')
  if (!sheet || !body) return
  var KEY = 'course.onepageMode'
  var mode = 'read'
  try { if (localStorage.getItem(KEY) === 'a4') mode = 'a4' } catch (error) {}
  var pending = null

  function save (value) { try { localStorage.setItem(KEY, value) } catch (error) {} }
  function overflows () {
    return body.scrollWidth > body.clientWidth + 2 || body.scrollHeight > body.clientHeight + 2
  }
  function userScale () {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1
  }
  function reduceMotion () {
    try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (error) { return false }
  }

  // ── 来源映射的往返 ──
  // 点"看原文"时记下：从哪一页的哪一块走的、滚到哪。原文那边据此给出「返回一页纸」，
  // 本页据此在回来时落回那一块——而不是回到页首让读者自己再找一遍。
  var RETURN_KEY = 'course.obReturn'
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('.ob-link') : null
    if (!link) return
    try {
      localStorage.setItem(RETURN_KEY, JSON.stringify({
        onepagePath: location.pathname,
        noteHref: link.getAttribute('href') || '',
        block: link.getAttribute('data-ob-from') || '',
        sectionId: link.getAttribute('data-ob-section') || '',
        scrollY: Math.round(window.scrollY || 0),
        sheetMode: sheet.getAttribute('data-mode'),
        at: Date.now()
      }))
    } catch (error) {}
  })
  function blockNode (id) {
    if (!id) return null
    // 块 ID 只可能是 ob-<8 位十六进制>（可能带 -2 后缀）：用白名单过滤后再拼进选择器。
    // 这里原先写的是正则转义（["\\]），而它在一层模板串里被折叠成了 /["\]/ ——
    // 一个没闭合的正则，整个一页纸脚本当场不执行（字号、模式开关、"看原文"全哑）。
    var safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '')
    return safe ? document.querySelector('[data-ob="' + safe + '"]') : null
  }
  function flashBlock (node) {
    if (!node || reduceMotion()) return
    node.classList.remove('ob-flash')
    void node.offsetWidth
    node.classList.add('ob-flash')
    setTimeout(function () { node.classList.remove('ob-flash') }, 2400)
  }
  function restorePlace () {
    var hashId = ''
    try { hashId = decodeURIComponent(String(location.hash || '').replace(/^#/, '')) } catch (error) { hashId = '' }
    var withHash = blockNode(hashId)
    if (withHash) {
      try { withHash.scrollIntoView({ block: 'center', behavior: 'auto' }) } catch (error) { withHash.scrollIntoView() }
      flashBlock(withHash)
      return
    }
    var saved = null
    try { saved = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null') } catch (error) { saved = null }
    if (!saved || saved.onepagePath !== location.pathname) return
    // 只用一次：否则下次直接打开这一页又会被拽去上次那一块
    try { localStorage.removeItem(RETURN_KEY) } catch (error) {}
    if (Date.now() - Number(saved.at || 0) > 6 * 60 * 60 * 1000) return
    var node = blockNode(saved.block)
    if (node) {
      try { node.scrollIntoView({ block: 'center', behavior: 'auto' }) } catch (error) { node.scrollIntoView() }
      flashBlock(node)
    } else if (saved.scrollY) {
      window.scrollTo(0, saved.scrollY)
    }
  }

  /** 纸张模式：起始字号跟随全局字号（限制在 0.85—1.15），放不下继续缩，缩不动就标记。 */
  function fit () {
    var scale = Math.max(0.85, Math.min(1.15, userScale()))
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

  /** 纸张模式的状态：缩放多少、放不放得下——读者要能看见"为什么字变小了"。 */
  function report (result) {
    if (!state) return
    if (mode !== 'a4') { state.textContent = ''; return }
    var parts = ['纸张缩放 ' + Math.round(result.scale * 100) + '%']
    if (result.tight) parts.push('内容超出 A4，请精简这一页')
    else if (userScale() !== 1) parts.push('纸张固定 A4，字号按纸缩放；想按自己的字号读请用阅读模式')
    state.textContent = parts.join(' · ')
  }

  function repaint () {
    sheet.setAttribute('data-mode', mode)
    // 包装元素上也记一份模式：未定位说明、来源入口这些都渲染在纸张之外，
    // 纸张模式与打印里它们一个都不该出现（纸上只有那张 A4）
    var wrap = document.getElementById('sheetWrap')
    if (wrap) wrap.setAttribute('data-sheet-mode', mode)
    if (tools) {
      [].slice.call(tools.querySelectorAll('button[data-sheet-mode]')).forEach(function (button) {
        button.setAttribute('aria-pressed', button.getAttribute('data-sheet-mode') === mode ? 'true' : 'false')
      })
    }
    if (mode === 'a4') report(fit())
    else if (state) state.textContent = ''
  }

  /** 一批变化里只量一次：拖字号滑块会连着触发几十次。 */
  function schedule () {
    if (pending) return
    pending = requestAnimationFrame(function () { pending = null; repaint() })
  }

  repaint()
  restorePlace()
  if (tools) {
    tools.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-sheet-mode]')
      if (!button) return
      mode = button.getAttribute('data-sheet-mode') === 'a4' ? 'a4' : 'read'
      save(mode)
      repaint()
    })
  }
  // 字号改动：工具栏滑块改的是 documentElement 上的 --font-scale，盯属性比盯着某个控件稳
  // （顶栏与设置浮层各有一个滑块）。
  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  }
  window.addEventListener('resize', schedule)
  // 打印前重新量一次，并**按纸张输出**：屏幕上选的是阅读模式，纸上也必须是那张 A4。
  var restore = null
  window.addEventListener('beforeprint', function () {
    if (restore === null) restore = mode
    mode = 'a4'
    repaint()
  })
  window.addEventListener('afterprint', function () {
    if (restore !== null) { mode = restore; restore = null }
    repaint()
  })
})();
</script>`

/**
 * 一页纸样式：一套内容，两种看法。
 *
 * 共享的只有变量（--font-scale / --line / --card-bg…），排版数值两边各写一套——
 * 让"纸上的 11.5px 三栏"和"屏幕上的 17px 单栏"互相迁就，结果只会是两个都不好用。
 */
export const ONEPAGE_CSS = `
/* ── 一页纸：左侧课次 + 右侧同一份内容 ── */
.onepage { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); gap: 26px;
  max-width: 1320px; margin: 0 auto; padding: 22px 22px 60px; align-items: start; }
.onepage .rail { position: sticky; top: calc(var(--header-h) + 18px); align-self: start;
  max-height: calc(100vh - var(--header-h) - 36px); overflow-y: auto; }
.onepage-chars { color: var(--muted); font-size: 11.5px; margin-left: 6px; }
.sheet-wrap { min-width: 0; }

/* 两组控制在同一工具行：左边是原笔记/一页纸/我的标记，右边是阅读模式/A4 预览。 */
.onepage-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;
  max-width: 210mm; margin: 0 auto 12px; }
.onepage-actions .lesson-dock { margin: 0; }
.onepage-actions .sheet-tools { max-width: none; margin: 0; }
/* ── 来源映射：块的包装 + "看原文" ── */
.sheet-body .ob { margin: 0; }
.sheet-body .ob-source { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px;
  margin: 4px 0 16px; font-family: var(--sans); font-size: calc(13px * var(--font-scale)); }
.sheet-body .ob-label { color: var(--muted); }
.sheet-body .ob-link { color: var(--accent-ink); text-decoration: none;
  border-bottom: 1px solid var(--accent-soft); padding-bottom: 1px; }
.sheet-body .ob-link:hover { border-bottom-color: var(--accent); }
.sheet-body .ob-quote { display: block; margin-top: 3px; color: var(--muted); font-size: .92em; line-height: 1.5; }
.sheet-body .ob-multi { margin: 4px 0 16px; font-family: var(--sans);
  font-size: calc(13px * var(--font-scale)); }
.sheet-body .ob-multi > summary { cursor: pointer; color: var(--accent-ink); }
.sheet-body .ob-multi[open] > summary { margin-bottom: 6px; }
.sheet-body .ob-list { list-style: none; margin: 0; padding: 0; }
.sheet-body .ob-list li { margin: 0 0 8px; }
.ob-unmapped { max-width: 74ch; margin: 14px auto 0; font-family: var(--sans); font-size: 13px;
  line-height: 1.6; color: var(--muted); }
.ob-unmapped a { color: var(--accent-ink); }
/* 回到这一块时轻量提示一下（不闪、不跳，只是让眼睛知道落在哪） */
.ob-flash { animation: obFlash 2.4s ease-out 1; }
@keyframes obFlash { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
/* 纸张模式与打印里没有交互控件：纸上只有那张 A4，映射不许把能放下的纸撑成多页 */
.sheet[data-mode="a4"] .ob-source,
[data-sheet-mode="a4"] .ob-unmapped { display: none; }
.sheet-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 210mm;
  margin: 0 auto 12px; }
.sheet-tools button { font: inherit; font-size: 13px; padding: 6px 12px; min-height: 34px; cursor: pointer;
  border: 1px solid var(--line); border-radius: 999px; background: var(--card-bg); color: var(--ink-soft); }
.sheet-tools button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent);
  color: var(--accent-ink); font-weight: 600; }
.sheet-state { font-size: 12.5px; color: var(--muted); }

.sheet { width: 100%; margin: 0 auto; padding: 12mm 11mm 9mm; display: flex; flex-direction: column;
  font-family: var(--sans); background: var(--card-bg); border: 1px solid var(--line); border-radius: 6px;
  box-shadow: var(--shadow-md); }

/* ── 阅读模式（默认）：字号跟随全局滑块，正文 17px 基准 ── */
.sheet[data-mode="read"] { max-width: 74ch; padding: 0; gap: 0; display: block; background: transparent;
  border: 0; box-shadow: none; overflow: visible; }
.sheet[data-mode="read"] .sheet-title { margin: 0 0 18px; font-size: calc(22px * var(--font-scale));
  line-height: 1.35; letter-spacing: -.01em; }
.sheet[data-mode="read"] .sheet-body { font-size: calc(17px * var(--font-scale)); line-height: 1.78;
  overflow: visible; column-count: auto; column-gap: normal; }
.sheet[data-mode="read"] .sheet-body h2 { font-size: calc(19px * var(--font-scale)); margin: 26px 0 10px;
  padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.sheet[data-mode="read"] .sheet-body h3 { font-size: calc(17px * var(--font-scale)); margin: 20px 0 8px;
  color: var(--ink-soft); }
.sheet[data-mode="read"] .sheet-body p { margin: 0 0 12px; }
.sheet[data-mode="read"] .sheet-body ul, .sheet[data-mode="read"] .sheet-body ol { margin: 0 0 14px;
  padding-left: 24px; }
.sheet[data-mode="read"] .sheet-body li { margin: 0 0 6px; }
.sheet[data-mode="read"] .sheet-body blockquote { margin: 0 0 14px; padding: 10px 16px;
  font-size: calc(16px * var(--font-scale)); }
.sheet[data-mode="read"] .sheet-body code { font-size: .92em; }
.sheet[data-mode="read"] .sheet-foot { margin-top: 26px; padding-top: 12px;
  font-size: calc(13px * var(--font-scale)); }
/* 长表格只在自己这块里横滚，整页不横移 */
.sheet-body table { width: 100%; border-collapse: collapse; margin: 0 0 18px;
  display: block; overflow-x: auto; max-width: 100%; }
.sheet-body th, .sheet-body td { border: 1px solid var(--line); padding: 6px 10px; text-align: left;
  vertical-align: top; }
.sheet-body th { background: var(--bg-soft); font-weight: 600; }
.sheet[data-mode="read"] .sheet-body table { font-size: calc(15px * var(--font-scale)); }

/* ── A4 预览：纸张固定，内容迁就纸 ── */
.sheet[data-mode="a4"] { --sheet-scale: 1; max-width: 210mm; aspect-ratio: 210 / 297; overflow: hidden; }
.sheet[data-mode="a4"] .sheet-title { margin: 0 0 4mm; font-size: calc(17px * var(--sheet-scale));
  line-height: 1.35; letter-spacing: -.01em; }
.sheet[data-mode="a4"] .sheet-body { flex: 1; min-height: 0; column-count: 3; column-gap: 6mm;
  font-size: calc(11.5px * var(--sheet-scale)); line-height: 1.62; overflow: hidden; }
.sheet[data-mode="a4"] .sheet-body h2 { font-size: calc(13px * var(--sheet-scale)); margin: 0 0 2mm;
  padding-bottom: 1mm; border-bottom: 1px solid var(--line); break-after: avoid; }
.sheet[data-mode="a4"] .sheet-body h3 { font-size: calc(12px * var(--sheet-scale)); margin: 2.5mm 0 1mm;
  color: var(--ink-soft); break-after: avoid; }
.sheet[data-mode="a4"] .sheet-body p { margin: 0 0 1.6mm; }
.sheet[data-mode="a4"] .sheet-body ul, .sheet[data-mode="a4"] .sheet-body ol { margin: 0 0 2mm;
  padding-left: 4.6mm; }
.sheet[data-mode="a4"] .sheet-body li { margin: 0 0 .8mm; }
.sheet[data-mode="a4"] .sheet-body table { font-size: calc(10.5px * var(--sheet-scale)); display: table;
  table-layout: fixed; }
.sheet[data-mode="a4"] .sheet-body th, .sheet[data-mode="a4"] .sheet-body td { padding: .9mm 1.4mm; }
.sheet[data-mode="a4"] .sheet-body blockquote { margin: 0 0 2mm; padding: 1.4mm 2.4mm; background: var(--bg-soft);
  border-left: 2px solid var(--accent); font-size: calc(11px * var(--sheet-scale)); }
.sheet[data-mode="a4"] .sheet-body code { font-family: ui-monospace, Menlo, monospace;
  background: var(--bg-sunken); padding: 0 1mm; border-radius: 3px; }
.sheet[data-mode="a4"] .sheet-foot { margin-top: 3mm; padding-top: 1.6mm; border-top: 1px solid var(--line);
  color: var(--muted); font-size: calc(10px * var(--sheet-scale)); }
/* 缩到底还是放不下：如实标出来（该回去删内容，而不是继续缩成蚂蚁字） */
.sheet[data-mode="a4"][data-overflow="1"] { border-color: var(--warn); }
.sheet[data-mode="a4"][data-overflow="1"] .sheet-foot::after { content: " · 内容超出 A4，请精简";
  color: var(--warn); }
@media (max-width: 1100px) { .sheet[data-mode="a4"] .sheet-body { column-count: 2; } }
@media (max-width: 900px) {
  .onepage { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px 14px 60px; }
  .onepage .rail { position: static; max-height: none; order: 2; }
  .sheet-tools { justify-content: flex-start; }
  /* 手机上的纸张模式仍是一张真 A4 的缩样（保持比例，放不下就标记），只是提醒读者
     日常阅读该用阅读模式——把"纸张"拉长成一条不算预览。 */
  .sheet[data-mode="a4"] .sheet-body { column-count: 1; }
}
@media print {
  @page { size: A4; margin: 8mm; }
  .topbar, .rail, .tools, .totop, .sheet-tools, .sheet-state { display: none !important; }
  .onepage { display: block; max-width: none; padding: 0; }
  .sheet, .sheet[data-mode="read"], .sheet[data-mode="a4"] { max-width: none !important; width: auto;
    aspect-ratio: auto !important; border: 0 !important; box-shadow: none !important; padding: 0 !important;
    background: #fff !important; display: block !important; overflow: visible !important; }
  .sheet-title { font-size: calc(17px * var(--sheet-scale, 1)) !important; margin: 0 0 4mm !important; }
  .sheet-body { font-size: calc(11.5px * var(--sheet-scale, 1)) !important; line-height: 1.62 !important;
    column-count: 3 !important; column-gap: 6mm !important; overflow: visible !important; }
  .sheet-body h2 { font-size: calc(13px * var(--sheet-scale, 1)) !important; margin: 0 0 2mm !important; }
  .sheet-body h3 { font-size: calc(12px * var(--sheet-scale, 1)) !important; }
  .sheet-body p { margin: 0 0 1.6mm !important; }
  .sheet-body table { display: table !important; table-layout: fixed; font-size: calc(10.5px * var(--sheet-scale, 1)) !important; }
  .sheet-body th, .sheet-body td { padding: .9mm 1.4mm !important; }
  .sheet-body blockquote { font-size: calc(11px * var(--sheet-scale, 1)) !important; }
  .sheet-foot { font-size: calc(10px * var(--sheet-scale, 1)) !important; }
  .ob-source, .ob-unmapped { display: none !important; }
  body { background: #fff; }
}
`;
