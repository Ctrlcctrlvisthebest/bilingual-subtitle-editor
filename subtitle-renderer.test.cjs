const assert = require('node:assert/strict');
const {test} = require('node:test');
const renderer = import('./subtitle-renderer.js');
const appearance = {mode: 'outline', order: 'zh-first', zhSize: 48, enSize: 42, outlineWidth: 3, font: 'Arial', bold: true, alignment: 2, marginX: 80, marginY: 60};

function drawing(width = 1920, height = 1080) {
  const calls = [];
  const ctx = {
    save() {calls.push({op: 'save'});}, restore() {calls.push({op: 'restore'});},
    measureText(text) {return {width: [...text].length * Number.parseFloat(this.font.replace(/^(?:400|700) /, '')), actualBoundingBoxDescent: 5};},
    strokeText(text, x, y) {calls.push({op: 'stroke', text, x, y, color: this.strokeStyle, width: this.lineWidth, font: this.font});},
    fillText(text, x, y) {calls.push({op: 'fill', text, x, y, color: this.fillStyle, font: this.font, align: this.textAlign});},
    fillRect(x, y, w, h) {calls.push({op: 'box', x, y, width: w, height: h, color: this.fillStyle});},
    drawImage(...args) {calls.push({op: 'image', args});},
  };
  return {canvas: {width, height, getContext: () => ctx}, calls, ctx};
}

test('cursor matches cue intervals across overlaps, repeated timestamps, long jumps, and rewinds', async () => {
  const {createSubtitleCursor} = await renderer;
  const rows = [
    {id: 'long', start: 0, end: 100}, {id: 'later', start: 5, end: 7},
    {id: 'early', start: 1, end: 3}, {id: 'same-a', start: 5, end: 8},
    {id: 'same-b', start: 5, end: 6}, {id: 'adjacent', start: 3, end: 5},
  ];
  const before = JSON.stringify(rows), cursor = createSubtitleCursor(rows);
  for (const time of [-1, 0, 1, 2.999, 3, 4, 5, 5, 6, 7, 8, 99.999, 100, 1000, 2, 5, 0]) {
    assert.deepEqual(cursor(time), rows.filter(row => row.start <= time && time < row.end), `time ${time}`);
  }
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(createSubtitleCursor([])(10), []);
});

test('cursor retains every simultaneous speaker in original project order even when cues are unsorted', async () => {
  const {createSubtitleCursor} = await renderer;
  const rows = Array.from({length: 600}, (_, index) => ({id: `row-${index}`, start: (index * 47) % 70, end: (index * 47) % 70 + 1 + index % 11}));
  const cursor = createSubtitleCursor(rows);
  for (const time of Array.from({length: 200}, (_, i) => i / 2).concat([40, 3, 50, 0])) {
    assert.deepEqual(cursor(time), rows.filter(row => row.start <= time && time < row.end));
  }
});

test('bilingual text order and each speaker outline survive simultaneous dialogue without background boxes', async () => {
  const {paintSubtitles} = await renderer;
  const rows = [
    {speaker: 'Spoke', zh: '第一句', en: 'First.'},
    {speaker: 'Mapicc', zh: '第二句', en: 'Second.'},
  ], colors = {Spoke: '#000000', Mapicc: '#ff0000'};
  const result = drawing();
  paintSubtitles(result.canvas, rows, appearance, colors);
  const strokes = result.calls.filter(call => call.op === 'stroke');
  assert.deepEqual(strokes.map(call => [call.text, call.color]), [
    ['Second.', '#ff0000'], ['第二句', '#ff0000'], ['First.', '#000000'], ['第一句', '#000000'],
  ]);
  assert.ok(strokes[1].y < strokes[0].y, 'Chinese appears above English');
  assert.ok(strokes[2].y < strokes[1].y, 'simultaneous speaker groups occupy distinct rows');
  assert.ok(strokes.every(call => call.x === 960 && call.width === 6));
  assert.ok(result.calls.filter(call => call.op === 'fill').every(call => call.color === '#ffffff'));
  assert.equal(result.calls.filter(call => call.op === 'box').length, 0);
  assert.equal(result.calls[0].op, 'save'); assert.equal(result.calls.at(-1).op, 'restore');

  const reversed = drawing();
  paintSubtitles(reversed.canvas, [rows[0]], {...appearance, order: 'en-first'}, colors);
  const text = reversed.calls.filter(call => call.op === 'fill');
  assert.deepEqual(text.map(call => call.text), ['第一句', 'First.']);
  assert.ok(text[1].y < text[0].y, 'English appears above Chinese');
});

test('box mode preserves contrast, skips empty languages, and fits long text inside scaled video bounds', async () => {
  const {paintSubtitles} = await renderer;
  const bright = drawing(640, 360), dark = drawing(640, 360);
  const row = {speaker: 'Ash', zh: '\n\r ', en: 'Long subtitle '.repeat(50)};
  for (const [result, color, expected] of [[bright, '#ffff00', '#101010'], [dark, '#000000', '#ffffff']]) {
    paintSubtitles(result.canvas, [row], {...appearance, mode: 'box'}, {Ash: color});
    const box = result.calls.find(call => call.op === 'box'), text = result.calls.filter(call => call.op === 'fill');
    assert.equal(text.length, 1); assert.equal(text[0].text, row.en.trim());
    assert.equal(text[0].color, expected); assert.equal(box.color, color);
    assert.ok(box.x >= 0 && box.x + box.width <= 640, 'long subtitle stays within horizontal bounds');
    assert.ok(box.y >= 0 && box.y + box.height <= 360, 'subtitle stays above the bottom margin');
    assert.equal(result.calls.filter(call => call.op === 'stroke').length, 0);
  }
});

test('preview paints the source frame before active subtitles and excludes an ending cue at its boundary', async () => {
  const {paintVideoExport} = await renderer;
  const result = drawing(), media = {};
  paintVideoExport(result.canvas, media, [
    {start: 0, end: 1, speaker: 'A', zh: '结束', en: 'Ended'},
    {start: 1, end: 2, speaker: 'B', zh: ' 开始\n这一句 ', en: ''},
  ], appearance, {B: '#ff0000'}, 1);
  assert.deepEqual(result.calls[0], {op: 'image', args: [media, 0, 0, 1920, 1080]});
  assert.deepEqual(result.calls.filter(call => call.op === 'fill').map(call => call.text), ['开始 这一句']);
});

test('all nine anchors place a bilingual group at its chosen horizontal and vertical margins', async () => {
  const {paintSubtitles} = await renderer;
  const row = {speaker: 'A', zh: '位置', en: 'Position'}, marginX = 150, marginY = 120;
  const height = (appearance.zhSize + appearance.enSize) * 1.3;
  for (let alignment = 1; alignment <= 9; alignment++) {
    const result = drawing(), column = (alignment - 1) % 3, band = Math.floor((alignment - 1) / 3);
    paintSubtitles(result.canvas, [row], {...appearance, alignment, marginX, marginY}, {A: '#000000'});
    const lines = result.calls.filter(call => call.op === 'fill');
    const bottom = band === 0 ? 1080 - marginY : band === 1 ? (1080 + height) / 2 : marginY + height;
    assert.equal(lines[0].x, [marginX, 960, 1920 - marginX][column], `horizontal anchor ${alignment}`);
    assert.equal(lines[0].align, ['left', 'center', 'right'][column]);
    assert.equal(lines[0].y, bottom - 5, `vertical anchor ${alignment}`);
    assert.ok(lines[1].y < lines[0].y, 'Chinese stays above English at every anchor');
  }
});

test('top and middle anchors lay out simultaneous speaker groups without changing their visual order', async () => {
  const {paintSubtitles} = await renderer;
  const rows = [{speaker: 'A', zh: '第一位', en: 'First'}, {speaker: 'B', zh: '第二位', en: 'Second'}];
  const before = JSON.stringify(rows);
  for (const alignment of [2, 5, 8]) {
    const result = drawing();
    paintSubtitles(result.canvas, rows, {...appearance, alignment}, {A: '#000000', B: '#ff0000'});
    const lines = result.calls.filter(call => call.op === 'fill').sort((a, b) => a.y - b.y);
    assert.deepEqual(lines.map(line => line.text), ['第一位', 'First', '第二位', 'Second']);
    assert.ok(lines[2].y - lines[1].y > appearance.enSize, 'speaker groups have a visible gap');
  }
  assert.equal(JSON.stringify(rows), before);
});

test('edge margins and colored boxes scale with video resolution and stay inside a portrait frame', async () => {
  const {paintSubtitles} = await renderer;
  const row = {speaker: 'A', zh: '调整位置', en: 'Position'}, colors = {A: '#ff0000'};
  for (const alignment of [1, 3, 7, 9]) {
    const full = drawing(), small = drawing(640, 360);
    const a = {...appearance, mode: 'box', alignment, marginX: 180, marginY: 150};
    paintSubtitles(full.canvas, [row], a, colors);
    paintSubtitles(small.canvas, [row], a, colors);
    const first = full.calls.find(call => call.op === 'box'), second = small.calls.find(call => call.op === 'box');
    for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(first[field] / 3 - second[field]) < 0.001, field);
  }
  const portrait = drawing(608, 1080);
  paintSubtitles(portrait.canvas, [row], {...appearance, mode: 'box', alignment: 9, marginX: 800, marginY: 900}, colors);
  const box = portrait.calls.find(call => call.op === 'box');
  assert.ok(box.x >= 0 && box.x + box.width <= 608);
  assert.ok(box.y >= 0 && box.y + box.height <= 1080);
});

test('ASS export writes selected anchors and margins and restores them on import', async () => {
  const {buildASS, parseASS, buildSRT} = await import('./subtitle-formats.js');
  const {normalizeProject} = await import('./project.js');
  const project = normalizeProject({version: 1, title: '位置测试', colors: {A: '#123456'},
    appearance: {...appearance, alignment: 9, marginX: 150, marginY: 120},
    rows: [{id: 'position', start: 1.5, end: 3, speaker: 'A', zh: '位置', en: 'Position'}]});
  const ass = buildASS(project.rows, project), imported = parseASS(ass);
  assert.ok(ass.includes(',9,150,150,120,1\n'));
  assert.equal(imported.appearance.alignment, 9);
  assert.equal(imported.appearance.marginX, 150);
  assert.equal(imported.appearance.marginY, 120);
  assert.equal(imported.rows[0].zh, '位置');
  assert.equal(imported.rows[0].en, 'Position');
  assert.equal(imported.rows[0].start, 1.5);
  assert.equal(buildSRT(project.rows, project), buildSRT(project.rows, {...project, appearance}));
});
