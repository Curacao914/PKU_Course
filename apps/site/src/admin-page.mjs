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
  --line:#e8e8ed;--line-2:#d2d2d7;--accent:#94070a;--accent-ink:#760507;--accent-soft:#f8ecec;
  --danger:#b42318;--danger-soft:#fdecea;--warn:#8a5a00;--warn-soft:#fff5e0;--ok:#1c7c4a;--ok-soft:#eaf6ef;
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

.act{font:inherit;font-size:14px;padding:7px 12px;border-radius:9px;border:1px solid var(--line-2);
  background:var(--card);color:var(--ink);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;
  text-decoration:none;line-height:1.45;transition:background .14s ease,border-color .14s ease,color .14s ease}
.act:hover{background:var(--sunken);border-color:var(--ink-3);color:var(--ink)}
.act[disabled],.act[aria-disabled=true]{opacity:.45;cursor:default}
.act.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.act.primary:hover{background:var(--accent-ink);border-color:var(--accent-ink);color:#fff}
.act.quiet{border-color:transparent;background:var(--sunken);color:var(--ink-2)}
.act.danger{border-color:#eccac7;color:var(--danger);background:transparent}
.act.danger:hover{background:var(--danger-soft);border-color:#e4aaa4;color:var(--danger)}
.icon-btn{font:inherit;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--ink-3);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .14s ease,color .14s ease}
.icon-btn:hover{background:var(--sunken);color:var(--ink)}
.icon-btn.danger{color:var(--danger)}
.icon-btn.danger:hover{background:var(--danger-soft);color:var(--danger)}
.icon-btn:focus-visible{outline:2px solid var(--accent-soft);outline-offset:1px}
.icon-btn svg.i{width:17px;height:17px}
.metric-button{border:0;background:transparent;color:inherit;text-align:left;padding:4px 6px;border-radius:10px;cursor:pointer;min-width:0}
.metric-button:hover{background:var(--sunken)}
.metric-button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.view-filter{display:flex;align-items:center;gap:6px;padding:4px 12px 8px}
.run-console{max-height:320px;overflow:auto;overscroll-behavior:contain;padding:4px 2px 2px}
.run-section{padding:8px 0;border-bottom:1px solid var(--line)}
.run-section:last-child{border-bottom:0}
.run-line{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:5px 4px;font-size:13px}
.run-line .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-line .meta{font-size:12px;color:var(--ink-3);white-space:nowrap}
.run-line .bar{grid-column:2 / -1;height:5px}
.run-empty{padding:10px 4px;color:var(--ink-3);font-size:13px}
.run-section-title{padding:0 4px 6px;color:var(--ink-3);font-size:12px;font-weight:600;letter-spacing:.04em}
.task-row{width:100%;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center;padding:8px 4px;border:0;border-top:1px solid var(--line);background:transparent;color:inherit;text-align:left}
.task-row:first-of-type{border-top:0}
.task-button{font:inherit;cursor:pointer;border-radius:9px}
.task-button:hover{background:var(--sunken)}
.task-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.task-copy strong{font-size:13.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-copy span{font-size:12px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-meta{font-size:12px;color:var(--ink-3);white-space:nowrap}
.task-progress{grid-column:2/-1;height:4px;border-radius:999px;background:var(--sunken);overflow:hidden}
.task-progress>i{display:block;height:100%;background:var(--accent);border-radius:999px}
.task-progress.indeterminate>i{width:38%;animation:taskslide 1.4s ease-in-out infinite}
@keyframes taskslide{0%{transform:translateX(-110%)}50%{transform:translateX(130%)}100%{transform:translateX(310%)}}
.raw-output{margin-top:8px}
.raw-output>summary{font-size:12.5px;color:var(--ink-3);cursor:pointer;padding:6px 4px}
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
.pill.ok{background:var(--ok-soft);color:var(--ok)}
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
input[type="checkbox"],input[type="radio"]{
  width:16px;height:16px;padding:0;margin:0;flex:none;accent-color:var(--accent);
  border-radius:4px;box-shadow:none;
}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[type="checkbox"]:focus,input[type="radio"]:focus{outline:2px solid var(--accent-soft);outline-offset:2px;box-shadow:none}
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
.colhead .icon-btn{width:26px;height:26px;margin:-3px 0;color:var(--ink-3)}
.colhead .icon-btn:hover{color:var(--ink);background:var(--sunken)}
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
.toast.ok{border-color:#cfe4d8;background:var(--ok-soft);color:var(--ok)}
.toast.error{border-color:#eccac7;background:var(--danger-soft);color:var(--danger)}
/* ── 课件：拖放区、展开指示、识别进度 ── */
.dropzone{border:2px dashed var(--line-2);border-radius:var(--r-md);padding:16px;text-align:center;color:var(--ink-2);
  font-size:13.5px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.dropzone:hover{border-color:var(--ink-3);color:var(--ink)}
.dropzone.over{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.dropzone:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.file .chev{display:flex;color:var(--ink-3);transition:transform .2s ease}
.file.open .chev{transform:rotate(90deg)}
.ocr{margin-top:10px}
.errbox{background:var(--danger-soft);border-radius:var(--r-md);padding:10px 12px;margin-top:8px}
.errbox pre{background:none;padding:0;max-height:220px;color:var(--danger)}
.action-item{display:flex;flex-direction:column;gap:3px;align-items:flex-start}
.action-item .hint{color:var(--ink-3);font-size:12.5px;margin:0;max-width:230px}

/* ── 设置：与课程区一样的分栏（左类别、右内容），不再竖排展开 ── */
.split{display:grid;grid-template-columns:196px minmax(0,1fr);background:var(--card);border:1px solid var(--line);
  border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.split .col{border-right:1px solid var(--line);min-width:0;max-height:74vh;overflow:auto;padding:8px 0}
.split .col:last-child{border-right:0;padding:0}
.split .pane{padding:18px 20px}
.pane-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.pane-actions{margin-top:12px}
.maintenance-grid{display:grid;gap:10px;margin-top:12px}
.maintenance-group{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:14px 0;border-top:1px solid var(--line)}
.maintenance-group:first-child{border-top:0;padding-top:2px}
.maintenance-group h3{margin:0 0 4px;font-size:14px}
.maintenance-group p{margin:0;color:var(--ink-3);font-size:12.5px;line-height:1.55;max-width:520px}
.maintenance-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.storage-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.storage-note{margin:8px 0 0;line-height:1.6}
.storage-disk{margin-top:12px}
.storage-bar{grid-column:1/-1}
button.item{width:100%;border:0;background:none;font:inherit;text-align:left;color:inherit}
button.item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}

.integration-lessons{padding:8px 10px;border:1px solid var(--line);border-radius:10px;max-height:220px;overflow:auto}
.integration-choice{display:flex;align-items:center;gap:9px;min-height:34px;margin:1px 0;color:var(--ink-2);font-size:13.5px;cursor:pointer}
.integration-choice:hover{color:var(--ink);background:var(--sunken);border-radius:8px;padding-left:6px;margin-left:-6px}
.integration-choice span{min-width:0}
.integration-enabled{display:inline-flex;align-items:center;gap:8px;min-height:36px;margin:6px 0 12px;color:var(--ink-2);cursor:pointer}
@media (max-width:900px){
  .board,.board.rail-hidden{grid-template-columns:1fr}
  .board .col{max-height:none;border-right:0;border-bottom:1px solid var(--line)}
  .split{grid-template-columns:1fr}
  .split .col{max-height:none;border-right:0;border-bottom:1px solid var(--line)}
  .maintenance-group{flex-direction:column}
  .maintenance-actions{justify-content:flex-start}
}
@media (max-width:560px){
  .wrap{padding-left:16px;padding-right:16px}
  nav.seg{width:100%;display:grid;grid-template-columns:repeat(4,1fr)}
  nav.seg button{padding:7px 4px;min-width:0}
  .card{padding:18px 16px;border-radius:16px}
  .grid.three{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .grid.three .stat{font-size:26px}
  header.top .wrap{padding-left:16px;padding-right:16px}
  .brand em{display:none}
}

/* 通知记录：宽屏四列一行，窄屏两行卡片。 */
.notify-list{list-style:none;margin:8px 0 0;padding:0}
.notify-item{
  display:grid;grid-template-columns:minmax(0,1fr) 88px 116px minmax(0,1.4fr);gap:10px;
  align-items:center;padding:8px 4px;border-bottom:1px solid var(--line);
}
.notify-item:last-child{border-bottom:0}
.notify-purpose{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.notify-when{white-space:nowrap}
.notify-error{min-width:0;overflow-wrap:anywhere}

/* 窄屏：一行放不下四列，改成"用途+状态"一行、"时间"一行、"说明"一行。
   关键是拉丁串（course-note / failed / 日期）**不许逐字换行**——手机上那会变成
   一列竖着的字母；宁可整块换到下一行。 */
@media (max-width:720px){
  .notify-item{
    grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;
    padding:10px 12px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;
  }
  .notify-purpose{grid-column:1;font-weight:600;white-space:nowrap;overflow:visible;text-overflow:clip}
  .notify-status{grid-column:2;justify-self:end}
  .notify-when{grid-column:1 / -1}
  .notify-error{grid-column:1 / -1}
  /* 移动端点击区稍大一点 */
  .act,.item{min-height:40px}
  .top .menu summary{min-width:40px;min-height:40px;display:inline-flex;align-items:center;justify-content:center}
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
          <a class="act" href="/" target="_blank" rel="noopener">看站点</a>
        </div>
      </div>
    </details>
  </div>
</header>

<main class="wrap">
  <nav class="seg" role="tablist">
    <button role="tab" data-tab="overview" aria-selected="true">概览</button>
    <button role="tab" data-tab="courses" aria-selected="false">课程</button>
    <button role="tab" data-tab="content" aria-selected="false">专题</button>
    <button role="tab" data-tab="settings" aria-selected="false">设置</button>
  </nav>
  <section id="tab-overview"></section>
  <section id="tab-courses" hidden></section>
  <section id="tab-content" hidden></section>
  <section id="tab-settings" hidden></section>
  <div class="card" style="padding:6px 22px">
    <details class="d" id="outCard" style="border-top:0" data-fold="out">
      <summary><span class="ttl">运行状态</span><span class="muted small" id="outHint">后台任务与最近操作</span></summary>
      <div class="body">
        <div class="run-console">
          <div id="ocrJobs"></div>
          <div id="recentJobs"></div>
          <details class="raw-output">
            <summary>详细输出</summary>
            <pre id="out">（暂无）</pre>
          </details>
        </div>
      </div>
    </details>
  </div>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
var $ = function (id) { return document.getElementById(id) }
var OPEN_KEY = 'course.admin.open'
var SEL_KEY = 'course.admin.sel'
var state = {
  status: null, balance: null, config: null, storage: null, content: null,
  tab: 'overview', busy: false, requests: {}, uploads: {}, open: {},
  contentDraft: { id: '', course: '', topic: '', lessons: [], enabled: true },
  sel: { tag: '', year: 'all', stage: '', course: '', lesson: '', sort: 'desc', rail: false, pane: 'maintenance' },
  preview: null,
  // 没保存的运行参数改动：20 秒轮询重绘与分栏切换都不该把它抹掉
  configDraft: {}
}
try {
  var savedOpen = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}')
  if (savedOpen && typeof savedOpen === 'object') state.open = savedOpen
  var savedSel = JSON.parse(localStorage.getItem(SEL_KEY) || '{}')
  if (savedSel && typeof savedSel === 'object') state.sel = Object.assign(state.sel, savedSel)
} catch (e) {}

// 动作名字要写清"会不会花钱、会不会推送到微信、可不可逆"：
// 这些都靠名字与副标题说，而不是等用户点下去再看结果。
var LABELS = {
  discover: '扫描录播', cycle: '继续处理', 'cycle-all': '继续处理待办',
  notify: '发送待发通知', doctor: '运行检查', backup: '创建备份',
  prune: '检查可清理内容', 'prune-apply': '清理可清理原件',
  retry: '重试', 'refresh-note': '更新笔记',
  revise: '重写笔记', 'notify-retry': '重发通知',
  'rebuild-content': '重建公开站点', 'rollback-content': '回滚上一版本',
  'rebuild-integration': '更新专题', 'rebuild-integrations': '更新全部专题',
  'ocr-material': '补识别'
}
var MODULE_TEXT = { approved: '已通过', draft: '草稿', reviewing: '审查中', revising: '重写中', pending: '待写', failed: '失败' }
// 阶段名要说人话：光看"待处理 · 尝试 0 次"没人知道它卡在哪一步
var STAGE_TEXT = {
  discovered: '排队中', queued: '排队中', downloading: '下载中',
  downloaded: '待转写', transcribing: '转写中', transcript_ready: '待写笔记',
  building_textpack: '准备笔记', writing: '写笔记中', notes_ready: '待发布', publishing: '发布中',
  published: '已发布', needs_attention: '需处理', failed: '失败', completed: '已发布'
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

function esc (v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  })
}
function headers (json) {
  var h = {}
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
    sortAsc: '<path d="M7 8h7M7 12h5M7 16h3"/><path d="M18 18V6M15.5 8.5 18 6l2.5 2.5"/>',
    sortDesc: '<path d="M7 8h7M7 12h5M7 16h3"/><path d="M18 6v12M15.5 15.5 18 18l2.5-2.5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    railOpen: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 5v14M14.5 9l3 3-3 3"/>',
    railClose: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 5v14M17.5 9l-3 3 3 3"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    // 图片版课件用得上：一张"图里带字"的图标
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>'
  }
  return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || '') + '</svg>'
}
function setOpen (key, value) {
  state.open[key] = value
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(state.open)) } catch (e) {}
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
  toast(/Failed to fetch|NetworkError|Load failed/i.test(text) ? '连接中断，请稍后重试' : ('操作未完成：' + text), 'error')
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
    if (res.status === 401) {
      window.location.assign('/')
      return false
    }
    var reason = data.error === 'too_many_attempts' ? '操作过于频繁，请稍后重试' : '课程服务暂不可用'
    $('tab-overview').innerHTML = card('<h2>暂时无法加载</h2><p class="muted">' + esc(reason) + '</p>')
    setRunState('暂不可用', 'bad')
    return false
  }
  state.status = data
  try {
    var contentRes = await fetch('/api/admin/content', { headers: headers(false) })
    var contentData = await contentRes.json().catch(function () { return {} })
    state.content = contentRes.ok ? contentData : { ok: false, error: contentData.error || 'content_state_failed' }
  } catch (e) {
    state.content = { ok: false, error: String(e) }
  }
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
  var boxes = document.querySelectorAll('[data-request],[data-newtag],[data-integration-text]')
  for (var i = 0; i < boxes.length; i += 1) if (boxes[i].value) return true
  return Object.keys(state.configDraft).length > 0
}
function refreshBalance () {
  state.balance = null
  renderOverview()
  fetch('/api/admin/balance', { headers: headers(false) })
    .then(function (r) { return r.json() })
    .then(function (b) { state.balance = b; renderOverview() })
    .catch(function (error) { state.balance = { ok: false, error: String(error) }; renderOverview() })
}
function elapsedText (startedAt, finishedAt) {
  if (!startedAt) return ''
  var start = new Date(startedAt).getTime()
  var end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  if (!isFinite(start) || !isFinite(end) || end < start) return ''
  var seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return seconds + ' 秒'
  var minutes = Math.floor(seconds / 60)
  var rest = seconds % 60
  return minutes + ' 分' + (rest ? ' ' + rest + ' 秒' : '')
}
function jobSubject (job) {
  var meta = (job && job.meta) || {}
  return [meta.course, meta.lesson, meta.module].filter(Boolean).join(' · ')
}
function renderRunState () {
  var status = state.status || {}
  var running = status.running
  var queued = status.queue || []
  var ocrJobs = status.ocrJobs || []
  var activeCount = (running ? 1 : 0) + ocrJobs.length
  var bits = []
  if (activeCount) bits.push(activeCount + ' 个进行中')
  if (queued.length) bits.push(queued.length + ' 个排队')
  setRunState(bits.length ? bits.join(' · ') : '空闲', bits.length ? 'warn' : 'ok')
  var hint = $('outHint')
  if (hint) hint.textContent = running ? (jobSubject(running) || (LABELS[running.action] || '后台任务')) : (bits.length ? bits.join(' · ') : '后台任务与最近操作')
  renderRecentJobs()
}
function renderRecentJobs () {
  var jobsBox = $('recentJobs')
  var ocrBox = $('ocrJobs')
  if (!jobsBox || !ocrBox) return

  var ocrJobs = (state.status && state.status.ocrJobs) || []
  ocrBox.innerHTML = ocrJobs.length
    ? '<div class="run-section"><div class="run-section-title">图片识别</div>' +
      ocrJobs.map(function (job) {
        var percent = Math.max(0, Math.min(100, Number(job.percent || 0)))
        var label = [job.courseName, job.lesson].filter(Boolean).join(' · ')
        var current = job.current ? '正在处理 ' + job.current : ('已识别 ' + Number(job.done || 0) + '/' + Number(job.total || 0) + ' 张图')
        return '<div class="task-row">' +
          '<span class="pill warn"><span class="dot"></span>识别中</span>' +
          '<div class="task-copy"><strong>' + esc(label || '图片识别') + '</strong><span>' + esc(current) + '</span></div>' +
          '<span class="task-meta">' + Number(job.done || 0) + '/' + Number(job.total || 0) + '</span>' +
          '<div class="task-progress"><i style="width:' + percent + '%"></i></div></div>'
      }).join('') + '</div>'
    : ''

  var seen = {}
  var jobs = []
  function addJob (job) {
    if (!job || !job.id || seen[job.id]) return
    seen[job.id] = true
    jobs.push(job)
  }
  addJob(state.status && state.status.running)
  ;((state.status && state.status.queue) || []).forEach(addJob)
  ;((state.status && state.status.recentJobs) || []).forEach(addJob)

  jobsBox.innerHTML = jobs.length
    ? '<div class="run-section"><div class="run-section-title">任务</div>' +
      jobs.slice(0, 12).map(function (job) {
        var cls = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'
        var statusText = job.status === 'done' ? '完成' : job.status === 'failed' ? '失败' : job.status === 'running' ? '进行中' : '排队中'
        var subject = jobSubject(job)
        var detail = subject || (job.status === 'queued' && job.queuePosition ? '队列第 ' + job.queuePosition + ' 项' : '')
        var time = job.status === 'queued' ? (job.queuePosition ? '第 ' + job.queuePosition + ' 项' : '') : elapsedText(job.startedAt, job.finishedAt)
        return '<button type="button" class="task-row task-button" data-act="job-output" data-id="' + esc(job.id) + '">' +
          '<span class="pill ' + cls + '"><span class="dot"></span>' + statusText + '</span>' +
          '<div class="task-copy"><strong>' + esc(LABELS[job.action] || job.action) + '</strong>' +
          (detail ? '<span>' + esc(detail) + '</span>' : '') + '</div>' +
          '<span class="task-meta">' + esc(time) + '</span>' +
          (job.status === 'running' ? '<div class="task-progress indeterminate"><i></i></div>' : '') +
          '</button>'
      }).join('') + '</div>'
    : (ocrJobs.length ? '' : '<div class="run-empty">当前没有后台任务</div>')
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
  renderOverview(); renderCourses(); renderContent(); renderSettings()
}
function card (inner, style) { return '<div class="card"' + (style ? ' style="' + style + '"' : '') + '>' + inner + '</div>' }

/* ── 概览 ── */
function stageGroup (task) {
  var stage = String(task && task.stage || '')
  if (stage === 'published' || stage === 'completed') return task.quality && task.quality.complete ? 'published' : 'attention'
  if (['downloading','transcribing','building_textpack','writing','publishing'].includes(stage)) return 'active'
  if (['discovered','queued','downloaded','transcript_ready','notes_ready'].includes(stage)) return 'queued'
  return 'attention'
}
function taskStatus (task) {
  var stage = String(task && task.stage || '')
  if ((stage === 'published' || stage === 'completed') && (!task.quality || !task.quality.complete)) {
    var missing = task.quality && task.quality.missing ? task.quality.missing : ['完整性状态']
    return { text: '待补齐', cls: 'warn', note: '缺：' + missing.join('、') }
  }
  return { text: STAGE_TEXT[stage] || stage, cls: STAGE_CLASS[stage] || '', note: '' }
}
function stageLabel (value) {
  return value === 'published' ? '已发布' : value === 'active' ? '进行中' : value === 'queued' ? '排队中' : value === 'attention' ? '待处理' : ''
}
function matchesStageFilter (task) {
  return !state.sel.stage || stageGroup(task) === state.sel.stage
}
function renderOverview () {
  if (!state.status) return
  var s = state.status
  var t = s.todos || {}
  var all = tasks()
  var counts = { published: 0, active: 0, queued: 0 }
  all.forEach(function (task) {
    var group = stageGroup(task)
    if (counts[group] != null) counts[group] += 1
  })
  var todos = []
  ;(t.stuck || []).forEach(function (item) {
    todos.push({ title: item.courseName + ' · ' + item.title, note: '需要处理', label: '查看', tab: 'courses', course: item.courseName, lesson: item.replayKey })
  })
  ;(t.missingMaterials || []).forEach(function (item) {
    todos.push({ title: item.courseName + ' · ' + item.title, note: '缺少课件', label: '上传', tab: 'courses', course: item.courseName, lesson: item.replayKey })
  })
  all.filter(function (task) {
    var stage = String(task.stage || '')
    return (stage === 'published' || stage === 'completed') && (!task.quality || !task.quality.complete)
  }).forEach(function (task) {
    var missing = task.quality && task.quality.missing ? task.quality.missing.join('、') : '完整性状态'
    todos.push({ title: task.courseName + ' · ' + task.title, note: '待补齐：' + missing, label: '查看', tab: 'courses', course: task.courseName, lesson: task.replayKey })
  })
  if (s.channel && s.channel.ok === false) todos.push({ title: '通知通道不可用', note: '', label: '查看', tab: 'overview' })
  if (t.failedDeliveries) todos.push({ title: t.failedDeliveries + ' 条通知发送失败', note: '', label: '查看', tab: 'settings' })

  var hero = todos.length
    ? '<h1>' + todos.length + ' 件待处理</h1>' + todos.map(function (item) {
      return '<div class="todo"><div class="t"><b>' + esc(item.title) + '</b>' +
        (item.note ? '<span>' + esc(item.note) + '</span>' : '') + '</div>' +
        '<button class="act" data-go="' + item.tab + '"' +
        (item.course ? ' data-course="' + esc(item.course) + '"' : '') +
        (item.lesson ? ' data-lesson="' + esc(item.lesson) + '"' : '') + '>' + esc(item.label) + '</button></div>'
    }).join('')
    : '<h1>无待办</h1><div class="empty-ok"><span class="pill ok"><span class="dot"></span>一切正常</span></div>'

  var spend = s.spend || { asrCny: 0, notesCny: 0, totalCny: 0 }
  var pricing = s.pricing || {}
  $('tab-overview').innerHTML =
    card(hero) +
    card('<div class="grid three">' +
      '<button class="metric-button stat" data-act="view-stage" data-value="published">' + counts.published + '<small>已发布</small></button>' +
      '<button class="metric-button stat" data-act="view-stage" data-value="active">' + counts.active + '<small>进行中</small></button>' +
      '<button class="metric-button stat" data-act="view-stage" data-value="queued">' + counts.queued + '<small>排队中</small></button>' +
      '</div>') +
    '<div class="grid two">' +
      card('<h2>花费</h2><div class="stat">' + money(spend.totalCny) + '<small>转写 ' + money(spend.asrCny) + ' + 笔记 ' + money(spend.notesCny) + '</small></div>' +
        '<div class="row" style="margin-top:14px;align-items:flex-start">' + balancesHtml() + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="act quiet" data-act="refresh-balance">刷新余额</button></div>' +
        '<div class="tiny muted" style="margin-top:10px">转写 ¥' + (pricing.asrPerHourCny || 0.288) + '/小时 · 笔记 ¥' + (pricing.noteInputPerMillionCny || 1) + ' / ¥' + (pricing.noteOutputPerMillionCny || 4) + ' 每百万 token</div>') +
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
    // 「最近互动 23 小时前」要用户自己算是算不过来的，所以判断结论由服务端一起给出：
    // 已过期就直接写「已过期（超过 12 小时）」并用 warn 色，再补一句可执行的提示。
    var summary = c.summary || ('最近互动 ' + (c.ageText || ''))
    rows.push('<div><span class="pill ' + (c.fresh ? 'ok' : 'warn') + '"><span class="dot"></span>微信机器人 ' + (c.fresh ? '可用' : '已过期') + '</span>' +
      '<span class="tiny muted" style="margin-left:8px">' + esc(summary) + '</span></div>')
    if (c.expired) {
      rows.push('<div class="tiny" style="margin-top:6px">' + esc(c.hint || '需要重新扫码/重新登录 OpenClaw') + '</div>')
    }
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
      published: list.filter(function (item) { return stageGroup(item) === 'published' }).length,
      stuck: list.some(function (item) { return item.stage === 'needs_attention' || item.stage === 'failed' })
    }
  }).sort(function (a, b) { return String(a.course).localeCompare(String(b.course), 'zh') })
}
function visibleCourses () {
  return courseList().filter(function (item) {
    if (state.sel.year !== 'all' && item.year !== state.sel.year) return false
    if (state.sel.tag && !(item.tags || []).includes(state.sel.tag)) return false
    if (state.sel.stage && !(item.lessons || []).some(matchesStageFilter)) return false
    return true
  })
}
function lessonsOf (course) {
  var list = tasks().filter(function (task) {
    return (task.courseName || '未分类') === course && matchesStageFilter(task)
  })
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
    '<div class="colhead"><span>筛选</span><span class="spacer"></span>' +
    '<button class="icon-btn" data-act="rail-toggle" title="收起筛选" aria-label="收起筛选">' + icon('railClose') + '</button></div>' +
    '<div class="rail">' + railItems.join('') + '</div></div>'

  // 中一：课程
  var courseItems = shown.map(function (item) {
    var dot = item.stuck ? 'bad' : item.published === item.lessons.length ? 'ok' : 'warn'
    return '<div class="item" data-act="pick-course" data-value="' + esc(item.course) + '"' +
      (state.sel.course === item.course ? ' aria-selected="true"' : '') + '>' +
      '<span class="dot ' + dot + '"></span><span class="name">' + esc(item.course) + '</span>' +
      '<span class="meta">' + (state.sel.stage ? item.lessons.filter(matchesStageFilter).length : (item.published + '/' + item.lessons.length)) + '</span></div>'
  }).join('')
  var courses = '<div class="col" id="courses">' +
    '<div class="colhead">' +
    (!state.sel.rail ? '<button class="icon-btn" data-act="rail-toggle" title="展开筛选" aria-label="展开筛选">' + icon('railOpen') + '</button>' : '') +
    '<span>课程 · ' + shown.length + '</span></div>' +
    (state.sel.stage ? '<div class="view-filter"><span class="pill">' + esc(stageLabel(state.sel.stage)) + '</span>' +
      '<button class="icon-btn" data-act="clear-stage" title="清除状态筛选" aria-label="清除状态筛选">' + icon('close') + '</button></div>' : '') +
    (courseItems || '<div class="item muted">没有匹配的课程</div>') + '</div>'

  // 中二：课次
  var lessonItems = ''
  if (state.sel.course) {
    lessonItems = '<div class="item" data-act="pick-lesson" data-value="__multi__"' +
      (state.sel.lesson === '__multi__' ? ' aria-selected="true"' : '') + '><span class="name">课程管理</span></div>'
    lessonItems += lessonsOf(state.sel.course).map(function (task) {
      var view = taskStatus(task)
      return '<div class="item" data-act="pick-lesson" data-value="' + esc(task.replayKey) + '"' +
        (state.sel.lesson === task.replayKey ? ' aria-selected="true"' : '') + '>' +
        '<span class="dot ' + view.cls + '"></span><span class="name">' + esc(task.title) + '</span>' +
        (view.text === '待补齐' ? '<span class="meta">待补齐</span>' : '') + '</div>'
    }).join('')
  }
  var lessons = '<div class="col" id="lessons">' +
    '<div class="colhead"><span>课次</span><span class="spacer"></span>' +
    (state.sel.course ? '<button class="icon-btn" data-act="sort-toggle" title="' + (state.sel.sort === 'asc' ? '当前：最早在前；点按改为最新在前' : '当前：最新在前；点按改为最早在前') + '" aria-label="' + (state.sel.sort === 'asc' ? '最早课次在前' : '最新课次在前') + '">' + icon(state.sel.sort === 'asc' ? 'sortAsc' : 'sortDesc') + '</button>' : '') +
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
    '<p class="sub">' + esc(task.courseName) + ' · 转写 ' + money(cost.asrCny) + ' · 笔记 ' + money(cost.notesCny) + '</p>'

  var view = taskStatus(task)
  var quality = task.quality || null
  var progress = '<div class="block"><h3>状态</h3><div class="row">' +
    '<span class="pill ' + view.cls + '"><span class="dot"></span>' + esc(view.text) + '</span>' +
    (quality && quality.complete ? '<span class="tiny muted">正文、简报、主题关键词、一页纸与来源映射均已更新</span>' : '') +
    '</div>' +
    (view.note ? '<div class="tiny muted" style="margin-top:7px">' + esc(view.note) + '</div>' : '') +
    (task.lastError ? '<div class="errbox"><pre>' + esc(String(task.lastError)) + '</pre></div>' : '') +
    '</div>'

  var done = task.stage === 'published' || task.stage === 'completed'
  var failed = task.stage === 'needs_attention' || task.stage === 'failed'
  var hasTranscript = Boolean(task.artifacts && task.artifacts.transcriptPath)
  var hasNote = Boolean(task.artifacts && task.artifacts.slug)
  var actionButtons = ''
  if (failed) {
    actionButtons += '<button class="act primary" data-act="retry" data-key="' + esc(task.replayKey) + '">重试</button>'
  } else if (done && hasTranscript && lesson.modules && lesson.modules.length) {
    actionButtons += '<button class="act primary" data-act="refresh-note" data-key="' + esc(task.replayKey) + '">更新笔记</button>'
  } else if (!done) {
    actionButtons += '<button class="act primary" data-act="cycle" data-key="' + esc(task.replayKey) + '">继续处理</button>'
  }
  if (hasNote) actionButtons += '<a class="act" target="_blank" rel="noopener" href="/' + esc(task.artifacts.slug) + '.html">查看笔记</a>'
  var actions = actionButtons ? '<div class="block"><h3>操作</h3><div class="row">' + actionButtons + '</div></div>' : ''

  var deck = deckHtml(task)

  var tagBlock = '<div class="block"><h3>标签</h3>' +
    (tags.length ? tags.map(function (tag) {
      return '<span class="tag">' + esc(tag) + '<button data-act="remove-tag" data-key="' + esc(task.replayKey) + '" data-tag="' + esc(tag) + '" title="移除标签" aria-label="移除标签 ' + esc(tag) + '">' + icon('close') + '</button></span>'
    }).join('') : '<span class="small muted">暂无标签</span>') +
    '<div class="row" style="margin-top:8px"><input data-newtag="' + esc(task.replayKey) + '" placeholder="新增标签，回车确认" style="max-width:240px">' +
    '<button class="act" data-act="add-tag" data-key="' + esc(task.replayKey) + '">添加</button></div></div>'

  var modules = lesson.modules || []
  var noteBlock = ''
  if (modules.length) {
    var summary = '<div class="row" style="align-items:baseline"><strong style="font-size:20px">' +
      Number(lesson.finalChars || 0).toLocaleString() + '</strong><span class="small muted">字</span>' +
      (lesson.savedAt ? '<span class="tiny muted">更新 ' + esc(formatTime(lesson.savedAt)) + '</span>' : '') + '</div>'
    if (modules.length > 1) {
      summary += '<table style="margin-top:8px"><tbody>' + modules.map(function (module) {
        var id = module.outlineNodeId || module.id
        return '<tr><td>' + esc(module.title || module.id) + '</td><td class="small muted">' + module.chars + ' 字</td>' +
          '<td style="text-align:right"><button class="act quiet" data-act="revise" data-key="' + esc(task.replayKey) + '" data-module="' + esc(id) + '">重写</button></td></tr>'
      }).join('') + '</tbody></table>'
    }
    noteBlock = '<div class="block"><h3>笔记</h3>' + summary +
      '<div class="row" style="margin-top:10px"><input data-request="' + esc(task.replayKey) + '" value="' + esc(state.requests[task.replayKey] || '') + '" placeholder="写下修改要求">' +
      '<button class="act" data-act="revise-first" data-key="' + esc(task.replayKey) + '">重写笔记</button></div></div>'
  }

  return head + progress + actions + deck + tagBlock + noteBlock
}

/** 时间戳给人看：账本里存的是 ISO，界面上要的是"月-日 时:分"。 */
function formatTime (value) {
  var date = new Date(value)
  if (!value || isNaN(date.getTime())) return ''
  var pad = function (n) { return String(n).padStart(2, '0') }
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function deckHtml (task) {
  var uploading = activeUpload && activeUpload.key === task.replayKey
  var files = (task.materials || []).map(function (material) {
    var selected = state.preview && state.preview.course === task.courseName && state.preview.name === material.name
    return '<div class="file' + (selected ? ' open' : '') + '" data-act="open-material" data-value="' + esc(material.name) + '"' +
      ' role="button" tabindex="0" aria-expanded="' + (selected ? 'true' : 'false') + '"' + (selected ? ' aria-selected="true"' : '') + '>' +
      icon('file') + '<span class="name">' + esc(material.name) + (material.scope === 'course' ? ' · 全课程' : '') + '</span>' +
      '<span class="meta">' + material.slideCount + ' 页' +
        (material.imageCount ? ' · 图 ' + material.imageCount : '') +
        (material.ocrPending ? ' · 待识别 ' + material.ocrPending : '') + '</span>' +
      '<span class="chev">' + icon('chevron') + '</span>' +
      '<button class="icon-btn danger" data-act="delete-material" data-key="' + esc(task.replayKey) + '"' +
      ' data-name="' + esc(material.name) + '" data-scope="' + esc(material.scope || 'lesson') + '"' +
      ' title="删除这份课件" aria-label="删除 ' + esc(material.name) + '">' + icon('trash') + '</button>' +
      '</div>'
  }).join('')

  var pending = (task.materials || []).some(function (material) { return material.ocrPending > 0 })
  var tools = ''
  if (task.ocrRunning) {
    var info = task.ocr || {}
    tools = '<span class="status">图片识别 ' + Number(info.done || 0) + '/' + Number(info.total || 0) + '</span>'
  } else if (pending) {
    tools = '<button class="act quiet" data-act="ocr-material" data-key="' + esc(task.replayKey) + '">' + icon('image') + '补识别</button>'
  }

  return '<div class="block"><h3>课件</h3>' +
    '<div class="dropzone" data-act="pick-file" data-key="' + esc(task.replayKey) + '" data-drop="' + esc(task.replayKey) + '"' +
    ' role="button" tabindex="0">' + icon('up') + '<span>拖到这里、点按选择，或粘贴文件</span></div>' +
    (files ? '<div style="margin-top:10px">' + files + '</div>' : '<p class="small muted" style="margin:10px 0 0">无课件</p>') +
    '<input class="hidden-file" type="file" multiple data-file="' + esc(task.replayKey) + '" accept=".pptx,.pdf,.docx,.xlsx,.md,.txt,.json">' +
    '<div class="row" style="margin-top:8px">' +
      (uploading && activeUpload.phase === 'uploading'
        ? '<button class="act danger" data-act="cancel-upload" data-key="' + esc(task.replayKey) + '">取消上传</button>'
        : '') +
      tools +
      '<span class="status" data-status="' + esc(task.replayKey) + '">' + esc(state.uploads[task.replayKey] || '') + '</span>' +
    '</div>' + previewHtml(task) + '</div>'
}

/** 后台识别的进度：分母在排队时就定下来了，这里只负责画出来。 */
function ocrProgressHtml (task) {
  var ocr = task.ocr || { total: 0, done: 0, current: '' }
  var percent = ocr.total ? Math.max(2, Math.min(100, Math.round((ocr.done / ocr.total) * 100))) : 0
  return '<div class="ocr"><div class="bar"><i style="width:' + percent + '%"></i></div>' +
    '<div class="tiny muted" style="margin-top:6px">已识别 ' + Number(ocr.done || 0) + '/' + Number(ocr.total || 0) + ' 张图' +
    (ocr.current ? ' · 正在处理 ' + esc(ocr.current) : '') + '</div></div>'
}

function previewHtml (task) {
  var preview = state.preview
  if (!preview || preview.course !== task.courseName) return ''
  if (preview.loading) return '<div class="pages" style="margin-top:8px">加载中…</div>'
  var shown = preview.pages || []
  var pages = shown.map(function (page) {
    return '<div class="page"><div class="no">第 ' + page.slideNumber + ' 页</div>' + esc(page.text || '（本页无文字）') + '</div>'
  }).join('')
  // 一屏 8 页只是"先看这些"，不是"只能看这些"：到底了才收起「继续加载」
  var last = shown.length ? shown[shown.length - 1].slideNumber : 0
  return '<div class="pages" style="margin-top:8px">' +
    '<div class="row" style="justify-content:space-between"><span class="tiny muted">' + esc(preview.name) +
    ' · 共 ' + Number(preview.slideCount || 0) + ' 页，当前显示到第 ' + last + ' 页</span>' +
    '<button class="icon-btn" data-act="close-material" title="收起预览" aria-label="收起预览">' + icon('close') + '</button></div>' +
    (pages || '<div class="muted small">没有文字</div>') +
    (preview.hasMore
      ? '<div class="row" style="justify-content:center;margin-top:8px"><button class="act quiet" data-act="load-more">继续加载</button></div>'
      : '') +
    '</div>'
}

/**
 * 整合材料：这些类型**都还没接线**，所以只列出来、标"规划中"，不给可点的按钮——
 * 让用户先点一个看起来能用的按钮，再收到"还没做"的报错，是把未完成当成已完成报给使用者。
 *
 * 仓库里已有的原型是另一件事：「course integrate」按章做确定性抽取（结构 + 出处 +
 * 待核继承，不调用模型），控制台还没接上它。所以单独一块写清它的真实范围。
 */
function integrationHtml () {
  var course = state.sel.course
  var list = tasks().filter(function (item) { return item.courseName === course })
  var published = list.filter(function (item) { return stageGroup(item) === 'published' }).length
  return '<h2>' + esc(course) + '</h2><p class="sub">' + list.length + ' 节 · 已发布 ' + published + '</p>' +
    '<div class="block"><h3>课程标签</h3>' + courseTagHtml(course) + '</div>' +
    '<div class="block"><button class="act" data-go="content">管理专题整合</button></div>'
}

function courseTagHtml (course) {
  var tags = ((tagsOf().courses || {})[course] || [])
  return (tags.length ? tags.map(function (tag) {
    return '<span class="tag">' + esc(tag) + '<button data-act="remove-course-tag" data-course="' + esc(course) + '" data-tag="' + esc(tag) + '" title="移除标签" aria-label="移除标签 ' + esc(tag) + '">' + icon('close') + '</button></span>'
  }).join('') : '<span class="small muted">暂无标签</span>') +
    '<div class="row" style="margin-top:8px"><input data-newcoursetag="' + esc(course) + '" placeholder="给这门课加标签，回车确认" style="max-width:260px">' +
    '<button class="act" data-act="add-course-tag" data-course="' + esc(course) + '">添加</button></div>'
}

/* ── 专题整合：跨课次长期维护的主题笔记 ── */
function contentCourseMap () {
  var map = {}
  tasks().forEach(function (task) {
    var course = String(task.courseName || '').trim()
    var lesson = String(task.title || '').trim()
    if (!course || !lesson) return
    if (!map[course]) map[course] = []
    if (!map[course].includes(lesson)) map[course].push(lesson)
  })
  Object.keys(map).forEach(function (course) {
    map[course].sort(function (a, b) { return a.localeCompare(b, 'zh-CN', { numeric: true }) })
  })
  return map
}

function resetIntegrationDraft (course) {
  var courses = contentCourseMap()
  var first = course || Object.keys(courses).sort().at(0) || ''
  state.contentDraft = { id: '', course: first, topic: '', lessons: [], enabled: true }
}

function contentStatusPill (status) {
  var cls = status === 'fresh' ? 'ok' : status === 'stale' ? 'warn' : 'bad'
  var text = status === 'fresh' ? '已更新' : status === 'stale' ? '待更新' : '未生成'
  return '<span class="pill ' + cls + '"><span class="dot"></span>' + text + '</span>'
}

function releaseTime (value) {
  if (!value) return ''
  try { return new Date(value).toLocaleString() } catch (e) { return String(value) }
}

function renderContent () {
  var box = $('tab-content')
  if (!box) return
  var data = state.content || {}
  if (!data.ok) {
    box.innerHTML = card('<h2>专题整合</h2><p class="muted">暂时读不到专题状态：' + esc(data.error || '尚未加载') + '</p>')
    return
  }

  var items = ((data.integrations || {}).items || [])
  var integrationRows = items.map(function (item) {
    var stale = item.staleLessons && item.staleLessons.length
      ? '<div class="tiny" style="color:var(--warn);margin-top:5px">变化课次：' + esc(item.staleLessons.join('、')) + '</div>'
      : ''
    return '<div class="block" style="margin:0">' +
      '<div class="row" style="align-items:center">' +
        contentStatusPill(item.status) +
        '<strong>' + esc(item.topic) + '</strong>' +
        '<span class="small muted">' + esc(item.course) + ' · ' + item.lessons.length + ' 节</span>' +
        '<span class="spacer"></span>' +
        '<button class="act quiet" data-act="edit-integration" data-id="' + esc(item.id) + '">编辑</button>' +
        '<button class="act" data-act="rebuild-integration" data-id="' + esc(item.id) + '">更新</button>' +
        '<button class="act danger" data-act="delete-integration" data-id="' + esc(item.id) + '">删除</button>' +
      '</div>' +
      '<div class="small" style="margin-top:7px">' + esc(item.lessons.join(' / ')) + '</div>' +
      stale +
      '<div class="tiny muted" style="margin-top:5px">' +
        (item.generatedAt ? '更新 ' + esc(releaseTime(item.generatedAt)) : '尚未生成') +
      '</div></div>'
  }).join('')

  var courseMap = contentCourseMap()
  if (!state.contentDraft.course || !courseMap[state.contentDraft.course]) resetIntegrationDraft()
  var draft = state.contentDraft
  var courseOptions = Object.keys(courseMap).sort().map(function (course) {
    return '<option value="' + esc(course) + '"' + (draft.course === course ? ' selected' : '') + '>' + esc(course) + '</option>'
  }).join('')
  var lessonChecks = (courseMap[draft.course] || []).map(function (lesson) {
    var checked = (draft.lessons || []).includes(lesson)
    return '<label class="integration-choice"><input type="checkbox" data-integration-lesson="' + esc(lesson) + '"' +
      (checked ? ' checked' : '') + '><span>' + esc(lesson) + '</span></label>'
  }).join('')

  var form = '<div class="block"><div class="row"><h3 style="margin:0">' + (draft.id ? '编辑专题' : '新建专题') + '</h3>' +
    '<span class="spacer"></span>' + (draft.id ? '<span class="tiny muted">' + esc(draft.id) + '</span>' : '') + '</div>' +
    '<div class="field"><label>课程</label><select data-integration-course>' + courseOptions + '</select></div>' +
    '<div class="field"><label>专题名称</label><input data-integration-text="topic" value="' + esc(draft.topic || '') + '" placeholder="例如：罪刑均衡与以刑制罪"></div>' +
    '<div class="field"><label>包含课次</label><div class="integration-lessons">' +
      (lessonChecks || '<span class="small muted">这门课还没有课次</span>') + '</div></div>' +
    '<label class="integration-enabled"><input type="checkbox" data-integration-enabled' +
      (draft.enabled !== false ? ' checked' : '') + '><span>随所选课次更新</span></label>' +
    '<div class="row"><button class="act primary" data-act="save-integration">保存专题</button>' +
      '<button class="act" data-act="new-integration">清空</button></div>' +
    '</div>'

  var integrationsCard = card(
    '<div class="row"><div><h2 style="margin:0">专题整合</h2>' +
      '<p class="sub" style="margin-top:5px">把同一课程的多节课组织成持续更新的专题笔记。</p></div><span class="spacer"></span>' +
      '<button class="act" data-act="rebuild-integrations"' + (items.length ? '' : ' disabled') + '>更新全部</button></div>' +
    '<div style="display:grid;gap:10px;margin:12px 0">' +
      (integrationRows || '<p class="small muted">还没有专题</p>') +
    '</div>' + form
  )

  box.innerHTML = integrationsCard
}

async function saveIntegration (btn) {
  var draft = state.contentDraft || {}
  if (!draft.course) { toast('先选课程', 'error'); return }
  if (!String(draft.topic || '').trim()) { toast('先填专题名称', 'error'); return }
  if (!(draft.lessons || []).length) { toast('至少勾一节课', 'error'); return }
  var restore = busyButton(btn, '保存中…')
  try {
    var definition = {
      course: draft.course,
      topic: String(draft.topic || '').trim(),
      lessons: draft.lessons.slice(),
      enabled: draft.enabled !== false
    }
    if (draft.id) definition.id = draft.id
    var res = await fetch('/api/admin/integrations', {
      method: 'PUT', headers: headers(true), body: JSON.stringify({ definition: definition })
    })
    var data = await res.json().catch(function () { return {} })
    if (!res.ok || !data.ok) throw new Error(data.message || data.error || '保存失败')
    state.content = data.content
    resetIntegrationDraft(draft.course)
    renderContent()
    toast('专题已保存', 'ok')
  } catch (error) {
    toast('保存失败：' + error, 'error')
  } finally { restore() }
}

async function deleteIntegration (id, btn) {
  if (!window.confirm('删除这个专题及其已生成的整合文件？单课笔记不会受影响。')) return
  var restore = busyButton(btn, '删除中…')
  try {
    var res = await fetch('/api/admin/integrations?id=' + encodeURIComponent(id), { method: 'DELETE', headers: headers(false) })
    var data = await res.json().catch(function () { return {} })
    if (!res.ok || !data.ok) throw new Error(data.message || data.error || '删除失败')
    state.content = data.content
    if (state.contentDraft.id === id) resetIntegrationDraft()
    renderContent()
    toast('专题已删除', 'ok')
  } catch (error) {
    toast('删除失败：' + error, 'error')
  } finally { restore() }
}

function editIntegration (id) {
  var items = (((state.content || {}).integrations || {}).items || [])
  var item = items.find(function (entry) { return entry.id === id })
  if (!item) { toast('找不到这个专题', 'error'); return }
  state.contentDraft = {
    id: item.id,
    course: item.course,
    topic: item.topic,
    lessons: (item.lessons || []).slice(),
    enabled: item.enabled !== false
  }
  renderContent()
  var input = document.querySelector('[data-integration-text="topic"]')
  if (input) input.focus()
}

/* ── 设置：与课程区一样的分栏（左类别、右内容），不再用竖排展开 ── */
var SETTINGS_PANES = [
  { key: 'maintenance', label: '维护' },
  { key: 'deliveries', label: '通知记录' },
  { key: 'storage', label: '存储占用' },
  { key: 'params', label: '运行参数' },
  { key: 'advanced', label: '高级维护' }
]

function settingsPane () {
  var key = state.sel.pane
  return SETTINGS_PANES.some(function (item) { return item.key === key }) ? key : 'maintenance'
}

/** 分类右端只放数据：条目数、占用、密码设了没——不放解释。 */
function paneMeta (key) {
  if (key === 'deliveries') return String(((state.status.ledger || {}).deliveries || []).length)
  if (key === 'storage') return state.storage ? bytes(state.storage.totalBytes) : ''
  return ''
}

function maintenancePane () {
  return '<h2>维护</h2>' +
    '<div class="maintenance-grid">' +
      '<section class="maintenance-group"><div><h3>课程同步</h3><p>从教学网扫描新的录播课次；已发现但未完成的课次按顺序进入处理队列。</p></div>' +
        '<div class="maintenance-actions"><button class="act primary" data-act="discover">扫描录播</button>' +
        '<button class="act" data-act="cycle-all">继续处理待办</button></div></section>' +
      '<section class="maintenance-group"><div><h3>系统健康</h3><p>检查服务、凭据、磁盘空间和任务链状态，不会修改课程内容。</p></div>' +
        '<div class="maintenance-actions"><button class="act" data-act="doctor">运行检查</button></div></section>' +
    '</div>'
}

function deliveriesPane (deliveries, rows, failed) {
  return '<div class="pane-head"><div><h2>通知记录</h2><p class="small muted">最近 ' + Math.min(10, deliveries.length) + ' 条</p></div>' +
    '<button class="act" data-act="notify">发送待发通知</button></div>' +
    (rows ? '<ul class="notify-list">' + rows + '</ul>' : '<p class="muted small">暂无通知</p>') +
    (failed ? '<div class="row pane-actions"><button class="act primary" data-act="notify-retry">重试 ' + failed + ' 条失败通知</button></div>' : '')
}

function advancedPane () {
  var release = (state.content && state.content.release) || { releases: [] }
  var current = (release.releases || []).find(function (item) { return item.current }) || (release.releases || [])[0] || null
  var currentText = current
    ? ((current.notes == null ? '' : current.notes + ' 篇 · ') + releaseTime(current.modifiedAt))
    : '暂无版本信息'
  return '<h2>高级维护</h2>' +
    '<p class="small muted">用于发布异常、迁移或恢复；日常使用通常不需要。</p>' +
    '<div class="maintenance-grid">' +
      '<section class="maintenance-group"><div><h3>备份</h3><p>保存账本与关键运行数据，供故障恢复使用。</p></div>' +
        '<div class="maintenance-actions"><button class="act" data-act="backup">创建备份</button></div></section>' +
      '<section class="maintenance-group"><div><h3>公开站点</h3><p>当前：' + esc(currentText) + '</p></div>' +
        '<div class="maintenance-actions"><button class="act" data-act="rebuild-content">重建公开站点</button>' +
        '<button class="act" data-act="rollback-content"' + (release.canRollback ? '' : ' disabled') + '>回滚上一版本</button></div></section>' +
    '</div>'
}


function renderSettings () {
  var c = state.config || { values: {}, editable: {} }
  var fields = Object.keys(c.editable || {}).map(function (key) {
    var spec = c.editable[key]
    var saved = c.values && c.values[key] != null ? c.values[key] : ''
    // 没保存的改动优先：切分栏、20 秒轮询重绘都不能把用户刚敲进去的数字抹掉
    var value = state.configDraft[key] != null ? state.configDraft[key] : saved
    var input
    if (spec.enum) {
      input = '<select data-cfg="' + key + '">' + spec.enum.map(function (o) {
        return '<option value="' + esc(o) + '"' + (String(value) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>'
      }).join('') + '</select>'
    } else if (spec.type === 'boolean') {
      var on = value === true || String(value) === 'true'
      var off = value === false || String(value) === 'false'
      input = '<select data-cfg="' + key + '"><option value=""' + (on || off ? '' : ' selected') + '>默认</option>' +
        '<option value="true"' + (on ? ' selected' : '') + '>开启</option>' +
        '<option value="false"' + (off ? ' selected' : '') + '>关闭</option></select>'
    } else {
      input = '<input data-cfg="' + key + '" type="' + (spec.type === 'number' ? 'number' : 'text') + '" value="' + esc(value) + '" placeholder="默认">'
    }
    return '<div class="field"><label>' + esc(spec.label || key) + '</label>' + input + '</div>'
  }).join('')

  var deliveries = (state.status.ledger && state.status.ledger.deliveries) || []
  var failed = (state.status.todos && state.status.todos.failedDeliveries) || 0
  // 每条通知一项。用列表而不是表格：表格在窄屏要把四列塞进手机宽度，
  // 结果 course-note、failed、日期这些拉丁串被逐字硬换行（一列竖着的字母）。
  // 列表项在宽屏是四列、窄屏是两行卡片（见 .notify-list 的 ≤720px 规则）。
  var purposeText = {
    'course-note': '课程笔记', 'new-lesson': '新课提醒', 'digest': '课程日报',
    'ppt-reminder': '课件提醒'
  }
  var deliveryText = {
    sent: '已发送', failed: '失败', pending: '排队中', claimed: '发送中'
  }
  var rows = deliveries.slice(0, 10).map(function (x) {
    var cls = x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'bad' : ''
    var when = String(x.sent_at || x.created_at || '').slice(5, 16).replace('T', ' ')
    var error = String(x.last_error || '').slice(0, 60)
    return '<li class="notify-item">' +
      '<span class="notify-purpose small">' + esc(purposeText[x.purpose] || '通知') + '</span>' +
      '<span class="notify-status"><span class="pill ' + cls + '">' + esc(deliveryText[x.status] || '处理中') + '</span></span>' +
      '<span class="notify-when small muted">' + esc(when) + '</span>' +
      '<span class="notify-error tiny muted">' + esc(error) + '</span>' +
      '</li>'
  }).join('')

  var pane = settingsPane()
  var rail = SETTINGS_PANES.map(function (item) {
    return '<button type="button" class="item" data-act="pick-pane" data-value="' + item.key + '"' +
      (pane === item.key ? ' aria-current="true"' : '') + '>' +
      '<span class="name">' + esc(item.label) + '</span>' +
      '<span class="meta">' + esc(paneMeta(item.key)) + '</span></button>'
  }).join('')
  var body = pane === 'maintenance' ? maintenancePane()
    : pane === 'deliveries' ? deliveriesPane(deliveries, rows, failed)
      : pane === 'storage' ? '<h2>存储占用</h2><div id="storageBody">' + storageHtml() + '</div>'
        : pane === 'advanced' ? advancedPane()
          : '<h2>运行参数</h2>' + fields +
            '<div class="row"><button class="act primary" data-act="save-config">保存设置</button></div>'

  $('tab-settings').innerHTML = '<div class="split">' +
    '<div class="col" id="settingsRail"><div class="colhead"><span>设置</span></div>' + rail + '</div>' +
    '<div class="col" id="settingsDetail" data-pane="' + esc(pane) + '"><div class="pane">' + body + '</div></div></div>'
}

function storageHtml () {
  var actions = '<div class="storage-actions">' +
    '<button class="act" data-act="prune">检查可清理内容</button>' +
    '<button class="act danger" data-act="prune-apply">清理可清理原件</button></div>' +
    '<p class="small muted storage-note">先检查、再清理。检查只计算候选，不删除文件；清理会删除可以安全释放的回放媒体原件，保留转录、课件解析结果和已发布笔记。</p>'
  if (!state.storage) {
    return '<div class="row"><button class="act" data-act="storage-load">计算存储占用</button></div>' + actions
  }
  var list = state.storage.categories || []
  var total = state.storage.totalBytes || 1
  var rows = list.map(function (item) {
    var percent = Math.max(2, Math.round((item.bytes / total) * 100))
    return '<div class="storage-row"><div>' + esc(item.label) + '</div><div class="muted small">' + bytes(item.bytes) + '</div>' +
      '<div class="hint">' + esc(item.hint) + '</div>' +
      '<div class="storage-bar"><div class="bar"><i style="width:' + percent + '%"></i></div></div></div>'
  }).join('')
  var disk = state.storage.disk
  return rows +
    (disk ? '<p class="small muted storage-disk">磁盘：已用 ' + bytes(disk.totalBytes - disk.freeBytes) + ' / 共 ' + bytes(disk.totalBytes) + '，可用 ' + bytes(disk.freeBytes) + '</p>' : '') +
    '<div class="row pane-actions"><button class="act quiet" data-act="storage-load">重新计算</button></div>' + actions
}

/* ── 动作 ── */
function go (tab) { state.tab = tab; render(); window.scrollTo({ top: 0, behavior: 'smooth' }) }

async function doAction (action, extra, btn) {
  var label = LABELS[action] || action
  var restore = busyButton(btn, '提交中…')
  state.busy = true
  try {
    var res = await fetch('/api/admin/run', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    })
    var data = await res.json().catch(function () { return {} })
    if (!res.ok || !data.jobId) {
      out(JSON.stringify(data, null, 2))
      toast('操作未提交：' + (data.message || data.error || label), 'error')
      return data
    }
    var queued = data.status === 'queued'
    var message = queued
      ? ('已加入队列' + (data.queuePosition ? ' · 第 ' + data.queuePosition + ' 项' : '') + '：' + label)
      : ('已开始：' + label)
    out(message + '\\n任务 ' + data.jobId)
    toast(message, 'info')
    await load()
    return data
  } catch (error) {
    out('请求失败：' + ((error && error.message) || error))
    toast('连接中断，请稍后重试', 'error')
  } finally {
    state.busy = false
    restore()
  }
}

async function showJobOutput (id) {
  if (!id) return
  try {
    var res = await fetch('/api/admin/job?id=' + encodeURIComponent(id), { headers: headers(false) })
    var data = await res.json().catch(function () { return {} })
    out(JSON.stringify(data, null, 2))
    var details = $('outCard')
    if (details) details.open = true
  } catch (error) {
    toast('读不到任务详情', 'error')
  }
}

function setStatus (key, text, kind) {
  var el = document.querySelector('[data-status="' + key + '"]')
  if (!el) return
  el.className = 'status ' + (kind || '')
  el.textContent = text
}

/** 每次请求都换一个可中止的句柄：取消时打断的是"正在飞"的那一个。 */
function jobSignal (job) {
  job.controller = typeof AbortController === 'function' ? new AbortController() : null
  return job.controller ? job.controller.signal : undefined
}

/** 取消不是错误，是一条独立的分支：用这个标记把它和真正的失败分开。 */
function canceled () {
  var error = new Error('已取消上传')
  error.canceled = true
  return error
}

/**
 * 上传一批文件（文件框、拖放、粘贴都走这里）。
 *
 * 取消的实现方式：把 job 记在 activeUpload 上，每个分片前先看一眼标记——标记一旦
 * 立起来就不再发下一个请求，同时在途的那个 fetch 直接 abort。**不能只改界面文案**，
 * 否则用户看到"已取消"而分片还在后台继续灌。
 */
async function uploadFiles (key, fileList, btn) {
  var task = taskByKey(key)
  if (!task || !task.courseName) { toast('找不到这条课次的课程名', 'error'); return }
  var files = [].slice.call(fileList || [])
  if (!files.length) { toast('先选文件', 'error'); return }
  if (activeUpload) { toast('已经有一个上传在进行，先等它结束或点取消', 'error'); return }
  // phase：分片还在传时可以取消；已经交给服务端解析之后就不该再说"已取消"——
  // 那时服务端收不到取消信号，文件多半已经归档了，说取消了是骗人
  var job = { key: key, canceled: false, name: files[0].name, controller: null, uploadId: '', phase: 'uploading' }
  activeUpload = job
  var restore = busyButton(btn, '上传中…')
  renderCourses()
  try {
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i]
      job.name = file.name
      if (job.canceled) throw canceled()
      var data = await uploadOne(task, file, job)
      if (job.canceled) throw canceled()
      // 图上的字是上传后自动识别的：说清楚"已经在后台跑了"，别让人以为要再点一下
      if (data.ok) {
        toast('已归档：' + data.name + '（' + data.slideCount + ' 页' +
          (data.ocr && data.ocr.queued ? '，' + (data.imageCount || 0) + ' 张图正在后台识别' : '') + '）', 'ok')
      } else {
        toast('上传失败：' + (data.message || data.error), 'error')
        break
      }
    }
    if (job.canceled) toast('已取消上传：' + job.name, 'info')
  } catch (error) {
    if (error && error.canceled) toast('已取消上传：' + job.name, 'info')
    else toast('上传失败：' + error, 'error')
  } finally {
    if (job.canceled && job.uploadId) {
      // 已经落盘的分片由服务端收掉；这是善后，失败也不该冒出来打扰用户
      fetch('/api/admin/materials/chunk?uploadId=' + encodeURIComponent(job.uploadId), { method: 'DELETE', headers: headers(false) }).catch(function () {})
    }
    activeUpload = null
    restore()
    setStatus(key, '')
    renderCourses()
    load()
  }
}

/** 单个文件：大的走分片，小的直接 PUT。 */
async function uploadOne (task, file, job) {
  if (file.size > 2 * CHUNK_SIZE) {
    var uploadId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    job.uploadId = uploadId
    var total = Math.ceil(file.size / CHUNK_SIZE)
    for (var index = 0; index < total; index += 1) {
      if (job.canceled) throw canceled()
      setStatus(task.replayKey, '上传中 ' + Math.round((index / total) * 100) + '%（' + file.name + '）')
      await putChunk(uploadId, index, file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), job)
    }
    if (job.canceled) throw canceled()
    job.phase = 'parsing'
    setStatus(task.replayKey, '解析中…（' + file.name + '）')
    renderCourses()
    var res = await fetch('/api/admin/materials/commit', {
      method: 'POST', headers: headers(true),
      body: JSON.stringify({ uploadId: uploadId, course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name, chunks: total }),
      signal: jobSignal(job)
    })
    return await res.json().catch(function () { return {} })
  }
  setStatus(task.replayKey, '上传中…（' + file.name + '）')
  var params = new URLSearchParams({ course: task.courseName, lesson: task.title, scope: 'lesson', name: file.name })
  var single = await fetch('/api/admin/materials?' + params.toString(), {
    method: 'PUT', headers: headers(false), body: file, signal: jobSignal(job)
  })
  return await single.json().catch(function () { return {} })
}

async function putChunk (uploadId, index, blob, job) {
  var lastError = null
  for (var attempt = 1; attempt <= 3; attempt += 1) {
    if (job && job.canceled) throw canceled()
    try {
      var res = await fetch('/api/admin/materials/chunk?uploadId=' + encodeURIComponent(uploadId) + '&index=' + index, {
        method: 'PUT', headers: headers(false), body: blob, signal: jobSignal(job)
      })
      var data = await res.json().catch(function () { return {} })
      if (res.ok && data.ok) return data
      lastError = new Error(data.message || data.error || ('分片 ' + index + ' 失败（HTTP ' + res.status + '）'))
    } catch (error) {
      if (job && job.canceled) throw canceled()
      lastError = error
    } finally {
      if (job) job.controller = null
    }
    await new Promise(function (done) { setTimeout(done, 600 * attempt) })
  }
  throw lastError
}

/** 课程详情重绘时保留三列与页面位置：展开课件/加载更多不应该把人踢回顶部。 */
function courseScrollSnapshot () {
  var value = { windowY: window.scrollY }
  ;['courses','lessons','detail'].forEach(function (id) {
    var node = document.getElementById(id)
    value[id] = node ? node.scrollTop : 0
  })
  return value
}
function restoreCourseScroll (value) {
  if (!value) return
  requestAnimationFrame(function () {
    window.scrollTo(0, value.windowY || 0)
    ;['courses','lessons','detail'].forEach(function (id) {
      var node = document.getElementById(id)
      if (node) node.scrollTop = value[id] || 0
    })
  })
}
function renderCoursesKeepingScroll () {
  var at = courseScrollSnapshot()
  renderCourses()
  restoreCourseScroll(at)
}

async function fetchMaterialJson (params) {
  var last = null
  for (var attempt = 0; attempt < 2; attempt += 1) {
    try {
      var res = await fetch('/api/admin/material?' + params.toString(), { headers: headers(false) })
      var data = await res.json().catch(function () { return {} })
      if (!res.ok || !data.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status))
      return data
    } catch (error) {
      last = error
      if (attempt === 0) await new Promise(function (done) { setTimeout(done, 450) })
    }
  }
  throw new Error('暂时无法读取课件，请稍后重试')
}

/** 点课件行：展开看文字，再点一次收起。 */
function toggleMaterial (name) {
  var task = taskByKey(state.sel.lesson)
  if (!task) return
  if (state.preview && state.preview.course === task.courseName && state.preview.name === name) {
    state.preview = null
    renderCoursesKeepingScroll()
    return
  }
  return openMaterial(name)
}

async function openMaterial (name) {
  var task = taskByKey(state.sel.lesson)
  if (!task) return
  var at = courseScrollSnapshot()
  state.preview = { course: task.courseName, name: name, loading: true, pages: [], slideCount: 0, offset: 0, hasMore: false }
  renderCourses()
  restoreCourseScroll(at)
  try {
    var params = new URLSearchParams({ course: task.courseName, lesson: task.title, name: name, pages: '8' })
    var data = await fetchMaterialJson(params)
    state.preview = {
      course: task.courseName, name: data.name, slideCount: data.slideCount,
      pages: data.pages || [], offset: (data.pages || []).length, hasMore: Boolean(data.hasMore)
    }
  } catch (error) {
    state.preview = null
    toast(error.message || '预览失败', 'error')
  }
  renderCourses()
  restoreCourseScroll(at)
}

/** 继续加载：一次 8 页往下接，直到整份课件都看过。 */
async function loadMorePages (btn) {
  var preview = state.preview
  var task = taskByKey(state.sel.lesson)
  if (!preview || !preview.hasMore || !task) return
  var at = courseScrollSnapshot()
  var restore = busyButton(btn, '加载中…')
  try {
    var params = new URLSearchParams({
      course: preview.course, lesson: task.title, name: preview.name,
      pages: '8', offset: String(preview.offset || 0)
    })
    var data = await fetchMaterialJson(params)
    preview.pages = (preview.pages || []).concat(data.pages || [])
    preview.offset = preview.pages.length
    preview.hasMore = Boolean(data.hasMore)
    preview.slideCount = data.slideCount || preview.slideCount
  } catch (error) {
    toast(error.message || '加载失败', 'error')
  } finally { restore() }
  renderCourses()
  restoreCourseScroll(at)
}

/** 删除一份已归档的课件：确认之后才动手，删完刷新列表。 */
async function deleteMaterial (key, name, scope, btn) {
  var task = taskByKey(key)
  if (!task) { toast('找不到这条课次', 'error'); return }
  if (!window.confirm('删除「' + name + '」？原件与解析出的文字都会删掉，写笔记前需要重新上传。')) return
  var restore = busyButton(btn, '…')
  try {
    var params = new URLSearchParams({ course: task.courseName, lesson: task.title, scope: scope || 'lesson', name: name })
    var res = await fetch('/api/admin/materials?' + params.toString(), { method: 'DELETE', headers: headers(false) })
    var data = await res.json().catch(function () { return {} })
    if (!data.ok) throw new Error(data.message || data.error || '删除失败')
    if (state.preview && state.preview.name === name) state.preview = null
    toast('已删除：' + name, 'ok')
  } catch (error) {
    toast('删除失败：' + error, 'error')
  } finally { restore() }
  renderCourses()
  load()
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
    // 保存成功后草稿就作废了：留着一个"未保存"的键会让后续重绘一直被 isDirty 挡住
    if (data.ok) { state.configDraft = {}; toast('设置已保存：' + (data.applied || []).join('、'), 'ok') }
    else toast('没保存：' + ((data.errors || []).join('；') || data.error), 'error')
  } catch (error) { toast('保存失败：' + error, 'error') } finally { restore() }
  state.config = null
  load()
}


function handleAct (act, btn) {
  var menu = $('menu')
  if (menu && menu.open) menu.open = false
  var key = btn.dataset.key || ''
  var value = btn.dataset.value || ''
  if (act === 'refresh') return load().then(function (ok) { if (ok) toast('已刷新', 'ok') })
  if (act === 'refresh-balance') { refreshBalance(); toast('正在查余额…', 'info'); return }
  if (act === 'rail-toggle') { state.sel.rail = !state.sel.rail; saveSel(); renderCourses(); return }
  if (act === 'sort-toggle') { state.sel.sort = state.sel.sort === 'asc' ? 'desc' : 'asc'; saveSel(); renderCourses(); return }
  if (act === 'filter-all') { state.sel.tag = ''; state.sel.year = 'all'; saveSel(); renderCourses(); return }
  if (act === 'filter-year') { state.sel.year = state.sel.year === value ? 'all' : value; state.sel.tag = ''; saveSel(); renderCourses(); return }
  if (act === 'view-stage') {
    state.sel.stage = value; state.sel.tag = ''; state.sel.year = 'all'; state.sel.course = ''; state.sel.lesson = ''
    saveSel(); go('courses'); return
  }
  if (act === 'clear-stage') { state.sel.stage = ''; state.sel.course = ''; state.sel.lesson = ''; saveSel(); renderCourses(); return }
  if (act === 'pick-course') {
    state.sel.course = value; state.sel.lesson = ''; state.preview = null; saveSel(); renderCourses(); return
  }
  if (act === 'pick-lesson') { state.sel.lesson = value; state.preview = null; saveSel(); renderCourses(); return }
  if (act === 'pick-file') { var input = document.querySelector('[data-file="' + key + '"]'); if (input) input.click(); return }
  if (act === 'open-material') return toggleMaterial(value)
  if (act === 'close-material') { state.preview = null; renderCoursesKeepingScroll(); return }
  if (act === 'load-more') return loadMorePages(btn)
  if (act === 'delete-material') return deleteMaterial(key, btn.dataset.name, btn.dataset.scope, btn)
  if (act === 'cancel-upload') {
    if (!activeUpload) { toast('现在没有正在上传的文件'); return }
    if (activeUpload.phase !== 'uploading') { toast('这一份已经在解析，等它结束'); return }
    // 先立标记再 abort：标记保证后面的分片不再发出去，abort 打断正在飞的那一个
    activeUpload.canceled = true
    if (activeUpload.controller) activeUpload.controller.abort()
    setStatus(activeUpload.key, '正在取消…（' + activeUpload.name + '）')
    toast('正在取消上传：' + activeUpload.name, 'info')
    return
  }
  if (act === 'pick-pane') {
    state.sel.pane = value
    saveSel()
    renderSettings()
    var rail = document.querySelector('#settingsRail [data-act="pick-pane"][data-value="' + value + '"]')
    if (rail) rail.focus()
    return
  }
  if (act === 'storage-load') return loadStorage(btn)
  if (act === 'job-output') return showJobOutput(btn.dataset.id || '')
  if (act === 'add-tag') { var box = document.querySelector('[data-newtag="' + key + '"]'); return addTag(key, box && box.value, 'lesson').then(function () { if (box) box.value = '' }) }
  if (act === 'remove-tag') return removeTag(key, btn.dataset.tag, 'lesson')
  if (act === 'add-course-tag') { var cbox = document.querySelector('[data-newcoursetag="' + btn.dataset.course + '"]'); return addTag('', cbox && cbox.value, 'course', btn.dataset.course).then(function () { if (cbox) cbox.value = '' }) }
  if (act === 'remove-course-tag') return removeTag('', btn.dataset.tag, 'course', btn.dataset.course)
  if (act === 'retry') { var retryTask = taskByKey(key); return doAction('retry', { replayKey: key, course: retryTask && retryTask.courseName, lesson: retryTask && retryTask.title }, btn) }
  if (act === 'refresh-note') { var refreshTask = taskByKey(key); return doAction('refresh-note', { replayKey: key, course: refreshTask && refreshTask.courseName, lesson: refreshTask && refreshTask.title }, btn) }
  if (act === 'cycle') { var cycleTask = taskByKey(key); return doAction('cycle', { replayKey: key, maxTasks: 1, course: cycleTask && cycleTask.courseName, lesson: cycleTask && cycleTask.title }, btn) }
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
  if (act === 'rebuild-content') return doAction('rebuild-content', {}, btn)
  if (act === 'rollback-content') {
    if (!window.confirm('回滚到上一份完整内容版本？当前版本不会删除，之后仍然可以再切回来。')) return
    return doAction('rollback-content', {}, btn)
  }
  if (act === 'rebuild-integration') return doAction('rebuild-integration', { id: btn.dataset.id || '' }, btn)
  if (act === 'rebuild-integrations') return doAction('rebuild-integrations', {}, btn)
  if (act === 'edit-integration') return editIntegration(btn.dataset.id || '')
  if (act === 'new-integration') { resetIntegrationDraft(); renderContent(); return }
  if (act === 'save-integration') return saveIntegration(btn)
  if (act === 'delete-integration') return deleteIntegration(btn.dataset.id || '', btn)
  if (act === 'discover' || act === 'notify' || act === 'doctor' || act === 'backup') return doAction(act, {}, btn)
  if (act === 'prune') return doAction('prune', {}, btn)
  if (act === 'prune-apply') {
    if (!window.confirm('确定要删除原件吗？视频、音频、PPT 原件会从磁盘移除；转录稿、课件文字与笔记保留。')) return
    return doAction('prune', { apply: true }, btn)
  }
  if (act === 'save-config') return saveConfig(btn)
  toast('这个按钮还没有接上处理逻辑：' + act, 'error')
}

var CHUNK_SIZE = 1024 * 1024
var dragFrom = null
// 正在进行的上传（同一时刻只允许一个）：里面有取消标记与可中止的请求句柄
var activeUpload = null

document.addEventListener('click', function (event) {
  var menu = $('menu')
  if (menu && menu.open && !event.target.closest('#menu')) menu.open = false
  var goLink = event.target.closest('[data-go]')
  if (goLink) {
    event.preventDefault()
    if (goLink.dataset.course) state.sel.course = goLink.dataset.course
    if (goLink.dataset.lesson) state.sel.lesson = goLink.dataset.lesson
    if (goLink.dataset.course || goLink.dataset.lesson) { state.sel.stage = ''; saveSel() }
    go(goLink.dataset.go); return
  }
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

/** 拖放上传：只有落在这个课次的虚线框里才算数，别的地方拖进来一律不管。 */
document.addEventListener('dragover', function (event) {
  var zone = event.target.closest ? event.target.closest('.dropzone') : null
  if (!zone || dragFrom !== null) return
  event.preventDefault()
  zone.classList.add('over')
})
document.addEventListener('dragleave', function (event) {
  var zone = event.target.closest ? event.target.closest('.dropzone') : null
  if (zone) zone.classList.remove('over')
})
document.addEventListener('drop', function (event) {
  var zone = event.target.closest ? event.target.closest('.dropzone') : null
  if (!zone || dragFrom !== null) return
  event.preventDefault()
  zone.classList.remove('over')
  var files = event.dataTransfer && event.dataTransfer.files
  if (!files || !files.length) return
  var key = zone.dataset.drop
  run(function () { return uploadFiles(key, files, null) })
})

/** 粘贴上传：剪贴板里带文件（截图、从访达复制的课件）就直接归档到当前课次。 */
document.addEventListener('paste', function (event) {
  var files = event.clipboardData && event.clipboardData.files
  if (!files || !files.length) return
  event.preventDefault()
  var key = state.sel.lesson
  if (!key || key === '__multi__') { toast('先在课次里选一节课，再粘贴课件', 'error'); return }
  run(function () { return uploadFiles(key, files, null) })
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
  var target = event.target
  if (!target || !target.closest) return
  var box = target.closest('[data-request]')
  if (box) { state.requests[box.dataset.request] = box.value; return }
  // 运行参数的改动先记在本地：切分栏或 20 秒轮询重绘都不该把它抹掉
  var cfg = target.closest('[data-cfg]')
  if (cfg) { state.configDraft[cfg.dataset.cfg] = cfg.value; return }
  var integrationText = target.closest('[data-integration-text]')
  if (integrationText) {
    state.contentDraft[integrationText.dataset.integrationText] = integrationText.value
  }
})
document.addEventListener('change', function (event) {
  var target = event.target
  var cfg = target && target.closest ? target.closest('[data-cfg]') : null
  if (cfg) { state.configDraft[cfg.dataset.cfg] = cfg.value; return }
  if (!target || !target.closest) return
  var course = target.closest('[data-integration-course]')
  if (course) {
    state.contentDraft.course = course.value
    state.contentDraft.lessons = []
    renderContent()
    return
  }
  var lesson = target.closest('[data-integration-lesson]')
  if (lesson) {
    var value = lesson.dataset.integrationLesson
    var lessons = (state.contentDraft.lessons || []).filter(function (item) { return item !== value })
    if (lesson.checked) lessons.push(value)
    state.contentDraft.lessons = lessons
    return
  }
  var enabled = target.closest('[data-integration-enabled]')
  if (enabled) state.contentDraft.enabled = enabled.checked
})
document.addEventListener('toggle', function (event) {
  var node = event.target
  if (!node || !node.dataset || !node.dataset.fold) return
  setOpen(node.dataset.fold, node.open)
}, true)
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') { var menu = $('menu'); if (menu && menu.open) menu.open = false; return }
  var target = event.target
  if (!target || !target.dataset) return
  // 设置分栏：上下箭头在类别之间走，与访达里用键盘挑分类的习惯一致
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.closest && target.closest('#settingsRail')) {
    event.preventDefault()
    var index = SETTINGS_PANES.findIndex(function (item) { return item.key === settingsPane() })
    var step = event.key === 'ArrowDown' ? 1 : -1
    var pane = SETTINGS_PANES[(index + step + SETTINGS_PANES.length) % SETTINGS_PANES.length]
    var next = document.querySelector('#settingsRail [data-act="pick-pane"][data-value="' + pane.key + '"]')
    if (next) next.click()
    return
  }
  if (event.key !== 'Enter' && event.key !== ' ') return
  // 整行可点的元素（课件行、拖放区）不是 <button>，回车/空格要等同点一下
  var row = target.closest ? target.closest('[data-act][role="button"]') : null
  if (row && target.tagName !== 'BUTTON') {
    event.preventDefault()
    run(function () { return handleAct(row.dataset.act, row) })
    return
  }
  if (event.key !== 'Enter') return
  if (target.hasAttribute && target.hasAttribute('data-newtag')) { event.preventDefault(); run(function () { return addTag(target.dataset.newtag, target.value, 'lesson').then(function () { target.value = '' }) }); return }
  if (target.hasAttribute && target.hasAttribute('data-newcoursetag')) { event.preventDefault(); run(function () { return addTag('', target.value, 'course', target.dataset.newcoursetag).then(function () { target.value = '' }) }); return }
  if (target.dataset.request) {
    event.preventDefault()
    run(function () { return reviseWith(target.dataset.request, '', document.querySelector('[data-act="revise-first"][data-key="' + target.dataset.request + '"]')) })
    return
  }
})

load()
setInterval(function () {
  if (state.busy || document.hidden) return
  run(function () { return load({ quiet: true }) })
}, 5000)
</script>
</body>
</html>
`
