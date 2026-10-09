import {createEditor} from './editor.js';
import {createBrowserProjectStore} from './browser-project-store.js';
import {normalizeProject, clone} from './project.js';
import {buildSRT, buildASS, exportName} from './subtitle-formats.js';

const $ = id => document.getElementById(id);

// Projects created before the generic editor used this fixed identity.
export function normalizeBrowserProject(project) {
  const original = project.video === 'KyLqZkfv3BU' ||
    project.video === 'https://www.youtube.com/watch?v=KyLqZkfv3BU';
  return normalizeProject(original && !project.editor_id ?
    {...project, editor_id: 'usmp-KyLqZkfv3BU'} : project);
}

function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function storageStatus({mode, pending, errors}) {
  const failed = errors.length > 0;
  $('storageNotice').textContent = failed ?
    '本机保存失败：' + errors[0].error.message + '。请保存工程 JSON 备份。' :
    mode === 'memory' ? '工程暂在当前页面内存中。请保存工程 JSON 备份。' :
    pending ? '正在保存修改到本机…' : '修改已保存到本机。关闭前建议另存工程 JSON 备份。';
  $('storageNotice').className = failed || mode === 'memory' ? 'warning' : 'muted';
}

export function createBrowserEditor({isExportOpen}) {
  const store = createBrowserProjectStore({
    onStatus: storageStatus,
    onError: error => editor.notice('本机保存未完成：' + error.message)
  });
  const editor = createEditor({
    initialProject: normalizeBrowserProject(JSON.parse($('initial').textContent)),
    validateProject: normalizeBrowserProject,
    store, output: download, isExportOpen,
    loadMedia: async file => {
      const src = URL.createObjectURL(file);
      return {src, file, release: () => URL.revokeObjectURL(src)};
    }
  });
  $('load').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {await editor.importFile(file);}
    catch (error) {editor.notice('未导入：' + error.message);}
  });
  $('save').addEventListener('click', () => {
    const project = {...clone(editor.getProject()), lastIndex: editor.getIndex()};
    download(exportName(project, 'json'), JSON.stringify(project, null, 2), 'application/json');
    editor.notice('已生成工程 JSON 备份。');
  });
  for (const [id, build] of [['srt', buildSRT], ['ass', buildASS]]) {
    $(id).addEventListener('click', () => {
      const rows = editor.exportRows();
      if (rows) download(exportName(editor.getProject(), id), build(rows, editor.getProject()));
    });
  }
  return editor;
}
