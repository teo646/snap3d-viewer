// Snap3dViewer - the whole library behind one class.
//
//   const viewer = new Snap3dViewer(canvas, './bundles/my_run');
//   await viewer.ready;
//
// It owns a WebGL2 context on `canvas`, loads an export bundle (config.json + a GLB +
// two KTX2 textures) and renders it exactly as viewers/view_bundle.py does.
//
// The loop is demand-driven by default. The desktop original spins at a fixed 60 Hz
// because it owns the machine; a viewer embedded in someone's page does not, and a
// still frame costs the same to hold as to leave alone. So rAF runs only while
// something is actually changing - a drag, a held key, a resize, an explicit
// requestRender() - and stops when the image settles. Pass `render: 'always'` for a
// continuously-clocked loop (benchmarks, video capture).

import { loadBundle } from './bundle.js';
import { multiply, perspective } from './mat4.js';
import { OrbitCamera } from './orbit-camera.js';
import { OrbitControls } from './controls.js';
import { createRenderer } from './renderer.js';

export const VIEWER_DEFAULTS = {
  background: [0.05, 0.05, 0.06], // view_bundle.py's BACKGROUND
  controls: true,      // false, or an options object forwarded to OrbitControls
  render: 'demand',    // 'demand' | 'always'
  autoStart: true,
  maxPixelRatio: 2,    // 3x on a phone is all cost and no visible gain
  antialias: true,
  fov: null,           // degrees; null takes the bundle's initial_camera.fov_deg
  contextAttributes: null,
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
   * @param {string} url  the bundle's `config.json`, or the directory holding it
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

    this._renderer = null;
    this._home = null;
    this._raf = 0;
    this._dirty = true;
    this._running = this.options.autoStart;
    this._disposed = false;
    this._last = 0;
    this._frames = 0;
    this._fpsAt = 0;
    this._frame = this._frame.bind(this);

    this.gl = this.canvas.getContext('webgl2', {
      antialias: this.options.antialias,
      depth: true,
      ...(this.options.contextAttributes ?? {}),
    });
    if (!this.gl) throw new Error(WEBGL2_MISSING);

    this._bindContextEvents();
    this._observeSize();

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
   *  RGBA16F per coefficient, plus one RG16F relief texture. */
  get textureBytes() {
    if (!this.config) return 0;
    const [w, h] = this.config.texture_resolution;
    return w * h * 2 * (4 * this.config.sh.coefficients + 2);
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
   * @returns {Promise<Snap3dViewer>} the same promise shape as `ready`
   */
  load(url) {
    this.url = String(url).replace(/\/+$/, '');
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

  /** Back to the home pose (R in the desktop viewer). */
  resetCamera() {
    const { home } = this;
    if (home) this.setCamera(home);
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
    const bundle = await loadBundle(this.url, (loaded, total) => this.options.onProgress?.(loaded, total));
    if (this._disposed) return this;

    this.config = bundle.config;
    this.stats = bundle.stats;
    this._renderer = createRenderer(this.gl, bundle);
    this.warnings = this._renderer.warnings;
    for (const warning of this.warnings) this._warn(warning);

    const initial = this.config.initial_camera;
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
      if (this.options.controls) {
        this.controls = new OrbitControls(this.canvas, this.camera, {
          ...(this.options.controls === true ? {} : this.options.controls),
          onChange: () => this.requestRender(),
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
    const dt = this._last ? Math.min((now - this._last) / 1000, 0.1) : 0;
    this._last = now;

    // Held keys advance the pan; anything they move marks the frame dirty via onChange.
    this.controls?.update(dt);

    if (this._dirty || this.options.render === 'always') {
      this._dirty = false;
      this._draw();
      this._reportFps(now, dt);
    }
    // Keep clocking while an input is live, so the next pointermove has a fresh dt.
    if (this._dirty || this.options.render === 'always' || this.controls?.active) this._schedule();
    else this._last = 0; // idle: the next frame's dt starts from that frame, not from now
  }

  _draw() {
    const { gl, canvas, camera, config } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(...this.options.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // near/far track the orbit radius, exactly as view_bundle.py sets them each frame.
    const projection = perspective(
      this.options.fov ?? config.initial_camera.fov_deg,
      canvas.width / canvas.height,
      camera.radius * 0.02,
      camera.radius * 20,
    );
    this._renderer.draw(multiply(projection, camera.viewMatrix()), camera.position);
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
