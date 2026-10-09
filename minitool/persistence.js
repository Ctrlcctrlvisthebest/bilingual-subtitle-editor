import {clone} from '../project.js';
import {createProjectSaveQueue} from '../project-save-queue.js';
const SAVE_ERRORS = {
  STORAGE_QUOTA: '本机空间不足',
  STORAGE_UNAVAILABLE: '此环境无法保存工程',
  CORRUPT_STORAGE: '已存工程数据损坏，请用备份图恢复',
  MIGRATION_FAILED: '旧版工程迁移未完成，原数据仍保留；请保留备份图并重新打开重试',
  STALE_STORAGE: '本机工程已在另一页面更新，请先保存备份图，再重新打开小工具',
  PROJECT_LIMIT: '本机工程数量已达上限',
  PROJECT_TOO_LARGE: '工程超过 8 MiB 限制',
  INVALID_PROJECT: '工程信息无效',
  STORAGE_FAILED: '本机保存未成功'
};

export function miniSaveError(error) {
  return SAVE_ERRORS[error && error.code] || '本机保存未成功';
}

export function createMiniEditorStore({store = window.MiniProjectStore, onStatus, onError} = {}) {
  const cache = new Map();
  const queue = createProjectSaveQueue({
    write(project, index) {
      return store.save({...project, id: project.editor_id, lastIndex: index});
    },
    onState: status,
    onError
  });

  function status(state = queue.state()) {
    if (onStatus) onStatus({mode: store.mode, ...state});
  }

  function snapshot(entry) {
    return {...clone(entry.project), id: entry.project.editor_id, lastIndex: entry.index};
  }

  function save(project, index) {
    cache.set(project.editor_id, {project, index});
    queue.save(project, index);
  }

  return {
    async init(initialProject) {
      cache.set(initialProject.editor_id, {project: initialProject, index: 0});
      try {
        await store.init();
        await store.migrateBrowser();
      } finally {
        status();
      }
    },
    list() {
      const list = new Map(store.list().map(entry => [entry.id, entry]));
      for (const [id, entry] of cache) list.set(id, {id, title: entry.project.title});
      return [...list.values()];
    },
    async get(id) {
      if (cache.has(id)) return snapshot(cache.get(id));
      const project = await store.get(id);
      if (!project || project.editor_id !== id) return null;
      const entry = {project, index: project.lastIndex || 0};
      cache.set(id, entry);
      return snapshot(entry);
    },
    save,
    flush: queue.flush,
    async getLastId() {
      return store.last();
    }
  };
}
