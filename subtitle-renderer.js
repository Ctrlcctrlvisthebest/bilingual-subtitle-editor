import {widthUnits, contrast} from './subtitle-formats.js';

// Encoding visits frames in time order. Keep only active cues between frames.
export function createSubtitleCursor(rows) {
  const ordered = rows.map((row, index) => ({row, index})).sort((a, b) => a.row.start - b.row.start || a.index - b.index);
  let next = 0, previous = -Infinity, active = [];
  return time => {
    if (time < previous) {next = 0; active = [];}
    previous = time;
    active = active.filter(({row}) => row.end > time);
    while (next < ordered.length && ordered[next].row.start <= time) {
      const item = ordered[next++];
      if (item.row.end > time) active.push(item);
    }
    return active.slice().sort((a, b) => a.index - b.index).map(({row}) => row);
  };
}

export function paintSubtitles(canvas, activeRows, appearance, colors) {
  const ctx = canvas.getContext('2d'), scale = canvas.height / 1080;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  let bottom = canvas.height - 60 * scale;
  for (const r of activeRows.slice().reverse()) {
    const color = colors[r.speaker] || '#455a64', outline = appearance.mode === 'outline', lines = [];
    for (const language of appearance.order === 'zh-first' ? ['zh', 'en'] : ['en', 'zh']) {
      const text = r[language].replace(/[\r\n]+/g, ' ').trim();
      if (!text) continue;
      let size = Math.min(appearance[language + 'Size'], Math.floor(1700 / Math.max(1, widthUnits(text)))) * scale;
      const font = s => (appearance.bold ? '700 ' : '400 ') + s + 'px "' + appearance.font + '", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.font = font(size);
      const measured = ctx.measureText(text).width, available = canvas.width - 160 * scale;
      if (measured > available) {size *= available / measured; ctx.font = font(size);}
      const metrics = ctx.measureText(text);
      lines.push({text, size, font: font(size), width: metrics.width, descent: metrics.actualBoundingBoxDescent ?? size * 0.2});
    }
    if (!lines.length) continue;
    const height = lines.reduce((n, line) => n + line.size * 1.3, 0), padding = 10 * scale;
    if (!outline) {
      const width = Math.max(...lines.map(line => line.width));
      ctx.fillStyle = color;
      ctx.fillRect((canvas.width - width) / 2 - padding, bottom - height - padding, width + 2 * padding, height + 2 * padding);
    }
    let y = bottom;
    for (const line of lines.reverse()) {
      ctx.font = line.font;
      ctx.shadowColor = outline ? '#0008' : 'transparent';
      ctx.shadowBlur = outline ? scale : 0;
      ctx.shadowOffsetY = outline ? scale : 0;
      if (outline) {
        ctx.strokeStyle = color;
        ctx.lineWidth = appearance.outlineWidth * 2 * scale;
        ctx.strokeText(line.text, canvas.width / 2, y - line.descent);
      }
      ctx.fillStyle = outline ? '#ffffff' : contrast(color);
      ctx.fillText(line.text, canvas.width / 2, y - line.descent);
      y -= line.size * 1.3;
    }
    bottom -= height + 20 * scale;
  }
  ctx.restore();
}

export function paintVideoExport(canvas, media, rows, appearance, colors, time) {
  canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
  paintSubtitles(canvas, rows.filter(row => row.start <= time && row.end > time), appearance, colors);
}
