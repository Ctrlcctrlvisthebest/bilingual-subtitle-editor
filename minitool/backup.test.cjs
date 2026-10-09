const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TextEncoder, TextDecoder } = require('node:util');

const source = fs.readFileSync(path.join(__dirname, 'backup.js'), 'utf8');
function load(overrides = {}) {
  const window = Object.assign({ TextEncoder, TextDecoder }, overrides);
  vm.runInNewContext(source, { window }, { filename: 'backup.js' });
  return window.SubtitleBackup;
}
const api = load();
const native = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepEqual(native(actual), native(expected));

function envelopeBytes(envelope, payloadOverride) {
  const payload = payloadOverride || Buffer.from(JSON.stringify(envelope), 'utf8');
  const packed = Buffer.alloc(16 + payload.length);
  packed.write('BSEPNG1!', 0, 'ascii');
  packed.writeUInt32BE(payload.length, 8);
  packed.writeUInt32BE(api.crc32(payload), 12);
  payload.copy(packed, 16);
  return packed;
}

function example() {
  return {
    version: 1,
    editor_id: 'test-only',
    title: '离线双语 · 测试 🐱 中文／English／日本語／العربية',
    revision: 3,
    appearance: { mode: 'outline', fontSize: 38, align: 'bottom', primary: '#ffffff', border: 3 },
    styles: { Narrator: { font: '系统字体', color: '#20a0cc', italic: false } },
    colors: { '讲述者 🎙️': '#135791' },
    mediaName: '本地测试视频.mp4',
    rows: [
      { id: '行-1', start: 0, end: 1.234, zh: '你好，世界 🌏\n换行与\t制表符', en: 'Hello, “world”!', speaker: '讲述者 🎙️', status: '已校对', note: '备注\n第二行', verification: { translation: 'user_reviewed' }, style: 'Narrator' },
      { id: '行-2', start: 1.234, end: 9.87, zh: '组合字符 e\u0301 / 𠮷 / 孤立代理：\ud800', en: 'Escapes: \\ " <script>', speaker: 'Unknown', status: '疑点待听校', note: '不访问网络' }
    ],
    extra: { enabled: true, empty: null, sequence: [1, 2, '三'] }
  };
}

test('CRC32 matches the standard known vector', () => {
  assert.equal(api.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(api.crc32(new Uint8Array()), 0);
});

test('Unicode project roundtrip preserves rows, styles, status, notes, and all metadata', () => {
  const project = example();
  const original = JSON.stringify(project);
  const packed = api.pack(project);
  assert.equal(Buffer.from(packed.subarray(0, 8)).toString('ascii'), 'BSEPNG1!');
  assert.equal(Buffer.from(packed).readUInt32BE(8), packed.length - 16);
  same(api.unpack(packed), project);
  assert.equal(JSON.stringify(project), original, 'pack must not mutate the supplied project');
});

test('UTF-8 fallback works with encoders absent and keeps supplementary characters', () => {
  const fallback = load({ TextEncoder: undefined, TextDecoder: undefined });
  same(fallback.unpack(fallback.pack(example())), example());
  assert.deepEqual(Buffer.from(fallback.pack(example())), Buffer.from(api.pack(example())));
});

test('zero rows and a large editable subtitle list roundtrip', () => {
  const empty = { version: 1, title: '', rows: [], appearance: { mode: 'box' } };
  same(api.unpack(api.pack(empty)), empty);
  const rows = Array.from({ length: 12000 }, (_, i) => ({ id: 'row-' + i, start: i * 2, end: i * 2 + 1, zh: '中文字幕 ' + i + ' 🐱', en: 'Caption ' + i, status: '疑点待听校', note: '待听校', styles: { size: 40 } }));
  const project = { version: 1, title: '大型测试工程', rows };
  same(api.unpack(api.pack(project)), project);
});

test('exactly 8 MiB is permitted and one byte beyond the limit is rejected', () => {
  const project = { title: '', rows: [], padding: '' };
  const overhead = Buffer.byteLength(JSON.stringify({ format: 'bse-backup-v1', project }));
  project.padding = 'a'.repeat(api.constants.maxPayload - overhead);
  const packed = api.pack(project);
  assert.equal(packed.length, api.constants.maxPayload + 16);
  assert.equal(api.unpack(packed).padding.length, project.padding.length);
  const rgba = api.bytesToRGBA(packed);
  assert.equal(rgba.length / 4 / 720, api.constants.maxBandHeight);
  project.padding += 'a';
  assert.throws(() => api.pack(project), /8 MiB/);
});

test('CRC corruption, damaged magic, truncated payload, and extra bytes are rejected', () => {
  const packed = Buffer.from(api.pack(example()));
  const corrupt = Buffer.from(packed);
  corrupt[corrupt.length - 2] ^= 1;
  assert.throws(() => api.unpack(corrupt), /校验失败/);
  const magic = Buffer.from(packed);
  magic[0] ^= 1;
  assert.throws(() => api.unpack(magic), /不是字幕工程备份/);
  assert.throws(() => api.unpack(packed.subarray(0, 15)), /数据头被截断/);
  assert.throws(() => api.unpack(packed.subarray(0, packed.length - 1)), /数据被截断/);
  assert.throws(() => api.unpack(Buffer.concat([packed, Buffer.from([0])])), /多余数据/);
});

test('zero, oversized, and unsigned invalid payload lengths are bounded before parsing', () => {
  for (const length of [0, api.constants.maxPayload + 1, 0xffffffff]) {
    const packed = Buffer.from(api.pack({ rows: [] }));
    packed.writeUInt32BE(length, 8);
    assert.throws(() => api.unpack(packed), /长度无效.*8 MiB/);
  }
});

test('invalid JSON and unsupported or malformed project envelopes are rejected', () => {
  for (const envelope of [null, [], { format: 'other', project: { rows: [] } }, { format: 'bse-backup-v1' }, { format: 'bse-backup-v1', project: { rows: 'text' } }, { format: 'bse-backup-v1', project: { rows: [null] } }, { format: 'bse-backup-v1', project: { rows: [], title: 3 } }]) {
    assert.throws(() => api.unpack(envelopeBytes(envelope)), /格式无效|版本不受支持/);
  }
  assert.throws(() => api.unpack(envelopeBytes(null, Buffer.from('{broken'))), /JSON 无效/);
  assert.throws(() => api.pack({ rows: [false] }), /字幕条目必须是对象/);
  const cycle = { rows: [] }; cycle.self = cycle;
  assert.throws(() => api.pack(cycle), /循环引用/);
});

test('CRC-valid but illegal UTF-8 sequences are rejected without replacement', () => {
  for (const sequence of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xe2, 0x20, 0xa1], [0x80]]) {
    assert.throws(() => api.unpack(envelopeBytes(null, Buffer.from(sequence))), /文字编码/);
  }
});

test('RGB pixels hold three bytes and alpha 255; band roundtrip verifies zero padding', () => {
  const project = example();
  const packed = api.pack(project);
  const rgba = api.bytesToRGBA(packed);
  assert.equal(rgba.length % (720 * 4), 0);
  for (let pixel = 0; pixel < rgba.length; pixel += 4) assert.equal(rgba[pixel + 3], 255);
  const decodedBytes = api.rgbaToBytes(rgba);
  assert.deepEqual(Buffer.from(decodedBytes.subarray(0, packed.length)), Buffer.from(packed));
  same(api.decodeBand(rgba, 720, rgba.length / 2880), project);
  rgba[rgba.length - 2] = 1;
  assert.throws(() => api.decodeBand(rgba, 720, rgba.length / 2880), /尾部数据已改变/);
});

test('resized, cropped, transparent, and malformed pixel data are rejected', () => {
  const rgba = api.bytesToRGBA(api.pack({ title: '图片测试', rows: [] }));
  const height = rgba.length / 2880;
  assert.throws(() => api.decodeBand(rgba, 360, height), /宽度必须是 720/);
  assert.throws(() => api.decodeBand(rgba, 720, 0), /高度无效/);
  assert.throws(() => api.decodeBand(rgba, 720, api.constants.maxBandHeight + 1), /高度无效/);
  assert.throws(() => api.decodeBand(rgba.subarray(0, rgba.length - 4), 720, height), /像素不完整/);
  const enlarged = new Uint8ClampedArray(rgba.length + 2880); enlarged.set(rgba);
  for (let i = rgba.length + 3; i < enlarged.length; i += 4) enlarged[i] = 255;
  assert.throws(() => api.decodeBand(enlarged, 720, height + 1), /被裁剪、缩放或数据不完整/);
  rgba[3] = 254;
  assert.throws(() => api.decodeBand(rgba, 720, height), /透明像素/);
  assert.throws(() => api.rgbaToBytes(new Uint8Array(3)), /像素数据不完整/);
  assert.throws(() => api.unpack([]), /二进制数据无效/);
});

function browserFixture(options = {}) {
  const state = Object.assign({ canvases: [], texts: [], band: null, width: 720, height: 0, drawCalls: [], imageError: false, readError: false, toDataURLCalls: 0, toBlobCalls: 0 }, options);
  const document = {
    createElement(type) {
      assert.equal(type, 'canvas');
      const canvas = {
        width: 0, height: 0,
        toDataURL(type) { state.toDataURLCalls++; assert.equal(type, 'image/png'); return 'data:image/png;base64,iVBORw0KGgo='; },
        toBlob(callback, type) {
          state.toBlobCalls++; assert.equal(type, 'image/png');
          if (state.toBlobThrows) throw new Error('canvas encoder failed');
          const blob = state.blobResult !== undefined ? state.blobResult : new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
          setImmediate(() => callback(blob));
        }
      };
      if (state.toBlobUnavailable) delete canvas.toBlob;
      const context = {
        fillRect() {}, fillText(text) { state.texts.push(text); }, measureText(text) { return { width: text.length * 12 }; },
        createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
        putImageData(data, x, y) { assert.equal(x, 0); assert.equal(y, 192); state.band = data; state.height = y + data.height; },
        drawImage(image, x, y) { state.drawCalls.push({ image, x, y }); },
        getImageData(x, y, width, height) { assert.deepEqual([x, y, width, height], [0, 192, 720, state.band.height]); return state.band; }
      };
      canvas.getContext = type => { assert.equal(type, '2d'); return state.contextUnavailable ? null : context; };
      if (state.canvasUnsupported) delete canvas.getContext;
      state.canvases.push(canvas);
      return canvas;
    }
  };
  class FileReader {
    readAsArrayBuffer(blob) { this.result = Uint8Array.from(blob.content).buffer; this.finish(); }
    readAsDataURL() { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.finish(); }
    finish() { setImmediate(() => state.readError ? this.onerror() : this.onload()); }
  }
  class Image {
    set src(value) {
      assert.match(value, /^data:image\/png/);
      this.naturalWidth = state.width;
      this.naturalHeight = state.height;
      setImmediate(() => state.imageError ? this.onerror() : this.onload());
    }
  }
  const api = load({ document, FileReader, Image });
  const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  function file(options = {}) {
    return Object.assign({ name: '工程.png', type: 'image/png', size: content.length, content, slice(a, b) { return { content: this.content.subarray(a, b) }; } }, options);
  }
  return { api, state, file };
}

test('Canvas encoding lays out the readable 192px header above the exact byte band', () => {
  const { api, state } = browserFixture();
  assert.match(api.encode(example()), /^data:image\/png/);
  assert.equal(state.canvases[0].width, 720);
  assert.equal(state.canvases[0].height, 192 + state.band.height);
  assert.ok(state.texts.includes('保留原图，请勿截图或压缩'));
  assert.ok(state.texts.some(text => /共 2 条字幕/.test(text)));
  same(api.decodeBand(state.band.data, 720, state.band.height), example());
});

test('encodeBlob writes the same editable pixel band directly to a PNG Blob without a data URL', async () => {
  const { api, state } = browserFixture();
  const promise = api.encodeBlob(example());
  assert.equal(typeof promise.then, 'function');
  const blob = await promise;
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
  assert.ok(blob.size > 0);
  assert.equal(state.toBlobCalls, 1);
  assert.equal(state.toDataURLCalls, 0, 'binary export never builds a Base64 data URI');
  assert.equal(state.canvases[0].width, 720);
  assert.equal(state.canvases[0].height, 192 + state.band.height);
  assert.ok(state.texts.includes('保留原图，请勿截图或压缩'));
  same(api.decodeBand(state.band.data, 720, state.band.height), example());
});

test('encodeBlob rejects null, empty, wrong-type, and throwing Canvas encoders', async () => {
  for (const options of [
    { blobResult: null },
    { blobResult: new Blob([], { type: 'image/png' }) },
    { blobResult: new Blob(['wrong format'], { type: 'image/jpeg' }) },
    { toBlobThrows: true }
  ]) {
    const { api, state } = browserFixture(options);
    await assert.rejects(api.encodeBlob(example()), /生成 PNG 备份文件失败/);
    assert.equal(state.toDataURLCalls, 0, 'failed binary export cannot silently fall back to a data URL');
  }
});

test('encodeBlob reports unavailable toBlob and Canvas APIs with rejected Promises', async () => {
  const unavailable = browserFixture({ toBlobUnavailable: true });
  await assert.rejects(unavailable.api.encodeBlob(example()), /Canvas\.toBlob 不可用/);
  assert.equal(unavailable.state.toDataURLCalls, 0);
  for (const options of [{ contextUnavailable: true }, { canvasUnsupported: true }]) {
    const fixture = browserFixture(options);
    await assert.rejects(fixture.api.encodeBlob(example()), /Canvas/);
  }
  await assert.rejects(api.encodeBlob(example()), /Canvas/);
  const invalid = browserFixture();
  await assert.rejects(invalid.api.encodeBlob({ rows: [null] }), /字幕条目必须是对象/);
});

test('decodeFile uses original natural resolution and returns an editable project', async () => {
  const { api, state, file } = browserFixture();
  api.encode(example());
  same(await api.decodeFile(file()), example());
  assert.equal(state.drawCalls.length, 1);
  assert.equal(state.drawCalls[0].x, 0);
  assert.equal(state.drawCalls[0].y, 0);
  assert.equal(state.canvases[1].width, 720);
  assert.equal(state.canvases[1].height, state.height);
});

test('decodeFile rejects JPEG, wrong signatures, truncated files, and oversized files', async () => {
  const { api, file } = browserFixture();
  await assert.rejects(api.decodeFile(file({ type: 'image/jpeg', name: 'backup.jpg' })), /JPEG/);
  await assert.rejects(api.decodeFile(file({ type: 'image/png', name: 'disguised.png', content: Buffer.from('not a PNG') })), /文件不是 PNG/);
  await assert.rejects(api.decodeFile(file({ size: 0 })), /为空或文件不完整/);
  await assert.rejects(api.decodeFile(file({ size: 32 * 1024 * 1024 + 1 })), /32 MiB/);
  await assert.rejects(api.decodeFile(null), /先选择/);
});

test('decodeFile rejects natural-width changes, header-only PNGs, and native read errors', async () => {
  const { api, state, file } = browserFixture();
  api.encode(example());
  state.width = 1440;
  await assert.rejects(api.decodeFile(file()), /宽度必须是 720/);
  assert.equal(state.drawCalls.length, 0, 'reject oversized dimensions before drawing');
  state.width = 720; state.height = 192;
  await assert.rejects(api.decodeFile(file()), /高度无效/);
  state.height = 193; state.readError = true;
  await assert.rejects(api.decodeFile(file()), /无法读取/);
  state.readError = false; state.imageError = true;
  await assert.rejects(api.decodeFile(file()), /无法打开备份 PNG/);
});

test('missing browser APIs yield useful errors and never call native services', async () => {
  assert.throws(() => api.encode({ rows: [] }), /Canvas/);
  await assert.rejects(api.decodeFile({ size: 8, slice() {} }), /不支持读取/);
  assert.doesNotMatch(source, /\b(?:fetch|eval)\s*\(|\bWebAssembly\b|saveImageToPhotosAlbum|clipboard|https?:\/\//);
});
