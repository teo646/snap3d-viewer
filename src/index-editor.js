// Module entry point for Snap3dViewerEditor - everything src/index.js exports, plus
// the editor class itself. Kept separate from src/index.js on purpose: that file is
// what dist/viewer.js's production IIFE also bundles (src/browser.js imports it), and
// the editor's shadow-DOM UI has no business shipping in a storefront's own script
// just because one module graph happened to import both.
//
//   import { Snap3dViewerEditor } from 'snap3d-viewer/editor';
//   const viewer = new Snap3dViewerEditor(canvas, './bundles/my_run.snap3d');

export * from './index.js';
export { Snap3dViewerEditor } from './viewer-editor.js';
