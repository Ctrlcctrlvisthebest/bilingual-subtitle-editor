import './minitool/compat.js';
import './minitool/storage.js';
import './minitool/native-files.js';
import './minitool/backup.js';
import './minitool/media.js';
import './minitool/photos.js';
import {createEditor} from './editor.js';
import {normalizeProject} from './project.js';
import {buildSRT, buildASS, exportName} from './subtitle-formats.js';
import {createMiniEditorStore, miniSaveError} from './minitool/persistence.js';
import {initMiniRuntime, showMiniStorageStatus} from './minitool/runtime.js';
import practice from './offline/练习字幕.srt';

const initialProject = {
  version: 1, revision: 1, editor_id: 'mini-blank', title: '空白字幕工程',
  rows: [], colors: {Unknown: '#455a64', Other: '#455a64'}
};

function normalizeMiniProject(value) {
  const project = normalizeProject(value);
  if (project.editor_id.length > 128 || project.title.length > 200 || project.rows.length > 20000) {
    throw Error('工程标题、编号或字幕数量超过小工具限制');
  }
  if (project.id !== undefined && project.id !== project.editor_id) {
    throw Error('工程编号不一致');
  }
  return project;
}

let runtime;
const store = createMiniEditorStore({
  onStatus: showMiniStorageStatus,
  onError: error => editor.notice(miniSaveError(error) + '；请保存工程备份图。')
});
const editor = createEditor({
  initialProject, validateProject: normalizeMiniProject, store,
  loadMedia: file => window.MiniVideo.load(file),
  output: (name, text) => runtime.showExport(name, text),
  isExportOpen: () => runtime.isExportOpen()
});
runtime = initMiniRuntime(editor, practice);
for (const [id, build] of [['srt', buildSRT], ['ass', buildASS]]) {
  document.getElementById(id).addEventListener('click', () => {
    const rows = editor.exportRows();
    if (rows) runtime.showExport(exportName(editor.getProject(), id), build(rows, editor.getProject()));
  });
}
