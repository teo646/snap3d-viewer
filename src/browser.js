// Entry point for the classic-script build (dist/viewer.js).
//
//   <script src="https://teo646.github.io/snap3d-viewer/dist/viewer.js"></script>
//   <script>const viewer = new Snap3dViewer(canvas, 'asset.json');</script>
//
// The global is the constructor itself, not a namespace object, because that is the
// line a page actually writes. The rest of the ESM surface hangs off it as statics -
// `Snap3dViewer.OrbitControls`, `Snap3dViewer.loadBundle`, `Snap3dViewer.VERSION` -
// so a <script> user is not cut off from anything an `import` user gets.

import * as api from './index.js';

const { Snap3dViewer } = api;
for (const [name, value] of Object.entries(api)) {
  if (name !== 'Snap3dViewer') Snap3dViewer[name] = value;
}

globalThis.Snap3dViewer = Snap3dViewer;
export default Snap3dViewer;
