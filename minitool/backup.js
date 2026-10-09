(function (root) {
  'use strict';

  // The visible header is followed by a lossless RGB byte band. Keep the PNG
  // original: screenshots, JPEG conversion, or resizing destroy these bytes.
  var WIDTH = 720;
  var HEADER_HEIGHT = 192;
  var PREFIX_LENGTH = 16;
  var MAX_PAYLOAD = 8 * 1024 * 1024;
  var MAX_BAND_HEIGHT = Math.ceil((PREFIX_LENGTH + MAX_PAYLOAD) / (WIDTH * 3));
  var MAGIC = [66, 83, 69, 80, 78, 71, 49, 33]; // BSEPNG1!
  var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  var crcTable = null;

  function fail(message) { throw new Error(message); }

  function isObject(value) {
    return value !== null && Object.prototype.toString.call(value) === '[object Object]';
  }

  function checkProject(project) {
    if (!isObject(project) || !Array.isArray(project.rows) ||
        (project.title !== undefined && typeof project.title !== 'string')) {
      fail('备份工程格式无效：需要包含字幕列表的工程。');
    }
    for (var i = 0; i < project.rows.length; i++) {
      if (!isObject(project.rows[i])) fail('备份工程格式无效：字幕条目必须是对象。');
    }
  }

  function bytes(value) {
    var tag = Object.prototype.toString.call(value);
    if (tag !== '[object Uint8Array]' && tag !== '[object Uint8ClampedArray]') {
      fail('备份二进制数据无效。');
    }
    return value;
  }

  function utf8Encode(text) {
    if (typeof root.TextEncoder === 'function') return new root.TextEncoder().encode(text);
    var result = new Uint8Array(text.length * 3), offset = 0;
    for (var i = 0; i < text.length; i++) {
      var point = text.charCodeAt(i);
      if (point >= 0xd800 && point <= 0xdbff) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          point = 0x10000 + ((point - 0xd800) << 10) + next - 0xdc00;
          i++;
        } else point = 0xfffd;
      } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd;
      if (point < 0x80) result[offset++] = point;
      else if (point < 0x800) {
        result[offset++] = 0xc0 | (point >> 6); result[offset++] = 0x80 | (point & 63);
      } else if (point < 0x10000) {
        result[offset++] = 0xe0 | (point >> 12); result[offset++] = 0x80 | ((point >> 6) & 63); result[offset++] = 0x80 | (point & 63);
      } else {
        result[offset++] = 0xf0 | (point >> 18); result[offset++] = 0x80 | ((point >> 12) & 63);
        result[offset++] = 0x80 | ((point >> 6) & 63); result[offset++] = 0x80 | (point & 63);
      }
    }
    return result.subarray(0, offset);
  }

  function unicodeSafeJSON(text) {
    // Chrome 61 predates well-formed JSON.stringify. Escape isolated surrogate
    // code units rather than letting the UTF-8 encoder replace user text.
    return text.replace(/[\ud800-\udfff]/g, function (character, index) {
      var code = character.charCodeAt(0);
      var paired = code <= 0xdbff
        ? text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff
        : text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff;
      return paired ? character : '\\u' + ('0000' + code.toString(16)).slice(-4);
    });
  }

  function utf8Decode(input) {
    // Decode strictly in one pass; damaged UTF-8 must never become replacement characters.
    var chunks = [], current = '';
    for (var i = 0; i < input.length;) {
      var first = input[i++], point, count, minimum;
      if (first < 0x80) { point = first; count = 0; minimum = 0; }
      else if (first >= 0xc2 && first <= 0xdf) { point = first & 31; count = 1; minimum = 0x80; }
      else if (first >= 0xe0 && first <= 0xef) { point = first & 15; count = 2; minimum = 0x800; }
      else if (first >= 0xf0 && first <= 0xf4) { point = first & 7; count = 3; minimum = 0x10000; }
      else fail('备份内容损坏：文字编码无效，请重新选择原始 PNG。');
      if (i + count > input.length) fail('备份内容不完整：文字编码被截断。');
      for (var c = 0; c < count; c++) {
        var continuation = input[i++];
        if ((continuation & 0xc0) !== 0x80) fail('备份内容损坏：文字编码无效，请重新选择原始 PNG。');
        point = (point << 6) | (continuation & 63);
      }
      if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
        fail('备份内容损坏：文字编码无效，请重新选择原始 PNG。');
      }
      if (point > 0xffff) {
        point -= 0x10000;
        current += String.fromCharCode(0xd800 | (point >> 10), 0xdc00 | (point & 1023));
      } else current += String.fromCharCode(point);
      if (current.length >= 8192) { chunks.push(current); current = ''; }
    }
    chunks.push(current);
    return chunks.join('');
  }

  function crc32(input) {
    input = bytes(input);
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var value = n;
        for (var bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crcTable[n] = value >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < input.length; i++) crc = crcTable[(crc ^ input[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function read32(input, offset) {
    return (input[offset] * 0x1000000 + (input[offset + 1] << 16) + (input[offset + 2] << 8) + input[offset + 3]) >>> 0;
  }

  function write32(input, offset, value) {
    input[offset] = (value >>> 24) & 255;
    input[offset + 1] = (value >>> 16) & 255;
    input[offset + 2] = (value >>> 8) & 255;
    input[offset + 3] = value & 255;
  }

  function readPrefix(input) {
    if (input.length < PREFIX_LENGTH) fail('备份内容不完整：数据头被截断。');
    for (var i = 0; i < MAGIC.length; i++) {
      if (input[i] !== MAGIC[i]) fail('这张图片不是字幕工程备份，或已被截图、压缩或修改。请选择原始备份 PNG。');
    }
    var length = read32(input, 8);
    if (length === 0 || length > MAX_PAYLOAD) fail('备份数据长度无效，或超过 8 MiB 上限。');
    return { length: length, checksum: read32(input, 12) };
  }

  function pack(project) {
    checkProject(project);
    var json;
    try { json = unicodeSafeJSON(JSON.stringify({ format: 'bse-backup-v1', project: project })); }
    catch (error) { fail('工程无法备份：数据不是有效 JSON，或包含循环引用。'); }
    if (json.length > MAX_PAYLOAD) fail('工程过大：备份内容不能超过 8 MiB。');
    var payload = utf8Encode(json);
    if (!payload.length || payload.length > MAX_PAYLOAD) fail('工程过大：备份内容不能超过 8 MiB。');
    // Check the serialized shape too, in case an object supplied a toJSON hook.
    var saved;
    try { saved = JSON.parse(json); }
    catch (error) { fail('工程无法备份：数据不是有效 JSON。'); }
    if (!isObject(saved) || saved.format !== 'bse-backup-v1') fail('备份工程格式无效。');
    checkProject(saved.project);
    var result = new Uint8Array(PREFIX_LENGTH + payload.length);
    result.set(MAGIC, 0);
    write32(result, 8, payload.length);
    write32(result, 12, crc32(payload));
    result.set(payload, PREFIX_LENGTH);
    return result;
  }

  function unpack(input) {
    input = bytes(input);
    var prefix = readPrefix(input);
    var expected = PREFIX_LENGTH + prefix.length;
    if (input.length < expected) fail('备份内容不完整：数据被截断，请选择完整的原始 PNG。');
    if (input.length !== expected) fail('备份数据长度无效：存在多余数据。');
    var payload = input.subarray(PREFIX_LENGTH, expected);
    if (crc32(payload) !== prefix.checksum) fail('备份校验失败：图片可能被压缩或修改。请选择原始 PNG。');
    var envelope;
    try { envelope = JSON.parse(utf8Decode(payload)); }
    catch (error) {
      if (/文字编码/.test(error.message)) throw error;
      fail('备份内容损坏：工程 JSON 无效。');
    }
    if (!isObject(envelope) || envelope.format !== 'bse-backup-v1') fail('备份工程格式无效，或版本不受支持。');
    checkProject(envelope.project);
    return envelope.project;
  }

  function bytesToRGBA(input) {
    input = bytes(input);
    var prefix = readPrefix(input);
    if (input.length !== PREFIX_LENGTH + prefix.length) fail('备份数据长度无效或不完整。');
    var height = Math.ceil(input.length / (WIDTH * 3));
    var rgba = new Uint8ClampedArray(WIDTH * height * 4);
    for (var p = 0, offset = 0; p < rgba.length; p += 4) {
      rgba[p] = offset < input.length ? input[offset++] : 0;
      rgba[p + 1] = offset < input.length ? input[offset++] : 0;
      rgba[p + 2] = offset < input.length ? input[offset++] : 0;
      rgba[p + 3] = 255;
    }
    return rgba;
  }

  function rgbaToBytes(rgba) {
    rgba = bytes(rgba);
    if (rgba.length % 4 !== 0) fail('备份像素数据不完整。');
    var result = new Uint8Array(rgba.length / 4 * 3);
    for (var p = 0, offset = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] !== 255) fail('备份图片包含透明像素或已被修改，请选择原始 PNG。');
      result[offset++] = rgba[p];
      result[offset++] = rgba[p + 1];
      result[offset++] = rgba[p + 2];
    }
    return result;
  }

  function decodeBand(rgba, width, height) {
    if (width !== WIDTH) fail('备份图片尺寸已改变：宽度必须是 720 像素。请勿缩放或截图。');
    if (height !== Math.floor(height) || height < 1 || height > MAX_BAND_HEIGHT) fail('备份图片高度无效或超过上限，请选择原始 PNG。');
    rgba = bytes(rgba);
    if (rgba.length !== width * height * 4) fail('备份图片像素不完整。');
    var band = rgbaToBytes(rgba);
    var prefix = readPrefix(band);
    var expected = PREFIX_LENGTH + prefix.length;
    if (height !== Math.ceil(expected / (WIDTH * 3))) fail('备份图片被裁剪、缩放或数据不完整，请选择原始 PNG。');
    // The unused pixels are zero-filled, so accidental changes there are also
    // caught instead of accepting an altered image with a valid first payload.
    for (var i = expected; i < band.length; i++) {
      if (band[i] !== 0) fail('备份图片尾部数据已改变，请选择原始 PNG。');
    }
    return unpack(band.subarray(0, expected));
  }

  function canvasContext(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') fail('当前环境不支持 Canvas 图片备份。');
    var context = canvas.getContext('2d');
    if (!context) fail('当前环境不支持图片备份，请在支持 Canvas 的浏览器中使用。');
    return context;
  }

  function fitText(context, value, maxWidth) {
    var text = String(value || '未命名字幕工程');
    if (context.measureText(text).width <= maxWidth) return text;
    var points = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      var next = text.charCodeAt(i + 1);
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) points.push(text.slice(i, ++i + 1));
      else points.push(text.charAt(i));
    }
    while (points.length && context.measureText(points.join('') + '…').width > maxWidth) points.pop();
    return points.join('') + '…';
  }

  function createBackupCanvas(project) {
    if (!root.document || !root.document.createElement) fail('当前环境不支持 Canvas 图片备份。');
    var data = pack(project);
    var bandHeight = Math.ceil(data.length / (WIDTH * 3));
    var canvas = root.document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEADER_HEIGHT + bandHeight;
    var context = canvasContext(canvas);
    context.fillStyle = '#fff8f4';
    context.fillRect(0, 0, WIDTH, HEADER_HEIGHT);
    context.fillStyle = '#dc3147';
    context.font = 'bold 18px sans-serif';
    context.fillText('双语字幕 · 可编辑工程备份', 32, 38);
    context.fillStyle = '#25242a';
    context.font = 'bold 30px sans-serif';
    context.fillText(fitText(context, project.title, WIDTH - 64), 32, 82);
    context.font = '18px sans-serif';
    context.fillText('共 ' + project.rows.length + ' 条字幕 · 包含文字、样式、状态与备注', 32, 118);
    context.fillStyle = '#b1263b';
    context.font = 'bold 20px sans-serif';
    context.fillText('保留原图，请勿截图或压缩', 32, 156);
    var imageData = context.createImageData(WIDTH, bandHeight);
    imageData.data.set(bytesToRGBA(data));
    context.putImageData(imageData, 0, HEADER_HEIGHT);
    return canvas;
  }

  function encode(project) {
    var canvas = createBackupCanvas(project);
    try { return canvas.toDataURL('image/png'); }
    catch (error) { fail('生成备份图片失败，请重试或缩小工程。'); }
  }

  function encodeBlob(project) {
    return Promise.resolve().then(function () {
      var canvas = createBackupCanvas(project);
      if (typeof canvas.toBlob !== 'function') {
        fail('当前环境不支持 PNG 文件备份（Canvas.toBlob 不可用），请升级小红书或换用支持此功能的浏览器。');
      }
      return new Promise(function (resolve, reject) {
        function failed() { reject(new Error('生成 PNG 备份文件失败，请重试或缩小工程。')); }
        try {
          // Keep this path binary: a data URL can exceed the native bridge's
          // Base64 limit before the file is split into supported native writes.
          canvas.toBlob(function (blob) {
            if (!blob || !Number.isFinite(blob.size) || blob.size <= 0 ||
                typeof blob.slice !== 'function' || typeof blob.type !== 'string' ||
                blob.type.toLowerCase() !== 'image/png') failed();
            else resolve(blob);
          }, 'image/png');
        } catch (error) { failed(); }
      });
    });
  }

  function readFile(file, asDataURL) {
    return new Promise(function (resolve, reject) {
      var reader = new root.FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('无法读取备份图片，请重新选择文件。')); };
      reader.onabort = function () { reject(new Error('已取消读取备份图片。')); };
      try {
        if (asDataURL) reader.readAsDataURL(file);
        else reader.readAsArrayBuffer(file);
      } catch (error) { reject(new Error('无法读取备份图片，请重新选择文件。')); }
    });
  }

  function decodeFile(file) {
    return Promise.resolve().then(function () {
      if (!file || typeof file.slice !== 'function') fail('请先选择原始 PNG 备份图片。');
      if (typeof root.FileReader !== 'function' || typeof root.Image !== 'function' || !root.document) {
        fail('当前环境不支持读取图片备份，请换用支持文件选择的浏览器。');
      }
      if (/jpe?g/i.test(file.type || '') || /\.jpe?g$/i.test(file.name || '')) fail('JPEG 会破坏工程数据，请选择原始 PNG 备份图片。');
      if (!Number.isFinite(file.size) || file.size < 8) fail('备份图片为空或文件不完整。');
      // A maximum-size raw RGBA PNG fits well under this limit; avoid reading
      // arbitrary giant files before their dimensions can be inspected.
      if (file.size > 32 * 1024 * 1024) fail('备份图片文件过大，请选择不超过 32 MiB 的原始 PNG。');
      return readFile(file.slice(0, 8), false);
    }).then(function (buffer) {
      var signature = new Uint8Array(buffer);
      for (var i = 0; i < PNG_SIGNATURE.length; i++) {
        if (signature[i] !== PNG_SIGNATURE[i]) fail('文件不是 PNG 图片，请选择原始 PNG 备份。JPEG、截图或压缩图片无法恢复工程。');
      }
      return readFile(file, true);
    }).then(function (dataURL) {
      return new Promise(function (resolve, reject) {
        var image = new root.Image();
        image.onerror = function () { reject(new Error('无法打开备份 PNG，图片可能已损坏。')); };
        image.onload = function () {
          try {
            var width = image.naturalWidth, height = image.naturalHeight;
            if (width !== WIDTH) fail('备份图片尺寸已改变：宽度必须是 720 像素。请勿缩放或截图。');
            if (height <= HEADER_HEIGHT || height > HEADER_HEIGHT + MAX_BAND_HEIGHT) fail('备份图片高度无效或超过上限，请选择完整的原始 PNG。');
            var canvas = root.document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            var context = canvasContext(canvas);
            context.drawImage(image, 0, 0);
            var pixelData = context.getImageData(0, HEADER_HEIGHT, width, height - HEADER_HEIGHT);
            resolve(decodeBand(pixelData.data, width, height - HEADER_HEIGHT));
          } catch (error) { reject(error); }
        };
        image.src = dataURL;
      });
    });
  }

  root.SubtitleBackup = {
    encode: encode,
    encodeBlob: encodeBlob,
    decodeFile: decodeFile,
    pack: pack,
    unpack: unpack,
    crc32: crc32,
    bytesToRGBA: bytesToRGBA,
    rgbaToBytes: rgbaToBytes,
    decodeBand: decodeBand,
    constants: { width: WIDTH, headerHeight: HEADER_HEIGHT, prefixLength: PREFIX_LENGTH, maxPayload: MAX_PAYLOAD, maxBandHeight: MAX_BAND_HEIGHT }
  };
})(typeof window !== 'undefined' ? window : this);
