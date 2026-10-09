'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const modulePromise = import(pathToFileURL(path.join(__dirname, 'project-save-queue.js')).href);

test('the shared queue delays one snapshot and passes the current index separately', {timeout: 3000}, async () => {
  const {createProjectSaveQueue} = await modulePromise;
  const writes = [];
  const states = [];
  let committed;
  const complete = new Promise(resolve => { committed = resolve; });
  const queue = createProjectSaveQueue({
    async write(snapshot, index) {
      writes.push({snapshot, index});
      committed();
    },
    onState(state) { states.push(state); }
  });
  const project = {editor_id: 'A', title: 'A', rows: [{zh: '最初文字'}]};
  queue.save(project, 1);
  project.rows[0].zh = '新文字';
  queue.save(project, 2);
  assert.equal(writes.length, 0);
  assert.deepEqual(queue.state(), {pending: 1, errors: []});
  await complete;
  assert.equal(await queue.flush(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].index, 2);
  assert.equal(writes[0].snapshot.rows[0].zh, '新文字');
  assert.equal(Object.hasOwn(writes[0].snapshot, 'id'), false);
  assert.equal(Object.hasOwn(writes[0].snapshot, 'lastIndex'), false);
  project.rows[0].zh = '后续文字';
  assert.equal(writes[0].snapshot.rows[0].zh, '新文字');
  assert.deepEqual(states.at(-1), {pending: 0, errors: []});
});
