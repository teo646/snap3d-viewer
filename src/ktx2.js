// KTX2 reader, the JS twin of pipeline/core/ktx2.py's `read_ktx2`.
//
// Only what the bundle writes: a single mip level, no cubemaps, no 3D textures,
// float16 samples, optional ZLIB supercompression. The payload is deliberately *not*
// block-compressed - SH coefficients and a height field are numeric data, not colours,
// and an 8-bit lossy codec on them shows up as banding in the parallax march.
//
// The supercompression is ZLIB (scheme 3) rather than Zstandard (2) precisely so this
// file needs no decoder: an RFC 1950 zlib datastream is what `DecompressionStream`
// calls "deflate", which every browser with WebGL2 has built in. Zstandard would cost
// a bundled JS decoder and a slower first paint for ~10% less download.
//
// float16 words are handed back raw (Uint16Array), not widened: gl.HALF_FLOAT takes
// exactly these bits, so decoding them would only be work to undo.

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

// vkFormat -> channels, for the float16 formats a WebGL2 consumer can sample. There is
// no plain R16G16B16_SFLOAT entry because there is no such WebGL format; 3-channel data
// is padded to RGBA by the writer.
const VK_SFLOAT16 = {
  76: 1,  // R16_SFLOAT
  83: 2,  // R16G16_SFLOAT
  97: 4,  // R16G16B16A16_SFLOAT
};

const SUPERCOMPRESSION = { 0: null, 1: 'BasisLZ', 2: 'Zstandard', 3: 'ZLIB' };

/** Inflate an RFC 1950 zlib datastream using the browser's own decoder. */
async function inflate(bytes, expectedLength) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'DecompressionStream is unavailable, so the ZLIB-supercompressed texture cannot ' +
        'be read. It needs Chrome 80+, Firefox 113+ or Safari 16.4+.',
    );
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.byteLength !== expectedLength) {
    throw new Error(`inflated ${out.byteLength} bytes, level index says ${expectedLength}`);
  }
  return out;
}

/**
 * @param {ArrayBuffer} buffer  a .ktx2 file
 * @returns {Promise<{data: Uint16Array, width: number, height: number,
 *                    layers: number, channels: number, isArray: boolean}>}
 *   `data` is raw float16 words, row 0 first (KTXorientation "rd"), laid out
 *   [layer][row][column][channel].
 */
export async function readKtx2(buffer) {
  const bytes = new Uint8Array(buffer);
  if (IDENTIFIER.some((byte, i) => bytes[i] !== byte)) throw new Error('not a KTX2 file');

  const view = new DataView(buffer);
  const u32 = (offset) => view.getUint32(offset, true);
  // The header's two u64 fields are byte counts that never approach 2^53, so reading
  // them as a pair of u32s and folding is exact.
  const u64 = (offset) => u32(offset) + u32(offset + 4) * 4294967296;

  const vkFormat = u32(12);
  const width = u32(20);
  const height = u32(24);
  const depth = u32(28);
  const layerCount = u32(32);
  const faceCount = u32(36);
  const levelCount = u32(40);
  const scheme = u32(44);

  const channels = VK_SFLOAT16[vkFormat];
  if (!channels) throw new Error(`vkFormat ${vkFormat} is not a float16 format this reader handles`);
  if (depth || faceCount !== 1 || levelCount > 1) {
    throw new Error('only single-level 2D (array) textures are supported');
  }

  // The level index sits right after the 68-byte header: offset, byteLength, then the
  // uncompressed length.
  const levelOffset = u64(80);
  const levelBytes = u64(88);
  const uncompressed = u64(96);

  let level = new Uint8Array(buffer, levelOffset, levelBytes);
  if (scheme === 3) {
    level = await inflate(level, uncompressed);
  } else if (scheme !== 0) {
    throw new Error(`supercompression scheme ${scheme} (${SUPERCOMPRESSION[scheme] ?? 'unknown'}) is not supported`);
  }

  // Uint16Array over the buffer needs a 2-byte-aligned offset; an inflated level is its
  // own buffer starting at 0, and an uncompressed one starts on a 4-byte boundary.
  const aligned = level.byteOffset % 2 === 0 ? level : new Uint8Array(level);
  const data = new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);

  // layerCount 0 is KTX2 for "not an array texture".
  return { data, width, height, layers: layerCount || 1, channels, isArray: layerCount > 0 };
}
