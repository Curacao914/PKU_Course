/**
 * 管理台页面。
 *
 * 设计原则（2026-09-26 重做，用户反馈「太臃肿、信息太爆炸」）：
 *
 *   1. **一屏只回答一个问题。** 概览先回答"现在需要我做什么"，其余数字排在后面。
 *      第一版把阶段分布、余额、最近运行、待办全铺在一屏，等于什么都没说。
 *   2. **默认折叠，需要时展开。** 课程按课程折叠、课次按行折叠、设置里的参数与密码折叠、
 *      运行输出折叠。用原生 <details>：没有构建步骤，也不需要自己写展开逻辑。
 *   3. **一件事一个动作。** 上传课件不再是"先点选文件、再点上传"两步，而是
 *      「选择课件并上传」一个按钮（也可以直接把文件拖到那一行）。
 *   4. **数字要说明白。** 花费按"转写 / 笔记"两笔分开显示，并把单价写在旁边——
 *      用户问过"为什么阿里云花了八块多"，界面上就该能自己回答。
 *   5. **按钮点下去必须当场有反应。** 置灰改字 + 顶部状态灯 + 右下角提示，
 *      跑完再弹明确的成功/失败（见 docs/09 §9）。
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
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;letter-spacing:-.005em;overflow-wrap:anywhere}
/* 路径、replayKey、URL 这类长串没有空格，不强制断行会把窄屏整体撑宽 */
code,.tiny,pre,td{overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-ink)}
.wrap{max-width:960px;margin:0 auto;padding:0 22px}

/* 顶栏：只留身份、状态与一个"更多"入口 */
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
.menu .sheet{position:absolute;right:0;top:38px;width:290px;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r-md);box-shadow:var(--shadow);padding:14px}
.menu .sheet a{display:block;padding:6px 0}
.menu label{display:block;font-size:12.5px;color:var(--ink-3);margin:8px 0 4px}

/* 分区导航：分段控件 */
nav.seg{display:flex;gap:2px;background:var(--sunken);border-radius:10px;padding:2px;margin:18px 0 22px;width:fit-content}
nav.seg button{font:inherit;font-size:14px;border:0;background:none;color:var(--ink-2);padding:6px 16px;border-radius:8px;cursor:pointer}
nav.seg button[aria-selected=true]{background:var(--card);color:var(--ink);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.08)}

main{padding-bottom:80px}
h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:19px;letter-spacing:-.015em;margin:0 0 10px}
h3{font-size:16px;margin:0 0 8px}
p{margin:0 0 10px}
.lede{color:var(--ink-2);font-size:15px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px 22px;box-shadow:var(--shadow);margin-bottom:16px}
.card .sub{color:var(--ink-3);font-size:13.5px;margin:-4px 0 12px}
.grid{display:grid;gap:16px}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid.three{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.stat{font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1.1}
.stat small{display:block;font-size:13px;font-weight:400;color:var(--ink-3);letter-spacing:0;margin-top:4px}

/* 待办：一条一行，右边一个动作 */
.todo{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.todo:first-of-type{border-top:0;padding-top:2px}
.todo .t{flex:1;min-width:0}
.todo .t b{display:block;font-weight:500}
.todo .t span{color:var(--ink-3);font-size:13.5px}
.empty-ok{display:flex;align-items:center;gap:10px;color:var(--ok);font-size:15px}

button.act{font:inherit;font-size:14px;padding:7px 14px;border-radius:980px;border:1px solid var(--line-2);
  background:var(--card);color:var(--ink);cursor:pointer;white-space:nowrap}
button.act:hover{border-color:var(--ink-3)}
button.act[disabled]{opacity:.5;cursor:progress}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{background:var(--accent-ink);border-color:var(--accent-ink);color:#fff}
button.quiet{border-color:transparent;background:var(--sunken);color:var(--ink-2)}
button.danger{border-color:#eccac7;color:var(--danger)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.muted{color:var(--ink-3)}.small{font-size:13.5px}.tiny{font-size:12.5px}

/* 折叠：课程、课次、参数、输出都用同一套 */
details.d{border-top:1px solid var(--line)}
details.d:first-of-type{border-top:0}
details.d>summary{list-style:none;cursor:pointer;padding:14px 2px;display:flex;align-items:center;gap:12px}
details.d>summary::-webkit-details-marker{display:none}
details.d>summary::after{content:'';width:8px;height:8px;border-right:1.6px solid var(--ink-3);border-bottom:1.6px solid var(--ink-3);
  transform:rotate(-45deg);margin-left:auto;transition:transform .2s ease;flex:none}
details.d[open]>summary::after{transform:rotate(45deg)}
details.d>summary:hover .ttl{color:var(--accent-ink)}
.ttl{font-weight:500}
.body{padding:0 2px 18px}
.sub-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.sub-row:first-child{border-top:0}
.sub-row .name{flex:1;min-width:0}
.sub-row .name span{display:block;color:var(--ink-3);font-size:12.5px}
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
.drop{border:1px dashed var(--line-2);border-radius:var(--r-md);padding:12px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.drop.hot{border-color:var(--accent);background:var(--accent-soft)}
.status{font-size:13.5px;color:var(--ink-3);margin-top:8px;min-height:0}
.status.bad{color:var(--danger)}
.status.ok{color:var(--ok)}
pre{background:var(--sunken);border-radius:var(--r-md);padding:14px;overflow:auto;max-height:340px;font-size:12.5px;margin:0}
.toast{position:fixed;right:20px;bottom:20px;z-index:60;max-width:min(420px,calc(100vw - 40px));padding:12px 15px;
  border-radius:var(--r-md);border:1px solid var(--line);background:rgba(255,255,255,.98);box-shadow:var(--shadow);
  font-size:14px;color:var(--ink-2);opacity:0;transform:translateY(10px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.ok{border-color:#cfe4d8;background:var(--accent-soft);color:var(--accent-ink)}
.toast.error{border-color:#eccac7;background:var(--danger-soft);color:var(--danger)}
@media (max-width:560px){
  body{font-size:15.5px}
  h1{font-size:24px}
  .card{padding:16px}
  .stat{font-size:26px}
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
    <button role="tab" data-tab="notes" aria-selected="false">笔记</button>
    <button role="tab" data-tab="settings" aria-selected="false">设置</button>
  </nav>
  <section id="tab-overview"></section>
  <section id="tab-courses" hidden></section>
  <section id="tab-notes" hidden></section>
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
// requests：每个课次输入框里正在写的要求。重绘很频繁，不记住就会把写到一半的字冲掉。
// open：哪些折叠块是展开的。整页 innerHTML 重绘很频繁（每次操作后、每 20 秒轮询一次），
// 不记住展开状态的话，用户点开的课次每 20 秒自己收回去一次——"我什么都没动，它自己收了"。
// key 用块自身的标识（课程名/课次 key/固定名），与 DOM 位置无关。
var state = { status: null, balance: null, config: null, tab: 'overview', busy: false, requests: {}, uploads: {}, open: {} }
var OPEN_KEY = 'course.admin.open'

try {
  var savedOpen = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}')
  if (savedOpen && typeof savedOpen === 'object') state.open = savedOpen
} catch (e) { state.open = {} }

function isOpen (key) { return state.open[key] === true }
function foldAttrs (key) { return ' data-fold="' + esc(key) + '"' + (isOpen(key) ? ' open' : '') }

var LABELS = {
  discover: '扫描教学网', cycle: '跑一轮完整链路', 'cycle-all': '跑一轮完整链路',
  notify: '投递通知', doctor: '体检', backup: '备份账本', prune: '清理预演',
  'prune-apply': '清理并删除原件', retry: '重跑这节课', republish: '重新发布',
  revise: '按新要求重写模块', 'notify-retry': '重发失败通知'
}
var MODULE_TEXT = { approved: '已通过', draft: '草稿', reviewing: '审查中', revising: '重写中', pending: '待写', failed: '失败' }
var STAGE_TEXT = {
  discovered: '待处理', queued: '排队中', downloading: '下载中', downloaded: '已下载',
  transcribing: '转写中', transcript_ready: '待写笔记', writing: '写笔记中',
  notes_ready: '待发布', publishing: '发布中', published: '已发布',
  needs_attention: '卡住了', failed: '失败', completed: '已完成'
}

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
function stagePill (stage) {
  var cls = stage === 'published' ? 'ok' : stage === 'needs_attention' || stage === 'failed' ? 'bad' : ''
  return '<span class="pill ' + cls + '"><span class="dot"></span>' + esc(STAGE_TEXT[stage] || stage) + '</span>'
}
function taskByKey (key) {
  var tasks = (state.status && state.status.ledger && state.status.ledger.tasks) || []
  for (var i = 0; i < tasks.length; i += 1) if (tasks[i].replayKey === key) return tasks[i]
  return null
}
function card (inner, cls) { return '<div class="card ' + (cls || '') + '">' + inner + '</div>' }

/* ── 反馈：右下角提示 + 按钮置灰 + 顶部状态灯 ── */
var toastTimer = null
function toast (message, kind) {
  var el = $('toast')
  el.textContent = String(message)
  el.className = 'toast show ' + (kind || 'info')
  clearTimeout(toastTimer)
  if (kind !== 'error') toastTimer = setTimeout(function () { el.className = 'toast' }, 7000)
}
function out (text) { $('out').textContent = String(text) }
function setRunState (text, cls) {
  $('runState').className = 'chip ' + (cls || '')
  $('runState').innerHTML = '<span class="dot"></span>' + esc(text)
}
function busyButton (btn, text) {
  if (!btn || btn.tagName !== 'BUTTON') return function () {}
  var old = btn.textContent
  btn.disabled = true
  btn.textContent = text || '处理中…'
  return function () { btn.disabled = false; btn.textContent = old }
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
function isDirty () {
  var active = document.activeElement
  if (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return true
  var boxes = document.querySelectorAll('[data-request],[data-pw="next"]')
  for (var i = 0; i < boxes.length; i += 1) if (boxes[i].value) return true
  return false
}
function setStatus (key, text, kind) {
  var el = document.querySelector('[data-status="' + key + '"]')
  if (!el) return
  el.className = 'status ' + (kind || '')
  el.textContent = text
}

async function load (options) {
  options = options || {}
  var res = await fetch('/api/admin/status', { headers: headers(false) })
  var data = await res.json()
  if (!res.ok) {
    var reason = data.error === 'admin_token_unconfigured'
      ? '服务端没有配置 COURSE_ADMIN_TOKEN，管理台已关闭。'
      : data.error === 'too_many_attempts'
        ? '凭据错误次数过多，请等 5 分钟再试。'
        : $('token').value.trim() ? '凭据不对' : '未登录：点右上角 ··· 填入密码或主令牌'
    $('tab-overview').innerHTML = card('<h2>需要登录</h2><p class="muted">' + reason + '</p>')
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
function render () {
  document.querySelectorAll('.seg button').forEach(function (btn) {
    var on = btn.dataset.tab === state.tab
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
    $('tab-' + btn.dataset.tab).hidden = !on
  })
  renderRunState()
  renderOverview(); renderCourses(); renderNotes(); renderSettings()
}

/* ── 概览：先回答"现在要做什么" ── */
function renderOverview () {
  if (!state.status) return
  var s = state.status
  var t = s.todos || {}
  var ledger = s.ledger || {}
  var tasks = ledger.tasks || []
  var counts = { published: 0, running: 0, waiting: 0 }
  tasks.forEach(function (task) {
    if (task.stage === 'published') counts.published += 1
    else if (task.stage === 'discovered') counts.waiting += 1
    else counts.running += 1
  })

  // 待办：能点一下就去的，才放在第一屏
  var todos = []
  ;(t.stuck || []).forEach(function (item) {
    todos.push({ title: item.courseName + ' · ' + item.title, note: '连续失败已停止重试：' + String(item.lastError || '').slice(0, 60), label: '去重跑', tab: 'courses' })
  })
  ;(t.missingMaterials || []).forEach(function (item) {
    todos.push({ title: item.courseName + ' · ' + item.title, note: '缺课件', label: '传课件', tab: 'courses' })
  })
  var channel = s.channel || { ok: true }
  if (channel.ok === false) {
    todos.push({ title: '推送发不出去', note: '通道未就绪', label: '查看', tab: 'overview' })
  }
  if (t.failedDeliveries) {
    todos.push({ title: t.failedDeliveries + ' 条通知发送失败', note: '未送达', label: '重发', tab: 'notes' })
  }

  var hero = todos.length
    ? '<h1>' + todos.length + ' 件事待处理</h1>' +
      todos.map(function (item) {
        return '<div class="todo"><div class="t"><b>' + esc(item.title) + '</b><span>' + esc(item.note) + '</span></div>' +
          '<button class="act" data-go="' + item.tab + '">' + esc(item.label) + '</button></div>'
      }).join('')
    : '<h1>无待办</h1><div class="empty-ok"><span class="pill ok"><span class="dot"></span>一切正常</span></div>'

  var spend = s.spend || { asrCny: 0, notesCny: 0, totalCny: 0 }
  var pricing = s.pricing || {}

  $('tab-overview').innerHTML =
    card(hero) +
    card(
      '<div class="grid three">' +
        '<div class="stat">' + counts.published + '<small>已发布</small></div>' +
        '<div class="stat">' + counts.running + '<small>进行中</small></div>' +
        '<div class="stat">' + counts.waiting + '<small>还没轮到</small></div>' +
      '</div>',
      ''
    ) +
    '<div class="grid two">' +
      card('<h2>花费</h2><div class="stat">' + money(spend.totalCny) + '<small>已发生合计 · 转写 ' + money(spend.asrCny) + ' + 笔记 ' + money(spend.notesCny) + '</small></div>' +
        '<div class="row" style="margin-top:14px;align-items:flex-start">' + balancesHtml() + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="act quiet" data-act="refresh-balance">刷新余额</button></div>' +
        '<div class="tiny muted" style="margin-top:10px">转写 ¥' + (pricing.asrPerHourCny || 0.288) + '/小时（按语音时长）· 笔记 ¥' + (pricing.noteInputPerMillionCny || 1) + ' / ¥' + (pricing.noteOutputPerMillionCny || 4) + ' 每百万 token（输入/输出）</div>') +
      card('<h2>推送通道</h2>' + channelHtml()) +
    '</div>' +
    card('<details class="d" style="border-top:0"' + foldAttrs('overview:runs') + '><summary><span class="ttl">最近运行</span><span class="muted small">' + ((s.runs || []).length) + ' 次</span></summary><div class="body">' + runsTable() + '</div></details>')
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
  return rows.join('')
}
function runsTable () {
  var runs = (state.status.runs || []).slice(0, 6)
  if (!runs.length) return '<p class="muted small">还没有运行记录</p>'
  return '<table><thead><tr><th>时间</th><th>运行</th><th>结果</th></tr></thead><tbody>' +
    runs.map(function (r) {
      var tasks = (r.summary && r.summary.tasks) || []
      var ok = tasks.filter(function (x) { return x.ok }).length
      return '<tr><td class="small">' + esc(String(r.at).slice(5, 16).replace('T', ' ')) + '</td><td class="small">' + esc(r.name) + '</td><td class="small">' +
        (r.summary ? ok + ' 成功 / ' + (tasks.length - ok) + ' 失败' : '—') + '</td></tr>'
    }).join('') + '</tbody></table>'
}

/* ── 课程：按课程折叠，课次再折叠 ── */
function materialBlock (task) {
  var list = (task.materials || []).map(function (m) {
    return '<span class="pill">' + esc(m.name) + (m.scope === 'course' ? ' · 全课程' : '') + ' · ' + m.slideCount + ' 页</span>'
  }).join(' ')
  var key = task.replayKey
  var status = state.uploads[key] || ''
  return '<div class="drop" data-drop="' + esc(key) + '">' +
    '<input class="hidden-file" type="file" data-file="' + esc(key) + '" accept=".pptx,.ppt,.pdf">' +
    '<button class="act" data-act="pick" data-key="' + esc(key) + '">选择课件并上传</button>' +
    '<span class="small muted">或拖入 .pptx / .pdf</span>' +
    '</div>' +
    '<div class="status ' + (status.indexOf('失败') === 0 ? 'bad' : status ? 'ok' : '') + '" data-status="' + esc(key) + '">' + esc(status) + '</div>' +
    (list ? '<div style="margin-top:8px">' + list + '</div>' : '<p class="small muted" style="margin:8px 0 0">无课件</p>')
}

function lessonDetails (task, index) {
  var lesson = task.lesson || {}
  var cost = task.cost || {}
  var title = String(task.title || '') + (task.courseName ? '' : '')
  var costText = cost.totalCny ? '转写 ' + money(cost.asrCny) + ' · 笔记 ' + money(cost.notesCny) : '还没花钱'
  var actions = '<div class="row" style="margin-top:12px">' +
    '<button class="act primary" data-act="cycle" data-key="' + esc(task.replayKey) + '">跑一轮</button>' +
    '<button class="act" data-act="retry" data-key="' + esc(task.replayKey) + '">重跑</button>' +
    (task.artifacts && task.artifacts.transcriptPath ? '<button class="act" data-act="republish" data-key="' + esc(task.replayKey) + '">重新发布</button>' : '') +
    '</div>'
  var metaBits = [esc(task.replayKey), '尝试 ' + task.attempts + ' 次']
  if (task.updatedAt) metaBits.push('更新于 ' + esc(String(task.updatedAt).slice(5, 16).replace('T', ' ')))
  if (lesson.finalChars) metaBits.push('成品 ' + lesson.finalChars + ' 字')
  if (cost.usage) metaBits.push(cost.usage.calls + ' 次模型调用')
  var meta = '<div class="tiny muted" style="margin-bottom:10px">' + metaBits.join(' · ') + '</div>'
  var error = task.lastError ? '<p class="small" style="color:var(--danger);margin:10px 0 0">最近错误：' + esc(String(task.lastError).slice(0, 200)) + '</p>' : ''
  var noteLine = ''
  return '<details class="d"' + foldAttrs('lesson:' + task.replayKey) + '><summary><span class="ttl">' + esc(title) + '</span>' + stagePill(task.stage) +
    '<span class="muted small">' + esc(costText) + '</span></summary>' +
    '<div class="body">' + meta + noteLine + materialBlock(task) + error + actions + '</div></details>'
}

function renderCourses () {
  var tasks = (state.status.ledger && state.status.ledger.tasks) || []
  var groups = {}
  tasks.forEach(function (t) {
    var key = t.courseName || '未分类'
    groups[key] = groups[key] || []
    groups[key].push(t)
  })
  var html = Object.keys(groups).map(function (course) {
    var list = groups[course].slice().sort(function (a, b) { return String(b.title).localeCompare(String(a.title)) })
    var done = list.filter(function (t) { return t.stage === 'published' }).length
    var alert = list.some(function (t) { return t.stage === 'needs_attention' || t.stage === 'failed' })
    return '<details class="d"' + foldAttrs('course:' + course) + '><summary><span class="ttl">' + esc(course) + '</span>' +
      '<span class="muted small">' + done + ' / ' + list.length + ' 讲已发布</span>' +
      (alert ? '<span class="pill bad"><span class="dot"></span>有卡住的</span>' : '') + '</summary>' +
      '<div class="body">' + list.map(lessonDetails).join('') + '</div></details>'
  }).join('')
  var parked = state.status.unassigned || []
  $('tab-courses').innerHTML = card(
    (html || '<p class="muted">账本里还没有课次</p>')) +
    (parked.length ? card('<h2>归属不明的课件</h2><div>' + parked.map(function (n) { return '<span class="pill warn">' + esc(n) + '</span>' }).join(' ') + '</div>' +
      '<p class="small muted" style="margin-top:10px">改名成 课程__课次.pptx 放进收件箱，再跑一次归档</p>') : '')
}

/* ── 笔记：逐模块重写 ── */
function renderNotes () {
  var tasks = (state.status.ledger && state.status.ledger.tasks) || []
  var withNotes = tasks.filter(function (t) { return t.lesson && (t.lesson.modules || []).length })
  var cards = withNotes.map(function (t) {
    var rows = t.lesson.modules.map(function (m) {
      var id = m.outlineNodeId || m.id
      return '<tr><td>' + esc(m.title || m.id) + '</td><td class="small muted">' + m.chars + ' 字</td><td class="small muted">' + esc(MODULE_TEXT[m.status] || m.status) + '</td>' +
        '<td style="text-align:right"><button class="act quiet" data-act="revise" data-key="' + esc(t.replayKey) + '" data-module="' + esc(id) + '">重写</button></td></tr>'
    }).join('')
    return '<details class="d"' + foldAttrs('note:' + t.replayKey) + '><summary><span class="ttl">' + esc(t.courseName + ' · ' + t.title) + '</span>' +
      '<span class="muted small">成品 ' + t.lesson.finalChars + ' 字 · ' + t.lesson.modules.length + ' 个模块</span></summary>' +
      '<div class="body">' +
      '<table><thead><tr><th>模块</th><th>字数</th><th>状态</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="row" style="margin-top:12px"><input data-request="' + esc(t.replayKey) + '" value="' + esc(state.requests[t.replayKey] || '') + '" placeholder="修改要求（例如：这一段太长，压缩到 1200 字并拆成列表）">' +
      '<button class="act primary" data-act="revise-first" data-key="' + esc(t.replayKey) + '">按这个要求重写</button></div>' +
      '</div></details>'
  }).join('')
  var deliveries = (state.status.ledger && state.status.ledger.deliveries) || []
  var failed = (state.status.todos && state.status.todos.failedDeliveries) || 0
  var rows = deliveries.slice(0, 12).map(function (x) {
    var cls = x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'bad' : ''
    return '<tr><td class="small">' + esc(x.purpose) + '</td><td><span class="pill ' + cls + '">' + esc(x.status) + '</span></td>' +
      '<td class="small muted">' + esc(String(x.sent_at || x.created_at || '').slice(5, 16).replace('T', ' ')) + '</td>' +
      '<td class="tiny muted">' + esc(String(x.last_error || '').slice(0, 60)) + '</td></tr>'
  }).join('')
  $('tab-notes').innerHTML = card(
      (cards || '<p class="muted">还没有带模块状态的笔记</p>') +
      (failed ? '<div class="row" style="margin-top:14px"><button class="act primary" data-act="notify-retry">把 ' + failed + ' 条失败通知放回队列</button></div>' : '')) +
    card('<details class="d" style="border-top:0"' + foldAttrs('notes:deliveries') + '><summary><span class="ttl">通知记录</span><span class="muted small">最近 ' + Math.min(12, deliveries.length) + ' 条</span></summary>' +
      '<div class="body">' + (rows ? '<table><thead><tr><th>用途</th><th>状态</th><th>时间</th><th>错误</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted small">队列为空</p>') + '</div></details>')
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
      input = '<select data-cfg="' + key + '">' +
        '<option value=""' + (value === '' ? ' selected' : '') + '>跟随环境变量</option>' +
        '<option value="true"' + (value === true ? ' selected' : '') + '>开启</option>' +
        '<option value="false"' + (value === false ? ' selected' : '') + '>关闭</option></select>'
    } else {
      input = '<input data-cfg="' + key + '" type="' + (spec.type === 'number' ? 'number' : 'text') + '" value="' + esc(value) + '" placeholder="跟随环境变量">'
    }
    return '<div class="field"><label>' + esc(spec.label || key) + '</label>' + input +
      (spec.hint ? '<div class="tiny muted" style="margin-top:4px">' + esc(spec.hint) + '</div>' : '') + '</div>'
  }).join('')

  $('tab-settings').innerHTML = card(
      '<div class="row"><button class="act primary" data-act="cycle-all">跑一轮完整链路</button>' +
      '<button class="act" data-act="discover">扫描教学网</button>' +
      '<button class="act" data-act="notify">投递通知</button>' +
      '<button class="act" data-act="doctor">体检</button>' +
      '<button class="act" data-act="backup">备份账本</button></div>' +
      '') +
    card('<details class="d" style="border-top:0"' + foldAttrs('settings:params') + '><summary><span class="ttl">运行参数</span><span class="muted small">篇幅、并发、成本窗口</span></summary>' +
      '<div class="body">' + fields + '<div class="row"><button class="act primary" data-act="save-config">保存设置</button></div>' +
      '<div class="tiny muted" style="margin-top:8px">' + esc(c.path || '') + '</div></div></details>' +
      '<details class="d"' + foldAttrs('settings:password') + '><summary><span class="ttl">登录密码</span><span class="muted small">' + ((state.status.auth && state.status.auth.passwordSet) ? '已设置' : '未设置') + '</span></summary>' +
      '<div class="body">' + passwordPanel() + '</div></details>' +
      '<details class="d"' + foldAttrs('settings:prune') + '><summary><span class="ttl">清理原件</span><span class="muted small">不可撤销</span></summary>' +
      '<div class="body"><p class="small muted">只删通过校验的原始媒体与 PPT；转录稿、课件文字、笔记保留。</p>' +
      '<div class="row"><button class="act" data-act="prune">清理预演</button><button class="act danger" data-act="prune-apply">清理并删除</button></div></div></details>')
}

function passwordPanel () {
  var auth = (state.status && state.status.auth) || {}
  return (auth.masterTokenSet ? '' : '<p class="small" style="color:var(--danger)">主令牌未配置：忘记密码只能去服务器重设。</p>') +
    '<div class="field"><label>新密码（至少 8 位）</label><input data-pw="next" type="password" autocomplete="new-password" placeholder="新密码"></div>' +
    '<div class="row"><button class="act primary" data-act="save-password">保存新密码</button>' +
    '<button class="act" data-act="clear-password">清除密码（只留主令牌）</button></div>'
}

function go (tab) {
  state.tab = tab
  render()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/* ── 动作 ── */
async function doAction (action, extra, btn) {
  if (state.busy || (state.status && state.status.running)) {
    toast('服务端已经有任务在跑，等它结束再点', 'error')
    return
  }
  var label = LABELS[action] || action
  var restore = busyButton(btn, '处理中…')
  state.busy = true
  setRunState('正在运行 ' + label, 'warn')
  out('运行中…（' + label + '）')
  toast('已开始：' + label, 'info')
  try {
    var res = await fetch('/api/admin/run', { method: 'POST', headers: headers(true), body: JSON.stringify(Object.assign({ action: action }, extra || {})) })
    var data = await res.json()
    out(JSON.stringify(data, null, 2))
    if (res.status === 409) toast('服务端正忙（' + (data.action || '别的任务') + '），稍后再点', 'error')
    else if (data.ok) toast('完成：' + label + '（退出码 ' + data.exitCode + '）', 'ok')
    else toast('没成功：' + label + ' —— ' + (data.message || data.error || ('退出码 ' + data.exitCode)), 'error')
  } catch (error) {
    out('请求失败：' + error)
    toast('请求失败：' + error, 'error')
  } finally {
    state.busy = false
    restore()
  }
  load()
}

/**
 * 上传课件：选好文件就直接传，不需要再点一次按钮。
 *
 * 大文件走**分片**：Cloudflare 隧道会把大的请求体中途掐断（实测 20MB 传到 12MB
 * 就被关掉，服务端一个字节都没落盘），而课件动辄二三十兆。切成 1MB 一片之后
 * 每个请求都又小又快，顺便还能报进度——用户至少知道"正在传第几片"。
 */
var CHUNK_SIZE = 1024 * 1024

/**
 * 传一片，失败自动重试两次。
 *
 * 网络抖动（隧道断一下、Wi-Fi 切换）会让 fetch 直接抛 TypeError: Failed to fetch——
 * 一个 25MB 的课件有二十多片，任何一片抖一下整包就白传，用户只看到"失败"。
 * 分片的意义之一就是可以单独重试，所以这里兜住。
 */
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
    } catch (error) {
      lastError = error
    }
    await new Promise(function (done) { setTimeout(done, 600 * attempt) })
  }
  throw lastError
}

async function uploadDeck (key, file, btn) {
  var task = taskByKey(key)
  if (!task || !task.courseName) { toast('找不到这条课次的课程名，先刷新页面', 'error'); return }
  if (!file) {
    var input = document.querySelector('[data-file="' + key + '"]')
    file = input && input.files && input.files[0]
  }
  if (!file) { toast('先选一个 .pptx / .ppt / .pdf 文件', 'error'); return }
  var restore = busyButton(btn, '上传中…')
  var sizeMb = (file.size / 1048576).toFixed(1)
  state.uploads[key] = '上传中…（' + file.name + ' · ' + sizeMb + 'MB）'
  setStatus(key, state.uploads[key])
  toast('上传并解析：' + file.name, 'info')
  try {
    var data
    if (file.size > 2 * CHUNK_SIZE) {
      var uploadId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
      var total = Math.ceil(file.size / CHUNK_SIZE)
      for (var index = 0; index < total; index += 1) {
        var percent = Math.round((index / total) * 100)
        state.uploads[key] = '上传中 ' + percent + '%（' + file.name + ' · ' + sizeMb + 'MB · 第 ' + (index + 1) + '/' + total + ' 片）'
        setStatus(key, state.uploads[key])
        await putChunk(uploadId, index, file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE))
      }
      state.uploads[key] = '解析中…（' + file.name + '）'
      setStatus(key, state.uploads[key])
      var res = await fetch('/api/admin/materials/commit', {
        method: 'POST', headers: headers(true),
        body: JSON.stringify({ uploadId: uploadId, course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name, chunks: total })
      })
      data = await res.json()
    } else {
      var params = new URLSearchParams({ course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name })
      var single = await fetch('/api/admin/materials?' + params.toString(), { method: 'PUT', headers: headers(false), body: file })
      data = await single.json()
    }
    out(JSON.stringify(data, null, 2))
    if (data.ok) {
      var when = new Date().toTimeString().slice(0, 5)
      state.uploads[key] = '已归档：' + data.name + '（' + data.slideCount + ' 页 · ' + when + '）'
      toast('已归档：' + data.name + '（' + data.slideCount + ' 页）', 'ok')
    } else {
      state.uploads[key] = '失败：' + (data.message || data.error)
      toast('上传失败：' + (data.message || data.error), 'error')
    }
  } catch (error) {
    state.uploads[key] = '失败：' + error + '（可重试；仍失败就把文件放进服务器收件箱再跑一次归档）'
    toast('上传失败：' + error, 'error')
  } finally {
    restore()
    setStatus(key, state.uploads[key], state.uploads[key].indexOf('失败') === 0 ? 'bad' : 'ok')
  }
  load()
}

function reviseWith (key, module, btn) {
  var task = taskByKey(key)
  if (!task) { toast('找不到这条课次，先点刷新', 'error'); return }
  var box = document.querySelector('[data-request="' + key + '"]')
  var request = box && box.value.trim()
  if (!request) { toast('先在输入框里写清要改什么', 'error'); if (box) box.focus(); return }
  if (!task.artifacts || !task.artifacts.transcriptPath) { toast('这条课次还没有转录稿，无法重写模块', 'error'); return }
  if (!module) {
    var first = task.lesson && (task.lesson.modules || [])[0]
    if (!first) { toast('还没有模块状态：先跑完一次笔记阶段', 'error'); return }
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
    var data = await res.json()
    out(JSON.stringify(data, null, 2))
    if (data.ok) toast('设置已保存：' + (data.applied || []).join('、'), 'ok')
    else toast('没保存：' + ((data.errors || []).join('；') || data.error), 'error')
  } catch (error) {
    out('保存失败：' + error)
    toast('保存失败：' + error, 'error')
  } finally { restore() }
  state.config = null
  load()
}

async function savePassword (clear, btn) {
  var next = document.querySelector('[data-pw="next"]')
  var body = clear ? { action: 'clear' } : { password: next && next.value }
  if (!clear && (!body.password || body.password.length < 8)) { toast('密码至少 8 位', 'error'); if (next) next.focus(); return }
  if (clear && !window.confirm('清除密码后只能用服务器上的主令牌登录，确定？')) return
  var restore = busyButton(btn, '处理中…')
  var done = false
  try {
    var res = await fetch('/api/admin/password', { method: 'PUT', headers: headers(true), body: JSON.stringify(body) })
    var data = await res.json()
    out(JSON.stringify(data, null, 2))
    if (data.ok) { done = true; toast(clear ? '已清除密码，现在只能用主令牌登录' : '密码已更新，当前浏览器已换用新密码', 'ok') }
    else toast('没成功：' + (data.message || data.error), 'error')
    if (res.ok && !clear) {
      $('token').value = body.password
      localStorage.setItem(KEY, body.password)
    }
  } catch (error) {
    out('请求失败：' + error)
    toast('请求失败：' + error, 'error')
  } finally { restore() }
  if (done && clear) {
    // 先试试手上这串还能不能用：本来就是主令牌的话，没必要把人踢出去重新登录
    var stillOk = await load()
    if (stillOk) { toast('已清除密码；当前浏览器用的是主令牌，仍然有效', 'ok'); return }
    try { localStorage.removeItem(KEY) } catch (e) {}
    toast('已清除密码，现在需要用主令牌登录', 'error')
    return
  }
  load()
}

/* ── 事件委托：界面里按钮很多，逐个绑定既容易漏也和引号打架 ── */
function handleAct (act, btn) {
  var key = btn.dataset.key || ''
  var menu = $('menu')
  if (menu && menu.open) menu.open = false
  if (act === 'save') {
    var value = $('token').value.trim()
    localStorage.setItem(KEY, value)
    if (!value) { toast('先填密码或主令牌', 'error'); return }
    return load().then(function (ok) { if (ok) toast('已登录', 'ok') })
  }
  if (act === 'refresh') return load().then(function (ok) { if (ok) toast('已刷新', 'ok') })
  if (act === 'refresh-balance') { refreshBalance(); toast('正在查余额…', 'info'); return }
  if (act === 'pick') {
    var input = document.querySelector('[data-file="' + key + '"]')
    if (input) input.click()
    return
  }
  if (act === 'retry') return doAction('retry', { replayKey: key }, btn)
  if (act === 'republish') {
    var task = taskByKey(key)
    if (!task || !task.artifacts || !task.artifacts.transcriptPath) { toast('这条课次还没有转录稿，无法重新发布', 'error'); return }
    return doAction('republish', { transcriptPath: task.artifacts.transcriptPath, course: task.courseName, lesson: task.title, replayKey: key }, btn)
  }
  if (act === 'cycle') return doAction('cycle', { replayKey: key, maxTasks: 1 }, btn)
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

document.addEventListener('click', function (event) {
  // 顶栏的 ··· 面板是浮层：点到别处就要收起来，
  // 否则它会一直盖在内容上、把点击吃掉（看起来就像"按钮点不动"）
  var menu = $('menu')
  if (menu && menu.open && !event.target.closest('#menu')) menu.open = false
  var goLink = event.target.closest('[data-go]')
  if (goLink) { event.preventDefault(); go(goLink.dataset.go); return }
  var tab = event.target.closest('.seg button')
  if (tab) { go(tab.dataset.tab); return }
  var btn = event.target.closest('[data-act]')
  if (!btn) return
  run(function () { return handleAct(btn.dataset.act, btn) })
})

// 选好文件就直接上传；拖进来也一样——不再要求"先选文件再点上传"
document.addEventListener('change', function (event) {
  var input = event.target.closest ? event.target.closest('[data-file]') : null
  if (!input) return
  var file = input.files && input.files[0]
  if (file) run(function () { return uploadDeck(input.dataset.file, file) })
})
document.addEventListener('dragover', function (event) {
  var zone = event.target.closest ? event.target.closest('[data-drop]') : null
  if (!zone) return
  event.preventDefault()
  zone.classList.add('hot')
})
document.addEventListener('dragleave', function (event) {
  var zone = event.target.closest ? event.target.closest('[data-drop]') : null
  if (zone) zone.classList.remove('hot')
})
document.addEventListener('drop', function (event) {
  var zone = event.target.closest ? event.target.closest('[data-drop]') : null
  if (!zone) return
  event.preventDefault()
  zone.classList.remove('hot')
  var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
  if (file) run(function () { return uploadDeck(zone.dataset.drop, file) })
})
document.addEventListener('input', function (event) {
  var box = event.target && event.target.closest ? event.target.closest('[data-request]') : null
  if (box) state.requests[box.dataset.request] = box.value
})

// 折叠块的展开状态记下来：下一次重绘（操作后或 20 秒轮询）要原样还原
document.addEventListener('toggle', function (event) {
  var node = event.target
  if (!node || !node.dataset || !node.dataset.fold) return
  state.open[node.dataset.fold] = node.open
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(state.open)) } catch (e) {}
}, true)
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    var menu = $('menu')
    if (menu && menu.open) menu.open = false
    return
  }
  if (event.key !== 'Enter') return
  var target = event.target
  if (!target || !target.dataset) return
  if (target.dataset.request) {
    event.preventDefault()
    run(function () { return reviseWith(target.dataset.request, '', document.querySelector('[data-act="revise-first"][data-key="' + target.dataset.request + '"]')) })
  } else if (target.dataset.pw === 'next') {
    event.preventDefault()
    run(function () { return savePassword(false, document.querySelector('[data-act="save-password"]')) })
  }
})

load()
// 定时任务也会自己跑起来，界面得跟着动：空闲时 20 秒刷一次，
// 但只在没有正在编辑的内容时才重绘（否则会把输入框里的字冲掉）
setInterval(function () {
  if (state.busy || document.hidden) return
  run(function () { return load({ quiet: true }) })
}, 20000)
</script>
</body>
</html>
`
