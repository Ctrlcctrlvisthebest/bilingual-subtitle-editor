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
  const column = (appearance.alignment - 1) % 3, row = Math.floor((appearance.alignment - 1) / 3);
  ctx.textAlign = ['left', 'center', 'right'][column];
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const outline = appearance.mode === 'outline', padding = (outline ? appearance.outlineWidth : 10) * scale;
  const marginX = Math.min(Math.max(padding, appearance.marginX * scale), (canvas.width - 1) / 2);
  const available = canvas.width - 2 * marginX, gap = 20 * scale;
  const x = [marginX, canvas.width / 2, canvas.width - marginX][column];
  const groups = [];
  for (const r of activeRows) {
    const color = colors[r.speaker] || '#455a64', lines = [];
    for (const language of appearance.order === 'zh-first' ? ['zh', 'en'] : ['en', 'zh']) {
      const text = r[language].replace(/[\r\n]+/g, ' ').trim();
      if (!text) continue;
      let size = Math.min(appearance[language + 'Size'], Math.floor(1700 / Math.max(1, widthUnits(text)))) * scale;
      const font = s => (appearance.bold ? '700 ' : '400 ') + s + 'px "' + appearance.font + '", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.font = font(size);
      const measured = ctx.measureText(text).width;
      if (measured > available) {size *= available / measured; ctx.font = font(size);}
      const metrics = ctx.measureText(text);
      lines.push({text, size, font: font(size), width: metrics.width, descent: metrics.actualBoundingBoxDescent ?? size * 0.2});
    }
    if (!lines.length) continue;
    groups.push({color, lines, height: lines.reduce((n, line) => n + line.size * 1.3, 0)});
  }
  const height = groups.reduce((total, group) => total + group.height, 0) + Math.max(0, groups.length - 1) * gap;
  const marginY = appearance.marginY * scale;
  const top = row === 2 ? marginY : row === 1 ? (canvas.height - height) / 2 : canvas.height - marginY - height;
  let bottom = Math.max(padding, Math.min(top, canvas.height - padding - height)) + height;
  for (const group of groups.reverse()) {
    const {color, lines, height} = group;
    if (!outline) {
      const width = Math.max(...lines.map(line => line.width));
      const left = column === 0 ? x : column === 1 ? x - width / 2 : x - width;
      ctx.fillStyle = color;
      ctx.fillRect(left - padding, bottom - height - padding, width + 2 * padding, height + 2 * padding);
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
        ctx.strokeText(line.text, x, y - line.descent);
      }
      ctx.fillStyle = outline ? '#ffffff' : contrast(color);
      ctx.fillText(line.text, x, y - line.descent);
      y -= line.size * 1.3;
    }
    bottom -= height + gap;
  }
  ctx.restore();
}

export function paintVideoExport(canvas, media, rows, appearance, colors, time) {
  canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
  paintSubtitles(canvas, rows.filter(row => row.start <= time && row.end > time), appearance, colors);
}
