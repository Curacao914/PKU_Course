/**
 * 管理台页面。
 *
 * 三块，按"一类操作一个区"：
 *   概览 —— 现在要我做什么（待办 + 数字 + 花费 + 推送通道）
 *   课程 —— 访达分栏式：筛选栏 | 课程 | 课次 | 详情
 *   设置 —— 维护动作 + 运行参数 + 存储占用 + 密码 + 清理
 *
 * 两条来自用户的硬要求（这一版重做的起因）：
 *   1. **不要再竖排下拉**。"后续课程内容多起来，像现在这样点开纵排展开根本没法管"——
 *      所以课程区改成横向分栏：点课程看课次、点课次看详情，一屏之内横向推进。
 *   2. **不要再出现元说明**。"这种元内容（前端出现的莫名其妙的解释和对话内容）不要出现"——
 *      界面上只留数据与控件，解释写在文档里。
 *
 * 另外三条一直有效的规矩：点下去必须当场有反应（置灰 + 状态灯 + 提示）；
 * 折叠状态跨重绘保持（20 秒轮询会重绘整页）；异步异常一律露面。
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>课程笔记 · 管理台</title>
<style>
:root{
  --bg:#fbfbfd;--card:#fff;--sunken:#f5f5f7;--ink:#1d1d1f;--ink-2:#6e6e73;--ink-3:#86868b;
  --line:#e8e8ed;--line-2:#d2d2d7;--accent:#2f6f61;--accent-ink:#245a4f;--accent-soft:#eef4f2;
  --danger:#b3261e;--danger-soft:#fdecea;--warn:#8a5a00;--warn-soft:#fff5e0;--ok:#1c7c4a;
  --r-lg:18px;--r-md:12px;--r-sm:9px;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 10px 30px -22px rgba(0,0,0,.3);
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;letter-spacing:-.005em;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-ink)}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px}
svg.i{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

header.top{position:sticky;top:0;z-index:20;background:rgba(251,251,253,.86);backdrop-filter:saturate(180%) blur(20px);
  border-bottom:1px solid var(--line)}
header.top .wrap{height:60px;display:flex;align-items:center;gap:14px}
.brand{font-size:17px;font-weight:600;letter-spacing:-.02em}
.brand em{font-style:normal;color:var(--ink-3);font-weight:400;margin-left:6px;font-size:14px}
.spacer{flex:1}
.chip{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:999px;
  background:var(--sunken);color:var(--ink-2);font-size:13.5px;white-space:nowrap}
.chip .dot{width:7px;height:7px;border-radius:50%;background:var(--ink-3)}
.chip.ok .dot{background:var(--ok)}.chip.warn .dot{background:#e0a300}.chip.bad .dot{background:var(--danger)}
.menu{position:relative}
.menu>summary{list-style:none;cursor:pointer;height:30px;width:30px;border-radius:50%;background:var(--sunken);
  display:flex;align-items:center;justify-content:center;color:var(--ink-2);font-size:15px;letter-spacing:1px}
.menu>summary::-webkit-details-marker{display:none}
.menu[open]>summary{background:var(--line)}
.menu .sheet{position:absolute;right:0;top:38px;width:300px;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r-md);box-shadow:var(--shadow);padding:14px}
.menu label{display:block;font-size:12.5px;color:var(--ink-3);margin:8px 0 4px}

nav.seg{display:flex;gap:2px;background:var(--sunken);border-radius:10px;padding:2px;margin:18px 0 20px;width:fit-content}
nav.seg button{font:inherit;font-size:14px;border:0;background:none;color:var(--ink-2);padding:6px 16px;border-radius:8px;cursor:pointer}
nav.seg button[aria-selected=true]{background:var(--card);color:var(--ink);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.08)}

main{padding-bottom:80px}
h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:19px;letter-spacing:-.015em;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px 22px;box-shadow:var(--shadow);margin-bottom:16px}
.grid{display:grid;gap:16px}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid.three{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.stat{font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1.1}
.stat small{display:block;font-size:13px;font-weight:400;color:var(--ink-3);letter-spacing:0;margin-top:4px}
.todo{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.todo:first-of-type{border-top:0;padding-top:2px}
.todo .t{flex:1;min-width:0}
.todo .t b{display:block;font-weight:500}
.todo .t span{color:var(--ink-3);font-size:13.5px}
.empty-ok{display:flex;align-items:center;gap:10px;color:var(--ok);font-size:15px}

button.act{font:inherit;font-size:14px;padding:7px 14px;border-radius:980px;border:1px solid var(--line-2);
  background:var(--card);color:var(--ink);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
button.act:hover{border-color:var(--ink-3)}
button.act[disabled]{opacity:.5;cursor:progress}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{background:var(--accent-ink);border-color:var(--accent-ink);color:#fff}
button.quiet{border-color:transparent;background:var(--sunken);color:var(--ink-2)}
button.icon{padding:6px;border-radius:8px;border-color:transparent;background:transparent;color:var(--ink-2)}
button.icon:hover{background:var(--sunken);color:var(--ink)}
button.danger{border-color:#eccac7;color:var(--danger)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.muted{color:var(--ink-3)}.small{font-size:13.5px}.tiny{font-size:12.5px}

details.d{border-top:1px solid var(--line)}
details.d:first-of-type{border-top:0}
details.d>summary{list-style:none;cursor:pointer;padding:14px 2px;display:flex;align-items:center;gap:12px}
details.d>summary::-webkit-details-marker{display:none}
details.d>summary::after{content:'';width:8px;height:8px;border-right:1.6px solid var(--ink-3);border-bottom:1.6px solid var(--ink-3);
  transform:rotate(-45deg);margin-left:auto;transition:transform .2s ease;flex:none}
details.d[open]>summary::after{transform:rotate(45deg)}
.ttl{font-weight:500}
.body{padding:0 2px 18px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;background:var(--sunken);
  color:var(--ink-2);font-size:12.5px}
.pill.ok{background:var(--accent-soft);color:var(--accent-ink)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--danger-soft);color:var(--danger)}
.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink-3);font-weight:500;font-size:12.5px}
tbody tr:last-child td{border-bottom:0}
label{display:block;font-size:13px;color:var(--ink-3);margin:0 0 5px}
input,select{font:inherit;font-size:15px;padding:9px 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);
  background:var(--card);color:var(--ink);width:100%}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.field{margin-bottom:14px}
.hidden-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);border:0}
.status{font-size:13.5px;color:var(--ink-3)}
.status.bad{color:var(--danger)}
.status.ok{color:var(--ok)}
pre{background:var(--sunken);border-radius:var(--r-md);padding:14px;overflow:auto;max-height:340px;font-size:12.5px;margin:0}

/* ── 访达分栏 ── */
.board{display:grid;grid-template-columns:176px 216px 232px minmax(0,1fr);background:var(--card);
  border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.board.rail-hidden{grid-template-columns:0 216px 232px minmax(0,1fr)}
.board .col{border-right:1px solid var(--line);min-width:0;max-height:74vh;overflow:auto;padding:8px 0}
.board .col:last-child{border-right:0;padding:0}
/* 收起的筛选栏**不能 display:none**：它一退出栅格，后面的列会各自顶到前一格上，
   课程列落进 0 宽的那一格——看起来"按钮在但点不动"。保持占位、把内容裁掉才对。 */
.board.rail-hidden #rail{width:0;padding:0;border-right:0;overflow:hidden}
.board.rail-hidden #rail .rail{display:none}
.colhead{display:flex;align-items:center;gap:6px;padding:6px 12px 8px;color:var(--ink-3);font-size:12px;letter-spacing:.04em}
.colhead .spacer{flex:1}
.item{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;font-size:14px;min-width:0}
.item:hover{background:var(--sunken)}
.item[aria-selected=true]{background:var(--accent-soft);color:var(--accent-ink);font-weight:500}
.item .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .meta{color:var(--ink-3);font-size:12px;flex:none}
.item .dot{width:7px;height:7px;border-radius:50%;background:var(--ink-3);flex:none}
.item .dot.ok{background:var(--ok)}.item .dot.warn{background:var(--warn)}.item .dot.bad{background:var(--danger)}
.rail{padding:8px 0}
.rail h4{margin:8px 12px 4px;font-size:12px;color:var(--ink-3);font-weight:600;letter-spacing:.04em}
.tag-row{display:flex;align-items:center;gap:6px;padding:5px 12px;cursor:pointer;font-size:13.5px;color:var(--ink-2)}
.tag-row:hover{background:var(--sunken)}
.tag-row[aria-selected=true]{color:var(--accent-ink);font-weight:500}
.tag-row .grip{color:var(--ink-3);cursor:grab;opacity:0}
.tag-row:hover .grip{opacity:1}
.tag-row.dragging{opacity:.4}
.detail{padding:18px 20px}
.detail h2{margin:0 0 4px;font-size:17px}
.detail .sub{color:var(--ink-3);font-size:13px;margin:0 0 14px}
.block{padding:14px 0;border-top:1px solid var(--line)}
.block:first-of-type{border-top:0}
.block h3{margin:0 0 8px;font-size:13.5px;color:var(--ink-3);font-weight:600;letter-spacing:.03em}
.file{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--r-md);margin-bottom:6px;cursor:pointer}
.file:hover{border-color:var(--ink-3)}
.file[aria-selected=true]{border-color:var(--accent);background:var(--accent-soft)}
.file .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.file .meta{color:var(--ink-3);font-size:12px}
.tag{display:inline-flex;align-items:center;gap:6px;padding:3px 6px 3px 10px;border-radius:999px;background:var(--sunken);
  font-size:12.5px;margin:0 6px 6px 0}
.tag button{border:0;background:none;color:var(--ink-3);cursor:pointer;padding:0 2px;font-size:14px;line-height:1}
.tag button:hover{color:var(--danger)}
.pages{max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px;font-size:13px}
.pages .page{padding:6px 0;border-top:1px dashed var(--line)}
.pages .page:first-child{border-top:0}
.pages .no{color:var(--ink-3);font-size:11.5px;font-family:var(--mono)}
.bar{height:8px;border-radius:999px;background:var(--sunken);overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:999px}
.storage-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:8px 0;border-top:1px solid var(--line)}
.storage-row:first-child{border-top:0}
.storage-row .hint{grid-column:1/-1;color:var(--ink-3);font-size:12px}
.toast{position:fixed;right:20px;bottom:20px;z-index:60;max-width:min(420px,calc(100vw - 40px));padding:12px 15px;
  border-radius:var(--r-md);border:1px solid var(--line);background:rgba(255,255,255,.98);box-shadow:var(--shadow);
  font-size:14px;color:var(--ink-2);opacity:0;transform:translateY(10px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.ok{border-color:#cfe4d8;background:var(--accent-soft);color:var(--accent-ink)}
.toast.error{border-color:#eccac7;background:var(--danger-soft);color:var(--danger)}
@media (max-width:900px){
  .board,.board.rail-hidden{grid-template-columns:1fr}
  .board .col{max-height:none;border-right:0;border-bottom:1px solid var(--line)}
}
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="brand">课程笔记<em>管理台</em></div>
    <div class="spacer"></div>
    <span id="runState" class="chip"><span class="dot"></span>空闲</span>
    <details class="menu" id="menu">
      <summary title="更多">···</summary>
      <div class="sheet">
        <div class="row" style="margin-bottom:6px">
          <button class="act" data-act="refresh">刷新</button>
          <a class="act" href="/" target="_blank" rel="noopener" style="padding:7px 14px;border:1px solid var(--line-2);border-radius:980px">看站点</a>
        </div>
        <label>管理密码或主令牌</label>
        <input id="token" type="password" placeholder="粘贴后回车" autocomplete="current-password">
        <div class="row" style="margin-top:8px"><button class="act primary" data-act="save">保存</button></div>
      </div>
    </details>
  </div>
</header>

<main class="wrap">
  <nav class="seg" role="tablist">
    <button role="tab" data-tab="overview" aria-selected="true">概览</button>
    <button role="tab" data-tab="courses" aria-selected="false">课程</button>
    <button role="tab" data-tab="settings" aria-selected="false">设置</button>
  </nav>
  <section id="tab-overview"></section>
  <section id="tab-courses" hidden></section>
  <section id="tab-settings" hidden></section>
  <div class="card" style="padding:6px 22px">
    <details class="d" id="outCard" style="border-top:0" data-fold="out">
      <summary><span class="ttl">运行输出</span><span class="muted small">最近一次命令的完整结果</span></summary>
      <div class="body"><pre id="out">（尚未运行）</pre></div>
    </details>
  </div>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
var $ = function (id) { return document.getElementById(id) }
var KEY = 'course.admin.token'
var OPEN_KEY = 'course.admin.open'
var SEL_KEY = 'course.admin.sel'
var state = {
  status: null, balance: null, config: null, storage: null,
  tab: 'overview', busy: false, requests: {}, uploads: {}, open: {},
  sel: { tag: '', year: 'all', course: '', lesson: '', sort: 'desc', rail: false },
  preview: null
}
try {
  var savedOpen = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}')
  if (savedOpen && typeof savedOpen === 'object') state.open = savedOpen
  var savedSel = JSON.parse(localStorage.getItem(SEL_KEY) || '{}')
  if (savedSel && typeof savedSel === 'object') state.sel = Object.assign(state.sel, savedSel)
} catch (e) {}

var LABELS = {
  discover: '扫描教学网', cycle: '跑一轮完整链路', 'cycle-all': '跑一轮完整链路',
  notify: '投递通知', doctor: '体检', backup: '备份账本', prune: '清理预演',
  'prune-apply': '清理并删除原件', retry: '放回队列', republish: '重新发布',
  revise: '按新要求重写模块', 'notify-retry': '重发失败通知'
}
var MODULE_TEXT = { approved: '已通过', draft: '草稿', reviewing: '审查中', revising: '重写中', pending: '待写', failed: '失败' }
var STAGE_TEXT = {
  discovered: '待处理', queued: '排队中', downloading: '下载中', downloaded: '已下载',
  transcribing: '转写中', transcript_ready: '待写笔记', writing: '写笔记中',
  notes_ready: '待发布', publishing: '发布中', published: '已发布',
  needs_attention: '卡住了', failed: '失败', completed: '已完成'
}
var STAGE_CLASS = { published: 'ok', completed: 'ok', needs_attention: 'bad', failed: 'bad', discovered: '', transcript_ready: 'warn', notes_ready: 'warn' }
var INTEGRATION_KINDS = [
  { key: 'integrated-note', label: '整合版笔记' },
  { key: 'knowledge-map', label: '知识图谱（XMind）' },
  { key: 'concept-track', label: '概念追踪表' },
  { key: 'statute-reader', label: '法条精读表' },
  { key: 'distinction-table', label: '辨析表' },
  { key: 'case-library', label: '案例练习库' }
]

$('token').value = localStorage.getItem(KEY) || ''
$('token').addEventListener('keydown', function (event) {
  if (event.key === 'Enter') { event.preventDefault(); localStorage.setItem(KEY, $('token').value.trim()); load() }
})

function esc (v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  })
}
function headers (json) {
  var h = { 'x-course-token': $('token').value.trim() }
  if (json) h['content-type'] = 'application/json'
  return h
}
function money (value) {
  var amount = Number(value || 0)
  if (!amount) return '¥0'
  return amount < 1 ? '¥' + amount.toFixed(3) : '¥' + amount.toFixed(2)
}
function bytes (value) {
  var n = Number(value || 0)
  if (!n) return '0'
  var units = ['B', 'KB', 'MB', 'GB']
  var i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i]
}
function icon (name) {
  var paths = {
    sort: '<path d="M4 7h10M4 12h7M4 17h4"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    rail: '<path d="M3 5h18v14H3z"/><path d="M9 5v14"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    // 图片版课件用得上：一张"图里带字"的图标
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>'
  }
  return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || '') + '</svg>'
}
function setOpen (key, value) {
  state.open[key] = value
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(state.open)) } catch (e) {}
}
function foldAttrs (key, forceOpen) {
  var open = forceOpen === undefined ? state.open[key] === true : forceOpen
  return ' data-fold="' + esc(key) + '"' + (open ? ' open' : '')
}
function saveSel () {
  try { localStorage.setItem(SEL_KEY, JSON.stringify(state.sel)) } catch (e) {}
}
function toast (message, kind) {
  var el = $('toast')
  el.textContent = String(message)
  el.className = 'toast show ' + (kind || 'info')
  clearTimeout(toast.timer)
  if (kind !== 'error') toast.timer = setTimeout(function () { el.className = 'toast' }, 7000)
}
function out (text) { $('out').textContent = String(text) }
function setRunState (text, cls) {
  $('runState').className = 'chip ' + (cls || '')
  $('runState').innerHTML = '<span class="dot"></span>' + esc(text)
}
function busyButton (btn, text) {
  if (!btn || btn.tagName !== 'BUTTON') return function () {}
  var old = btn.innerHTML
  btn.disabled = true
  btn.textContent = text || '处理中…'
  return function () { btn.disabled = false; btn.innerHTML = old }
}
function fail (error) {
  var text = (error && error.message) || String(error)
  out('操作失败：' + text)
  toast('操作失败：' + text, 'error')
}
function run (fn) {
  try {
    var pending = fn()
    if (pending && typeof pending.catch === 'function') pending.catch(fail)
  } catch (error) { fail(error) }
}
function taskByKey (key) {
  var tasks = (state.status && state.status.ledger && state.status.ledger.tasks) || []
  for (var i = 0; i < tasks.length; i += 1) if (tasks[i].replayKey === key) return tasks[i]
  return null
}
function tasks () { return (state.status && state.status.ledger && state.status.ledger.tasks) || [] }
function tagsOf () { return (state.status && state.status.tags) || { order: [], courses: {}, lessons: {} } }

async function load (options) {
  options = options || {}
  var res = await fetch('/api/admin/status', { headers: headers(false) })
  var data = await res.json().catch(function () { return {} })
  if (!res.ok) {
    var reason = data.error === 'admin_token_unconfigured' ? '服务端没有配置 COURSE_ADMIN_TOKEN'
      : data.error === 'too_many_attempts' ? '凭据错误次数过多，请等 5 分钟'
      : $('token').value.trim() ? '凭据不对' : '未登录：点右上角 ··· 填入密码或主令牌'
    $('tab-overview').innerHTML = card('<h2>需要登录</h2><p class="muted">' + esc(reason) + '</p>')
    setRunState('未登录', 'bad')
    return false
  }
  state.status = data
  if (!state.config) {
    try { state.config = await (await fetch('/api/admin/config', { headers: headers(false) })).json() } catch (e) {}
  }
  if (options.quiet && isDirty()) { renderRunState(); return true }
  render()
  if (!state.balance && !options.quiet) refreshBalance()
  return true
}
function isDirty () {
  var active = document.activeElement
  if (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return true
  var boxes = document.querySelectorAll('[data-request],[data-pw="next"],[data-newtag]')
  for (var i = 0; i < boxes.length; i += 1) if (boxes[i].value) return true
  return false
}
function refreshBalance () {
  state.balance = null
  renderOverview()
  fetch('/api/admin/balance', { headers: headers(false) })
    .then(function (r) { return r.json() })
    .then(function (b) { state.balance = b; renderOverview() })
    .catch(function (error) { state.balance = { ok: false, error: String(error) }; renderOverview() })
}
function renderRunState () {
  var running = state.status && state.status.running
  setRunState(running ? '正在运行 ' + running.action : '空闲', running ? 'warn' : 'ok')
}
/** 重绘前把 DOM 里的折叠状态抄回来：程序性改 open 不一定及时触发 toggle 事件。 */
function captureFolds () {
  document.querySelectorAll('details[data-fold]').forEach(function (node) {
    state.open[node.dataset.fold] = node.open
  })
}
function render () {
  captureFolds()
  document.querySelectorAll('.seg button').forEach(function (btn) {
    var on = btn.dataset.tab === state.tab
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
    $('tab-' + btn.dataset.tab).hidden = !on
  })
  renderRunState()
  renderOverview(); renderCourses(); renderSettings()
}
function card (inner, style) { return '<div class="card"' + (style ? ' style="' + style + '"' : '') + '>' + inner + '</div>' }

/* ── 概览 ── */
function renderOverview () {
  if (!state.status) return
  var s = state.status
  var t = s.todos || {}
  var all = tasks()
  var counts = { published: 0, running: 0, waiting: 0 }
  all.forEach(function (task) {
    if (task.stage === 'published') counts.published += 1
    else if (task.stage === 'discovered') counts.waiting += 1
    else counts.running += 1
  })
  var todos = []
  ;(t.stuck || []).forEach(function (item) {
    todos.push({ title: item.courseName + ' · ' + item.title, note: '已停止重试', label: '去处理', tab: 'courses' })
  })
  ;(t.missingMaterials || []).forEach(function (item) {
    todos.push({ title: item.courseName + ' · ' + item.title, note: '缺课件', label: '传课件', tab: 'courses' })
  })
  if (s.channel && s.channel.ok === false) todos.push({ title: '推送发不出去', note: '通道未就绪', label: '查看', tab: 'overview' })
  if (t.failedDeliveries) todos.push({ title: t.failedDeliveries + ' 条通知发送失败', note: '未送达', label: '重发', tab: 'settings' })

  var hero = todos.length
    ? '<h1>' + todos.length + ' 件事待处理</h1>' + todos.map(function (item) {
      return '<div class="todo"><div class="t"><b>' + esc(item.title) + '</b><span>' + esc(item.note) + '</span></div>' +
        '<button class="act" data-go="' + item.tab + '">' + esc(item.label) + '</button></div>'
    }).join('')
    : '<h1>无待办</h1><div class="empty-ok"><span class="pill ok"><span class="dot"></span>一切正常</span></div>'

  var spend = s.spend || { asrCny: 0, notesCny: 0, totalCny: 0 }
  var pricing = s.pricing || {}
  $('tab-overview').innerHTML =
    card(hero) +
    card('<div class="grid three">' +
        '<div class="stat">' + counts.published + '<small>已发布</small></div>' +
        '<div class="stat">' + counts.running + '<small>进行中</small></div>' +
        '<div class="stat">' + counts.waiting + '<small>还没轮到</small></div>' +
      '</div>') +
    '<div class="grid two">' +
      card('<h2>花费</h2><div class="stat">' + money(spend.totalCny) + '<small>转写 ' + money(spend.asrCny) + ' + 笔记 ' + money(spend.notesCny) + '</small></div>' +
        '<div class="row" style="margin-top:14px;align-items:flex-start">' + balancesHtml() + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="act quiet" data-act="refresh-balance">刷新余额</button></div>' +
        '<div class="tiny muted" style="margin-top:10px">转写 ¥' + (pricing.asrPerHourCny || 0.288) + '/小时（按语音时长）· 笔记 ¥' + (pricing.noteInputPerMillionCny || 1) + ' / ¥' + (pricing.noteOutputPerMillionCny || 4) + ' 每百万 token</div>') +
      card('<h2>推送通道</h2>' + channelHtml()) +
    '</div>'
}
function balancesHtml () {
  var b = state.balance
  if (!b) return '<span class="muted small">余额加载中…</span>'
  if (b.ok === false) return '<span class="muted small">' + esc(b.error || b.stderr || '查询失败') + '</span>'
  var list = b.balances || []
  if (!list.length) return '<span class="muted small">没有余额信息</span>'
  return list.map(function (x) {
    var amount = x.total != null ? x.total : x.available
    var name = x.provider === 'deepseek' ? 'DeepSeek（写笔记）' : x.provider === 'aliyun' ? '阿里云百炼（转写）' : x.provider
    var low = amount != null && amount < (b.threshold || 5)
    return '<div style="flex:1;min-width:140px"><div class="tiny muted">' + esc(name) + '</div>' +
      '<div style="font-size:20px;font-weight:600">' + (amount == null ? '—' : '¥' + Number(amount).toFixed(2)) + '</div>' +
      (low ? '<span class="pill bad">低于阈值</span>' : (x.configured === false ? '<span class="tiny muted">' + esc(x.reason || '未配置') + '</span>' : '')) +
      (x.rechargeUrl ? ' <a class="tiny" href="' + esc(x.rechargeUrl) + '" target="_blank" rel="noopener">充值</a>' : '') + '</div>'
  }).join('')
}
function channelHtml () {
  var c = state.status.channel || {}
  var rows = []
  if (c.ok) {
    var age = Number(c.ageMinutes || 0)
    var text = age < 60 ? age + ' 分钟前' : Math.round(age / 60) + ' 小时前'
    rows.push('<div><span class="pill ' + (c.fresh ? 'ok' : 'warn') + '"><span class="dot"></span>微信机器人 ' + (c.fresh ? '可用' : '会话过期') + '</span>' +
      '<span class="tiny muted" style="margin-left:8px">最近互动 ' + esc(text) + '</span></div>')
  } else {
    rows.push('<div><span class="pill bad"><span class="dot"></span>微信机器人 不可用</span>' +
      (c.reason ? '<span class="tiny muted" style="margin-left:8px">' + esc(c.reason) + '</span>' : '') + '</div>')
  }
  var f = c.fallback || {}
  rows.push('<div style="margin-top:8px"><span class="pill ' + (f.configured ? 'ok' : '') + '"><span class="dot"></span>备用通道 ' + (f.configured ? esc(f.kind) : '未配置') + '</span></div>')
  rows.push('<div style="margin-top:8px"><span class="pill ' + ((state.status.digest && state.status.digest.to) ? 'ok' : '') + '"><span class="dot"></span>邮件日报 ' + ((state.status.digest && state.status.digest.to) ? '每天 07:00' : '未配置') + '</span></div>')
  return rows.join('')
}

/* ── 课程：访达分栏 ── */
function lessonYear (task) {
  var match = String(task.title || '').match(/(20\d{2})/)
  return match ? match[1] : ''
}
function courseList () {
  var groups = new Map()
  tasks().forEach(function (task) {
    var course = task.courseName || '未分类'
    if (!groups.has(course)) groups.set(course, [])
    groups.get(course).push(task)
  })
  return [...groups.entries()].map(function ([course, list]) {
    var years = [...new Set(list.map(lessonYear).filter(Boolean))].sort()
    return {
      course: course,
      lessons: list,
      year: years[years.length - 1] || '',
      tags: (tagsOf().courses || {})[course] || [],
      published: list.filter(function (item) { return item.stage === 'published' }).length,
      stuck: list.some(function (item) { return item.stage === 'needs_attention' || item.stage === 'failed' })
    }
  }).sort(function (a, b) { return String(a.course).localeCompare(String(b.course), 'zh') })
}
function visibleCourses () {
  return courseList().filter(function (item) {
    if (state.sel.year !== 'all' && item.year !== state.sel.year) return false
    if (state.sel.tag && !(item.tags || []).includes(state.sel.tag)) return false
    return true
  })
}
function lessonsOf (course) {
  var list = tasks().filter(function (task) { return (task.courseName || '未分类') === course })
  list.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)) })
  return state.sel.sort === 'asc' ? list : list.reverse()
}

function renderCourses () {
  var all = courseList()
  var shown = visibleCourses()
  var tags = (tagsOf().order || [])
  var years = [...new Set(all.map(function (item) { return item.year }).filter(Boolean))].sort().reverse()

  // 左：筛选栏
  var railItems = ['<div class="tag-row" data-act="filter-all"' + (state.sel.tag || state.sel.year !== 'all' ? '' : ' aria-selected="true"') + '>' +
    '<span class="name">全部</span><span class="meta">' + all.length + '</span></div>']
  years.forEach(function (year) {
    railItems.push('<div class="tag-row" data-act="filter-year" data-value="' + esc(year) + '"' +
      (state.sel.year === year ? ' aria-selected="true"' : '') + '><span class="name">' + esc(year) + '</span>' +
      '<span class="meta">' + all.filter(function (item) { return item.year === year }).length + '</span></div>')
  })
  if (tags.length) {
    railItems.push('<h4>标签</h4>')
    tags.forEach(function (tag, index) {
      railItems.push('<div class="tag-row" draggable="true" data-tag="' + esc(tag) + '" data-index="' + index + '"' +
        (state.sel.tag === tag ? ' aria-selected="true"' : '') + '>' +
        '<span class="grip" title="拖动排序">⋮⋮</span><span class="name">' + esc(tag) + '</span></div>')
    })
  }
  var rail = '<div class="col" id="rail">' +
    '<div class="colhead">筛选<span class="spacer"></span></div><div class="rail">' + railItems.join('') + '</div></div>'

  // 中一：课程
  var courseItems = shown.map(function (item) {
    var dot = item.stuck ? 'bad' : item.published === item.lessons.length ? 'ok' : 'warn'
    return '<div class="item" data-act="pick-course" data-value="' + esc(item.course) + '"' +
      (state.sel.course === item.course ? ' aria-selected="true"' : '') + '>' +
      '<span class="dot ' + dot + '"></span><span class="name">' + esc(item.course) + '</span>' +
      '<span class="meta">' + item.published + '/' + item.lessons.length + '</span></div>'
  }).join('')
  var courses = '<div class="col" id="courses">' +
    '<div class="colhead"><button class="icon" data-act="rail-toggle" title="筛选">' + icon('rail') + '</button>' +
    '<span>课程 · ' + shown.length + '</span></div>' + (courseItems || '<div class="item muted">没有匹配的课程</div>') + '</div>'

  // 中二：课次
  var lessonItems = ''
  if (state.sel.course) {
    lessonItems = '<div class="item" data-act="pick-lesson" data-value="__multi__"' +
      (state.sel.lesson === '__multi__' ? ' aria-selected="true"' : '') + '><span class="name">多节课程</span>' +
      '<span class="meta">整合</span></div>'
    lessonItems += lessonsOf(state.sel.course).map(function (task) {
      return '<div class="item" data-act="pick-lesson" data-value="' + esc(task.replayKey) + '"' +
        (state.sel.lesson === task.replayKey ? ' aria-selected="true"' : '') + '>' +
        '<span class="dot ' + (STAGE_CLASS[task.stage] || '') + '"></span><span class="name">' + esc(task.title) + '</span></div>'
    }).join('')
  }
  var lessons = '<div class="col" id="lessons">' +
    '<div class="colhead"><span>课次</span><span class="spacer"></span>' +
    (state.sel.course ? '<button class="icon" data-act="sort-toggle" title="' + (state.sel.sort === 'asc' ? '正序' : '倒序') + '">' + icon('sort') + '</button>' : '') +
    '</div>' + lessonItems + '</div>'

  // 右：详情
  var detail = '<div class="col" id="detail"><div class="detail">' + detailHtml() + '</div></div>'
  $('tab-courses').innerHTML = '<div class="board' + (state.sel.rail ? '' : ' rail-hidden') + '">' + rail + courses + lessons + detail + '</div>'
}

function detailHtml () {
  if (!state.sel.course) return '<p class="muted">选一门课</p>'
  if (state.sel.lesson === '__multi__') return integrationHtml()
  var task = taskByKey(state.sel.lesson)
  if (!task) return '<p class="muted">选一节课</p>'
  var cost = task.cost || {}
  var lesson = task.lesson || {}
  var tags = ((tagsOf().lessons || {})[task.replayKey] || [])
  var head = '<h2>' + esc(task.title) + '</h2>' +
    '<p class="sub">' + esc(task.courseName) + ' · <span class="pill ' + (STAGE_CLASS[task.stage] || '') + '">' + esc(STAGE_TEXT[task.stage] || task.stage) + '</span>' +
    ' · 尝试 ' + task.attempts + ' 次 · 转写 ' + money(cost.asrCny) + ' · 笔记 ' + money(cost.notesCny) + '</p>' +
    (task.lastError ? '<p class="small" style="color:var(--danger)">' + esc(String(task.lastError).slice(0, 200)) + '</p>' : '')

  var actions = '<div class="block"><h3>操作</h3><div class="row">' +
    '<button class="act primary" data-act="cycle" data-key="' + esc(task.replayKey) + '">现在处理这一节</button>' +
    '<button class="act" data-act="retry" data-key="' + esc(task.replayKey) + '">解除卡住，放回队列</button>' +
    (task.artifacts && task.artifacts.transcriptPath ? '<button class="act" data-act="republish" data-key="' + esc(task.replayKey) + '">重新发布</button>' : '') +
    (task.artifacts && task.artifacts.slug ? '<a class="act" target="_blank" rel="noopener" href="/' + esc(task.artifacts.slug) + '.html">看笔记</a>' : '') +
    '</div></div>'

  var files = (task.materials || []).map(function (material) {
    var selected = state.preview && state.preview.course === task.courseName && state.preview.name === material.name
    return '<div class="file" data-act="open-material" data-value="' + esc(material.name) + '"' + (selected ? ' aria-selected="true"' : '') + '>' +
      icon('file') + '<span class="name">' + esc(material.name) + (material.scope === 'course' ? ' · 全课程' : '') + '</span>' +
      '<span class="meta">' + material.slideCount + ' 页' +
        (material.imageCount ? ' · 图 ' + material.imageCount : '') +
        (material.ocrPending ? ' · 待识别 ' + material.ocrPending : '') + '</span></div>'
  }).join('')
  var deck = '<div class="block"><h3>课件</h3>' + (files || '<p class="small muted">无课件</p>') +
    '<div class="row" style="margin-top:8px">' +
    '<input class="hidden-file" type="file" multiple data-file="' + esc(task.replayKey) + '" accept=".pptx,.pdf,.docx,.xlsx,.md,.txt">' +
    '<button class="act" data-act="pick-file" data-key="' + esc(task.replayKey) + '">' + icon('plus') + '上传课件</button>' +
    // 图片文字是上传后自动识别的（后台跑，不用点）；这里只在"还有没识别完的图"时
    // 提供一个补识别的入口——识别失败、或一次超过上限时的补救手段
    (task.ocrRunning
      ? '<span class="small muted">正在后台识别图片文字…</span>'
      : ((task.materials || []).some(function (material) { return material.ocrPending > 0 })
        ? '<button class="act" data-act="ocr-material" data-key="' + esc(task.replayKey) + '">' + icon('image') + '重新识别图片文字</button>'
        : '')) +
    '<span class="status" data-status="' + esc(task.replayKey) + '">' + esc(state.uploads[task.replayKey] || '') + '</span>' +
    '</div>' + previewHtml(task) + '</div>'

  var tagBlock = '<div class="block"><h3>标签</h3>' +
    (tags.length ? tags.map(function (tag) {
      return '<span class="tag">' + esc(tag) + '<button data-act="remove-tag" data-key="' + esc(task.replayKey) + '" data-tag="' + esc(tag) + '" title="移除">×</button></span>'
    }).join('') : '<span class="small muted">暂无标签</span>') +
    '<div class="row" style="margin-top:8px"><input data-newtag="' + esc(task.replayKey) + '" placeholder="新增标签，回车确认" style="max-width:240px">' +
    '<button class="act" data-act="add-tag" data-key="' + esc(task.replayKey) + '">添加</button></div></div>'

  var modules = (lesson.modules || []).map(function (module) {
    var id = module.outlineNodeId || module.id
    return '<tr><td>' + esc(module.title || module.id) + '</td><td class="small muted">' + module.chars + ' 字</td>' +
      '<td class="small muted">' + esc(MODULE_TEXT[module.status] || module.status) + '</td>' +
      '<td style="text-align:right"><button class="act quiet" data-act="revise" data-key="' + esc(task.replayKey) + '" data-module="' + esc(id) + '">重写</button></td></tr>'
  }).join('')
  var noteBlock = lesson.modules && lesson.modules.length
    ? '<div class="block"><h3>笔记</h3><p class="small muted">成品 ' + lesson.finalChars + ' 字 · ' + lesson.modules.length + ' 个模块</p>' +
      '<table><tbody>' + modules + '</tbody></table>' +
      '<div class="row" style="margin-top:10px"><input data-request="' + esc(task.replayKey) + '" value="' + esc(state.requests[task.replayKey] || '') + '" placeholder="修改要求，回车重写第一个模块">' +
      '<button class="act" data-act="revise-first" data-key="' + esc(task.replayKey) + '">按这个要求重写</button></div></div>'
    : ''

  return head + actions + deck + tagBlock + noteBlock
}

function previewHtml (task) {
  var preview = state.preview
  if (!preview || preview.course !== task.courseName || preview.loading) {
    return preview && preview.loading ? '<div class="pages">加载中…</div>' : ''
  }
  var pages = (preview.pages || []).map(function (page) {
    return '<div class="page"><div class="no">第 ' + page.slideNumber + ' 页</div>' + esc(page.text || '（本页无文字）') + '</div>'
  }).join('')
  return '<div class="pages" style="margin-top:8px">' +
    '<div class="row" style="justify-content:space-between"><span class="tiny muted">' + esc(preview.name) + ' · 共 ' + preview.slideCount + ' 页</span>' +
    '<button class="icon" data-act="close-material" title="关闭预览">×</button></div>' +
    (pages || '<div class="muted small">没有文字</div>') + '</div>'
}

function integrationHtml () {
  var course = state.sel.course
  var items = INTEGRATION_KINDS.map(function (kind) {
    return '<div class="item" data-act="integrate" data-value="' + esc(kind.key) + '">' +
      '<span class="name">' + esc(kind.label) + '</span><span class="meta">未生成</span></div>'
  }).join('')
  return '<h2>' + esc(course) + ' · 多节课程</h2><p class="sub">' + tasks().filter(function (item) { return item.courseName === course }).length + ' 节 · 整合材料</p>' +
    '<div class="block"><h3>整合材料</h3>' + items + '</div>' +
    '<div class="block"><h3>课程标签</h3>' + courseTagHtml(course) + '</div>'
}

function courseTagHtml (course) {
  var tags = ((tagsOf().courses || {})[course] || [])
  return (tags.length ? tags.map(function (tag) {
    return '<span class="tag">' + esc(tag) + '<button data-act="remove-course-tag" data-course="' + esc(course) + '" data-tag="' + esc(tag) + '" title="移除">×</button></span>'
  }).join('') : '<span class="small muted">暂无标签</span>') +
    '<div class="row" style="margin-top:8px"><input data-newcoursetag="' + esc(course) + '" placeholder="给这门课加标签，回车确认" style="max-width:260px">' +
    '<button class="act" data-act="add-course-tag" data-course="' + esc(course) + '">添加</button></div>'
}

/* ── 设置 ── */
function renderSettings () {
  var c = state.config || { values: {}, editable: {} }
  var fields = Object.keys(c.editable || {}).map(function (key) {
    var spec = c.editable[key]
    var value = c.values && c.values[key] != null ? c.values[key] : ''
    var input
    if (spec.enum) {
      input = '<select data-cfg="' + key + '">' + spec.enum.map(function (o) {
        return '<option' + (String(value) === o ? ' selected' : '') + '>' + esc(o) + '</option>'
      }).join('') + '</select>'
    } else if (spec.type === 'boolean') {
      input = '<select data-cfg="' + key + '"><option value=""' + (value === '' ? ' selected' : '') + '>跟随环境变量</option>' +
        '<option value="true"' + (value === true ? ' selected' : '') + '>开启</option>' +
        '<option value="false"' + (value === false ? ' selected' : '') + '>关闭</option></select>'
    } else {
      input = '<input data-cfg="' + key + '" type="' + (spec.type === 'number' ? 'number' : 'text') + '" value="' + esc(value) + '" placeholder="跟随环境变量">'
    }
    return '<div class="field"><label>' + esc(spec.label || key) + '</label>' + input + '</div>'
  }).join('')

  var deliveries = (state.status.ledger && state.status.ledger.deliveries) || []
  var failed = (state.status.todos && state.status.todos.failedDeliveries) || 0
  var rows = deliveries.slice(0, 10).map(function (x) {
    var cls = x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'bad' : ''
    return '<tr><td class="small">' + esc(x.purpose) + '</td><td><span class="pill ' + cls + '">' + esc(x.status) + '</span></td>' +
      '<td class="small muted">' + esc(String(x.sent_at || x.created_at || '').slice(5, 16).replace('T', ' ')) + '</td>' +
      '<td class="tiny muted">' + esc(String(x.last_error || '').slice(0, 60)) + '</td></tr>'
  }).join('')

  $('tab-settings').innerHTML =
    card('<div class="row"><button class="act primary" data-act="cycle-all">跑一轮完整链路</button>' +
      '<button class="act" data-act="discover">扫描教学网</button></div>') +
    card('<details class="d"' + foldAttrs('settings:maintenance', false) + '><summary><span class="ttl">维护</span><span class="muted small">通知、体检、备份、清理</span></summary>' +
      '<div class="body"><div class="row"><button class="act" data-act="notify">投递通知</button>' +
      '<button class="act" data-act="doctor">体检</button><button class="act" data-act="backup">备份账本</button>' +
      '<button class="act" data-act="prune">清理预演</button><button class="act danger" data-act="prune-apply">清理并删除</button></div></div></details>' +
      '<details class="d"' + foldAttrs('settings:notify') + '><summary><span class="ttl">通知记录</span><span class="muted small">最近 ' + Math.min(10, deliveries.length) + ' 条</span></summary>' +
      '<div class="body">' + (rows ? '<table><tbody>' + rows + '</tbody></table>' : '<p class="muted small">队列为空</p>') +
      (failed ? '<div class="row" style="margin-top:10px"><button class="act primary" data-act="notify-retry">把 ' + failed + ' 条失败通知放回队列</button></div>' : '') + '</div></details>') +
    card('<details class="d"' + foldAttrs('settings:storage') + '><summary><span class="ttl">存储占用</span><span class="muted small">' + (state.storage ? bytes(state.storage.totalBytes) : '点开查看') + '</span></summary>' +
      '<div class="body" id="storageBody">' + storageHtml() + '</div></details>') +
    card('<details class="d"' + foldAttrs('settings:params') + '><summary><span class="ttl">运行参数</span><span class="muted small">篇幅、并发、成本窗口</span></summary>' +
      '<div class="body">' + fields + '<div class="row"><button class="act primary" data-act="save-config">保存设置</button></div>' +
      '<div class="tiny muted" style="margin-top:8px">' + esc(c.path || '') + '</div></div></details>' +
      '<details class="d"' + foldAttrs('settings:password') + '><summary><span class="ttl">登录密码</span><span class="muted small">' +
      ((state.status.auth && state.status.auth.passwordSet) ? '已设置' : '未设置') + '</span></summary><div class="body">' + passwordPanel() + '</div></details>')
}

function storageHtml () {
  if (!state.storage) {
    return '<div class="row"><button class="act" data-act="storage-load">查看占用</button></div>'
  }
  var list = state.storage.categories || []
  var total = state.storage.totalBytes || 1
  var rows = list.map(function (item) {
    var percent = Math.max(2, Math.round((item.bytes / total) * 100))
    return '<div class="storage-row"><div>' + esc(item.label) + '</div><div class="muted small">' + bytes(item.bytes) + '</div>' +
      '<div class="hint">' + esc(item.hint) + '</div>' +
      '<div style="grid-column:1/-1"><div class="bar"><i style="width:' + percent + '%"></i></div></div></div>'
  }).join('')
  var disk = state.storage.disk
  return rows + (disk ? '<p class="small muted" style="margin-top:12px">磁盘：已用 ' + bytes(disk.totalBytes - disk.freeBytes) + ' / 共 ' + bytes(disk.totalBytes) + '，可用 ' + bytes(disk.freeBytes) + '</p>' : '') +
    '<div class="row" style="margin-top:10px"><button class="act quiet" data-act="storage-load">重新计算</button></div>'
}
function passwordPanel () {
  var auth = (state.status && state.status.auth) || {}
  return (auth.masterTokenSet ? '' : '<p class="small" style="color:var(--danger)">主令牌未配置：忘记密码只能去服务器重设。</p>') +
    '<div class="field"><label>新密码（至少 8 位）</label><input data-pw="next" type="password" autocomplete="new-password" placeholder="新密码"></div>' +
    '<div class="row"><button class="act primary" data-act="save-password">保存新密码</button>' +
    '<button class="act" data-act="clear-password">清除密码</button></div>'
}

/* ── 动作 ── */
function go (tab) { state.tab = tab; render(); window.scrollTo({ top: 0, behavior: 'smooth' }) }

async function doAction (action, extra, btn) {
  if (state.busy || (state.status && state.status.running)) { toast('服务端已经有任务在跑，等它结束再点', 'error'); return }
  var label = LABELS[action] || action
  var restore = busyButton(btn, '处理中…')
  state.busy = true
  setRunState('正在运行 ' + label, 'warn')
  out('运行中…（' + label + '）')
  toast('已开始：' + label, 'info')
  try {
    var res = await fetch('/api/admin/run', { method: 'POST', headers: headers(true), body: JSON.stringify(Object.assign({ action: action }, extra || {})) })
    var data = await res.json().catch(function () { return {} })
    out(JSON.stringify(data, null, 2))
    if (res.status === 409) toast('服务端正忙（' + (data.action || '别的任务') + '），稍后再点', 'error')
    else if (data.ok) toast('完成：' + label + '（退出码 ' + data.exitCode + '）', 'ok')
    else toast('没成功：' + label + ' —— ' + (data.message || data.error || ('退出码 ' + data.exitCode)), 'error')
  } catch (error) {
    out('请求失败：' + error)
    toast('请求失败：' + error, 'error')
  } finally { state.busy = false; restore() }
  load()
}

function setStatus (key, text, kind) {
  var el = document.querySelector('[data-status="' + key + '"]')
  if (!el) return
  el.className = 'status ' + (kind || '')
  el.textContent = text
}

async function uploadFiles (key, fileList, btn) {
  var task = taskByKey(key)
  if (!task || !task.courseName) { toast('找不到这条课次的课程名', 'error'); return }
  var files = [].slice.call(fileList || [])
  if (!files.length) { toast('先选文件', 'error'); return }
  var restore = busyButton(btn, '上传中…')
  for (var i = 0; i < files.length; i += 1) {
    var file = files[i]
    var sizeMb = (file.size / 1048576).toFixed(1)
    try {
      var data
      if (file.size > 2 * CHUNK_SIZE) {
        var uploadId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
        var total = Math.ceil(file.size / CHUNK_SIZE)
        for (var index = 0; index < total; index += 1) {
          setStatus(key, '上传中 ' + Math.round((index / total) * 100) + '%（' + file.name + '）')
          await putChunk(uploadId, index, file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE))
        }
        setStatus(key, '解析中…（' + file.name + '）')
        var res = await fetch('/api/admin/materials/commit', {
          method: 'POST', headers: headers(true),
          body: JSON.stringify({ uploadId: uploadId, course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name, chunks: total })
        })
        data = await res.json().catch(function () { return {} })
      } else {
        var params = new URLSearchParams({ course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name })
        var single = await fetch('/api/admin/materials?' + params.toString(), { method: 'PUT', headers: headers(false), body: file })
        data = await single.json().catch(function () { return {} })
      }
      if (data.ok) {
    // 图上的字是上传后自动识别的：说清楚"已经在后台跑了"，别让人以为要再点一下
    toast('已归档：' + data.name + '（' + data.slideCount + ' 页' +
      (data.ocr && data.ocr.queued ? '，' + (data.imageCount || 0) + ' 张图正在后台识别' : '') + '）', 'ok')
  }
      else { toast('上传失败：' + (data.message || data.error), 'error'); break }
    } catch (error) {
      toast('上传失败：' + error, 'error')
      break
    }
  }
  restore()
  setStatus(key, '')
  load()
}

async function putChunk (uploadId, index, blob) {
  var lastError = null
  for (var attempt = 1; attempt <= 3; attempt += 1) {
    try {
      var res = await fetch('/api/admin/materials/chunk?uploadId=' + encodeURIComponent(uploadId) + '&index=' + index, {
        method: 'PUT', headers: headers(false), body: blob
      })
      var data = await res.json().catch(function () { return {} })
      if (res.ok && data.ok) return data
      lastError = new Error(data.message || data.error || ('分片 ' + index + ' 失败（HTTP ' + res.status + '）'))
    } catch (error) { lastError = error }
    await new Promise(function (done) { setTimeout(done, 600 * attempt) })
  }
  throw lastError
}

async function openMaterial (name) {
  var task = taskByKey(state.sel.lesson)
  if (!task) return
  state.preview = { course: task.courseName, name: name, loading: true, pages: [] }
  renderCourses()
  try {
    var params = new URLSearchParams({ course: task.courseName, lesson: task.title, name: name, pages: '8' })
    var res = await fetch('/api/admin/material?' + params.toString(), { headers: headers(false) })
    var data = await res.json().catch(function () { return {} })
    if (!data.ok) throw new Error(data.message || data.error || '读不到课件')
    state.preview = { course: task.courseName, name: data.name, slideCount: data.slideCount, pages: data.pages || [] }
  } catch (error) {
    state.preview = null
    toast('预览失败：' + error, 'error')
  }
  renderCourses()
}

async function saveTags (patch) {
  var current = tagsOf()
  var next = {
    order: patch.order || current.order || [],
    courses: Object.assign({}, current.courses || {}, patch.courses || {}),
    lessons: Object.assign({}, current.lessons || {}, patch.lessons || {})
  }
  if (patch.removals) {
    patch.removals.forEach(function (item) {
      var list = (item.scope === 'course' ? next.courses[item.key] : next.lessons[item.key]) || []
      var kept = list.filter(function (tag) { return tag !== item.tag })
      if (item.scope === 'course') { if (kept.length) next.courses[item.key] = kept; else delete next.courses[item.key] }
      else { if (kept.length) next.lessons[item.key] = kept; else delete next.lessons[item.key] }
    })
  }
  var res = await fetch('/api/admin/tags', { method: 'PUT', headers: headers(true), body: JSON.stringify(next) })
  var data = await res.json().catch(function () { return {} })
  if (!data.ok) throw new Error(data.message || data.error || '标签没保存')
  state.status.tags = { order: data.order, courses: data.courses, lessons: data.lessons }
  renderCourses()
}

function addTag (key, value, scope, course) {
  var tag = String(value || '').trim()
  if (!tag) { toast('先写标签名', 'error'); return }
  var patch = scope === 'course' ? { courses: {} } : { lessons: {} }
  if (scope === 'course') {
    var list = ((tagsOf().courses || {})[course] || []).slice()
    if (!list.includes(tag)) list.push(tag)
    patch.courses[course] = list
  } else {
    var list2 = ((tagsOf().lessons || {})[key] || []).slice()
    if (!list2.includes(tag)) list2.push(tag)
    patch.lessons[key] = list2
  }
  return saveTags(patch).then(function () { toast('已加标签：' + tag, 'ok') })
}

function removeTag (key, tag, scope, course) {
  return saveTags({ removals: [{ scope: scope, key: scope === 'course' ? course : key, tag: tag }] })
    .then(function () { toast('已移除标签：' + tag, 'ok') })
}

function reorderTags (from, to) {
  var order = (tagsOf().order || []).slice()
  if (from < 0 || to < 0 || from >= order.length || to >= order.length) return
  var moved = order.splice(from, 1)[0]
  order.splice(to, 0, moved)
  return saveTags({ order: order })
}

async function loadStorage (btn) {
  var restore = busyButton(btn, '计算中…')
  try {
    var res = await fetch('/api/admin/storage', { headers: headers(false) })
    state.storage = await res.json()
    if (!state.storage.ok) throw new Error(state.storage.error || '读不到占用')
    toast('已更新占用：' + bytes(state.storage.totalBytes), 'ok')
  } catch (error) {
    toast('计算失败：' + error, 'error')
  } finally { restore() }
  var box = $('storageBody')
  if (box) box.innerHTML = storageHtml()
}

function reviseWith (key, module, btn) {
  var task = taskByKey(key)
  if (!task) { toast('找不到这条课次', 'error'); return }
  var box = document.querySelector('[data-request="' + key + '"]')
  var request = box && box.value.trim()
  if (!request) { toast('先写清要改什么', 'error'); if (box) box.focus(); return }
  if (!task.artifacts || !task.artifacts.transcriptPath) { toast('这条课次还没有转录稿', 'error'); return }
  if (!module) {
    var first = task.lesson && (task.lesson.modules || [])[0]
    if (!first) { toast('还没有模块状态', 'error'); return }
    module = first.outlineNodeId || first.id
  }
  return doAction('revise', {
    transcriptPath: task.artifacts.transcriptPath, course: task.courseName, lesson: task.title, module: module, request: request
  }, btn)
}

async function saveConfig (btn) {
  var values = {}
  document.querySelectorAll('[data-cfg]').forEach(function (el) { if (el.value !== '') values[el.dataset.cfg] = el.value })
  var restore = busyButton(btn, '保存中…')
  try {
    var res = await fetch('/api/admin/config', { method: 'PUT', headers: headers(true), body: JSON.stringify({ values: values }) })
    var data = await res.json().catch(function () { return {} })
    out(JSON.stringify(data, null, 2))
    if (data.ok) toast('设置已保存：' + (data.applied || []).join('、'), 'ok')
    else toast('没保存：' + ((data.errors || []).join('；') || data.error), 'error')
  } catch (error) { toast('保存失败：' + error, 'error') } finally { restore() }
  state.config = null
  load()
}

async function savePassword (clear, btn) {
  var next = document.querySelector('[data-pw="next"]')
  var body = clear ? { action: 'clear' } : { password: next && next.value }
  if (!clear && (!body.password || body.password.length < 8)) { toast('密码至少 8 位', 'error'); return }
  if (clear && !window.confirm('清除密码后只能用服务器上的主令牌登录，确定？')) return
  var restore = busyButton(btn, '处理中…')
  var done = false
  try {
    var res = await fetch('/api/admin/password', { method: 'PUT', headers: headers(true), body: JSON.stringify(body) })
    var data = await res.json().catch(function () { return {} })
    out(JSON.stringify(data, null, 2))
    if (data.ok) { done = true; toast(clear ? '已清除密码' : '密码已更新', 'ok') } else toast('没成功：' + (data.message || data.error), 'error')
    if (res.ok && !clear) { $('token').value = body.password; localStorage.setItem(KEY, body.password) }
  } catch (error) { toast('请求失败：' + error, 'error') } finally { restore() }
  if (done && clear) {
    var stillOk = await load()
    if (!stillOk) { try { localStorage.removeItem(KEY) } catch (e) {}; toast('已清除密码，现在需要用主令牌登录', 'error') }
    return
  }
  load()
}

function handleAct (act, btn) {
  var menu = $('menu')
  if (menu && menu.open) menu.open = false
  var key = btn.dataset.key || ''
  var value = btn.dataset.value || ''
  if (act === 'save') {
    var token = $('token').value.trim()
    localStorage.setItem(KEY, token)
    if (!token) { toast('先填密码或主令牌', 'error'); return }
    return load().then(function (ok) { if (ok) toast('已登录', 'ok') })
  }
  if (act === 'refresh') return load().then(function (ok) { if (ok) toast('已刷新', 'ok') })
  if (act === 'refresh-balance') { refreshBalance(); toast('正在查余额…', 'info'); return }
  if (act === 'rail-toggle') { state.sel.rail = !state.sel.rail; saveSel(); renderCourses(); return }
  if (act === 'sort-toggle') { state.sel.sort = state.sel.sort === 'asc' ? 'desc' : 'asc'; saveSel(); renderCourses(); return }
  if (act === 'filter-all') { state.sel.tag = ''; state.sel.year = 'all'; saveSel(); renderCourses(); return }
  if (act === 'filter-year') { state.sel.year = state.sel.year === value ? 'all' : value; state.sel.tag = ''; saveSel(); renderCourses(); return }
  if (act === 'pick-course') {
    state.sel.course = value; state.sel.lesson = ''; state.preview = null; saveSel(); renderCourses(); return
  }
  if (act === 'pick-lesson') { state.sel.lesson = value; state.preview = null; saveSel(); renderCourses(); return }
  if (act === 'pick-file') { var input = document.querySelector('[data-file="' + key + '"]'); if (input) input.click(); return }
  if (act === 'open-material') return openMaterial(value)
  if (act === 'close-material') { state.preview = null; renderCourses(); return }
  if (act === 'storage-load') return loadStorage(btn)
  if (act === 'add-tag') { var box = document.querySelector('[data-newtag="' + key + '"]'); return addTag(key, box && box.value, 'lesson') }
  if (act === 'remove-tag') return removeTag(key, btn.dataset.tag, 'lesson')
  if (act === 'add-course-tag') { var cbox = document.querySelector('[data-newcoursetag="' + btn.dataset.course + '"]'); return addTag('', cbox && cbox.value, 'course', btn.dataset.course) }
  if (act === 'remove-course-tag') return removeTag('', btn.dataset.tag, 'course', btn.dataset.course)
  if (act === 'integrate') {
    toast('整合材料生成还没做，下一步实现', 'error')
    return
  }
  if (act === 'retry') return doAction('retry', { replayKey: key }, btn)
  if (act === 'republish') {
    var task = taskByKey(key)
    if (!task || !task.artifacts || !task.artifacts.transcriptPath) { toast('这条课次还没有转录稿', 'error'); return }
    return doAction('republish', { transcriptPath: task.artifacts.transcriptPath, course: task.courseName, lesson: task.title, replayKey: key }, btn)
  }
  if (act === 'cycle') return doAction('cycle', { replayKey: key, maxTasks: 1 }, btn)
  if (act === 'ocr-material') {
    var ocrTask = taskByKey(key)
    if (!ocrTask) { toast('找不到这条课次', 'error'); return }
    var pending = (ocrTask.materials || []).reduce(function (total, material) { return total + (material.ocrPending || 0) }, 0)
    if (!pending) { toast('这份课件的图片都已经识别过了'); return }
    // 识别一张图几秒到几十秒：先在按钮上说明要等，别让人以为卡住了
    if (btn) { btn.disabled = true; btn.textContent = '正在识别 ' + pending + ' 张图…' }
    return doAction('ocr-material', { course: ocrTask.courseName, lesson: ocrTask.title, replayKey: key }, btn)
  }
  if (act === 'cycle-all') return doAction('cycle', { maxTasks: 5 }, btn)
  if (act === 'revise') return reviseWith(key, btn.dataset.module, btn)
  if (act === 'revise-first') return reviseWith(key, '', btn)
  if (act === 'notify-retry') return doAction('notify-retry', {}, btn)
  if (act === 'discover' || act === 'notify' || act === 'doctor' || act === 'backup') return doAction(act, {}, btn)
  if (act === 'prune') return doAction('prune', {}, btn)
  if (act === 'prune-apply') {
    if (!window.confirm('确定要删除原件吗？视频、音频、PPT 原件会从磁盘移除；转录稿、课件文字与笔记保留。')) return
    return doAction('prune', { apply: true }, btn)
  }
  if (act === 'save-config') return saveConfig(btn)
  if (act === 'save-password') return savePassword(false, btn)
  if (act === 'clear-password') return savePassword(true, btn)
  toast('这个按钮还没有接上处理逻辑：' + act, 'error')
}

var CHUNK_SIZE = 1024 * 1024
var dragFrom = null

document.addEventListener('click', function (event) {
  var menu = $('menu')
  if (menu && menu.open && !event.target.closest('#menu')) menu.open = false
  var goLink = event.target.closest('[data-go]')
  if (goLink) { event.preventDefault(); go(goLink.dataset.go); return }
  var tab = event.target.closest('.seg button')
  if (tab) { go(tab.dataset.tab); return }
  var tagRow = event.target.closest('.tag-row[data-tag]')
  if (tagRow && !event.target.closest('.grip')) {
    state.sel.tag = state.sel.tag === tagRow.dataset.tag ? '' : tagRow.dataset.tag
    state.sel.year = 'all'
    saveSel(); renderCourses(); return
  }
  var btn = event.target.closest('[data-act]')
  if (!btn) return
  run(function () { return handleAct(btn.dataset.act, btn) })
})

document.addEventListener('change', function (event) {
  var input = event.target.closest ? event.target.closest('[data-file]') : null
  if (!input) return
  var files = input.files
  if (files && files.length) run(function () { return uploadFiles(input.dataset.file, files, null) })
  input.value = ''
})

document.addEventListener('dragstart', function (event) {
  var row = event.target.closest ? event.target.closest('.tag-row[data-tag]') : null
  if (!row) return
  dragFrom = Number(row.dataset.index)
  row.classList.add('dragging')
})
document.addEventListener('dragover', function (event) {
  var row = event.target.closest ? event.target.closest('.tag-row[data-tag]') : null
  if (row && dragFrom !== null) event.preventDefault()
})
document.addEventListener('drop', function (event) {
  var row = event.target.closest ? event.target.closest('.tag-row[data-tag]') : null
  if (!row || dragFrom === null) return
  event.preventDefault()
  var to = Number(row.dataset.index)
  var from = dragFrom
  dragFrom = null
  run(function () { return reorderTags(from, to) })
})
document.addEventListener('dragend', function () {
  dragFrom = null
  document.querySelectorAll('.tag-row.dragging').forEach(function (el) { el.classList.remove('dragging') })
})

document.addEventListener('input', function (event) {
  var box = event.target && event.target.closest ? event.target.closest('[data-request]') : null
  if (box) state.requests[box.dataset.request] = box.value
})
document.addEventListener('toggle', function (event) {
  var node = event.target
  if (!node || !node.dataset || !node.dataset.fold) return
  setOpen(node.dataset.fold, node.open)
}, true)
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') { var menu = $('menu'); if (menu && menu.open) menu.open = false; return }
  if (event.key !== 'Enter') return
  var target = event.target
  if (!target || !target.dataset) return
  if (target.dataset.newtag) { event.preventDefault(); run(function () { return addTag(target.dataset.newtag, target.value, 'lesson') }); return }
  if (target.dataset.newcoursetag) { event.preventDefault(); run(function () { return addTag('', target.value, 'course', target.dataset.newcoursetag) }); return }
  if (target.dataset.request) {
    event.preventDefault()
    run(function () { return reviseWith(target.dataset.request, '', document.querySelector('[data-act="revise-first"][data-key="' + target.dataset.request + '"]')) })
    return
  }
  if (target.dataset.pw === 'next') { event.preventDefault(); run(function () { return savePassword(false, document.querySelector('[data-act="save-password"]')) }) }
})

load()
setInterval(function () {
  if (state.busy || document.hidden) return
  run(function () { return load({ quiet: true }) })
}, 20000)
</script>
</body>
</html>
`
