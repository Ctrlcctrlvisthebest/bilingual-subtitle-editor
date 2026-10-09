(function (global) {
  'use strict';

  var FILESYSTEM_MIN_VERSION = 9490;
  var MAX_CHUNK_BYTES = 512 * 1024;

  function nonempty(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function confirm(result, api, failure) {
    if (!result || typeof result !== 'object' || result.errMsg !== api + ':ok') {
      throw failure('客户端未确认 ' + api + ' 成功，请检查权限或更新客户端后重试。', result);
    }
    return result;
  }

  function versionOf(options) {
    var env = options && options.miniToolEnv;
    var build = Number(env && env.buildVersion);
    return Number.isSafeInteger(build) && build > 0 ? Math.floor(build / 1000) : 0;
  }

  function pathOf(options) {
    var env = options && options.miniToolEnv;
    return env && env.userDataPath;
  }

  async function launchOptions(xhs, sdk, failure, onRejected) {
    var sync = xhs && xhs.launchOptions;
    var version = versionOf(sync);
    if (version && (version < FILESYSTEM_MIN_VERSION || nonempty(pathOf(sync)))) return sync;
    if (typeof sdk.getLaunchOptions === 'function') {
      var result;
      try {
        result = await sdk.getLaunchOptions();
      } catch (error) {
        return onRejected(error, sync);
      }
      var options = confirm(result, 'getLaunchOptions', failure);
      if (versionOf(options)) return options;
    }
    return sync || null;
  }

  function readBase64(blob, start, end, label, failure) {
    return new Promise(function (resolve, reject) {
      var part, reader;
      try {
        part = blob.slice(start, end);
        if (!part || part.size !== end - start) throw new Error('slice size mismatch');
        reader = new global.FileReader();
      } catch (error) {
        reject(failure('无法开始读取' + label + '，请重新选择文件。', error));
        return;
      }
      function detach() {
        reader.onload = null;
        reader.onerror = null;
        reader.onabort = null;
      }
      reader.onload = function () {
        var result = reader.result;
        detach();
        if (typeof result !== 'string' || !/^data:[^,]*;base64,/.test(result)) {
          reject(failure(label + '分片格式无效，请重新生成或选择文件。'));
          return;
        }
        var data = result.slice(result.indexOf(',') + 1);
        var padding = data.slice(-2) === '==' ? 2 : data.slice(-1) === '=' ? 1 : 0;
        var bytes = data.length / 4 * 3 - padding;
        if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || bytes !== end - start) {
          reject(failure(label + '分片字节数不一致，请重新生成或选择文件。'));
          return;
        }
        resolve({ data: data, bytes: bytes });
      };
      reader.onerror = function () {
        var cause = reader.error;
        detach();
        reject(failure('读取' + label + '失败，请检查文件是否仍可访问。', cause));
      };
      reader.onabort = function () {
        detach();
        reject(failure(label + '读取已中止，请重试。'));
      };
      try {
        reader.readAsDataURL(part);
      } catch (error) {
        detach();
        reject(failure('读取' + label + '失败，请重新选择文件。', error));
      }
    });
  }

  async function writeChunk(sdk, path, piece, first, cap, failure) {
    if (piece.bytes > MAX_CHUNK_BYTES || piece.data.length > cap) {
      throw failure('文件分片超过客户端容量。');
    }
    var method = first ? 'writeFile' : 'appendFile';
    var result = confirm(await sdk[method]({ filePath: path, data: piece.data, encoding: 'base64' }), method, failure);
    if (result.writtenBytes !== piece.bytes) throw failure('文件写入字节数不一致，请重新选择或生成文件。');
    return result.writtenBytes;
  }

  global.MiniNativeFiles = {
    minimumVersion: FILESYSTEM_MIN_VERSION,
    maxChunkBytes: MAX_CHUNK_BYTES,
    nonempty: nonempty,
    confirm: confirm,
    versionOf: versionOf,
    pathOf: pathOf,
    launchOptions: launchOptions,
    readBase64: readBase64,
    writeChunk: writeChunk
  };
})(window);
