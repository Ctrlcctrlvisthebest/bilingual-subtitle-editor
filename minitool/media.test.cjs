'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'media.js'), 'utf8');
const nativeFilesSource = fs.readFileSync(require('node:path').join(__dirname, 'native-files.js'), 'utf8');
const MiB = 1024 * 1024;

function fileOf(bytes, overrides = {}) {
  return Object.assign({
    name: 'synthetic.mp4', type: 'video/mp4', size: bytes.length,
    slice(start, end) {
      const value = bytes.subarray(start, end);
      return { size: value.length, bytes: value };
    }
  }, overrides);
}

function nativeMock(overrides = {}) {
  const root = 'opaque-native-root://current-tool/';
  const files = new Map([[root + '/keep.json', Buffer.from('synthetic existing file')]]);
  const calls = [];
  const options = { errMsg: 'getLaunchOptions:ok', miniToolEnv: { buildVersion: 9490004, userDataPath: root } };
  const sdk = {
    async getLaunchOptions() { calls.push(['launch']); return options; },
    async getFileStorageInfo() {
      calls.push(['info']);
      return { errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 1024, usedBytes: 0, limitBytes: 200 * MiB };
    },
    async writeFile(input) {
      calls.push(['write', input.filePath, input.data.length]);
      assert.equal(input.encoding, 'base64');
      const bytes = Buffer.from(input.data, 'base64');
      files.set(input.filePath, bytes);
      await new Promise(resolve => setImmediate(resolve));
      return { errMsg: 'writeFile:ok', writtenBytes: bytes.length };
    },
    async appendFile(input) {
      calls.push(['append', input.filePath, input.data.length]);
      assert.equal(input.encoding, 'base64');
      const bytes = Buffer.from(input.data, 'base64');
      files.set(input.filePath, Buffer.concat([files.get(input.filePath), bytes]));
      await new Promise(resolve => setImmediate(resolve));
      return { errMsg: 'appendFile:ok', writtenBytes: bytes.length };
    },
    async unlink(input) { calls.push(['unlink', input.filePath]); files.delete(input.filePath); return { errMsg: 'unlink:ok' }; }
  };
  Object.assign(sdk, overrides);
  return { sdk, calls, files, root, options };
}

function environment(sdk, readerOverrides = {}, syncOptions) {
  const reads = [];
  function FileReader() { this.result = null; this.error = null; }
  FileReader.prototype.readAsDataURL = function (part) {
    const index = reads.push(part.size);
    queueMicrotask(() => {
      if (readerOverrides.failAt === index) {
        this.error = new Error('synthetic read failure');
        this.onerror();
      } else {
        const bytes = readerOverrides.corruptAt === index ? part.bytes.subarray(1) : part.bytes;
        this.result = 'data:video/mp4;base64,' + bytes.toString('base64');
        this.onload();
      }
    });
  };
  const window = { FileReader };
  if (sdk) window.xhs = { miniTool: sdk, launchOptions: syncOptions };
  vm.runInNewContext(nativeFilesSource + '\n' + source, { window, Set, Number, Math, Date, Promise, Error });
  return { api: window.MiniVideo, reads, window };
}

test('dynamic native cap creates serial chunks and reconstructs exact bytes', async () => {
  const mock = nativeMock();
  const env = environment(mock.sdk);
  const input = Buffer.from(Array.from({ length: 1601 }, (_, index) => index % 251));
  const handle = await env.api.load(fileOf(input));
  assert.deepEqual(env.reads, [512, 512, 512, 65]);
  assert.deepEqual(mock.calls.filter(call => /^(write|append)$/.test(call[0])).map(call => call[0]),
    ['write', 'append', 'append', 'append']);
  assert.ok(handle.src.startsWith(mock.root + '/minitool-video-'));
  assert.deepEqual(mock.files.get(handle.src), input);
  await Promise.all([handle.release(), handle.release()]);
  await handle.release();
  assert.equal(mock.files.has(handle.src), false);
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
  assert.ok(mock.files.has(mock.root + '/keep.json'));
});

test('large native caps still limit decoded chunks to 512 KiB', async () => {
  const mock = nativeMock({ async getFileStorageInfo() { return { errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 10 * MiB }; } });
  const env = environment(mock.sdk);
  const bytes = Buffer.alloc(512 * 1024 + 17, 37);
  const handle = await env.api.load(fileOf(bytes));
  assert.deepEqual(env.reads, [512 * 1024, 17]);
  assert.deepEqual(mock.files.get(handle.src), bytes);
  await handle.release();
});

test('validates extension, MIME, empty files and 100 MiB limit before reading', async () => {
  const mock = nativeMock();
  const env = environment(mock.sdk);
  const cases = [
    fileOf(Buffer.alloc(1), { name: 'picture.png' }),
    fileOf(Buffer.alloc(1), { type: 'image/png' }),
    fileOf(Buffer.alloc(0)),
    fileOf(Buffer.alloc(1), { size: 100 * MiB + 1 }),
    fileOf(Buffer.alloc(1), { size: Infinity }),
    fileOf(Buffer.alloc(1), { size: 1.5 })
  ];
  for (const file of cases) await assert.rejects(env.api.load(file));
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(env.reads, []);
  const accepted = await env.api.load(fileOf(Buffer.alloc(1), { name: 'VIDEO.MP4', type: '' }));
  await accepted.release();
});

test('a rejected append cleans only this load even if native wrote before rejecting', async () => {
  const mock = nativeMock();
  const append = mock.sdk.appendFile;
  mock.sdk.appendFile = async input => {
    await append(input);
    throw { errMsg: 'appendFile:fail permission denied' };
  };
  const env = environment(mock.sdk);
  await assert.rejects(env.api.load(fileOf(Buffer.alloc(1100))), /视频未载入/);
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
  assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/keep.json']);
});

test('read failure after a first write and corrupted chunk are rejected and cleaned', async () => {
  for (const readerOptions of [{ failAt: 2 }, { corruptAt: 2 }]) {
    const mock = nativeMock();
    const env = environment(mock.sdk, readerOptions);
    await assert.rejects(env.api.load(fileOf(Buffer.alloc(1100))), /视频未载入/);
    assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
    assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/keep.json']);
  }
});

test('first read failure does not delete any native file', async () => {
  const mock = nativeMock();
  const env = environment(mock.sdk, { failAt: 1 });
  await assert.rejects(env.api.load(fileOf(Buffer.alloc(10))));
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 0);
});

test('native written byte mismatch is rejected and the generated path is cleaned', async () => {
  const mock = nativeMock();
  const write = mock.sdk.writeFile;
  mock.sdk.writeFile = async input => {
    const result = await write(input);
    return { errMsg: 'writeFile:ok', writtenBytes: result.writtenBytes - 1 };
  };
  await assert.rejects(environment(mock.sdk).api.load(fileOf(Buffer.alloc(9))));
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
});

test('failed release can retry and never deletes another video', async () => {
  const mock = nativeMock();
  const unlink = mock.sdk.unlink;
  let failOnce = true;
  mock.sdk.unlink = async input => {
    if (failOnce) { failOnce = false; throw new Error('synthetic denial'); }
    return unlink(input);
  };
  const env = environment(mock.sdk);
  const first = await env.api.load(fileOf(Buffer.alloc(20, 1)));
  const second = await env.api.load(fileOf(Buffer.alloc(20, 2)));
  assert.notEqual(first.src, second.src);
  await assert.rejects(first.release(), /清理失败/);
  assert.ok(mock.files.has(first.src));
  await first.release();
  assert.ok(mock.files.has(second.src));
  await second.release();
  assert.ok(mock.files.has(mock.root + '/keep.json'));
});

test('resolved SDK failure responses never become a successful load', async () => {
  for (const method of ['getLaunchOptions', 'getFileStorageInfo', 'writeFile', 'appendFile']) {
    for (const confirmation of [undefined, method + ':fail synthetic']) {
      const mock = nativeMock();
      const original = mock.sdk[method];
      mock.sdk[method] = async input => {
        const result = await original(input);
        return Object.assign({}, result, { errMsg: confirmation });
      };
      await assert.rejects(environment(mock.sdk).api.load(fileOf(Buffer.alloc(1100))));
      if (['writeFile', 'appendFile'].includes(method)) {
        assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
        assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/keep.json']);
      } else {
        assert.equal(mock.calls.some(call => /^(write|append|unlink)$/.test(call[0])), false);
      }
      assert.ok(mock.files.has(mock.root + '/keep.json'));
    }
  }
});

test('resolved unlink failure preserves ownership so release can retry', async () => {
  for (const confirmation of [undefined, 'unlink:fail synthetic']) {
    const mock = nativeMock();
    const handle = await environment(mock.sdk).api.load(fileOf(Buffer.alloc(20)));
    const unlink = mock.sdk.unlink;
    let refused = 0;
    mock.sdk.unlink = async input => {
      refused++;
      assert.equal(input.filePath, handle.src);
      return { errMsg: confirmation };
    };
    await assert.rejects(handle.release(), /清理失败/);
    assert.equal(refused, 1);
    assert.ok(mock.files.has(handle.src));
    mock.sdk.unlink = unlink;
    await handle.release();
    assert.equal(mock.files.has(handle.src), false);
    assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
    assert.ok(mock.files.has(mock.root + '/keep.json'));
  }
});

test('load reports cleanup failure without broad cleanup', async () => {
  const mock = nativeMock({
    async writeFile() { throw new Error('synthetic write denial'); },
    async unlink(input) { mock.calls.push(['unlink', input.filePath]); throw new Error('synthetic cleanup denial'); }
  });
  await assert.rejects(environment(mock.sdk).api.load(fileOf(Buffer.alloc(10))), error => {
    assert.equal(error.cleanupFailed, true);
    assert.match(error.message, /未能清理/);
    return true;
  });
  assert.equal(mock.calls.filter(call => call[0] === 'unlink').length, 1);
  assert.deepEqual(Array.from(mock.files.keys()), [mock.root + '/keep.json']);
});

test('older clients reject even tiny MP4 without reading or invoking temporary APIs', async () => {
  const mock = nativeMock();
  mock.options.miniToolEnv.buildVersion = 9489999;
  let temporaryCalls = 0;
  mock.sdk.writeTempFile = async () => { temporaryCalls++; throw Error('must never be called'); };
  const env = environment(mock.sdk);
  await assert.rejects(env.api.load(fileOf(Buffer.alloc(1))), /9.49.*字幕编辑仍可继续/);
  assert.deepEqual(env.reads, []);
  assert.equal(mock.calls.some(call => /^(info|write|append|unlink)$/.test(call[0])), false);
  assert.equal(temporaryCalls, 0);
});

test('missing, invalid or rejected launch version requires a client update without reading video', async () => {
  for (const getLaunchOptions of [undefined,
    async () => { throw new Error('unavailable'); },
    async () => ({ errMsg: 'getLaunchOptions:ok', miniToolEnv: {} }),
    async () => ({ errMsg: 'getLaunchOptions:ok', miniToolEnv: { buildVersion: 'invalid' } })]) {
    const mock = nativeMock(); mock.sdk.getLaunchOptions = getLaunchOptions;
    const env = environment(mock.sdk);
    await assert.rejects(env.api.load(fileOf(Buffer.alloc(1))), /9.49.*字幕编辑仍可继续/);
    assert.deepEqual(env.reads, []);
    assert.equal(mock.calls.some(call => /^(info|write|append|unlink)$/.test(call[0])), false);
  }
});

test('missing SDK, native root, methods, cap and space fail without writing', async () => {
  await assert.rejects(environment(null).api.load(fileOf(Buffer.alloc(1))), /小红书小工具容器/);
  for (const configure of [
    mock => { mock.options.miniToolEnv.userDataPath = ''; },
    mock => { delete mock.sdk.appendFile; },
    mock => { mock.sdk.getFileStorageInfo = async () => ({ errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 0 }); },
    mock => { mock.sdk.getFileStorageInfo = async () => ({ errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: Infinity }); },
    mock => { mock.sdk.getFileStorageInfo = async () => ({ errMsg: 'getFileStorageInfo:ok', writeChunkMaxBytes: 1024, usedBytes: 9, limitBytes: 10 }); },
    mock => { mock.sdk.getFileStorageInfo = async () => { throw new Error('synthetic permission denial'); }; }
  ]) {
    const mock = nativeMock();
    configure(mock);
    const env = environment(mock.sdk);
    await assert.rejects(env.api.load(fileOf(Buffer.alloc(12))));
    assert.equal(mock.calls.some(call => /^(write|append|unlink)$/.test(call[0])), false);
    assert.deepEqual(env.reads, []);
  }
});

test('guarded sync launch options retain native root exactly and ignore build sequence', async () => {
  const mock = nativeMock({ async getLaunchOptions() { throw new Error('sync should be enough'); } });
  const sync = { miniToolEnv: { buildVersion: '9490999', userDataPath: 'opaque-root-with-trailing/' } };
  const handle = await environment(mock.sdk, {}, sync).api.load(fileOf(Buffer.alloc(1)));
  assert.ok(handle.src.startsWith(sync.miniToolEnv.userDataPath + '/minitool-video-'));
  await handle.release();
});

test('absent reader rejects cleanly', async () => {
  const env = environment(nativeMock().sdk);
  delete env.window.FileReader;
  await assert.rejects(env.api.load(fileOf(Buffer.alloc(1))), /无法读取/);
});

test('reader constructor and synchronous read failures keep a clear error', async () => {
  const sdk = nativeMock().sdk;
  const constructorFailure = environment(sdk);
  constructorFailure.window.FileReader = function () { throw new Error('synthetic constructor failure'); };
  constructorFailure.window.FileReader.prototype.readAsDataURL = function () {};
  await assert.rejects(constructorFailure.api.load(fileOf(Buffer.alloc(1))), error => {
    assert.match(error.message, /视频未载入.*字幕编辑/);
    assert.match(error.nativeError.message, /无法开始读取/);
    return true;
  });
  const readFailure = environment(sdk);
  readFailure.window.FileReader.prototype.readAsDataURL = function () { throw new Error('synthetic read failure'); };
  await assert.rejects(readFailure.api.load(fileOf(Buffer.alloc(1))), error => {
    assert.match(error.message, /视频未载入.*字幕编辑/);
    assert.match(error.nativeError.message, /读取本地视频失败/);
    return true;
  });
  const noSDK = environment(null);
  delete noSDK.window.FileReader;
  await assert.rejects(noSDK.api.load(fileOf(Buffer.alloc(1))), /小红书小工具容器/);
});

test('production source has no modern syntax or prohibited media/network paths', () => {
  assert.doesNotMatch(nativeFilesSource + source, /\?\.|\?\?|\bglobalThis\b|\bimport\s|\bexport\s|catch\s*\{/);
  assert.doesNotMatch(nativeFilesSource + source, /createObjectURL|\.text\(|fetch\s*\(|XMLHttpRequest|navigator\.clipboard|execCommand|\.download\s*=|new\s+Worker/);
  assert.doesNotMatch(nativeFilesSource + source, /writeTempFile|loadTemporary|data:video\/mp4/);
});
