import { blankRow, normalizeProject, normalizeAppearance, DEFAULT_COLORS } from "./project.js";
function contrast(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 155 ? "#101010" : "#ffffff";
}
function widthUnits(s) {
  return [...s].reduce((n, c) => n + (/[\u2e80-\uffef]/.test(c) ? 1 : 0.52), 0);
}
function time(s, ass = false) {
  const unit = ass ? 100 : 1e3, v = Math.round(s * unit), h = Math.floor(v / (unit * 3600)), m = Math.floor(v / (unit * 60)) % 60, z = Math.floor(v / unit) % 60, f = v % unit;
  return (ass ? String(h) : String(h).padStart(2, "0")) + ":" + String(m).padStart(2, "0") + ":" + String(z).padStart(2, "0") + (ass ? "." : ",") + String(f).padStart(ass ? 2 : 3, "0");
}
function playbackTime(s) {
  return Number.isFinite(s) ? time(Math.max(0, s)).replace(",", ".") : "--:--:--.---";
}
function parseStamp(value) {
  const m = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m || Number(m[2]) >= 60 || Number(m[3]) >= 60) throw Error("字幕时间格式无效：" + value);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1e3;
}
function plainText(s) {
  return s.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (v) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[v]).replace(/&#(\d+);/g, (_, n) => Number(n) <= 1114111 ? String.fromCodePoint(Number(n)) : "");
}
function splitLanguages(text, mode = "auto") {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (mode === "zh-first" && lines.length > 1) return { zh: lines[0], en: lines.slice(1).join(" ") };
  if (mode === "en-first" && lines.length > 1) return { en: lines[0], zh: lines.slice(1).join(" ") };
  const chinese = lines.filter((s) => /[\u3400-\u9fff]/.test(s)), other = lines.filter((s) => !/[\u3400-\u9fff]/.test(s));
  return { zh: chinese.join(" "), en: other.join(" ") };
}
function parseSRT(text, mode = "auto") {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), blocks = normalized.trim().split(/\n[ \t]*\n/), parsed = [];
  for (const block of blocks) {
    const lines = block.split("\n"), i = lines.findIndex((s) => s.includes("-->"));
    if (i < 0) {
      if (block.trim()) throw Error("有字幕块缺少时间轴");
      continue;
    }
    const m = lines[i].match(/^\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})(?:\s.*)?$/);
    if (!m) throw Error("字幕时间行无法识别");
    const sourceText = plainText(lines.slice(i + 1).join("\n"));
    if (!sourceText.trim()) continue;
    parsed.push({ ...blankRow(parseStamp(m[1]), parseStamp(m[2])), ...splitLanguages(sourceText, mode), sourceText });
  }
  if (!parsed.length) throw Error("未发现可导入的字幕");
  return normalizeProject({ version: 1, rows: parsed, colors: DEFAULT_COLORS }).rows.sort((a, b) => a.start - b.start);
}
function assColor(value) {
  const hex = String(value || "").replace(/^&H/i, "").replace(/&$/, "").padStart(8, "0").slice(-6);
  return /^[0-9a-f]{6}$/i.test(hex) ? "#" + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2) : "#455a64";
}
function csvFields(text, fields) {
  const parts = text.split(",");
  return parts.length < fields.length ? null : parts.slice(0, fields.length - 1).concat(parts.slice(fields.length - 1).join(","));
}
function parseASS(text, mode = "auto") {
  let section = "", styleFields = [], eventFields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"], appearance = normalizeAppearance();
  const styles = /* @__PURE__ */ Object.create(null), colors = Object.assign(/* @__PURE__ */ Object.create(null), DEFAULT_COLORS), parsed = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (line.startsWith("; BilingualEditorAppearance: ")) {
      appearance = normalizeAppearance(JSON.parse(line.slice("; BilingualEditorAppearance: ".length)));
      continue;
    }
    if (/^\[/.test(line.trim())) {
      section = line.trim();
      continue;
    }
    if (/^Format:/i.test(line)) {
      const fields = line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim());
      if (section === "[Events]") eventFields = fields;
      else if (/Styles/.test(section)) styleFields = fields;
      continue;
    }
    if (/^Style:/i.test(line) && styleFields.length) {
      const parts2 = csvFields(line.slice(line.indexOf(":") + 1).trim(), styleFields);
      if (parts2) {
        const style2 = Object.fromEntries(styleFields.map((f, i) => [f, parts2[i].trim()]));
        styles[style2.Name] = style2;
      }
      continue;
    }
    if (!/^Dialogue:/i.test(line) || section !== "[Events]") continue;
    const parts = csvFields(line.slice(line.indexOf(":") + 1).trim(), eventFields);
    if (!parts) throw Error("ASS 对话字段缺失");
    const event = Object.fromEntries(eventFields.map((f, i) => [f, parts[i]]));
    if (/\{[^}]*\\p[1-9]/.test(event.Text)) throw Error("该 ASS 含绘图字幕；请先另存为文本字幕再导入");
    const sourceText = event.Text.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
    if (!sourceText.trim()) continue;
    const speaker = (event.Name || event.Style || "Unknown").trim(), style = styles[event.Style];
    colors[speaker] = style ? assColor(style.OutlineColour || style.BackColour) : "#455a64";
    parsed.push({ ...blankRow(parseStamp(event.Start), parseStamp(event.End)), ...splitLanguages(sourceText, mode), speaker, sourceText });
  }
  if (!parsed.length) throw Error("未发现 ASS 文本字幕");
  return normalizeProject({ version: 1, rows: parsed, colors, appearance });
}
function exportName(project, ext) {
  return (project.title.replace(/[\\/:*?"<>|]/g, "_") || "字幕工程") + "." + ext;
}
function esc(s) {
  return s.replace(/\\/g, "＼").replace(/[{}]/g, "").replace(/[\r\n]+/g, " ");
}
function buildASS(rs, project) {
  const a = project.appearance, outlined = a.mode === "outline";
  let header = "[Script Info]\nTitle: Bilingual subtitles\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\nWrapStyle: 2\n; BilingualEditorAppearance: " + JSON.stringify(a) + "\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n";
  const styles = /* @__PURE__ */ new Map(), reserved = new Set(Object.keys(project.colors));
  let n = 0;
  for (const [name, hex] of Object.entries(project.colors)) {
    let style = name;
    if (!/^[\w-]+$/.test(name)) {
      do {
        style = "Speaker_" + ++n;
      } while (reserved.has(style));
      reserved.add(style);
    }
    styles.set(name, style);
    const c = hex.slice(1), bgr = c.slice(4, 6) + c.slice(2, 4) + c.slice(0, 2), foreground = outlined ? "&H00FFFFFF" : contrast(hex) === "#101010" ? "&H00101010" : "&H00FFFFFF";
    header += `Style: ${style},${a.font},${a.zhSize},${foreground},&H00FFFFFF,&H00${bgr},${outlined ? "&H80000000" : "&H00" + bgr},${a.bold ? -1 : 0},0,0,0,100,100,0,0,${outlined ? 1 : 3},${outlined ? a.outlineWidth : 10},${outlined ? 1 : 0},2,80,80,60,1
`;
  }
  header += "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  return header + rs.map((r) => {
    const parts = [], start = Math.round(r.start * 100) / 100, end = Math.max(start + 0.01, Math.round(r.end * 100) / 100);
    for (const language of a.order === "zh-first" ? ["zh", "en"] : ["en", "zh"]) if (r[language].trim()) {
      const size = Math.min(a[language + "Size"], Math.floor(1700 / Math.max(1, widthUnits(r[language]))));
      parts.push(`{\\fs${size}}${esc(r[language])}`);
    }
    return `Dialogue: 0,${time(start, true)},${time(end, true)},${styles.get(r.speaker) || "Unknown"},${r.speaker.replace(/[,\r\n]/g, " ")},0,0,0,,${parts.join("\\N")}`;
  }).join("\n") + "\n";
}
function buildSRT(rs, project) {
  return rs.map((r, i) => `${i + 1}
${time(r.start)} --> ${time(r.end)}
${(project.appearance.order === "zh-first" ? [r.zh, r.en] : [r.en, r.zh]).filter((s) => s.trim()).map((s) => s.replace(/[\r\n]+/g, " ")).join("\n")}
`).join("\n");
}
export {
  assColor,
  buildASS,
  buildSRT,
  contrast,
  csvFields,
  esc,
  exportName,
  parseASS,
  parseSRT,
  parseStamp,
  plainText,
  playbackTime,
  splitLanguages,
  time,
  widthUnits
};
