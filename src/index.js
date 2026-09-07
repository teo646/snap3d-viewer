// Public entry point for snap3d-viewer.
//
// The one thing most callers need:
//
//   import { Snap3dViewer } from 'snap3d-viewer';
//   const viewer = new Snap3dViewer(canvas, './bundles/my_run.snap3d');
//
// Everything below it is exported too, because a caller who wants to drive the camera
// from their own animation loop, or upload a bundle into a context they already own,
// should not have to fork the package to do it.

export { Snap3dViewer, VIEWER_DEFAULTS } from './viewer.js';
export { OrbitControls, CONTROL_DEFAULTS } from './controls.js';
export { OrbitCamera, horizontalBasis } from './orbit-camera.js';
export { loadBundle } from './bundle.js';
export { readGlb } from './glb.js';
export { readKtx2 } from './ktx2.js';
export { vertexFrameAttributes } from './frame.js';
export { createRenderer } from './renderer.js';
export { PIPELINE_GLSL_SHA256, VERTEX_SHADER, fragmentShader } from './shaders.js';
export * as mat4 from './mat4.js';

export const VERSION = '0.1.0';
