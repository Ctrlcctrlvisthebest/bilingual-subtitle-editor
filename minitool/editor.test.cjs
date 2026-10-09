const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TextEncoder, TextDecoder } = require('node:util');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const native = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepEqual(native(actual), native(expected));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const seed = { version: 1, revision: 1, editor_id: 'generic-blank', title: '空白字幕工程', rows: [], colors: { Unknown: '#455a64', Other: '#455a64' } };
const sample = { version: 1, revision: 1, editor_id: 'integration-a', title: '整合测试 A', colors: { Unknown: '#455a64', Alice: '#247c98' }, appearance: { mode: 'outline', order: 'zh-first', zhSize: 48, enSize: 42, outlineWidth: 3, font: 'Arial', bold: true }, rows: [
  { id: 'a', start: 10, end: 12, zh: '你好', en: 'Hello.', speaker: 'Alice', status: '疑点待听校', note: '首条备注' },
  { id: 'b', start: 14, end: 16, zh: '下一句', en: 'Next.', speaker: 'Unknown', status: '疑点待听校', note: '' }
] };

function nativeStorage(values = new Map()) {
  const settings = { hold: false, failWrite: null, pending: [], writes: [], savedImages: [], storageCalls: 0, albumResult: { success: true, errMsg: 'saveImageToPhotosAlbum:ok' } };
  function commit(options) {
    if (settings.failWrite && settings.failWrite(options.key, options.data)) return Promise.reject({ errMsg: 'setStorage:fail test quota', errCode: 1001 });
    values.set(options.key, options.data);
    return Promise.resolve({ errMsg: 'setStorage:ok' });
  }
  const miniTool = {
    setStorage(options) {
      settings.storageCalls += 1;
      settings.writes.push(native(options));
      if (!settings.hold) return commit(options);
      return new Promise((resolve, reject) => settings.pending.push({ options: native(options), resolve, reject }));
    },
    async getStorage(options) { return { errMsg: 'getStorage:ok', data: values.has(options.key) ? values.get(options.key) : null }; },
    async getStorageInfo() {
      const size = Array.from(values).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
      return { errMsg: 'getStorageInfo:ok', keys: Array.from(values.keys()), currentSize: size / 1024, limitSize: 10240 };
    },
    async removeStorage(options) { values.delete(options.key); return { errMsg: 'removeStorage:ok' }; },
    async getLaunchOptions() { return { errMsg: 'getLaunchOptions:ok', miniToolEnv: { buildVersion: 9460000 } }; },
    async saveImageToPhotosAlbum(options) { settings.savedImages.push(native(options)); return native(settings.albumResult); }
  };
  async function release() {
    settings.hold = false;
    const pending = settings.pending.splice(0);
    for (const task of pending) {
      try { task.resolve(await commit(task.options)); } catch (error) { task.reject(error); }
    }
    await nextTurn();
  }
  return { miniTool, settings, values, release };
}

function setup(source, initial = seed, device = nativeStorage()) {
  const elements = new Map(), documentEvents = {}, windowEvents = {}, timers = new Map();
  const diagnostics = { downloads: [], images: [], native: device, canvasBand: null, objectURLs: new Map(), revokedURLs: [], imageURLUses: [], reads: [] };
  let nextTimer = 1, created = 0;
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const events = {}, attributes = {}, classes = new Set();
    const item = {
      id, value: '', style: {}, textContent: '', checked: false, disabled: false, hidden: false,
      selectionStart: 0, selectionEnd: 0, clientWidth: 1000, children: [], files: [], open: false,
      className: '', tagName: 'DIV', attributes, events,
      classList: { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, contains(name) { return classes.has(name); }, toggle(name, force) { const yes = force === undefined ? !classes.has(name) : force; if (yes) classes.add(name); else classes.delete(name); return yes; } },
      replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); return child; }, append(...children) { this.children.push(...children); }, remove() {},
      setAttribute(name, value) { attributes[name] = String(value); }, getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; }, removeAttribute(name) { delete attributes[name]; },
      addEventListener(name, fn) { (events[name] || (events[name] = [])).push(fn); },
      removeEventListener(name, fn) { events[name] = (events[name] || []).filter(item => item !== fn); },
      async fire(name, extra = {}) {
        const event = Object.assign({ target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; } }, extra);
        const method = this['on' + name];
        if (typeof method === 'function') await method.call(this, event);
        for (const fn of events[name] || []) await fn.call(this, event);
      },
      click() { if (this.download) diagnostics.downloads.push(this.download); return this.fire('click'); },
      closest() { return null; }, querySelectorAll() { return []; }, focus() {}, select() {}, scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; }
    };
    Object.defineProperty(item, 'src', {
      configurable: true,
      get() { return this.getAttribute('src') || ''; },
      set(value) {
        if (typeof value === 'string' && value.startsWith('blob:')) {
          assert.equal(id, 'miniBackupPreview', 'blob URL is allowed only on the PNG preview image');
          assert.ok(diagnostics.objectURLs.has(value), 'preview refers to an owned PNG object URL');
          diagnostics.imageURLUses.push(value);
        }
        this.setAttribute('src', value);
      }
    });
    elements.set(id, item);
    return item;
  }
  const player = element('video');
  Object.assign(player, { currentTime: 0, duration: 100, readyState: 4, paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {} });
  element('initial').textContent = JSON.stringify(initial);
  element('offsetSeconds').value = '0'; element('offsetScope').value = 'all'; element('fineStep').value = '0.1'; element('importOrder').value = 'auto';
  const localValues = new Map();
  const localStorage = { get length() { return localValues.size; }, key(i) { return Array.from(localValues.keys())[i] || null; }, getItem(key) { return localValues.has(key) ? localValues.get(key) : null; }, setItem(key, value) { localValues.set(key, String(value)); }, removeItem(key) { localValues.delete(key); } };
  const document = {
    getElementById: element, body: element('body'), documentElement: element('html'), readyState: 'complete',
    addEventListener(name, fn) { (documentEvents[name] || (documentEvents[name] = [])).push(fn); }, querySelectorAll() { return []; },
    createElement(type) {
      const node = element('created-' + ++created); node.tagName = type.toUpperCase();
      if (type === 'canvas') {
        node.width = 0; node.height = 0;
        node.getContext = () => ({ fillRect() {}, fillText() {}, measureText(text) { return { width: text.length * 10 }; }, createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; }, putImageData(data) { diagnostics.canvasBand = data; }, drawImage() {}, getImageData() { return diagnostics.canvasBand; } });
        node.toDataURL = () => { throw new Error('miniTool backup UI must export a Blob instead of a data URL'); };
        node.toBlob = (callback, type) => {
          assert.equal(type, 'image/png'); diagnostics.images.push(node);
          setImmediate(() => callback(new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })));
        };
      }
      return node;
    }
  };
  class FileReader {
    readAsDataURL(blob) {
      diagnostics.reads.push({ kind: 'dataURL', type: blob.type, size: blob.size });
      blob.arrayBuffer().then(buffer => {
        this.result = 'data:' + blob.type + ';base64,' + Buffer.from(buffer).toString('base64');
        if (this.onload) this.onload();
      }, error => { this.error = error; if (this.onerror) this.onerror(); });
    }
    readAsArrayBuffer(blob) {
      diagnostics.reads.push({ kind: 'arrayBuffer', type: blob.type, size: blob.size });
      blob.arrayBuffer().then(buffer => { this.result = buffer; if (this.onload) this.onload(); }, error => { this.error = error; if (this.onerror) this.onerror(); });
    }
  }
  const context = { document, localStorage, xhs: { launchOptions: { miniToolEnv: { buildVersion: 9460000 } }, miniTool: device.miniTool }, console, TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, FileReader, URL: {
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob, 'only a PNG Blob can make an object URL');
      assert.equal(blob.type, 'image/png', 'video and subtitle object URLs remain blocked');
      const url = 'blob:mini-backup-' + (diagnostics.objectURLs.size + 1);
      diagnostics.objectURLs.set(url, blob); return url;
    },
    revokeObjectURL(url) { assert.ok(diagnostics.objectURLs.has(url)); diagnostics.revokedURLs.push(url); }
  }, Blob,
    crypto: require('node:crypto').webcrypto, navigator: { userAgent: 'miniTool integration test' }, location: { protocol: 'https:', search: '', href: 'https://local-test.invalid/' },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay: Number(delay) || 0 }); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { (windowEvents[name] || (windowEvents[name] = [])).push(fn); }, removeEventListener(name, fn) { windowEvents[name] = (windowEvents[name] || []).filter(item => item !== fn); }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'assets/app.js' });
  const run = code => vm.runInContext(code, context);
  async function tick(maxDelay = 1000) {
    const due = Array.from(timers).filter(([, timer]) => timer.delay <= maxDelay);
    due.forEach(([id]) => timers.delete(id));
    for (const [, timer] of due) await timer.fn();
    await nextTurn();
  }
  async function until(predicate, description) {
    for (let tries = 0; tries < 30; tries++) { if (predicate()) return; await nextTurn(); }
    assert.fail('Timed out waiting for ' + description);
  }
  return { el: element, player, run, tick, until, diagnostics, device, context, events: { document: documentEvents, window: windowEvents }, editor: context.MiniEditor, ready: context.MiniEditor && context.MiniEditor.ready };
}

// The checks below run the built, transpiled miniTool application, including its
// persistence and runtime adapters, rather than loading the desktop editor.
let bundlePath = process.env.MINITOOL_BUNDLE || process.argv[2];
if (!bundlePath) {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'minitool-editor-test-'));
  process.on('exit', () => fs.rmSync(destination, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'build-minitool.mjs'), destination], { stdio: 'pipe' });
  bundlePath = path.join(destination, 'assets', 'app.js');
}
if (!fs.existsSync(bundlePath)) throw new Error('请先运行 node build-minitool.mjs；未找到生成的 assets/app.js：' + bundlePath);
const appSource = fs.readFileSync(bundlePath, 'utf8');
async function app(device) {
  const instance = setup(appSource, seed, device);
  assert.ok(instance.editor, 'built app exposes MiniEditor');
  assert.ok(instance.ready && typeof instance.ready.then === 'function', 'MiniEditor.ready exposes async initialization');
  await instance.ready;
  return instance;
}
async function edit(instance, id, value, event = 'input') {
  instance.el(id).value = value;
  await instance.el(id).fire(event);
}
async function loadSample(instance, project = sample) {
  await instance.editor.importText(JSON.stringify(project), 'json');
}
const srtText = '1\n00:00:01,250 --> 00:00:02,750\n你好，世界 🌏\nHello, world!\n\n2\n00:00:03,500 --> 00:00:05,000\nEnglish only.\n';
const assText = '[Script Info]\nScriptType: v4.00+\n; BilingualEditorAppearance: {"mode":"outline","order":"en-first","zhSize":50,"enSize":40,"outlineWidth":4,"font":"Arial","bold":true}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Narrator,Arial,50,&H00FFFFFF,&H00FFFFFF,&H00987c24,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,60,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:04.25,0:00:06.75,Narrator,Alice,0,0,0,,{\\fs40}Hello Alice!\\N{\\fs50}你好艾丽丝\n';

test('built miniTool imports SRT text through the UI with bilingual timing and safe defaults', async () => {
  const a = await app();
  a.el('miniImportText').value = srtText;
  a.el('miniImportFormat').value = 'srt';
  await a.el('miniApplyImport').click();
  const project = a.editor.getProject();
  assert.equal(project.rows.length, 2);
  same(project.rows.map(row => ({ start: row.start, end: row.end, zh: row.zh, en: row.en, speaker: row.speaker })), [
    { start: 1.25, end: 2.75, zh: '你好，世界 🌏', en: 'Hello, world!', speaker: 'Unknown' },
    { start: 3.5, end: 5, zh: '', en: 'English only.', speaker: 'Unknown' }
  ]);
  assert.equal(a.el('miniImportText').value, '');
  assert.equal(a.el('miniImportPanel').hidden, true);
  assert.match(a.editor.buildSRT(), /00:00:01,250 --> 00:00:02,750\n你好，世界 🌏\nHello, world!/);
  assert.equal(a.diagnostics.downloads.length, 0);
});

test('ASS text import preserves bilingual text, role colors, timing, and editor appearance', async () => {
  const a = await app();
  await a.editor.importText(assText, 'ass');
  const project = a.editor.getProject(), row = project.rows[0];
  same({ start: row.start, end: row.end, zh: row.zh, en: row.en, speaker: row.speaker }, { start: 4.25, end: 6.75, zh: '你好艾丽丝', en: 'Hello Alice!', speaker: 'Alice' });
  assert.equal(project.colors.Alice.toLowerCase(), '#247c98');
  assert.equal(project.appearance.order, 'en-first');
  assert.equal(project.appearance.outlineWidth, 4);
  assert.match(a.editor.buildASS(), /0:00:04\.25,0:00:06\.75,.*Alice/);
  assert.match(a.editor.buildSRT(), /Hello Alice!\n你好艾丽丝/);
});

test('JSON text import keeps editable bilingual rows, roles, notes, and unknown metadata', async () => {
  const a = await app();
  const project = native(sample);
  project.rows[0].status = '已校对';
  project.rows[0].verification = { translation: 'user_reviewed', audio: 'pending' };
  project.rows[0].custom = { source: 'fixture' };
  project.extra = { styles: ['speaker', 'outline'], license: 'test-only' };
  await loadSample(a, project);
  const imported = a.editor.getProject();
  assert.equal(imported.editor_id, project.editor_id);
  same(imported.rows, project.rows);
  same(imported.appearance, project.appearance);
  same(imported.colors, Object.assign({ Other: '#455a64' }, project.colors));
  same(imported.extra, project.extra);
  await a.el('miniJSON').click();
  const exported = JSON.parse(a.el('miniExportText').value);
  same(exported.rows, imported.rows);
  assert.equal(a.el('miniExportPanel').hidden, false);
  assert.equal(a.diagnostics.downloads.length, 0);
});

test('DOM editing coalesces text undo, preserves roles and notes, and micro-adjusts time', async () => {
  const a = await app();
  await loadSample(a);
  await a.el('zhEdit').fire('focus');
  await edit(a, 'zhEdit', '我的');
  await edit(a, 'zhEdit', '我的修订 🐱');
  assert.equal(a.editor.getProject().rows[0].zh, '我的修订 🐱');
  await a.el('undo').click();
  assert.equal(a.editor.getProject().rows[0].zh, '你好');
  await edit(a, 'note', '听校备注');
  await edit(a, 'status', '已校对');
  const checked = a.editor.getProject().rows[0];
  assert.equal(checked.note, '听校备注');
  assert.equal(checked.speaker, 'Alice');
  assert.equal(checked.verification.translation, 'user_reviewed');
  await a.el('startMinus').click();
  assert.equal(a.editor.getProject().rows[0].start, 9.9);
  await a.el('undo').click();
  assert.equal(a.editor.getProject().rows[0].start, 10);
  await edit(a, 'start', '12', 'change');
  assert.equal(a.editor.getProject().rows[0].start, 10, 'invalid time cannot replace a valid row');
  assert.match(a.el('msg').textContent, /本次修改未应用/);
  await edit(a, 'fineStep', '0.01', 'change');
  await a.el('endPlus').click();
  assert.equal(a.editor.getProject().rows[0].end, 12.01);
  await a.editor.flush();
  const saved = await a.context.MiniProjectStore.get(sample.editor_id);
  assert.equal(saved.rows[0].note, '听校备注');
  assert.equal(saved.rows[0].end, 12.01);
});

test('failed native save keeps edits visible, reports failure, and can retry successfully', async () => {
  const a = await app();
  await loadSample(a);
  await a.editor.flush();
  const previous = await a.context.MiniProjectStore.get(sample.editor_id);
  a.device.settings.failWrite = key => key.endsWith(':manifest');
  await edit(a, 'zhEdit', '尚未提交的修订');
  assert.equal(await a.editor.flush(), false);
  assert.equal(a.editor.getProject().rows[0].zh, '尚未提交的修订');
  assert.match(a.el('storageNotice').textContent, /保存未成功/);
  assert.equal(a.el('storageNotice').className, 'warning');
  assert.doesNotMatch(a.el('msg').textContent, /已保存到本机/);
  assert.equal((await a.context.MiniProjectStore.get(sample.editor_id)).rows[0].zh, previous.rows[0].zh, 'failed commit retains prior durable version');
  a.device.settings.failWrite = null;
  assert.equal(await a.editor.flush(), true);
  assert.equal((await a.context.MiniProjectStore.get(sample.editor_id)).rows[0].zh, '尚未提交的修订');
  assert.match(a.el('msg').textContent, /已保存到本机/);
});

test('switching two projects during a pending native save retains the latest edits in each', async () => {
  const a = await app();
  const second = native(sample); second.editor_id = 'integration-b'; second.title = '整合测试 B'; second.rows[0].zh = 'B 原始字幕';
  await loadSample(a, sample); await a.editor.flush();
  await loadSample(a, second); await a.editor.flush();
  await a.editor.activate(sample);
  await edit(a, 'zhEdit', 'A 第一轮修改');
  a.device.settings.hold = true;
  const firstSave = a.editor.flush();
  await a.until(() => a.device.settings.pending.length > 0, 'first native write to be suspended');
  await edit(a, 'enEdit', 'A edit made after save began');
  const switchToB = a.editor.activate(second);
  await nextTurn();
  await a.device.release();
  await firstSave; await switchToB;
  assert.equal(a.editor.getProject().editor_id, second.editor_id);
  await edit(a, 'zhEdit', 'B 独立修订');
  await a.editor.flush();
  const savedA = await a.context.MiniProjectStore.get(sample.editor_id);
  const savedB = await a.context.MiniProjectStore.get(second.editor_id);
  assert.equal(savedA.rows[0].zh, 'A 第一轮修改');
  assert.equal(savedA.rows[0].en, 'A edit made after save began');
  assert.equal(savedB.rows[0].zh, 'B 独立修订');
  await a.editor.activate(savedA);
  assert.equal(a.editor.getProject().rows[0].en, 'A edit made after save began');
  await a.editor.activate(savedB);
  assert.equal(a.editor.getProject().rows[0].zh, 'B 独立修订');
  await a.editor.flush();
  const reloaded = await app(nativeStorage(a.device.values));
  assert.equal(reloaded.editor.getProject().editor_id, second.editor_id);
  assert.equal(reloaded.editor.getProject().rows[0].zh, 'B 独立修订');
});

test('backup PNG generation captures current unsaved edits and native saving requires its button', async () => {
  const a = await app();
  await loadSample(a);
  await edit(a, 'zhEdit', '备份图中的当前修订 🌏');
  await edit(a, 'note', '这条还在等待自动保存');
  const expected = {...native(a.editor.getProject()), id: a.editor.getProject().editor_id, lastIndex: a.editor.getIndex()};
  const clicked = a.el('backupImage').click();
  await a.tick(20); await clicked;
  assert.equal(a.el('miniBackupPanel').hidden, false);
  assert.match(a.el('miniBackupPreview').src, /^blob:mini-backup-/);
  assert.equal(a.diagnostics.imageURLUses.length, 1);
  assert.equal(a.diagnostics.objectURLs.get(a.el('miniBackupPreview').src).type, 'image/png');
  const band = a.diagnostics.canvasBand;
  const backedUp = a.context.SubtitleBackup.decodeBand(band.data, 720, band.height);
  same(backedUp, expected);
  assert.equal(a.device.settings.savedImages.length, 0, 'generating a preview cannot save to photos automatically');
  await a.el('miniSaveBackupImage').click();
  assert.equal(a.device.settings.savedImages.length, 1);
  assert.match(a.device.settings.savedImages[0].filePath, /^data:image\/png;base64,/);
  await edit(a, 'zhEdit', '生成备份之后又修改');
  await a.el('miniSaveBackupImage').click();
  assert.equal(a.device.settings.savedImages.length, 1, 'stale backup cannot be saved as current');
  assert.match(a.el('msg').textContent, /工程已有新修改/);
});

test('a resolved native album failure never reports that the original backup was saved', async () => {
  const a = await app();
  await loadSample(a);
  const clicked = a.el('backupImage').click(); await a.tick(20); await clicked;
  a.device.settings.albumResult = { success: false, errMsg: 'saveImageToPhotosAlbum:fail synthetic permission denied' };
  await a.el('miniSaveBackupImage').click();
  assert.equal(a.device.settings.savedImages.length, 1);
  assert.match(a.el('msg').textContent, /操作未完成/);
  assert.doesNotMatch(a.el('msg').textContent, /已保存到相册/);
});

test('a failed backup regeneration cannot label the previous PNG as the current edited project', async () => {
  const a = await app();
  await loadSample(a);
  const first = a.el('backupImage').click(); await a.tick(20); await first;
  const oldPreview = a.el('miniBackupPreview').src;
  await edit(a, 'zhEdit', '旧备份生成后新增的修改');
  a.context.SubtitleBackup.encodeBlob = () => Promise.reject(new Error('生成 PNG 备份文件失败'));
  const failed = a.el('backupImage').click(); await a.tick(20); await failed;
  assert.match(a.el('msg').textContent, /生成 PNG 备份文件失败/);
  assert.equal(a.el('miniBackupPreview').src, oldPreview, 'previous preview still corresponds to its original snapshot');
  await a.el('miniSaveBackupImage').click();
  assert.equal(a.device.settings.savedImages.length, 0, 'a failed new render cannot authorize saving the old PNG as the current project');
  assert.match(a.el('msg').textContent, /工程已有新修改|请先生成备份图/);
  assert.equal(a.editor.getProject().rows[0].zh, '旧备份生成后新增的修改');
});

test('replacement video takes over before old cleanup finishes and a project switch stays intact', async () => {
  const a = await app();
  await loadSample(a);
  let releaseOld, oldReleaseCalls = 0;
  const oldHandle = { src: 'native-test://first.mp4', release() { oldReleaseCalls++; return new Promise(resolve => { releaseOld = resolve; }); } };
  const replacement = { src: 'native-test://replacement.mp4', async release() {} };
  a.context.MiniVideo.load = async file => file.name === 'first.mp4' ? oldHandle : replacement;
  async function selectVideo(name) { return a.el('videoFile').fire('change', { target: { files: [{ name }], value: name } }); }
  await selectVideo('first.mp4');
  assert.equal(a.player.src, oldHandle.src);
  let replacementCompleted = false;
  const secondSelection = selectVideo('replacement.mp4').then(() => { replacementCompleted = true; });
  await a.until(() => oldReleaseCalls === 1 && replacementCompleted, 'new video to take over without awaiting old native cleanup');
  assert.equal(a.player.src, replacement.src);
  assert.equal(a.editor.getProject().mediaName, 'replacement.mp4');
  const nextProject = native(sample); nextProject.editor_id = 'media-project-b'; nextProject.title = 'Media B'; delete nextProject.mediaName;
  await a.editor.activate(nextProject);
  assert.equal(a.player.src, '');
  releaseOld(); await secondSelection; await nextTurn();
  assert.equal(a.editor.getProject().editor_id, nextProject.editor_id);
  assert.equal(a.player.src, '', 'old cleanup cannot attach a prior project video after the switch');
  assert.equal(a.editor.getProject().mediaName, undefined);
});

test('invalid text import leaves the current project and native snapshots intact', async () => {
  const a = await app();
  await loadSample(a); await a.editor.flush();
  const before = a.editor.getProject(), writes = a.device.settings.writes.length;
  await assert.rejects(a.editor.importText('1\ninvalid timing\nBroken', 'srt'), /缺少时间轴/);
  await assert.rejects(a.editor.importText('{"version":1,"rows":[{"start":2,"end":1}]}', 'json'), /无效起止时间/);
  await assert.rejects(a.editor.importText(srtText, 'txt'), /请选择 SRT/);
  same(a.editor.getProject(), before);
  assert.equal(a.device.settings.writes.length, writes);
});
