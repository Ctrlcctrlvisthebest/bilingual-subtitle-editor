(function (global) {
  'use strict';

  var MAX_VIDEO_BYTES = 100 * 1024 * 1024;
  var files = global.MiniNativeFiles;
  var MAX_CHUNK_BYTES = files.maxChunkBytes;
  var FILESYSTEM_MIN_VERSION = files.minimumVersion;
  var ownedPaths = new Set();
  var sequence = 0;

  function failed(message, cause) {
    var error = new Error(message + ' 字幕编辑仍可继续使用。');
    if (cause) error.nativeError = cause;
    return error;
  }

  function validate(file) {
    if (!file || typeof file.name !== 'string' || !/\.mp4$/i.test(file.name) ||
        typeof file.type !== 'string' || (file.type && file.type.toLowerCase() !== 'video/mp4')) {
      throw failed('请选择 MP4 视频文件。');
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw failed('视频文件为空或大小无效。');
    if (file.size > MAX_VIDEO_BYTES) throw failed('视频不能超过 100 MiB，请先裁剪或压缩。');
    if (typeof file.slice !== 'function') throw failed('当前环境无法分片读取视频。');
    if (typeof global.FileReader !== 'function' || !global.FileReader.prototype ||
        typeof global.FileReader.prototype.readAsDataURL !== 'function') {
      throw failed('当前环境无法读取本地视频。');
    }
  }

  async function removeOwned(sdk, path) {
    if (!ownedPaths.has(path)) return;
    files.confirm(await sdk.unlink({ filePath: path }), 'unlink', failed);
    ownedPaths.delete(path);
  }

  function persistentHandle(sdk, path) {
    var released = false;
    var pending = null;
    return {
      src: path,
      release: async function () {
        if (released) return;
        if (!pending) {
          pending = removeOwned(sdk, path).then(function () {
            released = true;
          }, function (error) {
            pending = null;
            throw failed('本次视频文件清理失败，可稍后重试。', error);
          });
        }
        await pending;
      }
    };
  }

  async function loadPersistent(file, sdk, options) {
    var root = files.pathOf(options);
    if (!files.nonempty(root)) throw failed('客户端未提供可用的视频保存路径，请更新小红书后重试。');
    for (var name of ['getFileStorageInfo', 'writeFile', 'appendFile', 'unlink']) {
      if (typeof sdk[name] !== 'function') throw failed('当前客户端缺少本地视频文件能力，请更新小红书。');
    }
    var info;
    try {
      info = files.confirm(await sdk.getFileStorageInfo(), 'getFileStorageInfo', failed);
    } catch (error) {
      throw failed('无法获取本地文件容量，请检查权限或稍后重试。', error);
    }
    var cap = info && info.writeChunkMaxBytes;
    if (!Number.isSafeInteger(cap) || cap < 8) throw failed('客户端返回的分片容量无效，请更新小红书后重试。');
    if (Number.isSafeInteger(info.usedBytes) && info.usedBytes >= 0 &&
        Number.isSafeInteger(info.limitBytes) && info.limitBytes >= 0 &&
        file.size > info.limitBytes - info.usedBytes) {
      throw failed('小工具本地文件空间不足，请换用较短的视频。');
    }
    // Half of the native cap leaves room for base64 expansion and bridge overhead.
    var chunkBytes = Math.min(MAX_CHUNK_BYTES, Math.floor(cap / 2));
    sequence += 1;
    var relative = 'minitool-video-' + Date.now().toString(36) + '-' + sequence + '-' +
      Math.random().toString(36).slice(2, 12) + '.mp4';
    // Native roots are opaque: retain the returned value and only append our name.
    var path = root + '/' + relative;
    var written = 0;
    try {
      for (var start = 0; start < file.size; start += chunkBytes) {
        var end = Math.min(file.size, start + chunkBytes);
        var piece = await files.readBase64(file, start, end, '本地视频', failed);
        ownedPaths.add(path);
        written += await files.writeChunk(sdk, path, piece, start === 0, cap, failed);
        piece = null;
      }
      if (written !== file.size) throw failed('视频写入未完成，请重新选择文件。');
      return persistentHandle(sdk, path);
    } catch (error) {
      var output = failed('视频未载入，请检查文件、可用空间和权限后重试。', error);
      try {
        await removeOwned(sdk, path);
      } catch (cleanupError) {
        output.cleanupFailed = true;
        output.cleanupError = cleanupError;
        output.message += ' 本次视频文件未能清理。';
      }
      throw output;
    }
  }

  global.MiniVideo = {
    load: async function (file) {
      var xhs = global.xhs;
      var sdk = xhs && xhs.miniTool;
      if (!sdk) throw failed('请在小红书小工具容器中载入视频。');
      validate(file);
      var options = await files.launchOptions(xhs, sdk, failed, function (error) {
        throw failed('无法确认客户端版本，请更新到小红书 9.49 或以上后载入视频。', error);
      });
      if (files.versionOf(options) >= FILESYSTEM_MIN_VERSION) return loadPersistent(file, sdk, options);
      throw failed('载入视频需要小红书 9.49 或以上；请更新客户端后重试。');
    }
  };
})(window);
