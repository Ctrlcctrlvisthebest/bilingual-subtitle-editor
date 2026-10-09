import {ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget} from 'mediabunny';
import {exportName} from './subtitle-formats.js';
import {createSubtitleCursor, paintSubtitles} from './subtitle-renderer.js';

export function directExportSupport() {
  return typeof globalThis.showSaveFilePicker === 'function' &&
    typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoDecoder === 'function';
}

export async function exportMP4(options) {
  if (!directExportSupport()) throw Error('网页 MP4 导出需要支持本地文件保存与视频编码的桌面 Chrome / Edge。请用这些浏览器打开编辑器。');
  if (!options.file) throw Error('请先载入本地原视频，再导出 MP4。');
  options.signal.throwIfAborted();
  // Invoke the picker immediately within the export button's user activation.
  const handle = await globalThis.showSaveFilePicker({
    suggestedName: exportName(options.project, 'mp4').replace(/\.mp4$/, '-带字幕.mp4'),
    types: [{description: '带字幕 MP4 视频', accept: {'video/mp4': ['.mp4']}}],
    excludeAcceptAllOption: true,
  });
  if (handle.name === options.file.name) throw Error('请使用不同于原视频的文件名，避免覆盖片源。');
  return writeMP4({...options, handle});
}

// The file remains uncommitted until encoding and MP4 finalization both succeed.
export async function writeMP4({file, handle, project, rows, range, canvas, signal, onProgress}) {
  const input = new Input({source: new BlobSource(file), formats: ALL_FORMATS});
  let output, writable, conversion, cancelPromise, cancelError, completed = false, size = 0;
  const cancel = () => {
    cancelPromise = conversion.cancel().catch(error => {cancelError = error;});
  };
  try {
    signal.throwIfAborted();
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw Error('片源没有视频轨，音频文件不能导出为带字幕视频。');
    const duration = await input.computeDuration(), end = range.end ?? duration;
    if (range.start >= duration || end > duration + 0.001) throw Error('导出区间超出原视频时长，请调整开始和结束。');
    const width = await video.getDisplayWidth(), height = await video.getDisplayHeight();
    const factor = Math.min(1, 1920 / width, 1080 / height);
    canvas.width = Math.max(2, Math.floor(width * factor / 2) * 2);
    canvas.height = Math.max(2, Math.floor(height * factor / 2) * 2);
    const ctx = canvas.getContext('2d'), activeRows = createSubtitleCursor(rows);
    await document.fonts.ready;
    signal.throwIfAborted();
    writable = await handle.createWritable();
    const target = new StreamTarget(new WritableStream({
      write: async chunk => {
        await writable.write(chunk);
        size = Math.max(size, chunk.position + chunk.data.byteLength);
      },
      // StreamTarget closes on cancellation too. Only this function commits the file.
    }), {chunked: true, chunkSize: 1024 * 1024});
    output = new Output({format: new Mp4OutputFormat({fastStart: false}), target});
    conversion = await Conversion.init({
      input, output, tracks: 'primary', trim: {start: range.start, end}, showWarnings: false,
      video: {
        codec: 'avc', quality: new Quality('high'), width: canvas.width, height: canvas.height, frameRate: 30,
        fit: 'contain', allowTransformationMetadata: false,
        process: sample => {
          signal.throwIfAborted();
          sample.draw(ctx, 0, 0, canvas.width, canvas.height);
          paintSubtitles(canvas, activeRows(sample.timestamp + range.start), project.appearance, project.colors);
          return canvas;
        },
      },
      audio: {codec: 'aac'},
    });
    const audio = await input.getPrimaryAudioTrack();
    if (!conversion.isValid || !conversion.utilizedTracks.includes(video)) throw Error('当前浏览器无法解码片源或编码 H.264 视频，请使用支持该格式的桌面 Chrome / Edge。');
    if (audio && !conversion.utilizedTracks.includes(audio)) throw Error('当前浏览器无法处理原视频的音轨或编码 AAC，导出已停止，以免生成无声视频。');
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, {once: true});
    conversion.onProgress = progress => onProgress({phase: 'encoding', progress, size});
    await conversion.execute();
    signal.throwIfAborted();
    signal.removeEventListener('abort', cancel);
    onProgress({phase: 'saving', progress: 1, size});
    await writable.close();
    completed = true;
    return {name: handle.name, width: canvas.width, height: canvas.height, duration: end - range.start, size};
  } finally {
    signal.removeEventListener('abort', cancel);
    try {
      if (cancelPromise) {await cancelPromise; if (cancelError) throw cancelError;}
      if (output && output.state !== 'finalized') await output.cancel();
    } finally {
      input.dispose();
      if (writable && !completed) await writable.abort();
    }
  }
}
