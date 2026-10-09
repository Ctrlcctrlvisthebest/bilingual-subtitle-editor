import {clone} from '../project.js';
import {buildSRT, buildASS, exportName} from '../subtitle-formats.js';
import {miniSaveError} from './persistence.js';

const $ = id => document.getElementById(id);
const PANEL_IDS = ['miniImportPanel', 'miniExportPanel', 'miniBackupPanel'];
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export function showMiniStorageStatus({mode, pending, errors}) {
  const failure = errors.length ? miniSaveError(errors[0].error) : '';
  const state = failure || (pending ? '正在保存修改…' : '');
  const storage = mode === 'native' ? '小红书本机存储' :
    mode === 'browser' ? '本地浏览器存储' : '仅当前页面内存';
  $('storageNotice').textContent = (state ? state + '。' : '') + storage +
    '；工程备份图可保存全部文字、时间、人物与样式。请定期另存原图，重新听校时再选择视频。';
  $('storageNotice').className = failure || mode === 'memory' ? 'warning' : 'muted';
}

function validateSize(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
    throw Error('工程超过 8 MiB，请分成较小工程');
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const character = text.charCodeAt(i);
    if (character < 128) bytes += 1;
    else if (character < 2048) bytes += 2;
    else if (character >= 55296 && character <= 56319 && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  if (bytes > MAX_IMPORT_BYTES) throw Error('工程超过 8 MiB，请分成较小工程');
}

export function initMiniRuntime(editor, practice) {
  let backupBlob = null;
  let backupPreviewURL = '';
  let backupRevision = '';
  let operationBusy = false;

  function snapshot() {
    const project = editor.getProject();
    return {...clone(project), id: project.editor_id, lastIndex: editor.getIndex()};
  }

  function hidePanels() {
    for (const id of PANEL_IDS) $(id).hidden = true;
  }

  function showPanel(id) {
    hidePanels();
    $(id).hidden = false;
    $(id).scrollIntoView({block: 'start'});
  }

  function showExport(name, text) {
    $('miniExportName').textContent = name;
    $('miniExportText').value = text;
    showPanel('miniExportPanel');
    editor.notice('已生成字幕文本，可查看。跨设备继续修改请保存工程备份图。');
  }

  async function importText(text, format) {
    if (!text.trim()) throw Error('请先输入字幕文本');
    if (!['srt', 'ass', 'json'].includes(format)) throw Error('请选择 SRT、ASS 或 JSON');
    validateSize(text);
    await editor.importFile({name: '导入字幕.' + format, text: () => Promise.resolve(text)});
  }

  async function flush() {
    editor.save(true);
    const ok = await editor.flushSave();
    if (ok) editor.notice('当前工程已保存到本机；建议再保存一张工程备份图。');
    return ok;
  }

  async function runOperation(action) {
    if (operationBusy) {
      editor.notice('上一项操作尚未完成，请稍候。');
      return;
    }
    operationBusy = true;
    try {
      await action();
    } catch (error) {
      editor.notice('操作未完成：' + error.message);
    } finally {
      operationBusy = false;
    }
  }

  function releasePreview() {
    if (!backupPreviewURL) return;
    URL.revokeObjectURL(backupPreviewURL);
    backupPreviewURL = '';
    backupBlob = null;
    backupRevision = '';
    $('miniBackupPreview').removeAttribute('src');
  }

  $('miniImport').addEventListener('click', () => {
    showPanel('miniImportPanel');
    $('miniImportText').focus();
  });
  $('miniApplyImport').addEventListener('click', () => runOperation(async () => {
    await importText($('miniImportText').value, $('miniImportFormat').value);
    hidePanels();
    $('miniImportText').value = '';
  }));
  $('miniJSON').addEventListener('click', () => {
    showExport(exportName(editor.getProject(), 'json'), JSON.stringify(snapshot(), null, 2));
  });
  for (const id of ['miniCloseImport', 'miniCloseExport', 'miniCloseBackup']) {
    $(id).addEventListener('click', hidePanels);
  }
  $('miniSelectExport').addEventListener('click', () => {
    $('miniExportText').focus();
    $('miniExportText').select();
    editor.notice('文本已选中。跨设备保留工程请使用备份图。');
  });
  $('miniPractice').addEventListener('click', () => runOperation(() => importText(practice, 'srt')));
  $('save').addEventListener('click', () => runOperation(flush));
  $('backupImage').addEventListener('click', () => runOperation(async () => {
    editor.notice('正在生成工程备份图…');
    await new Promise(resolve => setTimeout(resolve, 20));
    const revision = JSON.stringify(snapshot());
    const image = await window.SubtitleBackup.encodeBlob(JSON.parse(revision));
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw Error('此环境无法预览工程备份原图');
    }
    const previewURL = URL.createObjectURL(image);
    releasePreview();
    backupRevision = revision;
    backupBlob = image;
    backupPreviewURL = previewURL;
    $('miniBackupPreview').src = previewURL;
    $('miniSaveBackupImage').disabled = false;
    showPanel('miniBackupPanel');
    editor.notice('工程备份图已生成；点击“保存原图到相册”完成备份。');
  }));
  $('miniSaveBackupImage').addEventListener('click', () => runOperation(async () => {
    if (!backupBlob) throw Error('请先生成备份图');
    if (JSON.stringify(snapshot()) !== backupRevision) {
      throw Error('工程已有新修改，请关闭此面板并重新生成备份图');
    }
    await window.MiniPhotos.save(backupBlob);
    editor.notice('工程备份原图已保存到相册；截图、压缩或发笔记后的图片不能可靠恢复工程。');
  }));
  $('miniBackupFile').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    return runOperation(async () => {
      editor.notice('正在读取工程备份图…');
      await editor.activateProject(await window.SubtitleBackup.decodeFile(file));
      hidePanels();
      editor.notice('已恢复 ' + editor.getProject().rows.length + ' 条可编辑字幕；请重新选择对应视频。');
    });
  });
  window.addEventListener('pagehide', releasePreview);

  window.MiniEditor = Object.assign(editor, {
    importText,
    activate: editor.activateProject,
    flush,
    buildSRT: () => {
      const project = editor.getProject();
      return buildSRT(project.rows, project);
    },
    buildASS: () => {
      const project = editor.getProject();
      return buildASS(project.rows, project);
    }
  });
  return {showExport, isExportOpen: () => !$('miniExportPanel').hidden};
}
