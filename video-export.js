import { clone, roundTime, validTimes } from "./project.js";
import { playbackTime, widthUnits, contrast, buildASS, exportName } from "./subtitle-formats.js";
const BROWSER_EXPORT_LIMIT = 300;
function parseExportRange(mode, startValue, endValue) {
  if (mode === "all") return { start: 0, end: null };
  const startText = startValue.trim();
  const endText = endValue.trim();
  const start = Number(startText);
  const end = Number(endText);
  if (!startText || !endText || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw Error("请填写有效片段：开始不小于 0，结束晚于开始。");
  }
  const range = { start: roundTime(start), end: roundTime(end) };
  if (range.end <= range.start) throw Error("片段须至少 0.001 秒。");
  return range;
}
function clipExportRows(rs, range) {
  return rs.filter((row) => row.end > range.start && (range.end === null || row.start < range.end)).map((row) => ({
    ...row,
    start: roundTime(Math.max(row.start, range.start) - range.start),
    end: roundTime(Math.min(row.end, range.end ?? row.end) - range.start)
  })).filter(validTimes);
}
function browserExportType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"]) if (MediaRecorder.isTypeSupported(type)) return type;
  return null;
}
function zipCRC32(bytes) {
  let crc = 4294967295;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
  }
  return (crc ^ 4294967295) >>> 0;
}
function buildExportZip(files) {
  const encoder = new TextEncoder(), parts = [], directory = [];
  let offset = 0, centralSize = 0;
  const header = (size) => {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
  };
  for (const file of files) {
    const name = encoder.encode(file.name), data = encoder.encode(file.text), crc = zipCRC32(data), local = header(30 + name.length), central = header(46 + name.length);
    local.view.setUint32(0, 67324752, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 2048, true);
    local.view.setUint16(12, 33, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    central.view.setUint32(0, 33639248, true);
    central.view.setUint16(4, 788, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 2048, true);
    central.view.setUint16(14, 33, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(38, (file.executable ? 33261 : 33188) << 16 >>> 0, true);
    central.view.setUint32(42, offset, true);
    central.bytes.set(name, 46);
    parts.push(local.bytes, data);
    directory.push(central.bytes);
    offset += local.bytes.length + data.length;
    centralSize += central.bytes.length;
  }
  const end = header(22);
  end.view.setUint32(0, 101010256, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type: "application/zip" });
}
function burnScriptUnix(range, fast, mac) {
  const seek = range.start ? `seek_args=(-ss ${range.start})` : "seek_args=()", duration = range.end === null ? "duration_args=()" : `duration_args=(-t ${(range.end - range.start).toFixed(3)})`;
  return `#!/bin/bash
set -eu
invocation_dir="$PWD"
cd -- "$(dirname -- "$0")"
interactive=0
[ "$#" -gt 0 ] || interactive=1
finish() { code=$?; if [ "$code" -ne 0 ]; then printf '\\n导出未完成，请查看上面的错误。\\n'; fi; if [ "$interactive" = 1 ]; then read -r -p '按回车关闭…' _ || true; fi; }
trap finish EXIT
ffmpeg_bin="\${FFMPEG_BIN:-}"
if [ -z "$ffmpeg_bin" ]; then
  if [ -x ./ffmpeg ]; then ffmpeg_bin="$PWD/ffmpeg"
  elif command -v ffmpeg >/dev/null 2>&1; then ffmpeg_bin="$(command -v ffmpeg)"
  elif [ -x /opt/homebrew/bin/ffmpeg ]; then ffmpeg_bin=/opt/homebrew/bin/ffmpeg
  elif [ -x /usr/local/bin/ffmpeg ]; then ffmpeg_bin=/usr/local/bin/ffmpeg
  else printf '未找到 FFmpeg。请按 README.txt 安装后再次运行。\\n'; exit 1; fi
fi
input="\${1:-}"
${mac ? `if [ -z "$input" ]; then input="$(osascript -e 'POSIX path of (choose file with prompt "选择要烧录字幕的原视频")')"; fi` : `if [ -z "$input" ]; then read -r -p '输入原视频的完整路径（无需引号）：' input; fi`}
case "$input" in /*) ;; *) input="$invocation_dir/$input" ;; esac
if [ ! -f "$input" ]; then printf '原视频不存在，请检查选择的文件。\\n'; exit 1; fi
output="$PWD/带字幕视频-$(date +%Y%m%d-%H%M%S)-$$.mp4"
${seek}
${duration}
codec_args=(-c:v libx264 -crf 20 -preset veryfast)
${mac && fast ? `if "$ffmpeg_bin" -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then codec_args=(-c:v h264_videotoolbox -b:v 12M); fi` : "# Preserve quality and original frame rate with H.264."}
printf '正在烧录字幕。完成的视频：%s\\n' "$output"
"$ffmpeg_bin" -hide_banner -n "\${seek_args[@]}" -i "$input" "\${duration_args[@]}" -map 0:v:0 -map '0:a:0?' -sn -dn -vf 'ass=filename=captions.ass' "\${codec_args[@]}" -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "$output"
printf '\\n导出成功：%s\\n' "$output"
${mac ? 'if [ "$interactive" = 1 ]; then open -R "$output"; fi' : "# Output is saved in this package folder."}
`;
}
function burnScriptWindows(range) {
  return `param([string]$InputVideo)
$ErrorActionPreference = 'Stop'
$interactive = [string]::IsNullOrWhiteSpace($InputVideo)
$failed = $false
try {
  Set-Location -LiteralPath $PSScriptRoot
  $ffmpegPath = $env:FFMPEG_BIN
  if (!$ffmpegPath) {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'ffmpeg.exe')) { $ffmpegPath = Join-Path $PSScriptRoot 'ffmpeg.exe' }
    else { $ffmpegPath = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
  }
  if (!$ffmpegPath) { throw '未找到 FFmpeg。请按 README.txt 安装后再次运行。' }
  if ($interactive) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = '选择要烧录字幕的原视频'
    if ($picker.ShowDialog() -ne 'OK') { return }
    $InputVideo = $picker.FileName
  }
  $InputVideo = (Resolve-Path -LiteralPath $InputVideo).Path
  $output = Join-Path $PSScriptRoot ('带字幕视频-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID + '.mp4')
  $ffmpegArgs = @('-hide_banner','-n'${range.start ? `, '-ss', '${range.start}'` : ""}, '-i', $InputVideo${range.end === null ? "" : `, '-t', '${(range.end - range.start).toFixed(3)}'`}, '-map','0:v:0','-map','0:a:0?','-sn','-dn','-vf','ass=filename=captions.ass','-c:v','libx264','-crf','20','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',$output)
  Write-Host ('正在烧录字幕。完成的视频：' + $output)
  & $ffmpegPath @ffmpegArgs
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg 导出失败，请查看上面的错误。' }
  Write-Host ('导出成功：' + $output)
} catch { $failed = $true; Write-Host $_ -ForegroundColor Red }
finally { if ($interactive) { Read-Host '按回车关闭' | Out-Null } }
if ($failed) { exit 1 }
`;
}
function exportPackageFiles(rs, range, fast, project) {
  const clipped = clipExportRows(rs, range);
  if (!clipped.length) throw Error("所选区间没有字幕。请选择包含字幕的片段。");
  const readme = `带字幕视频导出包

这个 ZIP 是本机导出包，运行后才会生成 MP4。原视频不会被打包或上传。
导出范围：${range.end === null ? "完整视频" : playbackTime(range.start) + " → " + playbackTime(range.end)}
captions.ass 已按片段起点调整时间，请勿再手动偏移。
project.json 是完整可编辑工程，可回到编辑器导入、修改后重新生成导出包。

Mac
1. 首次安装 FFmpeg：已有 Homebrew 时，在终端运行 brew install ffmpeg。
   没有 Homebrew，可按 https://brew.sh/ 安装，或从 https://ffmpeg.org/download.html 获取带 libass 的版本。
   也可把可执行的 ffmpeg 文件放到本文件夹，文件名为 ffmpeg。
2. 解压后双击 export-mac.command，选择原视频，等待导出。
   若不能双击，在本文件夹的终端运行 bash export-mac.command。
   因为这是你刚生成的本地脚本，可在系统提示阻止运行时查看脚本并在右键菜单选择“打开”。
3. MP4 生成在本文件夹内。原视频、字幕和工程保留。
${fast ? "本包的 Mac 脚本优先使用硬件 H.264，码率 12 Mbps，文件会较大。不可用时使用标准编码。" : "标准编码使用 H.264 / CRF 20，原分辨率与帧率保持；音频转为 AAC。"}

Windows
1. 安装带 libass 的 FFmpeg 并加入 PATH，或把 ffmpeg.exe 放到本文件夹。
2. 在本文件夹打开 PowerShell，运行：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\\export-windows.ps1
   该命令仅在这次运行中允许你生成的脚本执行，不更改系统策略。
3. 选择原视频。MP4 生成在本文件夹内。

Linux
1. 使用系统包管理器安装带 libass 和 libx264 的 FFmpeg。
2. 在本文件夹运行 bash export-linux.sh /完整路径/原视频.mp4（有空格时给路径加引号）。

可把原视频路径作为脚本的第一个参数；FFMPEG_BIN 可指定 FFmpeg 路径。
脚本只读取第一条视频轨和第一条音频轨（无音轨也能导出），忽略旧的软字幕轨。
字幕直接烧进画面，无法在播放器中关闭。源画面若已有烧录字幕，不能自动移除。
请使用包含对应中文字体的系统；FFmpeg 缺少 ass 滤镜或字体时按错误提示补齐。
完整长视频需要等待编码完成；窗口显示编码进度。空间不足或编码失败会保留日志信息，未完成文件请不要当成成品。
脚本不覆盖已有文件、不上传任何文件，也不自动安装软件。
`;
  return [
    { name: "captions.ass", text: buildASS(clipped, project) },
    { name: "project.json", text: JSON.stringify(project, null, 2) },
    { name: "export-mac.command", text: burnScriptUnix(range, fast, true), executable: true },
    { name: "export-linux.sh", text: burnScriptUnix(range, false, false), executable: true },
    { name: "export-windows.ps1", text: "\uFEFF" + burnScriptWindows(range) },
    { name: "README.txt", text: readme }
  ];
}
function paintVideoExport(canvas, media, rs, appearance, colors, t) {
  const ctx = canvas.getContext("2d"), scale = canvas.height / 1080;
  ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  let bottom = canvas.height - 60 * scale;
  for (const r of rs.filter((r2) => r2.start <= t && r2.end > t).reverse()) {
    const color = colors[r.speaker] || "#455a64", outline = appearance.mode === "outline", lines = [];
    for (const language of appearance.order === "zh-first" ? ["zh", "en"] : ["en", "zh"]) {
      const text = r[language].replace(/[\r\n]+/g, " ").trim();
      if (!text) continue;
      let size = Math.min(appearance[language + "Size"], Math.floor(1700 / Math.max(1, widthUnits(text)))) * scale;
      const font = (s) => (appearance.bold ? "700 " : "400 ") + s + 'px "' + appearance.font + '", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.font = font(size);
      const measured = ctx.measureText(text).width, available = canvas.width - 160 * scale;
      if (measured > available) {
        size *= available / measured;
        ctx.font = font(size);
      }
      const metrics = ctx.measureText(text);
      lines.push({ text, size, font: font(size), width: metrics.width, descent: metrics.actualBoundingBoxDescent ?? size * 0.2 });
    }
    if (!lines.length) continue;
    const height = lines.reduce((n, line) => n + line.size * 1.3, 0), padding = 10 * scale;
    if (!outline) {
      const width = Math.max(...lines.map((line) => line.width));
      ctx.fillStyle = color;
      ctx.fillRect((canvas.width - width) / 2 - padding, bottom - height - padding, width + 2 * padding, height + 2 * padding);
    }
    let y = bottom;
    for (const line of lines.reverse()) {
      ctx.font = line.font;
      ctx.shadowColor = outline ? "#0008" : "transparent";
      ctx.shadowBlur = outline ? scale : 0;
      ctx.shadowOffsetY = outline ? scale : 0;
      if (outline) {
        ctx.strokeStyle = color;
        ctx.lineWidth = appearance.outlineWidth * 2 * scale;
        ctx.strokeText(line.text, canvas.width / 2, y - line.descent);
      }
      ctx.fillStyle = outline ? "#ffffff" : contrast(color);
      ctx.fillText(line.text, canvas.width / 2, y - line.descent);
      y -= line.size * 1.3;
    }
    bottom -= height + 20 * scale;
  }
  ctx.restore();
}
function waitExportMedia(media, event, job, trigger) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener(event, success);
      media.removeEventListener("error", failure);
      job.controller.signal.removeEventListener("abort", cancel);
    };
    const success = () => {
      cleanup();
      resolve();
    }, failure = () => {
      cleanup();
      reject(Error("视频无法读取。请载入浏览器能播放的本地视频，或使用本机高清导出。"));
    }, cancel = () => {
      cleanup();
      reject(Error("已取消导出。"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("视频载入或定位超时，请重新选择片源。"));
    }, 2e4);
    media.addEventListener(event, success, { once: true });
    media.addEventListener("error", failure, { once: true });
    job.controller.signal.addEventListener("abort", cancel, { once: true });
    if (job.controller.signal.aborted) {
      cancel();
      return;
    }
    if (trigger) try {
      trigger();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
function initVideoExport(editor) {
  const $ = (id) => document.getElementById(id), player = editor.player, dialog = $("videoExportDialog");
  let videoExportJob = null, videoExportResult = null;
  const exportRange = () => parseExportRange($("videoExportRange").value, $("videoExportStart").value, $("videoExportEnd").value);
  function mediaReady(show = false) {
    const ready = player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0 && !player.error;
    if (!ready && show) editor.notice(player.error || !player.getAttribute("src") ? "请先载入本地音视频。" : "片源正在载入，请稍候。");
    return ready;
  }
  function clearVideoExportResult() {
    if (videoExportResult) URL.revokeObjectURL(videoExportResult);
    videoExportResult = null;
    $("saveVideoExport").hidden = true;
    $("saveVideoExport").removeAttribute("href");
  }
  function updateVideoExportOptions() {
    const browser = $("videoExportMode").value === "browser";
    $("localExportOptions").hidden = browser;
    $("browserExportOptions").hidden = !browser;
    $("videoExportClip").hidden = $("videoExportRange").value !== "clip";
    $("startVideoExport").textContent = browser ? "开始导出视频片段" : "下载本机导出包 ZIP";
    const project = editor.getProject(), a = project.appearance;
    let text = (project.mediaName ? "片源：" + project.mediaName + " · " : "") + project.rows.length + " 条字幕 · " + (a.order === "zh-first" ? "中文在上" : "英文在上") + " · " + (a.mode === "outline" ? "人物颜色描边" : "人物颜色底框");
    try {
      const range = exportRange();
      text += "\n" + (range.end === null ? "完整视频" + (mediaReady() ? " · " + playbackTime(player.duration) : "") : "片段 " + playbackTime(range.start) + " → " + playbackTime(range.end) + " · " + (range.end - range.start).toFixed(3) + " 秒");
      if (browser) {
        const type = browserExportType();
        if (!type) text += "\n当前浏览器不支持直接导出，请选择本机高清 MP4。";
        else text += " · 输出 " + (type.includes("mp4") ? "MP4" : "WebM");
      }
    } catch (err) {
      text += "\n" + err.message;
    }
    $("videoExportInfo").textContent = text;
  }
  function setExportClip(start, end) {
    $("videoExportRange").value = "clip";
    $("videoExportStart").value = String(roundTime(start));
    $("videoExportEnd").value = String(roundTime(end));
    updateVideoExportOptions();
  }
  async function recordVideoExport(rs, range, project) {
    const mimeType = browserExportType(), AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!mimeType || !AudioCtor || !$("videoExportCanvas").captureStream) throw Error("当前浏览器不支持直接视频导出，请使用本机高清 MP4。");
    if (!mediaReady() || !player.videoWidth) throw Error("请先载入能播放的本地视频。音频文件不能直接导成视频。");
    const end = range.end ?? player.duration, start = range.start;
    if (start >= player.duration || end > player.duration + 1e-3) throw Error("片段超出视频时长，请调整开始和结束。");
    if (end - start > BROWSER_EXPORT_LIMIT + 1e-3) throw Error("浏览器最多导出 5 分钟，请选择短片段；完整长视频用本机高清 MP4。");
    const src = player.currentSrc || player.getAttribute("src");
    const a = clone(project.appearance), colors = clone(project.colors), snapshot = clone(rs);
    const job = { controller: new AbortController() }, canvas = $("videoExportCanvas"), media = document.createElement("video");
    const previousDisabled = /* @__PURE__ */ new Map();
    let audio, stream, recorder, raf = null, watchdog = null, chunks = [], bytes = 0;
    videoExportJob = job;
    clearVideoExportResult();
    editor.pause();
    for (const el of $("videoExportDialog").querySelectorAll("button,input,select")) {
      previousDisabled.set(el, el.disabled);
      el.disabled = el.id !== "cancelVideoExport";
    }
    $("cancelVideoExport").hidden = false;
    $("videoExportProgress").hidden = false;
    $("videoExportProgress").value = 0;
    $("videoExportStatus").textContent = "正在准备片段与音轨…";
    media.preload = "auto";
    media.playsInline = true;
    media.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
    $("videoExportDialog").append(media);
    try {
      audio = new AudioCtor();
      await audio.resume();
      const source = audio.createMediaElementSource(media), audioDestination = audio.createMediaStreamDestination();
      source.connect(audioDestination);
      await waitExportMedia(media, "loadedmetadata", job, () => {
        media.src = src;
        media.load();
      });
      if (media.readyState < 2) await waitExportMedia(media, "loadeddata", job);
      if (Math.abs(media.currentTime - start) > 1e-3) await waitExportMedia(media, "seeked", job, () => {
        media.currentTime = start;
      });
      if (media.readyState < 3) await waitExportMedia(media, "canplay", job);
      if (document.fonts?.ready) await document.fonts.ready;
      if (job.controller.signal.aborted) throw Error("已取消导出。");
      const factor = Math.min(1, 720 / media.videoHeight, 1280 / media.videoWidth);
      canvas.width = Math.max(2, Math.floor(media.videoWidth * factor / 2) * 2);
      canvas.height = Math.max(2, Math.floor(media.videoHeight * factor / 2) * 2);
      canvas.hidden = false;
      paintVideoExport(canvas, media, snapshot, a, colors, start);
      stream = canvas.captureStream(30);
      for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4e6, audioBitsPerSecond: 192e3 });
      let recordError = null, lastTime = media.currentTime, lastAdvance = performance.now(), lastUI = 0;
      const stop = () => {
        media.pause();
        if (recorder.state !== "inactive") recorder.stop();
      };
      const abort = () => stop();
      job.controller.signal.addEventListener("abort", abort, { once: true });
      const recorded = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", (e) => {
          if (e.data.size) {
            chunks.push(e.data);
            bytes += e.data.size;
            if (bytes > 256 * 1024 * 1024) {
              recordError = Error("片段超过浏览器导出容量，请缩短片段或使用本机高清 MP4。");
              stop();
            }
          }
        });
        recorder.addEventListener("error", (e) => {
          recordError = e.error || Error("浏览器编码失败。");
          stop();
          reject(recordError);
        });
        recorder.addEventListener("stop", () => recordError ? reject(recordError) : resolve(), { once: true });
      });
      media.addEventListener("ended", stop, { once: true });
      media.addEventListener("error", () => {
        recordError = Error("播放片源时出错。");
        stop();
      }, { once: true });
      const tick = () => {
        if (job.controller.signal.aborted || recorder.state === "inactive") return;
        const t = media.currentTime;
        if (t >= end - 5e-3) {
          stop();
          return;
        }
        paintVideoExport(canvas, media, snapshot, a, colors, t);
        const now = performance.now();
        if (t > lastTime + 0.01) {
          lastTime = t;
          lastAdvance = now;
        }
        if (now - lastUI > 500) {
          lastUI = now;
          $("videoExportProgress").value = Math.min(1, (t - start) / (end - start));
          $("videoExportStatus").textContent = "正在导出 " + playbackTime(t - start) + " / " + playbackTime(end - start) + " · " + Math.floor((t - start) / (end - start) * 100) + "%";
        }
        raf = requestAnimationFrame(tick);
      };
      watchdog = setInterval(() => {
        if (document.visibilityState === "hidden") {
          recordError = Error("页面离开前台，导出已停止。请保持页面可见后重新导出。");
          stop();
        } else if (performance.now() - lastAdvance > 2e4) {
          recordError = Error("视频播放停滞，导出已停止。请重新载入片源或使用本机导出。");
          stop();
        }
      }, 1e3);
      recorder.start(1e3);
      const playback = media.play();
      raf = requestAnimationFrame(tick);
      await Promise.all([playback, recorded]);
      if (job.controller.signal.aborted) throw Error("已取消导出。");
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      if (!blob.size) throw Error("浏览器没有生成视频数据，请使用本机高清 MP4。");
      videoExportResult = URL.createObjectURL(blob);
      const link = $("saveVideoExport"), ext = (recorder.mimeType || mimeType).includes("mp4") ? "mp4" : "webm";
      link.href = videoExportResult;
      link.download = exportName(project, ext).replace("." + ext, "-带字幕片段." + ext);
      link.textContent = "保存 " + ext.toUpperCase() + " 视频";
      link.hidden = false;
      const fileSize = blob.size < 1024 * 1024 ? (blob.size / 1024).toFixed(0) + " KB" : (blob.size / 1024 / 1024).toFixed(1) + " MB";
      $("videoExportProgress").value = 1;
      $("videoExportStatus").textContent = "导出完成，字幕已写进画面，点击下方保存视频。\n" + canvas.width + " × " + canvas.height + " · " + fileSize;
    } finally {
      if (raf !== null) cancelAnimationFrame(raf);
      if (watchdog !== null) clearInterval(watchdog);
      media.pause();
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      media.removeAttribute("src");
      media.load();
      media.remove();
      chunks = [];
      videoExportJob = null;
      for (const [el, disabled] of previousDisabled) el.disabled = disabled;
      $("cancelVideoExport").hidden = true;
      if (audio && audio.state !== "closed") await audio.close();
    }
  }
  $("exportVideo").addEventListener("click", async () => {
    await editor.ready;
    editor.commitTimes();
    $("videoExportStatus").textContent = "";
    $("videoExportCanvas").hidden = true;
    $("videoExportProgress").hidden = true;
    clearVideoExportResult();
    updateVideoExportOptions();
    dialog.showModal();
  });
  $("closeVideoExport").addEventListener("click", () => {
    if (!videoExportJob) dialog.close();
  });
  dialog.addEventListener("cancel", (e) => {
    if (videoExportJob) e.preventDefault();
  });
  dialog.addEventListener("close", clearVideoExportResult);
  $("videoExportMode").addEventListener("change", () => {
    if ($("videoExportMode").value === "browser" && $("videoExportRange").value === "all" && mediaReady() && player.duration > BROWSER_EXPORT_LIMIT) setExportClip(Math.min(player.currentTime, Math.max(0, player.duration - 30)), Math.min(player.duration, player.currentTime + 30));
    updateVideoExportOptions();
  });
  for (const id of ["videoExportRange", "videoExportStart", "videoExportEnd"]) $(id).addEventListener("change", updateVideoExportOptions);
  for (const id of ["videoExportStart", "videoExportEnd"]) for (const event of ["input", "blur"]) $(id).addEventListener(event, updateVideoExportOptions);
  $("videoExportHere").addEventListener("click", () => {
    if (!mediaReady(true)) return;
    const start = Math.min(player.currentTime, Math.max(0, player.duration - 0.1));
    setExportClip(start, Math.min(player.duration, start + 30));
  });
  $("videoExportCue").addEventListener("click", () => {
    const r = editor.getProject().rows[editor.getIndex()];
    if (r) setExportClip(r.start, r.end);
    else $("videoExportStatus").textContent = "请先选择一条字幕。";
  });
  $("cancelVideoExport").addEventListener("click", () => videoExportJob?.controller.abort());
  $("startVideoExport").addEventListener("click", async () => {
    try {
      updateVideoExportOptions();
      const rs = editor.exportRows();
      if (!rs) throw Error("请先导入或填写字幕文字。");
      const range = exportRange(), project = editor.getProject();
      if ($("videoExportMode").value === "browser") {
        if (!clipExportRows(rs, range).length) throw Error("所选区间没有字幕。请选择包含字幕的片段。");
        await recordVideoExport(rs, range, project);
      } else {
        const files = exportPackageFiles(rs, range, $("videoExportEncoder").value === "fast", project);
        editor.download(exportName(project, "zip").replace(".zip", "-视频导出包.zip"), buildExportZip(files), "application/zip");
        $("videoExportStatus").textContent = "导出包已下载。解压 ZIP，在电脑上运行对应脚本，选择原视频，即可生成带字幕的 MP4。\nMac：export-mac.command；首次安装方法见 README.txt。";
      }
    } catch (err) {
      $("videoExportStatus").textContent = err.message;
      $("videoExportProgress").hidden = true;
      clearVideoExportResult();
    }
  });
  return { isOpen: () => dialog.open };
}
export {
  buildExportZip,
  clipExportRows,
  exportPackageFiles,
  initVideoExport,
  parseExportRange,
  zipCRC32
};
