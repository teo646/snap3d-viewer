// The per-vertex frame, recomputed from position + uv + indices.
//
// The bundle ships no normals and no tangents, deliberately: all three are pure
// functions of the geometry, and storing them would nearly triple the mesh payload to
// save ~30 ms. The catch is that a consumer must reproduce them *exactly* - a different
// frame is a different resolved uv, hence a different texel, hence subtly wrong colours
// everywhere rather than an error. So these are ports of two specific functions,
// `uv_geometry.vertex_normals_for` and `uv_geometry.compute_vertex_tangents`, and they
// are checked numerically against those functions' output, not against plausibility.
//
// Normals are ANGLE-weighted: each face contributes its unit normal scaled by the
// interior angle at the vertex being accumulated into. (The pipeline falls through to
// trimesh's `vertex_normals` here, which is angle-weighted; an area-weighted sum - the
// other common choice - differs from it by up to a full radian on this mesh, so the
// distinction is not academic.)
//
// Tangents are Lengyel's, accumulated over incident faces and left UN-NORMALIZED: the
// length is world units per UV unit, which is what `xy_per_height` converts a world
// step into a texel step with. Normalizing here would silently rescale the parallax.

const DEGENERATE_UV = 1e-12;

/**
 * @param {Float32Array} positions  (V*3)
 * @param {Float32Array} uv         (V*2), in the shader's convention (v already flipped
 *                                  out of glTF's top-left origin)
 * @param {Uint32Array}  indices    (F*3)
 * @returns {{normal: Float32Array, tangent: Float32Array, bitangent: Float32Array}}
 */
export function vertexFrameAttributes(positions, uv, indices) {
  const vertexCount = positions.length / 3;
  const faceCount = indices.length / 3;

  // float64 throughout, as the reference does: the accumulation runs over every
  // incident face and float32 rounding would show up in the low bits of the normal.
  const normal = new Float64Array(vertexCount * 3);
  const tangent = new Float64Array(vertexCount * 3);
  const bitangent = new Float64Array(vertexCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3] * 3;
    const i1 = indices[f * 3 + 1] * 3;
    const i2 = indices[f * 3 + 2] * 3;

    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const e1x = positions[i1] - ax, e1y = positions[i1 + 1] - ay, e1z = positions[i1 + 2] - az;
    const e2x = positions[i2] - ax, e2y = positions[i2 + 1] - ay, e2z = positions[i2 + 2] - az;

    // Face normal, unit. Its length before normalizing is twice the area, which is the
    // weight an area-weighted scheme would use and this one deliberately does not.
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLength = Math.hypot(nx, ny, nz);
    if (nLength > 0) {
      nx /= nLength; ny /= nLength; nz /= nLength;
    }

    // Interior angle at each corner, from the two unit edges leaving it.
    const j0 = indices[f * 3] * 3, j1 = indices[f * 3 + 1] * 3, j2 = indices[f * 3 + 2] * 3;
    const corners = [
      [j0, j1, j2],
      [j1, j2, j0],
      [j2, j0, j1],
    ];
    for (let c = 0; c < 3; c++) {
      const [p, q, r] = corners[c];
      let ux = positions[q] - positions[p];
      let uy = positions[q + 1] - positions[p + 1];
      let uz = positions[q + 2] - positions[p + 2];
      let vx = positions[r] - positions[p];
      let vy = positions[r + 1] - positions[p + 1];
      let vz = positions[r + 2] - positions[p + 2];
      const uLength = Math.hypot(ux, uy, uz) || 1;
      const vLength = Math.hypot(vx, vy, vz) || 1;
      ux /= uLength; uy /= uLength; uz /= uLength;
      vx /= vLength; vy /= vLength; vz /= vLength;
      const angle = Math.acos(Math.min(1, Math.max(-1, ux * vx + uy * vy + uz * vz)));
      normal[p] += nx * angle;
      normal[p + 1] += ny * angle;
      normal[p + 2] += nz * angle;
    }

    // Lengyel: solve the 2x2 UV system for dP/du and dP/dv over the face.
    const k0 = indices[f * 3] * 2, k1 = indices[f * 3 + 1] * 2, k2 = indices[f * 3 + 2] * 2;
    const du1 = uv[k1] - uv[k0], dv1 = uv[k1 + 1] - uv[k0 + 1];
    const du2 = uv[k2] - uv[k0], dv2 = uv[k2 + 1] - uv[k0 + 1];
    const denom = du1 * dv2 - du2 * dv1;
    // A face with no UV area contributes nothing rather than an infinity.
    const r = Math.abs(denom) < DEGENERATE_UV ? 0 : 1 / denom;

    const tx = (e1x * dv2 - e2x * dv1) * r;
    const ty = (e1y * dv2 - e2y * dv1) * r;
    const tz = (e1z * dv2 - e2z * dv1) * r;
    const bx = (e2x * du1 - e1x * du2) * r;
    const by = (e2y * du1 - e1y * du2) * r;
    const bz = (e2z * du1 - e1z * du2) * r;

    for (const i of [i0, i1, i2]) {
      tangent[i] += tx; tangent[i + 1] += ty; tangent[i + 2] += tz;
      bitangent[i] += bx; bitangent[i + 1] += by; bitangent[i + 2] += bz;
    }
  }

  // Only the normal is normalized - see the header on why the tangents are not.
  for (let v = 0; v < vertexCount * 3; v += 3) {
    const length = Math.hypot(normal[v], normal[v + 1], normal[v + 2]);
    if (length > 0) {
      normal[v] /= length; normal[v + 1] /= length; normal[v + 2] /= length;
    }
  }

  return {
    normal: Float32Array.from(normal),
    tangent: Float32Array.from(tangent),
    bitangent: Float32Array.from(bitangent),
  };
}
