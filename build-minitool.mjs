import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, readText, fragment, renderEditor, bundleEntry } from './templates/render.mjs';

const destination = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('dist/minitool/', root));
const [script, styles, header, toolbar, panels, footer] = await Promise.all([
  bundleEntry('minitool-entry.js', ['es2017', 'chrome61']),
  Promise.all(['styles/editor.css', 'minitool/style.css'].map(readText)),
  fragment('minitool-header'),
  fragment('toolbar', {
    MEDIA_PICKER: '<label class="file">载入 MP4 视频<input id="videoFile" type="file" accept="video/mp4" hidden></label>',
    IMPORT_PICKER: '<button id="miniImport">导入字幕文本</button><label class="file">恢复工程备份图<input id="miniBackupFile" type="file" accept="image/png" hidden></label>',
    SAVE_LABEL: '保存本机工程',
    SRT_LABEL: '查看 SRT',
    ASS_LABEL: '查看 ASS',
    EXPORT_CONTROLS: '<button id="backupImage" class="primary">工程备份图</button><button id="miniJSON">查看工程 JSON</button>',
    STORAGE_NOTICE: '正在检查本机存储…',
  }),
  fragment('minitool-panels'),
  fragment('minitool-footer'),
]);
const page = await renderEditor({
  VIEWPORT: 'width=device-width,initial-scale=1.0,viewport-fit=cover',
  TITLE: '双语字幕小工具',
  HEAD: '',
  STYLES: '<link rel="stylesheet" href="./assets/style.css">',
  HEADER: header,
  COLLABORATION_PANEL: '',
  TOOLBAR: toolbar,
  COLLABORATION_BAR: '',
  PROJECT_TITLE_ATTRIBUTES: 'maxlength="200"',
  SPEAKER_NAME_ATTRIBUTES: 'maxlength="80"',
  SAVE_STYLE_NOTICE: '保存本机工程或备份图保留样式',
  VIDEO_ATTRIBUTES: 'playsinline webkit-playsinline poster="./assets/video-placeholder.svg"',
  CUE_ASSIGNMENT: '',
  EXTENSIONS: panels,
  FOOTER: footer,
  VIDEO_EXPORT: '',
  SCRIPTS: '<script src="./assets/app.js"></script>',
});
if (/\b(?:fetch|XMLHttpRequest|WebSocket|WebAssembly|Worker|SharedWorker|EventSource|RTCPeerConnection)\b|\beval\s*\(|new\s+Function\s*\(|\.onclick\s*=|\.download\s*=|navigator\.clipboard|execCommand/.test(script)) {
  throw Error('小工具脚本有不可用能力。');
}
if (/__[A-Z_]+__|cloudPanel|videoExportDialog|<script(?!\s+src=)|\bon\w+\s*=|type="module"|Content-Security-Policy|<iframe|<object/.test(page)) {
  throw Error('小工具 HTML 存在未清理内容。');
}
await mkdir(resolve(destination, 'assets'), { recursive: true });
await writeFile(resolve(destination, 'index.html'), page, 'utf8');
await writeFile(resolve(destination, 'assets/style.css'), styles.join('\n'), 'utf8');
await writeFile(resolve(destination, 'assets/app.js'), script, 'utf8');
await copyFile(new URL('templates/video-placeholder.svg', root), resolve(destination, 'assets/video-placeholder.svg'));
console.log('已生成小红书离线小工具：' + destination + '（空白工程，4 个静态文件）');
