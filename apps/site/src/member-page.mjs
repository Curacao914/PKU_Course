import { ADMIN_CSS } from './admin-style.mjs'

export const MEMBER_ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>课程笔记 · 个人空间</title>
<style>
${ADMIN_CSS}
.member-shell{padding-bottom:48px}.privacy-chip{font-size:12px;color:var(--ok);background:var(--ok-soft);border-radius:999px;padding:4px 9px}
.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r-md);padding:14px}.stat b{display:block;font-size:25px}.stat span{font-size:12px;color:var(--ink-2)}
.workspace-grid{display:grid;grid-template-columns:260px minmax(0,1fr);gap:14px}.rail,.detail{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px}
.member-list{display:grid;gap:6px}.member-item{width:100%;text-align:left;border:0;background:transparent;border-radius:9px;padding:10px;cursor:pointer;font:inherit}.member-item:hover,.member-item[aria-current=true]{background:var(--sunken)}
.note-row,.topic-row{display:flex;gap:10px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line)}.note-row:last-child,.topic-row:last-child{border-bottom:0}
.note-row .main,.topic-row .main{min-width:0;flex:1}.note-row strong,.topic-row strong{display:block}
.private-reader{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:18px}.private-reader pre{white-space:pre-wrap;word-break:break-word;font:14px/1.75 var(--mono);margin:0}
.topic-tree{display:grid;gap:10px;margin-top:12px}.topic-node{border-left:2px solid var(--line-2);padding-left:12px}.topic-node[data-rel=exception]{border-left-color:var(--warn)}.topic-node[data-rel=condition],.topic-node[data-rel=sequence]{border-left-color:var(--accent)}
.topic-source{font-size:12px;margin-top:5px}.topic-source button{border:0;background:transparent;color:var(--accent);padding:0;margin-right:8px;cursor:pointer}
.topic-view-tabs{display:flex;gap:6px;margin:14px 0}.topic-view-tabs button{border:1px solid var(--line);background:var(--card);padding:7px 12px;border-radius:999px;cursor:pointer}.topic-view-tabs button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.topic-outline{display:grid;gap:5px}.topic-outline-row{display:grid;gap:2px;padding:7px 8px;border-bottom:1px solid var(--line)}.topic-outline-row small{color:var(--ink-2)}
.recall-cover{border:1px dashed var(--line-2);background:var(--sunken);border-radius:8px;padding:7px 10px;cursor:pointer;color:var(--ink-2)}.recall-answer{padding-top:4px}
.course-pick{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}.course-pick label{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:6px 9px;font-size:13px}.qr-box img{display:block;max-width:260px;width:100%;border:1px solid var(--line);border-radius:12px;margin-top:10px}
.account-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px;margin-bottom:12px}.account-card h3{margin:0 0 12px}.secret-row{display:grid;grid-template-columns:120px minmax(0,1fr) auto auto;gap:8px;align-items:center;margin:8px 0}
.status-fresh{color:var(--ok)}.status-stale{color:var(--warn)}.status-missing{color:var(--ink-3)}
@media(max-width:760px){.stat-grid{grid-template-columns:repeat(2,1fr)}.workspace-grid{grid-template-columns:1fr}.secret-row{grid-template-columns:1fr}.rail{padding:10px}}
</style>
</head>
<body>
<header class="top"><div class="wrap"><div class="brand">课程笔记<em>个人空间</em></div><div class="spacer"></div><span class="privacy-chip">仅自己可见</span><button class="act quiet" id="refresh">刷新</button></div></header>
<main class="wrap member-shell">
<nav class="seg" role="tablist" id="tabs">
  <button role="tab" data-tab="overview" aria-selected="true">概览</button>
  <button role="tab" data-tab="courses" aria-selected="false">课程</button>
  <button role="tab" data-tab="topics" aria-selected="false">专题</button>
  <button role="tab" data-tab="account" aria-selected="false">账户设置</button>
</nav>
<section id="overview"></section><section id="courses" hidden></section><section id="topics" hidden></section><section id="account" hidden></section>
<div id="reader" hidden></div>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
(function(){
  var state={data:null,tab:'overview',course:'',reader:null,overviewStage:''}
  var $=function(id){return document.getElementById(id)}
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
  function toast(text,bad){var el=$('toast');el.textContent=text;el.className='toast show'+(bad?' error':'');setTimeout(function(){el.className='toast'},2200)}
  async function json(url,opts){
    var res=await fetch(url,Object.assign({credentials:'same-origin',headers:{'content-type':'application/json'}},opts||{}))
    var data=await res.json().catch(function(){return {}})
    if(!res.ok||data.ok===false) throw new Error(data.message||data.error||('HTTP '+res.status))
    return data
  }
  function notes(){return (state.data&&state.data.notes)||[]}
  function topics(){return (state.data&&state.data.topics)||[]}
  function courses(){
    var map={}
    notes().forEach(function(n){var c=n.courseName||'未分类';if(!map[c])map[c]=[];map[c].push(n)})
    Object.keys(map).forEach(function(c){map[c].sort(function(a,b){return String(b.lessonDate||b.updatedAt||'').localeCompare(String(a.lessonDate||a.updatedAt||''))})})
    return map
  }
  function running(){return ((state.data&&state.data.jobs)||[]).filter(function(j){return j.status==='queued'||j.status==='running'})}
  function taskGroup(task){
    var stage=String(task&&task.stage||'')
    if(stage==='published'||stage==='completed')return 'published'
    if(['downloading','transcribing','building_textpack','writing','publishing'].indexOf(stage)>=0)return 'active'
    if(['discovered','queued','downloaded','transcript_ready','notes_ready'].indexOf(stage)>=0)return 'queued'
    return 'attention'
  }
  function taskLabel(group){return group==='published'?'已发布':group==='active'?'进行中':group==='queued'?'排队中':'待处理'}
  function renderOverview(){
    var all=(state.data&&state.data.tasks)||[], counts={published:0,active:0,attention:0,queued:0}
    all.forEach(function(task){counts[taskGroup(task)]+=1})
    var selected=state.overviewStage||'', picked=selected?all.filter(function(task){return taskGroup(task)===selected}):[]
    var expand=selected?'<div class="card" style="margin-top:10px;padding-top:8px"><div class="row"><strong>'+taskLabel(selected)+'</strong><span class="small muted">'+picked.length+' 项</span></div>'+
      (picked.length?picked.map(function(task){return '<div class="note-row"><div class="main"><strong>'+esc((task.courseName||'')+' · '+(task.title||''))+'</strong><span class="small muted">'+esc(task.stage||'')+(task.lastError?' · '+esc(task.lastError):'')+'</span></div></div>'}).join(''):'<p class="small muted">暂无项目</p>')+'</div>':''
    var stale=topics().filter(function(t){return t.status==='stale'||t.status==='missing'}).length
    $('overview').innerHTML='<div class="stat-grid">'+
      '<button class="stat member-item" data-act="overview-stage" data-value="published" aria-current="'+(selected==='published')+'"><b>'+counts.published+'</b><span>已发布</span></button>'+
      '<button class="stat member-item" data-act="overview-stage" data-value="active" aria-current="'+(selected==='active')+'"><b>'+counts.active+'</b><span>进行中</span></button>'+
      '<button class="stat member-item" data-act="overview-stage" data-value="attention" aria-current="'+(selected==='attention')+'"><b>'+counts.attention+'</b><span>待处理</span></button>'+
      '<button class="stat member-item" data-act="overview-stage" data-value="queued" aria-current="'+(selected==='queued')+'"><b>'+counts.queued+'</b><span>排队中</span></button></div>'+expand+
      '<div class="card"><div class="row"><div><h2 style="margin:0">课程空间</h2><p class="sub">'+Object.keys(courses()).length+' 门课程 · '+notes().length+' 节课 · '+topics().length+' 个专题'+(stale?' · '+stale+' 个专题待更新':'')+'</p></div><span class="spacer"></span><button class="act primary" data-act="sync">同步课程</button></div></div>'
  }
  function renderCourses(){
    var cs=courses(), names=Object.keys(cs)
    if(!state.course&&names.length)state.course=names[0]
    var rail=names.map(function(c){return '<button class="member-item" data-course="'+esc(c)+'"'+(c===state.course?' aria-current="true"':'')+'><strong>'+esc(c)+'</strong><div class="tiny muted">'+cs[c].length+' 节</div></button>'}).join('')
    var list=cs[state.course]||[]
    var detail='<div class="row"><div><h2 style="margin:0">'+esc(state.course||'课程')+'</h2><p class="sub">'+list.length+' 节 · 仅当前账号可见</p></div><span class="spacer"></span>'+(state.course?'<button class="act" data-act="generate-topics" data-course="'+esc(state.course)+'">生成专题</button>':'')+'</div>'+
      (list.length?list.map(function(n){return '<div class="note-row"><div class="main"><strong>'+esc(n.lessonTitle||n.title)+'</strong><span class="small muted">'+esc(n.lessonDate||String(n.updatedAt||'').slice(0,10))+'</span></div><button class="act quiet" data-act="open-note" data-id="'+esc(n.id)+'">查看</button></div>'}).join(''):'<p class="muted">还没有课程笔记</p>')
    $('courses').innerHTML='<div class="workspace-grid"><div class="rail"><div class="member-list">'+(rail||'<p class="small muted">还没有课程</p>')+'</div></div><div class="detail">'+detail+'</div></div>'
  }
  function sourceButtons(refs){
    return (refs||[]).map(function(ref){var note=notes().find(function(n){return n.slug===ref.slug});return note?'<button data-act="open-note" data-id="'+esc(note.id)+'">'+esc(ref.title||note.lessonTitle)+'</button>':''}).join('')
  }
  function nodeHtml(node){
    return '<div class="topic-node" data-rel="'+esc(node.relation||'hierarchy')+'"><strong>'+esc(node.title)+'</strong>'+(node.note?'<div class="small muted">'+esc(node.note)+'</div>':'')+
      ((node.sourceRefs||[]).length?'<div class="topic-source">原文 '+sourceButtons(node.sourceRefs)+'</div>':'')+
      ((node.children||[]).length?'<div class="topic-tree">'+node.children.map(nodeHtml).join('')+'</div>':'')+'</div>'
  }
  function renderTopics(){
    var byCourse={}
    topics().forEach(function(t){var c=t.courseName||'未分类';if(!byCourse[c])byCourse[c]=[];byCourse[c].push(t)})
    var html=Object.keys(byCourse).map(function(c){
      return '<div class="card" style="margin-bottom:12px"><div class="row"><h2 style="margin:0">'+esc(c)+'</h2><span class="spacer"></span><button class="act" data-act="generate-topics" data-course="'+esc(c)+'">重新划分</button></div>'+
        byCourse[c].map(function(t){var cls='status-'+(t.status||'missing');return '<div class="topic-row"><div class="main"><strong>'+esc(t.title)+'</strong><span class="small '+cls+'">'+esc(t.status==='fresh'?'已更新':t.status==='stale'?'待更新':'待生成')+'</span>'+(t.summary?'<div class="small muted">'+esc(t.summary)+'</div>':'')+'</div><div><button class="act quiet" data-act="open-topic" data-id="'+esc(t.id)+'">打开</button> <button class="act quiet" data-act="rebuild-topic" data-course="'+esc(c)+'" data-topic-id="'+esc(t.topicId)+'">更新</button> <button class="act danger" data-act="delete-topic" data-id="'+esc(t.id)+'">删除</button></div></div>'}).join('')+'</div>'
    }).join('')
    $('topics').innerHTML=html||'<div class="card"><p class="muted">还没有专题。在“课程”里选择一门课生成。</p></div>'
  }

  function outlineNodes(nodes,depth){
    depth=depth||0
    return (nodes||[]).map(function(node){
      return '<div class="topic-outline-row" style="padding-left:'+(depth*18)+'px"><span>'+esc(node.title)+'</span>'+(node.note?'<small>'+esc(node.note)+'</small>':'')+'</div>'+outlineNodes(node.children||[],depth+1)
    }).join('')
  }
  function recallNodes(nodes){
    return (nodes||[]).map(function(node){
      return '<div class="topic-node recall-node" data-rel="'+esc(node.relation||'hierarchy')+'"><button class="recall-cover" data-act="reveal-node">点击回忆</button><div class="recall-answer" hidden><strong>'+esc(node.title)+'</strong>'+(node.note?'<div class="small muted">'+esc(node.note)+'</div>':'')+((node.sourceRefs||[]).length?'<div class="topic-source">原文 '+sourceButtons(node.sourceRefs)+'</div>':'')+'</div>'+((node.children||[]).length?'<div class="topic-tree">'+recallNodes(node.children)+'</div>':'')+'</div>'
    }).join('')
  }
  function renderTopicReader(topic,view){
    view=view||'framework'
    var artifact=topic&&topic.artifact||{}, nodes=artifact.nodes||[]
    var body=view==='outline'
      ? '<div class="topic-outline">'+outlineNodes(nodes,0)+'</div>'
      : view==='recall'
        ? '<div class="topic-tree">'+recallNodes(nodes)+'</div>'
        : '<div class="topic-tree">'+nodes.map(nodeHtml).join('')+'</div>'
    $('reader').hidden=false
    $('reader').innerHTML='<div class="private-reader topic-reader"><div class="row"><div><h2 style="margin:0">'+esc(topic.title||'专题整合')+'</h2><p class="sub">'+esc(topic.courseName||'')+(topic.summary?' · '+esc(topic.summary):'')+'</p></div><span class="spacer"></span><button class="act" data-act="close-note">关闭</button></div>'+
      '<div class="topic-view-tabs"><button data-act="topic-view" data-view="framework" aria-pressed="'+(view==='framework')+'">框架</button><button data-act="topic-view" data-view="outline" aria-pressed="'+(view==='outline')+'">提纲</button><button data-act="topic-view" data-view="recall" aria-pressed="'+(view==='recall')+'">自测</button></div>'+body+'</div>'
    $('reader').scrollIntoView({behavior:'smooth',block:'start'})
  }
  function openTopic(id){
    var topic=topics().find(function(item){return item.id===id})
    if(!topic)return toast('找不到这个专题',true)
    state.reader={kind:'topic',id:id,view:'framework'}
    renderTopicReader(topic,'framework')
  }
  function credRow(name,label){
    var st=((state.data.account||{}).credentials||{})[name]||{}
    return '<div class="secret-row"><strong>'+esc(label)+'</strong><input type="password" data-secret="'+name+'" placeholder="'+(st.configured?'已配置 · 尾号 '+esc(st.last4||''):'输入新密钥')+'"><button class="act primary" data-act="save-secret" data-provider="'+name+'">保存</button>'+(st.configured?'<button class="act danger" data-act="delete-secret" data-provider="'+name+'">删除</button>':'<span></span>')+'</div>'
  }
  function coursePickHtml(pku){
    var scanned=pku.scannedCourseKeys||[], selected=pku.selectedCourseKeys||[]
    if(!scanned.length)return '<p class="small muted">还没有扫描到课程。先连接教学网，再执行一次同步。</p>'
    return '<div class="course-pick">'+scanned.map(function(key){return '<label><input type="checkbox" data-course-key="'+esc(key)+'"'+(selected.indexOf(key)>=0?' checked':'')+'> '+esc(key)+'</label>'}).join('')+'</div>'+
      '<label class="small"><input type="checkbox" id="autoSync"'+(pku.autoSyncEnabled?' checked':'')+'> 自动同步</label>'+
      '<div class="row" style="margin-top:10px"><button class="act primary" data-act="save-course-selection">保存课程选择</button></div>'
  }
  function renderAccount(){
    var a=(state.data&&state.data.account)||{}, p=a.profile||{}, pku=a.pku||{}
    $('account').innerHTML='<div class="account-card"><h3>账号</h3><div class="field"><label>登录邮箱</label><input value="'+esc(p.email||'')+'" readonly></div><div class="field"><label>通知邮箱</label><div class="row"><input id="notifyEmail" value="'+esc(p.notificationEmail||p.email||'')+'" placeholder="留空则使用登录邮箱"><button class="act primary" data-act="save-notify-email">保存</button></div></div></div>'+
      '<div class="account-card"><h3>模型与识别 API</h3>'+credRow('deepseek','DeepSeek')+credRow('dashscope','阿里云')+credRow('ocr','OCR')+'</div>'+
      '<div class="account-card"><h3>教学网</h3><p class="small">状态：'+esc(pku.status||'disconnected')+(pku.lastSyncAt?' · 最近同步 '+esc(String(pku.lastSyncAt).slice(0,16).replace('T',' ')):'')+'</p>'+
      '<div class="secret-row"><strong>长期登录</strong><input id="pkuUser" autocomplete="username" placeholder="教学网账号"><input id="pkuPass" type="password" autocomplete="current-password" placeholder="密码"><button class="act primary" data-act="save-pku-password">保存</button></div>'+
      '<div class="row"><button class="act" data-act="start-pku-qr">扫码登录</button>'+(pku.hasPassword?'<button class="act danger" data-act="delete-pku-password">删除长期登录</button>':'')+'<button class="act" data-act="discover">扫描课程</button><button class="act" data-act="sync">立即同步</button></div><div id="pkuQrBox" class="qr-box"></div>'+
      coursePickHtml(pku)+'</div>'+
      '<div class="account-card"><h3>MCP</h3><p class="small muted">令牌只读取当前账号课程内容，30 天后自动失效。</p><div class="row"><button class="act primary" data-act="mcp-token">生成访问令牌</button></div><div id="mcpTokenBox"></div></div>'
  }
  function render(){renderOverview();renderCourses();renderTopics();renderAccount()}
  async function load(){
    try{state.data=await json('/api/account/workspace');render()}catch(e){toast('读取个人空间失败：'+e.message,true)}
  }
  async function openNote(id){
    try{
      var out=await json('/api/account/note?id='+encodeURIComponent(id))
      state.reader={kind:'note',id:id}
      $('reader').hidden=false
      $('reader').innerHTML='<div class="private-reader"><div class="row"><div><h2 style="margin:0">'+esc(out.note.title||'课程笔记')+'</h2><p class="sub">仅当前账号可见</p></div><span class="spacer"></span><button class="act" data-act="close-note">关闭</button></div><pre>'+esc(out.note.body_markdown||'')+'</pre></div>'
      $('reader').scrollIntoView({behavior:'smooth',block:'start'})
    }catch(e){toast('读取失败：'+e.message,true)}
  }
  async function pollQr(id){
    if(!id)return
    try{
      var result=await json('/api/account/pku/qr/status?id='+encodeURIComponent(id))
      var box=$('pkuQrBox')
      if(!box)return
      if(result.state==='connected'){box.innerHTML='<p class="small status-fresh">已连接</p>';toast('教学网已连接');setTimeout(load,300);return}
      if(result.state==='expired'||result.state==='missing'){box.innerHTML='<p class="small status-stale">二维码已失效，请重新生成。</p>';return}
      box.innerHTML='<p class="small muted">请使用北京大学 App 扫码</p>'+(result.image?'<img src="'+esc(result.image)+'" alt="北京大学教学网登录二维码">':'')
      setTimeout(function(){pollQr(id)},1600)
    }catch(e){var box=$('pkuQrBox');if(box)box.innerHTML='<p class="small status-stale">'+esc(e.message)+'</p>'}
  }
  async function post(url,body,msg){try{await json(url,{method:'POST',body:JSON.stringify(body||{})});toast(msg||'已提交');setTimeout(load,400)}catch(e){toast(e.message,true)}}
  document.addEventListener('click',async function(e){
    var tab=e.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;document.querySelectorAll('[data-tab]').forEach(function(b){b.setAttribute('aria-selected',b===tab?'true':'false')});['overview','courses','topics','account'].forEach(function(id){$(id).hidden=id!==state.tab});return}
    var c=e.target.closest('.member-item[data-course]');if(c){state.course=c.dataset.course;renderCourses();return}
    var b=e.target.closest('[data-act]');if(!b)return
    var act=b.dataset.act
    if(act==='overview-stage'){state.overviewStage=state.overviewStage===b.dataset.value?'':(b.dataset.value||'');renderOverview();return}
    if(act==='open-note')return openNote(b.dataset.id)
    if(act==='open-topic')return openTopic(b.dataset.id)
    if(act==='topic-view'){
      if(!state.reader||state.reader.kind!=='topic')return
      var topic=topics().find(function(item){return item.id===state.reader.id});if(!topic)return
      state.reader.view=b.dataset.view||'framework';renderTopicReader(topic,state.reader.view);return
    }
    if(act==='reveal-node'){b.hidden=true;var answer=b.parentElement&&b.parentElement.querySelector('.recall-answer');if(answer)answer.hidden=false;return}
    if(act==='close-note'){$('reader').hidden=true;state.reader=null;return}
    if(act==='discover')return post('/api/account/discover',{},'课程扫描已进入队列')
    if(act==='sync')return post('/api/account/sync',{maxTasks:3},'同步任务已进入队列')
    if(act==='save-notify-email'){var email=String($('notifyEmail')&&$('notifyEmail').value||'').trim();try{await json('/api/account/notification-email',{method:'PUT',body:JSON.stringify({email:email})});toast('通知邮箱已保存');load()}catch(e){toast(e.message,true)};return}
    if(act==='save-pku-password'){var u=$('pkuUser'),p=$('pkuPass');var username=String(u&&u.value||'').trim(),password=String(p&&p.value||'');if(!username||!password){toast('请填写教学网账号和密码',true);return}try{await json('/api/account/pku/password',{method:'PUT',body:JSON.stringify({username:username,password:password})});if(p)p.value='';toast('长期登录已保存');load()}catch(e){toast(e.message,true)};return}
    if(act==='delete-pku-password'){if(!confirm('删除长期登录凭据？'))return;try{await json('/api/account/pku/password',{method:'DELETE'});toast('已删除长期登录');load()}catch(e){toast(e.message,true)};return}
    if(act==='save-course-selection'){var keys=Array.from(document.querySelectorAll('[data-course-key]:checked')).map(function(x){return x.dataset.courseKey});try{await json('/api/account/pku/selection',{method:'PUT',body:JSON.stringify({selectedCourseKeys:keys,autoSyncEnabled:Boolean($('autoSync')&&$('autoSync').checked)})});toast('课程选择已保存');load()}catch(e){toast(e.message,true)};return}
    if(act==='start-pku-qr'){try{var q=await json('/api/account/pku/qr/start',{method:'POST',body:'{}'});var qbox=$('pkuQrBox');if(qbox)qbox.innerHTML='<p class="small muted">请使用北京大学 App 扫码</p>'+(q.image?'<img src="'+esc(q.image)+'" alt="北京大学教学网登录二维码">':'');pollQr(q.id)}catch(e){toast(e.message,true)};return}
    if(act==='mcp-token'){try{var token=await json('/api/account/mcp-token',{method:'POST',body:'{}'});var box=$('mcpTokenBox');box.innerHTML='<div class="field" style="margin-top:10px"><label>MCP 地址</label><input value="'+esc(location.origin+'/mcp')+'" readonly></div><div class="field"><label>Bearer Token</label><textarea rows="4" readonly>'+esc(token.token||'')+'</textarea></div><p class="tiny muted">这个令牌等同于当前账号的课程只读权限，请不要转发。</p>';toast('已生成 30 天访问令牌')}catch(e){toast(e.message,true)};return}
    if(act==='generate-topics')return post('/api/account/topics/generate',{courseName:b.dataset.course},'专题生成已进入队列')
    if(act==='rebuild-topic')return post('/api/account/topics/rebuild',{courseName:b.dataset.course,topicId:b.dataset.topicId},'专题更新已进入队列')
    if(act==='delete-topic'){if(!confirm('删除这个专题？'))return;try{await json('/api/account/topic?id='+encodeURIComponent(b.dataset.id),{method:'DELETE'});toast('专题已删除');load()}catch(e){toast(e.message,true)};return}
    if(act==='save-secret'){var input=document.querySelector('[data-secret="'+b.dataset.provider+'"]');var secret=String(input&&input.value||'').trim();if(!secret){toast('请先输入密钥',true);return}try{await json('/api/account/credential',{method:'PUT',body:JSON.stringify({provider:b.dataset.provider,secret:secret})});input.value='';toast('已保存');load()}catch(e){toast(e.message,true)};return}
    if(act==='delete-secret'){if(!confirm('删除这项凭据？'))return;try{await json('/api/account/credential?provider='+encodeURIComponent(b.dataset.provider),{method:'DELETE'});toast('已删除');load()}catch(e){toast(e.message,true)}}
  })
  $('refresh').addEventListener('click',load)
  load()
  setInterval(load,20000)
})()
</script>
</body></html>`
