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
  const viewer = new Snap3dViewer(canvas, 'bundles/my_run/config.json');
</script>
```

That is the whole integration. Drag to orbit, wheel to zoom, WASD or the arrows to pan,
`R` to reset. As a module instead:

```js
import { Snap3dViewer } from 'https://teo646.github.io/snap3d-viewer/dist/viewer.mjs';

const viewer = new Snap3dViewer(canvas, 'bundles/my_run/config.json');
await viewer.ready;
```

The second argument is the bundle's `config.json`, or the directory holding it; the
GLB and the two KTX2 textures are fetched from alongside it either way. **There is no
conversion step** - this is the pipeline's export stage directory, copied or served as
it stands.

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

## The bundle

Four files, written by the pipeline's export stage, in formats a browser already reads:

```
config.json   up_vector, sh{degree, coefficients}, texture_resolution,
              height{range, num_steps}, initial_camera
mesh.glb      POSITION (V,3) f32, TEXCOORD_0 (V,2) f32, indices (F,3) u32
sh.ktx2       RGBA16F array, one layer per SH coefficient; a is padding
height.ktx2   RG16F; r = displacement, g = 1 inside the atlas coverage
```

Copy an export stage dir into `demo/bundles/<name>/` and serve it:

```
python tools/serve.py                               # http://127.0.0.1:8000/demo/
```

`?bundle=<name>` picks one when several are present; an optional
`demo/bundles/index.json` (`{"bundles": ["a", "b"]}`) populates the picker.

Four bundles are committed rather than ignored, because the published landing page
renders them live and CI has to be able to publish what it did not build. They are
~12 MB each; a fifth belongs in `demo/bundles/` and stays out of git unless the gallery
grows to include it.

## Building and publishing

```
npm ci
npm run build      # dist/viewer.js (script tag), .mjs (ESM), .cjs (CommonJS)
npm run check      # bundles every entry without writing anything
```

`dist/` is gitignored. `.github/workflows/pages.yml` rebuilds it on every push to `main`
and publishes it to GitHub Pages together with the landing page, its posters and the
four bundles, so the URL in the Quick Start is always the build that matches `main` and
no one ever hand-edits a build artifact. The page itself loads that same
`dist/viewer.js`, so a broken build is visible on the front page rather than only in a
consumer's console.

Each subject on the landing page is introduced by five of the images it was fit from,
so what went in and what came out sit one above the other. `tools/make_input_stacks.py`
rebuilds those from the runs' ingest stages.

The landing page renders the first subject on arrival, over its own still so there is
something to look at while the 12 MB arrives, and then pulls the other three into the
HTTP cache one at a time behind it — sequential and low priority, so speculation never
competes with the bundle the visitor is waiting for, and skipped entirely when the
browser reports a metered or slow connection. Measured at 25 Mbit/s: first frame at
4.4 s, the second bundle's first request at 4.3 s *after* that, and switching subject
then costs a decode rather than a download. The stills are captured from the page
itself, so the live render replaces them at the same framing. Enabling Pages is a one-time manual step: **Settings → Pages → Source: GitHub
Actions**.

The version is declared in both `package.json` and `src/index.js`; the build fails if
they disagree, so drift becomes a red CI run rather than a wrong number in a bug report.

## What the loader has to get exactly right

The bundle is written in glTF's and KTX2's own conventions, not this repo's, so a
consumer that just follows those formats is correct with no special-casing. This viewer
reuses the pipeline's v-up shader verbatim, so it converts on the way in - the same two
conversions `view_bundle.py` makes:

**`v <- 1 - v` on TEXCOORD_0.** glTF puts the UV origin at the image's top-left.

**The texture rows are flipped.** KTX2 stores row 0 first; GL's texture origin is
bottom-left. `UNPACK_FLIP_Y_WEBGL` does not apply to `texSubImage3D` layers, so both
textures are flipped in `bundle.js` rather than by the driver.

**The per-vertex frame is recomputed.** The bundle ships positions, UVs and indices and
nothing else, because normals and tangents are pure functions of those three. The catch
is that they must be reproduced *exactly*: a different frame resolves a different uv,
which reads a different texel, which is subtly wrong colours everywhere rather than an
error. So `src/frame.js` is a port of two named functions -
`uv_geometry.vertex_normals_for` and `compute_vertex_tangents` - and is checked
numerically against their output, not against plausibility. Two things there are easy
to get wrong and cost nothing to get right:

* Normals are **angle-weighted**, not area-weighted. The two differ by up to a full
  radian on a real mesh.
* Tangents are **not normalized**. Their length is world units per UV unit, which is
  what `xy_per_height` converts a world step into a texel step with.

**Textures are float16 and stay that way.** `RGBA16F` and `RG16F` are filterable in core
WebGL2, so the file's bytes go to `texSubImage` untouched - no widening, no
`OES_texture_float_linear`.

**The supercompression is ZLIB, and that is a delivery decision.** KTX2 allows
Zstandard, which compresses ~10% better, but no browser exposes a zstd decoder:
`DecompressionStream('zstd')` is absent from Chrome 129 and from every Firefox and
Safari, so zstd would mean bundling a JS decoder and inflating ~38 MB in JS before the
first frame. ZLIB scheme 3 is an RFC 1950 datastream, which is exactly what
`DecompressionStream('deflate')` takes, natively, everywhere. The trade is 1 MB of
download for zero dependencies.

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
src/bundle.js                fetches the four files, applies the two flips
src/glb.js                   geometry-only glTF Binary reader
src/ktx2.js                  KTX2 reader; inflates via DecompressionStream
src/frame.js                 per-vertex normals and raw tangents, ported exactly
demo/index.html              canvas, HUD, loading overlay
demo/demo.js                 which bundle to open, HUD wiring - policy, not rendering
demo/bundles/<run_id>/       an export stage dir, copied in (gitignored)
tools/serve.py               static server with gzip; python -m http.server also works
tools/build.mjs              esbuild: the three dist/ outputs
pages/index.html             the Pages landing page: posters, gallery, live viewer
pages/posters/               one still per bundle, plus a thumbnail for the gallery
pages/inputs/                the photo stack showing what each bundle was fit from
tools/make_input_stacks.py   rebuilds pages/inputs/ from a run's ingest images
.github/workflows/pages.yml  build dist/ and deploy it on every push to main
```

## Keeping the shader port honest

`src/shaders.js` is the one place the pipeline's shared GLSL is retyped rather than
imported, and a drift there shows up as subtly wrong colours, not as an error. So every
port records `sha256(VERTEX_SHADER + RESOLVE_GLSL + EVAL_SH_GLSL)` of the pipeline it
was taken from, and the viewer compares it against a `glsl_sha256` in `config.json` and
prints a warning panel when they disagree. **The export format does not currently write
that field**, so the check is dormant; if the pipeline starts recording it, drift stops
being something anyone has to notice by eye. If you do see the warning: re-port
`pipeline/core/slf_shaders.py` and update `PIPELINE_GLSL_SHA256`.

The port itself differs from the Python source in exactly three places, each marked
`// PORT:` — `#version 300 es` with explicit precision qualifiers, and `v.z <= 0.0`
where GLSL ES will not compare a float against an int.

## Requirements

WebGL2, for 2D array textures (one layer per SH coefficient), 16-bit float textures and
32-bit indices — the GLB writes `UNSIGNED_INT` unconditionally, and a decimated mesh
is not bounded by 65,536 vertices — plus
`DecompressionStream`, for the textures' ZLIB supercompression. In practice that means
Chrome 80+, Firefox 113+ or Safari 16.4+. There is no WebGL1 fallback.

## Verified against the desktop viewer

The initial frame was rendered both ways at 1280×800 and diffed: 97.8% of pixels within
2/255 and a mean absolute difference of 0.3/255, which is the float16 atlas — the
reference widens it to float32 on upload, the browser samples the halves directly. The
0.31% beyond 24/255 are silhouette edges, where the browser draws with MSAA and the
reference framebuffer does not.

The frame `src/frame.js` computes was diffed against `vertex_frame_attributes` over all
65,198 vertices: normals are bit-identical once rounded to float32, and the raw tangents
agree to 3e-7 relative, which is float32 epsilon on an accumulation. The JS camera
reproduces the pose `config.json` ships to 6e-15.
