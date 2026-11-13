const assert = require('node:assert/strict');
const {test} = require('node:test');

const formats = import('./subtitle-formats.js');
const model = import('./project.js');
const layout = import('./subtitle-layout.js');
const eventFields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];

async function project(rows, appearance = {}) {
  const {normalizeProject} = await model;
  return normalizeProject({version: 1, title: '独立双语位置', colors: {Alice: '#247c98', Bob: '#ff0000'},
    appearance: {zhBottom: 230, enBottom: 70, zhSize: 64, enSize: 30, ...appearance}, rows});
}

async function events(ass) {
  const {csvFields, parseStamp} = await formats;
  return ass.split('\n').filter(line => line.startsWith('Dialogue: ')).map(line => {
    const fields = csvFields(line.slice(10), eventFields);
    const event = Object.fromEntries(eventFields.map((field, i) => [field, fields[i]]));
    return {...event, start: parseStamp(event.Start), end: parseStamp(event.End)};
  });
}

test('ASS uses separate language events with independent height and size and imports each cue once', async () => {
  const {buildASS, parseASS} = await formats;
  const p = await project([
    {id: 'one', start: 1.25, end: 5.5, speaker: 'Alice', zh: '你好', en: 'Hello'},
    {id: 'two', start: 6, end: 7, speaker: 'Bob', zh: 'OK', en: ''},
  ]);
  const ass = buildASS(p.rows, p), lines = await events(ass);
  assert.equal(lines.length, 3);
  assert.ok(lines.find(line => line.Effect === 'BilingualEditor:0:zh').Text.includes('\\pos(960,850)\\fs64'));
  assert.ok(lines.find(line => line.Effect === 'BilingualEditor:0:en').Text.includes('\\pos(960,1010)\\fs30'));
  assert.ok(lines.every(line => !line.Text.includes('\\N')));
  const restored = parseASS(ass, 'en-first');
  assert.equal(restored.rows.length, p.rows.length);
  for (let i = 0; i < p.rows.length; i++) {
    for (const field of ['zh', 'en', 'start', 'end', 'speaker']) assert.equal(restored.rows[i][field], p.rows[i][field], field);
  }
  assert.deepEqual(restored.appearance, p.appearance);
  assert.equal(restored.colors.Alice, p.colors.Alice);
});

test('changing one language export position or size leaves the other language event unchanged', async () => {
  const {buildASS, buildSRT} = await formats;
  const p = await project([{id: 'one', start: 1, end: 2, speaker: 'Alice', zh: '独立调整', en: 'Independent'}]);
  const updated = await project(p.rows, {...p.appearance, zhBottom: 400, zhSize: 80});
  const first = await events(buildASS(p.rows, p)), second = await events(buildASS(updated.rows, updated));
  assert.equal(first.find(line => line.Effect.endsWith(':en')).Text, second.find(line => line.Effect.endsWith(':en')).Text);
  assert.notEqual(first.find(line => line.Effect.endsWith(':zh')).Text, second.find(line => line.Effect.endsWith(':zh')).Text);
  assert.equal(buildSRT(p.rows, p), buildSRT(updated.rows, updated));
});

test('overlapping ASS segments match shared layout and reimport without duplicate cues or lost duration', async () => {
  const {buildASS, parseASS} = await formats;
  const {layoutSubtitleBoxes} = await layout;
  const p = await project([
    {id: 'long', start: 0, end: 10, speaker: 'Alice', zh: '长句', en: 'Long'},
    {id: 'later', start: 2, end: 4, speaker: 'Bob', zh: '第二位', en: 'Second'},
    {id: 'last', start: 3, end: 8, speaker: 'Alice', zh: '', en: 'Third'},
  ]);
  const ass = buildASS(p.rows, p), lines = await events(ass);
  for (const time of [0, 2, 3.5, 4, 8, 9.99]) {
    const expected = layoutSubtitleBoxes(p.rows.filter(row => row.start <= time && time < row.end), p.appearance)
      .map(box => `${p.rows.indexOf(box.row)}:${box.language}:${Math.round((1080 - box.bottom) * 1000) / 1000}:${box.size}`).sort();
    const actual = lines.filter(line => line.start <= time && time < line.end).map(line => {
      const [, index, language] = /^BilingualEditor:(\d+):(zh|en)$/.exec(line.Effect);
      const [, y, size] = /\\pos\(960,([\d.-]+)\)\\fs([\d.]+)/.exec(line.Text);
      return `${index}:${language}:${y}:${size}`;
    }).sort();
    assert.deepEqual(actual, expected, `time ${time}`);
  }
  const restored = parseASS(ass);
  assert.equal(restored.rows.length, 3);
  assert.deepEqual(restored.rows.map(row => [row.start, row.end, row.zh, row.en, row.speaker]), p.rows.map(row => [row.start, row.end, row.zh, row.en, row.speaker]));
});

test('ordinary ASS and legacy bilingual lines are not guessed into paired events', async () => {
  const {parseASS, buildASS} = await formats;
  const p = await project([{id: 'one', start: 1, end: 2, speaker: 'Alice', zh: '中文', en: 'English'}]);
  const ordinary = buildASS(p.rows, p).replace(/BilingualEditor:\d+:(?:zh|en)/g, '');
  assert.equal(parseASS(ordinary).rows.length, 2);
  const legacy = '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,Alice,0,0,0,,中文\\NEnglish\n';
  const restored = parseASS(legacy);
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.rows[0].zh, '中文');
  assert.equal(restored.rows[0].en, 'English');
});
