// Snap3dViewer - the whole library behind one class.
//
//   const viewer = new Snap3dViewer(canvas, './bundles/my_run.snap3d');
//   await viewer.ready;
//
// It owns a WebGL2 context on `canvas`, loads a snap3d bundle (config.json + a GLB +
// two KTX2 textures, in a `<run_id>.snap3d` folder) and renders it exactly as
// viewers/view_bundle.py does.
//
// The loop is demand-driven by default. The desktop original spins at a fixed 60 Hz
// because it owns the machine; a viewer embedded in someone's page does not, and a
// still frame costs the same to hold as to leave alone. So rAF runs only while
// something is actually changing - a drag, a held key, a resize, an explicit
// requestRender() - and stops when the image settles. Pass `render: 'always'` for a
// continuously-clocked loop (benchmarks, video capture).

import { loadBundle } from './bundle.js';
import { multiply, normalize, perspective, rotatePointAbout } from './mat4.js';
import { OrbitCamera } from './orbit-camera.js';
import { OrbitControls } from './controls.js';
import { createRenderer } from './renderer.js';

export const VIEWER_DEFAULTS = {
  background: [0.05, 0.05, 0.06], // view_bundle.py's BACKGROUND; a 4th alpha component
                                   // (default 1) lets the page behind the canvas show
                                   // through instead - the canvas's own WebGL context
                                   // already carries an alpha channel, so [r, g, b, 0]
                                   // is all a fully transparent stage takes.
  controls: true,      // false, or an options object forwarded to OrbitControls
  render: 'demand',    // 'demand' | 'always'
  autoStart: true,
  maxPixelRatio: 2,    // 3x on a phone is all cost and no visible gain
  antialias: true,
  fov: null,           // degrees; null takes the bundle's initial_camera.fov_deg
  contextAttributes: null,
  poster: null,         // image URL to show over the canvas until the first frame draws
  autoRotate: true,     // slow idle spin, until the visitor drags/zooms/pans it themselves
  autoRotateSpeed: 16,   // degrees per second
  onProgress: null,    // (loadedBytes, totalBytes)
  onReady: null,       // (viewer)
  onError: null,       // (error)
  onWarning: null,     // (message)
  onFrame: null,       // ({fps, dt})
};

const WEBGL2_MISSING =
  'WebGL2 is unavailable in this browser. The viewer needs it for 2D array textures, ' +
  '16-bit float textures, and 32-bit indices.';

export class Snap3dViewer {
  /**
   * @param {HTMLCanvasElement|string} canvas  element, or a selector for one
   * @param {string} url  the bundle's `config.json`, or the `.snap3d` folder holding it
   * @param {object} [options]  see VIEWER_DEFAULTS
   */
  constructor(canvas, url, options = {}) {
    this.canvas = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    if (!this.canvas) throw new Error(`Snap3dViewer: no canvas matching ${canvas}`);
    this.url = String(url).replace(/\/+$/, '');
    this.options = { ...VIEWER_DEFAULTS, ...options };

    this.config = null;
    this.stats = null;
    this.camera = null;
    this.controls = null;
    this.warnings = [];
    /** The turntable the idle spin turns the *object* on: `{center, axis}`, taken
     *  from the bundle's own `rotation` block. Mutable - an editor can move the
     *  centre and the next frame spins around the new one. */
    this.rotation = null;
    /** Degrees the view has turned about {@link Snap3dViewer#rotation} so far, for
     *  anyone who wants to read it back. `spinBy()` is what moves it. */
    this.spin = 0;

    this._renderer = null;
    this._home = null;
    this._raf = 0;
    this._dirty = true;
    this._running = this.options.autoStart;
    this._disposed = false;
    this._loadSeq = 0; // bumped on every _load() so an overlapping one can tell it lost
    this._last = 0;
    this._frames = 0;
    this._fpsAt = 0;
    this._autoRotating = false;
    this._frame = this._frame.bind(this);

    this.gl = this.canvas.getContext('webgl2', {
      antialias: this.options.antialias,
      depth: true,
      ...(this.options.contextAttributes ?? {}),
    });
    if (!this.gl) throw new Error(WEBGL2_MISSING);

    this._bindContextEvents();
    this._observeSize();

    this._posterHost = null;
    this._posterEl = null;
    this._posterPendingHide = false;
    if (this.options.poster) this._showPoster(this.options.poster);

    /** Resolves with this viewer once the bundle is on the GPU. */
    this.ready = this._load().catch((error) => {
      this.options.onError?.(error);
      throw error;
    });
  }

  get isReady() {
    return this._renderer !== null;
  }

  /** Bytes of GPU atlas this bundle occupies - the number that decides mobile fit.
   *  RGBA16F (or RGBA8, for unorm8 storage) per coefficient, plus one RG16F relief texture. */
  get textureBytes() {
    if (!this.config) return 0;
    const [w, h] = this.config.texture_resolution;
    const shBytesPerSample = this.config.sh.storage === 'unorm8' ? 1 : 2;
    return w * h * (shBytesPerSample * 4 * this.config.sh.coefficients + 2 * 2);
  }

  /** Draw when the loop is idle. Cheap and idempotent within one frame. */
  requestRender() {
    this._dirty = true;
    this._schedule();
  }

  start() {
    this._running = true;
    this.requestRender();
    return this;
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  }

  /**
   * Swap in a different bundle, keeping the context, the canvas and the loop.
   *
   * Tearing the viewer down and building a new one would be the obvious way, but
   * `dispose()` drops the WebGL context and a canvas whose context has been lost hands
   * back the same lost context on the next `getContext`. So the renderer is rebuilt
   * and the camera re-derived from the new bundle - a different `up_vector` and a
   * different opening pose are exactly what a second bundle brings.
   *
   * @param {object} [options]  currently just `poster`, shown again for the new bundle
   * @returns {Promise<Snap3dViewer>} the same promise shape as `ready`
   */
  load(url, options = {}) {
    this.url = String(url).replace(/\/+$/, '');
    if ('poster' in options) this.options.poster = options.poster;
    if (this.options.poster) this._showPoster(this.options.poster);
    this._renderer?.dispose();
    this._renderer = null;
    this.controls?.dispose();
    this.controls = null;
    this.camera = null;
    this.config = null;
    this.stats = null;
    this.warnings = [];
    this._home = null;
    this.ready = this._load().catch((error) => {
      this.options.onError?.(error);
      throw error;
    });
    return this.ready;
  }

  /** Draw one frame synchronously, outside the loop. */
  renderFrame() {
    if (this._renderer) this._draw();
    return this;
  }

  /** Apply any subset of {azimuth, elevation, radius, target}. */
  setCamera(pose) {
    if (this.controls) {
      this.controls.setCamera(pose); // goes through the same clamps a drag does
    } else if (this.camera) {
      if (pose.azimuth !== undefined) this.camera.azimuth = pose.azimuth;
      if (pose.elevation !== undefined) this.camera.elevation = pose.elevation;
      if (pose.radius !== undefined) this.camera.radius = pose.radius;
      if (pose.target !== undefined) this.camera.origin = [...pose.target];
    }
    this.requestRender();
    return this;
  }

  /** The pose `resetCamera()` and the R key return to. Starts as the one the bundle
   *  ships in `config.initial_camera`; `setHome` moves it. */
  get home() {
    const pose = this.controls ? this.controls.home : this._home;
    return pose && { ...pose, target: [...pose.target] };
  }

  /**
   * Make `pose` - by default wherever the camera is now - the pose to return to.
   * A page that reframes the shot on load wants R to come back to what the visitor
   * first saw, not to a pose they never had.
   */
  setHome(pose = null) {
    const next = pose ?? (this.camera && {
      azimuth: this.camera.azimuth,
      elevation: this.camera.elevation,
      radius: this.camera.radius,
      target: [...this.camera.origin],
    });
    if (!next) return this;
    const home = { ...next, target: [...next.target] };
    if (this.controls) this.controls.home = home;
    this._home = home;
    return this;
  }

  /** Back to the home pose, spin included (R in the desktop viewer). */
  resetCamera() {
    const { home } = this;
    this.spin = 0;
    if (home) this.setCamera(home);
    return this;
  }

  /**
   * Turn the view `degrees` further around {@link Snap3dViewer#rotation} - the
   * turntable step the idle spin takes, and the only thing that ever drives it.
   *
   * The object is never transformed. The camera is swung around the axis instead,
   * which renders the same image (all that matters is the camera's pose *relative*
   * to the object) and has two properties turning the object itself does not:
   * rotating about a line maps that line onto itself, so the axis sits at exactly
   * the same screen pixels frame after frame; and because nothing about the object's
   * placement depends on where the axis is, moving the axis mid-spin leaves the
   * picture untouched - it only changes what the *next* step turns around.
   */
  spinBy(degrees) {
    if (!this.camera || !this.rotation || !degrees) return this;
    const { center, axis } = this.rotation;
    // The camera goes the opposite way round, so the object reads as turning by
    // +degrees right-handed about `axis`.
    const angle = (-degrees * Math.PI) / 180;
    this.camera.setPose(
      rotatePointAbout(this.camera.position, center, axis, angle),
      rotatePointAbout(this.camera.origin, center, axis, angle),
    );
    this.spin = (this.spin + degrees) % 360;
    this.requestRender();
    return this;
  }

  /** Give the canvas keyboard focus, so WASD/R work without a click first. */
  focus() {
    this.canvas.focus?.({ preventScroll: true });
    return this;
  }

  /** A PNG data URL of the current view, drawn fresh so it works without
   *  preserveDrawingBuffer. */
  snapshot(type = 'image/png', quality) {
    this.renderFrame();
    return this.canvas.toDataURL(type, quality);
  }

  /** Match the drawing buffer to the canvas's CSS size. Called automatically. */
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, this.options.maxPixelRatio);
    const width = Math.max(1, Math.round((this.canvas.clientWidth || this.canvas.width) * dpr));
    const height = Math.max(1, Math.round((this.canvas.clientHeight || this.canvas.height) * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.requestRender();
    return true;
  }

  /** Release the GL objects, the listeners, and the loop. The instance is dead after. */
  dispose() {
    this._disposed = true;
    this.stop();
    this.controls?.dispose();
    this._resizeObserver?.disconnect();
    this._posterEl?.remove();
    for (const off of this._unbind ?? []) off();
    this._unbind = [];
    this._renderer?.dispose();
    this._renderer = null;
    // Frees the atlas immediately rather than at the GC's convenience, which matters
    // on a phone where the next route may want the same ~38 MB.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // -- internals ------------------------------------------------------------------

  async _load() {
    // load() can be called again before a prior _load() finishes (a page swapping
    // bundles fast, or a doubled keystroke on an input with no in-flight guard of its
    // own) - whichever call's fetch resolves last would otherwise win regardless of
    // which bundle is actually wanted, and the loser's renderer would leak with
    // nothing left holding a reference to dispose it. The loser bails here, before
    // touching any shared state or allocating GPU resources.
    const seq = ++this._loadSeq;
    const bundle = await loadBundle(this.url, (loaded, total) => this.options.onProgress?.(loaded, total));
    if (this._disposed || seq !== this._loadSeq) return this;

    this.config = bundle.config;
    this.stats = bundle.stats;
    this._renderer = createRenderer(this.gl, bundle);
    this.warnings = this._renderer.warnings;
    for (const warning of this.warnings) this._warn(warning);

    const initial = this.config.initial_camera;
    // The bundle's own turntable, kept apart from the camera on purpose: `center` is
    // what the object turns around, `initial_camera.target` is only what the opening
    // shot is framed on, and the two are free to differ. A bundle written before the
    // `rotation` block existed falls back to the pair that used to carry both jobs.
    const rotation = this.config.rotation;
    this.rotation = {
      center: [...(rotation?.center ?? initial.target)],
      axis: normalize(rotation?.axis ?? this.config.up_vector),
    };
    this.spin = 0;
    this._home = {
      azimuth: initial.azimuth_deg,
      elevation: initial.elevation_deg,
      radius: initial.radius,
      target: [...initial.target],
    };
    if (!this.camera) {
      this.camera = new OrbitCamera(initial.target, initial.radius, this.config.up_vector);
      this.camera.azimuth = initial.azimuth_deg;
      this.camera.elevation = initial.elevation_deg;
      this._autoRotating = this.options.autoRotate;
      if (this.options.controls) {
        this.controls = new OrbitControls(this.canvas, this.camera, {
          ...(this.options.controls === true ? {} : this.options.controls),
          onChange: () => this.requestRender(),
          onInteract: () => { this._autoRotating = false; },
        });
      }
    }

    this.gl.enable(this.gl.DEPTH_TEST);
    this.resize();
    this.requestRender();
    this.options.onReady?.(this);
    return this;
  }

  _warn(message) {
    if (this.options.onWarning) this.options.onWarning(message);
    else console.warn(`Snap3dViewer: ${message}`);
  }

  _schedule() {
    if (this._raf || !this._running || this._disposed || !this._renderer) return;
    this._raf = requestAnimationFrame(this._frame);
  }

  _frame(now) {
    this._raf = 0;
    // _schedule() refuses to schedule without a renderer, but a frame already
    // in flight when load() synchronously nulls it (config/camera go with it) still
    // fires - config/camera come back together with it in _load(), so this one check
    // covers all three.
    if (this._disposed || !this._renderer) return;
    const dt = this._last ? Math.min((now - this._last) / 1000, 0.1) : 0;
    this._last = now;

    // Held keys advance the pan; anything they move marks the frame dirty via onChange.
    this.controls?.update(dt);

    // Idle spin, until OrbitControls' onInteract cuts it off for good on the first
    // real drag/zoom/pan - see the wiring in _load(). It swings the camera around the
    // bundle's own turntable (`config.rotation`), which is not the same thing as the
    // azimuth a drag moves: azimuth circles whatever the camera is *aimed* at, and
    // the point an object should turn about is rarely that.
    if (this._autoRotating) {
      this.spinBy(this.options.autoRotateSpeed * dt);
      this._dirty = true;
    }

    if (this._dirty || this.options.render === 'always') {
      this._dirty = false;
      this._draw();
      this._reportFps(now, dt);
    }
    // Keep clocking while an input is live or the idle spin is running, so the next
    // pointermove (or rotate step) has a fresh dt.
    if (this._dirty || this.options.render === 'always' || this.controls?.active || this._autoRotating) {
      this._schedule();
    } else {
      this._last = 0; // idle: the next frame's dt starts from that frame, not from now
    }
  }

  _draw() {
    const { gl, canvas, camera, config } = this;
    const [r, g, b, a = 1] = this.options.background;
    gl.viewport(0, 0, canvas.width, canvas.height);
    // The default WebGL context is premultipliedAlpha:true, which means the browser
    // reads whatever's stored here as already multiplied by its own alpha - clearing
    // to un-premultiplied [1,1,1,0] stores a literal (1,1,1,0), and compositors are
    // free to treat that white-at-zero-alpha as opaque white rather than transparent.
    // Premultiplying it here is what makes alpha 0 reliably transparent.
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // near/far track the orbit radius, exactly as view_bundle.py sets them each frame.
    const projection = perspective(
      this.options.fov ?? config.initial_camera.fov_deg,
      canvas.width / canvas.height,
      camera.radius * 0.02,
      camera.radius * 20,
    );
    this._renderer.draw(multiply(projection, camera.viewMatrix()), camera.position);

    // Wait for an actual frame rather than hiding the poster the instant loading
    // finishes - hiding it in `_load()` would uncover one blank cleared frame before
    // the first real draw ever lands.
    if (this._posterPendingHide) {
      this._posterPendingHide = false;
      this._hidePoster();
    }
  }

  /** Show `url` over the canvas, creating the overlay the first time it's needed. */
  _showPoster(url) {
    if (!this._posterEl) {
      const host = this._ensurePosterHost();
      const img = document.createElement('img');
      img.alt = '';
      img.style.cssText =
        'position:absolute; inset:0; width:100%; height:100%; object-fit:cover; ' +
        'pointer-events:none; transition:opacity 0.4s ease;';
      host.appendChild(img);
      this._posterEl = img;
    }
    this._posterEl.src = url;
    this._posterEl.style.opacity = '1';
    this._posterEl.style.display = '';
    this._posterPendingHide = true;
  }

  _hidePoster() {
    const img = this._posterEl;
    if (!img) return;
    img.style.opacity = '0';
  }

  /**
   * The poster is a sibling `<img>`, not something drawn into the canvas - the canvas
   * already has a WebGL context, and a 2D context can't share it. Absolute positioning
   * needs a positioned ancestor: reuse the canvas's parent if it already is one (a page
   * that built its own stage div, as this library's own demo does), otherwise wrap the
   * canvas in a plain relative div so a bare `<canvas>` dropped into the page still
   * gets a poster that lines up with it.
   */
  _ensurePosterHost() {
    if (this._posterHost) return this._posterHost;
    const parent = this.canvas.parentNode;
    const positioned = ['relative', 'absolute', 'fixed', 'sticky'].includes(
      parent && getComputedStyle(parent).position,
    );
    if (positioned) {
      this._posterHost = parent;
    } else {
      const host = document.createElement('div');
      host.style.cssText = 'position:relative;';
      parent.insertBefore(host, this.canvas);
      host.appendChild(this.canvas);
      this._posterHost = host;
    }
    return this._posterHost;
  }

  _reportFps(now, dt) {
    if (!this.options.onFrame) return;
    this._frames++;
    if (now - this._fpsAt < 500) return;
    this.options.onFrame({ fps: (this._frames * 1000) / (now - this._fpsAt), dt });
    this._frames = 0;
    this._fpsAt = now;
  }

  _observeSize() {
    // ResizeObserver, not window.resize: an embedded canvas changes size when its
    // container does, with no window event to hear about it.
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => this.resize();
      addEventListener('resize', onResize);
      this._unbind = [...(this._unbind ?? []), () => removeEventListener('resize', onResize)];
      return;
    }
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.canvas);
  }

  _bindContextEvents() {
    this._unbind = this._unbind ?? [];
    const onLost = (event) => {
      event.preventDefault(); // without this the context is gone for good
      this.stop();
      this._renderer = null;
      this._warn('WebGL context lost; reloading the bundle when it comes back.');
    };
    const onRestored = () => {
      // The blobs come back out of the HTTP cache, so this costs a decode, not a
      // download - and it keeps the ~40 MB of typed arrays out of memory meanwhile.
      this._running = this.options.autoStart;
      this._load().catch((error) => this.options.onError?.(error));
    };
    this.canvas.addEventListener('webglcontextlost', onLost);
    this.canvas.addEventListener('webglcontextrestored', onRestored);
    this._unbind.push(
      () => this.canvas.removeEventListener('webglcontextlost', onLost),
      () => this.canvas.removeEventListener('webglcontextrestored', onRestored),
    );
  }
}
