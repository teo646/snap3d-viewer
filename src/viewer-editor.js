// Snap3dViewerEditor - the same Snap3dViewer, with one more job: let whoever is
// looking at it choose a new default camera pose and write it out as a `config.json`.
// Swap the *script* on an existing page - `dist/viewer.js` for `dist/viewer_editor.js`
// - and nothing else has to change: same global name, same constructor, same
// rendering, same `new Snap3dViewer(canvas, url, options)` a page already calls. The
// extra controls and the "make config" panel just show up, floating over whatever the
// page already renders, so the operator edits the real page rather than a stand-in.
//
// Everything here goes through the base class's own public surface - `camera`,
// `controls`, `config`, `requestRender()`, `resetCamera()`, `focus()`, `dispose()` -
// never a private, underscored field, so a refactor of Snap3dViewer can't silently
// break this file.

import { Snap3dViewer } from './viewer.js';
import { lookAt, multiply, perspective, sub, normalize } from './mat4.js';

const ROTATE_SPEED = 16; // deg/s - matches the shipped viewer's own idle-spin default

// WASD/arrows (see controls.js's own PAN_KEYS) move the camera - the render changes,
// same as a drag or a wheel tick would. I/J/K/L moves the other thing entirely: the
// turntable's own centre (`viewer.rotation.center`, drawn as the dashed line), which
// no camera control touches and which nothing but these four keys ever moves. The
// camera is not involved either way round - placing the axis leaves the render
// exactly as it was, and the spin turns the object about wherever the axis now is,
// with the line itself holding still. Each key moves it in camera-relative terms, so
// the line moves the way the letter suggests regardless of which way the view
// currently faces:
//   I  away from the camera, along the view direction (the axis recedes)
//   K  toward the camera, along the view direction (the axis approaches)
//   J  left on screen
//   L  right on screen
// 'view' and 'right' name which vector _moveAxis() computes each tick, not a fixed
// world axis - both are read off the camera fresh every frame, the same way
// OrbitCamera's own forwardAxes getter derives its right/up pair. Keyed by
// event.code (the physical key), not event.key - see controls.js's own PAN_KEYS for
// why: under a non-Latin input method an I/J/K/L keypress's .key is not 'i'/'j'/'k'/
// 'l' at all, so matching on .key silently breaks this for exactly the visitors whose
// arrow keys still work fine.
const AXIS_MOVE_KEYS = {
  KeyI: ['view', 1],
  KeyK: ['view', -1],
  KeyJ: ['right', -1],
  KeyL: ['right', 1],
};

/**
 * The idle spin here is this class's own, not Snap3dViewer's built-in `autoRotate`:
 * that one stops on *any* interaction, panning included (see OrbitControls'
 * `onInteract`), and a pan is exactly the interaction an operator repositioning the
 * pivot needs the spin to survive. So `autoRotate` is always off on the base class,
 * and a drag, a wheel tick or R - not a WASD pan, nor an I/J/K/L axis move - are
 * watched for directly instead.
 */
export class Snap3dViewerEditor extends Snap3dViewer {
  /**
   * @param {HTMLCanvasElement|string} canvas
   * @param {string} url
   * @param {object} [options] everything {@link Snap3dViewer} takes, plus:
   * @param {boolean} [options.playing=true]  start the idle spin already running
   * @param {boolean} [options.ui=true]  inject the floating readout, transport and
   *   "make config" panel; false leaves only the behaviour (spin, pan-through, R,
   *   Space) and the {@link Snap3dViewerEditor#exportConfig} API, for a page that
   *   wants to build its own controls against that method instead.
   */
  constructor(canvas, url, options = {}) {
    const { playing = true, ui = true, ...base } = options;
    super(canvas, url, { ...base, autoRotate: false });

    this._playing = playing;
    this._lastTick = 0;
    this._rafId = 0;
    this._host = null;
    this._els = null;
    this._axisMoveKeys = new Set(); // held subset of AXIS_MOVE_KEYS, advanced in _tick()
    this._axisCanvas = null;
    this._axisCtx = null;

    this._onPointerDown = () => this.pause();
    this._onWheel = () => this.pause();
    this._onKeydown = (event) => {
      if (event.code === 'KeyR') {
        this.pause(); // OrbitControls' own listener restores the camera itself
        // ...but it goes through the controls, not through resetCamera(), so the two
        // things that live up here are ours to put back: the axis, and the turn
        // counter the readout shows. R means "as the bundle shipped it" for both.
        const shipped = this.config?.rotation?.center ?? this.config?.initial_camera.target;
        if (shipped && this.rotation) this.rotation.center = [...shipped];
        this.spin = 0;
      }
      if (event.code === 'Space') {
        event.preventDefault(); // otherwise the page scrolls
        this.playing = !this.playing;
      }
      if (AXIS_MOVE_KEYS[event.code] !== undefined) {
        event.preventDefault();
        this._axisMoveKeys.add(event.code);
      }
    };
    this._onKeyup = (event) => this._axisMoveKeys.delete(event.code);
    // Bound to the canvas, not the window: a keydown only reaches a canvas-scoped
    // listener while the canvas itself has focus, which is exactly the condition
    // under which Space (or I/J/K/L) should mean "drive this viewer" rather than
    // whatever it means elsewhere on the host page.
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: true });
    this.canvas.addEventListener('keydown', this._onKeydown);
    this.canvas.addEventListener('keyup', this._onKeyup);
    // I/J/K/L only act while held, same as WASD; losing focus mid-hold must not leave
    // one stuck "down" forever (mirrors OrbitControls' own blur handling for its keys).
    this._onBlur = () => this._axisMoveKeys.clear();
    this.canvas.addEventListener('blur', this._onBlur);

    this._buildAxisLine();
    if (ui) this._buildUI();
    this._tick = this._tick.bind(this);
    this._rafId = requestAnimationFrame(this._tick);
    this.ready.then(() => this.focus()).catch(() => {});
  }

  get playing() {
    return this._playing;
  }
  set playing(next) {
    this._playing = next;
    if (this._els) this._els.playBtn.textContent = next ? 'Pause (Space)' : 'Play (Space)';
  }
  pause() {
    this.playing = false;
  }
  play() {
    this.playing = true;
  }

  /**
   * The current camera as a fresh `initial_camera` block, in exactly the shape
   * `pipeline/core/render_bundle.py` writes - `position` and `view_matrix` precomputed
   * the same way, for a consumer that skips the orbit math, even though this viewer
   * itself never reads either back in. Every other field of the loaded bundle's
   * config - `up_vector`, `sh`, `texture_resolution`, `height`, anything else a bundle
   * happens to carry - passes through unchanged; this only ever rewrites the camera.
   *
   * `near`/`far` are re-derived from *this bundle's own* near/far-to-radius ratio
   * rather than assumed pipeline defaults, so a bundle built with non-default
   * `near_scale`/`far_scale` keeps its own proportions at the new radius.
   *
   * Pauses the idle spin first: the object keeps turning while an operator zooms or
   * pans (see the class comment), so without this, exporting mid-turn would write
   * out - and measure `frame` against - whatever fleeting angle the spin happened to
   * be at that instant rather than the pose actually being looked at, and a pose
   * that clips `_measureFrame()` at one angle but not another makes that pose pick
   * silently non-deterministic too.
   *
   * @returns {object|null} a plain object ready for `JSON.stringify`, or null before
   *   the bundle has loaded
   */
  exportConfig() {
    if (!this.camera || !this.config) return null;
    this.pause();
    const round = (n) => Math.round(n * 1e6) / 1e6; // trims float noise, keeps real precision
    const cam0 = this.config.initial_camera;
    // A malformed/hand-edited bundle missing near or far would otherwise divide
    // through to NaN here and export it silently - Number.isFinite catches that as
    // well as radius <= 0.
    const nearScale = Number.isFinite(cam0.near / cam0.radius) && cam0.radius > 0 ? cam0.near / cam0.radius : 0.02;
    const farScale = Number.isFinite(cam0.far / cam0.radius) && cam0.radius > 0 ? cam0.far / cam0.radius : 20;

    const c = this.camera;
    // Straight off the live camera - the spin is *in* it (spinBy swings the camera
    // rather than transforming the object), so whatever is on screen right now is
    // what these numbers reopen on. `view_matrix` is recomputed rather than reused
    // for the same reason `position` is written out at all: a consumer that skips
    // the orbit convention should still land on exactly this frame.
    const position = Array.from(c.position);
    const flat = lookAt(position, c.origin, c.up); // column-major - see src/mat4.js
    const view_matrix = [];
    for (let r = 0; r < 4; r++) {
      const row = [];
      for (let col = 0; col < 4; col++) row.push(round(flat[col * 4 + r]));
      view_matrix.push(row);
    }

    return {
      ...this.config,
      initial_camera: {
        type: 'orbit',
        target: c.origin.map(round),
        radius: round(c.radius),
        azimuth_deg: round(c.azimuth),
        elevation_deg: round(c.elevation),
        position: position.map(round),
        view_matrix,
        fov_deg: cam0.fov_deg,
        near: round(c.radius * nearScale),
        far: round(c.radius * farScale),
      },
      // The turntable, which the camera block above says nothing about: `center` is
      // wherever I/J/K/L has put the axis, `axis` is carried straight through - only
      // the centre ever moves here. viewer.js's _load() reads both back (falling back
      // to target/up_vector for a bundle with no `rotation` block at all).
      rotation: {
        center: (this.rotation?.center ?? c.origin).map(round),
        axis: (this.rotation?.axis ?? c.up).map(round),
      },
      // How a consuming page should reproduce this framing on a box shaped
      // differently than this canvas - see _measureFrame(). Falls back to the
      // loaded config's own `frame` (or the shipped default) only if nothing could
      // be read back (e.g. the canvas is 0x0 - hidden mid-export).
      frame: this._measureFrame() ?? this.config.frame ?? { fill: 0.88, anchor: [0.5, 0.5] },
    };
  }

  /**
   * `{fill, anchor}` as this canvas is actually composed right now: `fill` is how
   * much of the canvas's own *height* the rendered object occupies
   * (`objH/canvasH`, can read above 1 for a deliberately close crop), and `anchor`
   * is where in the canvas - `[x, y]` fraction, 0..1, y from the top - the rotation
   * axis (`rotation.center`) itself projects to. Height only, not
   * `max(objW/canvasW, objH/canvasH)`: for a fixed vertical FOV, screen height as a
   * fraction of canvas height depends only on radius and the object's own size,
   * never on the canvas's width or aspect ratio, so it's the one measurement that
   * means the same thing on a consumer's differently-shaped box as it does here -
   * which is the whole reason to write these out instead of just the camera pose.
   * See snap3d-clothes/app.js's `applyFrame()` for the consumer side of this exact
   * measurement.
   *
   * @returns {{fill: number, anchor: [number, number]}|null} null if nothing is
   *   drawn (an empty canvas) or the axis is behind the camera - exportConfig()
   *   falls back to the loaded config's own value rather than write a broken one.
   */
  _measureFrame() {
    if (!this.camera || !this.rotation) return null;
    const round = (n) => Math.round(n * 1e4) / 1e4;
    const gl = this.gl;
    const { width, height } = this.canvas;
    if (!width || !height) return null;

    // Alpha marks "the object" versus "nothing drawn" - true only against a
    // transparent clear, and this class doesn't otherwise ask for one (its default
    // background, like the base class's, is an opaque dark grey - see
    // VIEWER_DEFAULTS). Rendering one throwaway frame with alpha 0 gives a reading
    // uncoupled from whatever background a host page actually configured; the real
    // background comes straight back on the next regular frame, since nothing else
    // reads `this.options.background` in between.
    const background = this.options.background;
    this.options.background = [0, 0, 0, 0];
    this.renderFrame();
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.options.background = background;
    this.requestRender(); // queue a real frame back, since the throwaway one just drew

    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // nothing drawn
    if (minY <= 0 || maxY >= height - 1) return null; // top/bottom clipped - unreliable

    const c = this.camera;
    const proj = multiply(
      perspective(this.options.fov ?? this.config.initial_camera.fov_deg, width / height, c.radius * 0.02, c.radius * 20),
      c.viewMatrix(),
    );
    const [ax, ay, az] = this.rotation.center;
    const cx = proj[0] * ax + proj[4] * ay + proj[8] * az + proj[12];
    const cy = proj[1] * ax + proj[5] * ay + proj[9] * az + proj[13];
    const cw = proj[3] * ax + proj[7] * ay + proj[11] * az + proj[15];
    if (cw <= 1e-6) return null; // the axis is behind the camera

    return {
      fill: round((maxY - minY) / height),
      anchor: [
        round(((cx / cw) * 0.5 + 0.5)),
        round(1 - ((cy / cw) * 0.5 + 0.5)), // top-down, matching app.js's box.y convention
      ],
    };
  }

  dispose() {
    cancelAnimationFrame(this._rafId);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('keydown', this._onKeydown);
    this.canvas.removeEventListener('keyup', this._onKeyup);
    this.canvas.removeEventListener('blur', this._onBlur);
    this._host?.remove();
    this._host = null;
    this._axisCanvas?.remove();
    this._axisCanvas = null;
    super.dispose();
  }

  // -- internals --------------------------------------------------------------------

  /** I/J/K/L held: move `rotation.center` in camera-relative directions - away/toward
   *  along the view, left/right on screen - at the same speed a WASD pan moves the
   *  camera (`controls.options.panPerSecond`, scaled by the current radius so it
   *  feels the same regardless of how far zoomed in the view is). `view` and `right`
   *  are read fresh each call, the same vectors the axis line itself is projected
   *  with, so held keys and the line agree on "away". Nothing about the camera is
   *  touched, so the render doesn't stir while the axis is being placed; the next
   *  spin simply turns the object about the new centre. */
  _moveAxis(dt) {
    if (!this._axisMoveKeys.size || !this.rotation) return;
    const speed = this.camera.radius * (this.controls?.options.panPerSecond ?? 1.2) * dt;
    const view = normalize(sub(this.camera.origin, this.camera.position));
    const [right] = this.camera.forwardAxes;
    const vectors = { view, right };
    let dx = 0, dy = 0, dz = 0;
    for (const code of this._axisMoveKeys) {
      const entry = AXIS_MOVE_KEYS[code];
      if (!entry) continue;
      const [name, sign] = entry;
      const v = vectors[name];
      dx += sign * v[0];
      dy += sign * v[1];
      dz += sign * v[2];
    }
    if (!dx && !dy && !dz) return; // e.g. I and K both held: cancel out
    const c = this.rotation.center;
    this.rotation.center = [c[0] + dx * speed, c[1] + dy * speed, c[2] + dz * speed];
  }

  _tick(now) {
    this._rafId = requestAnimationFrame(this._tick);
    const dt = this.camera && this._lastTick ? Math.min((now - this._lastTick) / 1000, 0.1) : 0;
    if (this.camera && this._playing) {
      // The base class's own turntable step, driven from here instead of from its
      // `autoRotate` so a WASD pan or an I/J/K/L move doesn't stop it (OrbitControls'
      // onInteract makes no distinction; see the class comment).
      this.spinBy(ROTATE_SPEED * dt);
    }
    if (this.camera && this._axisMoveKeys.size) {
      this._moveAxis(dt);
      this.requestRender(); // the object turns about the new centre from here on
    }
    this._lastTick = now;
    this._updateReadout();
    this._updateAxisLine();
  }

  _updateReadout() {
    if (!this._els || !this.camera) return;
    const c = this.camera;
    const p = (n) => n.toFixed(3).padStart(8);
    this._els.readout.textContent =
      `axis    ${(this.rotation?.center ?? c.origin).map(p).join(' ')}\n` +
      `camera  ${c.origin.map(p).join(' ')}\n` +
      `radius  ${c.radius.toFixed(3)}\n` +
      `azimuth ${c.azimuth.toFixed(1)}°  spin ${this.spin.toFixed(0)}°`;
  }

  /**
   * A 2D canvas laid exactly over the WebGL one - a `position: fixed` sibling of the
   * host page's own DOM (same reasoning as `_buildUI`'s shadow root: correct even when
   * `this.canvas` sits inside an ancestor that clips or transforms it, since its
   * position and size are read from `getBoundingClientRect()`, the same rectangle that
   * clipping already resolved to) - drawn on, not through the SH/parallax shader, so
   * this needs none of the renderer's own state.
   */
  _buildAxisLine() {
    const el = document.createElement('canvas');
    el.style.cssText =
      'all: initial; position: fixed; pointer-events: none; z-index: 2147482999;';
    document.body.appendChild(el);
    this._axisCanvas = el;
    this._axisCtx = el.getContext('2d');
  }

  /** Projects `camera.origin ± camera.up * length` through the same
   *  perspective/view the renderer itself draws with (see Snap3dViewer's own
   *  `_draw()`) and draws the segment between them - the rotation axis, in the same
   *  place onscreen the render puts it, updated every tick so it tracks a drag, a
   *  zoom, a WASD pan, an I/J/K/L axis move and the idle spin alike. */
  _updateAxisLine() {
    const canvas = this._axisCanvas;
    if (!canvas || !this.camera || !this.isReady) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, this.options.maxPixelRatio ?? 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const ctx = this._axisCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!rect.width || !rect.height) return;
    // A page that swaps its own canvas for a photo (visibility, not display, so it
    // keeps its box and this rect stays meaningful) shouldn't get a line drawn over
    // the photo instead.
    const style = getComputedStyle(this.canvas);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return;

    const c = this.camera;
    const projection = perspective(
      this.options.fov ?? this.config.initial_camera.fov_deg,
      this.canvas.width / this.canvas.height, // the render's own aspect, not the CSS box's
      c.radius * 0.02,
      c.radius * 20,
    );
    // The same camera the frame is drawn with. The spin swings that camera around
    // this very line, and a rotation about a line leaves the line where it was, so
    // the projection below comes out identical frame after frame - the axis sits
    // still and the object goes round it.
    const mvp = multiply(projection, c.viewMatrix());

    const toScreen = (x, y, z) => {
      const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (cw <= 1e-6) return null; // behind the camera
      return [((cx / cw) * 0.5 + 0.5) * canvas.width, (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.height, cw];
    };

    const [ax, ay, az] = this.rotation?.center ?? c.origin;
    const dir = this.rotation?.axis ?? c.up;
    const half = c.radius * 1.3; // pokes past the object either end, not just to its edge
    const top = toScreen(ax + dir[0] * half, ay + dir[1] * half, az + dir[2] * half);
    const bottom = toScreen(ax - dir[0] * half, ay - dir[1] * half, az - dir[2] * half);
    const pivot = toScreen(ax, ay, az);
    if (!top || !bottom) return;

    ctx.strokeStyle = 'rgba(255, 82, 82, 0.85)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.moveTo(top[0], top[1]);
    ctx.lineTo(bottom[0], bottom[1]);
    ctx.stroke();

    if (pivot) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff5252';
      ctx.beginPath();
      ctx.arc(pivot[0], pivot[1], 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = 'rgba(10, 11, 13, 0.9)';
      ctx.stroke();
    }
  }

  /**
   * A small fixed-position panel, in its own shadow root so the host page's own CSS
   * can neither style it by accident nor clip it - `position: fixed` on the host
   * element means it sits over the viewport regardless of where the canvas lives or
   * how its own ancestors clip or transform their content.
   */
  _buildUI() {
    const host = document.createElement('div');
    host.style.cssText = 'all: initial;';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${EDITOR_CSS}</style>
      <div id="bottom-bar">
        <div id="panel">
          <pre id="readout">loading…</pre>
          <p id="hint">drag/wheel/wasd/arrows move camera &middot; ijkl move rotation axis</p>
          <div id="transport">
            <button id="play" type="button">Pause (Space)</button>
            <button id="reset" type="button">Reset (R)</button>
            <button id="help" type="button" aria-label="Controls help">?</button>
          </div>
        </div>
        <button id="make-config" type="button" class="primary">Make config file</button>
      </div>
      <dialog id="help-dialog">
        <button id="help-close" type="button" aria-label="Close">✕</button>
        <h2>Controls</h2>
        <p class="sub">This is the ordinary <code>Snap3dViewer</code> - this build just adds these. The dashed line is the turntable the object spins on (<code>rotation.center</code> / <code>rotation.axis</code>): it stays put, the object goes round it. The camera is a separate thing entirely.</p>
        <dl>
          <dt>Drag</dt><dd>orbit</dd>
          <dt>Wheel / pinch</dt><dd>zoom - moves the camera in or out</dd>
          <dt>W A S D<br>or arrows</dt><dd>move the camera - keeps spinning through this one</dd>
          <dt>I J K L</dt><dd>move the rotation axis: I away from you, K toward you, J left, L right. Only the dashed line moves - the camera and the object stay exactly where they are, and the object starts turning about wherever you leave it</dd>
          <dt>Space</dt><dd>play / pause the idle spin</dd>
          <dt>R</dt><dd>reset to the pose the bundle shipped with (also pauses)</dd>
          <dt>Make config file</dt><dd>writes the camera above into a new <code>config.json</code> - save it over the bundle's own file and that becomes the new default</dd>
        </dl>
      </dialog>
      <dialog id="dialog">
        <button id="close" type="button" aria-label="Close">✕</button>
        <h2>New config.json</h2>
        <p class="sub">Overwrite the bundle's <code>config.json</code> with this.</p>
        <textarea id="text" readonly spellcheck="false"></textarea>
        <div id="actions">
          <button id="save-as" type="button">Save as…</button>
          <button id="download" type="button">Download</button>
          <button id="copy" type="button">Copy</button>
        </div>
        <p id="status"></p>
      </dialog>
    `;

    const $ = (id) => root.getElementById(id);
    const els = {
      readout: $('readout'),
      playBtn: $('play'),
      resetBtn: $('reset'),
      helpBtn: $('help'),
      helpDialog: $('help-dialog'),
      helpCloseBtn: $('help-close'),
      makeBtn: $('make-config'),
      dialog: $('dialog'),
      closeBtn: $('close'),
      text: $('text'),
      saveAsBtn: $('save-as'),
      downloadBtn: $('download'),
      copyBtn: $('copy'),
      status: $('status'),
    };
    this._host = host;
    this._els = els;
    this.playing = this._playing; // sync the button label to the starting state

    els.playBtn.addEventListener('click', () => (this.playing = !this.playing));
    els.resetBtn.addEventListener('click', () => {
      this.pause();
      this.resetCamera();
    });
    els.closeBtn.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', (e) => {
      if (e.target === els.dialog) els.dialog.close(); // the backdrop
    });
    els.helpBtn.addEventListener('click', () => els.helpDialog.showModal());
    els.helpCloseBtn.addEventListener('click', () => els.helpDialog.close());
    els.helpDialog.addEventListener('click', (e) => {
      if (e.target === els.helpDialog) els.helpDialog.close();
    });

    const setStatus = (text, kind = '') => {
      els.status.textContent = text;
      els.status.className = kind;
    };

    els.makeBtn.addEventListener('click', () => {
      // exportConfig() pauses and measures frame itself, but falls back silently if
      // the current pose clips (see _measureFrame()) - measuring once more here,
      // after that same pause, is what lets this button say so instead of quietly
      // handing back a config whose zoom doesn't match what's on screen.
      this.pause();
      const measured = this._measureFrame();
      const cfg = this.exportConfig();
      if (!cfg) return;
      els.text.value = JSON.stringify(cfg, null, 2) + '\n';
      setStatus(
        measured ? '' : 'This angle runs slightly past the edge, so zoom/position were saved as the default instead - zoom out a touch and try again for this pose’s own.',
        measured ? '' : 'error',
      );
      els.dialog.showModal();
    });

    els.saveAsBtn.addEventListener('click', async () => {
      if (!window.showSaveFilePicker) {
        setStatus('This browser has no save dialog - use Download or Copy.', 'error');
        return;
      }
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'config.json',
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(els.text.value);
        await writable.close();
        setStatus('Saved.', 'ok');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setStatus(`Save failed: ${err.message} - use Download or Copy.`, 'error');
      }
    });

    els.downloadBtn.addEventListener('click', () => {
      const blob = new Blob([els.text.value], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'config.json';
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('Downloaded as config.json.', 'ok');
    });

    els.copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(els.text.value);
      } catch {
        els.text.select();
        document.execCommand('copy');
      }
      setStatus('Copied.', 'ok');
    });
  }
}

const EDITOR_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
/* #panel and #make-config are laid out by #bottom-bar, not by their own fixed
   offsets, so the two can never overlap regardless of #panel's actual height: side by
   side on a wide viewport, stacked on a narrow one. Only #bottom-bar itself is
   position: fixed - a fixed descendant of a *filtered* fixed ancestor would position
   against that ancestor's own box instead of the viewport (backdrop-filter creates a
   containing block for fixed descendants), so nothing below it repeats that. */
#bottom-bar {
  position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
}
#panel {
  display: flex; flex-direction: column; gap: 10px; width: 240px; flex: none;
  background: rgba(18, 19, 23, 0.88); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px; padding: 14px;
  font: 12px/1.6 ui-monospace, 'SF Mono', Consolas, 'Roboto Mono', monospace; color: #9195a0;
}
#readout { margin: 0; white-space: pre; }
#hint { margin: 0; font-size: 11px; color: #6d7078; white-space: normal; }
#transport { display: flex; gap: 6px; }
button {
  font: 600 12px/1 -apple-system, 'Segoe UI', system-ui, sans-serif; color: #f2f3f5; cursor: pointer;
  background: #1a1b20; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 7px;
  padding: 8px 10px; flex: 1 1 auto;
}
button:hover { background: #232429; }
button:active { transform: translateY(1px); }
button.primary { background: #ff5252; border-color: #ff5252; color: #2a0b09; }
button.primary:hover { background: #ff6a63; }
#help { flex: none; width: 30px; padding: 8px 0; }
#make-config {
  flex: none; padding: 12px 18px; font-size: 13px; border-radius: 10px;
  box-shadow: 0 12px 32px -12px rgba(255, 82, 82, 0.5);
}
@media (max-width: 640px) {
  #bottom-bar { flex-direction: column; align-items: stretch; }
  #panel { width: 100%; }
}
dialog {
  max-width: min(640px, calc(100vw - 48px)); width: 100%;
  background: #101114; color: #f2f3f5; border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px; padding: 22px 24px 24px;
  font: 14px/1.5 -apple-system, 'Segoe UI', system-ui, sans-serif;
  box-shadow: 0 40px 80px -30px rgba(0, 0, 0, 0.8);
}
dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
dialog h2 { margin: 0 0 4px; font-size: 18px; letter-spacing: -0.01em; }
dialog p.sub { margin: 0 0 16px; color: #9195a0; font-size: 13px; }
dialog code { background: #1a1b20; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
#close, #help-close { position: absolute; top: 14px; right: 14px; padding: 6px 9px; flex: none; }
#help-dialog dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; }
#help-dialog dt { font: 600 12px/1.5 ui-monospace, monospace; color: #ff5252; white-space: nowrap; }
#help-dialog dd { margin: 0; font-size: 13.5px; line-height: 1.55; }
#text {
  width: 100%; height: 300px; resize: vertical; white-space: pre; overflow: auto;
  font: 12px/1.4 ui-monospace, 'SF Mono', Consolas, 'Roboto Mono', monospace; color: #f2f3f5;
  background: #16171b; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 7px; padding: 8px 10px;
}
#actions { display: flex; gap: 8px; margin-top: 12px; }
#actions button { flex: 1 1 auto; }
#status { margin: 10px 0 0; font: 12px/1.4 ui-monospace, monospace; color: #9195a0; min-height: 1.4em; }
#status.error { color: #ff8a80; }
#status.ok { color: #5bc98a; }
`;
