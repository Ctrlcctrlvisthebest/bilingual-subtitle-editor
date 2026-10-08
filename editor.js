'use strict';
const $=id=>document.getElementById(id);
const clone=value=>JSON.parse(JSON.stringify(value));
const uid=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'p-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const DEFAULT_COLORS={Unknown:'#455a64',Other:'#455a64'};
const DEFAULT_APPEARANCE={mode:'outline',order:'zh-first',zhSize:48,enSize:42,outlineWidth:3,font:'Arial',bold:true};
function normalizeAppearance(value){
 const a=value&&typeof value==='object'?value:{};
 const number=(field,min,max)=>typeof a[field]==='number'&&Number.isFinite(a[field])?Math.max(min,Math.min(max,a[field])):DEFAULT_APPEARANCE[field];
 return{mode:a.mode==='box'?'box':'outline',order:a.order==='en-first'?'en-first':'zh-first',zhSize:number('zhSize',20,90),enSize:number('enSize',20,90),outlineWidth:number('outlineWidth',1,8),font:['Arial','Microsoft YaHei','Noto Sans CJK SC'].includes(a.font)?a.font:'Arial',bold:typeof a.bold==='boolean'?a.bold:true};
}
const bundled=JSON.parse($('initial').textContent);
function normalizeProject(p){
 if(!p||p.version!==1||!Array.isArray(p.rows)||p.title!==undefined&&typeof p.title!=='string'||p.editor_id!==undefined&&typeof p.editor_id!=='string')throw Error('工程格式无效');
 const isOriginal=p.video==='KyLqZkfv3BU'||p.video==='https://www.youtube.com/watch?v=KyLqZkfv3BU';
 const result={...p,appearance:normalizeAppearance(p.appearance),colors:Object.assign(Object.create(null),DEFAULT_COLORS,p.colors),revision:p.revision||1,editor_id:p.editor_id||(isOriginal?'usmp-KyLqZkfv3BU':uid()),title:p.title||'未命名字幕工程'};
 const ids=new Set();
 result.rows=p.rows.map(r=>{
  if(!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start)throw Error('字幕包含无效起止时间');
  const item={...r,id:String(r.id??uid()),zh:r.zh??'',en:r.en??'',speaker:r.speaker||'Unknown',status:r.status||'疑点待听校',note:r.note||''};
  if(['zh','en','speaker','status','note'].some(f=>typeof item[f]!=='string')||ids.has(item.id))throw Error('字幕文字、说话者或编号无效');
  ids.add(item.id);if(!result.colors[item.speaker])result.colors[item.speaker]='#455a64';return item;
 });
 for(const color of Object.values(result.colors))if(!/^#[0-9a-f]{6}$/i.test(color))throw Error('说话者颜色须为六位十六进制颜色');
 return result;
}
let project=normalizeProject(bundled),idx=0,videoUrl,looping=false,auditionEnd=null,frameRequest=null;
let key,baseline,patches={},migrationConflicts=0,history=[],editGroup=null;
const bases=new Map(),REGISTRY='bilingual-subtitle-editor-projects-v1';
const entryKey='bilingual-subtitle-editor-last-'+project.editor_id;
const player=$('video');
if(player.getAttribute('src')&&!project.mediaName)project.mediaName=player.getAttribute('src').split('/').at(-1);
function prepareBase(){key=project.editor_id==='usmp-KyLqZkfv3BU'?'usmp-KyLqZkfv3BU-full-v4':'bilingual-subtitle-editor-v1-'+project.editor_id;baseline=new Map(project.rows.map(r=>[r.id,JSON.stringify(r)]));patches={};migrationConflicts=0}
prepareBase();
function rebaseStored(id,patch){const stored={...patch};for(const update of project.subtitle_updates||[])for(const change of update.rows||[])if(change.id===id)for(const [field,value] of Object.entries(change.before))if(JSON.stringify(stored[field])===JSON.stringify(value))stored[field]=change.after[field];return stored}
function restoreLocal(){try{
 let saved=JSON.parse(localStorage.getItem(key)||'null');
 if(!saved&&project.editor_id==='usmp-KyLqZkfv3BU'){const legacy=JSON.parse(localStorage.getItem('usmp-KyLqZkfv3BU-full-v3')||'null');if(legacy?.revision===3){
  const available=new Map(project.rows.map(r=>[r.id,{...r}])),groups=project.segmentation_updates||[],owners=new Map(),decisions=new Map();
  for(const group of groups){for(const r of group.after)available.delete(r.id);for(const r of group.before){available.set(r.id,{...r});owners.set(r.id,group)}}
  for(const [id,patch] of Object.entries(legacy.patches||{})){const stored=rebaseStored(id,patch);if(available.has(id))Object.assign(available.get(id),stored);else if(stored.en!==undefined)available.set(id,{id,...stored})}
  const order=legacy.order||project.segmentation_source_order||[...available.keys()],present=new Set(order);
  for(const group of groups){const edited=group.before.some(r=>!present.has(r.id)||Object.entries(rebaseStored(r.id,legacy.patches?.[r.id]||{})).some(([f,v])=>JSON.stringify(v)!==JSON.stringify(r[f])));decisions.set(group,edited);if(edited)migrationConflicts++}
  const handled=new Set(),rebuilt=[];
  for(const id of order){const group=owners.get(id);if(group&&!decisions.get(group)){if(!handled.has(group)){rebuilt.push(...group.after.map(r=>({...r})));handled.add(group)}}else if(available.has(id))rebuilt.push(available.get(id))}
  project.rows=rebuilt;project.colors=Object.assign(Object.create(null),project.colors,legacy.colors);
  for(const r of project.rows)if(baseline.get(r.id)!==JSON.stringify(r))patches[r.id]={...r};
  localStorage.setItem(key,JSON.stringify({revision:project.revision,patches,order:project.rows.map(r=>r.id),colors:project.colors}));
  $('msg').textContent=migrationConflicts?`已保留旧页修改；${migrationConflicts} 组断句与浏览器修改冲突，保留你的版本，请对照工程 JSON。`:'旧页修改已合入断句修订版。';
 }}else if(saved?.revision===project.revision){
  for(const r of project.rows)if(saved.patches?.[r.id]){const stored=rebaseStored(r.id,saved.patches[r.id]);Object.assign(r,stored);patches[r.id]=stored}
  if(saved.order){const available=new Map(project.rows.map(r=>[r.id,r]));for(const [id,r] of Object.entries(saved.patches||{}))if(!available.has(id)&&r.en!==undefined)available.set(id,{id,...r});project.rows=saved.order.map(id=>available.get(id)).filter(Boolean)}
  if(saved.colors)project.colors=Object.assign(Object.create(null),saved.colors);
  if(saved.meta)Object.assign(project,saved.meta);
  project.appearance=normalizeAppearance(project.appearance);
  idx=Math.max(0,Math.min(project.rows.length-1,saved.index||0));
 }
}catch(err){$('msg').textContent='暂存恢复失败，请载入已保存的工程 JSON：'+err.message}
}
function notice(text){$('msg').textContent=text}
function registry(){try{const list=JSON.parse(localStorage.getItem(REGISTRY)||'[]');return Array.isArray(list)?list.filter(p=>p&&typeof p.id==='string'&&typeof p.title==='string'):[]}catch{return[]}}
function registerProject(){
 try{const list=registry().filter(p=>p.id!==project.editor_id);list.unshift({id:project.editor_id,title:project.title});localStorage.setItem(REGISTRY,JSON.stringify(list));localStorage.setItem(entryKey,project.editor_id);if(!['generic-blank','usmp-KyLqZkfv3BU'].includes(project.editor_id))localStorage.setItem('bilingual-subtitle-editor-last-generic-blank',project.editor_id)}catch{}
 drawProjectPicker();
}
const database=typeof indexedDB==='undefined'?Promise.resolve(null):new Promise(resolve=>{
 try{const request=indexedDB.open('bilingual-subtitle-editor',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects',{keyPath:'editor_id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);request.onblocked=()=>resolve(null)}catch{resolve(null)}
});
async function storeBase(p){
 bases.set(p.editor_id,clone(p));const db=await database;if(!db)return false;
 return new Promise(resolve=>{try{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(clone(p));tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false)}catch{resolve(false)}});
}
async function readBase(id){
 if(bases.has(id))return clone(bases.get(id));const db=await database;if(!db)return null;
 return new Promise(resolve=>{try{const r=db.transaction('projects').objectStore('projects').get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>resolve(null)}catch{resolve(null)}});
}
function trackRow(r){
 const base=baseline.get(r.id);if(!base){patches[r.id]=clone(r);return}
 if(base===JSON.stringify(r)){delete patches[r.id];return}
 const original=JSON.parse(base),changed={};for(const [field,value] of Object.entries(r))if(JSON.stringify(value)!==JSON.stringify(original[field]))changed[field]=value;
 patches[r.id]=clone(changed);
}
function persist(r,quiet=false){
 if(r)trackRow(r);
 try{
  localStorage.setItem(key,JSON.stringify({revision:project.revision,patches,order:project.rows.map(r=>r.id),colors:project.colors,index:idx,meta:{title:project.title,mediaName:project.mediaName,fineStep:project.fineStep,appearance:project.appearance}}));
  if(!quiet)notice('修改已暂存；关闭前可保存工程 JSON 作为备份。');
 }catch{notice('本浏览器暂存未成功，请保存工程 JSON 保留修改。')}
}
function storageNotice(durable){$('storageNotice').textContent=durable?'修改按工程分别暂存。关闭前建议保存 JSON 备份；重新打开后可再选择对应的音视频。':'本浏览器未能保存工程底稿，请保存工程 JSON 作为继续编辑的依据。';$('storageNotice').className=durable?'muted':'warning'}
function trackAll(){for(const r of project.rows)trackRow(r);persist(null,true)}
function drawProjectPicker(){
 const list=registry();if(!list.some(p=>p.id===project.editor_id))list.unshift({id:project.editor_id,title:project.title});
 $('projectPicker').replaceChildren(...list.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.title;return o}));$('projectPicker').value=project.editor_id;
}
function drawSpeakers(){
 $('speaker').replaceChildren(...Object.keys(project.colors).map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o}));
}
function contrast(hex){const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));return rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>155?'#101010':'#ffffff'}
function widthUnits(s){return [...s].reduce((n,c)=>n+(/[\u2e80-\uffef]/.test(c)?1:.52),0)}
function drawAppearance(){
 const a=project.appearance;
 for(const [id,field] of Object.entries({subtitleMode:'mode',subtitleOrder:'order',zhSize:'zhSize',enSize:'enSize',outlineWidth:'outlineWidth',subtitleFont:'font'}))$(id).value=String(a[field]);
 $('subtitleBold').checked=a.bold;
 $('outlineWidth').disabled=a.mode==='box';
}
function preview(r){
 $('sub').style.visibility='visible';$('zh').textContent=r.zh||'';$('en').textContent=r.en||'';
 const a=project.appearance,color=project.colors[r.speaker]||'#455a64',outlined=a.mode==='outline';
 $('sub').style.background=outlined?'transparent':color;$('sub').style.border='none';$('sub').style.color=outlined?'#ffffff':contrast(color);
 $('sub').style.fontFamily='"'+a.font+'", "PingFang SC", "Microsoft YaHei", sans-serif';$('sub').style.fontWeight=a.bold?'700':'400';
 const available=Math.max(160,($('screen').clientWidth||1000)-100);
 const scale=Math.min(1,available/1720),stroke=a.outlineWidth*scale;
 for(const [language,size] of [['zh',a.zhSize],['en',a.enSize]]){const el=$(language);el.style.fontSize=Math.min(size*scale,available/Math.max(1,widthUnits(r[language])))+'px';el.style.display=r[language].trim()?'block':'none';el.style.order=language===(a.order==='zh-first'?'zh':'en')?'0':'1';el.style.webkitTextStroke=outlined?(2*stroke)+'px '+color:'0px';el.style.textShadow=outlined?'0 '+scale+'px '+scale+'px #000000':'none'}
}
const rowControls=['prev','next','seek','setStart','setEnd','startMinus','startPlus','endMinus','endPlus','listenStart','listenEnd','split','merge','delete','start','end','speaker','status','zhEdit','enEdit','note'];
function draw(){
 const r=project.rows[idx];$('index').value=r?idx+1:0;$('index').max=project.rows.length;$('count').textContent='/ '+project.rows.length;
 for(const id of rowControls)$(id).disabled=!r;
 $('undo').disabled=!history.length;$('projectTitle').value=project.title;$('mediaName').textContent=project.mediaName||'请选择本地音视频';
 $('fineStep').value=String(project.fineStep||.1);updateFineLabels();
 for(const f of ['start','end','speaker','status','note','zhEdit','enEdit'])$(f).value=r?(f==='zhEdit'?r.zh:f==='enEdit'?r.en:r[f]??''):'';
 $('asrText').textContent='音频转写参考：'+(r?.audioTranscript||'暂无');$('ytText').textContent='原字幕参考：'+(r?.youtubeTranscript||r?.sourceText||r?.en||'暂无');
 $('verification').textContent=r?'说话者：'+(r.verification?.speaker==='confirmed'?'已确认':r.speaker==='Unknown'?'未确认':'暂定 '+r.speaker):'尚无字幕；可导入 SRT / ASS，或在当前位置新增。';
 if(r){preview(r);$('speakerName').value=r.speaker;$('speakerColor').value=project.colors[r.speaker]||'#455a64'}else $('sub').style.visibility='hidden';
 drawAppearance();timingHint();offsetPreview();
}
function go(i){if(!project.rows.length)return;idx=Math.max(0,Math.min(project.rows.length-1,Math.floor(i)||0));stopLoop();editGroup=null;draw();persist(null,true)}
function remember(entry){history.push({...entry,idx});if(history.length>30)history.shift();$('undo').disabled=false}
function replaceRows(at,count,items,label,coalesce){
 if(!(coalesce&&editGroup===coalesce&&history.at(-1)?.coalesce===coalesce))remember({kind:'splice',at,inserted:items.length,rows:clone(project.rows.slice(at,at+count)),label,coalesce});
 editGroup=coalesce||null;const removed=project.rows.splice(at,count,...items);for(const r of removed)delete patches[r.id];for(const r of items)trackRow(r);persist(null,true);
}
function validTimes(r){return Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.start>=0&&r.end>r.start}
function commit(field){
 const current=project.rows[idx];if(!current)return;const r=clone(current);
 if(field==='start'||field==='end'){const raw=$(field).value;if(raw.trim()===''){notice('请输入有效时间。');draw();return}r[field]=Number(raw);if(!validTimes(r)){notice('开始须不小于 0，结束须晚于开始；本次修改未应用。');draw();return}}
 else if(field==='zhEdit')r.zh=$('zhEdit').value;else if(field==='enEdit')r.en=$('enEdit').value;else r[field]=$(field).value;
 if(JSON.stringify(r)===JSON.stringify(current))return;
 if(field==='status'&&r.status==='已校对')r.verification={...r.verification,translation:'user_reviewed',audio:'user_reviewed',speaker:'confirmed'};
 replaceRows(idx,1,[r],'编辑字幕','edit:'+r.id+':'+field);preview(r);timingHint();offsetPreview();persist(r);
}
for(const f of ['start','end','speaker','status','note','zhEdit','enEdit']){
 $(f).addEventListener(f==='start'||f==='end'?'change':'input',()=>commit(f));
 $(f).addEventListener('focus',()=>{editGroup=null});
 if(f==='start'||f==='end'){$(f).addEventListener('blur',()=>commit(f));$(f).addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commit(f)}})}
}
$('prev').onclick=()=>go(idx-1);$('next').onclick=()=>go(idx+1);$('index').onchange=()=>go(Number($('index').value)-1);
$('undo').onclick=()=>{
 const h=history.pop();if(!h)return;
 if(h.kind==='splice')project.rows.splice(h.at,h.inserted,...h.rows);else{const before=new Map(h.rows.map(r=>[r.id,r]));project.rows=project.rows.map(r=>before.get(r.id)||r)}
 if(h.colors){project.colors=Object.assign(Object.create(null),h.colors);drawSpeakers()}
 if(h.appearance)project.appearance=normalizeAppearance(h.appearance);
 idx=Math.max(0,Math.min(project.rows.length-1,h.idx));stopLoop();editGroup=null;trackAll();draw();notice('已撤销：'+h.label);
};
function blankRow(start=0,end=start+2){return{id:uid(),start,end,zh:'',en:'',speaker:'Unknown',status:'疑点待听校',note:'',verification:{translation:'pending',audio:'pending',speaker:'pending'}}}
$('add').onclick=()=>{
 const start=mediaReady()?Math.min(player.currentTime,Math.max(0,player.duration-.01)):(project.rows[idx]?.end||0),end=mediaReady()?Math.min(player.duration,start+2):start+2;
 const at=project.rows.length?idx+1:0;replaceRows(at,0,[blankRow(roundTime(start),roundTime(end))],'新增字幕');idx=at;draw();persist(null,true);notice('已在 '+playbackTime(start)+' 新增一条字幕。');
};
$('delete').onclick=()=>{if(!project.rows.length)return;replaceRows(idx,1,[],'删除字幕');idx=Math.max(0,Math.min(idx,project.rows.length-1));draw()};
$('merge').onclick=()=>{
 const a=project.rows[idx],b=project.rows[idx+1];if(!b)return;
 const merged={...a,end:Math.max(a.end,b.end),en:(a.en+' '+b.en).trim(),zh:(a.zh+' '+b.zh).trim(),note:(a.note+' '+b.note).trim(),speaker:a.speaker===b.speaker?a.speaker:'Unknown',status:'疑点待听校'};
 replaceRows(idx,2,[merged],'合并字幕');draw();
};
$('split').onclick=()=>{
 const r=project.rows[idx];if(!r)return;
 const enPos=$('enEdit').selectionStart??Math.floor(r.en.length/2),zhPos=$('zhEdit').selectionStart??Math.floor(r.zh.length/2);
 const mid=roundTime(mediaReady()&&player.currentTime>r.start&&player.currentTime<r.end?player.currentTime:(r.start+r.end)/2);
 if(mid<=r.start||mid>=r.end){notice('本条太短，无法继续拆分。');return}
 replaceRows(idx,1,[{...r,end:mid,en:r.en.slice(0,enPos).trim(),zh:r.zh.slice(0,zhPos).trim()},{...r,id:uid(),start:mid,en:r.en.slice(enPos).trim(),zh:r.zh.slice(zhPos).trim(),status:'疑点待听校'}],'拆分字幕');draw();
};
$('find').onclick=()=>{const q=$('query').value.trim().toLowerCase();if(!q)return;for(let n=1;n<=project.rows.length;n++){const i=(idx+n)%project.rows.length,r=project.rows[i];if((r.zh+' '+r.en+' '+r.note).toLowerCase().includes(q)){go(i);return}}notice('没有匹配内容。')};
$('nextFlag').onclick=()=>{for(let n=1;n<=project.rows.length;n++){const i=(idx+n)%project.rows.length;if(project.rows[i].status==='疑点待听校'){go(i);return}}notice('没有剩余的词句疑点。')};
function roundTime(t){return Math.round(t*1000)/1000}
function time(s,ass=false){const unit=ass?100:1000,v=Math.round(s*unit),h=Math.floor(v/(unit*3600)),m=Math.floor(v/(unit*60))%60,z=Math.floor(v/unit)%60,f=v%unit;return(ass?String(h):String(h).padStart(2,'0'))+':'+String(m).padStart(2,'0')+':'+String(z).padStart(2,'0')+(ass?'.':',')+String(f).padStart(ass?2:3,'0')}
function playbackTime(s){return Number.isFinite(s)?time(Math.max(0,s)).replace(',','.'):'--:--:--.---'}
function mediaReady(show=false){const ok=player.readyState>=1&&Number.isFinite(player.duration)&&player.duration>0&&!player.error;if(!ok&&show)$('seekFeedback').textContent=player.error||!player.getAttribute('src')?'请先载入本地音视频。':'片源正在载入，请稍候。';return ok}
function stopLoop(){looping=false;auditionEnd=null;$('loop').checked=false}
function updatePlayback(){
 const ready=mediaReady();for(const id of ['back5','forward5','backFine','forwardFine','playPause'])$(id).disabled=!ready;
 $('playPause').textContent=player.paused?'▶ 播放':'Ⅱ 暂停';$('playPause').setAttribute('aria-label',player.paused?'播放':'暂停');
 if(ready){
  if(auditionEnd!==null&&player.currentTime>=auditionEnd){const end=auditionEnd;auditionEnd=null;player.pause();player.currentTime=end}
  else if(looping&&project.rows[idx]&&player.currentTime>=project.rows[idx].end)player.currentTime=project.rows[idx].start;
  const r=project.rows.find(r=>r.start<=player.currentTime&&r.end>player.currentTime);$('sub').style.visibility=r?'visible':'hidden';if(r)preview(r);
 }
 $('playbackClock').textContent=playbackTime(player.currentTime)+' / '+playbackTime(player.duration);
}
function renderFrames(){if(frameRequest!==null)cancelAnimationFrame(frameRequest);frameRequest=null;if(typeof requestAnimationFrame!=='function')return;const tick=()=>{updatePlayback();if(!player.paused)frameRequest=requestAnimationFrame(tick);else frameRequest=null};if(!player.paused)frameRequest=requestAnimationFrame(tick)}
function seekPlayback(target,label='已跳转'){
 if(!mediaReady(true)||!Number.isFinite(target))return false;
 const hadLoop=looping||$('loop').checked;stopLoop();player.currentTime=Math.max(0,Math.min(player.duration,target));updatePlayback();
 $('seekFeedback').textContent=label+' · '+playbackTime(player.currentTime)+(hadLoop?' · 已退出循环':'');return true;
}
function skipBy(seconds){return seekPlayback(player.currentTime+seconds,(seconds<0?'后退 ':'前进 ')+Math.abs(seconds)+' 秒')}
function togglePlayback(){if(!mediaReady(true))return;if(player.paused)player.play().catch(()=>{$('seekFeedback').textContent='播放失败，请重新载入片源。'});else player.pause();updatePlayback()}
function fineStep(){return Number($('fineStep').value)||.1}
function updateFineLabels(){$('backFine').textContent='−'+fineStep().toFixed(2)+' 秒';$('forwardFine').textContent='+'+fineStep().toFixed(2)+' 秒'}
$('fineStep').onchange=()=>{project.fineStep=fineStep();updateFineLabels();persist(null,true)};
$('back5').onclick=()=>skipBy(-5);$('forward5').onclick=()=>skipBy(5);$('backFine').onclick=()=>skipBy(-fineStep());$('forwardFine').onclick=()=>skipBy(fineStep());$('playPause').onclick=togglePlayback;
$('seek').onclick=()=>{const r=project.rows[idx];if(!r||!mediaReady(true))return;if(r.start>=player.duration){$('seekFeedback').textContent='本条在片源时长之外，请检查时间或载入对应视频。';return}auditionEnd=null;player.currentTime=r.start;looping=$('loop').checked;updatePlayback();player.play().catch(()=>notice('播放失败，请检查片源。'))};
$('loop').onchange=()=>{if(!$('loop').checked)looping=false};
$('selectCurrent').onclick=()=>{const t=player.currentTime;let i=project.rows.findIndex(r=>r.start<=t&&r.end>t);if(i<0)i=project.rows.findIndex(r=>r.end>t);if(i>=0)go(i)};
$('jump').onclick=()=>{const input=$('jumpTime').value.trim(),parts=input.split(':').map(Number);if(!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(input)||parts.slice(1).some(n=>n>=60)){notice('请输入秒数或时:分:秒，例如 120.5 或 02:00:02。');return}const t=parts.reduce((s,n)=>s*60+n,0);seekPlayback(t)};
$('jumpTime').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('jump').click()}});
player.ontimeupdate=updatePlayback;
for(const event of ['loadedmetadata','durationchange','seeked','pause','ended','emptied'])player.addEventListener(event,()=>{updatePlayback();timingHint();if(event==='loadedmetadata'&&$('seekFeedback').textContent.startsWith('正在载入 '))$('seekFeedback').textContent='已载入 '+project.mediaName});
player.addEventListener('play',()=>{updatePlayback();renderFrames()});
player.addEventListener('error',()=>{updatePlayback();$('seekFeedback').textContent='片源未能载入，请选择本地音视频文件。'});
$('videoFile').onchange=e=>{const file=e.target.files[0];if(!file)return;if(videoUrl)URL.revokeObjectURL(videoUrl);videoUrl=URL.createObjectURL(file);stopLoop();player.src=videoUrl;project.mediaName=file.name;$('mediaName').textContent=file.name;$('seekFeedback').textContent='正在载入 '+file.name;persist(null,true);updatePlayback();e.target.value=''};
function timingHint(){
 const r=project.rows[idx];if(!r){$('timingHint').textContent='';return}
 const issues=[],prev=project.rows[idx-1],next=project.rows[idx+1];
 if(prev&&prev.end>r.start)issues.push('与上一条重叠 '+(prev.end-r.start).toFixed(3)+' 秒');
 if(next&&r.end>next.start)issues.push('与下一条重叠 '+(r.end-next.start).toFixed(3)+' 秒');
 if(mediaReady()&&r.end>player.duration)issues.push('超出当前片源时长');
 $('timingHint').textContent='本条 '+(r.end-r.start).toFixed(3)+' 秒 · '+playbackTime(r.start)+' → '+playbackTime(r.end)+(issues.length?' · '+issues.join('；'):'');$('timingHint').className=issues.length?'warning':'muted';
}
function changeTiming(field,target,label){
 const old=project.rows[idx];if(!old)return;const r={...old,[field]:roundTime(target)};
 if(!validTimes(r)){notice('微调会造成开始早于 0 或结束不晚于开始，本次未应用。');return false}
 if(mediaReady()&&r.end>player.duration){notice('微调会超出片源时长，本次未应用。');return false}
 replaceRows(idx,1,[r],label);stopLoop();draw();notice(label+'：'+playbackTime(r[field]));return true;
}
function setBoundaryNow(field){
 const old=project.rows[idx];if(!old||!mediaReady(true))return;
 const t=roundTime(player.currentTime),r={...old,[field]:t},length=old.end-old.start;let extended=false;
 if(field==='start'&&t>=r.end){r.end=roundTime(Math.min(player.duration,t+length));extended=true}
 if(field==='end'&&t<=r.start){r.start=roundTime(Math.max(0,t-length));extended=true}
 if(!validTimes(r)){notice('当前位置无法形成有效字幕区间，请稍微移动播放位置。');return}
 replaceRows(idx,1,[r],'按播放位置设置'+(field==='start'?'开始':'结束'));stopLoop();draw();notice((field==='start'?'开始':'结束')+'已设为 '+playbackTime(t)+(extended?'；另一端已同步调整，避免无效区间。':'。'));
}
$('setStart').onclick=()=>setBoundaryNow('start');$('setEnd').onclick=()=>setBoundaryNow('end');
for(const [id,field,sign] of [['startMinus','start',-1],['startPlus','start',1],['endMinus','end',-1],['endPlus','end',1]])$(id).onclick=()=>{const r=project.rows[idx];if(r)changeTiming(field,r[field]+sign*fineStep(),'微调'+(field==='start'?'开始':'结束'))};
function audition(field){
 const r=project.rows[idx];if(!r||!mediaReady(true))return;const boundary=r[field],start=Math.max(0,boundary-(field==='start'?.5:1)),end=Math.min(player.duration,boundary+.5);
 if(start>=end){notice('字幕边界不在片源范围内。');return}
 seekPlayback(start,field==='start'?'试听开始前后':'试听结束前后');auditionEnd=end;player.play().catch(()=>{auditionEnd=null;notice('试听失败，请检查片源。')});
}
$('listenStart').onclick=()=>audition('start');$('listenEnd').onclick=()=>audition('end');
function offsetRows(){return $('offsetScope').value==='current'?project.rows.slice(idx,idx+1):$('offsetScope').value==='following'?project.rows.slice(idx):project.rows}
function offsetPreview(){const rs=offsetRows(),delta=Number($('offsetSeconds').value),r=project.rows[idx];$('offsetPreview').textContent=r&&Number.isFinite(delta)?'影响 '+rs.length+' 条；本条开始 '+playbackTime(r.start)+' → '+(r.start+delta<0?'片头之前':playbackTime(r.start+delta)):'请先选择字幕。'}
$('offsetScope').onchange=offsetPreview;$('offsetSeconds').addEventListener('input',offsetPreview);
$('alignOffset').onclick=()=>{if(!project.rows[idx]||!mediaReady(true))return;$('offsetSeconds').value=roundTime(player.currentTime-project.rows[idx].start);offsetPreview();notice('已计算偏移量；检查影响范围后点“应用偏移”。')};
$('applyOffset').onclick=()=>{
 const rs=offsetRows(),raw=$('offsetSeconds').value,delta=Number(raw);if(!rs.length||!raw.trim()||!Number.isFinite(delta)){notice('请输入有效偏移秒数。');return}if(!delta){notice('偏移为 0，无需修改。');return}
 const changed=rs.map(r=>({...r,start:roundTime(r.start+delta),end:roundTime(r.end+delta)}));if(changed.some(r=>!validTimes(r))){notice('偏移会使字幕越过片头或形成无效区间，本次未应用。');return}
 remember({kind:'restore',rows:clone(rs),label:'批量偏移 '+delta+' 秒'});editGroup=null;const replacements=new Map(changed.map(r=>[r.id,r]));project.rows=project.rows.map(r=>replacements.get(r.id)||r);stopLoop();trackAll();draw();notice('已将 '+rs.length+' 条字幕'+(delta<0?'提前 ':'延后 ')+Math.abs(delta)+' 秒，可撤销。');
};
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented||e.isComposing||e.altKey||e.ctrlKey||e.metaKey)return;
 const target=e.target;if(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable],[role="textbox"],[role="slider"],[role="spinbutton"]'))return;
 if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();skipBy((e.key==='ArrowLeft'?-1:1)*(e.shiftKey?fineStep():5))}
 else if(e.shiftKey)return;
 else if(e.key==='['||e.key===']'){e.preventDefault();setBoundaryNow(e.key==='['?'start':'end')}
 else if(e.code==='Space'&&!e.repeat&&!target?.closest?.('button,a,summary,[role="button"]')){e.preventDefault();togglePlayback()}
});
function parseStamp(value){const m=value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);if(!m||Number(m[2])>=60||Number(m[3])>=60)throw Error('字幕时间格式无效：'+value);return Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4].padEnd(3,'0'))/1000}
function plainText(s){return s.replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[v]).replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'')}
function splitLanguages(text,mode='auto'){
 const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 if(mode==='zh-first'&&lines.length>1)return{zh:lines[0],en:lines.slice(1).join(' ')};
 if(mode==='en-first'&&lines.length>1)return{en:lines[0],zh:lines.slice(1).join(' ')};
 const chinese=lines.filter(s=>/[\u3400-\u9fff]/.test(s)),other=lines.filter(s=>!/[\u3400-\u9fff]/.test(s));
 return{zh:chinese.join(' '),en:other.join(' ')};
}
function parseSRT(text,mode='auto'){
 const normalized=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),blocks=normalized.trim().split(/\n[ \t]*\n/),parsed=[];
 for(const block of blocks){
  const lines=block.split('\n'),i=lines.findIndex(s=>s.includes('-->'));if(i<0){if(block.trim())throw Error('有字幕块缺少时间轴');continue}
  const m=lines[i].match(/^\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})(?:\s.*)?$/);if(!m)throw Error('字幕时间行无法识别');
  const sourceText=plainText(lines.slice(i+1).join('\n'));if(!sourceText.trim())continue;
  parsed.push({...blankRow(parseStamp(m[1]),parseStamp(m[2])),...splitLanguages(sourceText,mode),sourceText});
 }
 if(!parsed.length)throw Error('未发现可导入的字幕');return normalizeProject({version:1,rows:parsed,colors:DEFAULT_COLORS}).rows.sort((a,b)=>a.start-b.start);
}
function assColor(value){const hex=String(value||'').replace(/^&H/i,'').replace(/&$/,'').padStart(8,'0').slice(-6);return/^[0-9a-f]{6}$/i.test(hex)?'#'+hex.slice(4,6)+hex.slice(2,4)+hex.slice(0,2):'#455a64'}
function csvFields(text,fields){const parts=text.split(',');return parts.length<fields.length?null:parts.slice(0,fields.length-1).concat(parts.slice(fields.length-1).join(','))}
function parseASS(text,mode='auto'){
 let section='',styleFields=[],eventFields=['Layer','Start','End','Style','Name','MarginL','MarginR','MarginV','Effect','Text'],appearance=normalizeAppearance();const styles=Object.create(null),colors=Object.assign(Object.create(null),DEFAULT_COLORS),parsed=[];
 for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(line.startsWith('; BilingualEditorAppearance: ')){appearance=normalizeAppearance(JSON.parse(line.slice('; BilingualEditorAppearance: '.length)));continue}
  if(/^\[/.test(line.trim())){section=line.trim();continue}
  if(/^Format:/i.test(line)){const fields=line.slice(line.indexOf(':')+1).split(',').map(s=>s.trim());if(section==='[Events]')eventFields=fields;else if(/Styles/.test(section))styleFields=fields;continue}
  if(/^Style:/i.test(line)&&styleFields.length){const parts=csvFields(line.slice(line.indexOf(':')+1).trim(),styleFields);if(parts){const style=Object.fromEntries(styleFields.map((f,i)=>[f,parts[i].trim()]));styles[style.Name]=style}continue}
  if(!/^Dialogue:/i.test(line)||section!=='[Events]')continue;
  const parts=csvFields(line.slice(line.indexOf(':')+1).trim(),eventFields);if(!parts)throw Error('ASS 对话字段缺失');const event=Object.fromEntries(eventFields.map((f,i)=>[f,parts[i]]));
  if(/\{[^}]*\\p[1-9]/.test(event.Text))throw Error('该 ASS 含绘图字幕；请先另存为文本字幕再导入');
  const sourceText=event.Text.replace(/\{[^}]*\}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ');if(!sourceText.trim())continue;
  const speaker=(event.Name||event.Style||'Unknown').trim(),style=styles[event.Style];colors[speaker]=style?assColor(style.OutlineColour||style.BackColour):'#455a64';
  parsed.push({...blankRow(parseStamp(event.Start),parseStamp(event.End)),...splitLanguages(sourceText,mode),speaker,sourceText});
 }
 if(!parsed.length)throw Error('未发现 ASS 文本字幕');return normalizeProject({version:1,rows:parsed,colors,appearance});
}
function clearMedia(){player.pause();stopLoop();player.removeAttribute('src');player.load();$('mediaName').textContent='请选择本工程对应的音视频';$('seekFeedback').textContent='';updatePlayback()}
const mediaSources=new Map();if(player.getAttribute('src'))mediaSources.set(project.editor_id,{src:player.getAttribute('src'),time:0});
async function activateProject(p,{restore=true,store=false}={}){
 const incoming=normalizeProject(p);persist(null,true);
 if(player.getAttribute('src'))mediaSources.set(project.editor_id,{src:player.getAttribute('src'),time:player.currentTime});
 clearMedia();if(store)storageNotice(await storeBase(incoming));
 project=incoming;idx=0;history=[];editGroup=null;prepareBase();$('offsetSeconds').value='0';$('offsetScope').value='all';$('jumpTime').value='';$('query').value='';
 if(restore)restoreLocal();else{try{localStorage.removeItem(key)}catch{}}
 const media=mediaSources.get(project.editor_id);if(media){player.src=media.src;const resume=()=>{if(media.time<player.duration)player.currentTime=media.time;player.removeEventListener('loadedmetadata',resume)};player.addEventListener('loadedmetadata',resume)}
 drawSpeakers();registerProject();draw();persist(null,true);
}
$('projectPicker').onchange=async()=>{const id=$('projectPicker').value;const base=await readBase(id);if(!base){$('projectPicker').value=project.editor_id;notice('本浏览器没有该工程底稿，请载入它的工程 JSON。');return}await activateProject(base);notice('已切换工程。请检查片源是否对应，必要时重新选择本地视频。')};
$('newProject').onclick=async()=>{await activateProject({version:1,revision:1,editor_id:uid(),title:'新字幕工程',colors:clone(project.colors),appearance:clone(project.appearance),rows:[]},{restore:false,store:true});notice('新工程已建立并沿用当前说话者颜色和字幕样式：选择视频后导入字幕，或在当前位置新增。')};
async function importFile(file){
 const text=await file.text(),mode=$('importOrder').value;let p;
 if(/\.json$/i.test(file.name)){
  p=JSON.parse(text);
  if(p.video===project.video&&p.video&&p.revision<3&&project.revision>=3){const edits=new Map(normalizeProject(p).rows.map(r=>[r.id,r]));remember({kind:'restore',rows:clone(project.rows.filter(r=>edits.has(r.id))),colors:clone(project.colors),label:'合入旧版部分工程'});project.rows=project.rows.map(r=>edits.has(r.id)?{...r,...edits.get(r.id)}:r);project.colors=Object.assign(Object.create(null),project.colors,p.colors);drawSpeakers();trackAll();draw();notice('旧版部分工程已按编号合入，完整版后续字幕及参考底稿保留。');return}
 }else{
  const parsed=/\.ass$/i.test(file.name)?parseASS(text,mode):{rows:parseSRT(text,mode),colors:DEFAULT_COLORS,appearance:clone(project.appearance)};
  p={...parsed,version:1,revision:1,editor_id:uid(),title:file.name.replace(/\.(srt|ass)$/i,''),colors:{...project.colors,...parsed.colors}};
 }
 await activateProject(p,{restore:false,store:true});notice('已导入 '+project.rows.length+' 条字幕。'+(/\.ass$/i.test(file.name)?'已读取文字、时间和说话者颜色；重新导出使用本编辑器的双语排版。':''));
}
$('load').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{await importFile(file)}catch(err){notice('导入失败：'+err.message)}finally{e.target.value=''}};
$('projectTitle').addEventListener('input',()=>{const name=$('projectTitle').value.trim();if(name){project.title=name;persist(null,true);registerProject()}});
$('projectTitle').onchange=()=>{if(!$('projectTitle').value.trim())$('projectTitle').value=project.title};
function changeAppearance(){
 const incoming=normalizeAppearance({mode:$('subtitleMode').value,order:$('subtitleOrder').value,zhSize:Number($('zhSize').value),enSize:Number($('enSize').value),outlineWidth:Number($('outlineWidth').value),font:$('subtitleFont').value,bold:$('subtitleBold').checked});
 if(JSON.stringify(incoming)===JSON.stringify(project.appearance)){drawAppearance();return}
 remember({kind:'restore',rows:[],appearance:clone(project.appearance),label:'字幕样式'});project.appearance=incoming;editGroup=null;persist(null,true);draw();notice('字幕样式已更新，预览和 ASS 导出同步；文字与时间保持不变，可撤销。');
}
for(const id of ['subtitleMode','subtitleOrder','zhSize','enSize','outlineWidth','subtitleFont','subtitleBold'])$(id).addEventListener('change',changeAppearance);
for(const id of ['zhSize','enSize','outlineWidth']){$(id).addEventListener('blur',changeAppearance);$(id).addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();changeAppearance()}})}
$('speaker').addEventListener('change',()=>{$('speakerName').value=$('speaker').value;$('speakerColor').value=project.colors[$('speaker').value]});
$('addSpeaker').onclick=()=>{const name=$('speakerName').value.trim(),color=$('speakerColor').value;if(!name||name.length>80){notice('请输入 1～80 字的说话者名称。');return}const r=project.rows[idx];remember({kind:'restore',rows:r?[clone(r)]:[],colors:clone(project.colors),label:'修改说话者与颜色'});project.colors[name]=color;if(r)project.rows[idx]={...r,speaker:name};drawSpeakers();trackAll();draw();notice('已保存说话者 '+name+' 的颜色'+(r?'；当前字幕已归给此人。':'。'))};
$('renameSpeaker').onclick=()=>{const from=$('speaker').value,to=$('speakerName').value.trim();if(!from||!to||to.length>80){notice('请选中字幕的说话者并填写新名字。');return}if(from===to){$('addSpeaker').click();return}if(project.colors[to]){notice('该名字已存在，请用说话者下拉框更改归属。');return}const affected=project.rows.filter(r=>r.speaker===from);remember({kind:'restore',rows:clone(affected),colors:clone(project.colors),label:'重命名说话者'});project.colors[to]=$('speakerColor').value;project.rows=project.rows.map(r=>r.speaker===from?{...r,speaker:to}:r);drawSpeakers();trackAll();draw();notice('已重命名 '+affected.length+' 条；可撤销恢复旧名字。')};
function download(name,data,type='application/json'){const u=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000)}
function exportName(ext){if(project.editor_id==='usmp-KyLqZkfv3BU')return ext==='json'?'USMP字幕校对工程-完整版.json':'USMP完整双语字幕-待审核.'+ext;return(project.title.replace(/[\\/:*?"<>|]/g,'_')||'字幕工程')+'.'+ext}
function rows(){const rs=project.rows.filter(r=>r.zh.trim()||r.en.trim()).sort((a,b)=>a.start-b.start);if(!rs.length){notice('暂无字幕文字。');return null}if(rs.some(r=>!validTimes(r))){notice('有无效时间，请修正后导出。');return null}notice('已导出 '+rs.length+' 条；含单语条目 '+rs.filter(r=>!r.zh.trim()||!r.en.trim()).length+' 条。');return rs}
function esc(s){return s.replace(/\\/g,'＼').replace(/[{}]/g,'').replace(/[\r\n]+/g,' ')}
function buildASS(rs){
 const a=project.appearance,outlined=a.mode==='outline';
 let header='[Script Info]\nTitle: Bilingual subtitles\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\nWrapStyle: 2\n; BilingualEditorAppearance: '+JSON.stringify(a)+'\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';
 const styles=new Map(),reserved=new Set(Object.keys(project.colors));let n=0;
 for(const [name,hex] of Object.entries(project.colors)){let style=name;if(!/^[\w-]+$/.test(name)){do{style='Speaker_'+(++n)}while(reserved.has(style));reserved.add(style)}styles.set(name,style);const c=hex.slice(1),bgr=c.slice(4,6)+c.slice(2,4)+c.slice(0,2),foreground=outlined?'&H00FFFFFF':contrast(hex)==='#101010'?'&H00101010':'&H00FFFFFF';header+=`Style: ${style},${a.font},${a.zhSize},${foreground},&H00FFFFFF,&H00${bgr},${outlined?'&H80000000':'&H00'+bgr},${a.bold?-1:0},0,0,0,100,100,0,0,${outlined?1:3},${outlined?a.outlineWidth:10},${outlined?1:0},2,80,80,60,1\n`}
 header+='\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
 return header+rs.map(r=>{const parts=[],start=Math.round(r.start*100)/100,end=Math.max(start+.01,Math.round(r.end*100)/100);for(const language of a.order==='zh-first'?['zh','en']:['en','zh'])if(r[language].trim()){const size=Math.min(a[language+'Size'],Math.floor(1700/Math.max(1,widthUnits(r[language]))));parts.push(`{\\fs${size}}${esc(r[language])}`)}return`Dialogue: 0,${time(start,true)},${time(end,true)},${styles.get(r.speaker)||'Unknown'},${r.speaker.replace(/[,\r\n]/g,' ')},0,0,0,,${parts.join('\\N')}`}).join('\n')+'\n';
}
function buildSRT(rs){return rs.map((r,i)=>`${i+1}\n${time(r.start)} --> ${time(r.end)}\n${(project.appearance.order==='zh-first'?[r.zh,r.en]:[r.en,r.zh]).filter(s=>s.trim()).map(s=>s.replace(/[\r\n]+/g,' ')).join('\n')}\n`).join('\n')}
$('save').onclick=()=>{persist(null,true);download(exportName('json'),JSON.stringify(project,null,2))};
$('srt').onclick=()=>{const rs=rows();if(rs)download(exportName('srt'),buildSRT(rs),'text/plain;charset=utf-8')};
$('ass').onclick=()=>{const rs=rows();if(rs)download(exportName('ass'),buildASS(rs),'text/plain;charset=utf-8')};
restoreLocal();drawSpeakers();drawProjectPicker();draw();updatePlayback();
const ready=(async()=>{
 storageNotice(await storeBase(normalizeProject(bundled)));
 if(project.editor_id==='generic-blank'){let last;try{last=localStorage.getItem(entryKey)}catch{}if(last&&last!==project.editor_id){const p=await readBase(last);if(p)await activateProject(p)}}
 registerProject();
})();
