(function (global) {
  'use strict';

  var MAX_PNG_BYTES = 12 * 1024 * 1024;
  var LEGACY_MAX_BYTES = 1024 * 1024;
  var files = global.MiniNativeFiles;
  var MAX_CHUNK_BYTES = files.maxChunkBytes;
  var FILESYSTEM_MIN_VERSION = files.minimumVersion;
  var sequence = 0;

  function failure(message, cause) {
    var error = new Error(message);
    if (cause) error.nativeError = cause;
    return error;
  }

  function validate(blob) {
    var tag = Object.prototype.toString.call(blob);
    if (!blob || (tag !== '[object Blob]' && tag !== '[object File]') ||
        typeof blob.type !== 'string' || blob.type.toLowerCase() !== 'image/png' ||
        typeof blob.slice !== 'function') throw failure('请选择 PNG 图片数据。');
    if (!Number.isSafeInteger(blob.size) || blob.size < 8) throw failure('PNG 图片为空或不完整。');
    if (blob.size > MAX_PNG_BYTES) throw failure('备份 PNG 不能超过 12 MiB，请缩小工程。');
    if (typeof global.FileReader !== 'function' || !global.FileReader.prototype ||
        typeof global.FileReader.prototype.readAsDataURL !== 'function') {
      throw failure('当前环境无法读取 PNG 图片，请在小红书小工具内重试。');
    }
  }

  async function saveNative(blob, sdk, options) {
    var root = files.pathOf(options);
    if (!files.nonempty(root)) throw failure('客户端未提供可用的图片保存路径，请更新小红书。');
    for (var name of ['getFileStorageInfo', 'writeFile', 'appendFile', 'unlink']) {
      if (typeof sdk[name] !== 'function') throw failure('客户端缺少本地图片文件能力，请更新小红书。');
    }
    var info;
    try {
      info = files.confirm(await sdk.getFileStorageInfo(), 'getFileStorageInfo', failure);
    } catch (error) {
      throw failure('无法获取图片保存空间，请检查权限或稍后重试。', error);
    }
    var cap = info.writeChunkMaxBytes;
    if (!Number.isSafeInteger(cap) || cap < 8) throw failure('客户端返回的图片分片容量无效，请更新小红书。');
    if (Number.isSafeInteger(info.usedBytes) && info.usedBytes >= 0 &&
        Number.isSafeInteger(info.limitBytes) && info.limitBytes >= 0 &&
        blob.size > info.limitBytes - info.usedBytes) {
      throw failure('本地图片空间不足，请缩小工程后重试。');
    }
    var chunkBytes = Math.min(MAX_CHUNK_BYTES, Math.floor(cap / 2));
    sequence += 1;
    var relative = 'minitool-backup-' + Date.now().toString(36) + '-' + sequence + '-' +
      Math.random().toString(36).slice(2, 12) + '.png';
    // Do not normalize or parse the native root: append only this generated name.
    var path = root + '/' + relative;
    var written = 0, attempted = false, photoSaved = false, error = null;
    try {
      for (var start = 0; start < blob.size; start += chunkBytes) {
        var end = Math.min(blob.size, start + chunkBytes);
        var piece = await files.readBase64(blob, start, end, '备份 PNG ', failure);
        attempted = true;
        written += await files.writeChunk(sdk, path, piece, start === 0, cap, failure);
        piece = null;
      }
      if (written !== blob.size) throw failure('PNG 图片写入未完成，请重试。');
      files.confirm(await sdk.saveImageToPhotosAlbum({ filePath: path }), 'saveImageToPhotosAlbum', failure);
      photoSaved = true;
    } catch (cause) {
      error = failure('备份原图未确认保存成功：' + (cause && (cause.message || cause.errMsg) || '请检查权限并重试。'), cause);
    } finally {
      if (attempted) {
        try {
          files.confirm(await sdk.unlink({ filePath: path }), 'unlink', failure);
        } catch (cause) {
          if (!error) error = failure('备份原图已保存，但本次本地 PNG 文件清理失败。', cause);
          else error.message += ' 本次本地 PNG 文件未能清理。';
          error.cleanupFailed = true;
          error.cleanupError = cause;
          error.photoSaved = photoSaved;
        }
      }
    }
    if (error) throw error;
  }

  async function saveLegacy(blob, sdk) {
    if (blob.size > LEGACY_MAX_BYTES) throw failure('当前客户端只能保存 1 MiB 以内的备份 PNG，请更新到小红书 9.49 或以上，或缩小工程。');
    var piece = await files.readBase64(blob, 0, blob.size, '备份 PNG ', failure);
    try {
      files.confirm(await sdk.saveImageToPhotosAlbum({ filePath: 'data:image/png;base64,' + piece.data }), 'saveImageToPhotosAlbum', failure);
    } catch (error) {
      throw failure('备份原图未确认保存成功，请检查相册权限后重试。', error);
    }
  }

  global.MiniPhotos = {
    save: async function (blob) {
      var xhs = global.xhs;
      var sdk = xhs && xhs.miniTool;
      if (!sdk || typeof sdk.saveImageToPhotosAlbum !== 'function') {
        throw failure('请在小红书小工具容器内保存工程备份原图。');
      }
      validate(blob);
      var header = await files.readBase64(blob, 0, 8, '备份 PNG ', failure);
      if (header.data !== 'iVBORw0KGgo=') throw failure('图片不是有效的 PNG，请重新生成工程备份。');
      var options = await files.launchOptions(xhs, sdk, failure, function (error, sync) {
        // The existing old-client image API accepts only a bounded 1 MiB data URI.
        return sync || null;
      });
      if (files.versionOf(options) >= FILESYSTEM_MIN_VERSION) return saveNative(blob, sdk, options);
      return saveLegacy(blob, sdk);
    }
  };
})(window);
