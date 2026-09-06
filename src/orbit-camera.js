// Port of pipeline/core/orbit_camera.py's OrbitCamera.
//
// The orbit is built around the bundle's explicit `up` axis rather than world +Y: a
// reconstruction's world frame has no notion of up (COLMAP fixes it from whichever
// image came first), so a +Y-up orbit shows most runs lying on their side and spins
// about the wrong axis. `config.up_vector` is the axis the capture was shot upright
// about, and it is the axis this orbits.

import { add, cross, dot, lookAt, normalize, scale, sub } from './mat4.js';

// Seeds for the horizontal reference axis, tried in order. Z first so `up=+Y` gives
// right=+X, forward=+Z; 0.9 is just "not nearly parallel".
const BASIS_SEEDS = [[0, 0, 1], [1, 0, 0], [0, 1, 0]];
const BASIS_MAX_ALIGNMENT = 0.9;

/** (right, forward): an orthonormal pair spanning the plane perpendicular to `up`. */
export function horizontalBasis(up) {
  const seed = BASIS_SEEDS.find((s) => Math.abs(dot(s, up)) < BASIS_MAX_ALIGNMENT);
  const forward = normalize(sub(seed, scale(up, dot(seed, up))));
  return [cross(up, forward), forward];
}

export class OrbitCamera {
  constructor(origin, radius, up) {
    this.origin = [...origin];
    this.radius = radius;
    this.azimuth = 45;
    this.elevation = 20;
    this.up = normalize(up);
    [this._right, this._forward] = horizontalBasis(this.up);
  }

  get position() {
    const az = (this.azimuth * Math.PI) / 180;
    const el = (this.elevation * Math.PI) / 180;
    const d = add(
      scale(add(scale(this._right, Math.sin(az)), scale(this._forward, Math.cos(az))), Math.cos(el)),
      scale(this.up, Math.sin(el)),
    );
    return add(this.origin, scale(d, this.radius));
  }

  /** (right, up) in the current view direction, for WASD panning. */
  get forwardAxes() {
    const viewDir = normalize(sub(this.origin, this.position), 1e-10);
    const right = normalize(cross(viewDir, this.up), 1e-10);
    return [right, cross(right, viewDir)];
  }

  viewMatrix() {
    return lookAt(this.position, this.origin, this.up);
  }
}
