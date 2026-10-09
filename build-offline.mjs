import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, readText, fragment, renderEditor, desktopToolbar, bundleEntry, inlineApp, blankProject } from './templates/render.mjs';

const destination = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('dist/offline/', root));
const [script, styles, header, toolbar, exporter, footer] = await Promise.all([
  bundleEntry('offline-entry.js'),
  Promise.all(['styles/editor.css', 'styles/desktop-layout.css', 'styles/video-export.css', 'offline/style.css'].map(readText)),
  fragment('offline-header'),
  desktopToolbar(),
  fragment('video-export', { FFMPEG_NOTICE: '本机需事先安装 FFmpeg；安装步骤可能需要联网，安装好后可离线导出。' }),
  fragment('offline-footer'),
]);
const page = await renderEditor({
  VIEWPORT: 'width=device-width,initial-scale=1',
  TITLE: '字幕小工具 · 离线版',
  HEAD: '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src blob: data:; connect-src \'none\'; font-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'">',
  STYLES: '<style>\n' + styles.join('\n') + '</style>',
  HEADER: header,
  COLLABORATION_PANEL: '',
  TOOLBAR: toolbar,
  COLLABORATION_BAR: '',
  PROJECT_TITLE_ATTRIBUTES: '',
  SPEAKER_NAME_ATTRIBUTES: '',
  SAVE_STYLE_NOTICE: '保存 JSON 保留样式',
  VIDEO_ATTRIBUTES: '',
  CUE_ASSIGNMENT: '',
  EXTENSIONS: '',
  FOOTER: footer,
  VIDEO_EXPORT: exporter,
  SCRIPTS: inlineApp(script, blankProject),
});
if (/cloudPanel|cloudRequest|collabLeaderKey/.test(page)) {
  throw Error('离线页面包含未清理的模板或在线协作代码。');
}
if (/<(?:script|link)[^>]+(?:src|href)=|\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b/.test(page)) {
  throw Error('离线页面包含网络资源依赖。');
}
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, '双语字幕工具-离线.html'), page, 'utf8');
for (const name of ['使用说明.txt', '练习字幕.srt', '小红书分享文案.txt']) {
  await copyFile(new URL('offline/' + name, root), resolve(destination, name));
}
console.log('已生成离线字幕工具：' + destination + '（4 个文件，空白工程，无在线协作或外部资源）');
