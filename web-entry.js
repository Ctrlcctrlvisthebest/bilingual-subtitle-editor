import {createBrowserEditor} from './browser-runtime.js';
import {initVideoExport} from './video-export.js';
import {initCollaboration} from './collaboration.js';

let exporter;
const editor = createBrowserEditor({isExportOpen: () => exporter.isOpen()});
exporter = initVideoExport(editor);
initCollaboration(editor);
