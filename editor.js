import { clone, uid, normalizeProject, normalizeAppearance, blankRow, roundTime, validTimes, DEFAULT_COLORS } from "./project.js";
import { contrast, widthUnits, playbackTime, parseSRT, parseASS } from "./subtitle-formats.js";
function createEditor({ initialProject, store, loadMedia, output, isExportOpen, validateProject = normalizeProject }) {
  const $ = (id) => document.getElementById(id);
  let project = validateProject(initialProject), idx = 0, looping = false, auditionEnd = null, frameRequest = null;
  let history = [], editGroup = null, callbacks = {}, selectionVersion = 0, editVersion = 0, mediaLoadVersion = 0, playbackRow = null, lastPreview = null;
  const player = $("video");
  function drawSpeakers() {
    $("speaker").replaceChildren(...Object.keys(project.colors).map((name) => {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      return o;
    }));
  }
  function drawAppearance() {
    const a = project.appearance;
    for (const [id, field] of Object.entries({ subtitleMode: "mode", subtitleOrder: "order", zhSize: "zhSize", enSize: "enSize", outlineWidth: "outlineWidth", subtitleFont: "font" })) $(id).value = String(a[field]);
    $("subtitleBold").checked = a.bold;
    $("outlineWidth").disabled = a.mode === "box";
  }
  function preview(r) {
    lastPreview = r;
    $("sub").style.visibility = "visible";
    $("zh").textContent = r.zh || "";
    $("en").textContent = r.en || "";
    const a = project.appearance, color = project.colors[r.speaker] || "#455a64", outlined = a.mode === "outline";
    $("sub").style.background = outlined ? "transparent" : color;
    $("sub").style.border = "none";
    $("sub").style.color = outlined ? "#ffffff" : contrast(color);
    $("sub").style.fontFamily = '"' + a.font + '", "PingFang SC", "Microsoft YaHei", sans-serif';
    $("sub").style.fontWeight = a.bold ? "700" : "400";
    const available = Math.max(160, ($("screen").clientWidth || 1e3) - 100);
    const scale = Math.min(1, available / 1720), stroke = a.outlineWidth * scale;
    for (const [language, size] of [["zh", a.zhSize], ["en", a.enSize]]) {
      const el = $(language);
      el.style.fontSize = Math.min(size * scale, available / Math.max(1, widthUnits(r[language]))) + "px";
      el.style.display = r[language].trim() ? "block" : "none";
      el.style.order = language === (a.order === "zh-first" ? "zh" : "en") ? "0" : "1";
      el.style.webkitTextStroke = outlined ? 2 * stroke + "px " + color : "0px";
      el.style.textShadow = outlined ? "0 " + scale + "px " + scale + "px #000000" : "none";
    }
  }
  const rowControls = ["prev", "next", "seek", "setStart", "setEnd", "startMinus", "startPlus", "endMinus", "endPlus", "listenStart", "listenEnd", "split", "merge", "delete", "start", "end", "speaker", "status", "zhEdit", "enEdit", "note"];
  function draw() {
    const r = project.rows[idx];
    $("index").value = r ? idx + 1 : 0;
    $("index").max = project.rows.length;
    $("count").textContent = "/ " + project.rows.length;
    for (const id of rowControls) $(id).disabled = !r;
    $("undo").disabled = !history.length;
    $("projectTitle").value = project.title;
    $("mediaName").textContent = project.mediaName || "请选择本地音视频";
    $("fineStep").value = String(project.fineStep || 0.1);
    updateFineLabels();
    for (const f of ["start", "end", "speaker", "status", "note", "zhEdit", "enEdit"]) $(f).value = r ? f === "zhEdit" ? r.zh : f === "enEdit" ? r.en : r[f] ?? "" : "";
    $("asrText").textContent = "音频转写参考：" + (r?.audioTranscript || "暂无");
    $("ytText").textContent = "原字幕参考：" + (r?.youtubeTranscript || r?.sourceText || r?.en || "暂无");
    $("verification").textContent = r ? "说话者：" + (r.verification?.speaker === "confirmed" ? "已确认" : r.speaker === "Unknown" ? "未确认" : "暂定 " + r.speaker) : "尚无字幕；可导入 SRT / ASS，或在当前位置新增。";
    if (r) {
      preview(r);
      $("speakerName").value = r.speaker;
      $("speakerColor").value = project.colors[r.speaker] || "#455a64";
    } else $("sub").style.visibility = "hidden";
    drawAppearance();
    timingHint();
    offsetPreview();
    if (callbacks.onRender) callbacks.onRender();
  }
  function go(i) {
    if (!project.rows.length) return;
    idx = Math.max(0, Math.min(project.rows.length - 1, Math.floor(i) || 0));
    stopLoop();
    editGroup = null;
    draw();
    store.save(project, idx);
  }
  function remember(entry) {
    history.push({ ...entry, idx });
    if (history.length > 30) history.shift();
    $("undo").disabled = false;
  }
  function replaceRows(at, count, items, label, coalesce, selectedIndex = idx) {
    if (!(coalesce && editGroup === coalesce && history.at(-1)?.coalesce === coalesce)) remember({ kind: "splice", at, inserted: items.length, rows: clone(project.rows.slice(at, at + count)), label, coalesce });
    editGroup = coalesce || null;
    project.rows.splice(at, count, ...items);
    idx = Math.max(0, Math.min(project.rows.length - 1, selectedIndex));
    playbackRow = null;
    save();
  }
  function commit(field) {
    const current = project.rows[idx];
    if (!current) return;
    const r = clone(current);
    if (field === "start" || field === "end") {
      const raw = $(field).value;
      if (raw.trim() === "") {
        notice("请输入有效时间。");
        draw();
        return;
      }
      r[field] = Number(raw);
      if (!validTimes(r)) {
        notice("开始须不小于 0，结束须晚于开始；本次修改未应用。");
        draw();
        return;
      }
    } else if (field === "zhEdit") r.zh = $("zhEdit").value;
    else if (field === "enEdit") r.en = $("enEdit").value;
    else r[field] = $(field).value;
    if (JSON.stringify(r) === JSON.stringify(current)) return;
    if (field === "status" && r.status === "已校对") r.verification = { ...r.verification, translation: "user_reviewed", audio: "user_reviewed", speaker: "confirmed" };
    replaceRows(idx, 1, [r], "编辑字幕", "edit:" + r.id + ":" + field);
    preview(r);
    timingHint();
    offsetPreview();
    notice("修改已更新，正在保存到本机。");
  }
  for (const f of ["start", "end", "speaker", "status", "note", "zhEdit", "enEdit"]) {
    $(f).addEventListener(f === "start" || f === "end" ? "change" : "input", () => commit(f));
    $(f).addEventListener("focus", () => {
      editGroup = null;
    });
    if (f === "start" || f === "end") {
      $(f).addEventListener("blur", () => commit(f));
      $(f).addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(f);
        }
      });
    }
  }
  $("prev").addEventListener("click", () => go(idx - 1));
  $("next").addEventListener("click", () => go(idx + 1));
  $("index").addEventListener("change", () => go(Number($("index").value) - 1));
  $("undo").addEventListener("click", () => {
    const h = history.pop();
    if (!h) return;
    if (h.kind === "splice") project.rows.splice(h.at, h.inserted, ...h.rows);
    else {
      const before = new Map(h.rows.map((r) => [r.id, r]));
      project.rows = project.rows.map((r) => before.get(r.id) || r);
    }
    if (h.colors) {
      project.colors = Object.assign(/* @__PURE__ */ Object.create(null), h.colors);
      drawSpeakers();
    }
    if (h.appearance) project.appearance = normalizeAppearance(h.appearance);
    idx = Math.max(0, Math.min(project.rows.length - 1, h.idx));
    stopLoop();
    editGroup = null;
    save();
    draw();
    notice("已撤销：" + h.label);
  });
  $("add").addEventListener("click", () => {
    const start = mediaReady() ? Math.min(player.currentTime, Math.max(0, player.duration - 0.01)) : project.rows[idx]?.end || 0, end = mediaReady() ? Math.min(player.duration, start + 2) : start + 2;
    const at = project.rows.length ? idx + 1 : 0;
    replaceRows(at, 0, [blankRow(roundTime(start), roundTime(end))], "新增字幕", null, at);
    draw();
    notice("已在 " + playbackTime(start) + " 新增一条字幕。");
  });
  $("delete").addEventListener("click", () => {
    if (!project.rows.length) return;
    replaceRows(idx, 1, [], "删除字幕");
    draw();
  });
  $("merge").addEventListener("click", () => {
    const a = project.rows[idx], b = project.rows[idx + 1];
    if (!b) return;
    const merged = { ...a, end: Math.max(a.end, b.end), en: (a.en + " " + b.en).trim(), zh: (a.zh + " " + b.zh).trim(), note: (a.note + " " + b.note).trim(), speaker: a.speaker === b.speaker ? a.speaker : "Unknown", status: "疑点待听校" };
    replaceRows(idx, 2, [merged], "合并字幕");
    draw();
  });
  $("split").addEventListener("click", () => {
    const r = project.rows[idx];
    if (!r) return;
    const enPos = $("enEdit").selectionStart ?? Math.floor(r.en.length / 2), zhPos = $("zhEdit").selectionStart ?? Math.floor(r.zh.length / 2);
    const mid = roundTime(mediaReady() && player.currentTime > r.start && player.currentTime < r.end ? player.currentTime : (r.start + r.end) / 2);
    if (mid <= r.start || mid >= r.end) {
      notice("本条太短，无法继续拆分。");
      return;
    }
    replaceRows(idx, 1, [{ ...r, end: mid, en: r.en.slice(0, enPos).trim(), zh: r.zh.slice(0, zhPos).trim() }, { ...r, id: uid(), start: mid, en: r.en.slice(enPos).trim(), zh: r.zh.slice(zhPos).trim(), status: "疑点待听校" }], "拆分字幕");
    draw();
  });
  $("find").addEventListener("click", () => {
    const q = $("query").value.trim().toLowerCase();
    if (!q) return;
    for (let n = 1; n <= project.rows.length; n++) {
      const i = (idx + n) % project.rows.length, r = project.rows[i];
      if ((r.zh + " " + r.en + " " + r.note).toLowerCase().includes(q)) {
        go(i);
        return;
      }
    }
    notice("没有匹配内容。");
  });
  $("nextFlag").addEventListener("click", () => {
    for (let n = 1; n <= project.rows.length; n++) {
      const i = (idx + n) % project.rows.length;
      if (project.rows[i].status === "疑点待听校") {
        go(i);
        return;
      }
    }
    notice("没有剩余的词句疑点。");
  });
  function mediaReady(show = false) {
    const ok = player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0 && !player.error;
    if (!ok && show) $("seekFeedback").textContent = player.error || !player.getAttribute("src") ? "请先载入本地音视频。" : "片源正在载入，请稍候。";
    return ok;
  }
  function stopLoop() {
    looping = false;
    auditionEnd = null;
    $("loop").checked = false;
  }
  function updatePlayback() {
    const ready2 = mediaReady();
    for (const id of ["back5", "forward5", "backFine", "forwardFine", "playPause"]) $(id).disabled = !ready2;
    $("playPause").textContent = player.paused ? "▶ 播放" : "Ⅱ 暂停";
    $("playPause").setAttribute("aria-label", player.paused ? "播放" : "暂停");
    if (ready2) {
      if (auditionEnd !== null && player.currentTime >= auditionEnd) {
        const end = auditionEnd;
        auditionEnd = null;
        player.pause();
        player.currentTime = end;
      } else if (looping && project.rows[idx] && player.currentTime >= project.rows[idx].end) player.currentTime = project.rows[idx].start;
      const t = player.currentTime;
      if (!playbackRow || t < playbackRow.start || t >= playbackRow.end) playbackRow = project.rows.find((row) => row.start <= t && row.end > t);
      const r = playbackRow;
      $("sub").style.visibility = r ? "visible" : "hidden";
      if (r && r !== lastPreview) preview(r);
    }
    $("playbackClock").textContent = playbackTime(player.currentTime) + " / " + playbackTime(player.duration);
  }
  function renderFrames() {
    if (frameRequest !== null) cancelAnimationFrame(frameRequest);
    frameRequest = null;
    if (typeof requestAnimationFrame !== "function") return;
    const tick = () => {
      updatePlayback();
      if (!player.paused) frameRequest = requestAnimationFrame(tick);
      else frameRequest = null;
    };
    if (!player.paused) frameRequest = requestAnimationFrame(tick);
  }
  function seekPlayback(target, label = "已跳转") {
    if (!mediaReady(true) || !Number.isFinite(target)) return false;
    const hadLoop = looping || $("loop").checked;
    stopLoop();
    player.currentTime = Math.max(0, Math.min(player.duration, target));
    updatePlayback();
    $("seekFeedback").textContent = label + " · " + playbackTime(player.currentTime) + (hadLoop ? " · 已退出循环" : "");
    return true;
  }
  function skipBy(seconds) {
    return seekPlayback(player.currentTime + seconds, (seconds < 0 ? "后退 " : "前进 ") + Math.abs(seconds) + " 秒");
  }
  function togglePlayback() {
    if (!mediaReady(true)) return;
    if (player.paused) player.play().catch(() => {
      $("seekFeedback").textContent = "播放失败，请重新载入片源。";
    });
    else player.pause();
    updatePlayback();
  }
  function fineStep() {
    return Number($("fineStep").value) || 0.1;
  }
  function updateFineLabels() {
    $("backFine").textContent = "−" + fineStep().toFixed(2) + " 秒";
    $("forwardFine").textContent = "+" + fineStep().toFixed(2) + " 秒";
  }
  $("fineStep").addEventListener("change", () => {
    project.fineStep = fineStep();
    updateFineLabels();
    save();
  });
  $("back5").addEventListener("click", () => skipBy(-5));
  $("forward5").addEventListener("click", () => skipBy(5));
  $("backFine").addEventListener("click", () => skipBy(-fineStep()));
  $("forwardFine").addEventListener("click", () => skipBy(fineStep()));
  $("playPause").addEventListener("click", togglePlayback);
  $("seek").addEventListener("click", () => {
    const r = project.rows[idx];
    if (!r || !mediaReady(true)) return;
    if (r.start >= player.duration) {
      $("seekFeedback").textContent = "本条在片源时长之外，请检查时间或载入对应视频。";
      return;
    }
    auditionEnd = null;
    player.currentTime = r.start;
    looping = $("loop").checked;
    updatePlayback();
    player.play().catch(() => notice("播放失败，请检查片源。"));
  });
  $("loop").addEventListener("change", () => {
    if (!$("loop").checked) looping = false;
  });
  $("selectCurrent").addEventListener("click", () => {
    const t = player.currentTime;
    let i = project.rows.findIndex((r) => r.start <= t && r.end > t);
    if (i < 0) i = project.rows.findIndex((r) => r.end > t);
    if (i >= 0) go(i);
  });
  $("jump").addEventListener("click", () => {
    const input = $("jumpTime").value.trim(), parts = input.split(":").map(Number);
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(input) || parts.slice(1).some((n) => n >= 60)) {
      notice("请输入秒数或时:分:秒，例如 120.5 或 02:00:02。");
      return;
    }
    const t = parts.reduce((s, n) => s * 60 + n, 0);
    seekPlayback(t);
  });
  $("jumpTime").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("jump").click();
    }
  });
  player.addEventListener("timeupdate", updatePlayback);
  for (const event of ["loadedmetadata", "durationchange", "seeked", "pause", "ended", "emptied"]) player.addEventListener(event, () => {
    updatePlayback();
    timingHint();
    if (event === "loadedmetadata" && $("seekFeedback").textContent.startsWith("正在载入 ")) $("seekFeedback").textContent = "已载入 " + project.mediaName;
  });
  player.addEventListener("play", () => {
    updatePlayback();
    renderFrames();
  });
  player.addEventListener("error", () => {
    updatePlayback();
    $("seekFeedback").textContent = "片源未能载入，请选择本地音视频文件。";
  });
  $("videoFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const ownerId = project.editor_id, version = selectionVersion, loadVersion = ++mediaLoadVersion;
    try {
      const handle = await loadMedia(file);
      if (project.editor_id !== ownerId || version !== selectionVersion || loadVersion !== mediaLoadVersion) {
        await handle.release();
        return;
      }
      const old = mediaSources.get(project.editor_id);
      mediaSources.set(project.editor_id, { handle, time: 0 });
      stopLoop();
      player.src = handle.src;
      project.mediaName = file.name;
      $("seekFeedback").textContent = "正在载入 " + file.name;
      save();
      draw();
      updatePlayback();
      if (old) retireMedia(old.handle);
    } catch (error) {
      notice("片源未载入：" + error.message);
    }
  });
  function timingHint() {
    const r = project.rows[idx];
    if (!r) {
      $("timingHint").textContent = "";
      return;
    }
    const issues = [], prev = project.rows[idx - 1], next = project.rows[idx + 1];
    if (prev && prev.end > r.start) issues.push("与上一条重叠 " + (prev.end - r.start).toFixed(3) + " 秒");
    if (next && r.end > next.start) issues.push("与下一条重叠 " + (r.end - next.start).toFixed(3) + " 秒");
    if (mediaReady() && r.end > player.duration) issues.push("超出当前片源时长");
    $("timingHint").textContent = "本条 " + (r.end - r.start).toFixed(3) + " 秒 · " + playbackTime(r.start) + " → " + playbackTime(r.end) + (issues.length ? " · " + issues.join("；") : "");
    $("timingHint").className = issues.length ? "warning" : "muted";
  }
  function changeTiming(field, target, label) {
    const old = project.rows[idx];
    if (!old) return;
    const r = { ...old, [field]: roundTime(target) };
    if (!validTimes(r)) {
      notice("微调会造成开始早于 0 或结束不晚于开始，本次未应用。");
      return false;
    }
    if (mediaReady() && r.end > player.duration) {
      notice("微调会超出片源时长，本次未应用。");
      return false;
    }
    replaceRows(idx, 1, [r], label);
    stopLoop();
    draw();
    notice(label + "：" + playbackTime(r[field]));
    return true;
  }
  function setBoundaryNow(field) {
    const old = project.rows[idx];
    if (!old || !mediaReady(true)) return;
    const t = roundTime(player.currentTime), r = { ...old, [field]: t }, length = old.end - old.start;
    let extended = false;
    if (field === "start" && t >= r.end) {
      r.end = roundTime(Math.min(player.duration, t + length));
      extended = true;
    }
    if (field === "end" && t <= r.start) {
      r.start = roundTime(Math.max(0, t - length));
      extended = true;
    }
    if (!validTimes(r)) {
      notice("当前位置无法形成有效字幕区间，请稍微移动播放位置。");
      return;
    }
    replaceRows(idx, 1, [r], "按播放位置设置" + (field === "start" ? "开始" : "结束"));
    stopLoop();
    draw();
    notice((field === "start" ? "开始" : "结束") + "已设为 " + playbackTime(t) + (extended ? "；另一端已同步调整，避免无效区间。" : "。"));
  }
  $("setStart").addEventListener("click", () => setBoundaryNow("start"));
  $("setEnd").addEventListener("click", () => setBoundaryNow("end"));
  for (const [id, field, sign] of [["startMinus", "start", -1], ["startPlus", "start", 1], ["endMinus", "end", -1], ["endPlus", "end", 1]]) $(id).addEventListener("click", () => {
    const r = project.rows[idx];
    if (r) changeTiming(field, r[field] + sign * fineStep(), "微调" + (field === "start" ? "开始" : "结束"));
  });
  function audition(field) {
    const r = project.rows[idx];
    if (!r || !mediaReady(true)) return;
    const boundary = r[field], start = Math.max(0, boundary - (field === "start" ? 0.5 : 1)), end = Math.min(player.duration, boundary + 0.5);
    if (start >= end) {
      notice("字幕边界不在片源范围内。");
      return;
    }
    seekPlayback(start, field === "start" ? "试听开始前后" : "试听结束前后");
    auditionEnd = end;
    player.play().catch(() => {
      auditionEnd = null;
      notice("试听失败，请检查片源。");
    });
  }
  $("listenStart").addEventListener("click", () => audition("start"));
  $("listenEnd").addEventListener("click", () => audition("end"));
  function offsetRows() {
    return $("offsetScope").value === "current" ? project.rows.slice(idx, idx + 1) : $("offsetScope").value === "following" ? project.rows.slice(idx) : project.rows;
  }
  function offsetPreview() {
    const rs = offsetRows(), delta = Number($("offsetSeconds").value), r = project.rows[idx];
    $("offsetPreview").textContent = r && Number.isFinite(delta) ? "影响 " + rs.length + " 条；本条开始 " + playbackTime(r.start) + " → " + (r.start + delta < 0 ? "片头之前" : playbackTime(r.start + delta)) : "请先选择字幕。";
  }
  $("offsetScope").addEventListener("change", offsetPreview);
  $("offsetSeconds").addEventListener("input", offsetPreview);
  $("alignOffset").addEventListener("click", () => {
    if (!project.rows[idx] || !mediaReady(true)) return;
    $("offsetSeconds").value = roundTime(player.currentTime - project.rows[idx].start);
    offsetPreview();
    notice("已计算偏移量；检查影响范围后点“应用偏移”。");
  });
  $("applyOffset").addEventListener("click", () => {
    const rs = offsetRows(), raw = $("offsetSeconds").value, delta = Number(raw);
    if (!rs.length || !raw.trim() || !Number.isFinite(delta)) {
      notice("请输入有效偏移秒数。");
      return;
    }
    if (!delta) {
      notice("偏移为 0，无需修改。");
      return;
    }
    const changed = rs.map((r) => ({ ...r, start: roundTime(r.start + delta), end: roundTime(r.end + delta) }));
    if (changed.some((r) => !validTimes(r))) {
      notice("偏移会使字幕越过片头或形成无效区间，本次未应用。");
      return;
    }
    remember({ kind: "restore", rows: clone(rs), label: "批量偏移 " + delta + " 秒" });
    editGroup = null;
    const replacements = new Map(changed.map((r) => [r.id, r]));
    project.rows = project.rows.map((r) => replacements.get(r.id) || r);
    stopLoop();
    save();
    draw();
    notice("已将 " + rs.length + " 条字幕" + (delta < 0 ? "提前 " : "延后 ") + Math.abs(delta) + " 秒，可撤销。");
  });
  document.addEventListener("keydown", (e) => {
    if (isExportOpen() || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    if (target?.isContentEditable || target?.closest?.('input,textarea,select,[contenteditable],[role="textbox"],[role="slider"],[role="spinbutton"]')) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      skipBy((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? fineStep() : 5));
    } else if (e.shiftKey) return;
    else if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      setBoundaryNow(e.key === "[" ? "start" : "end");
    } else if (e.code === "Space" && !e.repeat && !target?.closest?.('button,a,summary,[role="button"]')) {
      e.preventDefault();
      togglePlayback();
    }
  });
  function clearMedia() {
    player.pause();
    stopLoop();
    player.removeAttribute("src");
    player.load();
    $("mediaName").textContent = "请选择本工程对应的音视频";
    $("seekFeedback").textContent = "";
    updatePlayback();
  }
  const mediaSources = /* @__PURE__ */ new Map();
  const retiredMedia = /* @__PURE__ */ new Set();
  function retireMedia(handle) {
    retiredMedia.add(handle);
    void (async () => {
      try {
        await handle.release();
        retiredMedia.delete(handle);
      } catch (error) {
        notice("旧视频文件未能清理：" + error.message);
      }
    })();
  }
  async function activateProject(p, { store: shouldStore = true, canApply, requestVersion = ++selectionVersion } = {}) {
    const incoming = validateProject(p), version = requestVersion;
    if (version !== selectionVersion) return false;
    await initialized;
    let savedVersion;
    do {
      savedVersion = editVersion;
      await store.flush();
    } while (version === selectionVersion && savedVersion !== editVersion);
    if (version !== selectionVersion) return false;
    if (canApply && !await canApply()) return false;
    if (version !== selectionVersion) return false;
    const previous = mediaSources.get(project.editor_id);
    if (previous) previous.time = player.currentTime;
    clearMedia();
    project = incoming;
    idx = Math.max(0, Math.min(project.rows.length - 1, project.lastIndex || 0));
    history = [];
    editGroup = null;
    playbackRow = null;
    $("offsetSeconds").value = "0";
    $("offsetScope").value = "all";
    $("jumpTime").value = "";
    $("query").value = "";
    const media = mediaSources.get(project.editor_id);
    if (media) {
      player.src = media.handle.src;
      player.addEventListener("loadedmetadata", () => {
        if (project === incoming && media.time < player.duration) player.currentTime = media.time;
      }, { once: true });
    }
    if (shouldStore) store.save(project, idx);
    drawSpeakers();
    drawProjectPicker();
    draw();
    return true;
  }
  function applyProject(p, { preserveHistory = true } = {}) {
    const selected = project.rows[idx]?.id;
    const focused = document.activeElement;
    const selection = focused && ["zhEdit", "enEdit", "note"].includes(focused.id) ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    project = validateProject(p);
    idx = Math.max(0, project.rows.findIndex((row) => row.id === selected));
    if (!preserveHistory) history = [];
    editGroup = null;
    playbackRow = null;
    store.save(project, idx);
    drawSpeakers();
    drawProjectPicker();
    draw();
    if (selection) {
      focused.focus();
      focused.setSelectionRange(...selection);
    }
  }
  $("projectPicker").addEventListener("change", async () => {
    const id = $("projectPicker").value, version = ++selectionVersion;
    try {
      const base = await store.get(id);
      if (version !== selectionVersion) return;
      if (!base) {
        $("projectPicker").value = project.editor_id;
        notice("本浏览器没有该工程底稿，请载入它的工程 JSON。");
        return;
      }
      if (await activateProject(base, { requestVersion: version })) notice("已切换工程。请检查片源是否对应，必要时重新选择本地视频。");
    } catch (error) {
      if ($("projectPicker").value !== id) return;
      $("projectPicker").value = project.editor_id;
      notice("工程未能打开：" + error.message);
    }
  });
  $("newProject").addEventListener("click", async () => {
    const applied = await activateProject({ version: 1, revision: 1, editor_id: uid(), title: "新字幕工程", colors: clone(project.colors), appearance: clone(project.appearance), rows: [] });
    if (applied) notice("新工程已建立并沿用当前说话者颜色和字幕样式：选择视频后导入字幕，或在当前位置新增。");
  });
  async function importFile(file) {
    const version = ++selectionVersion, mode = $("importOrder").value;
    const text = await file.text();
    if (version !== selectionVersion) return false;
    let p;
    if (/\.json$/i.test(file.name)) {
      p = JSON.parse(text);
      if (p.video === project.video && p.video && p.revision < 3 && project.revision >= 3) {
        const edits = new Map(normalizeProject(p).rows.map((r) => [r.id, r]));
        remember({ kind: "restore", rows: clone(project.rows.filter((r) => edits.has(r.id))), colors: clone(project.colors), label: "合入旧版部分工程" });
        project.rows = project.rows.map((r) => edits.has(r.id) ? { ...r, ...edits.get(r.id) } : r);
        project.colors = Object.assign(/* @__PURE__ */ Object.create(null), project.colors, p.colors);
        drawSpeakers();
        save();
        draw();
        notice("旧版部分工程已按编号合入，完整版后续字幕及参考底稿保留。");
        return true;
      }
    } else {
      const parsed = /\.ass$/i.test(file.name) ? parseASS(text, mode) : { rows: parseSRT(text, mode), colors: DEFAULT_COLORS, appearance: clone(project.appearance) };
      p = { ...parsed, version: 1, revision: 1, editor_id: uid(), title: file.name.replace(/\.(srt|ass)$/i, ""), colors: { ...project.colors, ...parsed.colors } };
    }
    if (!await activateProject(p, { requestVersion: version })) return false;
    notice("已导入 " + project.rows.length + " 条字幕。" + (/\.ass$/i.test(file.name) ? "已读取文字、时间和说话者颜色；重新导出使用本编辑器的双语排版。" : ""));
    return true;
  }
  $("projectTitle").addEventListener("input", () => {
    const name = $("projectTitle").value.trim();
    if (name) {
      project.title = name;
      save();
      drawProjectPicker();
    }
  });
  $("projectTitle").addEventListener("change", () => {
    if (!$("projectTitle").value.trim()) $("projectTitle").value = project.title;
  });
  function changeAppearance() {
    const incoming = normalizeAppearance({ mode: $("subtitleMode").value, order: $("subtitleOrder").value, zhSize: Number($("zhSize").value), enSize: Number($("enSize").value), outlineWidth: Number($("outlineWidth").value), font: $("subtitleFont").value, bold: $("subtitleBold").checked });
    if (JSON.stringify(incoming) === JSON.stringify(project.appearance)) {
      drawAppearance();
      return;
    }
    remember({ kind: "restore", rows: [], appearance: clone(project.appearance), label: "字幕样式" });
    project.appearance = incoming;
    editGroup = null;
    save();
    draw();
    notice("字幕样式已更新，预览和 ASS 导出同步；文字与时间保持不变，可撤销。");
  }
  for (const id of ["subtitleMode", "subtitleOrder", "zhSize", "enSize", "outlineWidth", "subtitleFont", "subtitleBold"]) $(id).addEventListener("change", changeAppearance);
  for (const id of ["zhSize", "enSize", "outlineWidth"]) {
    $(id).addEventListener("blur", changeAppearance);
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        changeAppearance();
      }
    });
  }
  $("speaker").addEventListener("change", () => {
    $("speakerName").value = $("speaker").value;
    $("speakerColor").value = project.colors[$("speaker").value];
  });
  $("addSpeaker").addEventListener("click", () => {
    const name = $("speakerName").value.trim(), color = $("speakerColor").value;
    if (!name || name.length > 80) {
      notice("请输入 1～80 字的说话者名称。");
      return;
    }
    const r = project.rows[idx];
    remember({ kind: "restore", rows: r ? [clone(r)] : [], colors: clone(project.colors), label: "修改说话者与颜色" });
    project.colors[name] = color;
    if (r) project.rows[idx] = { ...r, speaker: name };
    drawSpeakers();
    save();
    draw();
    notice("已保存说话者 " + name + " 的颜色" + (r ? "；当前字幕已归给此人。" : "。"));
  });
  $("renameSpeaker").addEventListener("click", () => {
    const from = $("speaker").value, to = $("speakerName").value.trim();
    if (!from || !to || to.length > 80) {
      notice("请选中字幕的说话者并填写新名字。");
      return;
    }
    if (from === to) {
      $("addSpeaker").click();
      return;
    }
    if (project.colors[to]) {
      notice("该名字已存在，请用说话者下拉框更改归属。");
      return;
    }
    const affected = project.rows.filter((r) => r.speaker === from);
    remember({ kind: "restore", rows: clone(affected), colors: clone(project.colors), label: "重命名说话者" });
    project.colors[to] = $("speakerColor").value;
    project.rows = project.rows.map((r) => r.speaker === from ? { ...r, speaker: to } : r);
    drawSpeakers();
    save();
    draw();
    notice("已重命名 " + affected.length + " 条；可撤销恢复旧名字。");
  });
  function exportRows() {
    const rs = project.rows.filter((r) => r.zh.trim() || r.en.trim()).sort((a, b) => a.start - b.start);
    if (!rs.length) {
      notice("暂无字幕文字。");
      return null;
    }
    if (rs.some((r) => !validTimes(r))) {
      notice("有无效时间，请修正后导出。");
      return null;
    }
    notice("已导出 " + rs.length + " 条；含单语条目 " + rs.filter((r) => !r.zh.trim() || !r.en.trim()).length + " 条。");
    return rs;
  }
  function notice(text) {
    $("msg").textContent = text;
  }
  function drawProjectPicker() {
    const list = store.list();
    if (!list.some((p) => p.id === project.editor_id)) list.unshift({ id: project.editor_id, title: project.title });
    $("projectPicker").replaceChildren(...list.map((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.title;
      return option;
    }));
    $("projectPicker").value = project.editor_id;
  }
  function save(quiet = true) {
    editVersion++;
    playbackRow = null;
    store.save(project, idx);
    if (callbacks.onChange) callbacks.onChange();
    if (!quiet) notice("修改已更新，正在保存到本机。");
  }
  function pause() {
    stopLoop();
    player.pause();
  }
  async function releaseMedia() {
    pause();
    const handles = /* @__PURE__ */ new Set([...retiredMedia, ...[...mediaSources.values()].map((media) => media.handle)]);
    const released = await Promise.allSettled([...handles].map((handle) => handle.release()));
    mediaSources.clear();
    retiredMedia.clear();
    const failure = released.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  function commitTimes() {
    commit("start");
    commit("end");
  }
  window.addEventListener("pagehide", () => {
    pause();
    void store.flush();
    void releaseMedia().catch((error) => notice("视频文件未能清理：" + error.message));
  });
  drawSpeakers();
  drawProjectPicker();
  draw();
  updatePlayback();
  const initialized = (async () => {
    try {
      await store.init(initialProject);
    } catch (error) {
      notice("工程存储初始化失败：" + error.message);
    }
  })();
  const ready = (async () => {
    const version = selectionVersion;
    await initialized;
    if (version !== selectionVersion) return;
    try {
      const last = initialProject.editor_id === "generic-blank" || initialProject.editor_id === "mini-blank" ? await store.getLastId() : initialProject.editor_id;
      const saved = last ? await store.get(last) : null;
      if (version === selectionVersion && saved) await activateProject(saved, { store: false, requestVersion: version });
      drawProjectPicker();
    } catch (error) {
      notice("工程恢复失败：" + error.message);
    }
  })();
  return { ready, player, getProject: () => project, getMediaFile: () => mediaSources.get(project.editor_id)?.handle.file, getIndex: () => idx, notice, activateProject, applyProject, replaceRows, save, flushSave: () => store.flush(), redraw: draw, setCallbacks(value) {
    callbacks = value;
  }, go, pause, stopLoop, releaseMedia, commitTimes, importFile, exportRows, download: output };
}
export {
  createEditor
};
