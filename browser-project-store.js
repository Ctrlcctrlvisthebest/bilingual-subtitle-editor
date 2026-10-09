import {clone, normalizeProject} from './project.js';
import {restoreLegacyProject} from './legacy-projects.js';
import {createProjectSaveQueue} from './project-save-queue.js';

const LAST_PROJECT = 'bilingual-subtitle-editor-last-generic-blank';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bilingual-subtitle-editor', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', {keyPath: 'editor_id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('工程存储被其他页面占用，请关闭旧编辑器后重试。'));
  });
}

function readProjects(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeProject(db, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    transaction.objectStore('projects').put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

function restoreRecord(record) {
  if (record.schemaVersion === 2) {
    return {...normalizeProject(record.project), lastIndex: record.index};
  }
  if (record.schemaVersion !== undefined) throw Error('不支持的工程存储版本。');
  const base = normalizeProject(record);
  const key = base.editor_id === 'usmp-KyLqZkfv3BU' ?
    'usmp-KyLqZkfv3BU-full-v4' : 'bilingual-subtitle-editor-v1-' + base.editor_id;
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  const legacy = base.editor_id === 'usmp-KyLqZkfv3BU' ?
    JSON.parse(localStorage.getItem('usmp-KyLqZkfv3BU-full-v3') || 'null') : null;
  const restored = restoreLegacyProject(base, saved, legacy);
  return {...restored.project, lastIndex: restored.index};
}

export function createBrowserProjectStore({onStatus, onError}) {
  const projects = new Map();
  let db;
  const queue = createProjectSaveQueue({
    async write(project, index) {
      if (!db) throw Error('本浏览器未能打开工程存储，请保存 JSON 备份。');
      await writeProject(db, {
        schemaVersion: 2, editor_id: project.editor_id, project, index
      });
      localStorage.setItem(LAST_PROJECT, project.editor_id);
    },
    onState: status,
    onError
  });

  function status(state = queue.state()) {
    onStatus({mode: db ? 'browser' : 'memory', ...state});
  }

  async function init(initialProject) {
    projects.set(initialProject.editor_id, {project: initialProject, index: 0});
    try {
      db = await openDatabase();
      db.onversionchange = () => {db.close(); db = undefined; status();};
      for (const record of await readProjects(db)) {
        const project = restoreRecord(record);
        projects.set(project.editor_id, {project, index: project.lastIndex || 0});
      }
    } finally {
      status();
    }
  }

  function save(project, index) {
    projects.set(project.editor_id, {project, index});
    queue.save(project, index);
  }

  return {
    init, save, flush: queue.flush,
    list: () => [...projects.values()].map(({project}) => ({id: project.editor_id, title: project.title})),
    get: async id => {
      const entry = projects.get(id);
      return entry ? {...clone(entry.project), lastIndex: entry.index} : null;
    },
    getLastId: async () => localStorage.getItem(LAST_PROJECT)
  };
}
