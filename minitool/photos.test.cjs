'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'photos.js'), 'utf8');
const nativeFilesSource = fs.readFileSync(require('node:path').join(__dirname, 'native-files.js'), 'utf8');
const MiB = 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngOf(size, type = 'image/png') {
  const bytes = Buffer.alloc(size, 37);
  signature.copy(bytes);
  return { blob: new Blob([bytes], { type }), bytes };
}

function sdkMock(overrides = {}) {
  const root = 'opaque-native-png-root://current-tool/';
  const files = new Map([[root + '/existing-video.mp4', Buffer.from('synthetic existing video')]]);
  const calls = [], albums = [];
  const options = { errMsg: 'getLaunchOptions:ok', miniToolEnv: { buildVersion: 9490004, userDataPath: root } };
  const sdk = {
    async getLaunchOptions() { calls.push(['launch']); return options; },
    async getFileStorageInfo() { calls.push(['info']); return { errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 1024, usedBytes: 0, limitBytes: 100 * MiB }; },
    async writeFile(input) {
      calls.push(['write', input.filePath, input.data.length]);
      assert.equal(input.encoding, 'base64');
      const data = Buffer.from(input.data, 'base64');
      files.set(input.filePath, data);
      await new Promise(resolve => setImmediate(resolve));
      return { errMsg: 'writeFile:ok', writtenBytes: data.length };
    },
    async appendFile(input) {
      calls.push(['append', input.filePath, input.data.length]);
      assert.equal(input.encoding, 'base64');
      const data = Buffer.from(input.data, 'base64');
      files.set(input.filePath, Buffer.concat([files.get(input.filePath), data]));
      await new Promise(resolve => setImmediate(resolve));
      return { errMsg: 'appendFile:ok', writtenBytes: data.length };
    },
    async saveImageToPhotosAlbum(input) {
      calls.push(['album', input.filePath]);
      albums.push({ path: input.filePath, bytes: files.has(input.filePath) ? files.get(input.filePath) : Buffer.from(input.filePath.split(',')[1], 'base64') });
      return { errMsg: 'saveImageToPhotosAlbum:ok' };
    },
    async unlink(input) { calls.push(['unlink', input.filePath]); files.delete(input.filePath); return { errMsg: 'unlink:ok' }; }
  };
  Object.assign(sdk, overrides);
  return { sdk, root, files, calls, albums, options };
}

function environment(sdk, readerOptions = {}, syncOptions) {
  const reads = [];
  function FileReader() { this.result = null; this.error = null; }
  FileReader.prototype.readAsDataURL = function (part) {
    const index = reads.push(part.size);
    part.arrayBuffer().then(buffer => {
      if (readerOptions.failAt === index) {
        this.error = new Error('synthetic read error'); this.onerror(); return;
      }
      const bytes = Buffer.from(buffer);
      this.result = 'data:application/octet-stream;base64,' + (readerOptions.corruptAt === index ? bytes.subarray(1) : bytes).toString('base64');
      this.onload();
    });
  };
  const window = { FileReader, Blob };
  if (sdk) window.xhs = { miniTool: sdk, launchOptions: syncOptions };
  vm.runInNewContext(nativeFilesSource + '\n' + source, { window, Number, Object, Math, Date, Promise, Error });
  return { api: window.MiniPhotos, reads, window };
}

test('native PNG saving reconstructs every byte, uses dynamic serial chunks, then removes only its PNG', async () => {
  const mock = sdkMock();
  const env = environment(mock.sdk);
  const input = pngOf(1601);
  await env.api.save(input.blob);
  assert.deepEqual(env.reads, [8, 512, 512, 512, 65]);
  assert.deepEqual(mock.calls.filter(call => /^(write|append|album|unlink)$/.test(call[0])).map(call => call[0]), ['write', 'append', 'append', 'append', 'album', 'unlink']);
  assert.equal(mock.albums.length, 1);
  assert.ok(mock.albums[0].path.startsWith(mock.root + '/minitool-backup-'));
  assert.deepEqual(mock.albums[0].bytes, input.bytes);
  assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/existing-video.mp4']);
});

test('a large PNG is read only in at most 512 KiB decoded chunks', async () => {
  const mock = sdkMock({ async getFileStorageInfo() { return { errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 10 * MiB }; } });
  const env = environment(mock.sdk);
  const input = pngOf(MiB + 17);
  await env.api.save(input.blob);
  assert.deepEqual(env.reads, [8, 512 * 1024, 512 * 1024, 17]);
  assert.deepEqual(mock.albums[0].bytes, input.bytes);
});

test('only complete PNG Blobs at or below 12 MiB are accepted', async () => {
  const mock = sdkMock();
  const env = environment(mock.sdk);
  for (const input of [null, {}, new Blob([], { type: 'image/png' }), pngOf(8, 'image/jpeg').blob,
    new Blob([Buffer.alloc(8)], { type: 'image/png' }), pngOf(12 * MiB + 1).blob]) {
    await assert.rejects(env.api.save(input));
  }
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(env.reads, [8]);
});

test('missing SDK, native path, API or capacity is a clear error and never writes', async () => {
  await assert.rejects(environment(null).api.save(pngOf(8).blob), /小红书小工具容器/);
  for (const setup of [
    mock => { mock.options.miniToolEnv.userDataPath = ''; },
    mock => { delete mock.sdk.appendFile; },
    mock => { mock.sdk.getFileStorageInfo = async () => ({ errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 0 }); },
    mock => { mock.sdk.getFileStorageInfo = async () => ({ errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: Infinity }); },
    mock => { mock.sdk.getFileStorageInfo = async () => ({ errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 1024, usedBytes: 90, limitBytes: 100 }); },
    mock => { mock.sdk.getFileStorageInfo = async () => { throw { errMsg: 'getFileStorageInfo:fail denied' }; }; }
  ]) {
    const mock = sdkMock(); setup(mock);
    await assert.rejects(environment(mock.sdk).api.save(pngOf(12).blob));
    assert.equal(mock.calls.some(call => /^(write|append|album|unlink)$/.test(call[0])), false);
  }
});

test('all resolved native failure responses reject instead of confirming success', async () => {
  for (const method of ['getLaunchOptions', 'getFileStorageInfo', 'writeFile', 'appendFile', 'saveImageToPhotosAlbum', 'unlink']) {
    const mock = sdkMock();
    const original = mock.sdk[method];
    mock.sdk[method] = async input => {
      const response = await original(input);
      return Object.assign({}, response, { errMsg: method + ':fail synthetic' });
    };
    await assert.rejects(environment(mock.sdk).api.save(pngOf(1100).blob));
    if (['writeFile', 'appendFile', 'saveImageToPhotosAlbum', 'unlink'].includes(method)) {
      assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
    }
    assert.ok(mock.files.has(mock.root + '/existing-video.mp4'));
  }
});

test('native rejected writes or album permission errors always clean the generated path', async () => {
  for (const method of ['writeFile', 'appendFile', 'saveImageToPhotosAlbum']) {
    const mock = sdkMock();
    const original = mock.sdk[method];
    mock.sdk[method] = async input => { await original(input); throw { errMsg: method + ':fail permission denied' }; };
    await assert.rejects(environment(mock.sdk).api.save(pngOf(1100).blob), /未确认保存成功/);
    assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
    assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/existing-video.mp4']);
  }
});

test('native rejections without an error object still clean this file and keep a useful message', async () => {
  const mock = sdkMock({ async saveImageToPhotosAlbum() { throw null; } });
  await assert.rejects(environment(mock.sdk).api.save(pngOf(20).blob), /未确认保存成功/);
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
  assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/existing-video.mp4']);
});

test('written byte mismatches and native read failures never reach album saving', async () => {
  const wrong = sdkMock();
  const write = wrong.sdk.writeFile;
  wrong.sdk.writeFile = async input => Object.assign(await write(input), { writtenBytes: 1 });
  await assert.rejects(environment(wrong.sdk).api.save(pngOf(1100).blob), /字节数不一致/);
  assert.equal(wrong.albums.length, 0);
  for (const options of [{ failAt: 3 }, { corruptAt: 3 }]) {
    const mock = sdkMock();
    await assert.rejects(environment(mock.sdk, options).api.save(pngOf(1100).blob));
    assert.equal(mock.albums.length, 0);
    assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
  }
});

test('cleanup refusal remains visible, distinguishes a saved photo, and never removes unrelated files', async () => {
  const mock = sdkMock({ async unlink(input) { mock.calls.push(['unlink', input.filePath]); throw new Error('synthetic unlink denial'); } });
  await assert.rejects(environment(mock.sdk).api.save(pngOf(20).blob), error => {
    assert.equal(error.cleanupFailed, true);
    assert.equal(error.photoSaved, true);
    assert.match(error.message, /已保存.*清理失败/);
    return true;
  });
  assert.ok(mock.files.has(mock.root + '/existing-video.mp4'));
  const failure = sdkMock({
    async saveImageToPhotosAlbum() { throw new Error('synthetic album denial'); },
    async unlink(input) { failure.calls.push(['unlink', input.filePath]); return { errMsg: 'unlink:fail denial' }; }
  });
  await assert.rejects(environment(failure.sdk).api.save(pngOf(20).blob), error => {
    assert.equal(error.cleanupFailed, true); assert.equal(error.photoSaved, false); return true;
  });
  assert.equal(failure.calls.filter(call => call[0] === 'unlink').length, 1);
});

test('legacy clients save exactly 1 MiB data URI PNG and reject larger images', async () => {
  const mock = sdkMock();
  mock.options.miniToolEnv.buildVersion = 9489999;
  const env = environment(mock.sdk);
  const input = pngOf(MiB);
  await env.api.save(input.blob);
  assert.deepEqual(env.reads, [8, MiB]);
  assert.match(mock.albums[0].path, /^data:image\/png;base64,/);
  assert.deepEqual(mock.albums[0].bytes, input.bytes);
  await assert.rejects(env.api.save(pngOf(MiB + 1).blob), /1 MiB.*9.49/);
  assert.equal(mock.albums.length, 1);
  assert.equal(mock.calls.some(call => /^(info|write|append|unlink)$/.test(call[0])), false);
});

test('unknown launch version stays bounded; async denied launch can use only small legacy images', async () => {
  for (const getLaunchOptions of [undefined, async () => { throw new Error('not supported'); }]) {
    const mock = sdkMock();
    mock.sdk.getLaunchOptions = getLaunchOptions;
    const env = environment(mock.sdk);
    await env.api.save(pngOf(20).blob);
    await assert.rejects(env.api.save(pngOf(MiB + 1).blob), /1 MiB/);
    assert.equal(mock.calls.some(call => /^(write|append|unlink)$/.test(call[0])), false);
  }
});

test('legacy album failure is rejected and never attempts native file deletion', async () => {
  const mock = sdkMock({ async saveImageToPhotosAlbum() { return { errMsg: 'saveImageToPhotosAlbum:fail denied' }; } });
  mock.options.miniToolEnv.buildVersion = 9480000;
  await assert.rejects(environment(mock.sdk).api.save(pngOf(20).blob), /相册权限/);
  assert.equal(mock.calls.some(call => call[0] === 'unlink'), false);
});

test('concurrent PNG saves generate distinct paths and clean only their own files', async () => {
  const mock = sdkMock();
  const env = environment(mock.sdk, {}, { miniToolEnv: { buildVersion: '9490999', userDataPath: mock.root } });
  await Promise.all([env.api.save(pngOf(1100).blob), env.api.save(pngOf(1200).blob)]);
  assert.equal(new Set(mock.albums.map(item => item.path)).size, 2);
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 2);
  assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/existing-video.mp4']);
});

test('missing reader and synchronous FileReader failures remain useful errors', async () => {
  const missing = environment(sdkMock().sdk); delete missing.window.FileReader;
  await assert.rejects(missing.api.save(pngOf(20).blob), /无法读取 PNG/);
  const broken = environment(sdkMock().sdk);
  broken.window.FileReader.prototype.readAsDataURL = function () { throw new Error('synthetic reader exception'); };
  await assert.rejects(broken.api.save(pngOf(20).blob), /读取备份 PNG 失败/);
});

test('production code stays ES2017 and has no network, download or clipboard calls', () => {
  assert.doesNotMatch(nativeFilesSource + source, /\?\.|\?\?|\bglobalThis\b|catch\s*\{|\.at\(|\.text\(|\bimport\s|\bexport\s/);
  assert.doesNotMatch(nativeFilesSource + source, /createObjectURL|fetch\s*\(|XMLHttpRequest|navigator\.clipboard|execCommand|\.download\s*=|new\s+Worker/);
});
