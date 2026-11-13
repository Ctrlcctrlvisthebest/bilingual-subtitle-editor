export function widthUnits(s) {
  return [...s].reduce((n, c) => n + (/[\u2e80-\uffef]/.test(c) ? 1 : 0.52), 0);
}

// Reference coordinates are pixels in a 1080p frame, shared by Canvas and ASS.
export function layoutSubtitleBoxes(rows, appearance) {
  const result = [], languages = appearance.order === 'zh-first' ? ['en', 'zh'] : ['zh', 'en'];
  let offset = 0;
  for (const row of rows.slice().reverse()) {
    const boxes = [];
    for (const language of languages) {
      const text = row[language].replace(/[\r\n]+/g, ' ').trim();
      if (!text) continue;
      const size = Math.min(appearance[language + 'Size'], Math.floor(1700 / Math.max(1, widthUnits(text))));
      boxes.push({row, language, text, size, bottom: appearance[language + 'Bottom'] + offset});
    }
    if (!boxes.length) continue;
    result.push(...boxes);
    const low = Math.min(...boxes.map(box => box.bottom));
    const high = Math.max(...boxes.map(box => box.bottom + box.size * 1.3));
    offset += high - low + 20;
  }
  return result;
}
