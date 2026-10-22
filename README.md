# snap3d-viewer

## Overview

A WebGL2 viewer for **`.snap3d` bundles** — the browser counterpart to
[snap3d](https://github.com/teo646/snap3d.git), the pipeline that turns a set of photos
into one. It renders a low-poly mesh with a baked, view-dependent surface (a
parallax-occlusion march plus a spherical-harmonic colour evaluation), so the object's
appearance changes correctly as you move around it — no lighting model, no material.

### Demo

https://teo646.github.io/snap3d-multisite/

## Usage

```html
<canvas id="canvas" style="width:100%;height:480px"></canvas>
<script src="https://teo646.github.io/snap3d-viewer/dist/viewer.js"></script>
<script>
  const viewer = new Snap3dViewer(canvas, 'bundles/my_run.snap3d');
</script>
```

That's the whole integration. Drag to orbit, wheel to zoom, WASD or the arrows to pan.
As a module instead:

```js
import { Snap3dViewer } from 'https://teo646.github.io/snap3d-viewer/dist/viewer.mjs';

const viewer = new Snap3dViewer(canvas, 'bundles/my_run.snap3d');
await viewer.ready;
```

The second argument is the bundle's `config.json`, or the `.snap3d` folder holding it —
there's no conversion step, this is the folder snap3d's export stage wrote, served as
it stands.

## viewer_editor

A build for picking a bundle's default camera pose and fixing its `up_vector` by eye,
instead of hand-editing `config.json`. Swap the `<script>` tag for
`dist/viewer_editor.js` — same `Snap3dViewer` constructor, same rendering, plus a
floating panel that writes a corrected `config.json` out for you. A ready-made page for
this lives at [`editor/`](editor/README.md).

## API

`new Snap3dViewer(canvas, url, options)`, where `canvas` is an element or a selector
and `url` points at a snap3d bundle.

| | |
|---|---|
| `ready` | promise, resolves with the viewer once the bundle is on the GPU |
| `meta` `warnings` `isReady` `textureBytes` | bundle metadata, load-time warnings, state, VRAM |
| `camera` `controls` | `OrbitCamera`, `OrbitControls` |
| `rotation` `spin` `spinBy(deg)` | the turntable `{center, axis}` the idle spin turns around, how far it has turned, and the step that turns it |
| `setCamera({azimuth, elevation, radius, target})` | any subset, through the same clamps a drag uses |
| `load(url)` | swap in a different bundle, keeping the canvas and the loop |
| `start()` `stop()` `requestRender()` `renderFrame()` | loop control, and drawing from your own loop |
| `resize()` `focus()` | manual resize, keyboard focus |
| `dispose()` | releases the GL objects, the listeners and the loop |

Options: `controls` (`false`, or an `OrbitControls` config), `passthrough` (forward a
click/drag on an empty, transparent part of the canvas to whatever sits behind it),
`autoStart`, `maxPixelRatio`, `antialias`, `fov`, `contextAttributes`,
`loadingIndicator` (a built-in progress bar; `false` to build your own, or `{ color }`
to restyle it), `autoRotate` / `autoRotateSpeed` (idle spin, on by default, that stops
on the visitor's first drag/zoom/pan), and the callbacks `onProgress` `onReady`
`onError` `onWarning`.
