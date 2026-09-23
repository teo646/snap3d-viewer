// Shared logic for every snap3d landing page - the flagship page at the site root and
// every industry pitch variant under it. Each page shows exactly one bundle, live and
// rotating, under a title and a tagline; nothing else. What differs between pages is
// just that tagline and which bundle - each page sets `window.SNAP3D_PAGE = { tagline,
// bundles }` in a tiny inline <script> before this one loads (see pages/index.html).
//
// The asset base (posters/, bundle/) is resolved from *this script's own* URL rather
// than a page-relative './' - a variant page lives one directory deeper
// (/clothes/index.html) than the assets it shares with every other page, and deriving
// the base from where app.js itself was loaded from means every page can ask for
// "../app.js" or "./app.js" and still resolve posters/bundle to the one shared copy at
// the site root, with nothing to keep in sync by hand.

(() => {
  const PAGE = window.SNAP3D_PAGE;
  if (!PAGE) throw new Error('app.js: window.SNAP3D_PAGE must be set before this script loads');

  const BASE = new URL('.', document.currentScript.src).href;

  // Transparent (the 4th, alpha component of the viewer's [r, g, b, a] `background`)
  // rather than matched to the page's own colour - #stage has no background of its
  // own either (see the page's CSS), so body's colour shows straight through the
  // canvas's empty pixels, right out to the edges the canvas now spans, and the
  // bundle reads as floating on that colour rather than boxed onto a white card.
  const STAGE_BACKGROUND = [1, 1, 1, 0];

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const progress = $('progress');
  const status = $('status');
  const canvas = $('canvas');

  $('tagline').textContent = PAGE.tagline;

  // The one bundle this page shows. ?bundle= can still point it at a different entry
  // in the page's own list without a picker in the UI - a plain link, not a control.
  const current =
    PAGE.bundles.find((b) => b.name === new URLSearchParams(location.search).get('bundle')) ?? PAGE.bundles[0];

  // The folder itself - what the library takes. `loadBundle` appends `/config.json` to
  // any URL that doesn't already end in `.json`, so the folder is everything it needs.
  const bundleDir = (name) => `${BASE}bundle/${name}.snap3d`;
  const posterUrl = (name) => `${BASE}posters/${name}.webp`;

  const fail = (error) => {
    progress.hidden = false;
    progress.classList.add('failed');
    status.textContent = String(error?.message ?? error);
    console.error(error);
  };

  /**
   * Centre and fill the stage with whatever the bundle drew.
   *
   * The pose in config.json is the one the pipeline picked for a 1280x800 window, and
   * this stage is neither that size nor that shape, so it tends to leave the surface
   * small and hugging one edge. Rather than hard-code an offset per bundle, read back
   * the frame, take the bounding box of everything that is not background, and pan and
   * zoom until it sits in the middle at a comfortable size. Two passes: the first is
   * approximate because zooming changes what is visible, the second settles it. Purely
   * presentational: the library still opens the bundle on its shipped pose, and this is
   * also the framing the poster was captured at.
   */
  function fitToView(v, fill = 0.86) {
    const gl = v.gl;
    const { width, height } = v.canvas;
    if (!width || !height) return;
    const pixels = new Uint8Array(width * height * 4);

    for (let pass = 0; pass < 2; pass++) {
      v.renderFrame();
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // The background is pure white (255,255,255); anything meaningfully darker or
      // more saturated than that is surface.
      let minX = width, maxX = -1, minY = height, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          if (Math.max(r, g, b) - Math.min(r, g, b) > 12 || Math.min(r, g, b) < 210) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return; // nothing drawn - leave the shipped pose alone

      // readPixels is bottom-up, which is also the sign convention of `up` below.
      const offsetX = (minX + maxX) / 2 / width - 0.5;
      const offsetY = (minY + maxY) / 2 / height - 0.5;
      const halfHeight = v.camera.radius * Math.tan((v.config.initial_camera.fov_deg * Math.PI) / 360);
      const halfWidth = halfHeight * (width / height);

      const [right, up] = v.camera.forwardAxes;
      const target = v.camera.origin.map(
        (c, i) => c + 2 * offsetX * halfWidth * right[i] + 2 * offsetY * halfHeight * up[i],
      );
      const occupancy = Math.max((maxX - minX) / width, (maxY - minY) / height);
      v.setCamera({ target, radius: v.camera.radius * (occupancy / fill) });
    }
  }

  function settle() {
    fitToView(viewer);
    // R should return to what the visitor first saw, not to the pose the fit moved
    // away from - here, that is also the frame the poster shows.
    viewer.setHome();
    progress.hidden = true;
    stage.classList.add('live');
  }

  function onReadyFailed() {} // onError already reported it; this only stops the rejection

  const viewer = new Snap3dViewer(canvas, bundleDir(current.name), {
    background: STAGE_BACKGROUND,
    poster: posterUrl(current.name),
    onProgress: (loaded, total) => {
      $('bar').firstElementChild.style.width = `${(loaded / total) * 100}%`;
      status.textContent =
        loaded < total
          ? `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
          : 'decompressing…';
    },
    onError: fail,
  });
  window.viewer = viewer; // a console handle, and what the smoke test drives
  viewer.ready.then(settle, onReadyFailed);
})();
