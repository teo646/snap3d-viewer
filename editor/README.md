# snap3d editor

A minimal page (`index.html`, no separate script) that loads a bundle into
[`Snap3dViewerEditor`](../src/viewer-editor.js) and lets whoever runs a storefront pick
its default camera pose and its rotation axis without touching the pipeline - drag,
zoom, pan, place the turntable with I/J/K/L, and write out a `config.json` that carries
it all as the bundle's `initial_camera` and `rotation` - drop it in over the bundle's
own `config.json` and the storefront's ordinary viewer (`dist/viewer.js`) opens on it
from then on.

Everything the operator actually sees - the readout, the transport, the axis overlay,
the "Config 파일 만들기" dialog - is `Snap3dViewerEditor`'s own shadow-DOM UI, the same
UI a storefront's own page gets by swapping `dist/viewer.js` for `dist/viewer_editor.js`
(see the root README). This page adds nothing but a bundle-URL bar above the canvas; it
is not a second, separately maintained editing surface.

## Running it

```
cd snap3d-viewer
python3 -m http.server 8080   # any static server; file:// can't fetch a bundle
```

Then open `http://localhost:8080/editor/?bundle=<path-or-url-to-a-.snap3d-folder>`, or
leave the query off and paste the path into the field at the top. The last bundle
opened is remembered (`localStorage`) and reflected in the URL, so the page is
bookmarkable per bundle.

## Controls

See the class's own **?** button once a bundle is loaded, or
[`src/viewer-editor.js`](../src/viewer-editor.js)'s help-dialog markup directly. In
short: drag/wheel/WASD move the camera, I/J/K/L move the rotation axis without moving
anything else, Space plays/pauses the idle spin, R resets, and **Config 파일 만들기**
writes `initial_camera` and `rotation` into a new `config.json` - every other field of
the loaded bundle passes through unchanged.
