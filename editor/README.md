# snap3d editor

A page for whoever runs a storefront that embeds a snap3d bundle, to pick that bundle's
default camera pose without touching the pipeline: open a bundle, spin it, pan its pivot,
zoom, and write out a `config.json` that carries the new pose as the bundle's
`initial_camera` - drop it in over the bundle's own `config.json` and the storefront's
ordinary viewer opens on it from then on.

It renders through the exact same [`../dist/viewer.js`](../dist/viewer.js) any other
page here loads - this is a different page, not a different viewer.

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

| | |
|---|---|
| Drag | orbit |
| Wheel / pinch | zoom |
| `W` `A` `S` `D` or the arrows | pan the pivot - keeps spinning through this one |
| `Space` | play / pause the idle spin |
| `R` | reset to the bundle's own shipped pose (also pauses) |
| **Config 파일 만들기** | writes the current pose into a new `config.json`, shown in a dialog with **파일로 저장…** (the File System Access API, where the browser supports it - Chrome and Edge, over `http://localhost` or `https://`), **다운로드**, and **복사** as fallbacks |

The in-page **사용법** panel carries the same list, in Korean, for whoever is actually
running the tool.

## What "make config file" changes and what it leaves alone

Only `initial_camera` is regenerated - `target`, `radius`, `azimuth_deg`,
`elevation_deg` from the live `OrbitCamera`, plus `position` and `view_matrix`
precomputed the same way `pipeline/core/render_bundle.py` does, for a consumer that
skips the orbit math. `near`/`far` are re-derived from the *loaded* bundle's own
near/far-to-radius ratio applied to the new radius, rather than assumed defaults, so a
bundle built with non-default `near_scale`/`far_scale` keeps its own proportions.
`fov_deg` is carried over unchanged - there is no control for it here.

Everything else in the file - `up_vector`, `sh`, `texture_resolution`, `height`, and any
other top-level key a given bundle happens to carry - is copied through byte-for-byte
from whatever `config.json` the bundle loaded with. This page only ever writes a camera.
