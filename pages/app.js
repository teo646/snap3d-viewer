// Shared logic for every snap3d landing page - the flagship page at the site root and
// every industry pitch variant under it. What differs between them is content, not
// mechanics: each page sets `window.SNAP3D_PAGE = { tagline, about, bundles }` in a tiny
// inline <script> before this one loads (see pages/index.html), and everything below
// reads that instead of a hardcoded constant.
//
// Asset paths (posters/, bundle/, inputs/) are resolved from *this script's own* URL
// rather than a page-relative './' - a variant page lives one directory deeper
// (/clothes/index.html) than the assets it shares with every other page, and deriving
// the base from where app.js itself was loaded from means every page can ask for
// "../app.js" or "./app.js" and still resolve posters/bundle/inputs to the one shared
// copy at the site root, with nothing to keep in sync by hand.

(() => {
  const PAGE = window.SNAP3D_PAGE;
  if (!PAGE) throw new Error('app.js: window.SNAP3D_PAGE must be set before this script loads');

  const BASE = new URL('.', document.currentScript.src).href;
  const BUNDLES = PAGE.bundles;

  // The viewer's `background` option is [r, g, b] in 0-1, WebGL's own convention -
  // pure white, the same white the page itself sits on, so the live render's clear
  // colour disappears into the page rather than marking where the stage begins.
  const STAGE_BACKGROUND = [1, 1, 1];

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const progress = $('progress');
  const status = $('status');
  const canvas = $('canvas');
  const subjectSelect = $('subject');

  $('tagline').textContent = PAGE.tagline;
  $('about').innerHTML = PAGE.about;

  // The folder itself - what the library takes and what the bundle link points at.
  // `loadBundle` appends `/config.json` to any URL that doesn't already end in
  // `.json`, so the folder is also everything a caller needs to pass in.
  const bundleDir = (name) => `${BASE}bundle/${name}.snap3d`;
  // The raw config, for the two places on this page that read it themselves rather
  // than handing the URL to the library.
  const configUrl = (name) => `${bundleDir(name)}/config.json`;
  const posterUrl = (name) => `${BASE}posters/${name}.webp`;
  const inputsUrl = (name) => `${BASE}inputs/${name}.webp`;

  // Coloured the same way the rest of the page's code is - by hand, so a highlighter
  // library is not the cost of a few lines of markup.
  const embedSnippet = (name) => `<span class="punct">&lt;</span><span class="t">script</span> <span class="a">src</span><span class="punct">=</span><span class="s">"https://teo646.github.io/snap3d-viewer/dist/viewer.js"</span><span class="punct">&gt;&lt;/</span><span class="t">script</span><span class="punct">&gt;</span>
<span class="punct">&lt;</span><span class="t">script</span><span class="punct">&gt;</span>
  <span class="k">new</span> Snap3dViewer<span class="punct">(</span>viewer<span class="punct">,</span> <span class="s">'${name}.snap3d'</span><span class="punct">);</span>
<span class="punct">&lt;/</span><span class="t">script</span><span class="punct">&gt;</span>`;

  let current = BUNDLES.find((b) => b.name === new URLSearchParams(location.search).get('bundle')) ?? BUNDLES[0];
  let viewer = null;
  let prefetching = null; // AbortController for the background fetches, if any

  const fail = (error) => {
    progress.hidden = false;
    progress.classList.add('failed');
    status.textContent = String(error?.message ?? error);
    console.error(error);
  };

  const renderEmbed = () => {
    $('embed-code').innerHTML = embedSnippet(current.name);
  };

  /**
   * Centre and fill the stage with whatever the bundle drew.
   *
   * The pose in config.json is the one the pipeline picked for a 1280x800 window, and
   * this stage is neither that size nor that shape, so it tends to leave the surface
   * small and hugging one edge. Rather than hard-code an offset per bundle - there are
   * three here, with different up vectors and extents - read back the frame, take the
   * bounding box of everything that is not background, and pan and zoom until it sits
   * in the middle at a comfortable size. Two passes: the first is approximate because
   * zooming changes what is visible, the second settles it. Purely presentational: the
   * library still opens every bundle on its shipped pose, and this is also the framing
   * the posters were captured at.
   */
  function fitToView(v, fill = 0.86) {
    const gl = v.gl;
    const { width, height } = v.canvas;
    if (!width || !height) return;
    const pixels = new Uint8Array(width * height * 4);

    for (let pass = 0; pass < 2; pass++) {
      v.renderFrame();
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // The background is now pure white (255,255,255); anything meaningfully darker
      // or more saturated than that is surface. (Was "brighter than a dark
      // background" before the page flipped to a light one - same idea, flipped.)
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

  /**
   * Pull the other bundles into the HTTP cache, one at a time, after the one on screen
   * is drawn. Switching subject then costs a decode rather than a download.
   *
   * Sequential and low priority on purpose: parallel 12 MB streams would fight the
   * bundle the visitor is actually waiting for. Skipped entirely when the browser says
   * the connection is metered or slow - that much speculation is a rude thing to put
   * on someone's data plan for a subject they may never click.
   */
  async function prefetchOthers() {
    const link = navigator.connection;
    if (link?.saveData || /(^|-)2g$/.test(link?.effectiveType ?? '')) return;

    prefetching?.abort();
    const controller = (prefetching = new AbortController());
    for (const bundle of BUNDLES) {
      if (bundle.name === current.name) continue;
      const url = configUrl(bundle.name);
      try {
        const config = await fetch(url, { signal: controller.signal }).then((r) => r.json());
        const base = url.slice(0, url.lastIndexOf('/'));
        for (const key of ['mesh', 'sh', 'height']) {
          // Read the body to completion: a response left unread is not cached.
          await fetch(`${base}/${config.files[key]}`, { signal: controller.signal, priority: 'low' })
            .then((r) => r.arrayBuffer());
        }
      } catch {
        if (controller.signal.aborted) return; // a click won; it will restart after
      }
    }
  }

  function settle() {
    fitToView(viewer);
    // R should return to what the visitor first saw, not to the pose the fit moved
    // away from - here, that is also the frame the poster shows.
    viewer.setHome();
    progress.hidden = true;
    stage.classList.add('live');
    prefetchOthers();
  }

  function onReadyFailed() {} // onError already reported it; this only stops the rejection

  function render() {
    progress.classList.remove('failed');
    progress.hidden = false;
    status.textContent = 'loading…';
    try {
      // Both calls below pass the bundle's folder, not its config.json - the library
      // resolves that itself, exactly as the embed snippet above demonstrates.
      if (viewer) {
        viewer.load(bundleDir(current.name), { poster: posterUrl(current.name) }).then(settle, onReadyFailed);
        return;
      }
      viewer = new Snap3dViewer(canvas, bundleDir(current.name), {
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
    } catch (error) {
      fail(error);
    }
  }

  /** Re-point every part of the page at one subject: what went in, the bundle it
   *  became, the line that embeds it, and the render it produces. */
  function select(bundle) {
    if (bundle.name === current.name && viewer) return;
    current = bundle;
    // Anything speculative loses to what the visitor just asked for.
    prefetching?.abort();
    subjectSelect.value = bundle.name;

    $('inputs').src = inputsUrl(bundle.name);
    $('inputs').alt = `Eight of the ${bundle.images} images the ${bundle.label} was fit from`;
    $('capture').textContent = bundle.images;
    renderEmbed();

    stage.classList.remove('live');
    render();
  }

  for (const bundle of BUNDLES) subjectSelect.appendChild(new Option(bundle.label, bundle.name));
  subjectSelect.addEventListener('change', () => {
    select(BUNDLES.find((b) => b.name === subjectSelect.value));
  });
  select(current);
})();
