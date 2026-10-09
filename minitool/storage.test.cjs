const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'storage.js'), 'utf8');
const PREFIX = 'bse-mini:v1:';
const MANIFEST = PREFIX + 'manifest';
const CHUNK_PREFIX = PREFIX + 'chunk:';
const detached = value => JSON.parse(JSON.stringify(value));

function browserStorage(values = new Map()) {
  const settings = { failWrite: null, failRead: false, writes: [], removed: [] };
  const storage = {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] || null; },
    getItem(key) {
      if (settings.failRead) throw new Error('browser read blocked');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      settings.writes.push({ key, value });
      if (settings.failWrite && settings.failWrite(key, value)) throw new Error('browser quota exceeded');
      values.set(key, value);
    },
    removeItem(key) { settings.removed.push(key); values.delete(key); }
  };
  return { storage, values, settings };
}

function nativeStorage(values = new Map()) {
  const settings = { failWrite: null, failRead: null, failInfo: false, failRemove: false,
    writes: [], removed: [], infoCalls: 0, readCalls: 0, delay: 0, active: 0, maximumActive: 0,
    currentSize: null, limitSize: 10240 };
  const miniTool = {
    async setStorage(options) {
      assert.deepEqual(Object.keys(options).sort(), ['data', 'key']);
      assert.equal(typeof options.key, 'string');
      assert.equal(typeof options.data, 'string');
      JSON.parse(options.data); // SDK requires valid JSON, including every chunk.
      assert.ok(Buffer.byteLength(options.data, 'utf8') < 1024 * 1024, 'each native key is below 1 MiB');
      settings.writes.push({ key: options.key, data: options.data });
      settings.active += 1;
      settings.maximumActive = Math.max(settings.maximumActive, settings.active);
      try {
        if (settings.delay) await new Promise(resolve => setTimeout(resolve, settings.delay));
        if (settings.failWrite && settings.failWrite(options.key, options.data)) {
          throw { errMsg: 'setStorage:fail quota exceeded', errCode: 1001 };
        }
        values.set(options.key, options.data);
        return { errMsg: 'setStorage:ok' };
      } finally { settings.active -= 1; }
    },
    async getStorage(options) {
      assert.deepEqual(Object.keys(options), ['key']);
      settings.readCalls += 1;
      if (settings.failRead && settings.failRead(options.key)) throw { errMsg: 'getStorage:fail unavailable' };
      return { errMsg: 'getStorage:ok', data: values.has(options.key) ? values.get(options.key) : null };
    },
    async getStorageInfo() {
      assert.equal(arguments.length, 0);
      settings.infoCalls += 1;
      if (settings.failInfo) throw { errMsg: 'getStorageInfo:fail unavailable' };
      const actualBytes = Array.from(values).reduce((sum, [key, data]) => sum +
        Buffer.byteLength(key, 'utf8') + Buffer.byteLength(data, 'utf8'), 0);
      return { errMsg: 'getStorageInfo:ok', keys: Array.from(values.keys()),
        currentSize: settings.currentSize === null ? actualBytes / 1024 : settings.currentSize,
        limitSize: settings.limitSize };
    },
    async removeStorage(options) {
      assert.deepEqual(Object.keys(options), ['key']);
      if (settings.failRemove) throw { errMsg: 'removeStorage:fail unavailable' };
      settings.removed.push(options.key);
      values.delete(options.key);
      return { errMsg: 'removeStorage:ok' };
    }
  };
  return { miniTool, values, settings };
}

function load(options = {}) {
  const browser = options.browser || browserStorage();
  const window = {};
  if (options.xhs !== undefined) window.xhs = options.xhs;
  if (options.browserGetterFailure) {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('access denied'); } });
  } else window.localStorage = browser.storage;
  vm.runInNewContext(source, { window }, { filename: 'storage.js' });
  return { store: window.MiniProjectStore, browser, window };
}

function nativeLoad(native, buildVersion = 9460000, extra = {}) {
  return load({ xhs: { launchOptions: { miniToolEnv: { buildVersion } }, miniTool: native.miniTool }, ...extra });
}

function project(id, text = '原字幕 Original subtitle', title = '工程 ' + id) {
  return { id, title, lastIndex: 3, rows: [{ id: 'r-1', text, translation: '完整快照' }],
    extra: { color: '#ffe97c', enabled: true } };
}

test('native version threshold ignores the final three build digits', async () => {
  for (const build of [9460000, 9460001, 9460999, 9462004, '9460000']) {
    const native = nativeStorage();
    const { store, browser } = nativeLoad(native, build);
    await store.init();
    assert.equal(store.mode, 'native');
    assert.equal(browser.settings.writes.length, 0);
    await store.save(project('client-' + build));
    assert.equal(store.last(), 'client-' + build);
  }
  for (const build of [9459999, 9459000, 0, null, NaN, Infinity, {}, true]) {
    const native = nativeStorage();
    const { store } = nativeLoad(native, build);
    await store.init();
    assert.equal(store.mode, 'browser');
    assert.equal(native.settings.infoCalls, 0);
  }
});

test('asynchronous version lookup is guarded and only runs when the sync version is absent', async () => {
  let calls = 0;
  const native = nativeStorage();
  native.miniTool.getLaunchOptions = async function () {
    assert.equal(arguments.length, 0);
    calls += 1;
    return { miniToolEnv: { buildVersion: 9462004 } };
  };
  const { store } = load({ xhs: { miniTool: native.miniTool } });
  await store.init();
  assert.equal(calls, 1);
  assert.equal(store.mode, 'native');
  const { store: low } = nativeLoad(native, 9459999);
  await low.init();
  assert.equal(calls, 1);
  assert.equal(low.mode, 'browser');

  native.miniTool.getLaunchOptions = async () => { throw new Error('launch options blocked'); };
  const { store: unknown } = load({ xhs: { miniTool: native.miniTool } });
  await unknown.init();
  assert.equal(unknown.mode, 'browser');
});

test('missing SDK or incomplete storage API uses guarded browser storage', async () => {
  for (const xhs of [undefined, {}, { miniTool: {} }, { launchOptions: {}, miniTool: {} }]) {
    const { store } = load({ xhs });
    await store.init();
    assert.equal(store.mode, 'browser');
    await store.save(project('offline'));
    assert.deepEqual(detached(await store.get('offline')), project('offline'));
  }
  for (const name of ['setStorage', 'getStorage', 'getStorageInfo', 'removeStorage']) {
    const native = nativeStorage();
    delete native.miniTool[name];
    const { store } = nativeLoad(native);
    await store.init();
    assert.equal(store.mode, 'browser');
  }
  const { store: unknown } = load({ xhs: { miniTool: nativeStorage().miniTool } });
  await unknown.init();
  assert.equal(unknown.mode, 'browser');
});

test('Unicode projects are chunked as JSON strings and restored with every field', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  const input = project('unicode', ('你好🌏\\"\n').repeat(55000), '中英字幕🎬');
  await store.save(input);
  const chunks = native.settings.writes.filter(call => call.key.startsWith(CHUNK_PREFIX));
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const text = JSON.parse(chunk.data);
    assert.equal(typeof text, 'string');
    assert.ok(text.length <= 200000);
    assert.ok(Buffer.byteLength(chunk.data) < 1024 * 1024);
    const tail = text.charCodeAt(text.length - 1);
    assert.ok(!(tail >= 55296 && tail <= 56319), 'chunks do not split a surrogate pair');
  }
  assert.deepEqual(detached(await store.get(input.id)), input);
  assert.equal(store.last(), input.id);
});

test('a fresh instance restores multiple projects and last, and returned objects are detached', async () => {
  const native = nativeStorage();
  const first = nativeLoad(native).store;
  await first.save(project('first'));
  await first.save(project('second', '新字幕'));
  const restored = nativeLoad(native).store;
  await restored.init();
  assert.deepEqual(detached(restored.list()), [
    { id: 'first', title: '工程 first' }, { id: 'second', title: '工程 second' }
  ]);
  assert.equal(restored.last(), 'second');
  assert.deepEqual(detached(await restored.get('first')), project('first'));
  const retrieved = await restored.get('second');
  retrieved.rows[0].text = 'mutated';
  const list = restored.list();
  list[0].title = 'mutated';
  assert.equal((await restored.get('second')).rows[0].text, '新字幕');
  assert.equal(restored.list()[0].title, '工程 first');
  assert.equal(await restored.get('missing'), null);
});

test('partial chunk failure and manifest failure preserve the previous committed snapshot', async () => {
  const native = nativeStorage();
  native.values.set('unrelated-setting', '{"keep":true}');
  native.values.set(CHUNK_PREFIX + 'not-a-generation', '"keep too"');
  const { store, browser } = nativeLoad(native);
  const original = project('stable');
  await store.save(original);
  const committed = native.values.get(MANIFEST);
  const originalKeys = Array.from(native.values.keys()).filter(key => key.startsWith(CHUNK_PREFIX));
  const updated = project('stable', '🌏字幕'.repeat(110000), '新标题');
  native.settings.failWrite = key => key.startsWith(CHUNK_PREFIX) && key.endsWith(':1');
  await assert.rejects(store.save(updated), /quota exceeded/);
  assert.equal(native.values.get(MANIFEST), committed);
  assert.deepEqual(detached(store.list()), [{ id: original.id, title: original.title }]);
  assert.equal(store.last(), original.id);
  assert.deepEqual(detached(await store.get(original.id)), original);
  assert.equal(browser.settings.writes.length, 0);
  for (const key of originalKeys) assert.ok(native.values.has(key));
  assert.equal(native.settings.removed.length, 0, 'failed saves do not clean previous generations');

  native.settings.failWrite = key => key === MANIFEST;
  await assert.rejects(store.save(updated), /quota exceeded/);
  assert.equal(native.values.get(MANIFEST), committed);
  assert.deepEqual(detached(await nativeLoad(native).store.get(original.id)), original);
  assert.equal(native.settings.removed.length, 0);

  native.settings.failWrite = null;
  await store.save(updated);
  assert.deepEqual(detached(await store.get(updated.id)), updated);
  const liveEntry = JSON.parse(native.values.get(MANIFEST)).projects[0];
  const ownChunks = Array.from(native.values.keys()).filter(key => key.startsWith(CHUNK_PREFIX) && key !== CHUNK_PREFIX + 'not-a-generation');
  assert.equal(ownChunks.length, liveEntry.chunks, 'a successful commit cleans orphaned own generations');
  assert.ok(native.values.has('unrelated-setting'));
  assert.ok(native.values.has(CHUNK_PREFIX + 'not-a-generation'));
});

test('cleanup never deletes another saved project and failures after commit do not reject save', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await store.save(project('kept'));
  await store.save(project('updated'));
  native.settings.failRemove = true;
  await store.save(project('updated', 'replacement'));
  assert.equal(store.last(), 'updated');
  assert.deepEqual(detached(await store.get('kept')), project('kept'));
  assert.deepEqual(detached(await store.get('updated')), project('updated', 'replacement'));
});

test('native capacity preflight and SDK quota failure reject without changing the manifest', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await store.save(project('stable'));
  const committed = native.values.get(MANIFEST);
  const writes = native.settings.writes.length;
  native.settings.currentSize = 10230;
  await assert.rejects(store.save(project('new', 'text'.repeat(10000))), /Not enough space/);
  assert.equal(native.settings.writes.length, writes);
  assert.equal(native.values.get(MANIFEST), committed);
  native.settings.currentSize = null;
  native.settings.failWrite = key => key.startsWith(CHUNK_PREFIX);
  await assert.rejects(store.save(project('new')), exception => exception.errCode === 1001);
  assert.equal(native.values.get(MANIFEST), committed);
  assert.equal(store.last(), 'stable');
  assert.deepEqual(detached(await store.get('stable')), project('stable'));
});

test('native init failure stays native, rejects future saves, and never purges or falls back', async () => {
  const native = nativeStorage();
  const existing = nativeLoad(native).store;
  await existing.save(project('existing'));
  const before = new Map(native.values);
  native.settings.failInfo = true;
  const { store, browser } = nativeLoad(native);
  await assert.rejects(store.init(), /unavailable/);
  assert.equal(store.mode, 'native');
  await assert.rejects(store.save(project('accidental-empty-replacement')), /unavailable/);
  assert.equal(browser.settings.writes.length, 0);
  assert.deepEqual(native.values, before);
});

test('every native success response requires its documented API errMsg', async () => {
  for (const api of ['getStorageInfo', 'getStorage']) {
    for (const marker of [api + ':fail blocked', undefined, 'differentApi:ok']) {
      const native = nativeStorage();
      await nativeLoad(native).store.save(project('saved'));
      const before = new Map(native.values);
      if (api === 'getStorageInfo') {
        native.miniTool.getStorageInfo = async () => ({ errMsg: marker, keys: [], currentSize: 0, limitSize: 10240 });
      } else native.miniTool.getStorage = async () => ({ errMsg: marker, data: null });
      const { store, browser } = nativeLoad(native);
      await assert.rejects(store.init(), exception => exception.code === 'STORAGE_FAILED');
      assert.equal(store.mode, 'native');
      await assert.rejects(store.save(project('empty-replacement')), exception => exception.code === 'STORAGE_FAILED');
      assert.equal(browser.settings.writes.length, 0);
      assert.deepEqual(native.values, before);
    }
  }

  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await store.save(project('saved'));
  const originalGet = native.miniTool.getStorage;
  native.miniTool.getStorage = async options => options.key.startsWith(CHUNK_PREFIX)
    ? { errMsg: 'getStorage:fail read blocked', data: null } : originalGet(options);
  await assert.rejects(store.get('saved'), /read blocked/);
  assert.equal(store.mode, 'native');
});

test('removeStorage resolve-fail is never considered successful cleanup', async () => {
  const native = nativeStorage();
  native.settings.limitSize = 2048;
  const { store } = nativeLoad(native);
  await store.save(project('kept'));
  await store.save(project('large', 'A'.repeat(750000)));
  const originalRemove = native.miniTool.removeStorage;
  native.miniTool.removeStorage = async () => ({ errMsg: 'removeStorage:fail busy' });
  await store.save(project('large', 'B'.repeat(750000)));
  const before = native.values.get(MANIFEST);
  await assert.rejects(store.save(project('large', 'C'.repeat(750000))), /Not enough space/);
  assert.equal(native.values.get(MANIFEST), before);
  assert.equal((await store.get('large')).rows[0].text, 'B'.repeat(750000));
  native.miniTool.removeStorage = originalRemove;
  await store.save(project('large', 'C'.repeat(750000)));
  assert.equal((await store.get('large')).rows[0].text, 'C'.repeat(750000));
  assert.deepEqual(detached(await store.get('kept')), project('kept'));
});

test('a manifest that actually committed with a fail response blocks later overwrite and cleanup', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await store.save(project('saved', 'old snapshot'));
  const originalWrite = native.miniTool.setStorage;
  native.miniTool.setStorage = async options => {
    const result = await originalWrite(options);
    return options.key === MANIFEST ? { errMsg: 'setStorage:fail unconfirmed commit' } : result;
  };
  await assert.rejects(store.save(project('saved', 'new snapshot')), /unconfirmed commit/);
  const afterUnconfirmed = new Map(native.values);
  const writes = native.settings.writes.length;
  const removes = native.settings.removed.length;
  await assert.rejects(store.save(project('saved', 'must not overwrite')), exception => exception.code === 'STALE_STORAGE');
  assert.equal(native.settings.writes.length, writes);
  assert.equal(native.settings.removed.length, removes);
  assert.deepEqual(native.values, afterUnconfirmed);
  assert.equal((await nativeLoad(native).store.get('saved')).rows[0].text, 'new snapshot');
});

test('a stale instance cannot overwrite or clean a newer committed manifest', async () => {
  const native = nativeStorage();
  const first = nativeLoad(native).store;
  await first.save(project('first'));
  const stale = nativeLoad(native).store;
  await stale.init();
  await first.save(project('second'));
  const newer = new Map(native.values);
  const writes = native.settings.writes.length;
  const removes = native.settings.removed.length;
  await assert.rejects(stale.save(project('stale-write')), exception => exception.code === 'STALE_STORAGE');
  assert.equal(native.settings.writes.length, writes);
  assert.equal(native.settings.removed.length, removes);
  assert.deepEqual(native.values, newer);
  assert.equal((await first.get('second')).id, 'second');
});

test('a manifest change during staging is detected before commit and does not remove live data', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await store.save(project('saved'));
  const originalWrite = native.miniTool.setStorage;
  let changed = false;
  let otherManifest;
  native.miniTool.setStorage = async options => {
    const result = await originalWrite(options);
    if (!changed && options.key.startsWith(CHUNK_PREFIX)) {
      changed = true;
      const parsed = JSON.parse(native.values.get(MANIFEST));
      parsed.externalChange = true;
      otherManifest = JSON.stringify(parsed);
      native.values.set(MANIFEST, otherManifest);
    }
    return result;
  };
  const removes = native.settings.removed.length;
  await assert.rejects(store.save(project('new')), exception => exception.code === 'STALE_STORAGE');
  assert.equal(native.values.get(MANIFEST), otherManifest);
  assert.equal(native.settings.removed.length, removes);
  assert.deepEqual(detached(await store.get('saved')), project('saved'));
});

test('unavailable browser storage enters memory mode and cannot falsely report a successful save', async () => {
  const blocked = browserStorage();
  blocked.settings.failWrite = () => true;
  for (const options of [{ browser: blocked }, { browserGetterFailure: true }]) {
    const { store } = load(options);
    await store.init();
    assert.equal(store.mode, 'memory');
    await assert.rejects(store.save(project('unsaved')), /unavailable/);
    assert.deepEqual(detached(store.list()), []);
    assert.equal(store.last(), null);
    assert.equal(await store.get('unsaved'), null);
  }
});

test('browser write failure preserves the committed snapshot, list, and last pointer', async () => {
  const browser = browserStorage();
  const { store } = load({ browser });
  await store.save(project('old'));
  const committed = browser.values.get(MANIFEST);
  browser.settings.failWrite = key => key.startsWith(CHUNK_PREFIX) && key.endsWith(':1');
  await assert.rejects(store.save(project('old', '字'.repeat(250000), 'changed')), /quota exceeded/);
  assert.equal(browser.values.get(MANIFEST), committed);
  assert.equal(store.mode, 'browser');
  assert.equal(store.last(), 'old');
  assert.deepEqual(detached(await store.get('old')), project('old'));
  browser.settings.failWrite = key => key === MANIFEST;
  await assert.rejects(store.save(project('another')), /quota exceeded/);
  assert.equal(browser.values.get(MANIFEST), committed);
  assert.deepEqual(detached(store.list()), [{ id: 'old', title: '工程 old' }]);
});

test('malformed registries reject restore without overwriting or cleaning existing bytes', async () => {
  for (const raw of ['not json', '{}', '{"version":1,"last":null,"projects":{}}',
    JSON.stringify({ version: 1, last: 'unknown', projects: [] }), 'x'.repeat(65537)]) {
    const native = nativeStorage(new Map([[MANIFEST, raw], ['other', '1']]));
    const { store } = nativeLoad(native);
    await assert.rejects(store.init(), /damaged/);
    await assert.rejects(store.save(project('fresh')), /damaged/);
    assert.equal(native.values.get(MANIFEST), raw);
    assert.equal(native.settings.writes.length, 0);
    assert.equal(native.settings.removed.length, 0);
  }
  const browser = browserStorage(new Map([[MANIFEST, 'not json']]));
  const { store } = load({ browser });
  await assert.rejects(store.init(), /damaged/);
  assert.equal(store.mode, 'browser');
  await assert.rejects(store.save(project('fresh')), /damaged/);
  assert.equal(browser.values.get(MANIFEST), 'not json');
});

test('invalid native metadata and corrupt chunks are bounded and never purged', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await store.save(project('saved'));
  const committed = native.values.get(MANIFEST);
  const entry = JSON.parse(committed).projects[0];
  const key = CHUNK_PREFIX + entry.generation + ':0';
  const removed = native.settings.removed.length;
  for (const raw of ['not json', '{}', '"wrong data"', '"' + 'x'.repeat(400001) + '"']) {
    native.values.set(key, raw);
    assert.equal(await store.get('saved'), null);
    assert.equal(native.values.get(MANIFEST), committed);
    assert.equal(native.settings.removed.length, removed);
  }
  const invalid = JSON.parse(committed);
  invalid.projects[0].chunks = 10000000;
  native.values.set(MANIFEST, JSON.stringify(invalid));
  const fresh = nativeLoad(native).store;
  await assert.rejects(fresh.init(), /damaged/);
  assert.equal(native.settings.removed.length, removed);
  assert.equal(native.values.get(MANIFEST), JSON.stringify(invalid));
});

test('project limits are checked before any storage writes', async () => {
  const native = nativeStorage();
  const { store } = nativeLoad(native);
  await assert.rejects(store.save(project('oversize', '字'.repeat(3 * 1024 * 1024))), /8 MiB/);
  await assert.rejects(store.save({ id: 'valid', title: 'x'.repeat(201) }), /invalid/);
  await assert.rejects(store.save({ id: 'x'.repeat(129), title: 'valid' }), /invalid/);
  const cyclic = project('cycle');
  cyclic.self = cyclic;
  await assert.rejects(store.save(cyclic), /serialized/);
  assert.equal(native.settings.writes.length, 0);
  for (let i = 0; i < 50; i += 1) await store.save(project('project-' + i));
  const writes = native.settings.writes.length;
  await assert.rejects(store.save(project('51st')), /50 projects/);
  assert.equal(native.settings.writes.length, writes);
  await store.save(project('project-0', 'an existing project can still be updated'));
  assert.equal(store.list().length, 50);
});

test('concurrent saves are serialized, capture invocation snapshots, and leave the latest commit restorable', async () => {
  const native = nativeStorage();
  native.settings.delay = 2;
  const { store } = nativeLoad(native);
  const input = project('same', 'A'.repeat(250000), 'First');
  const first = store.save(input);
  input.title = 'Second';
  input.rows[0].text = 'B'.repeat(250000);
  const second = store.save(input);
  const read = store.get('same');
  const third = store.save(project('last', 'C'.repeat(250000), 'Third'));
  await Promise.all([first, second, third]);
  assert.equal((await read).title, 'Second');
  assert.equal(native.settings.maximumActive, 1);
  const writes = native.settings.writes;
  const commits = writes.map((call, index) => call.key === MANIFEST ? index : -1).filter(index => index !== -1);
  assert.equal(commits.length, 3);
  let start = 0;
  for (const commit of commits) {
    const descriptor = JSON.parse(writes[commit].data).projects.find(entry =>
      writes[start].key.startsWith(CHUNK_PREFIX + entry.generation + ':'));
    assert.ok(descriptor);
    assert.equal(commit - start, descriptor.chunks);
    for (let index = start; index < commit; index += 1) {
      assert.ok(writes[index].key.startsWith(CHUNK_PREFIX + descriptor.generation + ':'));
    }
    start = commit + 1;
  }
  assert.equal(store.last(), 'last');
  assert.equal((await store.get('same')).rows[0].text, 'B'.repeat(250000));
  const restored = nativeLoad(native).store;
  await restored.init();
  assert.equal(restored.last(), 'last');
  assert.deepEqual(detached(await restored.get('last')), project('last', 'C'.repeat(250000), 'Third'));
});

test('browser-to-native migration imports complete snapshots and imports the old last project last', async () => {
  const browser = browserStorage();
  const old = load({ browser }).store;
  await old.save(project('last', '中英🌏'.repeat(80000), '旧工程最后使用'));
  await old.save(project('other'));
  await old.save(project('last', '中英🌏'.repeat(80000), '旧工程最后使用'));
  const browserBefore = new Map(browser.values);
  const native = nativeStorage();
  const current = nativeLoad(native, 9460000, { browser }).store;
  await current.init();
  assert.deepEqual(detached(await current.migrateBrowser()), { migrated: 2, skipped: 0 });
  assert.equal(current.last(), 'last');
  assert.deepEqual(detached(await current.get('last')), project('last', '中英🌏'.repeat(80000), '旧工程最后使用'));
  assert.deepEqual(detached(await current.get('other')), project('other'));
  assert.deepEqual(browser.values, browserBefore, 'migration never writes or deletes legacy browser data');
});

test('migration never overwrites a native ID and preserves an existing native last pointer', async () => {
  const browser = browserStorage();
  const old = load({ browser }).store;
  await old.save(project('duplicate', 'old browser version'));
  await old.save(project('missing', 'browser-only project'));
  const browserBefore = new Map(browser.values);
  const native = nativeStorage();
  const current = nativeLoad(native, 9460000, { browser }).store;
  await current.save(project('duplicate', 'new native version'));
  assert.deepEqual(detached(await current.migrateBrowser()), { migrated: 1, skipped: 1 });
  assert.equal(current.last(), 'duplicate');
  assert.deepEqual(detached(await current.get('duplicate')), project('duplicate', 'new native version'));
  assert.deepEqual(detached(await current.get('missing')), project('missing', 'browser-only project'));
  const writes = native.settings.writes.length;
  assert.deepEqual(detached(await current.migrateBrowser()), { migrated: 0, skipped: 2 });
  assert.equal(native.settings.writes.length, writes, 'retry must not duplicate or overwrite native snapshots');
  assert.deepEqual(browser.values, browserBefore);
});

test('interrupted migration retains every committed and browser snapshot and can import the remainder later', async () => {
  const browser = browserStorage();
  const old = load({ browser }).store;
  for (const id of ['a', 'b', 'c']) await old.save(project(id));
  const browserBefore = new Map(browser.values);
  const native = nativeStorage();
  native.settings.failWrite = (key, data) => key.startsWith(CHUNK_PREFIX) && JSON.parse(data).includes('"id":"b"');
  const current = nativeLoad(native, 9460000, { browser }).store;
  await assert.rejects(current.migrateBrowser(), exception => exception.code === 'MIGRATION_FAILED' && exception.migrated === 1);
  assert.deepEqual(detached(await current.get('a')), project('a'));
  assert.equal(await current.get('b'), null);
  assert.equal(await current.get('c'), null);
  assert.equal(current.last(), 'a');
  assert.deepEqual(browser.values, browserBefore);
  native.settings.failWrite = null;
  const reopened = nativeLoad(native, 9460000, { browser }).store;
  assert.deepEqual(detached(await reopened.migrateBrowser()), { migrated: 2, skipped: 1 });
  assert.equal(reopened.last(), 'a', 'a native last pointer already present on retry remains authoritative');
  for (const id of ['a', 'b', 'c']) assert.deepEqual(detached(await reopened.get(id)), project(id));
  assert.deepEqual(browser.values, browserBefore);
});

test('unavailable/absent browser storage and non-native environments have no migration', async () => {
  const native = nativeStorage();
  const inaccessible = nativeLoad(native, 9460000, { browserGetterFailure: true }).store;
  assert.deepEqual(detached(await inaccessible.migrateBrowser()), { migrated: 0, skipped: 0 });
  const absent = nativeLoad(native).store;
  assert.deepEqual(detached(await absent.migrateBrowser()), { migrated: 0, skipped: 0 });
  const low = nativeLoad(native, 9459999).store;
  assert.deepEqual(detached(await low.migrateBrowser()), { migrated: 0, skipped: 0 });
  assert.equal(low.mode, 'browser');
  assert.equal(native.settings.writes.length, 0);
});

test('unreadable or corrupt browser migration data is rejected without changing either store', async () => {
  for (const scenario of ['read', 'registry', 'chunk']) {
    const browser = browserStorage();
    const old = load({ browser }).store;
    await old.save(project('legacy'));
    if (scenario === 'read') browser.settings.failRead = true;
    if (scenario === 'registry') browser.values.set(MANIFEST, '{}');
    if (scenario === 'chunk') {
      const entry = JSON.parse(browser.values.get(MANIFEST)).projects[0];
      browser.values.set(CHUNK_PREFIX + entry.generation + ':0', '"corrupt"');
    }
    const before = new Map(browser.values);
    const native = nativeStorage();
    const current = nativeLoad(native, 9460000, { browser }).store;
    await assert.rejects(current.migrateBrowser(), exception => exception.code === 'MIGRATION_FAILED');
    assert.equal(current.mode, 'native');
    assert.equal(native.settings.writes.length, 0);
    assert.deepEqual(browser.values, before);
  }
});

test('concurrent migration calls share one run without holding the save queue', async () => {
  const browser = browserStorage();
  const old = load({ browser }).store;
  await old.save(project('first'));
  await old.save(project('last'));
  const native = nativeStorage();
  native.settings.delay = 1;
  const current = nativeLoad(native, 9460000, { browser }).store;
  const first = current.migrateBrowser();
  const second = current.migrateBrowser();
  assert.equal(first, second);
  const result = await Promise.all([first, second]);
  assert.deepEqual(detached(result), [{ migrated: 2, skipped: 0 }, { migrated: 2, skipped: 0 }]);
  assert.equal(native.settings.writes.filter(call => call.key === MANIFEST).length, 2);
  assert.equal(native.settings.maximumActive, 1);
  assert.equal(current.last(), 'last');
});
