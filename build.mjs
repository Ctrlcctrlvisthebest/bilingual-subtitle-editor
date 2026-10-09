import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { root, readText, fragment, renderEditor, desktopToolbar, bundleEntry, inlineApp, blankProject } from './templates/render.mjs';

const iconPath = 'subtitle-editor-icon.png';
const icon = await readFile(new URL(iconPath, root));
const iconVersion = createHash('sha256').update(icon).digest('hex').slice(0, 12);
const iconUrl = `./${iconPath}?v=${iconVersion}`;
const [script, styles, header, panel, toolbar, bar, assignment, exporter] = await Promise.all([
  bundleEntry('web-entry.js'),
  Promise.all(['styles/editor.css', 'styles/desktop-layout.css', 'styles/collaboration.css', 'styles/video-export.css', 'styles/web-brand.css'].map(readText)),
  fragment('web-header', { ICON_URL: iconUrl }),
  fragment('collaboration-panel'),
  desktopToolbar(),
  fragment('collaboration-bar'),
  fragment('cue-assignment'),
  fragment('video-export', { FFMPEG_NOTICE: '首次使用需要安装 FFmpeg，包内附安装方法。' }),
]);
const html = await renderEditor({
  VIEWPORT: 'width=device-width,initial-scale=1',
  TITLE: '双语字幕编辑器',
  HEAD: `<link rel="icon" type="image/png" href="${iconUrl}">\n<link rel="apple-touch-icon" href="${iconUrl}">`,
  STYLES: '<style>\n' + styles.join('\n') + '</style>',
  HEADER: header,
  COLLABORATION_PANEL: panel,
  TOOLBAR: toolbar,
  COLLABORATION_BAR: bar,
  PROJECT_TITLE_ATTRIBUTES: '',
  SPEAKER_NAME_ATTRIBUTES: '',
  SAVE_STYLE_NOTICE: '保存 JSON 保留样式',
  VIDEO_ATTRIBUTES: '',
  CUE_ASSIGNMENT: assignment,
  EXTENSIONS: '',
  FOOTER: '',
  VIDEO_EXPORT: exporter,
  SCRIPTS: inlineApp(script, blankProject),
});
await writeFile(new URL('index.html', root), html, 'utf8');
await mkdir(new URL('dist/', root), { recursive: true });
await copyFile(new URL(iconPath, root), new URL('dist/' + iconPath, root));
await writeFile(new URL('dist/index.html', root), html, 'utf8');
await writeFile(new URL('dist/_headers', root), '/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n', 'utf8');
console.log('已生成 index.html：空白工程，无内置音视频或字幕。');
