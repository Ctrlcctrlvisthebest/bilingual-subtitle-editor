const test = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('./browser-project-store.js');
const row = (id, zh = id) => ({id, start: 0, end: 1, zh, en: id, speaker: 'Unknown', status: '疑点待听校', note: ''});
const project = id => ({version: 1, revision: 4, editor_id: id, title: '工程 ' + id, colors: {Unknown: '#455a64'}, rows: [row('a'), row('b'), row('c')]});

function storageFixture(records = [], localEntries = {}) {
  const databaseRecords = new Map(records.map(record => [record.editor_id, structuredClone(record)]));
  const local = new Map(Object.entries(localEntries));
  const failures = new Set();
  const writes = [];
  const db = {
    close() {},
    transaction(name, mode) {
      assert.equal(name, 'projects');
      const transaction = {
        objectStore(storeName) {
          assert.equal(storeName, 'projects');
          return {
            getAll() {
              const request = {};
              queueMicrotask(() => {request.result = structuredClone([...databaseRecords.values()]); request.onsuccess();});
              return request;
            },
            put(record) {
              assert.equal(mode, 'readwrite');
              const snapshot = structuredClone(record);
              writes.push(snapshot);
              queueMicrotask(() => {
                if (failures.has(snapshot.editor_id)) {
                  transaction.error = Error('工程 ' + snapshot.editor_id + ' 写入失败');
                  transaction.onabort();
                } else {
                  databaseRecords.set(snapshot.editor_id, snapshot);
                  transaction.oncomplete();
                }
              });
            }
          };
        }
      };
      return transaction;
    }
  };
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, 'bilingual-subtitle-editor');
      assert.equal(version, 1);
      const request = {};
      queueMicrotask(() => {request.result = db; request.onsuccess();});
      return request;
    }
  };
  globalThis.localStorage = {getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value)};
  return {databaseRecords, local, failures, writes};
}

async function initializedStore() {
  const {createBrowserProjectStore} = await modulePromise;
  const states = [], errors = [];
  const store = createBrowserProjectStore({onStatus: state => states.push(state), onError: error => errors.push(error)});
  await store.init(project('blank'));
  return {store, states, errors};
}

test('schema 2 restores complete isolated projects and each selected row index', async () => {
  const a = project('A'), b = project('B');
  a.rows[1].note = 'A 的校对笔记';
  a.reference = {source: '原参考字幕'};
  b.rows[1].zh = 'B 的字幕';
  const fixture = storageFixture([
    {schemaVersion: 2, editor_id: 'A', project: a, index: 2},
    {schemaVersion: 2, editor_id: 'B', project: b, index: 1}
  ]);
  const {store, states} = await initializedStore();
  assert.equal((await store.get('A')).lastIndex, 2);
  assert.equal((await store.get('B')).lastIndex, 1);
  assert.equal((await store.get('A')).rows[1].note, 'A 的校对笔记');
  assert.deepEqual((await store.get('A')).reference, a.reference);
  const editing = await store.get('A');
  editing.title = 'A 的新标题'; editing.rows[0].zh = 'A 的新校对';
  store.save(editing, 1);
  assert.equal(await store.flush(), true);
  const record = fixture.databaseRecords.get('A');
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.editor_id, 'A');
  assert.equal(record.index, 1);
  assert.deepEqual(record.project, editing);
  editing.rows[0].zh = 'flush 后继续编辑';
  assert.equal(record.project.rows[0].zh, 'A 的新校对');
  assert.deepEqual(fixture.databaseRecords.get('B').project, b);
  assert.equal(await store.getLastId(), 'A');
  assert.equal(states.at(-1).mode, 'browser');
  assert.equal(states.at(-1).errors.length, 0);

  const {store: reopened} = await initializedStore();
  assert.equal((await reopened.get('A')).lastIndex, 1);
  assert.equal((await reopened.get('A')).rows[0].zh, 'A 的新校对');
  assert.equal((await reopened.get('B')).rows[1].zh, 'B 的字幕');
  const returned = await reopened.get('A'); returned.rows[0].zh = '不应修改缓存';
  assert.equal((await reopened.get('A')).rows[0].zh, 'A 的新校对');
  assert.equal(await reopened.get('missing'), null);
  assert.deepEqual(new Map(reopened.list().map(item => [item.id, item.title])).get('A'), 'A 的新标题');
});

test('legacy bare projects merge known local patches, additions, deletions and unedited source updates', async () => {
  const base = project('legacy-generic');
  base.rows[0].en = '新底稿';
  base.subtitle_updates = [{rows: [{id: 'a', before: {en: '旧底稿'}, after: {en: '新底稿'}}]}];
  const newRow = row('added', '用户新增字幕');
  const saved = {
    revision: 4, index: 1, order: ['added', 'a'], colors: {Unknown: '#123456'},
    meta: {title: '用户工程名称'},
    patches: {a: {...base.rows[0], zh: '用户修改保留', en: '旧底稿', note: '用户笔记'}, added: newRow}
  };
  const key = 'bilingual-subtitle-editor-v1-' + base.editor_id;
  const fixture = storageFixture([base], {[key]: JSON.stringify(saved)});
  const {store} = await initializedStore();
  const restored = await store.get(base.editor_id);
  assert.deepEqual(restored.rows.map(item => item.id), ['added', 'a']);
  assert.deepEqual(restored.rows[0], newRow);
  assert.equal(restored.rows[1].zh, '用户修改保留');
  assert.equal(restored.rows[1].en, '新底稿');
  assert.equal(restored.rows[1].note, '用户笔记');
  assert.equal(restored.title, '用户工程名称');
  assert.equal(restored.colors.Unknown, '#123456');
  assert.equal(restored.lastIndex, 1);
  assert.deepEqual(fixture.databaseRecords.get(base.editor_id), base);
  assert.equal(fixture.local.get(key), JSON.stringify(saved));

  restored.rows[1].zh = '迁移后新增校对';
  store.save(restored, 0); assert.equal(await store.flush(), true);
  assert.equal(fixture.databaseRecords.get(base.editor_id).schemaVersion, 2);
  const {store: reopened} = await initializedStore();
  assert.equal((await reopened.get(base.editor_id)).rows[1].zh, '迁移后新增校对');
  assert.equal((await reopened.get(base.editor_id)).lastIndex, 0);
});

test('the known full-v3 project migration preserves edited segmentation, additions and selected row', async () => {
  const base = project('usmp-KyLqZkfv3BU');
  const original = row('old-a', '旧分段原文');
  const oldOther = {...row('old-b'), start: 2, end: 3};
  const split = [{...row('split-a'), end: 0.5}, {...row('split-b'), start: 0.5}];
  const updatedOther = {...oldOther, id: 'new-b', zh: '新的未编辑分段'};
  base.rows = [...split, updatedOther];
  base.segmentation_updates = [{before: [original], after: split}, {before: [oldOther], after: [updatedOther]}];
  base.segmentation_source_order = ['old-a', 'old-b'];
  const added = {...row('added-v3', '旧版用户新增'), start: 4, end: 5};
  const legacy = {
    revision: 3, index: 2, order: ['old-a', 'old-b', 'added-v3'],
    colors: {Unknown: '#789abc'}, patches: {'old-a': {...original, zh: '旧版用户校对内容'}, 'added-v3': added}
  };
  const key = 'usmp-KyLqZkfv3BU-full-v3';
  const fixture = storageFixture([base], {[key]: JSON.stringify(legacy)});
  const {store} = await initializedStore();
  const restored = await store.get(base.editor_id);
  assert.deepEqual(restored.rows.map(item => item.id), ['old-a', 'new-b', 'added-v3']);
  assert.equal(restored.rows[0].zh, '旧版用户校对内容');
  assert.equal(restored.rows[1].zh, '新的未编辑分段');
  assert.deepEqual(restored.rows[2], added);
  assert.equal(restored.colors.Unknown, '#789abc');
  assert.equal(restored.lastIndex, 2);
  assert.equal(fixture.local.get(key), JSON.stringify(legacy));
  store.save(restored, restored.lastIndex);
  assert.equal(await store.flush(), true);
  assert.equal(fixture.databaseRecords.get(base.editor_id).schemaVersion, 2);
});

test('a successful write for B leaves A failure visible until A is retried successfully', async () => {
  const fixture = storageFixture();
  const {store, states, errors} = await initializedStore();
  const a = project('A'), b = project('B');
  fixture.failures.add('A');
  store.save(a, 2); assert.equal(await store.flush(), false);
  assert.equal(errors.length, 1);
  store.save(b, 1); assert.equal(await store.flush(), false);
  assert.equal(fixture.databaseRecords.get('B').project.editor_id, 'B');
  assert.equal(fixture.databaseRecords.has('A'), false);
  assert.deepEqual(states.at(-1).errors.map(item => item.id), ['A']);
  assert.equal((await store.get('A')).rows[0].zh, a.rows[0].zh);
  assert.equal((await store.get('A')).lastIndex, 2);
  fixture.failures.delete('A');
  assert.equal(await store.flush(), true);
  assert.equal(fixture.databaseRecords.get('A').index, 2);
  assert.equal(states.at(-1).errors.length, 0);
});

test('unknown stored schemas reject explicitly without overwriting the original record', async () => {
  const unknown = {schemaVersion: 99, editor_id: 'future-project', project: project('future-project'), index: 1};
  const fixture = storageFixture([unknown]);
  const {createBrowserProjectStore} = await modulePromise;
  const store = createBrowserProjectStore({onStatus() {}, onError() {}});
  await assert.rejects(store.init(project('blank')), /不支持的工程存储版本/);
  assert.deepEqual(fixture.databaseRecords.get('future-project'), unknown);
  assert.equal(fixture.writes.length, 0);
});
