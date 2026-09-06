// Fetches a web bundle written by tools/export_web_bundle.py: one `bundle.json` plus
// two flat little-endian blobs it indexes into. The blobs are tens of megabytes, so
// they are streamed with a byte counter rather than awaited as opaque promises.

const ARRAY_TYPES = {
  f32: Float32Array,
  // f16 stays raw 16-bit words: there is no Float16Array to decode into, and
  // gl.HALF_FLOAT takes exactly these bits.
  f16: Uint16Array,
  u32: Uint32Array,
  u8: Uint8Array,
};

async function fetchWithProgress(url, onChunk) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
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

/** Slice one blob into the typed arrays its `views` table describes. */
function sliceViews(buffer, blob) {
  const arrays = {};
  for (const [key, view] of Object.entries(blob.views)) {
    const Type = ARRAY_TYPES[view.dtype];
    if (!Type) throw new Error(`unknown dtype "${view.dtype}" for ${blob.file}:${key}`);
    arrays[key] = new Type(buffer, view.offset, view.bytes / Type.BYTES_PER_ELEMENT);
  }
  return arrays;
}

/**
 * @param {string} url  the manifest itself (`.../asset.json`) or the directory holding
 *   a `bundle.json`. The blobs are always resolved next to the manifest, so a bundle
 *   stays movable and renameable as one directory.
 * @param {(loaded:number, total:number) => void} onProgress
 */
export async function loadBundle(url, onProgress = () => {}) {
  const trimmed = String(url).replace(/\/+$/, '');
  const manifestUrl = /\.json$/i.test(trimmed) ? trimmed : `${trimmed}/bundle.json`;
  const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/'));

  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`${manifestUrl}: ${response.status} ${response.statusText}`);
  }
  const meta = await response.json().catch(() => {
    throw new Error(`${manifestUrl} is not JSON - is that a bundle?`);
  });
  if (!meta.format?.startsWith('slf_web_bundle/')) {
    throw new Error(`${baseUrl} is not a web bundle (format "${meta.format}")`);
  }

  const blobs = Object.values(meta.buffers);
  const total = blobs.reduce((sum, blob) => sum + blob.bytes, 0);
  let loaded = 0;
  onProgress(0, total);

  // Sequential, not Promise.all: two parallel 20 MB streams make the progress bar
  // jump around and gain nothing over one connection.
  const arrays = {};
  for (const [name, blob] of Object.entries(meta.buffers)) {
    const buffer = await fetchWithProgress(`${baseUrl}/${blob.file}`, (bytes) => {
      loaded += bytes;
      onProgress(loaded, total);
    });
    arrays[name] = sliceViews(buffer, blob);
  }
  onProgress(total, total);
  return { meta, ...arrays };
}
