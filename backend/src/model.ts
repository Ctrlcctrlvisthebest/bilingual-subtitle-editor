import {MAX_META_BYTES, MAX_PROJECT_BYTES, MAX_ROW_BYTES, utf8Bytes} from './limits';

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type Obj = {[key: string]: Json};
export type Role = 'owner' | 'editor' | 'viewer';
export type Row = Obj & {id: string; start: number; end: number; zh: string; en: string; speaker: string; status: string; note: string};
export type Project = Obj & {version: number; editor_id: string; title: string; rows: Row[]; colors: Obj};
export type Result = {status: number; body: Obj};
export class Problem extends Error {
  constructor(public status: number, message: string, public details: Obj = {}) {super(message);}
}
export function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Problem(400, '需要 JSON 对象');
  return v as Obj;
}
export function text(v: Json | undefined, label: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Problem(400, `${label}格式无效`);
  return v;
}
export function integer(v: Json | undefined): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Problem(400, '版本号无效');
  return v;
}
export function checkedRow(value: unknown): Row {
  const r = object(value);
  text(r.id, '字幕编号', 150);
  if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start || r.end > 604800) throw new Problem(400, '字幕时间无效');
  for (const key of ['zh', 'en', 'speaker', 'status', 'note']) {
    if (typeof r[key] !== 'string' || (r[key] as string).length > (key === 'note' ? 10000 : 20000)) throw new Problem(400, '字幕文字格式无效');
  }
  if (typeof r.assignedTo !== 'undefined' && typeof r.assignedTo !== 'string') throw new Problem(400, '认领信息无效');
  if (utf8Bytes(JSON.stringify(r)) > MAX_ROW_BYTES) throw new Problem(413, '单条字幕数据超过 64 KB');
  return r as Row;
}
export function checkedMeta(value: unknown): Obj {
  const m = object(value);
  if (m.version !== 1) throw new Problem(400, '需要本编辑器的 JSON 工程');
  text(m.title, '工程名称', 300);
  text(m.editor_id, '工程编号', 150);
  const colors = object(m.colors);
  if (Object.keys(colors).length > 200 || Object.entries(colors).some(([k, v]) => k.length > 80 || typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v))) throw new Problem(400, '人物颜色格式无效');
  if (m.appearance !== undefined) {
    const a = object(m.appearance);
    if (!['outline', 'box'].includes(String(a.mode)) || !['zh-first', 'en-first'].includes(String(a.order)) || !['Arial', 'Microsoft YaHei', 'Noto Sans CJK SC'].includes(String(a.font)) || typeof a.bold !== 'boolean') throw new Problem(400, '字幕样式无效');
    for (const [key, min, max] of [['zhSize',20,90], ['enSize',20,90], ['outlineWidth',1,8]] as const) if (typeof a[key] !== 'number' || !Number.isFinite(a[key]) || a[key] < min || a[key] > max) throw new Problem(400, '字幕字号或描边无效');
  }
  if (m.rows !== undefined) throw new Problem(400, '工程属性不应包含字幕列表');
  if (utf8Bytes(JSON.stringify(m)) > MAX_META_BYTES) throw new Problem(413, '工程属性数据超过 1 MB');
  return m;
}
export function checkedProjectSize(meta: string, rows: Iterable<string>): void {
  // Add the rows property and array punctuation to the serialized metadata.
  let bytes = utf8Bytes(meta) + ',"rows":[]'.length, count = 0;
  for (const row of rows) bytes += utf8Bytes(row) + (count++ > 0 ? 1 : 0);
  if (bytes > MAX_PROJECT_BYTES) throw new Problem(413, '共享工程数据超过 12 MB');
}
export function checkedProject(value: unknown): Project {
  const p = object(value), {rows, ...meta} = p;
  checkedMeta(meta);
  if (!Array.isArray(rows) || rows.length > 20000) throw new Problem(400, '工程最多包含 20,000 条字幕');
  const valid = rows.map(checkedRow), ids = new Set(valid.map(r => r.id));
  if (ids.size !== valid.length) throw new Problem(400, '字幕编号重复');
  checkedProjectSize(JSON.stringify(meta), valid.map(r => JSON.stringify(r)));
  return {...meta, rows: valid} as Project;
}
