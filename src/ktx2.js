// KTX2 reader, the JS twin of pipeline/core/ktx2.py's `read_ktx2`.
//
// Only what the bundle writes: a single mip level, no cubemaps, no 3D textures,
// float16 or 8-bit UNORM samples, optional ZLIB supercompression. The payload is deliberately *not*
// block-compressed - SH coefficients and a height field are numeric data, not colours,
// and an 8-bit lossy codec on them shows up as banding in the parallax march.
//
// The supercompression is ZLIB (scheme 3) rather than Zstandard (2) precisely so this
// file needs no decoder: an RFC 1950 zlib datastream is what `DecompressionStream`
// calls "deflate", which every browser with WebGL2 has built in. Zstandard would cost
// a bundled JS decoder and a slower first paint for ~10% less download.
//
// Samples are handed back raw, not widened: float16 words as a Uint16Array, which
// gl.HALF_FLOAT takes bit for bit, and UNORM8 bytes as a Uint8Array for
// gl.UNSIGNED_BYTE. Decoding either would only be work to undo.

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

// vkFormat -> channels, for the float16 formats a WebGL2 consumer can sample. There is
// no plain R16G16B16_SFLOAT entry because there is no such WebGL format; 3-channel data
// is padded to RGBA by the writer.
const VK_SFLOAT16 = {
  76: 1,  // R16_SFLOAT
  83: 2,  // R16G16_SFLOAT
  97: 4,  // R16G16B16A16_SFLOAT
};

// 8-bit UNORM, what a bundle with `sh.storage: "unorm8"` writes for sh.ktx2. What the
// bytes mean (a per-coefficient offset and scale) lives in config.json, not here.
const VK_UNORM8 = {
  9: 1,   // R8_UNORM
  16: 2,  // R8G8_UNORM
  37: 4,  // R8G8B8A8_UNORM
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
 * @returns {Promise<{data: Uint16Array|Uint8Array, type: 'float16'|'unorm8', width: number,
 *                    height: number, layers: number, channels: number, isArray: boolean}>}
 *   `data` is raw samples - float16 words or UNORM8 bytes - row 0 first
 *   (KTXorientation "rd"), laid out [layer][row][column][channel].
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

  const type = VK_SFLOAT16[vkFormat] ? 'float16' : VK_UNORM8[vkFormat] ? 'unorm8' : null;
  if (!type) throw new Error(`vkFormat ${vkFormat} is not a float16 or UNORM8 format this reader handles`);
  const channels = type === 'float16' ? VK_SFLOAT16[vkFormat] : VK_UNORM8[vkFormat];
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

  let data;
  if (type === 'float16') {
    // Uint16Array over the buffer needs a 2-byte-aligned offset; an inflated level is its
    // own buffer starting at 0, and an uncompressed one starts on a 4-byte boundary.
    const aligned = level.byteOffset % 2 === 0 ? level : new Uint8Array(level);
    data = new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  } else {
    data = level;
  }

  // layerCount 0 is KTX2 for "not an array texture".
  return { data, type, width, height, layers: layerCount || 1, channels, isArray: layerCount > 0 };
}
