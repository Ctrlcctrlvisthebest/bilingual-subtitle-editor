import {timingSafeEqual} from 'node:crypto';
import {Problem, object, text, type Obj} from './model';
import {MAX_REQUEST_BYTES} from './limits';
export {SubtitleGroup} from './group';

const encoder = new TextEncoder();
async function hash(v: string): Promise<string> {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(v)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function token(): string {return [...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function signature(id: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(id)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
function equal(a: string, b: string): boolean {const x=encoder.encode(a),y=encoder.encode(b);return x.length===y.length&&timingSafeEqual(x,y);}
async function body(request: Request): Promise<Obj> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Problem(415,'请使用 JSON 请求');
  if (Number(request.headers.get('Content-Length') || 0)>MAX_REQUEST_BYTES) throw new Problem(413,'请求数据超过 16 MB');
  const reader=request.body?.getReader();if(!reader)throw new Problem(400,'缺少请求内容');
  const chunks:Uint8Array[]=[];let length=0;
  try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>MAX_REQUEST_BYTES){await reader.cancel();throw new Problem(413,'请求数据超过 16 MB');}chunks.push(part.value);}} finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length;}
  try {return object(JSON.parse(new TextDecoder().decode(bytes)));} catch(e){if(e instanceof Problem)throw e;throw new Problem(400,'JSON 无法解析');}
}
function response(value: Obj, status=200, origin=''): Response {
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin'});
  if(origin){headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');headers.set('Access-Control-Allow-Methods','GET, POST, PATCH, OPTIONS');}
  return Response.json(value,{status,headers});
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    const origin=request.headers.get('Origin')||'',allowed=new Set([url.origin,...env.ALLOWED_ORIGINS.split(',').map(v=>v.trim())]);
    if(origin&&!allowed.has(origin))return response({error:'这个网站未获准连接协作后端'},403);
    if(request.method==='OPTIONS')return response({ok:true},200,origin);
    try {
      if(url.pathname==='/api/health'&&request.method==='GET')return response({ok:true,collaboration:true},200,origin);
      if(!env.GROUP_SIGNING_KEY)throw new Problem(503,'字幕组服务尚未配置完成');
      if(url.pathname==='/api/groups'&&request.method==='POST') {
        // Group creation is self-service. Credentials returned below only grant access to this group.
        // Cloudflare supplies CF-Connecting-IP; do not trust a client-chosen nickname or forwarding header.
        if(!env.CREATE_LIMIT||typeof env.CREATE_LIMIT.limit!=='function')throw new Problem(503,'暂时无法创建字幕组，请稍后重试');
        const data=await body(request);
        text(data.name,'字幕组名称',100);text(data.memberName,'成员名称',80);
        const {success}=await env.CREATE_LIMIT.limit({key:'subtitle-create:'+await hash(request.headers.get('CF-Connecting-IP')||'unknown')});
        if(!success)throw new Problem(429,'创建字幕组太频繁，每分钟最多创建 3 个，请稍后重试');
        const id=crypto.randomUUID(),groupId=id+'.'+await signature(id,env.GROUP_SIGNING_KEY),raw=token();
        const result=await env.SUBTITLE_GROUPS.getByName(groupId).dispatch('init',await hash(raw),JSON.stringify(data));
        return response({...object(JSON.parse(result.json)),groupId,token:raw},result.status,origin);
      }
      const match=url.pathname.match(/^\/api\/groups\/([\w.-]{50,120})(?:\/(.*))?$/);
      if(!match)throw new Problem(404,'接口不存在');
      const [,groupId,route='']=match,[uuid,sig]=groupId.split('.');
      if(!/^[a-f0-9-]{36}$/.test(uuid)||!sig||!equal(sig,await signature(uuid,env.GROUP_SIGNING_KEY)))throw new Problem(404,'字幕组不存在');
      const stub=env.SUBTITLE_GROUPS.getByName(groupId);
      let data:Obj={},op='',pid='',raw='';
      if(request.method!=='GET')data=await body(request);
      if(route==='join'&&request.method==='POST') {
        raw=token();data={name:data.name??'',inviteHash:await hash(text(data.code,'邀请码',100))};op='join';
      } else {
        raw=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]||'';
        if(!raw)throw new Problem(401,'请先创建或加入字幕组');
        if(!route&&request.method==='GET')op='group';
        else if(route==='presence'&&request.method==='POST')op='presence';
        else if(route==='invites'&&request.method==='POST'){op='invite';const code=token();data.inviteHash=await hash(code);data.code=code;}
        else if(route==='invites/reset'&&request.method==='POST')op='resetInvites';
        else if(route==='members'&&request.method==='PATCH')op='member';
        else if(route==='projects'&&request.method==='POST')op='createProject';
        else {
          const p=route.match(/^projects\/([a-f0-9-]{36})(?:\/(history))?$/);
          if(!p)throw new Problem(404,'接口不存在');pid=p[1];
          if(p[2]==='history'&&request.method==='GET'){op='history';data={rowId:url.searchParams.get('row')||''};}
          else if(!p[2]&&request.method==='GET'){op='getProject';data={since:Number(url.searchParams.get('since')||0)};}
          else if(!p[2]&&request.method==='PATCH')op='patch';
          else throw new Problem(405,'请求方法无效');
        }
      }
      const result=await stub.dispatch(op,await hash(raw),JSON.stringify(data),pid,op==='join'?await hash(request.headers.get('CF-Connecting-IP')||'local'):''),value=object(JSON.parse(result.json));
      if(result.status<300&&op==='join')value.token=raw;
      if(result.status<300&&op==='invite')value.code=data.code;
      return response(value,result.status,origin);
    } catch(e) {
      if(e instanceof Problem)return response({error:e.message,...e.details},e.status,origin);
      console.error(JSON.stringify({event:'api_error'}));
      return response({error:'协作服务暂时不可用，请稍后重试'},500,origin);
    }
  }
} satisfies ExportedHandler<Env>;
