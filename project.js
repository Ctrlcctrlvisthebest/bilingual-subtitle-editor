const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "p-" + Date.now() + "-" + Math.random().toString(36).slice(2);
const DEFAULT_COLORS = { Unknown: "#455a64", Other: "#455a64" };
const DEFAULT_APPEARANCE = { mode: "outline", order: "zh-first", zhSize: 48, enSize: 42, outlineWidth: 3, font: "Arial", bold: true };
function normalizeAppearance(value) {
  const a = value && typeof value === "object" ? value : {};
  const number = (field, min, max) => typeof a[field] === "number" && Number.isFinite(a[field]) ? Math.max(min, Math.min(max, a[field])) : DEFAULT_APPEARANCE[field];
  return { mode: a.mode === "box" ? "box" : "outline", order: a.order === "en-first" ? "en-first" : "zh-first", zhSize: number("zhSize", 20, 90), enSize: number("enSize", 20, 90), outlineWidth: number("outlineWidth", 1, 8), font: ["Arial", "Microsoft YaHei", "Noto Sans CJK SC"].includes(a.font) ? a.font : "Arial", bold: typeof a.bold === "boolean" ? a.bold : true };
}
function normalizeProject(p) {
  if (!p || p.version !== 1 || !Array.isArray(p.rows) || p.title !== void 0 && typeof p.title !== "string" || p.editor_id !== void 0 && typeof p.editor_id !== "string") throw Error("工程格式无效");
  const result = { ...p, appearance: normalizeAppearance(p.appearance), colors: Object.assign(/* @__PURE__ */ Object.create(null), DEFAULT_COLORS, p.colors), revision: p.revision || 1, editor_id: p.editor_id || uid(), title: p.title || "未命名字幕工程" };
  const ids = /* @__PURE__ */ new Set();
  result.rows = p.rows.map((r) => {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start) throw Error("字幕包含无效起止时间");
    const item = { ...r, id: String(r.id ?? uid()), zh: r.zh ?? "", en: r.en ?? "", speaker: r.speaker || "Unknown", status: r.status || "疑点待听校", note: r.note || "" };
    if (["zh", "en", "speaker", "status", "note"].some((f) => typeof item[f] !== "string") || ids.has(item.id)) throw Error("字幕文字、说话者或编号无效");
    ids.add(item.id);
    if (!result.colors[item.speaker]) result.colors[item.speaker] = "#455a64";
    return item;
  });
  for (const color of Object.values(result.colors)) if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error("说话者颜色须为六位十六进制颜色");
  return result;
}
function blankRow(start = 0, end = start + 2) {
  return { id: uid(), start, end, zh: "", en: "", speaker: "Unknown", status: "疑点待听校", note: "", verification: { translation: "pending", audio: "pending", speaker: "pending" } };
}
function roundTime(t) {
  return Math.round(t * 1e3) / 1e3;
}
function validTimes(r) {
  return Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start;
}
export {
  DEFAULT_APPEARANCE,
  DEFAULT_COLORS,
  blankRow,
  clone,
  normalizeAppearance,
  normalizeProject,
  roundTime,
  uid,
  validTimes
};
