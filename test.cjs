const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'editor.js'),'utf8')+'\n'+fs.readFileSync(require('path').join(__dirname,'video-export.js'),'utf8');
function fakeDB(data=new Map()){
 const db={createObjectStore(){},transaction(){const tx={objectStore(){return{put(p){data.set(p.editor_id,JSON.parse(JSON.stringify(p)));queueMicrotask(()=>tx.oncomplete?.())},get(id){const r={};queueMicrotask(()=>{r.result=data.get(id);r.onsuccess?.()});return r}}}};return tx}};
 return{open(){const r={result:db};queueMicrotask(()=>r.onsuccess?.());return r}};
}
function setup(p,storage={},dbData=new Map()){
 const elements=new Map(),events={};
 function element(id){if(!elements.has(id))elements.set(id,{value:'',style:{},textContent:'',checked:false,selectionStart:0,clientWidth:1000,attrs:{},events:{},replaceChildren(...items){this.children=items},setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]??null},removeAttribute(k){delete this.attrs[k]},addEventListener(k,fn){(this.events[k]??=[]).push(fn)},removeEventListener(k,fn){this.events[k]=(this.events[k]||[]).filter(f=>f!==fn)},click(){this.onclick?.()},closest(){return null}});return elements.get(id)}
 const v=element('video');Object.assign(v,{currentTime:0,duration:100,readyState:4,paused:true,play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true},load(){}});v.attrs.src='test.mp4';
 element('initial').textContent=JSON.stringify(p);element('offsetSeconds').value='0';element('offsetScope').value='all';element('fineStep').value='0.1';element('importOrder').value='auto';
 element('videoExportRange').value='all';element('videoExportMode').value='local';
 const context={document:{getElementById:element,createElement:()=>element('created-'+Math.random()),addEventListener(k,fn){events[k]=fn}},indexedDB:fakeDB(dbData),localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]},console,URL,Blob,TextEncoder,setTimeout,crypto:require('crypto').webcrypto};vm.createContext(context);vm.runInContext(source,context);
 return{el:element,v,events,storage,dbData,run:s=>vm.runInContext(s,context),ready:context.ready||vm.runInContext('ready',context)};
}
const sample={version:1,revision:1,editor_id:'test-a',title:'A',colors:{Unknown:'#455a64'},rows:[{id:'a',start:10,end:12,zh:'你好',en:'Hello.',speaker:'Unknown',status:'疑点待听校',note:''},{id:'b',start:14,end:16,zh:'下一句',en:'Next.',speaker:'Unknown',status:'疑点待听校',note:''}]};
(async()=>{
 const a=setup(sample);await a.ready;
 const beforeExport=a.run('JSON.stringify(project)');
 a.el('videoExportRange').value='clip';a.el('videoExportStart').value='11';a.el('videoExportEnd').value='15';
 const exportFiles=a.run('exportPackageFiles(rows(),exportRange(),true)');
 const clippedASS=exportFiles.find(f=>f.name==='captions.ass').text;
 assert(clippedASS.includes('0:00:00.00,0:00:01.00'));assert(clippedASS.includes('0:00:03.00,0:00:04.00'));
 assert.equal(a.run('JSON.stringify(project)'),beforeExport);
 assert.equal(JSON.parse(exportFiles.find(f=>f.name==='project.json').text).rows[0].start,10);
 const script=exportFiles.find(f=>f.name==='export-mac.command').text;
 assert(script.includes('seek_args=(-ss 11)'));assert(script.includes('duration_args=(-t 4.000)'));assert(script.includes("-map '0:a:0?' -sn -dn"));assert(script.includes('-n'));assert(script.includes('h264_videotoolbox'));
 const zip=Buffer.from(await a.run('buildExportZip(exportPackageFiles(rows(),exportRange(),true)).arrayBuffer()'));
 let zipPos=0,zipCount=0;
 while(zip.readUInt32LE(zipPos)===0x04034b50){const size=zip.readUInt32LE(zipPos+18),length=zip.readUInt16LE(zipPos+26),name=zip.subarray(zipPos+30,zipPos+30+length).toString(),data=zip.subarray(zipPos+30+length,zipPos+30+length+size);assert.equal(a.run('zipCRC32(new TextEncoder().encode('+JSON.stringify(data.toString())+'))'),zip.readUInt32LE(zipPos+14));assert.equal(data.toString(),exportFiles.find(f=>f.name===name).text);zipPos+=30+length+size;zipCount++}
 assert.equal(zipCount,6);assert.equal(zip.readUInt32LE(zipPos),0x02014b50);
 assert.throws(()=>a.run('exportPackageFiles(rows(),{start:40,end:41},false)'),/没有字幕/);
 a.el('videoExportStart').value='NaN';assert.throws(()=>a.run('exportRange()'));a.el('videoExportStart').value='15';assert.throws(()=>a.run('exportRange()'));
 a.el('videoExportRange').value='all';assert.equal(a.run('clipExportRows(rows(),exportRange())[0].start'),10);
 await assert.rejects(a.run('recordVideoExport(rows(),exportRange())'),/不支持/);
 assert.equal(a.run('project.appearance.mode'),'outline');
 assert.equal(a.el('sub').style.background,'transparent');
 assert.equal(a.el('sub').style.color,'#ffffff');
 assert(a.el('zh').style.webkitTextStroke.includes('#455a64'));
 const captionBeforeStyle=a.run('JSON.stringify(project.rows)');
 a.el('subtitleOrder').value='en-first';a.el('outlineWidth').value='4';a.run('changeAppearance()');
 assert.equal(a.run('JSON.stringify(project.rows)'),captionBeforeStyle);
 assert.equal(a.el('en').style.order,'0');
 assert(a.run('buildSRT(rows())').includes('Hello.\n你好'));
 const outlineASS=a.run('buildASS(rows())');
 const style=outlineASS.split('\n').find(line=>line.startsWith('Style: Unknown,')).slice(7).split(',');
 assert.equal(style[3],'&H00FFFFFF');assert.equal(style[5],'&H00645a45');assert.equal(style[7],'-1');assert.equal(style[15],'1');assert.equal(style[16],'4');
 const importedStyle=a.run(`parseASS(${JSON.stringify(outlineASS)})`);
 assert.equal(importedStyle.appearance.order,'en-first');assert.equal(importedStyle.appearance.outlineWidth,4);assert.equal(importedStyle.colors.Unknown,'#455a64');
 const restoredStyle=setup(sample,a.storage,a.dbData);await restoredStyle.ready;assert.equal(restoredStyle.run('project.appearance.outlineWidth'),4);
 a.el('subtitleMode').value='box';a.run('changeAppearance()');assert.equal(a.el('sub').style.background,'#455a64');assert(a.run('buildASS(rows())').includes(',3,10,0,2,80,80,60,1'));
 a.el('undo').click();assert.equal(a.run('project.appearance.mode'),'outline');a.el('undo').click();assert.equal(a.run('project.appearance.order'),'zh-first');
 a.v.currentTime=10.123;a.el('setStart').click();assert.equal(a.run('project.rows[0].start'),10.123);a.el('startMinus').click();assert.equal(a.run('project.rows[0].start'),10.023);a.el('undo').click();assert.equal(a.run('project.rows[0].start'),10.123);a.el('undo').click();assert.equal(a.run('project.rows[0].start'),10);
 a.v.currentTime=13;a.el('setEnd').click();assert.equal(a.run('project.rows[0].end'),13);a.el('undo').click();
 a.v.currentTime=20;a.el('setStart').click();assert.equal(a.run('project.rows[0].start'),20);assert.equal(a.run('project.rows[0].end'),22);a.el('undo').click();
 a.el('offsetSeconds').value='-11';a.el('applyOffset').click();assert.equal(a.run('project.rows[0].start'),10);a.el('offsetSeconds').value='1.25';a.el('applyOffset').click();assert.equal(a.run('project.rows[1].start'),15.25);assert.equal(a.run('project.rows[0].end-project.rows[0].start'),2);a.el('undo').click();assert.equal(a.run('project.rows[1].start'),14);
 a.el('offsetScope').value='following';a.run('go(1)');a.el('offsetSeconds').value='-0.5';a.el('applyOffset').click();assert.equal(a.run('project.rows[0].start'),10);assert.equal(a.run('project.rows[1].start'),13.5);a.el('undo').click();
 a.run('go(0)');a.v.currentTime=11.2;a.el('alignOffset').click();assert.equal(Number(a.el('offsetSeconds').value),1.2);assert.equal(a.run('project.rows[0].start'),10);
 a.el('listenEnd').click();assert.equal(a.v.currentTime,11);assert(!a.v.paused);a.v.currentTime=12.55;a.v.ontimeupdate();assert(a.v.paused);assert.equal(a.v.currentTime,12.5);
 a.v.currentTime=7;a.el('forward5').click();assert.equal(a.v.currentTime,12);a.el('backFine').click();assert.equal(a.v.currentTime,11.9);
 const key=(key,target=a.v,extra={})=>a.events.keydown({key,code:key===' '?'Space':key,target,preventDefault(){this.defaultPrevented=true},...extra});key('ArrowRight',a.v,{shiftKey:true});assert.equal(a.v.currentTime,12);key('ArrowRight',{closest:()=>({})});assert.equal(a.v.currentTime,12);
 a.el('videoExportDialog').open=true;key('ArrowRight');assert.equal(a.v.currentTime,12);a.el('videoExportDialog').open=false;
 a.el('zhEdit').value='我的修订';a.run("commit('zhEdit')");const savedId=a.run('project.editor_id');assert.equal(a.run('project.rows[0].zh'),'我的修订');
 const english='1\n00:00:01,000 --> 00:00:02,000\nEnglish only.\n\n2\n00:00:03,000 --> 00:00:04,000\n中文字幕\nEnglish line.\n';const parsed=a.run(`parseSRT(${JSON.stringify(english)})`);assert.equal(parsed[0].en,'English only.');assert.equal(parsed[0].zh,'');assert.equal(parsed[1].zh,'中文字幕');
 await a.run(`importFile({name:'Other.srt',text:async()=>${JSON.stringify(english)}})`);const otherId=a.run('project.editor_id');assert.notEqual(otherId,savedId);assert.equal(a.run('rows().length'),2);assert(a.run('buildSRT(rows())').includes('English only.'));
 a.el('zhEdit').value='英文单语的翻译';a.run("commit('zhEdit')");await a.run(`activateProject(bases.get(${JSON.stringify(savedId)}))`);assert.equal(a.run('project.rows[0].zh'),'我的修订');await a.run(`activateProject(bases.get(${JSON.stringify(otherId)}))`);assert.equal(a.run('project.rows[0].zh'),'英文单语的翻译');
 const b=setup({version:1,revision:1,editor_id:'generic-blank',title:'空白',colors:{Unknown:'#455a64'},rows:[]},a.storage,a.dbData);await b.ready;assert.equal(b.run('project.editor_id'),otherId);assert.equal(b.run('project.rows[0].zh'),'英文单语的翻译');
 const ass=a.run('buildASS(rows())'),roundtrip=a.run(`parseASS(${JSON.stringify(ass)})`);assert.equal(roundtrip.rows.length,2);assert.equal(roundtrip.rows[0].en,'English only.');assert.equal(roundtrip.rows[0].zh,'英文单语的翻译');
 await a.run(`importFile({name:'Style-roundtrip.ass',text:async()=>${JSON.stringify(outlineASS)}})`);assert.equal(a.run('project.title'),'Style-roundtrip');assert.equal(a.run('project.appearance.order'),'en-first');assert.equal(a.run('project.appearance.outlineWidth'),4);
 await a.run("importFile({name:'Different.json',text:async()=>JSON.stringify({version:1,editor_id:'different-video',video:'OTHER_VIDEO',title:'另一个视频',rows:[{id:'new',start:1,end:2,zh:'',en:'No restriction.'}],colors:{}})})");assert.equal(a.run('project.video'),'OTHER_VIDEO');
 console.log('通过：视频导出 ZIP / CRC、片段时间归零、全量工程保留、无音轨与旧字幕轨映射、无覆盖脚本、异常区间；彩色描边 / 色框、样式往返；时间校准、撤销、单语 / 双语导出、工程隔离和刷新恢复。');
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
