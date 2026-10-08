const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'editor.js'),'utf8');
function fakeDB(data=new Map()){
 const db={createObjectStore(){},transaction(){const tx={objectStore(){return{put(p){data.set(p.editor_id,JSON.parse(JSON.stringify(p)));queueMicrotask(()=>tx.oncomplete?.())},get(id){const r={};queueMicrotask(()=>{r.result=data.get(id);r.onsuccess?.()});return r}}}};return tx}};
 return{open(){const r={result:db};queueMicrotask(()=>r.onsuccess?.());return r}};
}
function setup(p,storage={},dbData=new Map()){
 const elements=new Map(),events={};
 function element(id){if(!elements.has(id))elements.set(id,{value:'',style:{},textContent:'',checked:false,selectionStart:0,clientWidth:1000,attrs:{},events:{},replaceChildren(...items){this.children=items},setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]??null},removeAttribute(k){delete this.attrs[k]},addEventListener(k,fn){(this.events[k]??=[]).push(fn)},removeEventListener(k,fn){this.events[k]=(this.events[k]||[]).filter(f=>f!==fn)},click(){this.onclick?.()},closest(){return null}});return elements.get(id)}
 const v=element('video');Object.assign(v,{currentTime:0,duration:100,readyState:4,paused:true,play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true},load(){}});v.attrs.src='test.mp4';
 element('initial').textContent=JSON.stringify(p);element('offsetSeconds').value='0';element('offsetScope').value='all';element('fineStep').value='0.1';element('importOrder').value='auto';
 const context={document:{getElementById:element,createElement:()=>element('created-'+Math.random()),addEventListener(k,fn){events[k]=fn}},indexedDB:fakeDB(dbData),localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]},console,URL,Blob,setTimeout,crypto:require('crypto').webcrypto};vm.createContext(context);vm.runInContext(source,context);
 return{el:element,v,events,storage,dbData,run:s=>vm.runInContext(s,context),ready:context.ready||vm.runInContext('ready',context)};
}
const sample={version:1,revision:1,editor_id:'test-a',title:'A',colors:{Unknown:'#455a64'},rows:[{id:'a',start:10,end:12,zh:'你好',en:'Hello.',speaker:'Unknown',status:'疑点待听校',note:''},{id:'b',start:14,end:16,zh:'下一句',en:'Next.',speaker:'Unknown',status:'疑点待听校',note:''}]};
(async()=>{
 const a=setup(sample);await a.ready;
 a.v.currentTime=10.123;a.el('setStart').click();assert.equal(a.run('project.rows[0].start'),10.123);a.el('startMinus').click();assert.equal(a.run('project.rows[0].start'),10.023);a.el('undo').click();assert.equal(a.run('project.rows[0].start'),10.123);a.el('undo').click();assert.equal(a.run('project.rows[0].start'),10);
 a.v.currentTime=13;a.el('setEnd').click();assert.equal(a.run('project.rows[0].end'),13);a.el('undo').click();
 a.v.currentTime=20;a.el('setStart').click();assert.equal(a.run('project.rows[0].start'),20);assert.equal(a.run('project.rows[0].end'),22);a.el('undo').click();
 a.el('offsetSeconds').value='-11';a.el('applyOffset').click();assert.equal(a.run('project.rows[0].start'),10);a.el('offsetSeconds').value='1.25';a.el('applyOffset').click();assert.equal(a.run('project.rows[1].start'),15.25);assert.equal(a.run('project.rows[0].end-project.rows[0].start'),2);a.el('undo').click();assert.equal(a.run('project.rows[1].start'),14);
 a.el('offsetScope').value='following';a.run('go(1)');a.el('offsetSeconds').value='-0.5';a.el('applyOffset').click();assert.equal(a.run('project.rows[0].start'),10);assert.equal(a.run('project.rows[1].start'),13.5);a.el('undo').click();
 a.run('go(0)');a.v.currentTime=11.2;a.el('alignOffset').click();assert.equal(Number(a.el('offsetSeconds').value),1.2);assert.equal(a.run('project.rows[0].start'),10);
 a.el('listenEnd').click();assert.equal(a.v.currentTime,11);assert(!a.v.paused);a.v.currentTime=12.55;a.v.ontimeupdate();assert(a.v.paused);assert.equal(a.v.currentTime,12.5);
 a.v.currentTime=7;a.el('forward5').click();assert.equal(a.v.currentTime,12);a.el('backFine').click();assert.equal(a.v.currentTime,11.9);
 const key=(key,target=a.v,extra={})=>a.events.keydown({key,code:key===' '?'Space':key,target,preventDefault(){this.defaultPrevented=true},...extra});key('ArrowRight',a.v,{shiftKey:true});assert.equal(a.v.currentTime,12);key('ArrowRight',{closest:()=>({})});assert.equal(a.v.currentTime,12);
 a.el('zhEdit').value='我的修订';a.run("commit('zhEdit')");const savedId=a.run('project.editor_id');assert.equal(a.run('project.rows[0].zh'),'我的修订');
 const english='1\n00:00:01,000 --> 00:00:02,000\nEnglish only.\n\n2\n00:00:03,000 --> 00:00:04,000\n中文字幕\nEnglish line.\n';const parsed=a.run(`parseSRT(${JSON.stringify(english)})`);assert.equal(parsed[0].en,'English only.');assert.equal(parsed[0].zh,'');assert.equal(parsed[1].zh,'中文字幕');
 await a.run(`importFile({name:'Other.srt',text:async()=>${JSON.stringify(english)}})`);const otherId=a.run('project.editor_id');assert.notEqual(otherId,savedId);assert.equal(a.run('rows().length'),2);assert(a.run('buildSRT(rows())').includes('English only.'));
 a.el('zhEdit').value='英文单语的翻译';a.run("commit('zhEdit')");await a.run(`activateProject(bases.get(${JSON.stringify(savedId)}))`);assert.equal(a.run('project.rows[0].zh'),'我的修订');await a.run(`activateProject(bases.get(${JSON.stringify(otherId)}))`);assert.equal(a.run('project.rows[0].zh'),'英文单语的翻译');
 const b=setup({version:1,revision:1,editor_id:'generic-blank',title:'空白',colors:{Unknown:'#455a64'},rows:[]},a.storage,a.dbData);await b.ready;assert.equal(b.run('project.editor_id'),otherId);assert.equal(b.run('project.rows[0].zh'),'英文单语的翻译');
 const ass=a.run('buildASS(rows())'),roundtrip=a.run(`parseASS(${JSON.stringify(ass)})`);assert.equal(roundtrip.rows.length,2);assert.equal(roundtrip.rows[0].en,'English only.');assert.equal(roundtrip.rows[0].zh,'英文单语的翻译');
 await a.run("importFile({name:'Different.json',text:async()=>JSON.stringify({version:1,editor_id:'different-video',video:'OTHER_VIDEO',title:'另一个视频',rows:[{id:'new',start:1,end:2,zh:'',en:'No restriction.'}],colors:{}})})");assert.equal(a.run('project.video'),'OTHER_VIDEO');
 console.log('通过：毫秒标记、边界微调与撤销、批量范围/时长保持/越界拒绝、偏移预览、试听自动停止、快进和输入保护、单语/双语 SRT 与 ASS、跨视频 JSON、工程隔离和刷新恢复。');
})().catch(e=>{console.error(e);process.exitCode=1});

const html=fs.readFileSync(require('path').join(__dirname,'index.html'),'utf8');
const seed=JSON.parse(html.match(/<script id="initial" type="application\/json">([\s\S]*?)<\/script>/)[1]);
assert.equal(seed.rows.length,0);
assert.equal(seed.editor_id,'generic-blank');
assert(!/<video[^>]*\ssrc=/.test(html));
assert(!/<script[^>]*\ssrc=/.test(html));
assert(!html.includes('__PROJECT__'));
assert(!html.includes('__SCRIPT__'));
console.log('通过：静态首页为空白工程，无内置片源或字幕，无外部脚本。');
