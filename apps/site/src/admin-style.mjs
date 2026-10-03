/** 管理台统一样式。新增/调整视觉规则只在这里维护；动态宽度等极少数值仍由页面内联。 */
export const ADMIN_CSS = String.raw`:root{
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
`
