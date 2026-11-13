import {paintSubtitles} from './subtitle-renderer.js';

export function initSubtitlePreview(editor) {
  const canvas = document.getElementById('subtitlePreview');
  const stage = document.getElementById('videoStage');
  const player = editor.player;
  let rows = [];
  function draw(value) {
    rows = value;
    canvas.width = player.videoWidth || 1920;
    canvas.height = player.videoHeight || 1080;
    stage.style.aspectRatio = canvas.width + ' / ' + canvas.height;
    const project = editor.getProject();
    paintSubtitles(canvas, rows, project.appearance, project.colors);
  }
  function activeRows() {
    return editor.getProject().rows.filter(row => row.start <= player.currentTime && player.currentTime < row.end);
  }
  function preview(row) {
    const active = activeRows();
    if (row) draw(active.includes(row) ? active : [row]);
    else draw([]);
  }
  function playback() {
    const active = activeRows();
    if (active.length !== rows.length || active.some((row, i) => row !== rows[i])) draw(active);
  }
  canvas.hidden = false;
  stage.classList.add('subtitle-preview-stage');
  editor.setCallbacks({onPreview: preview, onPlayback: playback});
  player.addEventListener('loadedmetadata', () => draw(rows));
  player.addEventListener('emptied', () => draw(rows));
  editor.ready.then(() => {
    preview(editor.getProject().rows[editor.getIndex()] || null);
  });
}
