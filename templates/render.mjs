import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const root = new URL('../', import.meta.url);
export const readText = name => readFile(new URL(name, root), 'utf8');

export function render(template, slots) {
  return template.replace(/__([A-Z_]+)__/g, (placeholder, name) => {
    if (!Object.hasOwn(slots, name)) throw Error('未提供 HTML 插槽：' + name);
    return slots[name];
  });
}

export async function fragment(name, slots = {}) {
  return render(await readText('templates/' + name + '.html'), slots);
}

export async function renderEditor(slots) {
  return render(await readText('editor.template.html'), slots);
}

export async function desktopToolbar() {
  return fragment('toolbar', {
    MEDIA_PICKER: '<label class="file">载入音视频<input id="videoFile" type="file" accept="video/*,audio/*" hidden></label>',
    IMPORT_PICKER: '<label class="file">导入 SRT / ASS / JSON<input id="load" type="file" accept=".srt,.ass,.json" hidden></label>',
    SAVE_LABEL: '保存工程 JSON',
    SRT_LABEL: '导出 SRT',
    ASS_LABEL: '导出 ASS',
    EXPORT_CONTROLS: '<button id="exportVideo" class="primary">导出带字幕视频</button>',
    STORAGE_NOTICE: '修改按工程分别暂存。关闭前建议保存 JSON 备份。每次重新打开工程，可重新选择对应的音视频。',
  });
}

export async function bundleEntry(name, target = ['es2022']) {
  const result = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [name],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target,
    charset: 'utf8',
    legalComments: 'none',
    loader: { '.srt': 'text' },
  });
  return result.outputFiles[0].text;
}

export function inlineApp(script, project) {
  const seed = JSON.stringify(project).replaceAll('<', '\\u003c');
  const executable = script.replace(/<\/script/gi, '<\\/script');
  return '<script id="initial" type="application/json">' + seed + '</script>\n<script>' + executable + '</script>';
}

export const blankProject = {
  version: 1,
  revision: 1,
  editor_id: 'generic-blank',
  title: '空白字幕工程',
  rows: [],
  colors: { Unknown: '#455a64', Other: '#455a64' },
};
