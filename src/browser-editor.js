// Entry point for the classic-script editor build (dist/viewer_editor.js).
//
//   <script src="https://teo646.github.io/snap3d-viewer/dist/viewer_editor.js"></script>
//   <script>const viewer = new Snap3dViewer(canvas, 'my_run.snap3d');</script>
//
// Deliberately the same global name as src/browser.js's own `dist/viewer.js` build,
// not a differently-named class: swapping which one script tag a page loads is the
// entire integration this build is for, and that only works if the page's existing
// `new Snap3dViewer(...)` call needs no edit. Load both scripts on one page and the
// second wins, same as any other same-named global - don't.

import * as api from './index-editor.js';

const { Snap3dViewerEditor } = api;
for (const [name, value] of Object.entries(api)) {
  if (name !== 'Snap3dViewerEditor') Snap3dViewerEditor[name] = value;
}

globalThis.Snap3dViewer = Snap3dViewerEditor;
export default Snap3dViewerEditor;
