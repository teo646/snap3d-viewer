// Loads a snap3d bundle: four files, in formats the browser already understands.
//
//   config.json   up_vector, sh{...}, texture_resolution, height{...}, initial_camera
//   mesh.glb      POSITION, TEXCOORD_0, indices - and nothing else
//   sh.ktx2       RGBA16F array, one layer per SH coefficient (a is padding)
//   height.ktx2   RG16F; r = displacement, g = 1 inside the atlas coverage
//
// There is no conversion step. The pipeline writes glTF and KTX2 in those formats' own
// conventions, and the two adjustments into this repo's v-up shader happen here at
// load, exactly as viewers/view_bundle.py does them: `v <- 1 - v` on TEXCOORD_0, and
// the row flip that puts KTX2's first row at v=0 for GL's bottom-left origin.
//
// The per-vertex frame is not in the bundle; frame.js recomputes it from the geometry.
//
// The pipeline writes those four into a folder named `<run_id>.snap3d`, so a bundle
// carries its capture's name wherever it is copied to. That is a naming convention and
// not a container - there is nothing to unpack, and `config.json` is still the entry
// point - so a `.snap3d` URL is loaded exactly like any other directory.

import { readGlb } from './glb.js';
import { readKtx2 } from './ktx2.js';
import { vertexFrameAttributes } from './frame.js';

// The `format` string config.json carries. It names the payload format, which the
// `.snap3d` folder convention did not change, so it is still the pipeline's original.
const BUNDLE_FORMAT = 'sh_texture_bundle/';

/** Stream one URL, reporting bytes as they arrive. */
async function streamBody(response, onChunk) {
  if (!response.body) return response.arrayBuffer(); // no streams (file://): still correct
  const chunks = [];
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Flip a KTX2 texture's rows in place: row 0 arrives as the top row (KTXorientation
 * "rd", the atlas convention), and GL's texture origin is the bottom-left. The desktop
 * viewer does this with np.flipud; WebGL's UNPACK_FLIP_Y does not apply to
 * texSubImage3D layers, so both textures are flipped the same way here.
 */
function flipRows(data, width, height, layers, channels) {
  const rowWords = width * channels;
  const scratch = new Uint16Array(rowWords);
  for (let layer = 0; layer < layers; layer++) {
    const base = layer * height * rowWords;
    for (let y = 0; y < height >> 1; y++) {
      const top = base + y * rowWords;
      const bottom = base + (height - 1 - y) * rowWords;
      scratch.set(data.subarray(top, top + rowWords));
      data.copyWithin(top, bottom, bottom + rowWords);
      data.set(scratch, bottom);
    }
  }
  return data;
}

/**
 * @param {string} url  the bundle's `config.json`, or the `<run_id>.snap3d` folder
 *   holding it (any directory works; the suffix is a label, not a requirement)
 * @param {(loaded:number, total:number) => void} onProgress
 */
export async function loadBundle(url, onProgress = () => {}) {
  const trimmed = String(url).replace(/\/+$/, '');
  const configUrl = /\.json$/i.test(trimmed) ? trimmed : `${trimmed}/config.json`;
  const baseUrl = configUrl.slice(0, configUrl.lastIndexOf('/'));

  const response = await fetch(configUrl);
  if (!response.ok) throw new Error(`${configUrl}: ${response.status} ${response.statusText}`);
  const config = await response.json().catch(() => {
    throw new Error(`${configUrl} is not JSON - is that a bundle?`);
  });
  if (!String(config.format).startsWith(BUNDLE_FORMAT)) {
    throw new Error(`${baseUrl} is not a snap3d bundle (format "${config.format}")`);
  }

  // All three requests are issued at once so their Content-Lengths give a real total
  // before any body is read; the bodies then stream in parallel into one counter.
  const names = ['mesh', 'sh', 'height'];
  const responses = await Promise.all(
    names.map(async (name) => {
      const fileUrl = `${baseUrl}/${config.files[name]}`;
      const r = await fetch(fileUrl);
      if (!r.ok) throw new Error(`${fileUrl}: ${r.status} ${r.statusText}`);
      return r;
    }),
  );
  const total = responses.reduce((sum, r) => sum + (Number(r.headers.get('content-length')) || 0), 0);
  let loaded = 0;
  onProgress(0, total);
  const buffers = await Promise.all(
    responses.map((r) =>
      streamBody(r, (bytes) => {
        loaded += bytes;
        onProgress(loaded, total || loaded);
      }),
    ),
  );
  onProgress(total || loaded, total || loaded);

  const [meshBuffer, shBuffer, heightBuffer] = buffers;
  const mesh = readGlb(meshBuffer);
  const [sh, height] = await Promise.all([readKtx2(shBuffer), readKtx2(heightBuffer)]);

  const [width, textureHeight] = config.texture_resolution;
  for (const [name, texture] of [['sh', sh], ['height', height]]) {
    if (texture.width !== width || texture.height !== textureHeight) {
      throw new Error(
        `${name}.ktx2 is ${texture.width}x${texture.height}, config says ${width}x${textureHeight}`,
      );
    }
  }
  if (sh.layers !== config.sh.coefficients) {
    throw new Error(`sh.ktx2 has ${sh.layers} layers, config says ${config.sh.coefficients} coefficients`);
  }

  flipRows(sh.data, sh.width, sh.height, sh.layers, sh.channels);
  flipRows(height.data, height.width, height.height, 1, height.channels);

  // glTF puts the UV origin at the image's top-left; the shader this ports is v-up.
  const uv = Float32Array.from(mesh.uv);
  for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i];

  const frame = vertexFrameAttributes(mesh.positions, uv, mesh.indices);

  // Coverage, for the HUD: g is exactly 0 or 1 per texel, so a non-zero half-float word
  // is the whole test - no need to decode the mantissa.
  let covered = 0;
  for (let i = 1; i < height.data.length; i += height.channels) {
    if (height.data[i] !== 0) covered++;
  }

  return {
    config,
    geometry: { position: mesh.positions, uv, indices: mesh.indices, ...frame },
    textures: { sh, height },
    stats: {
      vertices: mesh.vertexCount,
      faces: mesh.faceCount,
      coverage: covered / (width * textureHeight),
      bytes: total || buffers.reduce((sum, b) => sum + b.byteLength, 0),
    },
  };
}
