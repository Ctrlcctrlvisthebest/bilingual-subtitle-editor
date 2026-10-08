import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

async function localRuntime(t,{port=8857,signingKey='isolated-test-signing-key',rateLimit=true}={}) {
 const cwd=fileURLToPath(new URL('../../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'subtitle-collab-test-'));
 const config=JSON.parse(await readFile(join(cwd,'wrangler.jsonc'),'utf8'));
 config.main=join(cwd,config.main);config.assets.directory=join(cwd,config.assets.directory);
 if(!rateLimit)delete config.ratelimits;
 // Test configuration never loads the workspace's local or production secrets.
 const configPath=join(dir,'wrangler.jsonc');await writeFile(configPath,JSON.stringify(config));
 await writeFile(join(dir,'.dev.vars'),'GROUP_SIGNING_KEY='+signingKey+'\n');
 const child=spawn(process.execPath,[join(cwd,'node_modules/wrangler/bin/wrangler.js'),'dev','--config',configPath,'--local','--port',String(port),'--inspector-port','0','--persist-to',join(dir,'state')],{cwd:dir,env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(dir,'logs')},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
 t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+port;let started=false;
 for(let n=0;n<100;n++){try{const r=await fetch(origin+'/api/health');if(r.ok){started=true;break;}}catch{}if(child.exitCode!==null)break;await delay(200);}
 assert(started,'Wrangler did not start:\n'+logs);
 const api=async(path,method='GET',data,token,expected=200,headers={})=>{const r=await fetch(origin+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});const json=await r.json();assert.equal(r.status,expected,JSON.stringify(json));return json;};
 return {api,origin};
}

test('Cloudflare runtime: self-service groups, scoped credentials, invitation, concurrent edits and durable history', {timeout:60000}, async t=>{
 const {api,origin}=await localRuntime(t);
 await api('groups','POST',{name:'测试组',memberName:''},undefined,400);
 const owner=await api('groups','POST',{name:'测试组',memberName:'组主'},undefined,201),g='groups/'+owner.groupId;
 assert.match(owner.groupId,/^[a-f0-9-]{36}\.[a-f0-9]{64}$/);assert.match(owner.token,/^[a-f0-9]{64}$/);assert.equal(owner.member.role,'owner');
 // Existing member-backup fields still authenticate without a global creation key.
 const backup=JSON.parse(JSON.stringify({format:'subtitle-group-member-v1',server:origin,groupId:owner.groupId,token:owner.token,member:owner.member,groupName:owner.groupName}));
 assert.equal((await api('groups/'+backup.groupId,'GET',undefined,backup.token)).member.id,owner.member.id);
 const other=await api('groups','POST',{name:'其他组',memberName:'另一组长',createKey:'ignored-legacy-client-key'},undefined,201,{'CF-Connecting-IP':'192.0.2.21'});
 await api('groups/'+other.groupId,'GET',undefined,owner.token,401);await api(g,'GET',undefined,other.token,401);
 assert(!JSON.stringify(await api(g,'GET',undefined,owner.token)).includes(owner.token));
 await api(g,'GET',undefined,undefined,401);await api('groups/'+owner.groupId.slice(0,-1)+'z','GET',undefined,owner.token,404);
 await api(g,'GET',undefined,owner.token,403,{Origin:'https://evil.example'});
 const inv=await api(g+'/invites','POST',{role:'editor',uses:1,days:7},owner.token,201);
 const editor=await api(g+'/join','POST',{name:'校对员',code:inv.code},undefined,201);
 await api(g+'/join','POST',{name:'不能重用',code:inv.code},undefined,403);
 const readInv=await api(g+'/invites','POST',{role:'viewer',uses:1,days:7},owner.token,201),viewer=await api(g+'/join','POST',{name:'只读成员',code:readInv.code},undefined,201);
 const project={version:1,editor_id:'local',title:'测试字幕',colors:{Unknown:'#455a64'},rows:[{id:'a',start:0,end:1,zh:'第一句',en:'First',speaker:'Unknown',status:'疑点待听校',note:''},{id:'b',start:2,end:3,zh:'第二句',en:'Second',speaker:'Unknown',status:'疑点待听校',note:''}]};
 await api(g+'/projects','POST',{project},viewer.token,403);
 const created=await api(g+'/projects','POST',{project},owner.token,201),path=g+'/projects/'+created.id;
 await api(path,'PATCH',{changes:[{id:'a',expected:1,row:{...project.rows[0],zh:'不允许'}}]},viewer.token,403);
 const [one,two]=await Promise.all([
  api(path,'PATCH',{changes:[{id:'a',expected:1,row:{...project.rows[0],zh:'组主修订'}}]},owner.token),
  api(path,'PATCH',{changes:[{id:'b',expected:1,row:{...project.rows[1],en:'Member revision'}}]},editor.token)
 ]);
 const latest=await api(path,'GET',undefined,viewer.token);assert.equal(latest.project.rows[0].zh,'组主修订');assert.equal(latest.project.rows[1].en,'Member revision');assert.equal(latest.revision,3);
 const conflict=await api(path,'PATCH',{changes:[{id:'a',expected:1,row:{...project.rows[0],zh:'旧版本试图覆盖'}}]},editor.token,409);assert.equal(conflict.snapshot.project.rows[0].zh,'组主修订');
 const atomicConflict=await api(path,'PATCH',{changes:[{id:'a',expected:1,row:project.rows[0]},{id:'b',expected:2,row:{...project.rows[1],zh:'不该写入'}}]},editor.token,409);assert.equal(atomicConflict.snapshot.project.rows[1].zh,'第二句');
 const events=await api(path+'/history?row=a','GET',undefined,owner.token);assert.equal(events.events[0].actor,'组主');assert.equal(events.events[0].before.zh,'第一句');
 await api(path+'?since=3','GET',undefined,owner.token).then(v=>assert.equal(v.unchanged,true));
 await api(path,'PATCH',{changes:[{id:'a',expected:2,row:null}]},owner.token,400);
 const removed=await api(path,'PATCH',{changes:[{id:'a',expected:2,row:null}],order:{expected:1,ids:['b']}},owner.token);assert.equal(removed.rowVersions.a,3);
 await api(path,'PATCH',{changes:[{id:'a',expected:0,row:project.rows[0]}],order:{expected:2,ids:['a','b']}},editor.token,409);
 const recovered=await api(path,'PATCH',{changes:[{id:'a',expected:3,row:project.rows[0]}],order:{expected:2,ids:['a','b']}},owner.token);assert.equal(recovered.project.rows.length,2);
 await api(g+'/presence','POST',{projectId:created.id,rowId:'b'},editor.token);const group=await api(g,'GET',undefined,owner.token);assert.equal(group.members.find(m=>m.id===editor.member.id).row_id,'b');assert(!JSON.stringify(group).includes(editor.token));
 await api(g+'/members','PATCH',{id:owner.member.id,role:'removed'},owner.token,400);
 await api(g+'/members','PATCH',{id:editor.member.id,role:'removed'},owner.token);await api(g,'GET',undefined,editor.token,401);
 await api(g+'/invites','POST',{role:'owner',uses:1,days:7},owner.token,400);
 const waiting=await api(g+'/invites','POST',{role:'editor',uses:1,days:7},owner.token,201);await api(g+'/invites/reset','POST',{},owner.token);await api(g+'/join','POST',{name:'无效邀请',code:waiting.code},undefined,403);
 const large=structuredClone(project);large.title='四小时字幕容量检查';large.rows=Array.from({length:4200},(_,i)=>({...project.rows[0],id:'row-'+i,start:i*3,end:i*3+2,note:'参考转写 '.repeat(120)}));
 const long=await api(g+'/projects','POST',{project:large},owner.token,201);assert.equal(long.project.rows.length,4200);assert.equal((await api(g+'/projects/'+long.id,'GET',undefined,owner.token)).project.rows[4199].id,'row-4199');
 const asset=await fetch(origin+'/');assert.equal(asset.status,200);assert((await asset.text()).includes('字幕组 · 多人在线校对'));
 console.log('后端实测通过：自助建组、旧成员备份、跨组凭证隔离、两个成员并发、冲突无覆盖、权限、邀请撤销、历史记录、4200 条工程。');
});

test('Cloudflare runtime: per-IP creation rate limit and missing configuration fail closed', {timeout:60000}, async t=>{
 const {api}=await localRuntime(t,{port:8858});
 const limitHeaders={'CF-Connecting-IP':'192.0.2.50'};
 for(let n=0;n<3;n++)await api('groups','POST',{name:'限流测试 '+n,memberName:'组主'},undefined,201,limitHeaders);
 await api('groups','POST',{name:'第四次应被拦截',memberName:'组主'},undefined,429,limitHeaders);
 await api('groups','POST',{name:'独立 IP 仍可建组',memberName:'组主'},undefined,201,{'CF-Connecting-IP':'192.0.2.51'});
 const missingSigning=await localRuntime(t,{port:8859,signingKey:''});
 await missingSigning.api('groups','POST',{name:'不可创建',memberName:'组主'},undefined,503);
 const missingLimiter=await localRuntime(t,{port:8860,rateLimit:false});
 await missingLimiter.api('groups','POST',{name:'不可无上限创建',memberName:'组主'},undefined,503);
 console.log('建组保护实测通过：每 IP 每分钟 3 次、不同 IP 独立计数、缺签名密钥与缺限流 binding 都拒绝创建。');
});
