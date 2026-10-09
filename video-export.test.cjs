const assert = require('node:assert/strict');
const { test } = require('node:test');

const exportsModule = import('./video-export.js');
const projectModule = import('./project.js');

async function sampleProject() {
  const { normalizeProject } = await projectModule;
  return normalizeProject({
    version: 1,
    editor_id: 'video-export-test',
    title: '测试工程',
    rows: [
      { id: 'a', start: 10, end: 12, zh: '你好', en: 'Hello.', speaker: 'Unknown' },
      { id: 'b', start: 14, end: 16, zh: '下一句', en: 'Next.', speaker: 'Unknown' },
    ],
  });
}

test('clip ranges validate milliseconds and exclude cues outside either boundary', async () => {
  const { parseExportRange, clipExportRows } = await exportsModule;
  assert.deepEqual(parseExportRange('all', '', ''), { start: 0, end: null });
  assert.deepEqual(parseExportRange('clip', '11.0001', '15.0001'), { start: 11, end: 15 });
  assert.throws(() => parseExportRange('clip', '', '12'), /有效片段/);
  assert.throws(() => parseExportRange('clip', 'NaN', '12'), /有效片段/);
  assert.throws(() => parseExportRange('clip', '-1', '12'), /有效片段/);
  assert.throws(() => parseExportRange('clip', '12', '12'), /有效片段/);
  assert.throws(() => parseExportRange('clip', '12.0001', '12.0002'), /至少 0.001 秒/);

  const project = await sampleProject();
  const before = JSON.stringify(project);
  const clipped = clipExportRows(project.rows, { start: 11, end: 15 });
  assert.deepEqual(clipped.map(({ id, start, end }) => ({ id, start, end })), [
    { id: 'a', start: 0, end: 1 },
    { id: 'b', start: 3, end: 4 },
  ]);
  assert.deepEqual(clipExportRows(project.rows, { start: 12, end: 14 }), []);
  assert.deepEqual(clipExportRows(project.rows, { start: 0, end: null }), project.rows);
  assert.equal(JSON.stringify(project), before);
});

test('local export clips subtitles while retaining the complete editable project and Unix permissions', async () => {
  const { exportPackageFiles, buildExportZip, zipCRC32 } = await exportsModule;
  const project = await sampleProject();
  const files = exportPackageFiles(project.rows, { start: 11, end: 15 }, true, project);
  const captions = files.find(file => file.name === 'captions.ass').text;
  assert.match(captions, /0:00:00\.00,0:00:01\.00/);
  assert.match(captions, /0:00:03\.00,0:00:04\.00/);
  assert.deepEqual(JSON.parse(files.find(file => file.name === 'project.json').text), JSON.parse(JSON.stringify(project)));
  const script = files.find(file => file.name === 'export-mac.command').text;
  assert.match(script, /seek_args=\(-ss 11\)/);
  assert.match(script, /duration_args=\(-t 4\.000\)/);
  assert.match(script, /-map '0:a:0\?' -sn -dn/);
  assert.match(script, /h264_videotoolbox/);
  assert.throws(() => exportPackageFiles(project.rows, { start: 40, end: 41 }, false, project), /没有字幕/);
  assert.equal(zipCRC32(new TextEncoder().encode('123456789')), 0xcbf43926);

  const zip = Buffer.from(await buildExportZip(files).arrayBuffer());
  let offset = 0;
  const extracted = new Map();
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(offset + 26);
    const size = zip.readUInt32LE(offset + 18);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const text = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size).toString();
    extracted.set(name, text);
    offset += 30 + nameLength + size;
  }
  assert.deepEqual(extracted, new Map(files.map(file => [file.name, file.text])));
  for (const file of files) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    assert.equal(zip.readUInt32LE(offset + 38) >>> 16, file.executable ? 0o100755 : 0o100644);
    offset += 46 + zip.readUInt16LE(offset + 28);
  }
  assert.equal(zip.readUInt32LE(offset), 0x06054b50);
  assert.equal(zip.readUInt16LE(offset + 10), files.length);
});

class Element {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
  }
  addEventListener(type, callback, options = {}) {
    const handlers = this.listeners.get(type) || [];
    handlers.push({ callback, once: options.once });
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(handler => handler.callback !== callback));
  }
  async emit(type) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; } };
    const tasks = [];
    for (const handler of [...(this.listeners.get(type) || [])]) {
      if (handler.once) this.removeEventListener(type, handler.callback);
      tasks.push(handler.callback(event));
    }
    await Promise.all(tasks);
    return event;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function globalsForTest(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
}

async function setupUI(t, options = {}) {
  const project = await sampleProject();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const player = new Element('video');
  Object.assign(player, { currentTime: 0, duration: 100, readyState: 4, videoWidth: 1920 });
  player.attributes.set('src', 'test.mp4');
  element('videoExportRange').value = 'clip';
  element('videoExportMode').value = 'local';
  element('videoExportStart').value = '11';
  element('videoExportEnd').value = '15';
  const controls = ['closeVideoExport', 'startVideoExport', 'cancelVideoExport', 'videoExportMode', 'videoExportRange', 'videoExportStart', 'videoExportEnd', 'videoExportEncoder'].map(element);
  element('videoExportDialog').querySelectorAll = () => controls;
  globalsForTest(t, { document: { getElementById: element, createElement: () => new Element('media') } });
  const downloads = [];
  let committed = 0;
  let paused = 0;
  const editor = {
    getProject: () => project,
    getMediaFile: () => ({name: 'test.mp4'}),
    getIndex: () => 0,
    player,
    ready: Promise.resolve(),
    notice: () => {},
    exportRows: () => project.rows,
    commitTimes: () => { committed++; },
    pause: () => { paused++; },
    download: (...args) => downloads.push(args),
  };
  const { initVideoExport } = await exportsModule;
  const controller = initVideoExport(editor, options);
  return { element, editor, downloads, controller, get committed() { return committed; }, get paused() { return paused; } };
}

test('export UI initializes through its editor API and reports an empty selected range', async t => {
  const ui = await setupUI(t);
  assert.equal(ui.element('directVideoExportMode').hidden, true);
  await ui.element('exportVideo').emit('click');
  assert.equal(ui.committed, 1);
  assert.equal(ui.controller.isOpen(), true);
  await ui.element('startVideoExport').emit('click');
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0][0], '测试工程-视频导出包.zip');

  ui.element('videoExportStart').value = '40';
  ui.element('videoExportEnd').value = '41';
  await ui.element('startVideoExport').emit('click');
  assert.match(ui.element('videoExportStatus').textContent, /没有字幕/);
  assert.equal(ui.downloads.length, 1);

  ui.element('videoExportMode').value = 'browser';
  await ui.element('startVideoExport').emit('click');
  assert.match(ui.element('videoExportStatus').textContent, /没有字幕/);
  await ui.element('closeVideoExport').emit('click');
  assert.equal(ui.controller.isOpen(), false);
});

test('direct MP4 export starts synchronously, preserves a snapshot, and completes after saving the file', async t => {
  let invocation, finish, calls = 0;
  const ui = await setupUI(t, {
    exportMP4: options => {
      calls++;
      invocation = options;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  assert.equal(ui.element('directVideoExportMode').hidden, false);
  assert.equal(ui.element('videoExportMode').value, 'direct');
  ui.element('videoExportEncoder').disabled = true;
  ui.element('videoExportRange').value = 'all';
  ui.editor.player.duration = 13920;
  await ui.element('exportVideo').emit('click');
  assert.equal(ui.element('directExportOptions').hidden, false);
  assert.equal(ui.element('localExportOptions').hidden, true);
  assert.equal(ui.element('browserExportOptions').hidden, true);
  const exporting = ui.element('startVideoExport').emit('click');
  assert.equal(calls, 1, 'the file picker is reached in the click event before an await');
  assert.equal(invocation.file.name, 'test.mp4');
  assert.equal(invocation.range.end, null);
  assert.equal(ui.paused, 1);
  assert.equal(ui.element('startVideoExport').disabled, true);
  assert.equal(ui.element('cancelVideoExport').disabled, false);
  assert.equal(ui.element('videoExportProgress').value, 0);
  await ui.element('startVideoExport').emit('click');
  await ui.element('exportVideo').emit('click');
  assert.equal(calls, 1);
  assert.equal(ui.committed, 1);
  assert.equal((await ui.element('videoExportDialog').emit('cancel')).prevented, true);
  await ui.element('closeVideoExport').emit('click');
  assert.equal(ui.controller.isOpen(), true);

  ui.editor.getProject().rows[0].zh = '导出期间修改';
  assert.equal(invocation.rows[0].zh, '你好');
  assert.equal(invocation.project.rows[0].zh, '你好');
  invocation.onProgress({phase: 'encoding', progress: 0.25, size: 1048576});
  assert.equal(ui.element('videoExportProgress').value, 0.25);
  assert.match(ui.element('videoExportStatus').textContent, /25%.*1.0 MB/);
  invocation.onProgress({phase: 'saving', progress: 1, size: 2147483648});
  assert.equal(ui.element('videoExportProgress').value, 0.99);
  assert.equal(ui.element('cancelVideoExport').disabled, true);
  assert.equal(ui.element('videoExportStatus').textContent, '正在完成并保存 MP4…');
  assert.equal(ui.element('saveVideoExport').hidden, true);
  finish({name: '完整带字幕.mp4', width: 1920, height: 1080, size: 2147483648, duration: 13920});
  await exporting;
  assert.equal(ui.element('videoExportProgress').value, 1);
  assert.match(ui.element('videoExportStatus').textContent, /MP4 已保存：完整带字幕.mp4/);
  assert.match(ui.element('videoExportStatus').textContent, /1920 × 1080.*2.00 GB/);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.element('saveVideoExport').hidden, true);
  assert.equal(ui.element('startVideoExport').disabled, false);
  assert.equal(ui.element('videoExportEncoder').disabled, true);
  assert.equal(ui.element('cancelVideoExport').disabled, false);
  assert.equal(ui.element('cancelVideoExport').hidden, true);
  await ui.element('closeVideoExport').emit('click');
  assert.equal(ui.controller.isOpen(), false);
});

test('direct MP4 reports a committed file as saved even if cancellation arrives during the saving phase', async t => {
  let invocation, finish;
  const ui = await setupUI(t, {
    exportMP4: options => {
      invocation = options;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  await ui.element('exportVideo').emit('click');
  const exporting = ui.element('startVideoExport').emit('click');
  invocation.onProgress({phase: 'saving', progress: 1, size: 1048576});
  assert.equal(ui.element('cancelVideoExport').disabled, true);
  await ui.element('cancelVideoExport').emit('click');
  assert.equal(invocation.signal.aborted, true);
  finish({name: '已经保存.mp4', width: 1920, height: 1080, size: 1048576, duration: 4});
  await exporting;
  assert.match(ui.element('videoExportStatus').textContent, /MP4 已保存：已经保存.mp4/);
  assert.doesNotMatch(ui.element('videoExportStatus').textContent, /取消/);
  assert.equal(ui.element('videoExportProgress').value, 1);
  assert.equal(ui.element('cancelVideoExport').disabled, false);
});

test('direct MP4 cancellation propagates its signal and restores controls without offering an unfinished video', async t => {
  let signal;
  const ui = await setupUI(t, {
    exportMP4: options => {
      signal = options.signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), {once: true}));
    }
  });
  ui.element('videoExportEncoder').disabled = true;
  await ui.element('exportVideo').emit('click');
  const exporting = ui.element('startVideoExport').emit('click');
  await ui.element('cancelVideoExport').emit('click');
  await exporting;
  assert.equal(signal.aborted, true);
  assert.match(ui.element('videoExportStatus').textContent, /已取消导出，未保存成品/);
  assert.equal(ui.element('videoExportProgress').hidden, true);
  assert.equal(ui.element('saveVideoExport').hidden, true);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.element('startVideoExport').disabled, false);
  assert.equal(ui.element('videoExportEncoder').disabled, true);
  assert.equal(ui.element('cancelVideoExport').hidden, true);
  await ui.element('closeVideoExport').emit('click');
  assert.equal(ui.controller.isOpen(), false);
});

test('direct MP4 reports save or codec failure without switching to another export method', async t => {
  let calls = 0;
  const ui = await setupUI(t, {
    exportMP4: () => {
      calls++;
      throw Error('当前浏览器无法编码 H.264。');
    }
  });
  await ui.element('exportVideo').emit('click');
  await ui.element('startVideoExport').emit('click');
  assert.equal(calls, 1);
  assert.equal(ui.element('videoExportStatus').textContent, '当前浏览器无法编码 H.264。');
  assert.equal(ui.element('videoExportMode').value, 'direct');
  assert.equal(ui.element('videoExportProgress').hidden, true);
  assert.equal(ui.element('saveVideoExport').hidden, true);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.element('startVideoExport').disabled, false);
  assert.equal(ui.element('cancelVideoExport').hidden, true);
});

test('dismissing the direct MP4 file picker is reported as cancellation', async t => {
  const ui = await setupUI(t, {
    exportMP4: async () => { throw new DOMException('picker dismissed', 'AbortError'); }
  });
  await ui.element('exportVideo').emit('click');
  await ui.element('startVideoExport').emit('click');
  assert.match(ui.element('videoExportStatus').textContent, /已取消导出，未保存成品/);
  assert.equal(ui.element('startVideoExport').disabled, false);
  assert.equal(ui.element('saveVideoExport').hidden, true);
});

test('cancelling browser preparation releases media and audio and restores controls', async t => {
  const ui = await setupUI(t);
  ui.element('videoExportMode').value = 'browser';
  ui.element('videoExportEncoder').disabled = true;
  ui.element('videoExportCanvas').captureStream = () => {};
  let loaded;
  const loading = new Promise(resolve => { loaded = resolve; });
  const media = new Element('media');
  media.pause = () => {};
  media.load = () => loaded();
  media.remove = () => { media.removed = true; };
  ui.element('videoExportDialog').append = () => {};
  let audioClosed = 0;
  class AudioContext {
    async resume() {}
    createMediaElementSource() { return { connect() {} }; }
    createMediaStreamDestination() { return {}; }
    async close() { audioClosed++; }
  }
  globalsForTest(t, {
    MediaRecorder: { isTypeSupported: () => true },
    AudioContext,
    document: { getElementById: ui.element, createElement: () => media },
  });
  await ui.element('exportVideo').emit('click');
  const exporting = ui.element('startVideoExport').emit('click');
  await loading;
  assert.equal(ui.paused, 1);
  assert.equal(ui.element('startVideoExport').disabled, true);
  assert.equal(ui.element('cancelVideoExport').disabled, false);
  assert.equal((await ui.element('videoExportDialog').emit('cancel')).prevented, true);
  await ui.element('cancelVideoExport').emit('click');
  await exporting;

  assert.match(ui.element('videoExportStatus').textContent, /已取消导出/);
  assert.equal(media.removed, true);
  assert.equal(audioClosed, 1);
  assert.equal(media.listeners.get('loadedmetadata').length, 0);
  assert.equal(media.listeners.get('error').length, 0);
  assert.equal(ui.element('startVideoExport').disabled, false);
  assert.equal(ui.element('videoExportEncoder').disabled, true);
  assert.equal(ui.element('cancelVideoExport').hidden, true);
  await ui.element('closeVideoExport').emit('click');
  assert.equal(ui.controller.isOpen(), false);
});
