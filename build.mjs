import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const [template, editor, exporter, core, collaboration] = await Promise.all([
  readFile(new URL('editor.template.html', root), 'utf8'),
  readFile(new URL('editor.js', root), 'utf8'),
  readFile(new URL('video-export.js', root), 'utf8'),
  readFile(new URL('collaboration-core.js', root), 'utf8'),
  readFile(new URL('collaboration.js', root), 'utf8'),
]);
const script = editor + '\n' + exporter + '\n' + core + '\n' + collaboration;
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
await mkdir(new URL('dist/', root), {recursive:true});
await writeFile(new URL('dist/index.html', root), html, 'utf8');
await writeFile(new URL('dist/_headers', root), '/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n', 'utf8');
console.log('已生成 index.html：空白工程，无内置音视频或字幕。');
