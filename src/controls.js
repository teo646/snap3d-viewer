// Orbit / zoom / pan input for an OrbitCamera, bound to one DOM element.
//
// The constants are view_bundle.py's: 0.3 degrees per pixel of drag, radius *= 0.9
// per wheel tick clamped to [0.05, 8] of the starting radius, pan at radius*0.02 per
// frame. That pygame loop ticks at a fixed 60 Hz, so "per frame" is expressed here as
// `panPerSecond` and scaled by dt - a 144 Hz display would otherwise pan 2.4x faster.
//
// Input is scoped to the element rather than the window, including the keyboard: a
// viewer embedded in someone else's page must not eat their W key. The element is made
// focusable and takes focus on pointerdown, so keys work once you have touched it.

export const CONTROL_DEFAULTS = {
  orbitDegreesPerPixel: 0.3,
  zoomPerTick: 0.9,
  zoomRange: [0.05, 8.0], // multiples of the radius the camera started at
  panPerSecond: 0.02 * 60,
  keys: true,
  // The Python original has no limit and lets elevation run past the pole, where
  // look_at's up axis becomes parallel to the view direction and the image flips.
  // Set to null to reproduce that exactly.
  elevationLimit: 89.9,
};

// key -> (index into camera.forwardAxes, sign). forwardAxes is (right, up).
const PAN_KEYS = {
  w: [1, 1], arrowup: [1, 1],
  s: [1, -1], arrowdown: [1, -1],
  a: [0, -1], arrowleft: [0, -1],
  d: [0, 1], arrowright: [0, 1],
};

export class OrbitControls {
  /**
   * @param {HTMLElement} element  the surface that receives pointer/wheel/key input
   * @param {import('./orbit-camera.js').OrbitCamera} camera  driven in place
   * @param {object} [options]  see CONTROL_DEFAULTS, plus `onChange`
   */
  constructor(element, camera, options = {}) {
    this.element = element;
    this.camera = camera;
    this.options = { ...CONTROL_DEFAULTS, ...options };
    this.enabled = true;
    /** Called whenever the camera moved, so a demand-driven loop knows to redraw. */
    this.onChange = options.onChange ?? (() => {});

    this._radius0 = camera.radius;
    this._pointers = new Map();
    this._keys = new Set();
    this._pinch = 0;
    this._unbind = [];

    this.home = this.readCamera();
    this._bind();
  }

  /** True while a drag or a key is live - the loop must keep running. */
  get active() {
    return this.enabled && (this._pointers.size > 0 || this._keys.size > 0);
  }

  /** A plain snapshot of the pose, the shape `setCamera` and `home` both take. */
  readCamera() {
    const { azimuth, elevation, radius, origin } = this.camera;
    return { azimuth, elevation, radius, target: [...origin] };
  }

  /** Apply any subset of {azimuth, elevation, radius, target}. */
  setCamera(pose) {
    if (pose.azimuth !== undefined) this.camera.azimuth = pose.azimuth;
    if (pose.elevation !== undefined) this.camera.elevation = this._clampElevation(pose.elevation);
    if (pose.radius !== undefined) this.camera.radius = this._clampRadius(pose.radius);
    if (pose.target !== undefined) this.camera.origin = [...pose.target];
    this.onChange();
  }

  /** Back to the pose the bundle shipped (R in the desktop viewer). */
  reset() {
    this.setCamera(this.home);
  }

  /** `ticks` follows pygame's wheel: positive zooms in, matching radius *= 0.9^ticks. */
  zoom(ticks) {
    this.camera.radius = this._clampRadius(this.camera.radius * this.options.zoomPerTick ** ticks);
    this.onChange();
  }

  orbit(dxPixels, dyPixels) {
    const step = this.options.orbitDegreesPerPixel;
    this.camera.azimuth -= dxPixels * step;
    this.camera.elevation = this._clampElevation(this.camera.elevation + dyPixels * step);
    this.onChange();
  }

  /** Advance held-key panning. Returns true if the camera moved. */
  update(dt) {
    if (!this.enabled || this._keys.size === 0) return false;
    const axes = this.camera.forwardAxes;
    const speed = this.camera.radius * this.options.panPerSecond * dt;
    let moved = false;
    for (const key of this._keys) {
      const pan = PAN_KEYS[key];
      if (!pan) continue;
      const [axis, sign] = pan;
      this.camera.origin = this.camera.origin.map((v, i) => v + sign * speed * axes[axis][i]);
      moved = true;
    }
    if (moved) this.onChange();
    return moved;
  }

  dispose() {
    for (const off of this._unbind) off();
    this._unbind = [];
    this._pointers.clear();
    this._keys.clear();
  }

  _clampRadius(radius) {
    const [lo, hi] = this.options.zoomRange;
    return Math.min(Math.max(radius, this._radius0 * lo), this._radius0 * hi);
  }

  _clampElevation(elevation) {
    const limit = this.options.elevationLimit;
    return limit === null ? elevation : Math.min(Math.max(elevation, -limit), limit);
  }

  _on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._unbind.push(() => target.removeEventListener(type, handler, options));
  }

  _bind() {
    const el = this.element;

    this._on(el, 'pointerdown', (event) => {
      if (!this.enabled) return;
      el.setPointerCapture?.(event.pointerId);
      this._pointers.set(event.pointerId, event);
      el.classList.add('shs-dragging');
      if (this.options.keys) el.focus?.({ preventScroll: true });
    });

    this._on(el, 'pointermove', (event) => {
      const previous = this._pointers.get(event.pointerId);
      if (!previous || !this.enabled) return;
      this._pointers.set(event.pointerId, event);

      if (this._pointers.size >= 2) {
        // Two fingers: pinch only. Averaging the drag in as well makes both feel mushy.
        const [a, b] = [...this._pointers.values()];
        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (this._pinch > 0 && distance > 0) {
          this.zoom(Math.log(this._pinch / distance) / Math.log(this.options.zoomPerTick));
        }
        this._pinch = distance;
        return;
      }
      this.orbit(event.clientX - previous.clientX, event.clientY - previous.clientY);
    });

    const endPointer = (event) => {
      this._pointers.delete(event.pointerId);
      if (this._pointers.size < 2) this._pinch = 0;
      if (this._pointers.size === 0) el.classList.remove('shs-dragging');
    };
    this._on(el, 'pointerup', endPointer);
    this._on(el, 'pointercancel', endPointer);

    this._on(el, 'wheel', (event) => {
      if (!this.enabled) return;
      event.preventDefault(); // otherwise the host page scrolls out from under the canvas
      // deltaMode 1 is lines, 0 is pixels; both normalized to pygame's wheel "ticks".
      this.zoom(-event.deltaY / (event.deltaMode === 1 ? 3 : 100));
    }, { passive: false });

    if (!this.options.keys) return;
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0; // focusable, so keydown reaches it
    this._on(el, 'keydown', (event) => {
      if (!this.enabled) return;
      const key = event.key.toLowerCase();
      if (key === 'r') this.reset();
      if (!PAN_KEYS[key]) return;
      event.preventDefault(); // arrows would scroll the host page
      this._keys.add(key);
      this.onChange();
    });
    this._on(el, 'keyup', (event) => this._keys.delete(event.key.toLowerCase()));
    // Losing focus mid-drag would otherwise leave a key stuck down forever.
    this._on(el, 'blur', () => { this._keys.clear(); this._pointers.clear(); });
  }
}
