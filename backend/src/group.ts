import {DurableObject} from 'cloudflare:workers';
import {Problem, checkedMeta, checkedProject, checkedProjectSize, checkedRow, integer, object, text, type Obj, type Result, type Role} from './model';

type Member = {id: string; name: string; role: Role; active: number; last_seen: number; project_id: string; row_id: string};
type StoredProject = {id: string; meta: string; meta_version: number; order_ids: string; order_version: number; revision: number; updated_at: number; updated_by: string};
type StoredRow = {id: string; data: string | null; version: number};

export class SubtitleGroup extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS group_info (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1, last_seen INTEGER NOT NULL DEFAULT 0, project_id TEXT NOT NULL DEFAULT '', row_id TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, uses INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, meta TEXT NOT NULL, meta_version INTEGER NOT NULL, order_ids TEXT NOT NULL, order_version INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rows (project_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT, version INTEGER NOT NULL, PRIMARY KEY(project_id,id));
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, row_id TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, before_data TEXT, after_data TEXT);
        CREATE INDEX IF NOT EXISTS events_project ON events(project_id,seq);
        CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, n INTEGER NOT NULL);
      `);
    });
  }
  private member(hash: string): Member {
    const m = this.ctx.storage.sql.exec<Member>('SELECT id,name,role,active,last_seen,project_id,row_id FROM members WHERE token_hash=? AND active=1', hash).toArray()[0];
    if (!m) throw new Problem(401, '成员凭证无效或已被移出字幕组');
    return m;
  }
  private owner(m: Member): void {if (m.role !== 'owner') throw new Problem(403, '只有组主可以管理成员与邀请');}
  private editable(m: Member): void {if (m.role === 'viewer') throw new Problem(403, '你是只读成员，不能修改共享工程');}
  private rate(key: string, max: number): void {
    const bucket = Math.floor(Date.now() / 60000);
    this.ctx.storage.sql.exec('INSERT INTO attempts(key,bucket,n) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET n=CASE WHEN bucket=excluded.bucket THEN n+1 ELSE 1 END,bucket=excluded.bucket', key, bucket);
    const n = this.ctx.storage.sql.exec<{n:number}>('SELECT n FROM attempts WHERE key=?', key).one().n;
    if (n > max) throw new Problem(429, '操作太频繁，请稍后再试');
    this.ctx.storage.sql.exec('DELETE FROM attempts WHERE bucket<?', bucket - 2);
  }
  private project(id: string): StoredProject {
    const p = this.ctx.storage.sql.exec<StoredProject>('SELECT * FROM projects WHERE id=?', id).toArray()[0];
    if (!p) throw new Problem(404, '共享工程不存在');
    return p;
  }
  private snapshot(id: string): Obj {
    const p = this.project(id), stored = this.ctx.storage.sql.exec<StoredRow>('SELECT id,data,version FROM rows WHERE project_id=?', id).toArray();
    const rows = new Map(stored.filter(r => r.data !== null).map(r => [r.id, JSON.parse(r.data!)]));
    const versions = Object.fromEntries(stored.map(r => [r.id, r.version]));
    return {project: {...JSON.parse(p.meta), rows: (JSON.parse(p.order_ids) as string[]).map(rid => rows.get(rid))}, rowVersions: versions, metaVersion: p.meta_version, orderVersion: p.order_version, revision: p.revision};
  }
  private event(pid: string, rid: string, m: Member, before: string | null, after: string | null): void {
    this.ctx.storage.sql.exec('INSERT INTO events(project_id,row_id,actor,at,before_data,after_data) VALUES(?,?,?,?,?,?)', pid, rid, m.name, Date.now(), before, after);
  }
  private trimEvents(pid: string): void {
    this.ctx.storage.sql.exec('DELETE FROM events WHERE project_id=? AND seq NOT IN (SELECT seq FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 2000)', pid, pid);
  }
  // One object per group. All checks and writes below are synchronous SQL in a transaction.
  dispatch(op: string, hash: string, payload: string, pid = '', scope = ''): {status: number; json: string} {
    const result = this.command(op, hash, object(JSON.parse(payload)), pid, scope);
    return {status:result.status,json:JSON.stringify(result.body)};
  }
  private command(op: string, hash: string, input: Obj, pid = '', scope = ''): Result {
    try {
      if (op === 'init') {
        if (this.ctx.storage.sql.exec('SELECT id FROM group_info').toArray().length) throw new Problem(409, '字幕组已存在');
        const name = text(input.name, '字幕组名称', 100), memberName = text(input.memberName, '成员名称', 80), id = crypto.randomUUID();
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('INSERT INTO group_info(id,name) VALUES(1,?)', name);
          this.ctx.storage.sql.exec('INSERT INTO members(id,name,role,token_hash) VALUES(?,?,?,?)', id, memberName, 'owner', hash);
        });
        return {status:201, body:{groupName:name, member:{id,name:memberName,role:'owner'}}};
      }
      if (op === 'join') {
        this.rate('join:' + scope, 15);
        const inviteHash = text(input.inviteHash, '邀请凭证', 100), name = text(input.name, '成员名称', 80);
        const invite = this.ctx.storage.sql.exec<{role:Role; expires:number; uses:number}>('SELECT role,expires,uses FROM invites WHERE hash=?', inviteHash).toArray()[0];
        if (!invite || invite.expires < Date.now() || invite.uses < 1) throw new Problem(403, '邀请已失效、已用完或不存在');
        if (this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM members WHERE active=1').one().n >= 100) throw new Problem(400, '字幕组已达 100 名成员');
        if (this.ctx.storage.sql.exec('SELECT id FROM members WHERE name=? AND active=1', name).toArray().length) throw new Problem(409, '已有同名成员，请换一个昵称');
        const id = crypto.randomUUID();
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('UPDATE invites SET uses=uses-1 WHERE hash=?', inviteHash);
          this.ctx.storage.sql.exec('INSERT INTO members(id,name,role,token_hash) VALUES(?,?,?,?)', id, name, invite.role, hash);
        });
        return {status:201, body:{member:{id,name,role:invite.role}}};
      }
      const m = this.member(hash);
      this.rate(m.id, 120);
      if (op === 'group') {
        const groupName = this.ctx.storage.sql.exec<{name:string}>('SELECT name FROM group_info').one().name;
        const members = this.ctx.storage.sql.exec<Member>('SELECT id,name,role,active,last_seen,project_id,row_id FROM members WHERE active=1').toArray();
        const projects = this.ctx.storage.sql.exec<StoredProject>('SELECT * FROM projects ORDER BY updated_at DESC').toArray().map(p => ({id:p.id,title:JSON.parse(p.meta).title,revision:p.revision,count:(JSON.parse(p.order_ids) as string[]).length,updatedAt:p.updated_at,updatedBy:p.updated_by}));
        return {status:200, body:{groupName, member:object(m), members:members.map(object), projects}};
      }
      if (op === 'presence') {
        if (typeof input.projectId !== 'string' || input.projectId.length > 150 || typeof input.rowId !== 'string' || input.rowId.length > 150) {
          throw new Problem(400, '在线状态的工程或字幕编号格式无效');
        }
        this.ctx.storage.sql.exec('UPDATE members SET last_seen=?,project_id=?,row_id=? WHERE id=?', Date.now(), input.projectId, input.rowId, m.id);
        return {status:200, body:{ok:true}};
      }
      if (op === 'invite') {
        this.owner(m);
        if (input.role !== 'editor' && input.role !== 'viewer') throw new Problem(400, '邀请权限无效');
        const uses = integer(input.uses), days = integer(input.days);
        if (uses < 1 || uses > 50 || days < 1 || days > 30) throw new Problem(400, '邀请人数或有效期无效');
        this.ctx.storage.sql.exec('DELETE FROM invites WHERE expires<? OR uses<1', Date.now());
        if (this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM invites').one().n >= 20) throw new Problem(400, '有效邀请过多，请先重置邀请');
        this.ctx.storage.sql.exec('INSERT INTO invites(hash,role,expires,uses) VALUES(?,?,?,?)', text(input.inviteHash,'邀请凭证',100), input.role, Date.now()+days*86400000, uses);
        return {status:201, body:{ok:true}};
      }
      if (op === 'resetInvites') {this.owner(m);this.ctx.storage.sql.exec('DELETE FROM invites');return {status:200,body:{ok:true}};}
      if (op === 'member') {
        this.owner(m);
        const id = text(input.id,'成员编号',150);
        if (id === m.id) throw new Problem(400,'组主不能移除自己');
        if (!['editor','viewer','removed'].includes(String(input.role))) throw new Problem(400,'成员权限无效');
        this.ctx.storage.sql.exec('UPDATE members SET role=?,active=? WHERE id=? AND role<>?', input.role === 'removed' ? 'viewer' : input.role as string, input.role === 'removed' ? 0 : 1, id, 'owner');
        return {status:200,body:{ok:true}};
      }
      if (op === 'createProject') {
        this.editable(m);
        if (this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM projects').one().n >= 50) throw new Problem(400,'一个字幕组最多 50 个工程');
        const p = checkedProject(input.project), id = crypto.randomUUID(), {rows,...meta} = p;
        meta.editor_id = 'shared-'+id;
        checkedProjectSize(JSON.stringify(meta), rows.map(row => JSON.stringify(row)));
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('INSERT INTO projects VALUES(?,?,1,?,1,1,?,?)', id, JSON.stringify(meta), JSON.stringify(rows.map(r=>r.id)), Date.now(), m.name);
          for (const row of rows) this.ctx.storage.sql.exec('INSERT INTO rows VALUES(?,?,?,1)', id, row.id, JSON.stringify(row));
          this.event(id,'@import',m,null,JSON.stringify({title:meta.title,rows:rows.length}));
        });
        return {status:201,body:{id,...this.snapshot(id)}};
      }
      const p = this.project(pid);
      if (op === 'getProject') return {status:200,body:input.since === p.revision ? {unchanged:true,revision:p.revision} : this.snapshot(pid)};
      if (op === 'history') {
        const rowId = typeof input.rowId === 'string' ? input.rowId : '';
        const query = rowId ? 'SELECT * FROM events WHERE project_id=? AND row_id=? ORDER BY seq DESC LIMIT 30' : 'SELECT * FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 30';
        const events = this.ctx.storage.sql.exec<{seq:number; row_id:string; actor:string; at:number; before_data:string|null; after_data:string|null}>(query, ...rowId ? [pid,rowId] : [pid]).toArray().map(e=>({seq:e.seq,rowId:e.row_id,actor:e.actor,at:e.at,before:e.before_data?JSON.parse(e.before_data):null,after:e.after_data?JSON.parse(e.after_data):null}));
        return {status:200,body:{events}};
      }
      if (op !== 'patch') throw new Problem(404,'接口不存在');
      this.editable(m);
      if (!Array.isArray(input.changes) || input.changes.length > 20000) throw new Problem(400,'修改列表无效');
      const changes = input.changes.map(c => {
        const value = object(c), id = text(value.id,'字幕编号',150), expected = integer(value.expected);
        const row = value.row === null ? null : checkedRow(value.row);
        if (row && row.id !== id) throw new Problem(400,'字幕编号不一致');
        return {id,expected,row};
      });
      if (new Set(changes.map(c=>c.id)).size !== changes.length) throw new Problem(400,'重复的修改编号');
      const existing = this.ctx.storage.sql.exec<StoredRow>('SELECT id,data,version FROM rows WHERE project_id=?',pid).toArray(), before = new Map(existing.map(r=>[r.id,r]));
      const conflicts: Obj[] = [];
      for (const change of changes) if ((before.get(change.id)?.version ?? 0) !== change.expected) conflicts.push({kind:'row',id:change.id});
      let meta: Obj | null = null, order: string[] | null = null;
      if (input.meta !== undefined) {
        const v = object(input.meta);meta = checkedMeta(v.value);
        if (meta.editor_id !== JSON.parse(p.meta).editor_id) throw new Problem(400,'不能修改共享工程编号');
        if (integer(v.expected) !== p.meta_version) conflicts.push({kind:'meta'});
      }
      if (input.order !== undefined) {
        const v = object(input.order);
        if (!Array.isArray(v.ids) || v.ids.some(id=>typeof id !== 'string') || v.ids.length > 20000) throw new Problem(400,'字幕顺序无效');
        order = v.ids as string[];
        if (integer(v.expected) !== p.order_version) conflicts.push({kind:'order'});
      }
      if (conflicts.length) return {status:409,body:{error:'有成员修改了相同字幕，请先解决冲突',conflicts,snapshot:this.snapshot(pid)}};
      const resulting = new Map(existing.filter(r=>r.data!==null).map(r=>[r.id,r.data!]));
      for (const c of changes) {if (c.row) resulting.set(c.id,JSON.stringify(c.row));else resulting.delete(c.id);}
      const ids = order ?? JSON.parse(p.order_ids) as string[];
      if (ids.length !== resulting.size || new Set(ids).size !== ids.length || ids.some(id=>!resulting.has(id))) throw new Problem(400,'增删字幕时必须同步修改顺序');
      if (resulting.size > 20000) throw new Problem(400,'工程最多包含 20,000 条字幕');
      checkedProjectSize(meta ? JSON.stringify(meta) : p.meta, resulting.values());
      if (!changes.length && !meta && !order) return {status:200,body:this.snapshot(pid)};
      this.ctx.storage.transactionSync(() => {
        for (const c of changes) {
          const data = c.row ? JSON.stringify(c.row) : null;
          this.ctx.storage.sql.exec('INSERT INTO rows VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data,version=excluded.version',pid,c.id,data,(before.get(c.id)?.version??0)+1);
          this.event(pid,c.id,m,before.get(c.id)?.data??null,data);
        }
        if (meta) this.event(pid,'@meta',m,p.meta,JSON.stringify(meta));
        if (order) this.event(pid,'@order',m,p.order_ids,JSON.stringify(order));
        this.ctx.storage.sql.exec('UPDATE projects SET meta=?,meta_version=?,order_ids=?,order_version=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?',meta?JSON.stringify(meta):p.meta,p.meta_version+(meta?1:0),order?JSON.stringify(order):p.order_ids,p.order_version+(order?1:0),Date.now(),m.name,pid);
        this.trimEvents(pid);
      });
      return {status:200,body:this.snapshot(pid)};
    } catch (e) {
      if (e instanceof Problem) return {status:e.status,body:{error:e.message,...e.details}};
      // Avoid logging tokens, invite codes or subtitle content.
      console.error(JSON.stringify({event:'group_error',operation:op}));
      return {status:500,body:{error:'共享存储暂时不可用，请重试；本地修改仍保留'}};
    }
  }
}
