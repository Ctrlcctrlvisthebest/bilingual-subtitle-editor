import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
const iconPath = 'subtitle-editor-icon.png';
const icon = await readFile(new URL(iconPath, root));
const iconVersion = createHash('sha256').update(icon).digest('hex').slice(0, 12);
const iconUrl = `./${iconPath}?v=${iconVersion}`;
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
// Add the hosted site's identity here so the shared template stays portable
// for the separate, self-contained offline and miniTool builds.
const heading = /<h1>双语字幕编辑器<\/h1>(<p class="tip">[^<]*<\/p>)/;
if (!heading.test(template)) throw new Error('未找到页面标题，无法添加网站图标。');
const brandedTemplate = template
  .replace('<title>双语字幕编辑器</title>', `<title>双语字幕编辑器</title>\n<link rel="icon" type="image/png" href="${iconUrl}">\n<link rel="apple-touch-icon" href="${iconUrl}">`)
  .replace('</style>', `.app-brand{display:flex;align-items:center;gap:16px;margin:4px 0 18px}.app-brand-icon{width:72px;height:72px;object-fit:contain;flex-shrink:0}.app-brand-copy{min-width:0}.app-brand h1{margin:0 0 6px}.app-brand .tip{margin:0}@media(max-width:700px){.app-brand{gap:12px}.app-brand-icon{width:56px;height:56px}.app-brand h1{font-size:23px}}\n</style>`)
  .replace(heading, (_, tip) => `<header class="app-brand"><img class="app-brand-icon" src="${iconUrl}" width="72" height="72" alt="" decoding="async"><div class="app-brand-copy"><h1>双语字幕编辑器</h1>${tip}</div></header>`);
const html = brandedTemplate
  .replace('__PROJECT__', JSON.stringify(project).replaceAll('<', '\\u003c'))
  .replace('__SCRIPT__', () => script.replace(/<\/script/gi, '<\\/script'))
  .replace('__MEDIA__', '');
await writeFile(new URL('index.html', root), html, 'utf8');
await mkdir(new URL('dist/', root), {recursive:true});
await copyFile(new URL(iconPath, root), new URL(`dist/${iconPath}`, root));
await writeFile(new URL('dist/index.html', root), html, 'utf8');
await writeFile(new URL('dist/_headers', root), '/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n', 'utf8');
console.log('已生成 index.html：空白工程，无内置音视频或字幕。');
