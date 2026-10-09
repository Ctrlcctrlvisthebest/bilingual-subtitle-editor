import {clone} from './project.js';

const SAVE_DELAY = 700;

export function createProjectSaveQueue({write, onState, onError}) {
  const pending = new Map();
  const versions = new Map();
  const errors = new Map();
  let timer = null;
  let queue = Promise.resolve(true);
  let queued = 0;

  function state() {
    return {
      pending: pending.size + queued,
      errors: [...errors].map(([id, entry]) => ({id, version: entry.version, error: entry.error}))
    };
  }

  function notify() {
    if (onState) onState(state());
  }

  function save(project, index) {
    const id = project.editor_id;
    const version = (versions.get(id) || 0) + 1;
    versions.set(id, version);
    pending.set(id, {project, index, version});
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, SAVE_DELAY);
    notify();
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Capture one detached snapshot per pending project. The controller flushes
    // before switching projects, so edits made during the delay belong together.
    const batch = [...pending].map(([id, entry]) => [id, {
      project: clone(entry.project),
      index: entry.index,
      version: entry.version
    }]);
    pending.clear();
    queued += batch.length;
    notify();

    const action = async () => {
      let ok = true;
      for (const [id, entry] of batch) {
        try {
          await write(entry.project, entry.index);
          const failure = errors.get(id);
          if (failure && failure.version <= entry.version) errors.delete(id);
        } catch (error) {
          ok = false;
          errors.set(id, {version: entry.version, error});
          // Retain this failed snapshot unless a newer save already exists.
          if (!pending.has(id) && versions.get(id) === entry.version) pending.set(id, entry);
          if (onError) onError(error);
        } finally {
          queued -= 1;
          notify();
        }
      }
      return ok && errors.size === 0;
    };
    queue = queue.then(action);
    return queue;
  }

  return {save, flush, state};
}
