# snap3d-viewer

A WebGL2 viewer for SH-texture surface bundles — the browser counterpart to the
pipeline's [`viewers/view_bundle.py`](../3d_recon_sh_texture/viewers/view_bundle.py).

It renders the same thing that viewer does, by the same procedure: a low-poly mesh, a
parallax-occlusion march through a baked height map to resolve each fragment's uv, and
a spherical-harmonic evaluation of the view direction in the surface's local frame. No
lighting model, no material — the SH texture *is* the appearance, so the surface
changes as you move around it.

## Quick start

```html
<canvas id="canvas" style="width:100%;height:480px"></canvas>
<script src="https://teo646.github.io/snap3d-viewer/dist/viewer.js"></script>
<script>
  const viewer = new Snap3dViewer(canvas, 'asset.json');
</script>
```

That is the whole integration. Drag to orbit, wheel to zoom, WASD or the arrows to pan,
`R` to reset. As a module instead:

```js
import { Snap3dViewer } from 'https://teo646.github.io/snap3d-viewer/dist/viewer.mjs';

const viewer = new Snap3dViewer(canvas, 'asset.json');
await viewer.ready;
```

The second argument is the bundle's JSON manifest, or the directory holding a
`bundle.json`; the binary blobs are fetched from alongside it either way.

The loop is demand-driven: rAF runs while something is changing — a drag, a held key, a
resize, an explicit `requestRender()` — and stops when the image settles, because a
viewer embedded in someone else's page has no business burning a phone's battery on a
still frame. Pass `{ render: 'always' }` for a continuously clocked loop.

### API

`new Snap3dViewer(canvas, url, options)`, where `canvas` is an element or a selector.

| | |
|---|---|
| `ready` | promise, resolves with the viewer once the bundle is on the GPU |
| `meta` `warnings` `isReady` `textureBytes` | bundle metadata, load-time warnings, state, VRAM |
| `camera` `controls` `home` | `OrbitCamera`, `OrbitControls`, the pose the bundle ships |
| `setCamera({azimuth, elevation, radius, target})` `resetCamera()` | any subset, through the same clamps a drag uses |
| `start()` `stop()` `requestRender()` `renderFrame()` | loop control, and drawing from your own loop |
| `resize()` `focus()` `snapshot(type, quality)` | manual resize, keyboard focus, PNG data URL |
| `dispose()` | releases the GL objects, the listeners and the loop |

Options: `background`, `controls` (`false`, or an `OrbitControls` config), `render`,
`autoStart`, `maxPixelRatio`, `antialias`, `fov`, `contextAttributes`, and the callbacks
`onProgress` `onReady` `onError` `onWarning` `onFrame`.

The `<script>` build defines `Snap3dViewer` as the constructor itself, with the rest of
the module surface on it as statics — `Snap3dViewer.OrbitControls`,
`Snap3dViewer.loadBundle`, `Snap3dViewer.VERSION` — so a script-tag user is not cut off
from anything an `import` user gets.

## Producing a bundle

```
python tools/export_web_bundle.py <run>/10_export   # npz bundle -> web assets
python tools/serve.py                               # http://127.0.0.1:8000/demo/
```

The demo page at `/demo/` opens the first converted bundle; `?bundle=<name>` picks one
when several are converted.

## Building and publishing

```
npm ci
npm run build      # dist/viewer.js (script tag), .mjs (ESM), .cjs (CommonJS)
npm run check      # bundles every entry without writing anything
```

`dist/` is gitignored. `.github/workflows/pages.yml` rebuilds it on every push to `main`
and publishes it to GitHub Pages together with a landing page, so the URL in the Quick
Start is always the build that matches `main` and no one ever hand-edits a build
artifact. Enabling Pages is a one-time manual step: **Settings → Pages → Source: GitHub
Actions**.

The version is declared in both `package.json` and `src/index.js`; the build fails if
they disagree, so drift becomes a red CI run rather than a wrong number in a bug report.

## Why there is a conversion step

The pipeline's bundle is `config.json` + two `.npz` files, which a browser cannot read.
`tools/export_web_bundle.py` unzips them into flat little-endian blobs plus one
`bundle.json` index, and does three things worth knowing about:

**It ships the per-vertex frame.** `view_bundle.py` recomputes normals and the raw
dP/du, dP/dv at load time, because the bundle carries no frame and reproducing the fit's
frame approximately is the one way to get subtly wrong colours everywhere. Rather than
port `vertex_frame_attributes` — and trimesh's smooth-normal fallback — to JavaScript,
the converter calls the pipeline's own function and writes the result. That costs
~2.3 MB against a ~41 MB payload, and buys a frame that is identical by construction
rather than by review. It is why the converter needs the pipeline importable
(`--pipeline-root`, default `../3d_recon_sh_texture`) and must run under the pipeline's
interpreter.

**It narrows the atlas to float16.** Halves the download. The error is 1e-4 on average;
the worst case is 0.03, reached only by the ~0.01% of SH coefficients with |c| > 25,
whose contribution is clamped into `[0, 1]` anyway. `--full-precision` keeps float32,
at ~2x the bytes and a dependency on `OES_texture_float_linear` for filtering.

**It flips v.** `camera_raster.to_gl_texture` flips every atlas raster so row 0 lands at
v=0, matching GL's bottom-left origin. `UNPACK_FLIP_Y_WEBGL` does not apply to
`texSubImage3D` layers, so the flip happens in the converter for all three textures and
the shader samples with the mesh's own uv, exactly as the desktop viewer does.

## Layout

```
src/index.js                 package entry: Snap3dViewer and the pieces under it
src/browser.js               <script> entry: defines the global, attaches the statics
src/viewer.js                the class - context, loop, resize, dispose
src/controls.js              orbit / zoom / pan input, scoped to one element
src/renderer.js              program, atlas textures, mesh VAO
src/shaders.js               GLSL ES 3.00 port of pipeline/core/slf_shaders.py
src/orbit-camera.js          port of pipeline/core/orbit_camera.py
src/mat4.js                  column-major look_at / perspective
src/bundle.js                streaming loader for bundle.json + the two blobs
demo/index.html              canvas, HUD, loading overlay
demo/demo.js                 which bundle to open, HUD wiring - policy, not rendering
demo/bundles/<run_id>/       converted output (gitignored)
tools/export_web_bundle.py   bundle -> web assets (needs the pipeline importable)
tools/serve.py               static server with gzip; python -m http.server also works
tools/build.mjs              esbuild: the three dist/ outputs
pages/index.html             the Pages landing page
.github/workflows/pages.yml  build dist/ and deploy it on every push to main
```

## Keeping the shader port honest

`src/shaders.js` is the one place the pipeline's shared GLSL is retyped rather than
imported, and a drift there shows up as subtly wrong colours, not as an error. So every
bundle records `sha256(VERTEX_SHADER + RESOLVE_GLSL + EVAL_SH_GLSL)` of the pipeline
that built it, the port records the hash it was taken from, and the viewer prints a
warning panel when they disagree. If you see it: re-port
`pipeline/core/slf_shaders.py` and update `PIPELINE_GLSL_SHA256`.

The port itself differs from the Python source in exactly three places, each marked
`// PORT:` — `#version 300 es` with explicit precision qualifiers, and `v.z <= 0.0`
where GLSL ES will not compare a float against an int.

## Requirements

WebGL2, for 2D array textures (one layer per SH coefficient), 16-bit float textures, and
32-bit indices — 65k vertices overflow a 16-bit index buffer. That is every current
desktop and mobile browser; there is no WebGL1 fallback.

## Verified against the desktop viewer

The initial frame was rendered both ways at 1280×800 and diffed: 97.8% of pixels within
2/255, mean absolute difference 0.4/255, and the residual is confined to silhouette
edges — the browser draws with MSAA, the reference framebuffer does not. Geometry
round-trips bit-exactly; the JS camera reproduces the pose `config.json` ships to 6e-15.
