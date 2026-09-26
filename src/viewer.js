// Snap3dViewer - the whole library behind one class.
//
//   const viewer = new Snap3dViewer(canvas, './bundles/my_run.snap3d');
//   await viewer.ready;
//
// It owns a WebGL2 context on `canvas`, loads a snap3d bundle (config.json + a GLB +
// two KTX2 textures, in a `<run_id>.snap3d` folder) and renders it exactly as
// viewers/view_bundle.py does.
//
// The loop is demand-driven. The desktop original spins at a fixed 60 Hz because it
// owns the machine; a viewer embedded in someone's page does not, and a still frame
// costs the same to hold as to leave alone. So rAF runs only while something is
// actually changing - a drag, a held key, a resize, an explicit requestRender() - and
// stops when the image settles.

import { loadBundle } from './bundle.js';
import { multiply, normalize, perspective, rotatePointAbout } from './mat4.js';
import { OrbitCamera } from './orbit-camera.js';
import { OrbitControls } from './controls.js';
import { createRenderer } from './renderer.js';

export const VIEWER_DEFAULTS = {
  controls: true,      // false, or an options object forwarded to OrbitControls
  autoStart: true,
  maxPixelRatio: 2,    // 3x on a phone is all cost and no visible gain
  antialias: true,
  fov: null,           // degrees; null takes the bundle's initial_camera.fov_deg
  contextAttributes: null,
  // A small progress bar + MB counter over the canvas while the bundle downloads and
  // decompresses, gone the moment the first frame draws - true for the built-in look,
  // false to build your own off onProgress/onError instead, or { color } to keep the
  // built-in layout with your own accent colour (default '#3b82f6').
  loadingIndicator: true,
  autoRotate: true,     // slow idle spin, until the visitor drags/zooms/pans it themselves
  autoRotateSpeed: 25,   // degrees per second
  onProgress: null,    // (loadedBytes, totalBytes)
  onReady: null,       // (viewer)
  onError: null,       // (error)
  onWarning: null,     // (message)
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
    /** Degrees the view has turned about {@link Snap3dViewer#rotation} so far, for
     *  anyone who wants to read it back. `spinBy()` is what moves it. */
    this.spin = 0;

    this._renderer = null;
    this._raf = 0;
    this._dirty = true;
    this._running = this.options.autoStart;
    this._disposed = false;
    this._loadSeq = 0; // bumped on every _load() so an overlapping one can tell it lost
    this._last = 0;
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

    this._overlayHost = null;

    this._loadingEl = null;
    this._loadingBarEl = null;
    this._loadingTextEl = null;
    this._loadingPendingHide = false;
    if (this.options.loadingIndicator) this._showLoadingIndicator();

    /** Resolves with this viewer once the bundle is on the GPU. */
    this.ready = this._load().catch((error) => {
      this._reportError(error);
      throw error;
    });
  }

  get isReady() {
    return this._renderer !== null;
  }

  /**
   * The turntable the idle spin turns the *object* on, right now: a line through
   * wherever the camera is currently aimed (`camera.origin`), pointing along the
   * bundle's own `up_vector`. Not stored - a pan moves `camera.origin`, and the
   * axis simply follows it, which is also what keeps it sitting at the exact
   * centre of the screen: `origin` is by definition the point the camera looks
   * straight at, so it always projects there.
   */
  get rotation() {
    if (!this.camera || !this.config) return null;
    return { center: this.camera.origin, axis: normalize(this.config.up_vector) };
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
   * @param {object} [options]  
   * @returns {Promise<Snap3dViewer>} the same promise shape as `ready`
   */
  load(url) {
    this.url = String(url).replace(/\/+$/, '');
    if (this.options.loadingIndicator) this._showLoadingIndicator();
    this._renderer?.dispose();
    this._renderer = null;
    this.controls?.dispose();
    this.controls = null;
    this.camera = null;
    this.config = null;
    this.stats = null;
    this.warnings = [];
    this.ready = this._load().catch((error) => {
      this._reportError(error);
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
    this._loadingEl?.remove();
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
    const bundle = await loadBundle(this.url, (loaded, total) => {
      this._updateLoadingIndicator(loaded, total);
      this.options.onProgress?.(loaded, total);
    });
    if (this._disposed || seq !== this._loadSeq) return this;

    this.config = bundle.config;
    this.stats = bundle.stats;
    this._renderer = createRenderer(this.gl, bundle);
    this.warnings = this._renderer.warnings;
    for (const warning of this.warnings) this._warn(warning);

    const initial = this.config.initial_camera;
    this.spin = 0;
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
    // real drag/zoom/pan - see the wiring in _load().
    if (this._autoRotating) {
      this.spinBy(this.options.autoRotateSpeed * dt);
      this._dirty = true;
    }

    if (this._dirty) {
      this._dirty = false;
      this._draw();
    }
    // Keep clocking while an input is live or the idle spin is running, so the next
    // pointermove (or rotate step) has a fresh dt. Not `this._dirty` too - the block
    // just above always clears it, so it's already false on every path getting here.
    if (this.controls?.active || this._autoRotating) {
      this._schedule();
    } else {
      this._last = 0; // idle: the next frame's dt starts from that frame, not from now
    }
  }

  _draw() {
    const { gl, canvas, camera, config } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // near/far track the orbit radius, exactly as view_bundle.py sets them each frame.
    const projection = perspective(
      this.options.fov ?? config.initial_camera.fov_deg,
      canvas.width / canvas.height,
      camera.radius * 0.02,
      camera.radius * 20,
    );
    this._renderer.draw(multiply(projection, camera.viewMatrix()), camera.position);

    if (this._loadingPendingHide) {
      this._loadingPendingHide = false;
      this._hideLoadingIndicator();
    }
  }


  /** Show the built-in loading bar, creating it the first time it's needed - the
   *  `loadingIndicator` counterpart to `_showPoster()`, same overlay host, same
   *  "stays up until the first real frame draws" handling in `_draw()`. */
  _showLoadingIndicator() {
    const opt = this.options.loadingIndicator;
    const color = (opt && typeof opt === 'object' && opt.color) || '#3b82f6';
    if (!this._loadingEl) {
      const host = this._ensureOverlayHost();
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute; left:50%; bottom:16px; transform:translateX(-50%); z-index:2147483000; ' +
        'display:flex; flex-direction:column; align-items:center; gap:8px; ' +
        'padding:10px 16px; border-radius:10px; background:rgba(15,15,17,0.72); ' +
        'backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); pointer-events:none; ' +
        'transition:opacity 0.3s ease; font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;';
      const track = document.createElement('div');
      track.style.cssText = 'width:140px; height:3px; border-radius:2px; background:rgba(255,255,255,0.2); overflow:hidden;';
      const fill = document.createElement('div');
      fill.style.cssText = 'width:0%; height:100%; transition:width 0.15s linear;';
      track.appendChild(fill);
      const text = document.createElement('div');
      text.style.cssText = 'color:rgba(255,255,255,0.85); white-space:nowrap;';
      el.append(track, text);
      host.appendChild(el);
      this._loadingEl = el;
      this._loadingTrackEl = track;
      this._loadingBarEl = fill;
      this._loadingTextEl = text;
    }
    this._loadingTrackEl.style.display = '';
    this._loadingBarEl.style.width = '0%';
    this._loadingBarEl.style.background = color;
    this._loadingTextEl.textContent = 'loading…';
    this._loadingTextEl.style.color = '';
    this._loadingEl.style.display = '';
    this._loadingEl.style.opacity = '1';
    this._loadingPendingHide = true;
  }

  _updateLoadingIndicator(loaded, total) {
    if (!this._loadingBarEl) return;
    this._loadingBarEl.style.width = `${total ? (loaded / total) * 100 : 0}%`;
    this._loadingTextEl.textContent =
      loaded < total ? `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` : 'decompressing…';
  }

  _hideLoadingIndicator() {
    if (!this._loadingEl) return;
    this._loadingEl.style.opacity = '0';
  }

  /** Both error paths (construction, `load()`) go through here: the message replaces
   *  the bar rather than the indicator just vanishing, since a load that never
   *  finishes otherwise leaves no trace of why. */
  _reportError(error) {
    if (this._loadingEl) {
      this._loadingPendingHide = false;
      this._loadingTrackEl.style.display = 'none';
      this._loadingTextEl.textContent = String(error?.message ?? error);
      this._loadingTextEl.style.color = '#f87171';
      this._loadingEl.style.display = '';
      this._loadingEl.style.opacity = '1';
    }
    this.options.onError?.(error);
  }

  /**
   * For the loading indicator: the canvas already has a WebGL context, and a
   * 2D context can't share it. Absolute positioning needs a positioned ancestor:
   * reuse the canvas's parent if it already is one (a page that built its own stage
   * div, as this library's own demo does), otherwise wrap the canvas in a plain
   * relative div so a bare `<canvas>` dropped into the page still gets an overlay
   * that lines up with it.
   */
  _ensureOverlayHost() {
    if (this._overlayHost) return this._overlayHost;
    const parent = this.canvas.parentNode;
    const positioned = ['relative', 'absolute', 'fixed', 'sticky'].includes(
      parent && getComputedStyle(parent).position,
    );
    if (positioned) {
      this._overlayHost = parent;
    } else {
      const host = document.createElement('div');
      host.style.cssText = 'position:relative;';
      parent.insertBefore(host, this.canvas);
      host.appendChild(this.canvas);
      this._overlayHost = host;
    }
    return this._overlayHost;
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
