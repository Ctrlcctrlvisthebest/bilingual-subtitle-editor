'use strict';
const CLOUD_SESSION_KEY='subtitle-group-connections-v1';
const CLOUD_DEFAULT_SERVER=location.hostname==='ctrlcctrlvisthebest.github.io'||!location.protocol.startsWith('http')?'https://bilingual-subtitle-editor.zoeli2010xl.workers.dev':location.origin;
const cloud={server:CLOUD_DEFAULT_SERVER,session:null,base:null,pid:null,conflicts:[],applying:false,busy:false,timer:null,poll:null,members:[],epoch:0,presenceAt:0,retryAt:0,detached:null};
const cloudDB=typeof indexedDB==='undefined'?Promise.resolve(null):new Promise(resolve=>{
 try{const req=indexedDB.open('subtitle-group-drafts',1);req.onupgradeneeded=()=>req.result.createObjectStore('drafts',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=req.onblocked=()=>resolve(null);}catch{resolve(null);}
});
function cloudKey(){return cloud.session?cloud.session.server+'|'+cloud.session.groupId+'|'+cloud.session.member.id+'|'+cloud.pid:'';}
async function cloudDraft(value){
 const db=await cloudDB;if(!db)return null;
 return new Promise(resolve=>{try{const tx=db.transaction('drafts',value?'readwrite':'readonly'),store=tx.objectStore('drafts');if(value){store.put(value);tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(null);}else{const r=store.get(cloudKey());r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>resolve(null);}}catch{resolve(null);}});
}
function cloudSessions(){try{const s=JSON.parse(localStorage.getItem(CLOUD_SESSION_KEY)||'[]');return Array.isArray(s)?s:[];}catch{return [];}}
function cloudStoreSession(session){
 cloud.session=session;
 try{const list=cloudSessions().filter(s=>!(s.server===session.server&&s.groupId===session.groupId&&s.member.id===session.member.id));list.unshift(session);localStorage.setItem(CLOUD_SESSION_KEY,JSON.stringify(list));}catch{cloudMessage('成员凭证无法暂存，请立刻下载成员备份。');}
 cloudRenderConnections();
}
function cloudServer(value){
 const u=new URL(value.trim()||location.origin);
 if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('字幕组连接信息无效，请重新获取邀请或成员备份');
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error('字幕组连接需要安全地址，请联系网站管理员');
 return u.origin;
}
function cloudMessage(text){$('cloudStatus').textContent=text;$('cloudBar').hidden=!cloud.session;$('cloudBarText').textContent=(cloud.session?(cloud.session.groupName||'字幕组')+' · ':'')+text;}
function cloudActive(){return cloud.session&&cloud.base&&cloud.pid&&project.editor_id===cloud.base.project.editor_id;}
async function cloudRequest(path,method='GET',data,auth=true,session=cloud.session){
 if(!session)throw Error('请先连接字幕组');
 const headers={'Content-Type':'application/json'};if(auth)headers.Authorization='Bearer '+session.token;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
 try{const res=await fetch(session.server+'/api/'+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
  let body;try{body=await res.json();}catch{throw Error('字幕组服务返回了无效响应，请联系网站管理员');}
  if(!res.ok){const e=Error(body.error||'协作请求失败');e.status=res.status;e.data=body;throw e;}return body;
 }catch(e){if(e.name==='AbortError')throw Error('连接超时，本地修改已保留');throw e;}finally{clearTimeout(timeout);}
}
function cloudPath(suffix=''){return 'groups/'+encodeURIComponent(cloud.session.groupId)+(suffix?'/'+suffix:'');}
function cloudRenderConnections(){
 const list=cloudSessions();$('cloudConnections').replaceChildren(...list.map((s,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=(s.groupName||'字幕组')+' · '+s.member.name;return o;}));
 $('cloudReconnect').disabled=!list.length;
}
function cloudNode(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function cloudEditControls(){
 const disabled=!!(cloudActive()&&(cloud.session.member.role==='viewer'||cloud.conflicts.length));
 for(const id of ['start','end','speaker','status','zhEdit','enEdit','note','setStart','setEnd','startMinus','startPlus','endMinus','endPlus','split','merge','delete','add','projectTitle','addSpeaker','renameSpeaker','subtitleMode','subtitleOrder','zhSize','enSize','outlineWidth','subtitleFont','subtitleBold','applyOffset','undo','claimCue']){
  const el=$(id);if(!el)continue;if(disabled)el.disabled=true;else if(id==='outlineWidth')el.disabled=project.appearance.mode==='box';else if(['add','projectTitle','addSpeaker','renameSpeaker','subtitleMode','subtitleOrder','zhSize','enSize','subtitleFont','subtitleBold','applyOffset'].includes(id))el.disabled=false;
 }
 $('cloudSaveNow').disabled=!cloudActive()||cloud.session.member.role==='viewer'||cloud.conflicts.length>0;
 $('cloudHistory').disabled=!cloudActive();$('claimCue').disabled=!cloudActive()||disabled||!project.rows[idx];$('nextMine').disabled=!cloudActive();
 const r=project.rows[idx],member=cloud.members.find(m=>m.id===r?.assignedTo);$('cueAssignment').textContent=r?.assignedTo?'本条由 '+(member?.name||(cloud.session?'已离组成员':'组内成员（连接后查看名字）'))+' 认领':'本条未认领';
}
const originalDraw=draw;draw=function(){originalDraw();cloudEditControls();};
const originalPersist=persist;persist=function(r,quiet=false){originalPersist(r,quiet);if(cloud.applying)return;if(cloudActive())cloudSchedule();else if(cloud.detached&&project.editor_id===cloud.detached.base.project.editor_id)void cloudDraft({...cloud.detached,project:clone(project)});};
function cloudSaveDraft(){
 if(!cloudActive())return Promise.resolve(null);
 return cloudDraft({id:cloudKey(),base:clone(cloud.base),project:clone(project),conflicts:clone(cloud.conflicts)}).then(ok=>{if(!ok)cloudMessage('离线协作备份未成功，请保存工程 JSON；在线同步仍可重试。');return ok;});
}
function cloudSchedule(){
 if(!cloudActive()||cloud.session.member.role==='viewer')return;
 void cloudSaveDraft();clearTimeout(cloud.timer);
 if(!collabDirty(cloud.base,project))return;
 if(cloud.conflicts.length){cloudMessage('有 '+cloud.conflicts.length+' 处冲突，解决后继续同步；你的修改已保留。');return;}
 if(Date.now()>=cloud.retryAt)cloudMessage('修改待同步…');cloud.timer=setTimeout(()=>{void cloudFlush();},Math.max(1200,cloud.retryAt-Date.now()));
}
async function cloudApply(snapshot,local,conflicts=[]){
 const selected=project.rows[idx]?.id,focus=document.activeElement,selection=focus&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null;
 const preserveHistory=collabEqual(project,local);
 cloud.applying=true;
 try{cloud.base=clone(snapshot);cloud.detached=null;project=normalizeProject(local);cloud.conflicts=conflicts;baseline=new Map(snapshot.project.rows.map(r=>[r.id,JSON.stringify(r)]));patches={};if(!preserveHistory)history=[];editGroup=null;
  idx=Math.max(0,project.rows.findIndex(r=>r.id===selected));drawSpeakers();registerProject();draw();trackAll();
  if(selection&&document.activeElement===focus)focus.setSelectionRange(Math.min(selection[0],focus.value.length),Math.min(selection[1],focus.value.length));
  cloudRenderConflicts();
 }finally{cloud.applying=false;}
 await storeBase(snapshot.project);await cloudSaveDraft();
}
async function cloudFlush(){
 if(!cloudActive()||cloud.conflicts.length||cloud.session.member.role==='viewer')return;
 if(cloud.busy){cloudSchedule();return;}
 const patch=collabPatch(cloud.base,project);if(!patch.changes.length&&!patch.meta&&!patch.order){cloudMessage('已与字幕组同步');return;}
 const captured=clone(project),base=clone(cloud.base),epoch=cloud.epoch,path=cloudPath('projects/'+cloud.pid),session=cloud.session;
 cloud.busy=true;cloudMessage('正在保存到字幕组…');
 try{
  const snapshot=await cloudRequest(path,'PATCH',patch,true,session);if(epoch!==cloud.epoch||!cloudActive())return;cloud.retryAt=0;
  const merged=collabMerge(captured,project,snapshot.project);await cloudApply(snapshot,merged.project,merged.conflicts);
  cloudMessage(merged.conflicts.length?'有新冲突，请选择保留的版本':'已保存到字幕组 · '+new Date().toLocaleTimeString());
 }catch(e){
  if(epoch!==cloud.epoch)return;
  if(e.status===409&&e.data.snapshot){const snapshot=e.data.snapshot,merged=collabMerge(base.project,project,snapshot.project);await cloudApply(snapshot,merged.project,merged.conflicts);cloudMessage(merged.conflicts.length?'其他成员也修改了这些字幕，请处理下方冲突':'已合入其他成员的修改，继续保存');}
  else{cloud.retryAt=Date.now()+15000;cloudMessage(e.message+'；修改保留在本地，可保存 JSON 备份。');if(e.status===401||e.status===403)cloud.session.member.role='viewer';}
 }finally{cloud.busy=false;cloudEditControls();}
 if(cloudActive()&&!cloud.conflicts.length&&collabDirty(cloud.base,project))cloudSchedule();
}
async function cloudPoll(){
 if(!cloudActive()||cloud.busy||cloud.conflicts.length||document.hidden)return;
 if(collabDirty(cloud.base,project)){if(Date.now()>=cloud.retryAt)await cloudFlush();return;}
 const epoch=cloud.epoch;cloud.busy=true;
 try{
  const snapshot=await cloudRequest(cloudPath('projects/'+cloud.pid)+'?since='+cloud.base.revision);
  if(epoch!==cloud.epoch)return;
  if(!snapshot.unchanged){const merged=collabMerge(cloud.base.project,project,snapshot.project);await cloudApply(snapshot,merged.project,merged.conflicts);cloudMessage(merged.conflicts.length?'其他成员有并发修改，请处理冲突':'已收到组内最新修改');}
  if(Date.now()-cloud.presenceAt>30000){cloud.presenceAt=Date.now();await cloudRequest(cloudPath('presence'),'POST',{projectId:cloud.pid,rowId:project.rows[idx]?.id||''});await cloudRefresh();}
 }catch(e){cloudMessage(e.message+'；本地编辑仍可保存 JSON。');if(e.status===401||e.status===403){cloud.session.member.role='viewer';cloudEditControls();}}
 finally{cloud.busy=false;if(cloudActive()&&!cloud.conflicts.length&&collabDirty(cloud.base,project))cloudSchedule();}
}
function cloudConflictValue(value,kind){
 if(value===null)return '此条已删除';
 if(kind==='order')return '字幕顺序 / 增删：'+value.length+' 条';
 if(kind==='meta')return JSON.stringify({title:value.title,colors:value.colors,appearance:value.appearance},null,2);
 return playbackTime(value.start)+' → '+playbackTime(value.end)+'\n'+value.speaker+' · '+value.status+'\n'+value.zh+'\n'+value.en+(value.note?'\n备注：'+value.note:'');
}
function cloudRenderConflicts(){
 const panel=$('cloudConflicts');panel.replaceChildren();panel.hidden=!cloud.conflicts.length;
 if(cloud.conflicts.length){$('cloudPanel').open=true;notice('字幕组检测到并发修改：请在“字幕组 · 多人在线校对”中比较版本、处理冲突。');}
 for(const conflict of cloud.conflicts){
  const card=cloudNode('section',undefined,'cloud-conflict');card.append(cloudNode('h3',conflict.kind==='row'?'字幕冲突 · '+conflict.id:conflict.kind==='meta'?'工程名称 / 人物颜色 / 样式冲突':'字幕增删或顺序冲突'));
  const grid=cloudNode('div',undefined,'grid');
  for(const [label,choice] of [['我的修改','local'],['字幕组最新版本','remote']]){
   const col=cloudNode('div');col.append(cloudNode('strong',label),cloudNode('pre',cloudConflictValue(conflict[choice],conflict.kind)));
   const btn=cloudNode('button',choice==='local'?'保留我的修改':'使用组内版本');btn.onclick=async()=>{cloud.applying=true;try{
    const value=conflict[choice];if(conflict.kind==='row'){const map=new Map(project.rows.map(r=>[r.id,r]));if(value)map.set(conflict.id,clone(value));else map.delete(conflict.id);project.rows=collabOrder(project.rows.map(r=>r.id),map).map(id=>map.get(id));}
    else if(conflict.kind==='meta')project={...clone(value),rows:project.rows};
    else{const map=new Map(project.rows.map(r=>[r.id,r]));project.rows=collabOrder(value,map).map(id=>map.get(id));}
    cloud.conflicts=cloud.conflicts.filter(c=>c!==conflict);idx=Math.max(0,Math.min(idx,project.rows.length-1));drawSpeakers();draw();trackAll();cloudRenderConflicts();await cloudSaveDraft();
   }finally{cloud.applying=false;}if(!cloud.conflicts.length)cloudSchedule();};col.append(btn);grid.append(col);
  }card.append(grid);panel.append(card);
 }
}
async function cloudRefresh(){
 const result=await cloudRequest(cloudPath());cloud.session.member=result.member;cloud.session.groupName=result.groupName;cloud.members=result.members;cloudStoreSession(cloud.session);
 $('cloudGroupName').textContent=result.groupName+' · '+result.member.name+'（'+({owner:'组长',editor:'编辑者',viewer:'只读成员'}[result.member.role])+'）';
 const leader=result.member.role==='owner';$('cloudLeaderTools').hidden=!leader;
 const leaderKey=leader?collabLeaderKey(cloud.session.groupId,cloud.session.token):'';
 if($('cloudOwnerKey').value!==leaderKey){$('cloudOwnerKey').value=leaderKey;$('cloudOwnerKey').type='password';$('cloudShowLeaderKey').textContent='显示组长密钥';}
 const picker=$('cloudProjects'),previous=cloud.pid||picker.value;picker.replaceChildren(...result.projects.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.title+' · '+p.count+' 条 · '+p.updatedBy+' 最近修改';return o;}));picker.value=result.projects.some(p=>p.id===previous)?previous:result.projects[0]?.id||'';
 $('cloudOpen').disabled=!result.projects.length;$('cloudPublish').disabled=result.member.role==='viewer';$('cloudOwnerTools').hidden=result.member.role!=='owner';$('cloudConnected').hidden=false;
 const members=$('cloudMembers');members.replaceChildren();
 for(const m of result.members){const line=cloudNode('div',undefined,'row');line.append(cloudNode('span',m.name+' · '+({owner:'组长',editor:'编辑者',viewer:'只读'}[m.role])+(Date.now()-m.last_seen<90000?' · 在线':'')+(m.row_id?' · 当前字幕 '+m.row_id:'')));
  if(result.member.role==='owner'&&m.role!=='owner'){const selector=document.createElement('select');selector.setAttribute('aria-label',m.name+'的权限');for(const [value,label] of [['editor','编辑者'],['viewer','只读'],['removed','移出字幕组']]){const o=cloudNode('option',label);o.value=value;selector.append(o);}selector.value=m.role;const btn=cloudNode('button','更新权限');btn.onclick=()=>cloudAction(async()=>{await cloudRequest(cloudPath('members'),'PATCH',{id:m.id,role:selector.value});await cloudRefresh();cloudMessage('成员权限已更新');});line.append(selector,btn);}members.append(line);
 }cloudEditControls();
}
async function cloudAction(fn){try{await fn();}catch(e){cloudMessage(e.message);}}
async function cloudConnect(session){
 if(cloudServer(session.server)!==CLOUD_DEFAULT_SERVER)throw Error('这份连接信息不属于当前字幕网站，请使用对应的网站入口');
 if(cloudActive()&&collabDirty(cloud.base,project)){await cloudSaveDraft();cloudMessage('当前未同步修改已保存为离线草稿，返回该共享工程时会恢复。');}
 clearTimeout(cloud.timer);cloud.epoch++;cloud.pid=null;cloud.base=null;cloud.conflicts=[];$('cloudConnected').hidden=true;$('cloudLeaderTools').hidden=true;$('cloudOwnerKey').value='';cloudStoreSession(session);cloud.server=session.server;cloudRenderConflicts();draw();await cloudRefresh();cloudMessage('已连接字幕组，选择共享工程或发布当前工程');
}
async function cloudOpen(pid){
 if(!pid)throw Error('请选择共享工程');
 if(cloudActive())await cloudSaveDraft();
 const snapshot=await cloudRequest(cloudPath('projects/'+pid));
 clearTimeout(cloud.timer);cloud.epoch++;cloud.pid=pid;cloud.base=snapshot;cloud.conflicts=[];
 const saved=await cloudDraft();let merged={project:snapshot.project,conflicts:[]};
 if(saved?.base&&saved.project){
  merged=collabMerge(saved.base.project,saved.project,snapshot.project);
  for(const conflict of saved.conflicts||[]){
   const local=conflict.kind==='row'?merged.project.rows.find(r=>r.id===conflict.id)||null:conflict.kind==='meta'?collabMeta(merged.project):merged.project.rows.map(r=>r.id);
   const remote=conflict.kind==='row'?snapshot.project.rows.find(r=>r.id===conflict.id)||null:conflict.kind==='meta'?collabMeta(snapshot.project):snapshot.project.rows.map(r=>r.id);
   if(!collabEqual(local,remote)&&!merged.conflicts.some(c=>c.kind===conflict.kind&&c.id===conflict.id))merged.conflicts.push({...conflict,local,remote});
  }
 }
 cloud.applying=true;try{await activateProject(snapshot.project,{restore:false,store:true});}finally{cloud.applying=false;}
 await cloudApply(snapshot,merged.project,merged.conflicts);await cloudRequest(cloudPath('presence'),'POST',{projectId:pid,rowId:project.rows[idx]?.id||''});cloud.presenceAt=Date.now();await cloudRefresh();
 cloudMessage(merged.conflicts.length?'离线修改与组内版本有冲突，请选择要保留的内容':'共享工程已打开；修改会自动同步');if(!merged.conflicts.length)cloudSchedule();
}
$('cloudCreate').onclick=()=>cloudAction(async()=>{
 const name=$('cloudNewName').value.trim(),memberName=$('cloudNickname').value.trim();if(!name||!memberName)throw Error('请先填写你的昵称和字幕组名称');
 const button=$('cloudCreate');button.disabled=true;
 try{const server=CLOUD_DEFAULT_SERVER,data=await cloudRequest('groups','POST',{name,memberName},false,{server});
  await cloudConnect({server,groupId:data.groupId,token:data.token,member:data.member,groupName:data.groupName});cloudMessage('字幕组已创建，请复制组长密钥保存，再发布工程、邀请成员。');
 }finally{button.disabled=false;}
});
$('cloudLeaderConnect').onclick=()=>cloudAction(async()=>{
 const credentials=collabParseLeaderKey($('cloudLeaderLogin').value),server=CLOUD_DEFAULT_SERVER,session={server,...credentials};
 const data=await cloudRequest('groups/'+encodeURIComponent(credentials.groupId),'GET',undefined,true,session);
 if(data.member.role!=='owner')throw Error('这不是组长密钥；请通过成员邀请加入或恢复成员备份');
 await cloudConnect({...session,member:data.member,groupName:data.groupName});$('cloudLeaderLogin').value='';cloudMessage('已用组长密钥连接，选择共享工程即可继续校对。');
});
$('cloudCopyLeaderKey').onclick=()=>cloudAction(async()=>{
 if(cloud.session?.member.role!=='owner')throw Error('只有组长可以复制组长密钥');
 const input=$('cloudOwnerKey');input.value=collabLeaderKey(cloud.session.groupId,cloud.session.token);
 try{await navigator.clipboard.writeText(input.value);cloudMessage('组长密钥已复制。请私下保存或交给本组组长。');}
 catch{input.type='text';$('cloudShowLeaderKey').textContent='隐藏组长密钥';input.focus();input.select();cloudMessage('无法自动复制，密钥已选中，请手动复制后保存。');}
});
$('cloudShowLeaderKey').onclick=()=>{const input=$('cloudOwnerKey');input.type=input.type==='password'?'text':'password';$('cloudShowLeaderKey').textContent=input.type==='password'?'显示组长密钥':'隐藏组长密钥';};
$('cloudJoin').onclick=()=>cloudAction(async()=>{
 const server=cloudServer(cloud.server),groupId=$('cloudJoinGroup').value.trim(),data=await cloudRequest('groups/'+encodeURIComponent(groupId)+'/join','POST',{name:$('cloudNickname').value.trim(),code:$('cloudJoinCode').value.trim()},false,{server});
 $('cloudJoinCode').value='';await cloudConnect({server,groupId,token:data.token,member:data.member});cloudMessage('已加入字幕组，请下载成员备份，再选择共享工程。');
});
$('cloudReconnect').onclick=()=>cloudAction(()=>cloudConnect(cloudSessions()[Number($('cloudConnections').value)]));
$('cloudRefresh').onclick=()=>cloudAction(()=>cloudRefresh());
$('cloudOpen').onclick=()=>cloudAction(()=>cloudOpen($('cloudProjects').value));
$('cloudPublish').onclick=()=>cloudAction(async()=>{
 if(!project.rows.length)throw Error('先导入字幕工程，再发布到字幕组');
 if(cloudActive()&&collabDirty(cloud.base,project))await cloudSaveDraft();
 const result=await cloudRequest(cloudPath('projects'),'POST',{project:clone(project)});await cloudRefresh();await cloudOpen(result.id);cloudMessage('工程已发布到字幕组，成员现在可以共同校对。');
});
$('cloudSaveNow').onclick=()=>{void cloudFlush();};
$('cloudShowPanel').onclick=()=>{$('cloudPanel').open=true;$('cloudPanel').scrollIntoView({behavior:'smooth',block:'start'});};
$('cloudInvite').onclick=()=>cloudAction(async()=>{
 const data=await cloudRequest(cloudPath('invites'),'POST',{role:$('cloudInviteRole').value,uses:Number($('cloudInviteUses').value),days:7});
 const u=new URL(location.href),params={subtitleGroup:cloud.session.groupId,invite:data.code};if(cloud.session.server!==CLOUD_DEFAULT_SERVER)params.backend=cloud.session.server;u.hash=new URLSearchParams(params).toString();
 $('cloudInviteLink').value=u.href;$('cloudInviteResult').hidden=false;cloudMessage('邀请链接已生成，有效期 7 天；只分享给字幕组成员。');
});
$('cloudResetInvites').onclick=()=>cloudAction(async()=>{await cloudRequest(cloudPath('invites/reset'),'POST',{});$('cloudInviteResult').hidden=true;$('cloudInviteLink').value='';cloudMessage('旧邀请已全部失效，已加入的成员保持原权限。');});
$('cloudBackup').onclick=()=>{if(cloud.session)download('字幕组-'+cloud.session.member.name+'.credential.json',JSON.stringify({format:'subtitle-group-member-v1',...cloud.session},null,2));};
$('cloudRestore').onchange=e=>cloudAction(async()=>{const file=e.target.files[0];if(!file)return;try{const s=JSON.parse(await file.text());if(s.format!=='subtitle-group-member-v1'||!/^[-\w.]{50,120}$/.test(s.groupId)||!/^[a-f0-9]{64}$/.test(s.token)||!s.member?.name)throw Error('不是有效的成员备份');s.server=cloudServer(s.server);await cloudConnect(s);}finally{e.target.value='';}});
$('cloudDisconnect').onclick=()=>cloudAction(async()=>{if(cloudActive()){await cloudSaveDraft();cloud.detached={id:cloudKey(),base:clone(cloud.base),conflicts:clone(cloud.conflicts)};}clearTimeout(cloud.timer);cloud.epoch++;cloud.session=null;cloud.pid=null;cloud.base=null;cloud.conflicts=[];$('cloudConnected').hidden=true;$('cloudOwnerKey').value='';cloudRenderConflicts();draw();cloudMessage('已断开共享连接。当前修改保留为离线草稿，重新打开该共享工程时可以合入。');});
$('claimCue').onclick=()=>{const r=project.rows[idx];if(!r||!cloudActive())return;replaceRows(idx,1,[{...r,assignedTo:cloud.session.member.id}],'认领字幕');draw();};
$('nextMine').onclick=()=>{if(!cloud.session)return;for(let n=1;n<=project.rows.length;n++){const i=(idx+n)%project.rows.length;if(project.rows[i].assignedTo===cloud.session.member.id&&project.rows[i].status!=='已校对'){go(i);return;}}notice('你认领的字幕都已校对，或尚未认领字幕。');};
$('cloudHistory').onclick=()=>cloudAction(async()=>{
 const r=project.rows[idx],data=await cloudRequest(cloudPath('projects/'+cloud.pid+'/history')+(r?'?row='+encodeURIComponent(r.id):'')),list=$('cloudHistoryList');list.replaceChildren();$('cloudHistoryPanel').hidden=false;
 if(!data.events.length)list.append(cloudNode('p','这条字幕还没有组内修改记录。'));
 for(const event of data.events){const item=cloudNode('details'),summary=cloudNode('summary',event.actor+' · '+new Date(event.at).toLocaleString());item.append(summary,cloudNode('pre','修改前\n'+cloudConflictValue(event.before,'row')),cloudNode('pre','修改后\n'+cloudConflictValue(event.after,'row')));
  if(event.before?.id&&cloud.session.member.role!=='viewer'){const btn=cloudNode('button','将当前字幕恢复为修改前版本');btn.onclick=()=>{if(!cloudActive()||cloud.conflicts.length)return;const at=project.rows.findIndex(row=>row.id===event.before.id);if(at<0){cloudMessage('该条已删除，先在冲突处理或 JSON 中恢复。');return;}replaceRows(at,1,[clone(event.before)],'恢复历史版本');idx=at;draw();cloudMessage('历史内容已载入，会作为一次新修改同步。');};item.append(btn);}list.append(item);}
});
function cloudInit(){
 cloudRenderConnections();cloudEditControls();cloud.poll=setInterval(()=>{void cloudPoll();},5000);
 try{const params=new URLSearchParams(location.hash.slice(1));if(params.has('subtitleGroup')){
  window.history.replaceState(null,'',location.pathname+location.search);
  if(cloudServer(params.get('backend')||CLOUD_DEFAULT_SERVER)!==CLOUD_DEFAULT_SERVER)throw Error('这个邀请不属于当前字幕网站，请向组长索取本网站的邀请');
  cloud.server=CLOUD_DEFAULT_SERVER;$('cloudJoinGroup').value=params.get('subtitleGroup');$('cloudJoinCode').value=params.get('invite')||'';$('cloudPanel').open=true;$('cloudJoinDetails').open=true;
  window.history.replaceState(null,'',location.pathname+location.search);cloudMessage('邀请已填写，输入昵称后点“加入字幕组”。');
 }}catch(e){cloudMessage('邀请链接无法解析：'+e.message);}
}
// Editor undo uses `history`; the browser history is explicitly qualified above.
window.addEventListener('beforeunload',e=>{if(cloudActive()&&(cloud.conflicts.length||collabDirty(cloud.base,project))){e.preventDefault();e.returnValue='';}});
document.addEventListener('keydown',e=>{if(cloudActive()&&(cloud.session.member.role==='viewer'||cloud.conflicts.length)&&(e.key==='['||e.key===']')){e.preventDefault();e.stopImmediatePropagation();}},true);
void ready.then(cloudInit);
