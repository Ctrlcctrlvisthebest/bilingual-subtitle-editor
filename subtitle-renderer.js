import {contrast} from './subtitle-formats.js';
import {layoutSubtitleBoxes} from './subtitle-layout.js';

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
  const outline = appearance.mode === 'outline', padding = 10 * scale;
  const available = canvas.width - 160 * scale, x = canvas.width / 2;
  const font = size => (appearance.bold ? '700 ' : '400 ') + size + 'px "' + appearance.font + '", "PingFang SC", "Microsoft YaHei", sans-serif';
  for (const box of layoutSubtitleBoxes(activeRows, appearance)) {
    const color = colors[box.row.speaker] || '#455a64';
    let size = box.size * scale;
    ctx.font = font(size);
    const measured = ctx.measureText(box.text).width;
    if (measured > available) {size *= available / measured; ctx.font = font(size);}
    const metrics = ctx.measureText(box.text), bottom = canvas.height - box.bottom * scale;
    const descent = metrics.actualBoundingBoxDescent ?? size * 0.2;
    ctx.shadowColor = outline ? '#0008' : 'transparent';
    ctx.shadowBlur = outline ? scale : 0;
    ctx.shadowOffsetY = outline ? scale : 0;
    if (!outline) {
      ctx.fillStyle = color;
      ctx.fillRect(x - metrics.width / 2 - padding, bottom - size * 1.3 - padding, metrics.width + 2 * padding, size * 1.3 + 2 * padding);
    }
    if (outline) {
      ctx.strokeStyle = color;
      ctx.lineWidth = appearance.outlineWidth * 2 * scale;
      ctx.strokeText(box.text, x, bottom - descent);
    }
    ctx.fillStyle = outline ? '#ffffff' : contrast(color);
    ctx.fillText(box.text, x, bottom - descent);
  }
  ctx.restore();
}

export function paintVideoExport(canvas, media, rows, appearance, colors, time) {
  canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
  paintSubtitles(canvas, rows.filter(row => row.start <= time && row.end > time), appearance, colors);
}
