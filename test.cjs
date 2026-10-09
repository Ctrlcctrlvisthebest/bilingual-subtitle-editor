const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {buildSync} = require('esbuild');
const native = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => {resolve = yes;});
  return {promise, resolve};
};
const source = buildSync({
  stdin: {contents: "import {createEditor} from './editor.js'; import * as formats from './subtitle-formats.js'; globalThis.testAPI = {createEditor,...formats};", resolveDir: __dirname},
  bundle: true, write: false, format: 'iife', platform: 'browser'
}).outputFiles[0].text;
const sample = {version: 1, editor_id: 'a', title: '测试 A', colors: {Unknown: '#455a64', Alice: '#247c98'}, rows: [
  {id: 'one', start: 10, end: 12, zh: '你好', en: 'Hello.', speaker: 'Alice', status: '疑点待听校', note: ''},
  {id: 'two', start: 14, end: 16, zh: '下一句', en: 'Next.', speaker: 'Unknown', status: '疑点待听校', note: ''}
]};
function setup(options = {}) {
  const elements = new Map(), events = {}, windowEvents = {}, saved = new Map(), writes = [];
  const document = {activeElement: null, getElementById: el, createElement: () => el('created-' + elements.size), addEventListener(name, fn) {events[name] = fn;}};
  function el(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = {}, attrs = {};
    const item = {id, value: '', checked: false, style: {}, textContent: '', clientWidth: 1000, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
      addEventListener(name, fn) {(handlers[name] ||= []).push(fn);}, removeEventListener(name, fn) {handlers[name] = (handlers[name] || []).filter(x => x !== fn);},
      async fire(name, extra = {}) {for (const fn of handlers[name] || []) await fn({target: this, preventDefault() {}, ...extra});},
      click() {return this.fire('click');}, replaceChildren(...children) {this.children = children;},
      setAttribute(name, value) {attrs[name] = value;}, getAttribute(name) {return attrs[name] || null;}, removeAttribute(name) {delete attrs[name];}, closest() {return null;},
      focus() {document.activeElement = this;}, setSelectionRange(start, end, direction) {this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;}
    };
    elements.set(id, item);
    return item;
  }
  const player = el('video');
  Object.assign(player, {currentTime: 0, duration: 100, readyState: 4, paused: true, play() {this.paused = false; return Promise.resolve();}, pause() {this.paused = true;}, load() {}});
  el('fineStep').value = '0.1'; el('offsetSeconds').value = '0'; el('offsetScope').value = 'all'; el('importOrder').value = 'auto';
  const store = {
    async init(project) {saved.set(project.editor_id, native(project)); if (options.init) await options.init();},
    save(project, index) {writes.push({id: project.editor_id, index}); saved.set(project.editor_id, {...native(project), lastIndex: index});},
    flush: options.flush || (async () => true),
    get: async id => saved.has(id) ? native(saved.get(id)) : null,
    list: () => [...saved.values()].map(p => ({id: p.editor_id, title: p.title})),
    getLastId: options.getLastId || (async () => null)
  };
  const context = {document, window: {addEventListener(name, fn) {windowEvents[name] = fn;}}, console, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout};
  vm.createContext(context);
  vm.runInContext(source, context);
  const editor = context.testAPI.createEditor({initialProject: native(options.initial || sample), store,
    loadMedia: options.loadMedia || (async () => ({src: 'test.mp4', release() {}})), output() {}, isExportOpen: () => el('videoExportDialog').open});
  return {editor, store, el, player, events, saved, writes, formats: context.testAPI, document};
}
async function edit(a, field, value, event = 'input') {a.el(field).value = value; await a.el(field).fire(event);}

test('one edit queues one save; navigation does not create a collaborative edit', async () => {
  const a = setup(); await a.editor.ready;
  let changes = 0;
  a.editor.setCallbacks({onChange() {changes++;}});
  const before = a.writes.length;
  await edit(a, 'zhEdit', '我的修订');
  assert.equal(a.writes.length - before, 1); assert.equal(changes, 1);
  a.editor.go(1);
  assert.equal(changes, 1); assert.equal(a.writes.at(-1).index, 1);
  a.editor.go(0);
  await edit(a, 'zhEdit', '连续输入');
  await a.el('undo').click();
  assert.equal(a.editor.getProject().rows[0].zh, '我的修订');
  a.player.currentTime = 20;
  const beforeAdd = a.writes.length;
  await a.el('add').click();
  assert.equal(a.writes.length - beforeAdd, 1);
  assert.equal(a.writes.at(-1).index, a.editor.getIndex());
  await a.el('undo').click();
  assert.equal(a.editor.getProject().rows.length, 2);
});

test('timing, keyboard guards, offset, split/merge and undo remain functional', async () => {
  const a = setup(); await a.editor.ready;
  const rows = () => a.editor.getProject().rows;
  a.player.currentTime = 10.123; await a.el('setStart').click();
  assert.equal(rows()[0].start, 10.123);
  await a.el('startMinus').click(); assert.equal(rows()[0].start, 10.023);
  await a.el('undo').click(); await a.el('undo').click(); assert.equal(rows()[0].start, 10);
  a.player.currentTime = 20; await a.el('setStart').click();
  assert.equal(rows()[0].start, 20); assert.equal(rows()[0].end, 22); await a.el('undo').click();
  a.el('offsetSeconds').value = '-11'; await a.el('applyOffset').click(); assert.equal(rows()[0].start, 10);
  a.el('offsetSeconds').value = '1.25'; await a.el('applyOffset').click();
  assert.equal(rows()[1].start, 15.25); assert.equal(rows()[0].end - rows()[0].start, 2); await a.el('undo').click();
  a.editor.go(1); a.el('offsetScope').value = 'following'; a.el('offsetSeconds').value = '-0.5';
  await a.el('applyOffset').click(); assert.equal(rows()[0].start, 10); assert.equal(rows()[1].start, 13.5); await a.el('undo').click();
  a.editor.go(0); a.player.currentTime = 11.2; await a.el('alignOffset').click(); assert.equal(Number(a.el('offsetSeconds').value), 1.2);
  await a.el('listenEnd').click(); assert.equal(a.player.currentTime, 11); assert.equal(a.player.paused, false);
  a.player.currentTime = 12.55; await a.player.fire('timeupdate'); assert.equal(a.player.paused, true); assert.equal(a.player.currentTime, 12.5);
  a.player.currentTime = 7; await a.el('forward5').click(); assert.equal(a.player.currentTime, 12);
  await a.el('backFine').click(); assert.equal(a.player.currentTime, 11.9);
  const key = (target, extra = {}) => a.events.keydown({key: 'ArrowRight', target, preventDefault() {}, ...extra});
  key(a.player, {shiftKey: true}); assert.equal(a.player.currentTime, 12);
  key({closest: () => ({})}); assert.equal(a.player.currentTime, 12);
  a.el('videoExportDialog').open = true; key(a.player); assert.equal(a.player.currentTime, 12); a.el('videoExportDialog').open = false;
  a.player.currentTime = 11; a.el('zhEdit').selectionStart = 1; a.el('enEdit').selectionStart = 3;
  await a.el('split').click(); assert.equal(rows().length, 3); assert.equal(rows()[1].start, 11);
  assert.equal(rows()[0].zh, '你'); assert.equal(rows()[1].zh, '好');
  await a.el('merge').click(); assert.equal(rows().length, 2); assert.equal(rows()[0].end, 12);
  await a.el('undo').click(); await a.el('undo').click(); assert.equal(rows()[0].zh, '你好');
});

test('outline/box styles and SRT/ASS round trips preserve text, speakers and timing', async () => {
  const a = setup(); await a.editor.ready;
  const before = JSON.stringify(a.editor.getProject().rows);
  assert.equal(a.el('sub').style.background, 'transparent');
  await edit(a, 'subtitleOrder', 'en-first', 'change'); await edit(a, 'outlineWidth', '4', 'change');
  assert.equal(JSON.stringify(a.editor.getProject().rows), before);
  const p = a.editor.getProject(), f = a.formats;
  assert.equal(a.el('en').style.order, '0'); assert.ok(f.buildSRT(p.rows, p).includes('Hello.\n你好'));
  const ass = f.buildASS(p.rows, p), parsed = f.parseASS(ass);
  assert.equal(parsed.appearance.order, 'en-first'); assert.equal(parsed.appearance.outlineWidth, 4); assert.equal(parsed.colors.Alice, '#247c98');
  assert.equal(parsed.rows[0].start, 10); assert.equal(parsed.rows[0].zh, '你好');
  await edit(a, 'subtitleMode', 'box', 'change'); assert.equal(a.el('sub').style.background, '#247c98');
  assert.ok(f.buildASS(p.rows, p).includes(',3,10,0,2,80,80,60,1'));
  await a.el('undo').click(); assert.equal(a.editor.getProject().appearance.mode, 'outline');
  const english = '1\n00:00:01,000 --> 00:00:02,000\nEnglish only.\n\n2\n00:00:03,000 --> 00:00:04,000\n中文字幕\nEnglish line.\n';
  await a.editor.importFile({name: 'Other.srt', text: async () => english});
  assert.equal(a.editor.getProject().rows[0].en, 'English only.'); assert.equal(a.editor.getProject().rows[0].zh, '');
  await a.editor.importFile({name: 'Roundtrip.ass', text: async () => ass});
  assert.equal(a.editor.getProject().appearance.outlineWidth, 4); assert.equal(a.editor.getProject().rows.length, 2);
});

test('remote refresh preserves focused text selection and project activation rejects obsolete requests', async () => {
  const a = setup(); await a.editor.ready;
  a.el('zhEdit').focus(); a.el('zhEdit').setSelectionRange(1, 2, 'forward');
  const changed = native(a.editor.getProject()); changed.rows[0].en = 'Revised remotely.';
  a.editor.applyProject(changed);
  assert.equal(a.document.activeElement.id, 'zhEdit'); assert.equal(a.el('zhEdit').selectionStart, 1); assert.equal(a.el('zhEdit').selectionEnd, 2);
  const gate = deferred();
  const first = a.editor.activateProject({...sample, editor_id: 'obsolete'}, {canApply: () => gate.promise});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await a.editor.activateProject({...sample, editor_id: 'current'}), true);
  gate.resolve(true); assert.equal(await first, false); assert.equal(a.editor.getProject().editor_id, 'current');
  assert.equal(await a.editor.activateProject({...sample, editor_id: 'denied'}, {canApply: async () => false}), false);
  assert.equal(a.editor.getProject().editor_id, 'current');
});

test('switching projects releases late media and keeps projects and navigation separate', async () => {
  const media = deferred(); let released = 0;
  const a = setup({loadMedia: () => media.promise}); await a.editor.ready;
  await edit(a, 'zhEdit', '工程 A 修订'); a.editor.go(1);
  const selecting = a.el('videoFile').fire('change', {target: {files: [{name: 'A.mp4'}], value: 'A.mp4'}});
  await a.editor.activateProject({...sample, editor_id: 'b', title: '工程 B'});
  media.resolve({src: 'late-A.mp4', release() {released++;}}); await selecting;
  assert.equal(released, 1); assert.notEqual(a.player.src, 'late-A.mp4');
  await edit(a, 'zhEdit', '工程 B 修订');
  await a.editor.activateProject(await a.saved.get('a'));
  assert.equal(a.editor.getIndex(), 1); assert.equal(a.editor.getProject().rows[0].zh, '工程 A 修订');
  await a.editor.activateProject(await a.saved.get('b'));
  assert.equal(a.editor.getProject().rows[0].zh, '工程 B 修订');
});

test('published HTML starts with a blank project and bundles local runtime', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const seed = JSON.parse(html.match(/<script id="initial" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(seed.rows.length, 0); assert.equal(seed.editor_id, 'generic-blank');
  assert.ok(!/<video[^>]*\ssrc=/.test(html)); assert.ok(!/<script[^>]*\ssrc=/.test(html));
  assert.ok(!/__PROJECT__|__SCRIPT__|__TITLE__|__TOOLBAR__/.test(html));
});

test('the newest video selection wins when two native loads finish out of order', async () => {
  const first = deferred(), second = deferred(), released = [];
  const a = setup({loadMedia: file => file.name === 'first.mp4' ? first.promise : second.promise});
  await a.editor.ready;
  const select = name => a.el('videoFile').fire('change', {target: {files: [{name}], value: name}});
  const oldLoad = select('first.mp4'), newLoad = select('second.mp4');
  second.resolve({src: 'second.mp4', release() {released.push('second');}}); await newLoad;
  first.resolve({src: 'first.mp4', release() {released.push('first');}}); await oldLoad;
  assert.equal(a.player.src, 'second.mp4'); assert.equal(a.editor.getProject().mediaName, 'second.mp4');
  assert.deepEqual(released, ['first']);
});

test('direct export receives the current project media file after switching projects and replacing a source', async () => {
  const released = [], a = setup({loadMedia: async file => ({file, src: file.name, release() {released.push(file.name);}})});
  await a.editor.ready;
  const select = file => a.el('videoFile').fire('change', {target: {files: [file], value: file.name}});
  assert.equal(a.editor.getMediaFile(), undefined);
  const first = {name: 'A.mp4'}, second = {name: 'B.mp4'}, replacement = {name: 'A-revised.mp4'};
  await select(first);
  assert.equal(a.editor.getMediaFile(), first);
  await a.editor.activateProject({...sample, editor_id: 'b', title: '工程 B'});
  assert.equal(a.editor.getMediaFile(), undefined, 'another project cannot export the previous project video');
  await select(second);
  assert.equal(a.editor.getMediaFile(), second);
  await a.editor.activateProject(await a.saved.get('a'));
  assert.equal(a.editor.getMediaFile(), first);
  await select(replacement);
  assert.equal(a.editor.getMediaFile(), replacement);
  assert.deepEqual(released, ['A.mp4']);
  await a.editor.activateProject(await a.saved.get('b'));
  assert.equal(a.editor.getMediaFile(), second);
});

test('a delayed project lookup cannot undo a newer selection', async () => {
  const a = setup(); await a.editor.ready;
  const slow = deferred();
  a.store.get = id => id === 'slow' ? slow.promise : Promise.resolve({...sample, editor_id: id});
  a.el('projectPicker').value = 'slow'; const old = a.el('projectPicker').fire('change');
  a.el('projectPicker').value = 'latest'; await a.el('projectPicker').fire('change');
  slow.resolve({...sample, editor_id: 'slow'}); await old;
  assert.equal(a.editor.getProject().editor_id, 'latest');
});

test('edits made during a switch save are committed before the old project detaches', async () => {
  const a = setup(); await a.editor.ready;
  const saving = deferred(); let flushCount = 0, committed;
  a.store.flush = async () => {
    const snapshot = native(a.editor.getProject());
    if (++flushCount === 1) await saving.promise;
    committed = snapshot;
    return true;
  };
  const switching = a.editor.activateProject({...sample, editor_id: 'b'});
  await new Promise(resolve => setImmediate(resolve));
  await edit(a, 'zhEdit', '保存等待期间的修改');
  saving.resolve(); await switching;
  assert.equal(committed.editor_id, 'a'); assert.equal(committed.rows[0].zh, '保存等待期间的修改');
  assert.equal(a.editor.getProject().editor_id, 'b');
});

test('a new project created during initialization wins over startup restoration', async () => {
  const initializing = deferred();
  const a = setup({initial: {...sample, editor_id: 'generic-blank', rows: []}, init: () => initializing.promise, getLastId: async () => 'previous'});
  a.saved.set('previous', {...sample, editor_id: 'previous', title: 'Previously saved'});
  const creating = a.el('newProject').click();
  initializing.resolve(); await a.editor.ready; await creating;
  assert.equal(a.editor.getProject().title, '新字幕工程');
  assert.notEqual(a.editor.getProject().editor_id, 'previous');
});

test('the latest import wins over an older file read and a pending project lookup', async () => {
  const a = setup(); await a.editor.ready;
  const olderFile = deferred(), oldLookup = deferred();
  a.store.get = () => oldLookup.promise;
  a.el('projectPicker').value = 'lookup'; const selecting = a.el('projectPicker').fire('change');
  const importing = a.editor.importFile({name: 'older.json', text: () => olderFile.promise});
  await a.editor.importFile({name: 'latest.json', text: async () => JSON.stringify({...sample, editor_id: 'latest'})});
  olderFile.resolve(JSON.stringify({...sample, editor_id: 'older'}));
  assert.equal(await importing, false);
  oldLookup.resolve({...sample, editor_id: 'lookup'}); await selecting;
  assert.equal(a.editor.getProject().editor_id, 'latest');
  assert.match(a.el('msg').textContent, /已导入/);
});
