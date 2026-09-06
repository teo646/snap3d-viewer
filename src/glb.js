// Geometry-only glTF Binary reader, the JS twin of pipeline/core/gltf.py's `read_glb`.
//
// The bundle's GLB carries positions, UVs and indices and nothing else - no normals,
// no tangents, no texture, because the surface's appearance is the SH texture plus the
// parallax march and no glTF material can express that. So this is not a glTF importer:
// it reads the first primitive of the first mesh, in the one tightly-packed layout the
// writer produces, and refuses anything else rather than silently mis-reading it.

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENTS = {
  5126: Float32Array, // FLOAT
  5125: Uint32Array,  // UNSIGNED_INT
  5123: Uint16Array,  // UNSIGNED_SHORT - not written here, but cheap to accept
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3 };

/**
 * @param {ArrayBuffer} buffer  a .glb file
 * @returns {{positions: Float32Array, uv: Float32Array, indices: Uint32Array,
 *            vertexCount: number, faceCount: number}}
 */
export function readGlb(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 binary file');
  }

  const chunks = new Map();
  for (let offset = 12; offset + 8 <= buffer.byteLength; ) {
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    chunks.set(kind, { offset: offset + 8, length });
    offset += 8 + length;
  }
  const json = chunks.get(CHUNK_JSON);
  const bin = chunks.get(CHUNK_BIN);
  if (!json || !bin) throw new Error('glb is missing its JSON or BIN chunk');

  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, json.offset, json.length)));

  const fetchAccessor = (index) => {
    const accessor = gltf.accessors[index];
    const bufferView = gltf.bufferViews[accessor.bufferView];
    if (bufferView.byteStride !== undefined || accessor.sparse) {
      throw new Error('strided or sparse accessors are not supported');
    }
    const Type = COMPONENTS[accessor.componentType];
    if (!Type) throw new Error(`unsupported componentType ${accessor.componentType}`);
    const width = WIDTHS[accessor.type];
    if (!width) throw new Error(`unsupported accessor type ${accessor.type}`);

    const start = bin.offset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count * width;
    // A typed array view needs its offset aligned to the element size. The writer packs
    // every view on a 4-byte boundary, so this only ever copies for a malformed file.
    if (start % Type.BYTES_PER_ELEMENT === 0) return new Type(buffer, start, count);
    return new Type(buffer.slice(start, start + count * Type.BYTES_PER_ELEMENT));
  };

  const primitive = gltf.meshes?.[0]?.primitives?.[0];
  if (!primitive) throw new Error('glb has no mesh primitive');
  const positions = fetchAccessor(primitive.attributes.POSITION);
  const uv = fetchAccessor(primitive.attributes.TEXCOORD_0);
  let indices = fetchAccessor(primitive.indices);
  // The writer emits UNSIGNED_INT, but widen rather than fail on a mesh small enough
  // that some other exporter wrote 16-bit indices.
  if (!(indices instanceof Uint32Array)) indices = Uint32Array.from(indices);

  return {
    positions,
    uv,
    indices,
    vertexCount: positions.length / 3,
    faceCount: indices.length / 3,
  };
}
