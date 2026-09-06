#!/usr/bin/env python
"""Convert an export bundle into the flat binary form the WebGL viewer fetches.

The pipeline's bundle is three files aimed at numpy (`config.json`, `mesh.npz`,
`texture.npz`); a browser can read none of them. This script is the whole adapter:
it unzips the npz payloads into plain little-endian buffers, narrows the float32
textures to float16 (halves the download; see `--full-precision` for the cost), and
writes one `bundle.json` describing where every array landed.

Two things it does *not* just copy through:

* The per-vertex frame. `view_bundle.py` recomputes normals and raw dP/du, dP/dv at
  load time because the bundle ships none, and getting them subtly wrong is the one
  way to get subtly wrong colours everywhere. Rather than port
  `vertex_frame_attributes` (and trimesh's smooth-normal fallback) to JavaScript, we
  call the pipeline's own function here and ship the result: ~2.3 MB against a ~35 MB
  payload, in exchange for the frame being identical by construction rather than by
  review.
* The v flip. `camera_raster.to_gl_texture` flips every atlas raster so row 0 lands at
  v=0, matching GL's bottom-left texture origin. WebGL's `UNPACK_FLIP_Y_WEBGL` does not
  apply to `texSubImage3D` layers, so the flip happens here for all three textures and
  the shader samples with the mesh's own uv, exactly as the desktop viewer does.

Usage:
    python tools/export_web_bundle.py <run>/10_export [-o demo/bundles/<name>]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PIPELINE_ROOT = ROOT.parent / "3d_recon_sh_texture"
BUNDLE_FORMAT = "slf_web_bundle/1"


def import_pipeline(pipeline_root: Path):
    """The two pipeline entry points this converter refuses to reimplement."""
    if not (pipeline_root / "pipeline").is_dir():
        sys.exit(
            f"Error: no `pipeline/` package under {pipeline_root}.\n"
            "Point --pipeline-root (or $SLF_PIPELINE_ROOT) at a checkout of the "
            "sh-texture-pipeline repo."
        )
    sys.path.insert(0, str(pipeline_root))
    try:
        from pipeline.core import slf_shaders
        from pipeline.core.uv_geometry import vertex_frame_attributes
        from pipeline.schemas.uv_mesh import UVMesh
    except ImportError as exc:  # trimesh & co. live in the pipeline's env, not ours
        sys.exit(f"Error: cannot import the pipeline ({exc}).\nRun this with the pipeline's interpreter.")
    return slf_shaders, vertex_frame_attributes, UVMesh


def glsl_sha256(slf_shaders) -> str:
    """Fingerprint of the GLSL the viewer's `shaders.js` was ported from. Stored in
    `bundle.json` so the viewer can shout when the pipeline's shaders have moved on."""
    source = slf_shaders.VERTEX_SHADER + slf_shaders.RESOLVE_GLSL + slf_shaders.EVAL_SH_GLSL
    return hashlib.sha256(source.encode()).hexdigest()


class BlobWriter:
    """Appends arrays to one file, recording each one's offset and shape."""

    def __init__(self, path: Path, name: str):
        self.path, self.name, self.views, self._offset = path, name, {}, 0
        self._fh = path.open("wb")

    def add(self, key: str, array: np.ndarray, dtype: str) -> None:
        data = np.ascontiguousarray(array, dtype=dtype)
        # A typed-array view over the blob must start on a multiple of its element
        # size, so pad to 4 bytes: the loader slices in place rather than copying, and
        # a misaligned view is a RangeError at load, not a slow path.
        if pad := -self._offset % 4:
            self._fh.write(b"\0" * pad)
            self._offset += pad
        self._fh.write(data.tobytes())
        self.views[key] = {
            "offset": self._offset,
            "bytes": data.nbytes,
            "dtype": {"float32": "f32", "float16": "f16", "uint32": "u32", "uint8": "u8"}[str(data.dtype)],
            "shape": list(data.shape),
        }
        self._offset += data.nbytes

    def close(self) -> dict:
        self._fh.close()
        return {"file": self.path.name, "bytes": self._offset, "views": self.views}


def convert(bundle_dir: Path, out_dir: Path, pipeline_root: Path, full_precision: bool) -> dict:
    slf_shaders, vertex_frame_attributes, UVMesh = import_pipeline(pipeline_root)

    config = json.loads((bundle_dir / "config.json").read_text())
    files = config["files"]
    mesh = np.load(bundle_dir / files["mesh"])
    texture = np.load(bundle_dir / files["texture"])
    sh, height, valid = texture["sh"], texture["height"], texture["valid"]

    tex_w, tex_h = config["texture_resolution"]
    k_coeffs = int(sh.shape[2])
    tex_dtype = "float32" if full_precision else "float16"

    # vertex_normals=None on purpose: the bundle ships no frame, so this is the path
    # `view_bundle.py` takes, and the frame must come out of the identical branch.
    uv_mesh = UVMesh(
        vertices=mesh["position"].astype(np.float64),
        faces=mesh["indices"].astype(np.int64),
        uv=mesh["uv"],
        vertex_normals=None,
        texture_resolution=(tex_w, tex_h),
    )
    normals, tangent_raw, bitangent_raw = vertex_frame_attributes(uv_mesh)

    out_dir.mkdir(parents=True, exist_ok=True)

    geometry = BlobWriter(out_dir / "geometry.bin", "geometry")
    geometry.add("position", mesh["position"], "float32")
    geometry.add("uv", mesh["uv"], "float32")
    geometry.add("normal", normals, "float32")
    geometry.add("tangent", tangent_raw, "float32")
    geometry.add("bitangent", bitangent_raw, "float32")
    geometry.add("indices", mesh["indices"], "uint32")  # 65k verts: 16-bit indices would wrap

    # (H, W, K, 3) -> (K, H, W, 4), v flipped, alpha padded: one RGBA layer per SH
    # coefficient, in the memory order texSubImage3D wants for a TEXTURE_2D_ARRAY.
    layers = np.zeros((k_coeffs, tex_h, tex_w, 4), dtype=tex_dtype)
    layers[..., :3] = np.transpose(np.flipud(sh), (2, 0, 1, 3)).astype(tex_dtype)

    textures = BlobWriter(out_dir / "textures.bin", "textures")
    textures.add("sh", layers, tex_dtype)
    textures.add("height", np.flipud(height), tex_dtype)
    textures.add("valid", np.flipud(valid).astype(np.uint8) * 255, "uint8")

    web_bundle = {
        "format": BUNDLE_FORMAT,
        "name": out_dir.name,
        "source": {"bundle_dir": str(bundle_dir), "format": config["format"]},
        "sh_degree": config["sh_degree"],
        "k_coeffs": k_coeffs,
        "texture_resolution": [tex_w, tex_h],
        "texture_precision": "f32" if full_precision else "f16",
        "height": config["height"],
        "up_vector": config["up_vector"],
        "initial_camera": config["initial_camera"],
        "mesh": config["mesh"],
        "coverage": float(valid.mean()),
        # The viewer's shaders.js is a hand port of these; a mismatch means the port
        # is stale and the colours may be quietly wrong.
        "glsl_sha256": glsl_sha256(slf_shaders),
        "buffers": {"geometry": geometry.close(), "textures": textures.close()},
    }
    (out_dir / "bundle.json").write_text(json.dumps(web_bundle, indent=2) + "\n")
    return web_bundle


def write_index(bundles_dir: Path) -> list[str]:
    """`bundles/index.json` - what the viewer offers when no ?bundle= is given."""
    names = sorted(p.parent.name for p in bundles_dir.glob("*/bundle.json"))
    (bundles_dir / "index.json").write_text(json.dumps({"bundles": names}, indent=2) + "\n")
    return names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bundle_dir", type=Path, help="an export stage dir, e.g. data/runs/<run_id>/10_export")
    parser.add_argument("-o", "--out", type=Path, help="output dir (default: demo/bundles/<run_id>)")
    parser.add_argument(
        "--pipeline-root",
        type=Path,
        default=Path(os.environ.get("SLF_PIPELINE_ROOT", DEFAULT_PIPELINE_ROOT)),
        help="checkout of the sh-texture-pipeline repo (default: $SLF_PIPELINE_ROOT or ../3d_recon_sh_texture)",
    )
    parser.add_argument(
        "--full-precision",
        action="store_true",
        help="keep the atlas textures at float32 (~2x the download; only the top ~0.01%% of "
        "SH coefficients, |c| > 25, lose anything visible to float16)",
    )
    parser.add_argument("--force", action="store_true", help="overwrite an existing output dir")
    args = parser.parse_args()

    bundle_dir = args.bundle_dir.resolve()
    missing = [n for n in ("config.json", "mesh.npz", "texture.npz") if not (bundle_dir / n).exists()]
    if missing:
        sys.exit(f"Error: {bundle_dir} is not an export bundle - missing {', '.join(missing)}")

    # <run_id>/10_export -> <run_id>, which is the name a human recognizes.
    default_name = bundle_dir.parent.name if bundle_dir.name.endswith("_export") else bundle_dir.name
    out_dir = (args.out or ROOT / "demo" / "bundles" / default_name).resolve()
    if out_dir.exists() and not args.force:
        sys.exit(f"Error: {out_dir} already exists (pass --force to overwrite)")
    if out_dir.exists():
        shutil.rmtree(out_dir)

    web_bundle = convert(bundle_dir, out_dir, args.pipeline_root.resolve(), args.full_precision)
    total = sum(b["bytes"] for b in web_bundle["buffers"].values())
    names = write_index(out_dir.parent) if out_dir.parent.name == "bundles" else []

    print(
        f"{web_bundle['mesh']['vertices']} verts, {web_bundle['mesh']['faces']} faces  |  "
        f"SH degree {web_bundle['sh_degree']} ({web_bundle['k_coeffs']} coeffs)  |  "
        f"{web_bundle['texture_resolution'][0]}x{web_bundle['texture_resolution'][1]} "
        f"{web_bundle['texture_precision']}  |  covered texels {web_bundle['coverage'] * 100:.1f}%"
    )
    print(f"wrote {out_dir}  ({total / 1e6:.1f} MB)")
    if names:
        print(f"bundles: {', '.join(names)}")


if __name__ == "__main__":
    main()
