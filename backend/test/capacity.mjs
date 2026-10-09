import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {sampleRow,projectAtBytes} from './capacity-fixtures.mjs';

async function loadModule(name) {
 const result=await build({entryPoints:[fileURLToPath(new URL('../src/'+name+'.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const model=await loadModule('model'),limits=await loadModule('limits');
const {checkedProject,checkedProjectSize,checkedRow,checkedMeta}=model;
const {MAX_PROJECT_BYTES,MAX_ROW_BYTES,MAX_META_BYTES,utf8Bytes}=limits;
const isCapacityError=error=>error.status===413;

test('capacity counts actual UTF-8 bytes, including Chinese and astral characters',()=>{
 const text='字幕a😀';
 assert.equal(text.length,5);
 assert.equal(utf8Bytes(text),11);
 assert.equal(utf8Bytes(text),new TextEncoder().encode(text).byteLength);
});

test('project capacity includes JSON properties, brackets and row separators',()=>{
 const project=projectAtBytes(MAX_PROJECT_BYTES);
 const {rows,...meta}=project;
 assert.equal(utf8Bytes(JSON.stringify(project)),MAX_PROJECT_BYTES);
 assert.doesNotThrow(()=>checkedProjectSize(JSON.stringify(meta),rows.map(row=>JSON.stringify(row))));
 rows.push(sampleRow('extra'));
 assert.throws(()=>checkedProjectSize(JSON.stringify(meta),rows.map(row=>JSON.stringify(row))),isCapacityError);
 assert.doesNotThrow(()=>checkedProjectSize(JSON.stringify(meta),[]));
});

test('create and resulting-project capacity accept the exact boundary and reject one byte more',()=>{
 const project=projectAtBytes(MAX_PROJECT_BYTES);
 assert.equal(checkedProject(project).rows.length,project.rows.length);
 const {rows,...meta}=project;
 assert.doesNotThrow(()=>checkedProjectSize(JSON.stringify(meta),rows.map(row=>JSON.stringify(row))));
 project.rows[0].audioTranscript+='x';
 assert.throws(()=>checkedProject(project),isCapacityError);
 assert.throws(()=>checkedProjectSize(JSON.stringify(meta),rows.map(row=>JSON.stringify(row))),isCapacityError);
});

test('single-row capacity uses UTF-8 bytes at the exact boundary',()=>{
 const row=sampleRow();
 const padding=MAX_ROW_BYTES-utf8Bytes(JSON.stringify(row));
 row.audioTranscript+='字'.repeat(Math.floor(padding/3))+'x'.repeat(padding%3);
 assert.equal(utf8Bytes(JSON.stringify(row)),MAX_ROW_BYTES);
 assert.equal(checkedRow(row),row);
 row.audioTranscript+='x';
 assert.throws(()=>checkedRow(row),isCapacityError);
});

test('metadata capacity uses UTF-8 bytes at the exact boundary',()=>{
 const meta={version:1,editor_id:'test',title:'字幕工程',colors:{Spoke:'#000000'},notes:''};
 const padding=MAX_META_BYTES-utf8Bytes(JSON.stringify(meta));
 meta.notes='字'.repeat(Math.floor(padding/3))+'x'.repeat(padding%3);
 assert.equal(utf8Bytes(JSON.stringify(meta)),MAX_META_BYTES);
 assert.equal(checkedMeta(meta),meta);
 meta.notes+='x';
 assert.throws(()=>checkedMeta(meta),isCapacityError);
});
