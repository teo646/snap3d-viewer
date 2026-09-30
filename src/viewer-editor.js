// Snap3dViewerEditor - the same Snap3dViewer, with one more job: let whoever is
// looking at it choose a new default camera pose and write it out as a `config.json`.
// Swap the *script* on an existing page - `dist/viewer.js` for `dist/viewer_editor.js`
// - and nothing else has to change: same global name, same constructor, same
// rendering, same `new Snap3dViewer(canvas, url, options)` a page already calls. The
// extra controls and the "make config" panel just show up, floating over whatever the
// page already renders, so the operator edits the real page rather than a stand-in.
//
// Everything here goes through the base class's own public surface - `camera`,
// `controls`, `config`, `requestRender()`, `focus()`, `dispose()` -
// never a private, underscored field, so a refactor of Snap3dViewer can't silently
// break this file.

import { Snap3dViewer } from './viewer.js';
import { CONTROL_DEFAULTS } from './controls.js';
import { add, lookAt, multiply, normalize, perspective, rotateAbout, sub } from './mat4.js';

const ROTATE_SPEED = 16; // deg/s - matches the shipped viewer's own idle-spin default
// The base viewer's own panPerSecond matches view_bundle.py's per-frame pan exactly
// (see controls.js) - deliberately not the number to tune for feel. An operator
// nudging the camera by eye wants something slower than that reference constant, so
// the editor asks for its own default rather than touching the shared one.
const EDITOR_PAN_PER_SECOND = CONTROL_DEFAULTS.panPerSecond * 0.35;
const UP_STEP_DEG = 0.3; // per keypress; Shift multiplies it by UP_STEP_FAST
const UP_STEP_FAST = 10;
const UP_GIZMO_COLOR = '#39e991';
// event.code, keyed the same way controls.js's PAN_KEYS is - see _onKeydown.
const UP_KEYS = { KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l' };

/**
 * The idle spin here is this class's own, not Snap3dViewer's built-in `autoRotate`:
 * that one stops on *any* interaction, panning included (see OrbitControls'
 * `onInteract`), and a pan is exactly the interaction an operator repositioning the
 * view needs the spin to survive. So `autoRotate` is always off on the base class,
 * and a drag or a wheel tick - not a WASD pan - are watched for directly instead.
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
    // false stays false (no controls at all); an explicit object of the caller's own
    // is layered over the editor's slower default rather than replaced by it.
    const controls =
      base.controls === false
        ? false
        : { panPerSecond: EDITOR_PAN_PER_SECOND, ...(base.controls === true || base.controls == null ? {} : base.controls) };
    super(canvas, url, { ...base, autoRotate: false, controls });

    this._playing = playing;
    this._lastTick = 0;
    this._rafId = 0;
    this._host = null;
    this._els = null;
    this._gizmoCanvas = null;
    this._gizmoCtx = null;

    this._onPointerDown = () => this.pause();
    this._onWheel = () => this.pause();
    // I/K tilt the up vector toward/away from the view direction; J/L roll it about
    // the view direction - see _nudgeUp. IJKL rather than arrows: arrows already pan
    // (see Snap3dViewer's own controls), and this needs four more keys beside them.
    //
    // Matched on event.code, not event.key, for the same reason controls.js's own
    // PAN_KEYS is: under a non-Latin input method (Korean, Japanese, ...) a physical
    // I/J/K/L keypress's *character* is not 'i'/'j'/'k'/'l', so .key silently drops
    // the binding for exactly the visitors WASD's .code match keeps working for.
    // .code still reports 'KeyI' etc. regardless of layout or an active IME.
    this._onKeydown = (event) => {
      if (event.code === 'Space') {
        event.preventDefault(); // otherwise the page scrolls
        this.playing = !this.playing;
        return;
      }
      const key = UP_KEYS[event.code];
      if (key) {
        event.preventDefault();
        this._nudgeUp(key, event.shiftKey ? UP_STEP_DEG * UP_STEP_FAST : UP_STEP_DEG);
      }
    };
    // Bound to the canvas, not the window: a keydown only reaches a canvas-scoped
    // listener while the canvas itself has focus, which is exactly the condition
    // under which Space (or IJKL) should mean "drive this viewer" rather than
    // whatever it means elsewhere on the host page.
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: true });
    this.canvas.addEventListener('keydown', this._onKeydown);

    if (ui) {
      this._buildUI();
      this._buildUpGizmo();
    }
    this._tick = this._tick.bind(this);
    this._rafId = requestAnimationFrame(this._tick);
    this.ready.then(() => this.focus()).catch(() => {});
  }

  /**
   * Rotate the bundle's `up_vector` by `deg` and re-point the live camera at the
   * result. J/L rotate `up` about the view direction (roll) - `lookAt` only ever uses
   * the component of `up` perpendicular to the view direction, so that component is
   * the *entire* visible effect, and freezing `position` across the change is what
   * makes it legible: the view visibly rolls, and the fix is "keep pressing until the
   * horizon looks upright," not "hunt for where the camera went."
   *
   * I/K rotate `up` about the camera's right axis (pitch) instead, and that axis is
   * exactly the one spanning the view-direction/up plane `lookAt` throws away - held
   * with `position` frozen the same way, the edit would do nothing visible until the
   * discarded component crossed zero, then flip the image outright. So pitch also
   * carries `position` through the same rotation, orbiting the eye around `origin`
   * right along with `up`: the pair stays rigidly related (their dot product doesn't
   * change), which is what makes the object visibly nod rather than the screen either
   * doing nothing or snapping upside down.
   */
  _nudgeUp(key, deg) {
    if (!this.camera || !this.config) return;
    const c = this.camera;
    const rad = (deg * Math.PI) / 180;
    const viewDir = normalize(sub(c.origin, c.position), 1e-10);
    const [right] = c.forwardAxes;
    const pitch = key === 'i' || key === 'k';
    const axis = pitch ? right : viewDir;
    const angle = (key === 'i' || key === 'l' ? 1 : -1) * rad;

    const oldPosition = c.position; // read before setUp changes what this getter means
    const nextUp = normalize(rotateAbout(c.up, axis, angle));
    const position = pitch ? add(c.origin, rotateAbout(sub(oldPosition, c.origin), axis, angle)) : oldPosition;

    c.setUp(nextUp);
    c.setPose(position, c.origin);
    this.config.up_vector = nextUp;
    this.requestRender();
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
   * out whatever fleeting angle the spin happened to be at that instant rather than
   * the pose actually being looked at.
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
    };
  }

  dispose() {
    cancelAnimationFrame(this._rafId);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('keydown', this._onKeydown);
    this._host?.remove();
    this._host = null;
    this._gizmoCanvas?.remove();
    this._gizmoCanvas = null;
    this._gizmoCtx = null;
    super.dispose();
  }

  // -- internals --------------------------------------------------------------------

  _tick(now) {
    this._rafId = requestAnimationFrame(this._tick);
    const dt = this.camera && this._lastTick ? Math.min((now - this._lastTick) / 1000, 0.1) : 0;
    if (this.camera && this._playing) {
      this.spinBy(ROTATE_SPEED * dt);
    }
    this._lastTick = now;
    this._updateReadout();
    this._drawUpGizmo();
  }

  _updateReadout() {
    if (!this._els || !this.camera) return;
    const c = this.camera;
    const p = (n) => n.toFixed(3).padStart(8);
    this._els.readout.textContent =
      `target  ${c.origin.map(p).join(' ')}\n` +
      `radius  ${c.radius.toFixed(3)}\n` +
      `azimuth ${c.azimuth.toFixed(1)}°  spin ${this.spin.toFixed(0)}°\n` +
      `up      ${c.up.map(p).join(' ')}`;
  }

  /**
   * A transparent 2D canvas laid exactly over the WebGL one, not a draw call added to
   * the GL scene - the viewer's own render loop is demand-driven and clears the
   * canvas on every draw it decides to run (see Snap3dViewer#_draw), so a gizmo drawn
   * through the same context would just as often be erased the frame after as shown.
   * A sibling canvas redrawn every editor tick has no such race, at the cost of never
   * occluding against the bundle's own depth - fine for an arrow that only needs to
   * be visible, not physically correct.
   */
  _buildUpGizmo() {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position: fixed; left: 0; top: 0; pointer-events: none; z-index: 2147483000;';
    document.body.appendChild(canvas);
    this._gizmoCanvas = canvas;
    this._gizmoCtx = canvas.getContext('2d');
  }

  /**
   * Project `camera.origin -> origin + up * radius/2` through the same
   * projection/view the bundle itself draws with (see Snap3dViewer#_draw - near/far
   * are re-derived from `radius` there too, so this has to match rather than assume
   * the config's own near/far) and draw the result as an arrow, so the up_vector
   * `_nudgeUp` is editing reads as a line in the same space as the bundle rather than
   * as three unitless numbers in the readout.
   */
  _drawUpGizmo() {
    const canvas = this._gizmoCanvas;
    if (!canvas || !this.camera || !this.config) return;
    const rect = this.canvas.getBoundingClientRect();
    const ctx = this._gizmoCtx;
    if (!rect.width || !rect.height) {
      canvas.width = canvas.height = 0;
      return;
    }
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const c = this.camera;
    const projection = perspective(
      this.options.fov ?? this.config.initial_camera.fov_deg,
      rect.width / rect.height,
      c.radius * 0.02,
      c.radius * 20,
    );
    const vp = multiply(projection, c.viewMatrix()); // column-major - see src/mat4.js

    // Column-major M * [x, y, z, 1]; returns clip-space (x, y, w) - z is unused, this
    // only ever draws in 2D screen space.
    const project = ([x, y, z]) => {
      const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
      const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
      const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (cw < 1e-4) return null; // behind the eye - nothing sane to draw
      return { x: ((cx / cw) * 0.5 + 0.5) * canvas.width, y: (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.height };
    };

    const tail = c.origin;
    const tip = [c.origin[0] + c.up[0] * c.radius * 0.5, c.origin[1] + c.up[1] * c.radius * 0.5, c.origin[2] + c.up[2] * c.radius * 0.5];
    const p0 = project(tail);
    const p1 = project(tip);
    if (!p0 || !p1) return;

    const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const headLen = 12;

    ctx.save();
    // A dark outline first, so the line stays visible over both light and dark
    // patches of whatever the bundle itself just rendered.
    for (const [color, width] of [['rgba(0,0,0,0.55)', 5], [UP_GIZMO_COLOR, 2.5]]) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p1.x - headLen * Math.cos(angle - Math.PI / 7), p1.y - headLen * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(p1.x - headLen * Math.cos(angle + Math.PI / 7), p1.y - headLen * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillStyle = UP_GIZMO_COLOR;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeText('up', p1.x + 6, p1.y - 6);
    ctx.fillText('up', p1.x + 6, p1.y - 6);
    ctx.restore();
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
          <p id="hint">drag/wheel/wasd/arrows move camera - ijkl fix up vector</p>
          <div id="transport">
            <button id="play" type="button">Pause (Space)</button>
            <button id="help" type="button" aria-label="Controls help">?</button>
          </div>
        </div>
        <button id="make-config" type="button" class="primary">Make config file</button>
      </div>
      <dialog id="help-dialog">
        <button id="help-close" type="button" aria-label="Close">✕</button>
        <h2>Controls</h2>
        <p class="sub">This is the ordinary <code>Snap3dViewer</code> - this build just adds these.</p>
        <dl>
          <dt>Drag</dt><dd>orbit</dd>
          <dt>Wheel / pinch</dt><dd>zoom - moves the camera in or out</dd>
          <dt>W A S D<br>or arrows</dt><dd>move the camera - keeps spinning through this one</dd>
          <dt>Space</dt><dd>play / pause the idle spin</dd>
          <dt>I K<br>J L</dt><dd>tilt / roll <code>up_vector</code> - the green arrow in the scene is it; hold Shift to move it faster</dd>
          <dt>Make config file</dt><dd>writes the camera and <code>up_vector</code> above into a new <code>config.json</code> - save it over the bundle's own file and that becomes the new default</dd>
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
      const cfg = this.exportConfig();
      if (!cfg) return;
      els.text.value = JSON.stringify(cfg, null, 2) + '\n';
      setStatus('');
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
