/**
 * 管理台页面。
 *
 * 单独一个文件：界面源码本来就长，混在 handler 里既难读也容易和转义打架。
 * 页面自己带样式与脚本，不引任何外部依赖（与笔记站同一套设计令牌）。
 *
 * 四个区，按"一类操作一个区"划分，不是按数据种类：
 *   概览 —— 现在要我做什么（待办 + 余额 + 账本阶段 + 最近运行）
 *   课程 —— 课次表；每行能重跑/重置/重新发布，展开即该课课件上传
 *   笔记 —— 逐模块状态与"只重写这个模块" + 通知队列（含失败重发）
 *   设置 —— 维护动作 + 运行参数（可改的只有调参，密钥仍只在服务器环境变量里）
 *
 * 两条经验写在这里，免得下次又踩：
 *   1. **按钮必须当场有反应。** 维护动作动辄跑几分钟，只把结果写进页面底部的
 *      <pre> 等于没反应——用户在「课程」区点了「重跑」，看不到任何东西变化，
 *      会以为按钮坏了。所以每个按钮点击后：立刻置灰改字、右上角弹一条提示、
 *      顶部状态灯切成"正在运行"，跑完再弹结果（成功/失败都用一句话说清楚）。
 *   2. **按钮属性与事件委托必须对得上。** 之前把属性写成 data-run，委托只认
 *      data-act，点了完全没反应且不报错。页面上所有按钮只用 data-act，
 *      并有测试逐条比对"页面里的 data-act"与"脚本里的处理分支"两个集合。
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>课程笔记 · 管理台</title>
<style>
:root{--bg:#fff;--bg-soft:#f6f7f8;--bg-sunken:#f1f3f4;--ink:#16191d;--ink-soft:#454b52;--muted:#787f87;
--line:#e7e9ec;--line-strong:#d5d9dd;--accent:#2f6f61;--accent-ink:#245a4f;--accent-soft:#eef4f2;
--warn:#a8641b;--warn-soft:#fdf5e9;--danger:#a33a3a;--danger-soft:#fbeeee;--ok:#2f7d52;
--radius:12px;--radius-lg:16px;--shadow-sm:0 1px 2px rgba(16,24,32,.05);--shadow-md:0 10px 30px -18px rgba(16,24,32,.28);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-ink)}
.topbar{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.topbar .inner{max-width:1100px;margin:0 auto;padding:0 22px;height:56px;display:flex;align-items:center;gap:12px}
.brand{font-weight:650}.brand span{font-weight:400;color:var(--muted);margin-left:8px;font-size:14px}
.spacer{flex:1}
.tabs{max-width:1100px;margin:0 auto;padding:0 22px;display:flex;gap:4px;border-bottom:1px solid var(--line)}
.tabs button{background:none;border:0;padding:12px 14px;font:inherit;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button:hover{color:var(--ink)}
.tabs button[aria-selected=true]{color:var(--accent-ink);border-bottom-color:var(--accent);font-weight:600}
main{max-width:1100px;margin:0 auto;padding:24px 22px 96px}
.grid{display:grid;gap:16px}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
.grid.three{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-lg);padding:18px 20px;box-shadow:var(--shadow-sm)}
.card h2{margin:0 0 10px;font-size:15px}
.card .sub{color:var(--muted);font-size:13.5px;margin:-6px 0 12px}
.stat{font-size:26px;font-weight:650;letter-spacing:-.02em}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--line);color:var(--ink-soft);font-size:13px;margin:0 6px 6px 0}
.pill.warn{background:var(--warn-soft);border-color:#f0dfc2;color:var(--warn)}
.pill.danger{background:var(--danger-soft);border-color:#f0d3d3;color:var(--danger)}
.pill.ok{background:var(--accent-soft);border-color:#d6e6e1;color:var(--accent-ink)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.danger{background:var(--danger)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:9px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase}
tbody tr:hover{background:#fcfcfd}
button.act{font:inherit;font-size:13px;padding:5px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--bg);color:var(--ink-soft);cursor:pointer}
button.act:hover{border-color:var(--accent);color:var(--accent-ink)}
button.act[disabled]{opacity:.55;cursor:progress}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{background:var(--accent-ink);color:#fff;border-color:var(--accent-ink)}
button.danger{border-color:#e6c9c9;color:var(--danger)}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line-strong);border-radius:10px;background:var(--bg);color:var(--ink);width:100%}
input:focus,select:focus,textarea:focus{outline:3px solid var(--accent-soft);outline-offset:1px;border-color:var(--accent)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.row>*{width:auto}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
.field{margin-bottom:14px}
pre{background:var(--bg-sunken);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;overflow:auto;max-height:360px;font-size:12.5px}
.empty{color:var(--muted);background:var(--bg-soft);border:1px dashed var(--line-strong);border-radius:var(--radius);padding:18px;text-align:center}
.muted{color:var(--muted)}.small{font-size:13px}
.token{width:180px}
/* 右下角提示条：按钮点下去之后必须马上有东西动，否则用户会以为坏了 */
.toast{position:fixed;right:20px;bottom:20px;z-index:60;max-width:min(420px,calc(100vw - 40px));
padding:11px 14px;border-radius:12px;border:1px solid var(--line-strong);background:rgba(255,255,255,.97);
box-shadow:var(--shadow-md);font-size:13.5px;color:var(--ink-soft);opacity:0;transform:translateY(10px);
transition:opacity .18s ease,transform .18s ease;pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.ok{border-color:#cfe4d8;background:var(--accent-soft);color:var(--accent-ink)}
.toast.error{border-color:#e6c9c9;background:var(--danger-soft);color:var(--danger)}
</style>
</head>
<body>
<header class="topbar"><div class="inner">
  <div class="brand">课程笔记<span>管理台</span></div>
  <div class="spacer"></div>
  <span id="runState" class="pill"><span class="dot"></span>空闲</span>
  <input class="token" id="token" type="password" placeholder="管理密码或令牌">
  <button class="act" data-act="save">保存令牌</button>
  <button class="act" data-act="refresh">刷新</button>
  <a class="act" href="/" target="_blank" rel="noopener" style="padding:5px 10px;border:1px solid var(--line-strong);border-radius:8px">看站点</a>
</div></header>
<nav class="tabs" role="tablist">
  <button role="tab" data-tab="overview" aria-selected="true">概览</button>
  <button role="tab" data-tab="courses" aria-selected="false">课程</button>
  <button role="tab" data-tab="notes" aria-selected="false">笔记</button>
  <button role="tab" data-tab="settings" aria-selected="false">设置</button>
</nav>
<main>
  <section id="tab-overview"></section>
  <section id="tab-courses" hidden></section>
  <section id="tab-notes" hidden></section>
  <section id="tab-settings" hidden></section>
  <div class="card" style="margin-top:18px"><h2>运行输出</h2><pre id="out">（尚未运行）</pre></div>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
var $ = function (id) { return document.getElementById(id) }
var KEY = 'course.admin.token'
// requests：每个课次输入框里正在写的要求。重绘很频繁（每次操作完、每 20 秒轮询），
// 不记住的话用户写到一半的字会被冲掉——这比"按钮没反应"更让人恼火。
var state = { status: null, balance: null, config: null, tab: 'overview', busy: false, requests: {} }

// 动作 → 人话。按钮文案与提示共用一张表，避免两处各写一份、改一处漏一处。
var LABELS = {
  discover: '扫描教学网', cycle: '跑一轮完整链路', 'cycle-all': '跑一轮完整链路',
  notify: '投递通知', doctor: '体检', backup: '备份账本', prune: '清理预演',
  'prune-apply': '清理并删除原件', retry: '重跑这节课', republish: '重新发布',
  revise: '按新要求重写模块', 'notify-retry': '重发失败通知'
}

$('token').value = localStorage.getItem(KEY) || ''
// 回车即登录：粘贴完凭据顺手敲一下回车是本能动作
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
function panel (title, body, sub) {
  return '<div class="card">' + (title ? '<h2>' + esc(title) + '</h2>' : '') +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + body + '</div>'
}
function taskByKey (key) {
  var tasks = (state.status && state.status.ledger && state.status.ledger.tasks) || []
  for (var i = 0; i < tasks.length; i += 1) if (tasks[i].replayKey === key) return tasks[i]
  return null
}

// ── 反馈通道：右下角提示条 + 按钮置灰 + 顶部状态灯 ──
var toastTimer = null
function toast (message, kind) {
  var el = $('toast')
  el.textContent = String(message)
  el.className = 'toast show ' + (kind || 'info')
  clearTimeout(toastTimer)
  // 成功/进行中的提示自己消失；失败留着，逼人看见
  if (kind !== 'error') toastTimer = setTimeout(function () { el.className = 'toast' }, 7000)
}
function out (text) { $('out').textContent = String(text) }
function labelOf (action) { return LABELS[action] || action }
function setRunState (text, cls) {
  $('runState').innerHTML = '<span class="dot ' + (cls || '') + '"></span>' + esc(text)
}
/** 按钮进入"处理中"：置灰、改字，返回一个复原函数。 */
function busyButton (btn, text) {
  if (!btn || btn.tagName !== 'BUTTON') return function () {}
  var old = btn.textContent
  btn.disabled = true
  btn.setAttribute('aria-busy', 'true')
  btn.textContent = text || '处理中…'
  return function () { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = old }
}
/** 事件里的异常一律要露面：异步 handler 抛错默认只会进 console，看起来就是"点了没反应"。 */
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

/** 页面里有正在编辑的内容吗：自动刷新时不能把这些冲掉。 */
function isDirty () {
  var active = document.activeElement
  if (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return true
  var boxes = document.querySelectorAll('[data-request],[data-pw="next"]')
  for (var i = 0; i < boxes.length; i += 1) if (boxes[i].value) return true
  return false
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
        : $('token').value.trim() ? '密码或主令牌不对，请重新输入。' : '还没有填写登录凭据：把管理台密码或服务器上的主令牌粘进右上角输入框，点「保存令牌」（或直接回车）。'
    $('tab-overview').innerHTML = panel('需要登录', '<div class="muted">' + reason + '</div>')
    setRunState('未登录', 'danger')
    return false
  }
  state.status = data
  if (!state.config) {
    try { state.config = await (await fetch('/api/admin/config', { headers: headers(false) })).json() } catch (e) {}
  }
  // 自动刷新时若用户正在输入，只更新状态灯，别把输入框里的字冲掉
  if (options.quiet && isDirty()) { renderRunState(); return true }
  render()
  // 余额是外部网络调用，只在首次进来或手动点「刷新余额」时查，不跟着轮询打
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
  document.querySelectorAll('.tabs button').forEach(function (btn) {
    var on = btn.dataset.tab === state.tab
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
    $('tab-' + btn.dataset.tab).hidden = !on
  })
  renderRunState()
  renderOverview(); renderCourses(); renderNotes(); renderSettings()
}

function todoCard (title, items, hint, tab) {
  var body = items.length
    ? '<div>' + items.map(function (x) {
      return '<span class="pill warn">' + esc(x.courseName || '') + ' · ' + esc(x.title || x.replayKey || '') + '</span>'
    }).join('') + '</div>' + (tab ? '<div class="small"><a href="#" data-go="' + tab + '">去处理</a></div>' : '')
    : '<div class="pill ok"><span class="dot ok"></span>没有待处理</div>'
  return panel(title, body, hint)
}

function renderOverview () {
  if (!state.status) return
  var s = state.status
  var t = s.todos || {}
  var b = state.balance
  var balances = (b && b.balances) || []
  var balanceHtml
  if (!b) balanceHtml = '<div class="muted small">加载中…</div>'
  else if (b.ok === false) balanceHtml = '<div class="muted small">' + esc(b.error || b.stderr || '查询失败') + '</div>'
  else if (!balances.length) balanceHtml = '<div class="muted small">没有余额信息</div>'
  else balanceHtml = balances.map(function (x) {
    var amount = x.total != null ? x.total : x.available
    var low = amount != null && amount < (b.threshold || 5)
    var name = x.provider === 'deepseek' ? 'DeepSeek（笔记写作）' : x.provider === 'aliyun' ? '阿里云百炼（语音转写）' : x.provider
    return '<div class="field"><label>' + esc(name) + '</label>' +
      '<div class="stat">' + (amount == null ? '—' : '¥' + Number(amount).toFixed(2)) + '</div>' +
      (x.configured === false ? '<div class="muted small">' + esc(x.reason || '未配置') + '</div>' : '') +
      (low ? '<div class="pill danger">低于阈值，建议充值</div>' : '') +
      (x.rechargeUrl ? '<div class="small"><a href="' + esc(x.rechargeUrl) + '" target="_blank" rel="noopener">去充值 / 查看余额</a></div>' : '') +
      '</div>'
  }).join('')
  var stages = (s.ledger && s.ledger.stages) || []
  var runs = (s.runs || []).slice(0, 5).map(function (r) {
    var tasks = (r.summary && r.summary.tasks) || []
    var ok = tasks.filter(function (x) { return x.ok }).length
    return '<tr><td>' + esc(String(r.at).slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(r.name) + '</td><td>' +
      (r.summary ? '<span class="pill">' + ok + ' 成功 / ' + (tasks.length - ok) + ' 失败</span>' : '—') + '</td></tr>'
  }).join('')
  $('tab-overview').innerHTML =
    '<div class="grid three">' +
      todoCard('等我补课件', t.missingMaterials || [], '这些课次已经转录、马上要写笔记，但没有课件', 'courses') +
      todoCard('卡住的课次', t.stuck || [], '连续失败到上限已停止重试；处理完在「课程」里点重跑', 'courses') +
      panel('通知', (t.failedDeliveries ? '<div class="pill danger">' + t.failedDeliveries + ' 条发送失败</div>' : '<div class="pill ok"><span class="dot ok"></span>没有失败</div>') + '<div class="small"><a href="#" data-go="notes">去「笔记」看队列</a></div>', '推送失败不会自己消失，需要你决定是否重发') +
    '</div>' +
    '<div class="grid two" style="margin-top:16px">' +
      panel('账本阶段', stages.map(function (x) { return '<span class="pill">' + esc(x.stage) + ' ' + x.n + '</span>' }).join('') || '<span class="muted">账本为空</span>', '共 ' + ((s.ledger && s.ledger.tasks) || []).length + ' 个课次') +
      panel('余额与充值', balanceHtml +
        '<div class="row"><button class="act" data-act="refresh-balance">刷新余额</button></div>',
        '写笔记排在低价时段；欠费时相关阶段会停下并通知你') +
    '</div>' +
    '<div class="card" style="margin-top:16px"><h2>最近运行</h2>' +
      (runs ? '<table><thead><tr><th>时间</th><th>运行</th><th>结果</th></tr></thead><tbody>' + runs + '</tbody></table>' : '<div class="muted">还没有运行记录</div>') + '</div>'
}

function materialCell (task) {
  var list = (task.materials || []).map(function (m) {
    return '<span class="pill">' + esc(m.name) + (m.scope === 'course' ? ' · 全课程' : '') + ' · ' + m.slideCount + ' 页</span>'
  }).join('')
  return (list || '<span class="muted small">无</span>') +
    '<div class="row" style="margin-top:8px"><input type="file" accept=".pptx,.ppt,.pdf" data-file="' + esc(task.replayKey) + '" style="width:auto"><button class="act" data-act="upload" data-key="' + esc(task.replayKey) + '">上传并解析</button></div>'
}

function actionCell (task) {
  var html = '<button class="act" data-act="retry" data-key="' + esc(task.replayKey) + '">重跑</button> '
  if (task.artifacts && task.artifacts.transcriptPath) {
    html += '<button class="act" data-act="republish" data-key="' + esc(task.replayKey) + '">重新发布</button> '
  }
  html += '<button class="act" data-act="cycle" data-key="' + esc(task.replayKey) + '">跑一轮</button>'
  return html
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
    var rows = groups[course].map(function (t) {
      var cls = t.stage === 'needs_attention' ? 'danger' : t.stage === 'published' ? 'ok' : ''
      return '<tr><td>' + esc(t.title) + '<div class="muted small">' + esc(t.replayKey) + '</div></td>' +
        '<td><span class="pill ' + cls + '">' + esc(t.stage) + '</span></td>' +
        '<td>' + t.attempts + '</td>' +
        '<td>' + materialCell(t) + '</td>' +
        '<td class="small muted">' + esc(String(t.lastError || '').slice(0, 140)) + '</td>' +
        '<td>' + actionCell(t) + '</td></tr>'
    }).join('')
    return panel(course + ' · ' + groups[course].length + ' 讲',
      '<table><thead><tr><th>课次</th><th>阶段</th><th>尝试</th><th>课件</th><th>最近错误</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>')
  }).join('<div style="height:16px"></div>')
  var parked = state.status.unassigned || []
  $('tab-courses').innerHTML = (html || '<div class="empty">账本里还没有课次。先去「设置」跑一次扫描。</div>') +
    (parked.length ? '<div style="height:16px"></div>' + panel('归属不明的课件',
      '<div>' + parked.map(function (n) { return '<span class="pill warn">' + esc(n) + '</span>' }).join('') + '</div>' +
      '<div class="muted small">这些文件认不出属于哪一节课。把它们改名成 课程__课次.pptx 放进服务器收件箱，再在「设置」里跑一次归档。</div>') : '')
}

function renderNotes () {
  var tasks = (state.status.ledger && state.status.ledger.tasks) || []
  var withNotes = tasks.filter(function (t) { return t.lesson && (t.lesson.modules || []).length })
  var cards = withNotes.map(function (t) {
    var rows = t.lesson.modules.map(function (m) {
      var id = m.outlineNodeId || m.id
      return '<tr><td>' + esc(m.title || m.id) + '<div class="muted small">' + esc(m.id) + '</div></td>' +
        '<td>' + m.chars + ' 字</td><td>' + esc(m.status) + '</td><td>' + m.revisions + '</td>' +
        '<td><button class="act" data-act="revise" data-key="' + esc(t.replayKey) + '" data-module="' + esc(id) + '">只重写这个模块</button></td></tr>'
    }).join('')
    return panel(t.courseName + ' · ' + t.title,
      '<div class="sub">成品 ' + t.lesson.finalChars + ' 字 · 状态 ' + esc(t.lesson.status || '') + ' · 保存于 ' + esc(String(t.lesson.savedAt || '').slice(0, 16).replace('T', ' ')) + '</div>' +
      '<table><thead><tr><th>模块</th><th>字数</th><th>状态</th><th>重写次数</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="row" style="margin-top:12px"><input data-request="' + esc(t.replayKey) + '" value="' + esc(state.requests[t.replayKey] || '') + '" placeholder="修改要求（例如：这一段太长，压缩到 1200 字并拆成列表）"><button class="act primary" data-act="revise-first" data-key="' + esc(t.replayKey) + '">按这个要求重写</button></div>' +
      '<div class="muted small">重写只改这一个模块，其余模块的草稿原样保留；改完想上线，再点该课次的「重新发布」。</div>')
  }).join('<div style="height:16px"></div>')
  var deliveries = (state.status.ledger && state.status.ledger.deliveries) || []
  var rows = deliveries.map(function (x) {
    return '<tr><td>' + esc(x.purpose) + '</td><td>' + esc(x.status) + '</td><td>' + x.attempts + '</td>' +
      '<td class="small muted">' + esc(String(x.last_error || '').slice(0, 90)) + '</td>' +
      '<td class="small">' + esc(String(x.sent_at || '').slice(0, 16).replace('T', ' ')) + '</td></tr>'
  }).join('')
  var failed = (state.status.todos && state.status.todos.failedDeliveries) || 0
  $('tab-notes').innerHTML = (cards || '<div class="empty">还没有带模块状态的笔记。跑完一次笔记阶段后这里会出现逐模块列表。</div>') +
    '<div style="height:16px"></div>' +
    panel('通知队列',
      '<table><thead><tr><th>用途</th><th>状态</th><th>次数</th><th>最近错误</th><th>发送时间</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="muted">队列为空</td></tr>') + '</tbody></table>' +
      (failed ? '<div class="row" style="margin-top:12px"><button class="act primary" data-act="notify-retry">把 ' + failed + ' 条失败通知放回队列</button></div>' : ''))
}

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
      (spec.hint ? '<div class="muted small">' + esc(spec.hint) + '</div>' : '') + '</div>'
  }).join('')
  $('tab-settings').innerHTML = '<div class="grid two">' +
    panel('维护动作',
      '<div class="row">' +
      '<button class="act" data-act="discover">扫描教学网</button>' +
      '<button class="act" data-act="cycle-all">跑一轮完整链路</button>' +
      '<button class="act" data-act="notify">投递通知</button>' +
      '<button class="act" data-act="doctor">体检</button>' +
      '<button class="act" data-act="backup">备份账本</button>' +
      '<button class="act" data-act="prune">清理预演</button>' +
      '<button class="act danger" data-act="prune-apply">清理并删除</button>' +
      '</div>' +
      '<div class="muted small">「跑一轮完整链路」最多处理 5 个课次，与定时任务一致。清理只删通过校验的原件：转录稿与课件文字永久保留，视频与 PPT 原件在确认无误后才删。</div>',
      '手动运行走的是与定时任务完全相同的 CLI 入口') +
    panel('运行参数', fields + '<div class="row"><button class="act primary" data-act="save-config">保存设置</button></div>' +
      '<div class="muted small">' + esc(c.path || '') + '</div>',
      '这里只放可以随手改的参数；密钥仍然只从服务器环境变量读取，不接受界面写入') +
    '</div>' +
    '<div style="height:16px"></div>' +
    passwordPanel()
}

function passwordPanel () {
  var auth = (state.status && state.status.auth) || {}
  var status = auth.passwordSet
    ? '<div class="pill ok"><span class="dot ok"></span>已设置登录密码</div>'
    : '<div class="pill warn">还没设置密码：现在只能用服务器上的主令牌登录</div>'
  var master = auth.masterTokenSet
    ? '<div class="muted small">主令牌仍然有效——它是忘记密码时的找回路径（见 docs/10）</div>'
    : '<div class="pill danger">服务器上没有配置主令牌，一旦忘记密码就只能去服务器重设</div>'
  return panel('登录密码',
    '<div class="sub">用自己设的密码登录管理台，比记 64 位随机串实际得多。密码只存哈希，明文不落盘。</div>' +
    status + master +
    '<div class="field" style="margin-top:12px"><label>新密码（至少 8 位）</label>' +
    '<input data-pw="next" type="password" autocomplete="new-password" placeholder="换一个记得住的"></div>' +
    '<div class="row"><button class="act primary" data-act="save-password">保存新密码</button>' +
    '<button class="act" data-act="clear-password">清除密码（只留主令牌）</button></div>' +
    '<div class="muted small">忘记密码时在服务器上跑：<code>course admin-passwd --set-stdin</code>（详见 docs/10-管理台登录与找回.md）</div>')
}

function go (tab) { state.tab = tab; render() }

/**
 * 触发一次服务端动作。
 *
 * 关键在"点下去立刻有反应"：置灰按钮 → 顶部状态灯 → 右下角提示，三处同时变，
 * 再去等结果。跑完把 JSON 写进运行输出，并用一句话说清成功还是失败。
 */
async function doAction (action, extra, btn) {
  if (state.busy || (state.status && state.status.running)) {
    toast('服务端已经有任务在跑，等它结束再点', 'error')
    return
  }
  var label = labelOf(action)
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

async function uploadDeck (key, btn) {
  var input = document.querySelector('[data-file="' + key + '"]')
  var file = input && input.files && input.files[0]
  if (!file) { toast('先选一个 .pptx / .ppt / .pdf 文件', 'error'); if (input) input.focus(); return }
  var task = taskByKey(key)
  if (!task || !task.courseName) { toast('找不到这条课次的课程名，先刷新页面', 'error'); return }
  var restore = busyButton(btn, '上传中…')
  var params = new URLSearchParams({ course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name })
  out('上传中…（' + file.name + '）')
  toast('上传并解析：' + file.name, 'info')
  try {
    var res = await fetch('/api/admin/materials?' + params.toString(), { method: 'PUT', headers: headers(false), body: file })
    var data = await res.json()
    out(JSON.stringify(data, null, 2))
    if (data.ok) toast('已归档：' + data.name + '（' + data.slideCount + ' 页）', 'ok')
    else toast('上传失败：' + (data.message || data.error), 'error')
  } catch (error) {
    out('上传失败：' + error)
    toast('上传失败：' + error, 'error')
  } finally { restore() }
  load()
}

function reviseWith (key, module, btn) {
  var task = taskByKey(key)
  if (!task) { toast('找不到这条课次，先点「刷新」', 'error'); return }
  var box = document.querySelector('[data-request="' + key + '"]')
  var request = box && box.value.trim()
  if (!request) { toast('先在输入框里写清要改什么，再点重写', 'error'); if (box) box.focus(); return }
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
      // 改完立刻用新密码继续（否则下一次刷新会因为旧凭据失效而被挡在门外）
      $('token').value = body.password
      localStorage.setItem(KEY, body.password)
    }
  } catch (error) {
    out('请求失败：' + error)
    toast('请求失败：' + error, 'error')
  } finally { restore() }
  if (done && clear) {
    // 密码刚被清掉，浏览器里还留着的那串此刻已是废凭据。与其让它静默 401、
    // 让人以为管理台坏了，不如直接清空并把人引到「用主令牌登录」这条明路上。
    $('token').value = ''
    try { localStorage.removeItem(KEY) } catch (e) {}
    $('tab-overview').innerHTML = panel('需要登录',
      '<div class="muted">密码已清除。现在只能用服务器上的主令牌登录：在服务器上执行 ' +
      '<code>grep COURSE_ADMIN_TOKEN ~/.course-worker/env</code>，把结果粘进右上角输入框。</div>')
    setRunState('未登录', 'warn')
    return
  }
  load()
}

// 事件委托：界面里的按钮很多，逐个绑定容易漏，也让内联 handler 的引号到处打架
document.addEventListener('click', function (event) {
  var goLink = event.target.closest('[data-go]')
  if (goLink) { event.preventDefault(); go(goLink.dataset.go); return }
  var tab = event.target.closest('.tabs button')
  if (tab) { go(tab.dataset.tab); return }
  var btn = event.target.closest('[data-act]')
  if (!btn) return
  var act = btn.dataset.act
  var key = btn.dataset.key || ''
  run(function () {
    if (act === 'save') {
      var value = $('token').value.trim()
      localStorage.setItem(KEY, value)
      if (!value) { toast('先填密码或主令牌', 'error'); return }
      return load().then(function (ok) { if (ok) toast('已登录', 'ok') })
    }
    if (act === 'refresh') return load().then(function (ok) { if (ok) toast('已刷新', 'ok') })
    if (act === 'refresh-balance') { refreshBalance(); toast('正在查余额…', 'info'); return }
    if (act === 'upload') return uploadDeck(key, btn)
    if (act === 'retry') return doAction('retry', { replayKey: key }, btn)
    if (act === 'republish') {
      var task = taskByKey(key)
      if (!task || !task.artifacts || !task.artifacts.transcriptPath) { toast('这条课次还没有转录稿，无法重新发布', 'error'); return }
      return doAction('republish', { transcriptPath: task.artifacts.transcriptPath, course: task.courseName, lesson: task.title, replayKey: key }, btn)
    }
    // 课次行里的「跑一轮」只推这一节；「设置」里的整轮跑与定时任务一致，最多 5 节
    if (act === 'cycle') return doAction('cycle', { replayKey: key, maxTasks: 1 }, btn)
    if (act === 'cycle-all') return doAction('cycle', { maxTasks: 5 }, btn)
    if (act === 'revise') return reviseWith(key, btn.dataset.module, btn)
    if (act === 'revise-first') return reviseWith(key, '', btn)
    if (act === 'notify-retry') return doAction('notify-retry', {}, btn)
    if (act === 'discover' || act === 'notify' || act === 'doctor' || act === 'backup') return doAction(act, {}, btn)
    if (act === 'prune') return doAction('prune', {}, btn)
    if (act === 'prune-apply') {
      // 真删原件不可逆：先问一句再动手
      if (!window.confirm('确定要删除原件吗？视频、音频、PPT 原件会从磁盘移除；转录稿、课件文字与笔记保留。')) return
      return doAction('prune', { apply: true }, btn)
    }
    if (act === 'save-config') return saveConfig(btn)
    if (act === 'save-password') return savePassword(false, btn)
    if (act === 'clear-password') return savePassword(true, btn)
    toast('这个按钮还没有接上处理逻辑：' + act, 'error')
  })
})

// 记住输入框里正在写的内容，重绘之后再放回去
document.addEventListener('input', function (event) {
  var box = event.target && event.target.closest ? event.target.closest('[data-request]') : null
  if (box) state.requests[box.dataset.request] = box.value
})

// 输入框里直接回车＝点旁边那颗按钮（改模块的要求、改密码都是这个习惯）
document.addEventListener('keydown', function (event) {
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
