'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const modulePromise = import(pathToFileURL(path.join(__dirname, 'persistence.js')).href);
const project = (id, title = id) => ({version: 1, editor_id: id, title, rows: [{id: 'row', start: 0, end: 1, zh: id, en: ''}]});
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(overrides = {}) {
  const {createMiniEditorStore} = await modulePromise;
  const saved = new Map();
  const writes = [];
  const states = [];
  const reported = [];
  const native = Object.assign({
    mode: 'native',
    async init() {},
    async migrateBrowser() {},
    list() { return [...saved.values()].map(value => ({id: value.id, title: value.title})); },
    async get(id) { return saved.get(id) || null; },
    async save(value) { writes.push(value); saved.set(value.id, value); },
    last() { return [...saved.keys()].pop() || null; }
  }, overrides);
  const store = createMiniEditorStore({
    store: native,
    onStatus(state) { states.push(state); },
    onError(error) { reported.push(error); }
  });
  await store.init(project('initial'));
  return {store, native, saved, writes, states, reported};
}

test('coalesced saves capture the latest project only when the batch commits', async () => {
  const {store, writes} = await fixture();
  const current = project('A');
  store.save(current, 0);
  current.rows[0].zh = '第一轮';
  store.save(current, 0);
  current.rows[0].zh = '提交前的最新文字';
  assert.equal(writes.length, 0);
  assert.equal(await store.flush(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rows[0].zh, '提交前的最新文字');
  current.rows[0].zh = '提交后的文字';
  assert.equal(writes[0].rows[0].zh, '提交前的最新文字', 'durable snapshot is detached from live edits');
});

test('A failure remains visible after B succeeds and the failed snapshot can retry', async () => {
  const failure = Object.assign(new Error('A cannot be saved'), {code: 'STORAGE_FAILED'});
  let failA = true;
  const calls = [];
  const {store, states, reported} = await fixture({
    async save(value) {
      calls.push(value.id);
      if (value.id === 'A' && failA) throw failure;
    }
  });
  store.save(project('A'), 2);
  store.save(project('B'), 3);
  assert.equal(await store.flush(), false);
  assert.deepEqual(calls, ['A', 'B']);
  const state = states.at(-1);
  assert.equal(state.pending, 1, 'failed A is retained for retry');
  assert.deepEqual(state.errors, [{id: 'A', version: 1, error: failure}]);
  assert.deepEqual(reported, [failure]);
  failA = false;
  assert.equal(await store.flush(), true);
  assert.deepEqual(calls, ['A', 'B', 'A']);
  assert.deepEqual(states.at(-1).errors, []);
  assert.equal(states.at(-1).pending, 0);
});

test('an old in-flight failure does not replace a newer project version', async () => {
  let rejectFirst;
  const calls = [];
  const {store, states} = await fixture({
    async save(value) {
      calls.push(value);
      if (calls.length === 1) await new Promise((resolve, reject) => { rejectFirst = reject; });
    }
  });
  const current = project('A');
  store.save(current, 0);
  const first = store.flush();
  await turn();
  current.rows[0].zh = '新版本';
  store.save(current, 1);
  const second = store.flush();
  rejectFirst(new Error('old version failed'));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(calls.map(value => value.rows[0].zh), ['A', '新版本']);
  assert.equal(calls[1].lastIndex, 1);
  assert.deepEqual(states.at(-1).errors, []);
  assert.equal(states.at(-1).pending, 0);
});

test('registry reflects pending titles and cached reads return detached snapshots', async () => {
  const {store} = await fixture();
  const current = project('A', '新工程名');
  store.save(current, 4);
  assert.deepEqual(store.list(), [{id: 'initial', title: 'initial'}, {id: 'A', title: '新工程名'}]);
  const read = await store.get('A');
  assert.equal(read.lastIndex, 4);
  read.rows[0].zh = '外部修改';
  assert.equal(current.rows[0].zh, 'A');
  await store.flush();
  assert.equal(await store.getLastId(), 'A');
  assert.equal(await store.get('missing'), null);
});

test('initialization and migration errors propagate without swallowing them', async () => {
  const {createMiniEditorStore} = await modulePromise;
  for (const method of ['init', 'migrateBrowser']) {
    const failure = new Error(method + ' failed');
    const native = {mode: 'native', async init() {}, async migrateBrowser() {}};
    native[method] = async () => { throw failure; };
    const store = createMiniEditorStore({store: native});
    await assert.rejects(store.init(project('A')), error => error === failure);
  }
});
