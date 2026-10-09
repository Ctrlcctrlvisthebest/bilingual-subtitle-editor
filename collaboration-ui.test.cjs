const assert = require('node:assert/strict');

const server = 'https://bilingual-subtitle-editor.zoeli2010xl.workers.dev';
const groupA = '00000000-0000-4000-8000-000000000001.' + 'b'.repeat(64);
const groupB = '00000000-0000-4000-8000-000000000002.' + 'c'.repeat(64);
const token = 'a'.repeat(64);
const leaderKey = group => 'sg1_' + group + '.' + token;
const response = data => ({ok: true, json: async () => structuredClone(data)});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = id => ({id, start: 1, end: 2, zh: '字幕 ' + id, en: id, speaker: 'Unknown', status: '疑点待听校', note: ''});
const snapshot = (id, title) => ({
  project: {version: 1, editor_id: 'shared-' + id, title, rows: [row('a'), row('b')], colors: {Unknown: '#455a64'}, appearance: {mode: 'outline'}},
  rowVersions: {a: 1, b: 1}, metaVersion: 1, orderVersion: 1, revision: 1
});
const snapshots = new Map([['project-a', snapshot('project-a', '甲组工程')], ['project-b', snapshot('project-b', '乙组工程')]]);
const elements = new Map(), stored = new Map(), requests = [], timers = new Map(), waiting = [], draftData = new Map();
const element = () => ({
  value: '', hidden: false, disabled: false, type: 'password', textContent: '', children: [],
  replaceChildren(...children) {this.children = children;}, append(...children) {this.children.push(...children);},
  setAttribute() {}, focus() {}, select() {}, scrollIntoView() {}
});
const $ = id => {
  if (!elements.has(id)) elements.set(id, element());
  return elements.get(id);
};
let role = 'owner', copied = '', timerId = 0, copiedProjectCount = 0, draftWriteCount = 0, holdWrites = false, failWrites = false;
const heldWrites = [];
const writeStarted = deferred();
let poll;
const groupData = group => ({
  groupName: group === groupA ? '甲字幕组' : '乙字幕组', member: {id: 'owner-' + group.slice(0, 36), name: '测试组长', role},
  members: [{id: 'owner-' + group.slice(0, 36), name: '测试组长', role, last_seen: Date.now()}],
  projects: [{id: group === groupA ? 'project-a' : 'project-b', title: group === groupA ? '甲组工程' : '乙组工程', count: 2, updatedBy: '组长'}]
});
function delayRequest(method, route) {
  const result = deferred(), started = deferred();
  waiting.push({method, route, result, started});
  return {resolve: data => result.resolve(response(data)), reject: result.reject, started: started.promise};
}
const localProject = {version: 1, editor_id: 'blank', title: '空白', rows: [], colors: {}, appearance: {mode: 'outline'}};
let currentProject = localProject, selected = 0, callbacks, activated = [], nextActivation;
const editor = {
  ready: Promise.resolve(),
  getProject: () => currentProject, getIndex: () => selected,
  setCallbacks(value) {callbacks = value;},
  async activateProject(value, {canApply}) {
    const pending = nextActivation;
    nextActivation = null;
    if (pending) {pending.started.resolve(); await pending.release.promise;}
    if (!await canApply()) return false;
    currentProject = structuredClone(value); selected = 0; activated.push(value.editor_id); this.redraw();
    return true;
  },
  applyProject(value) {currentProject = structuredClone(value); this.redraw();},
  replaceRows(at, count, items) {currentProject.rows.splice(at, count, ...items); callbacks.onChange();},
  go(at) {selected = at; this.redraw();},
  redraw() {callbacks?.onRender();}, save() {}, notice(text) {$('notice').textContent = text;},
  download(name, text) {stored.set(name, text);}
};
Object.defineProperty(globalThis, 'navigator', {value: {clipboard: {async writeText(value) {copied = value;}}}, configurable: true});
Object.assign(globalThis, {
  location: {hostname: 'ctrlcctrlvisthebest.github.io', protocol: 'https:', origin: 'https://ctrlcctrlvisthebest.github.io', pathname: '/bilingual-subtitle-editor/', search: '', hash: '#subtitleGroup=' + groupA + '&backend=https%3A%2F%2Funtrusted.example&invite=invalid', href: 'https://ctrlcctrlvisthebest.github.io/bilingual-subtitle-editor/'},
  setTimeout(fn, ms) {const id = ++timerId; timers.set(id, {fn, ms}); return id;}, clearTimeout(id) {timers.delete(id);},
  setInterval(fn) {poll = fn; return 1;},
  localStorage: {getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value)},
  document: {getElementById: $, createElement: element, addEventListener() {}, hidden: false},
  window: {addEventListener() {}, history: {replaceState() {}}},
  indexedDB: {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          transaction() {
            const transaction = {
              objectStore() {
                return {
                  put(value) {
                    draftWriteCount++;
                    if (failWrites) {queueMicrotask(() => transaction.onabort()); return;}
                    const complete = () => {draftData.set(value.id, structuredClone(value)); transaction.oncomplete();};
                    if (holdWrites) {heldWrites.push(complete); writeStarted.resolve();}
                    else queueMicrotask(complete);
                  },
                  get(key) {
                    const result = {};
                    queueMicrotask(() => {result.result = draftData.get(key); result.onsuccess();});
                    return result;
                  }
                };
              }
            };
            return transaction;
          }
        };
        request.onsuccess();
      });
      return request;
    }
  },
  async fetch(url, options) {
    requests.push({url, options});
    const route = new URL(url).pathname.replace('/api/', '');
    const at = waiting.findIndex(item => item.method === options.method && item.route === route);
    if (at >= 0) {
      const item = waiting.splice(at, 1)[0]; item.started.resolve(); return item.result.promise;
    }
    if (route === 'groups') return response({groupId: groupA, token, ...groupData(groupA)});
    const group = route.split('/')[1];
    if (route.endsWith('/presence')) return response({ok: true});
    if (route.includes('/projects/')) {
      const id = route.split('/')[3];
      if (options.method === 'PATCH') {
        const patch = JSON.parse(options.body), value = structuredClone(snapshots.get(id));
        for (const change of patch.changes) {
          const index = value.project.rows.findIndex(item => item.id === change.id);
          if (change.row) value.project.rows[index] = change.row;
        }
        value.revision++; snapshots.set(id, value); return response(value);
      }
      return response(snapshots.get(id));
    }
    return response(groupData(group));
  }
});

async function connect(group) {
  $('cloudLeaderLogin').value = leaderKey(group);
  await $('cloudLeaderConnect').onclick();
}
async function openProject(id) {
  $('cloudProjects').value = id;
  await $('cloudOpen').onclick();
}
async function runDebounce() {
  const entry = [...timers].find(([, timer]) => timer.ms < 20000);
  assert(entry, 'Expected a queued draft/sync timer');
  timers.delete(entry[0]);
  await entry[1].fn();
}

(async () => {
  const {initCollaboration} = await import('./collaboration.js');
  initCollaboration(editor);
  await tick();
  assert($('cloudStatus').textContent.includes('不属于当前字幕网站'));
  $('cloudNewName').value = '甲字幕组'; $('cloudNickname').value = '测试组长';
  await $('cloudCreate').onclick();
  assert.deepEqual(JSON.parse(requests[0].options.body), {name: '甲字幕组', memberName: '测试组长'});
  assert.equal($('cloudCreate').disabled, false);
  assert.equal($('cloudOwnerKey').value, leaderKey(groupA));
  assert.equal($('cloudOwnerKey').type, 'password');
  assert.equal($('cloudLeaderTools').hidden, false);
  await $('cloudCopyLeaderKey').onclick(); assert.equal(copied, leaderKey(groupA));
  await $('cloudDisconnect').onclick(); assert.equal($('cloudOwnerKey').value, '');
  requests.length = 0;
  await connect(groupA);
  assert(requests.every(item => item.options.method === 'GET'));
  assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal($('cloudLeaderLogin').value, '');
  await $('cloudDisconnect').onclick(); role = 'viewer';
  await connect(groupA);
  assert($('cloudStatus').textContent.includes('不是组长密钥'));
  assert.equal($('cloudOwnerKey').value, '');
  role = 'owner'; await connect(groupA);
  await openProject('project-a');

  // A late group response cannot change B's credentials, name, member list or picker.
  const oldRefresh = delayRequest('GET', 'groups/' + groupA);
  const refreshing = $('cloudRefresh').onclick();
  await oldRefresh.started;
  await connect(groupB);
  const statusB = $('cloudStatus').textContent;
  oldRefresh.resolve({...groupData(groupA), member: {...groupData(groupA).member, role: 'viewer'}});
  await refreshing;
  assert($('cloudGroupName').textContent.startsWith('乙字幕组'));
  assert.equal($('cloudOwnerKey').value, leaderKey(groupB));
  assert.equal($('cloudProjects').value, 'project-b');
  assert.equal($('cloudStatus').textContent, statusB);

  // A delayed project fetch cannot activate A or post A's presence after connecting B.
  await connect(groupA);
  const oldOpen = delayRequest('GET', 'groups/' + groupA + '/projects/project-a');
  $('cloudProjects').value = 'project-a';
  const opening = $('cloudOpen').onclick();
  await oldOpen.started;
  await connect(groupB); await openProject('project-b');
  const activationCount = activated.length, requestCount = requests.length;
  oldOpen.resolve(snapshots.get('project-a'));
  await opening;
  assert.equal(currentProject.editor_id, 'shared-project-b');
  assert.equal(activated.length, activationCount);
  assert.equal(requests.length, requestCount);
  assert($('cloudGroupName').textContent.startsWith('乙字幕组'));

  // The editor can finish its old-project local save after the cloud session changes.
  await connect(groupA);
  const activation = {started: deferred(), release: deferred()};
  nextActivation = activation;
  const pendingActivation = openProject('project-a');
  await activation.started.promise;
  await connect(groupB); await openProject('project-b');
  const beforeStaleActivation = activated.length;
  activation.release.resolve();
  await pendingActivation;
  assert.equal(currentProject.editor_id, 'shared-project-b');
  assert.equal(activated.length, beforeStaleActivation);

  // Edits made while the editor flushes its old project must save before activation.
  const blockedActivation = {started: deferred(), release: deferred()};
  nextActivation = blockedActivation;
  const reopening = openProject('project-b');
  await blockedActivation.started.promise;
  currentProject.rows[0].zh = '等待切换时继续输入'; callbacks.onChange();
  failWrites = true;
  const beforeFailedActivation = activated.length;
  blockedActivation.release.resolve();
  await reopening;
  assert.equal(activated.length, beforeFailedActivation);
  assert.equal(currentProject.rows[0].zh, '等待切换时继续输入');
  assert($('cloudStatus').textContent.includes('暂未切换工程'));
  failWrites = false;
  await $('cloudSaveNow').onclick();

  // Superseded failures must not report an error or remove the current group's edit rights.
  const oldPoll = delayRequest('GET', 'groups/' + groupB + '/projects/project-b');
  const polling = poll();
  await oldPoll.started;
  await connect(groupA); await openProject('project-a');
  const freshStatus = $('cloudStatus').textContent;
  oldPoll.reject(Object.assign(Error('旧会话失效'), {status: 401}));
  await polling; await tick();
  assert.equal($('cloudStatus').textContent, freshStatus);
  assert.equal($('cloudSaveNow').disabled, false);

  // Keystrokes only queue work; copying a full project and draft writes happen after debounce.
  const beforeWrites = draftWriteCount;
  const oldStringify = JSON.stringify;
  JSON.stringify = function(value, ...args) {
    if (value === currentProject || value?.editor_id === currentProject.editor_id && Array.isArray(value.rows)) copiedProjectCount++;
    return oldStringify(value, ...args);
  };
  for (const text of ['一', '一段', '一段修改']) {
    currentProject.rows[0].zh = text; callbacks.onChange();
  }
  assert.equal(copiedProjectCount, 0);
  assert.equal(draftWriteCount, beforeWrites);
  JSON.stringify = oldStringify;
  await runDebounce();
  assert.equal(snapshots.get('project-a').project.rows[0].zh, '一段修改');
  assert(draftWriteCount > beforeWrites);

  // Disconnect waits for an already running draft write, then saves later edits before leaving.
  currentProject.rows[0].zh = '切组前草稿'; callbacks.onChange();
  holdWrites = true;
  const saving = runDebounce();
  await writeStarted.promise;
  currentProject.rows[0].zh = '保存期间继续输入'; callbacks.onChange();
  let disconnected = false;
  const leaving = $('cloudDisconnect').onclick().then(() => {disconnected = true;});
  await tick(); assert.equal(disconnected, false);
  currentProject.rows[0].zh = '断开等待期间最新输入'; callbacks.onChange();
  holdWrites = false;
  heldWrites.shift()();
  await saving; await leaving;
  const draftId = server + '|' + groupA + '|' + groupData(groupA).member.id + '|project-a';
  assert.equal(draftData.get(draftId).project.rows[0].zh, '断开等待期间最新输入');
  assert.equal($('cloudOwnerKey').value, '');

  // Detached edits still save once at the debounce boundary and restore through normal UI.
  currentProject.rows[0].zh = '离线继续修改'; callbacks.onChange();
  await runDebounce();
  await connect(groupA); await openProject('project-a');
  assert.equal(currentProject.rows[0].zh, '离线继续修改');
  failWrites = true;
  currentProject.rows[0].zh = '存储失败保留修改'; callbacks.onChange();
  await $('cloudDisconnect').onclick();
  assert($('cloudStatus').textContent.includes('暂未断开连接'));
  assert.equal($('cloudOwnerKey').value, leaderKey(groupA));
  assert.equal(currentProject.rows[0].zh, '存储失败保留修改');
  failWrites = false;
  await $('cloudDisconnect').onclick();
  assert.equal($('cloudOwnerKey').value, '');
  assert(requests.every(item => item.url.startsWith(server + '/')));
  assert(!JSON.stringify(currentProject).includes(token));
  console.log('通过：组长密钥与权限、会话切换隔离（刷新/打开/轮询）、输入防抖、切组等待草稿、离线草稿恢复。');
})().catch(error => {console.error(error); process.exitCode = 1;});
