import {createBrowserEditor} from './browser-runtime.js';
import {initVideoExport} from './video-export.js';
import {initOfflinePractice} from './offline/editor.js';
import practice from './offline/练习字幕.srt';

let exporter;
const editor = createBrowserEditor({isExportOpen: () => exporter.isOpen()});
exporter = initVideoExport(editor);
initOfflinePractice(editor, practice);
