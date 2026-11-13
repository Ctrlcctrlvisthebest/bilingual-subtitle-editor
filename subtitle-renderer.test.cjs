const assert = require('node:assert/strict');
const {test} = require('node:test');
const renderer = import('./subtitle-renderer.js');
const appearance = {mode: 'outline', order: 'zh-first', zhSize: 48, enSize: 42, outlineWidth: 3, font: 'Arial', bold: true, zhBottom: 140, enBottom: 60};

function drawing(width = 1920, height = 1080) {
  const calls = [];
  const ctx = {
    save() {calls.push({op: 'save'});}, restore() {calls.push({op: 'restore'});},
    measureText(text) {const size = Number.parseFloat(this.font.replace(/^(?:400|700) /, '')); return {width: [...text].length * size, actualBoundingBoxDescent: size * 0.2};},
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
  paintSubtitles(reversed.canvas, [rows[0]], {...appearance, order: 'en-first', zhBottom: 60, enBottom: 120}, colors);
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

test('each language has an independent height and font size while both remain horizontally centered', async () => {
  const {paintSubtitles} = await renderer;
  const row = {speaker: 'A', zh: '位置', en: 'Position'}, colors = {A: '#000000'};
  const render = a => {
    const result = drawing();
    paintSubtitles(result.canvas, [row], a, colors);
    return Object.fromEntries(result.calls.filter(call => call.op === 'fill').map(call => [call.text, call]));
  };
  const original = render(appearance);
  const chinese = render({...appearance, zhBottom: 350, zhSize: 70});
  assert.deepEqual(chinese.Position, original.Position, 'Chinese changes do not move or resize English');
  assert.ok(chinese['位置'].y < original['位置'].y);
  assert.notEqual(chinese['位置'].font, original['位置'].font);
  const english = render({...appearance, enBottom: 240, enSize: 60});
  assert.deepEqual(english['位置'], original['位置'], 'English changes do not move or resize Chinese');
  assert.ok(english.Position.y < original.Position.y);
  assert.notEqual(english.Position.font, original.Position.font);
  for (const call of Object.values(english)) {
    assert.equal(call.x, 960);
    assert.equal(call.align, 'center');
  }
});

test('shared layout stacks simultaneous bilingual groups and keeps source rows unchanged', async () => {
  const {layoutSubtitleBoxes} = await import('./subtitle-layout.js');
  const rows = [{speaker: 'A', zh: '第一位', en: 'First'}, {speaker: 'B', zh: '第二位', en: 'Second'}];
  const before = JSON.stringify(rows);
  const boxes = layoutSubtitleBoxes(rows, appearance);
  const lower = boxes.filter(box => box.row === rows[1]), upper = boxes.filter(box => box.row === rows[0]);
  assert.equal(lower.length, 2); assert.equal(upper.length, 2);
  assert.ok(Math.abs((upper[1].bottom - upper[0].bottom) - (lower[1].bottom - lower[0].bottom)) < 0.001);
  const lowerTop = Math.max(...lower.map(box => box.bottom + box.size * 1.3));
  const upperBottom = Math.min(...upper.map(box => box.bottom));
  assert.ok(Math.abs(upperBottom - lowerTop - 20) < 0.001, 'speaker groups have a visible gap');
  assert.equal(JSON.stringify(rows), before);
});

test('both language boxes and their fonts scale with video resolution', async () => {
  const {paintSubtitles} = await renderer;
  const row = {speaker: 'A', zh: '调整位置', en: 'Position'}, colors = {A: '#ff0000'};
  const defaults = drawing();
  paintSubtitles(defaults.canvas, [row], {...appearance, mode: 'box'}, colors);
  const [englishBox, chineseBox] = defaults.calls.filter(call => call.op === 'box');
  assert.ok(chineseBox.y + chineseBox.height < englishBox.y, 'default language backgrounds have a visible gap');
  const full = drawing(), small = drawing(640, 360), a = {...appearance, mode: 'box', zhBottom: 300, enBottom: 100};
  paintSubtitles(full.canvas, [row], a, colors);
  paintSubtitles(small.canvas, [row], a, colors);
  const fullBoxes = full.calls.filter(call => call.op === 'box'), smallBoxes = small.calls.filter(call => call.op === 'box');
  assert.equal(fullBoxes.length, 2, 'Chinese and English have distinct backgrounds');
  for (let i = 0; i < fullBoxes.length; i++) {
    const first = fullBoxes[i], second = smallBoxes[i];
    for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(first[field] / 3 - second[field]) < 0.001, field);
  }
  const fullText = full.calls.filter(call => call.op === 'fill'), smallText = small.calls.filter(call => call.op === 'fill');
  for (let i = 0; i < fullText.length; i++) {
    assert.ok(Math.abs(fullText[i].y / 3 - smallText[i].y) < 0.001);
    assert.equal(fullText[i].x / 3, smallText[i].x);
  }
  const portrait = drawing(608, 1080);
  paintSubtitles(portrait.canvas, [row], a, colors);
  for (const box of portrait.calls.filter(call => call.op === 'box')) {
    assert.ok(box.x >= 0 && box.x + box.width <= 608);
    assert.ok(box.y >= 0 && box.y + box.height <= 1080);
  }
});

test('shared layout omits empty language boxes and flattens each line without altering source text', async () => {
  const {layoutSubtitleBoxes} = await import('./subtitle-layout.js');
  const row = {speaker: 'A', zh: ' \n ', en: '  One\nline\r\nonly  '};
  const before = JSON.stringify(row), boxes = layoutSubtitleBoxes([row], appearance);
  assert.equal(boxes.length, 1); assert.equal(boxes[0].language, 'en');
  assert.equal(boxes[0].text, 'One line only');
  assert.equal(boxes[0].bottom, appearance.enBottom);
  assert.equal(boxes[0].row, row);
  assert.equal(JSON.stringify(row), before);
  assert.deepEqual(layoutSubtitleBoxes([], appearance), []);
});
