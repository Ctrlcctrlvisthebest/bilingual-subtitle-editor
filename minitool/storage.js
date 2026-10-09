(function (root) {
  'use strict';

  // Storage contracts: https://miniapp-sandbox.xiaohongshu.com/minitool/doc §3.6–3.7.
  // A registry write is the only commit point. Until it succeeds, every existing
  // project and the last-project pointer continue to reference their old chunks.
  var PREFIX = 'bse-mini:v1:';
  var MANIFEST_KEY = PREFIX + 'manifest';
  var CHUNK_PREFIX = PREFIX + 'chunk:';
  var CHUNK_CHARS = 200000;
  var MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 10 * 1024 * 1024;
  var MAX_PROJECTS = 50;
  var MAX_MANIFEST_CHARS = 65536;
  var MAX_CHUNKS = Math.ceil(MAX_PAYLOAD_BYTES / (CHUNK_CHARS - 1));
  var generationCounter = 0;
  var manifest = { version: 1, last: null, projects: [] };
  var manifestRaw = null;
  var manifestBytes = 0;
  var backend = null;
  var initPromise = null;
  var migrationPromise = null;
  var operationQueue = Promise.resolve();

  function error(code, message, cause) {
    var result = new Error(message);
    result.name = 'MiniProjectStoreError';
    result.code = code;
    if (cause) {
      result.cause = cause;
      if (cause.errCode !== undefined) result.errCode = cause.errCode;
    }
    return result;
  }

  function storageError(cause) {
    var detail = cause && (cause.errMsg || cause.message);
    return error('STORAGE_FAILED', detail || 'Local storage operation failed.', cause);
  }

  function confirmed(result, api) {
    if (!object(result) || result.errMsg !== api + ':ok') {
      throw storageError(result || error('STORAGE_FAILED', api + ' did not confirm success.'));
    }
    return result;
  }

  function integer(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function identity(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128;
  }

  function title(value) {
    return typeof value === 'string' && value.length <= 200;
  }

  // Count UTF-8 without relying on TextEncoder, which is outside the Android
  // Chrome 61 baseline. Surrogate pairs occupy four bytes; lone ones occupy three.
  function utf8Bytes(text) {
    var bytes = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code < 128) bytes += 1;
      else if (code < 2048) bytes += 2;
      else if (code >= 55296 && code <= 56319 && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function checksum(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function generation() {
    var candidate;
    do {
      generationCounter += 1;
      candidate = Date.now().toString(36) + '-' + generationCounter.toString(36) + '-' +
        Math.floor(Math.random() * 4294967296).toString(36);
    } while (manifest.projects.some(function (entry) { return entry.generation === candidate; }));
    return candidate;
  }

  function generationValid(value) {
    return typeof value === 'string' && value.length <= 80 &&
      /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(value);
  }

  function chunkKey(entry, index) {
    return CHUNK_PREFIX + entry.generation + ':' + index;
  }

  function ownChunk(key) {
    return typeof key === 'string' && key.indexOf(CHUNK_PREFIX) === 0 &&
      /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+:[0-9]{1,2}$/.test(key.slice(CHUNK_PREFIX.length));
  }

  function parseManifest(raw) {
    if (raw === null) return { version: 1, last: null, projects: [] };
    if (typeof raw !== 'string' || raw.length > MAX_MANIFEST_CHARS) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (ignored) { return null; }
    if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects) ||
      parsed.projects.length > MAX_PROJECTS ||
      !(parsed.last === null || identity(parsed.last))) return null;
    var ids = Object.create(null);
    var generations = Object.create(null);
    var entries = [];
    for (var i = 0; i < parsed.projects.length; i += 1) {
      var entry = parsed.projects[i];
      if (!object(entry) || !identity(entry.id) || !title(entry.title) || ids[entry.id] ||
        !generationValid(entry.generation) || generations[entry.generation] ||
        !integer(entry.chunks) || entry.chunks < 1 || entry.chunks > MAX_CHUNKS ||
        !integer(entry.chars) || entry.chars < 1 || entry.chars > MAX_PAYLOAD_BYTES ||
        !integer(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_PAYLOAD_BYTES ||
        typeof entry.hash !== 'string' || !/^[a-f0-9]{8}$/.test(entry.hash)) return null;
      ids[entry.id] = true;
      generations[entry.generation] = true;
      entries.push({ id: entry.id, title: entry.title, generation: entry.generation,
        chunks: entry.chunks, chars: entry.chars, bytes: entry.bytes, hash: entry.hash });
    }
    if (parsed.last !== null && !ids[parsed.last]) return null;
    return { version: 1, last: parsed.last, projects: entries };
  }

  function readBuildVersion(options) {
    var environment = options && options.miniToolEnv;
    var value = environment && environment.buildVersion;
    if (!(typeof value === 'number' || typeof value === 'string') || value === '') return 0;
    var build = Number(value);
    return integer(build) && build > 0 ? build : 0;
  }

  async function buildVersion(xhs, miniTool) {
    var sync = readBuildVersion(xhs && xhs.launchOptions);
    if (sync) return sync;
    if (!miniTool || typeof miniTool.getLaunchOptions !== 'function') return 0;
    try { return readBuildVersion(await miniTool.getLaunchOptions()); }
    catch (ignored) { return 0; }
  }

  function nativeBackend(miniTool) {
    return {
      read: async function (key) {
        var result;
        try { result = await miniTool.getStorage({ key: key }); }
        catch (cause) { throw storageError(cause); }
        confirmed(result, 'getStorage');
        if (!object(result) || !(result.data === null || typeof result.data === 'string')) {
          throw error('CORRUPT_STORAGE', 'Storage returned an invalid data type.');
        }
        return result.data;
      },
      write: async function (key, data) {
        var result;
        try { result = await miniTool.setStorage({ key: key, data: data }); }
        catch (cause) { throw storageError(cause); }
        confirmed(result, 'setStorage');
      },
      remove: async function (key) {
        var result;
        try { result = await miniTool.removeStorage({ key: key }); }
        catch (cause) { throw storageError(cause); }
        confirmed(result, 'removeStorage');
      },
      info: async function () {
        var result;
        try { result = await miniTool.getStorageInfo(); }
        catch (cause) { throw storageError(cause); }
        confirmed(result, 'getStorageInfo');
        if (!object(result) || !Array.isArray(result.keys) || result.keys.length > 10000 ||
          result.keys.some(function (key) { return typeof key !== 'string'; }) ||
          typeof result.currentSize !== 'number' || !isFinite(result.currentSize) ||
          result.currentSize < 0 || typeof result.limitSize !== 'number' ||
          !isFinite(result.limitSize) || result.limitSize <= 0) {
          throw error('CORRUPT_STORAGE', 'Storage returned invalid capacity metadata.');
        }
        return result;
      }
    };
  }

  function browserBackend(storage) {
    return {
      read: async function (key) {
        try { return storage.getItem(key); } catch (cause) { throw storageError(cause); }
      },
      write: async function (key, data) {
        try { storage.setItem(key, data); } catch (cause) { throw storageError(cause); }
      },
      remove: async function (key) {
        try { storage.removeItem(key); } catch (cause) { throw storageError(cause); }
      },
      info: async function () {
        var keys = [];
        try {
          var length = Math.min(storage.length, 10000);
          for (var i = 0; i < length; i += 1) {
            var key = storage.key(i);
            if (typeof key === 'string') keys.push(key);
          }
        } catch (cause) { throw storageError(cause); }
        return { keys: keys };
      }
    };
  }

  async function initialize() {
    var xhs = root.xhs;
    var miniTool = xhs && xhs.miniTool;
    var build = await buildVersion(xhs, miniTool);
    var nativeAvailable = Math.floor(build / 1000) >= 9460 && miniTool &&
      ['setStorage', 'getStorage', 'getStorageInfo', 'removeStorage'].every(function (name) {
        return typeof miniTool[name] === 'function';
      });
    var raw = null;
    if (nativeAvailable) {
      store.mode = 'native';
      backend = nativeBackend(miniTool);
      var info = await backend.info();
      if (info.keys.indexOf(MANIFEST_KEY) !== -1) raw = await backend.read(MANIFEST_KEY);
    } else {
      var storage;
      try {
        storage = root.localStorage;
        if (!storage || typeof storage.getItem !== 'function' ||
          typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
          throw error('STORAGE_UNAVAILABLE', 'Browser storage is unavailable.');
        }
        // Probe before restoring; all browser accesses are guarded because the
        // sandbox can expose localStorage while rejecting its operations.
        var probe = PREFIX + 'probe:' + generation();
        storage.setItem(probe, 'null');
        storage.removeItem(probe);
        raw = storage.getItem(MANIFEST_KEY);
      } catch (ignored) {
        store.mode = 'memory';
        backend = null;
        return store;
      }
      store.mode = 'browser';
      backend = browserBackend(storage);
    }
    var restored = parseManifest(raw);
    if (!restored) {
      // Do not replace an unreadable registry with a new empty one on autosave.
      throw error('CORRUPT_STORAGE', 'The saved project registry is damaged.');
    }
    manifest = restored;
    manifestRaw = raw;
    manifestBytes = raw === null ? 0 : utf8Bytes(raw);
    return store;
  }

  function init() {
    if (!initPromise) initPromise = initialize();
    return initPromise;
  }

  function enqueue(action) {
    var result = operationQueue.then(action, action);
    operationQueue = result.catch(function () {});
    return result;
  }

  function split(text) {
    var parts = [];
    var offset = 0;
    while (offset < text.length) {
      var end = Math.min(offset + CHUNK_CHARS, text.length);
      if (end < text.length && text.charCodeAt(end - 1) >= 55296 &&
        text.charCodeAt(end - 1) <= 56319 && text.charCodeAt(end) >= 56320 &&
        text.charCodeAt(end) <= 57343) end -= 1;
      parts.push(JSON.stringify(text.slice(offset, end)));
      offset = end;
    }
    return parts;
  }

  async function ensureCurrentManifest() {
    var current = await backend.read(MANIFEST_KEY);
    if (current !== manifestRaw) {
      throw error('STALE_STORAGE', 'Saved projects changed or a write was not confirmed. Reopen the tool before saving.');
    }
  }

  async function cleanup(previousInfo) {
    var live = Object.create(null);
    manifest.projects.forEach(function (entry) {
      for (var i = 0; i < entry.chunks; i += 1) live[chunkKey(entry, i)] = true;
    });
    // Cleanup is allowed only after the new manifest has committed. It is best
    // effort: cleanup failure cannot turn an already-committed save into failure.
    try {
      // Another instance or an unconfirmed commit may have advanced the registry.
      // Never delete based on this instance's old view of the live generations.
      await ensureCurrentManifest();
      var info = previousInfo || await backend.info();
      for (var i = 0; i < info.keys.length; i += 1) {
        var key = info.keys[i];
        if (ownChunk(key) && !live[key]) {
          await ensureCurrentManifest();
          try { await backend.remove(key); } catch (ignored) {}
        }
      }
    } catch (ignored) {}
  }

  function snapshot(project) {
    if (!object(project)) throw error('INVALID_PROJECT', 'A plain project object is required.');
    var serialized;
    try { serialized = JSON.stringify(project); }
    catch (cause) { throw error('INVALID_PROJECT', 'The project cannot be serialized.', cause); }
    if (typeof serialized !== 'string' || serialized.length > MAX_PAYLOAD_BYTES) {
      throw error('PROJECT_TOO_LARGE', 'The project exceeds the 8 MiB snapshot limit.');
    }
    var parsed;
    try { parsed = JSON.parse(serialized); }
    catch (cause) { throw error('INVALID_PROJECT', 'The project cannot be restored.', cause); }
    if (!object(parsed) || !identity(parsed.id) || !title(parsed.title)) {
      throw error('INVALID_PROJECT', 'Project id or title is invalid.');
    }
    var bytes = utf8Bytes(serialized);
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw error('PROJECT_TOO_LARGE', 'The project exceeds the 8 MiB snapshot limit.');
    }
    return { project: parsed, text: serialized, bytes: bytes };
  }

  function saveSnapshot(project, options) {
    // Capture at invocation, so edits made while a previous save runs cannot
    // change the snapshot queued for this operation.
    var captured;
    try { captured = snapshot(project); } catch (cause) { return Promise.reject(cause); }
    return enqueue(async function () {
      await init();
      if (!backend) throw error('STORAGE_UNAVAILABLE', 'Persistent local storage is unavailable.');
      await ensureCurrentManifest();
      var index = manifest.projects.findIndex(function (entry) { return entry.id === captured.project.id; });
      if (options && options.skipExisting && index !== -1) return false;
      if (index === -1 && manifest.projects.length >= MAX_PROJECTS) {
        throw error('PROJECT_LIMIT', 'At most 50 projects can be stored.');
      }
      var parts = split(captured.text);
      var entry = { id: captured.project.id, title: captured.project.title, generation: generation(),
        chunks: parts.length, chars: captured.text.length, bytes: captured.bytes, hash: checksum(captured.text) };
      var entries = manifest.projects.slice();
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
      var next = { version: 1, last: options && options.preserveLast ? manifest.last : entry.id, projects: entries };
      var serializedManifest = JSON.stringify(next);
      if (serializedManifest.length > MAX_MANIFEST_CHARS) {
        throw error('PROJECT_LIMIT', 'The project registry is too large.');
      }
      if (store.mode === 'native') {
        var info = await backend.info();
        var stagedBytes = parts.reduce(function (sum, part, position) {
          return sum + utf8Bytes(part) + utf8Bytes(chunkKey(entry, position));
        }, 0);
        var manifestGrowth = Math.max(0, utf8Bytes(serializedManifest) - manifestBytes) + utf8Bytes(MANIFEST_KEY);
        var limitBytes = Math.min(MAX_TOTAL_BYTES, info.limitSize * 1024);
        if (info.currentSize * 1024 + stagedBytes + manifestGrowth > limitBytes &&
          manifestRaw !== null && manifest.projects.length > 0) {
          // A previous commit is known. Retry failed orphan cleanup when space is
          // tight, preserving every generation referenced by the current registry.
          await cleanup(info);
          await ensureCurrentManifest();
          info = await backend.info();
          limitBytes = Math.min(MAX_TOTAL_BYTES, info.limitSize * 1024);
        }
        if (info.currentSize * 1024 + stagedBytes + manifestGrowth > limitBytes) {
          throw error('STORAGE_QUOTA', 'Not enough space to save a new snapshot safely.');
        }
      }
      for (var i = 0; i < parts.length; i += 1) await backend.write(chunkKey(entry, i), parts[i]);
      await ensureCurrentManifest();
      await backend.write(MANIFEST_KEY, serializedManifest);
      manifest = next;
      manifestRaw = serializedManifest;
      manifestBytes = utf8Bytes(serializedManifest);
      await cleanup();
      return true;
    });
  }

  function save(project) {
    return saveSnapshot(project, null).then(function () {});
  }

  async function readSnapshot(source, entry) {
    var pieces = [];
    var chars = 0;
    for (var i = 0; i < entry.chunks; i += 1) {
      var raw = await source.read(chunkKey(entry, i));
      if (typeof raw !== 'string' || raw.length > CHUNK_CHARS * 2 + 2) return null;
      var piece;
      try { piece = JSON.parse(raw); } catch (ignored) { return null; }
      if (typeof piece !== 'string' || piece.length > CHUNK_CHARS) return null;
      chars += piece.length;
      if (chars > entry.chars || chars > MAX_PAYLOAD_BYTES) return null;
      pieces.push(piece);
    }
    var text = pieces.join('');
    if (text.length !== entry.chars || utf8Bytes(text) !== entry.bytes || checksum(text) !== entry.hash) return null;
    var project;
    try { project = JSON.parse(text); } catch (ignored) { return null; }
    if (!object(project) || project.id !== entry.id || project.title !== entry.title) return null;
    return project;
  }

  function get(id) {
    return enqueue(async function () {
      await init();
      if (!identity(id) || !backend) return null;
      var entry = manifest.projects.find(function (item) { return item.id === id; });
      if (!entry) return null;
      return readSnapshot(backend, entry);
    });
  }

  async function migrateLegacyBrowser() {
    await init();
    var result = { migrated: 0, skipped: 0 };
    if (store.mode !== 'native') return result;
    var storage;
    try { storage = root.localStorage; } catch (ignored) { return result; }
    if (!storage || typeof storage.getItem !== 'function') return result;
    var source = browserBackend(storage);
    var raw;
    try { raw = await source.read(MANIFEST_KEY); }
    catch (cause) { throw error('MIGRATION_FAILED', 'The old browser registry could not be read. Keep a backup and retry later.', cause); }
    if (raw === null) return result;
    var legacy = parseManifest(raw);
    if (!legacy) throw error('MIGRATION_FAILED', 'The old browser project registry is damaged. Restore a project backup.');
    var preserveLast = manifest.projects.length > 0;
    var entries = legacy.projects.slice().sort(function (a, b) {
      return a.id === legacy.last ? 1 : b.id === legacy.last ? -1 : 0;
    });
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (manifest.projects.some(function (item) { return item.id === entry.id; })) {
        result.skipped += 1;
        continue;
      }
      try {
        // Browser data is read only. Every imported project uses the ordinary
        // serialized commit queue, so partial migration is safe and retryable.
        var project = await readSnapshot(source, entry);
        if (!project) throw error('CORRUPT_STORAGE', 'The old browser project snapshot is damaged.');
        var imported = await saveSnapshot(project, { skipExisting: true, preserveLast: preserveLast });
        if (imported) result.migrated += 1;
        else result.skipped += 1;
      } catch (cause) {
        var failure = error('MIGRATION_FAILED', 'Some old browser projects could not be imported. Keep a backup and retry later.', cause);
        failure.migrated = result.migrated;
        failure.skipped = result.skipped;
        throw failure;
      }
    }
    return result;
  }

  function migrateBrowser() {
    if (migrationPromise) return migrationPromise;
    var current = migrateLegacyBrowser();
    migrationPromise = current;
    function release() { if (migrationPromise === current) migrationPromise = null; }
    current.then(release, release);
    return current;
  }

  var store = {
    mode: 'memory',
    init: init,
    list: function () {
      return manifest.projects.map(function (entry) { return { id: entry.id, title: entry.title }; });
    },
    get: get,
    migrateBrowser: migrateBrowser,
    last: function () { return manifest.last; },
    save: save
  };
  root.MiniProjectStore = store;
}(window));
