import { clone } from "./project.js";
import { playbackTime } from "./subtitle-formats.js";
import {
  collabEqual,
  collabMeta,
  collabPatch,
  collabDirty,
  collabOrder,
  collabMerge,
  collabLeaderKey,
  collabParseLeaderKey
} from "./collaboration-core.js";
const SESSION_KEY = "subtitle-group-connections-v1";
const roles = { owner: "组长", editor: "编辑者", viewer: "只读成员" };
function initCollaboration(editor) {
  const $ = (id) => document.getElementById(id);
  const defaultServer = location.hostname === "ctrlcctrlvisthebest.github.io" || !location.protocol.startsWith("http") ? "https://bilingual-subtitle-editor.zoeli2010xl.workers.dev" : location.origin;
  const state = {
    server: defaultServer,
    session: null,
    base: null,
    pid: null,
    conflicts: [],
    busy: null,
    timer: null,
    members: [],
    epoch: 0,
    presenceAt: 0,
    retryAt: 0,
    detached: null,
    pendingDraft: null,
    dirty: false
  };
  const database = openDraftDatabase();
  let draftWrites = Promise.resolve(true);
  const project = () => editor.getProject();
  const index = () => editor.getIndex();
  const capture = () => ({ session: state.session, epoch: state.epoch });
  const current = (scope) => scope.session === state.session && scope.epoch === state.epoch;
  const active = () => !!(state.session && state.base && state.pid && project().editor_id === state.base.project.editor_id);
  const path = (suffix = "", scope = capture()) => "groups/" + encodeURIComponent(scope.session.groupId) + (suffix ? "/" + suffix : "");
  const draftKey = (session, pid) => session.server + "|" + session.groupId + "|" + session.member.id + "|" + pid;
  function openDraftDatabase() {
    return new Promise((resolve) => {
      try {
        const request2 = indexedDB.open("subtitle-group-drafts", 1);
        request2.onupgradeneeded = () => request2.result.createObjectStore("drafts", { keyPath: "id" });
        request2.onsuccess = () => resolve(request2.result);
        request2.onerror = request2.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  async function draft(id, value) {
    const db = await database;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction("drafts", value ? "readwrite" : "readonly");
        const store = transaction.objectStore("drafts");
        if (value) {
          store.put(value);
          transaction.oncomplete = () => resolve(true);
          transaction.onerror = transaction.onabort = () => resolve(null);
        } else {
          const request2 = store.get(id);
          request2.onsuccess = () => resolve(request2.result || null);
          request2.onerror = () => resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  }
  function sessions() {
    try {
      const list = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function storeSession(session) {
    state.session = session;
    try {
      const list = sessions().filter((item) => !(item.server === session.server && item.groupId === session.groupId && item.member.id === session.member.id));
      list.unshift(session);
      localStorage.setItem(SESSION_KEY, JSON.stringify(list));
    } catch {
      message("成员凭证无法暂存，请立刻下载成员备份。");
    }
    renderConnections();
  }
  function server(value) {
    const url = new URL(value.trim() || location.origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw Error("字幕组连接信息无效，请重新获取邀请或成员备份");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw Error("字幕组连接需要安全地址，请联系网站管理员");
    }
    return url.origin;
  }
  function message(text) {
    $("cloudStatus").textContent = text;
    $("cloudBar").hidden = !state.session;
    $("cloudBarText").textContent = (state.session ? (state.session.groupName || "字幕组") + " · " : "") + text;
  }
  async function request(route, method = "GET", data, auth = true, session = state.session) {
    if (!session) throw Error("请先连接字幕组");
    const headers = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = "Bearer " + session.token;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2e4);
    try {
      const response = await fetch(session.server + "/api/" + route, {
        method,
        headers,
        body: data === void 0 ? void 0 : JSON.stringify(data),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw Error("字幕组服务返回了无效响应，请联系网站管理员");
      }
      if (!response.ok) {
        const error = Error(body.error || "协作请求失败");
        error.status = response.status;
        error.data = body;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw Error("连接超时，本地修改已保留");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  function renderConnections() {
    const list = sessions();
    $("cloudConnections").replaceChildren(...list.map((session, at) => {
      const option = node("option", (session.groupName || "字幕组") + " · " + session.member.name);
      option.value = String(at);
      return option;
    }));
    $("cloudReconnect").disabled = !list.length;
  }
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== void 0) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function editControls() {
    const disabled = active() && (state.session.member.role === "viewer" || state.conflicts.length > 0);
    for (const id of ["start", "end", "speaker", "status", "zhEdit", "enEdit", "note", "setStart", "setEnd", "startMinus", "startPlus", "endMinus", "endPlus", "split", "merge", "delete", "add", "projectTitle", "addSpeaker", "renameSpeaker", "subtitleMode", "subtitleOrder", "zhSize", "enSize", "outlineWidth", "subtitleFont", "subtitleBold", "applyOffset", "undo", "claimCue"]) {
      const element = $(id);
      if (disabled) element.disabled = true;
      else if (id === "outlineWidth") element.disabled = project().appearance.mode === "box";
      else if (["add", "projectTitle", "addSpeaker", "renameSpeaker", "subtitleMode", "subtitleOrder", "zhSize", "enSize", "subtitleFont", "subtitleBold", "applyOffset"].includes(id)) element.disabled = false;
    }
    $("cloudSaveNow").disabled = !active() || state.session.member.role === "viewer" || state.conflicts.length > 0;
    $("cloudHistory").disabled = !active();
    $("claimCue").disabled = !active() || disabled || !project().rows[index()];
    $("nextMine").disabled = !active();
    const row = project().rows[index()];
    const member = state.members.find((item) => item.id === row?.assignedTo);
    $("cueAssignment").textContent = row?.assignedTo ? "本条由 " + (member?.name || (state.session ? "已离组成员" : "组内成员（连接后查看名字）")) + " 认领" : "本条未认领";
  }
  function queueDraft() {
    if (active()) {
      state.pendingDraft = {
        id: draftKey(state.session, state.pid),
        base: state.base,
        project: project(),
        conflicts: state.conflicts,
        scope: capture()
      };
    } else if (state.detached && project().editor_id === state.detached.base.project.editor_id) {
      state.pendingDraft = { ...state.detached, project: project(), scope: capture() };
    }
  }
  async function saveDraft() {
    let writing;
    do {
      const pending = state.pendingDraft;
      if (pending) {
        state.pendingDraft = null;
        const value = { id: pending.id, base: clone(pending.base), project: clone(pending.project), conflicts: clone(pending.conflicts) };
        draftWrites = draftWrites.then(() => draft(value.id, value));
      }
      writing = draftWrites;
      const ok = await writing;
      if (!ok) {
        if (pending && current(pending.scope)) message("离线协作备份未成功，请保存工程 JSON；在线同步仍可重试。");
        return ok;
      }
    } while (state.pendingDraft || writing !== draftWrites);
    return true;
  }
  function schedule() {
    clearTimeout(state.timer);
    if (!state.pendingDraft) return;
    const scope = capture();
    if (active() && !state.conflicts.length && Date.now() >= state.retryAt) message("修改待同步…");
    state.timer = setTimeout(async () => {
      await saveDraft();
      if (current(scope)) await flush();
    }, Math.max(1200, state.retryAt - Date.now()));
  }
  function changed() {
    if (active()) state.dirty = true;
    queueDraft();
    schedule();
  }
  async function apply(snapshot, local, conflicts, scope) {
    if (!current(scope)) return false;
    const preserveHistory = collabEqual(project(), local);
    state.base = snapshot;
    state.detached = null;
    state.conflicts = conflicts;
    editor.applyProject(local, { preserveHistory });
    state.dirty = collabDirty(state.base, project());
    renderConflicts();
    queueDraft();
    await saveDraft();
    return current(scope);
  }
  async function flush() {
    if (!active() || state.conflicts.length || state.session.member.role === "viewer") return;
    if (state.busy) {
      queueDraft();
      schedule();
      return;
    }
    const patch = collabPatch(state.base, project());
    state.dirty = !!(patch.changes.length || patch.meta || patch.order);
    if (!state.dirty) {
      message("已与字幕组同步");
      return;
    }
    const scope = capture();
    const captured = clone(project());
    const base = state.base;
    const route = path("projects/" + state.pid, scope);
    state.busy = scope;
    message("正在保存到字幕组…");
    try {
      const snapshot = await request(route, "PATCH", patch, true, scope.session);
      if (!current(scope) || !active()) return;
      state.retryAt = 0;
      const merged = collabMerge(captured, project(), snapshot.project);
      if (!await apply(snapshot, merged.project, merged.conflicts, scope)) return;
      message(merged.conflicts.length ? "有新冲突，请选择保留的版本" : "已保存到字幕组 · " + (/* @__PURE__ */ new Date()).toLocaleTimeString());
    } catch (error) {
      if (!current(scope)) return;
      if (error.status === 409 && error.data.snapshot) {
        const snapshot = error.data.snapshot;
        const merged = collabMerge(base.project, project(), snapshot.project);
        if (!await apply(snapshot, merged.project, merged.conflicts, scope)) return;
        message(merged.conflicts.length ? "其他成员也修改了这些字幕，请处理下方冲突" : "已合入其他成员的修改，继续保存");
      } else {
        state.retryAt = Date.now() + 15e3;
        message(error.message + "；修改保留在本地，可保存 JSON 备份。");
        if (error.status === 401 || error.status === 403) state.session.member.role = "viewer";
      }
    } finally {
      if (state.busy === scope) {
        state.busy = null;
        editControls();
      }
    }
    if (current(scope) && active() && state.dirty && !state.conflicts.length) {
      queueDraft();
      schedule();
    }
  }
  async function poll() {
    if (!active() || state.busy || state.conflicts.length || document.hidden) return;
    if (state.dirty) {
      if (Date.now() >= state.retryAt) await flush();
      return;
    }
    const scope = capture();
    const pid = state.pid;
    state.busy = scope;
    try {
      const snapshot = await request(path("projects/" + pid, scope) + "?since=" + state.base.revision, "GET", void 0, true, scope.session);
      if (!current(scope) || !active()) return;
      if (!snapshot.unchanged) {
        const merged = collabMerge(state.base.project, project(), snapshot.project);
        if (!await apply(snapshot, merged.project, merged.conflicts, scope)) return;
        message(merged.conflicts.length ? "其他成员有并发修改，请处理冲突" : "已收到组内最新修改");
      }
      if (Date.now() - state.presenceAt > 3e4) {
        await request(path("presence", scope), "POST", { projectId: pid, rowId: project().rows[index()]?.id || "" }, true, scope.session);
        if (!current(scope)) return;
        state.presenceAt = Date.now();
        await refresh(scope);
      }
    } catch (error) {
      if (!current(scope)) return;
      message(error.message + "；本地编辑仍可保存 JSON。");
      if (error.status === 401 || error.status === 403) state.session.member.role = "viewer";
    } finally {
      if (state.busy === scope) {
        state.busy = null;
        editControls();
        if (active() && state.dirty && !state.conflicts.length) {
          queueDraft();
          schedule();
        }
      }
    }
  }
  function conflictValue(value, kind) {
    if (value === null) return "此条已删除";
    if (kind === "order") return "字幕顺序 / 增删：" + value.length + " 条";
    if (kind === "meta") return JSON.stringify({ title: value.title, colors: value.colors, appearance: value.appearance }, null, 2);
    return playbackTime(value.start) + " → " + playbackTime(value.end) + "\n" + value.speaker + " · " + value.status + "\n" + value.zh + "\n" + value.en + (value.note ? "\n备注：" + value.note : "");
  }
  function renderConflicts() {
    const panel = $("cloudConflicts");
    panel.replaceChildren();
    panel.hidden = !state.conflicts.length;
    if (state.conflicts.length) {
      $("cloudPanel").open = true;
      editor.notice("字幕组检测到并发修改：请在“字幕组 · 多人在线校对”中比较版本、处理冲突。");
    }
    for (const conflict of state.conflicts) {
      const card = node("section", void 0, "cloud-conflict");
      card.append(node("h3", conflict.kind === "row" ? "字幕冲突 · " + conflict.id : conflict.kind === "meta" ? "工程名称 / 人物颜色 / 样式冲突" : "字幕增删或顺序冲突"));
      const grid = node("div", void 0, "grid");
      for (const [label, choice] of [["我的修改", "local"], ["字幕组最新版本", "remote"]]) {
        const column = node("div");
        column.append(node("strong", label), node("pre", conflictValue(conflict[choice], conflict.kind)));
        const button = node("button", choice === "local" ? "保留我的修改" : "使用组内版本");
        button.onclick = () => action(async () => {
          const local = clone(project());
          const value = conflict[choice];
          if (conflict.kind === "meta") Object.assign(local, clone(value), { rows: local.rows });
          else {
            const rows = new Map(local.rows.map((row) => [row.id, row]));
            if (conflict.kind === "row") {
              if (value) rows.set(conflict.id, clone(value));
              else rows.delete(conflict.id);
            }
            const order = conflict.kind === "order" ? value : local.rows.map((row) => row.id);
            local.rows = collabOrder(order, rows).map((id) => rows.get(id));
          }
          const conflicts = state.conflicts.filter((item) => item !== conflict);
          await apply(state.base, local, conflicts, capture());
          if (!state.conflicts.length) {
            queueDraft();
            schedule();
          }
        });
        column.append(button);
        grid.append(column);
      }
      card.append(grid);
      panel.append(card);
    }
  }
  async function refresh(scope = capture()) {
    const result = await request(path("", scope), "GET", void 0, true, scope.session);
    if (!current(scope)) return false;
    scope.session.member = result.member;
    scope.session.groupName = result.groupName;
    state.members = result.members;
    storeSession(scope.session);
    $("cloudGroupName").textContent = result.groupName + " · " + result.member.name + "（" + roles[result.member.role] + "）";
    const leader = result.member.role === "owner";
    $("cloudLeaderTools").hidden = !leader;
    const key = leader ? collabLeaderKey(scope.session.groupId, scope.session.token) : "";
    if ($("cloudOwnerKey").value !== key) {
      $("cloudOwnerKey").value = key;
      $("cloudOwnerKey").type = "password";
      $("cloudShowLeaderKey").textContent = "显示组长密钥";
    }
    const picker = $("cloudProjects");
    const previous = state.pid || picker.value;
    picker.replaceChildren(...result.projects.map((item) => {
      const option = node("option", item.title + " · " + item.count + " 条 · " + item.updatedBy + " 最近修改");
      option.value = item.id;
      return option;
    }));
    picker.value = result.projects.some((item) => item.id === previous) ? previous : result.projects[0]?.id || "";
    $("cloudOpen").disabled = !result.projects.length;
    $("cloudPublish").disabled = result.member.role === "viewer";
    $("cloudOwnerTools").hidden = !leader;
    $("cloudConnected").hidden = false;
    const members = $("cloudMembers");
    members.replaceChildren();
    for (const member of result.members) {
      const line = node("div", void 0, "row");
      line.append(node("span", member.name + " · " + roles[member.role] + (Date.now() - member.last_seen < 9e4 ? " · 在线" : "") + (member.row_id ? " · 当前字幕 " + member.row_id : "")));
      if (leader && member.role !== "owner") {
        const selector = node("select");
        selector.setAttribute("aria-label", member.name + "的权限");
        for (const [value, label] of [["editor", "编辑者"], ["viewer", "只读"], ["removed", "移出字幕组"]]) {
          const option = node("option", label);
          option.value = value;
          selector.append(option);
        }
        selector.value = member.role;
        const button = node("button", "更新权限");
        button.onclick = () => action(async () => {
          if (!current(scope)) return;
          await request(path("members", scope), "PATCH", { id: member.id, role: selector.value }, true, scope.session);
          if (current(scope) && await refresh(scope)) message("成员权限已更新");
        });
        line.append(selector, button);
      }
      members.append(line);
    }
    editControls();
    return true;
  }
  async function action(fn) {
    const scope = capture();
    try {
      await fn();
    } catch (error) {
      if (current(scope)) message(error.message);
    }
  }
  function advance() {
    clearTimeout(state.timer);
    state.epoch++;
    state.busy = null;
    state.presenceAt = 0;
    state.retryAt = 0;
  }
  async function connect(session) {
    if (server(session.server) !== defaultServer) throw Error("这份连接信息不属于当前字幕网站，请使用对应的网站入口");
    queueDraft();
    advance();
    const previous = capture();
    const saved = await saveDraft();
    if (!current(previous)) return false;
    if (!saved) {
      message("离线协作备份未成功，暂未切换字幕组；请保存工程 JSON 后重试。");
      return false;
    }
    state.pid = null;
    state.base = null;
    state.conflicts = [];
    state.dirty = false;
    $("cloudConnected").hidden = true;
    $("cloudLeaderTools").hidden = true;
    $("cloudOwnerKey").value = "";
    storeSession(session);
    state.server = session.server;
    renderConflicts();
    editor.redraw();
    const scope = capture();
    try {
      if (!await refresh(scope)) return false;
      message("已连接字幕组，选择共享工程或发布当前工程");
      return true;
    } catch (error) {
      if (current(scope)) message(error.message);
      return false;
    }
  }
  async function open(pid, expected = capture()) {
    if (!pid) throw Error("请选择共享工程");
    if (!current(expected)) return false;
    queueDraft();
    advance();
    const scope = capture();
    const persisted = await saveDraft();
    if (!current(scope)) return false;
    if (!persisted) {
      message("离线协作备份未成功，暂未切换工程；请保存工程 JSON 后重试。");
      return false;
    }
    try {
      const snapshot = await request(path("projects/" + pid, scope), "GET", void 0, true, scope.session);
      if (!current(scope)) return false;
      const saved = await draft(draftKey(scope.session, pid));
      if (!current(scope)) return false;
      let merged = { project: snapshot.project, conflicts: [] };
      if (saved?.base && saved.project) {
        merged = collabMerge(saved.base.project, saved.project, snapshot.project);
        for (const conflict of saved.conflicts || []) {
          const local = conflict.kind === "row" ? merged.project.rows.find((row) => row.id === conflict.id) || null : conflict.kind === "meta" ? collabMeta(merged.project) : merged.project.rows.map((row) => row.id);
          const remote = conflict.kind === "row" ? snapshot.project.rows.find((row) => row.id === conflict.id) || null : conflict.kind === "meta" ? collabMeta(snapshot.project) : snapshot.project.rows.map((row) => row.id);
          if (!collabEqual(local, remote) && !merged.conflicts.some((item) => item.kind === conflict.kind && item.id === conflict.id)) merged.conflicts.push({ ...conflict, local, remote });
        }
      }
      const activated = await editor.activateProject(snapshot.project, {
        store: true,
        canApply: async () => {
          if (!current(scope)) return false;
          queueDraft();
          const saved2 = await saveDraft();
          if (!current(scope)) return false;
          if (!saved2) message("离线协作备份未成功，暂未切换工程；请保存工程 JSON 后重试。");
          return !!saved2;
        }
      });
      if (!activated) return false;
      if (!current(scope)) return false;
      state.pid = pid;
      state.base = snapshot;
      state.conflicts = [];
      if (!await apply(snapshot, merged.project, merged.conflicts, scope)) return false;
      await request(path("presence", scope), "POST", { projectId: pid, rowId: project().rows[index()]?.id || "" }, true, scope.session);
      if (!current(scope)) return false;
      state.presenceAt = Date.now();
      if (!await refresh(scope)) return false;
      message(merged.conflicts.length ? "离线修改与组内版本有冲突，请选择要保留的内容" : "共享工程已打开；修改会自动同步");
      if (!merged.conflicts.length && state.dirty) {
        queueDraft();
        schedule();
      }
      return true;
    } catch (error) {
      if (current(scope)) message(error.message);
      return false;
    }
  }
  $("cloudCreate").onclick = () => action(async () => {
    const name = $("cloudNewName").value.trim();
    const memberName = $("cloudNickname").value.trim();
    if (!name || !memberName) throw Error("请先填写你的昵称和字幕组名称");
    const scope = capture();
    const button = $("cloudCreate");
    button.disabled = true;
    try {
      const data = await request("groups", "POST", { name, memberName }, false, { server: defaultServer });
      if (!current(scope)) return;
      if (await connect({ server: defaultServer, groupId: data.groupId, token: data.token, member: data.member, groupName: data.groupName })) message("字幕组已创建，请复制组长密钥保存，再发布工程、邀请成员。");
    } finally {
      button.disabled = false;
    }
  });
  $("cloudLeaderConnect").onclick = () => action(async () => {
    const credentials = collabParseLeaderKey($("cloudLeaderLogin").value);
    const session = { server: defaultServer, ...credentials };
    const scope = capture();
    const data = await request("groups/" + encodeURIComponent(credentials.groupId), "GET", void 0, true, session);
    if (!current(scope)) return;
    if (data.member.role !== "owner") throw Error("这不是组长密钥；请通过成员邀请加入或恢复成员备份");
    if (await connect({ ...session, member: data.member, groupName: data.groupName })) {
      $("cloudLeaderLogin").value = "";
      message("已用组长密钥连接，选择共享工程即可继续校对。");
    }
  });
  $("cloudCopyLeaderKey").onclick = () => action(async () => {
    if (state.session?.member.role !== "owner") throw Error("只有组长可以复制组长密钥");
    const scope = capture();
    const input = $("cloudOwnerKey");
    input.value = collabLeaderKey(scope.session.groupId, scope.session.token);
    try {
      await navigator.clipboard.writeText(input.value);
      if (current(scope)) message("组长密钥已复制。请私下保存或交给本组组长。");
    } catch {
      if (!current(scope)) return;
      input.type = "text";
      $("cloudShowLeaderKey").textContent = "隐藏组长密钥";
      input.focus();
      input.select();
      message("无法自动复制，密钥已选中，请手动复制后保存。");
    }
  });
  $("cloudShowLeaderKey").onclick = () => {
    const input = $("cloudOwnerKey");
    input.type = input.type === "password" ? "text" : "password";
    $("cloudShowLeaderKey").textContent = input.type === "password" ? "显示组长密钥" : "隐藏组长密钥";
  };
  $("cloudJoin").onclick = () => action(async () => {
    const scope = capture();
    const origin = server(state.server);
    const groupId = $("cloudJoinGroup").value.trim();
    const data = await request("groups/" + encodeURIComponent(groupId) + "/join", "POST", { name: $("cloudNickname").value.trim(), code: $("cloudJoinCode").value.trim() }, false, { server: origin });
    if (!current(scope)) return;
    $("cloudJoinCode").value = "";
    if (await connect({ server: origin, groupId, token: data.token, member: data.member })) message("已加入字幕组，请下载成员备份，再选择共享工程。");
  });
  $("cloudReconnect").onclick = () => action(() => connect(sessions()[Number($("cloudConnections").value)]));
  $("cloudRefresh").onclick = () => action(async () => {
    const scope = capture();
    try {
      await refresh(scope);
    } catch (error) {
      if (current(scope)) throw error;
    }
  });
  $("cloudOpen").onclick = () => action(() => open($("cloudProjects").value));
  $("cloudPublish").onclick = () => action(async () => {
    if (!project().rows.length) throw Error("先导入字幕工程，再发布到字幕组");
    const scope = capture();
    queueDraft();
    const saved = await saveDraft();
    if (!current(scope)) return;
    if (!saved) {
      message("离线协作备份未成功，暂未发布工程；请保存工程 JSON 后重试。");
      return;
    }
    const result = await request(path("projects", scope), "POST", { project: clone(project()) }, true, scope.session);
    if (!current(scope) || !await refresh(scope)) return;
    if (await open(result.id, scope)) message("工程已发布到字幕组，成员现在可以共同校对。");
  });
  $("cloudSaveNow").onclick = () => action(async () => {
    const scope = capture();
    queueDraft();
    await saveDraft();
    if (current(scope)) await flush();
  });
  $("cloudShowPanel").onclick = () => {
    $("cloudPanel").open = true;
    $("cloudPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("cloudInvite").onclick = () => action(async () => {
    const scope = capture();
    const data = await request(path("invites", scope), "POST", { role: $("cloudInviteRole").value, uses: Number($("cloudInviteUses").value), days: 7 }, true, scope.session);
    if (!current(scope)) return;
    const url = new URL(location.href);
    const params = { subtitleGroup: scope.session.groupId, invite: data.code };
    if (scope.session.server !== defaultServer) params.backend = scope.session.server;
    url.hash = new URLSearchParams(params).toString();
    $("cloudInviteLink").value = url.href;
    $("cloudInviteResult").hidden = false;
    message("邀请链接已生成，有效期 7 天；只分享给字幕组成员。");
  });
  $("cloudResetInvites").onclick = () => action(async () => {
    const scope = capture();
    await request(path("invites/reset", scope), "POST", {}, true, scope.session);
    if (!current(scope)) return;
    $("cloudInviteResult").hidden = true;
    $("cloudInviteLink").value = "";
    message("旧邀请已全部失效，已加入的成员保持原权限。");
  });
  $("cloudBackup").onclick = () => {
    if (state.session) editor.download("字幕组-" + state.session.member.name + ".credential.json", JSON.stringify({ format: "subtitle-group-member-v1", ...state.session }, null, 2));
  };
  $("cloudRestore").onchange = (event) => action(async () => {
    const file = event.target.files[0];
    if (!file) return;
    const scope = capture();
    try {
      const session = JSON.parse(await file.text());
      if (!current(scope)) return;
      if (session.format !== "subtitle-group-member-v1" || !/^[-\w.]{50,120}$/.test(session.groupId) || !/^[a-f0-9]{64}$/.test(session.token) || !session.member?.name) throw Error("不是有效的成员备份");
      session.server = server(session.server);
      await connect(session);
    } finally {
      event.target.value = "";
    }
  });
  $("cloudDisconnect").onclick = () => action(async () => {
    const oldSession = state.session;
    if (active()) {
      queueDraft();
      state.detached = { id: draftKey(oldSession, state.pid), base: state.base, conflicts: state.conflicts };
    }
    advance();
    const scope = capture();
    const saved = await saveDraft();
    if (!current(scope)) return;
    if (!saved) {
      message("离线协作备份未成功，暂未断开连接；请保存工程 JSON 后重试。");
      return;
    }
    state.session = null;
    state.pid = null;
    state.base = null;
    state.conflicts = [];
    state.dirty = false;
    $("cloudConnected").hidden = true;
    $("cloudOwnerKey").value = "";
    renderConflicts();
    editor.redraw();
    message("已断开共享连接。当前修改保留为离线草稿，重新打开该共享工程时可以合入。");
  });
  $("claimCue").onclick = () => {
    const row = project().rows[index()];
    if (!row || !active()) return;
    editor.replaceRows(index(), 1, [{ ...row, assignedTo: state.session.member.id }], "认领字幕");
    editor.redraw();
  };
  $("nextMine").onclick = () => {
    if (!state.session) return;
    for (let offset = 1; offset <= project().rows.length; offset++) {
      const at = (index() + offset) % project().rows.length;
      const row = project().rows[at];
      if (row.assignedTo === state.session.member.id && row.status !== "已校对") {
        editor.go(at);
        return;
      }
    }
    editor.notice("你认领的字幕都已校对，或尚未认领字幕。");
  };
  $("cloudHistory").onclick = () => action(async () => {
    const scope = capture();
    const row = project().rows[index()];
    const data = await request(path("projects/" + state.pid + "/history", scope) + (row ? "?row=" + encodeURIComponent(row.id) : ""), "GET", void 0, true, scope.session);
    if (!current(scope)) return;
    const list = $("cloudHistoryList");
    list.replaceChildren();
    $("cloudHistoryPanel").hidden = false;
    if (!data.events.length) list.append(node("p", "这条字幕还没有组内修改记录。"));
    for (const event of data.events) {
      const item = node("details");
      item.append(node("summary", event.actor + " · " + new Date(event.at).toLocaleString()), node("pre", "修改前\n" + conflictValue(event.before, "row")), node("pre", "修改后\n" + conflictValue(event.after, "row")));
      if (event.before?.id && scope.session.member.role !== "viewer") {
        const button = node("button", "将当前字幕恢复为修改前版本");
        button.onclick = () => {
          if (!current(scope) || !active() || state.conflicts.length) return;
          const at = project().rows.findIndex((value) => value.id === event.before.id);
          if (at < 0) {
            message("该条已删除，先在冲突处理或 JSON 中恢复。");
            return;
          }
          editor.replaceRows(at, 1, [clone(event.before)], "恢复历史版本");
          editor.go(at);
          message("历史内容已载入，会作为一次新修改同步。");
        };
        item.append(button);
      }
      list.append(item);
    }
  });
  function initialize() {
    renderConnections();
    editControls();
    setInterval(() => {
      void poll();
    }, 5e3);
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      if (params.has("subtitleGroup")) {
        window.history.replaceState(null, "", location.pathname + location.search);
        if (server(params.get("backend") || defaultServer) !== defaultServer) throw Error("这个邀请不属于当前字幕网站，请向组长索取本网站的邀请");
        state.server = defaultServer;
        $("cloudJoinGroup").value = params.get("subtitleGroup");
        $("cloudJoinCode").value = params.get("invite") || "";
        $("cloudPanel").open = true;
        $("cloudJoinDetails").open = true;
        message("邀请已填写，输入昵称后点“加入字幕组”。");
      }
    } catch (error) {
      message("邀请链接无法解析：" + error.message);
    }
  }
  editor.setCallbacks({ onChange: changed, onRender: editControls });
  window.addEventListener("beforeunload", (event) => {
    if (active() && (state.conflicts.length || state.dirty)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  document.addEventListener("keydown", (event) => {
    if (active() && (state.session.member.role === "viewer" || state.conflicts.length) && (event.key === "[" || event.key === "]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  void editor.ready.then(initialize);
}
export {
  initCollaboration
};
