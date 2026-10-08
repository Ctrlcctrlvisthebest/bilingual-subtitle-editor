import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const [template, script] = await Promise.all([
  readFile(new URL('editor.template.html', root), 'utf8'),
  readFile(new URL('editor.js', root), 'utf8'),
]);
const project = {
  version: 1,
  revision: 1,
  editor_id: 'generic-blank',
  title: '空白字幕工程',
  rows: [],
  colors: { Unknown: '#455a64', Other: '#455a64' },
};
const html = template
  .replace('__PROJECT__', JSON.stringify(project).replaceAll('<', '\\u003c'))
  .replace('__SCRIPT__', () => script.replace(/<\/script/gi, '<\\/script'))
  .replace('__MEDIA__', '');
await writeFile(new URL('index.html', root), html, 'utf8');
console.log('已生成 index.html：空白工程，无内置音视频或字幕。');
