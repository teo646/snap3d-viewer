#!/usr/bin/env python
"""Build the fanned photo stack the landing page shows beside each render.

The point of the picture is provenance: *this* set of images produced *that* surface.
So the five cards are chosen for how much of the subject they show, not by index - a
NeRF set's frames include steep angles where the object is a speck, and a pile of five
near-empty cards says nothing about what was captured - and they are laid back in
capture order so the pile still reads as a walk around the subject.

Usage:
    python tools/make_input_stacks.py [--runs <dir>] [--out pages/inputs]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUNS = ROOT.parent / "snap3d" / "data" / "runs"

# The name the page knows a bundle by -> where that run's ingest images live.
#
# The two photo captures are named for their subject rather than for the run that
# produced them, because a landing page reads better than `photo_20260904_152839` does.
# That makes this table the one place the subject name and the pipeline run id are
# written side by side, so keep it that way: it is what tells you which run to re-export
# a bundle from.
IMAGE_SETS = {
    "framed_painting": "photo_20260904_152839/01_ingest/images/train",
    "model_house": "photo_20260904_000809/01_ingest/images/photos",
    "nerf_chair": "nerf_chair/01_ingest/images",
    "nerf_ship": "nerf_ship/01_ingest/images",
}

CARD = 300                              # long side of one card, at 2x for retina
ANGLES = [-7.0, -3.5, 0.0, 3.5, 7.0]
STEP = 190                              # ~35% overlap: enough to read as a pile, little
BORDER = 4                              # enough to hide the card behind it
BACKDROP = (18, 18, 22)                 # what a matted frame sits on, instead of black
SUFFIXES = {".jpg", ".jpeg", ".png"}


def load(path: Path) -> Image.Image:
    # exif_transpose first: a phone writes the sensor's own landscape frame plus an
    # Orientation tag, and PIL honours neither on its own - without this every portrait
    # capture ends up on its side.
    image = ImageOps.exif_transpose(Image.open(path))
    if image.mode not in ("RGBA", "LA", "P"):
        return image.convert("RGB")
    image = image.convert("RGBA")
    flat = Image.new("RGB", image.size, BACKDROP)
    flat.paste(image, mask=image.getchannel("A"))
    return flat


def subject_score(path: Path) -> float:
    """How much subject a frame shows: matte coverage where there is one, else the
    spread of its luminance, which on these captures tracks the same thing."""
    probe = ImageOps.exif_transpose(Image.open(path))
    probe.thumbnail((160, 160), Image.NEAREST)
    if probe.mode in ("RGBA", "LA", "P"):
        return float(np.asarray(probe.convert("RGBA").getchannel("A"), dtype=np.float32).mean() / 255)
    return float(np.asarray(probe.convert("L"), dtype=np.float32).std() / 255)


def stack(paths: list[Path]) -> Image.Image:
    cards = []
    for path, angle in zip(paths, ANGLES):
        image = load(path)
        image.thumbnail((CARD, CARD), Image.LANCZOS)
        framed = Image.new("RGB", (image.width + BORDER * 2, image.height + BORDER * 2), (232, 232, 234))
        framed.paste(image, (BORDER, BORDER))
        card = framed.rotate(angle, expand=True, resample=Image.BICUBIC).convert("RGBA")
        # rotate() fills the new corners opaquely; the alpha has to come from a mask
        # rotated the same way, or every card carries black triangles.
        card.putalpha(Image.new("L", framed.size, 255).rotate(angle, expand=True, resample=Image.BICUBIC))
        cards.append(card)

    width = STEP * (len(cards) - 1) + max(card.width for card in cards)
    height = max(card.height for card in cards)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for index, card in enumerate(cards):  # back to front
        canvas.alpha_composite(card, (index * STEP, (height - card.height) // 2))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=Path, default=DEFAULT_RUNS, help="the pipeline's data/runs directory")
    parser.add_argument("--out", type=Path, default=ROOT / "pages" / "inputs")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    for name, relative in IMAGE_SETS.items():
        folder = args.runs / relative
        if not folder.is_dir():
            print(f"  {name:24s} skipped - no {folder}")
            continue
        files = sorted(p for p in folder.iterdir() if p.suffix.lower() in SUFFIXES)
        # Score a spread of candidates rather than all of them: at 100 frames the
        # ranking is the same and it reads a twentieth of the pixels.
        probes = [files[round(i * (len(files) - 1) / 23)] for i in range(24)]
        # Drop the half that shows least of the subject, then take five spread evenly
        # across what is left. Taking the top five outright bunches them: consecutive
        # frames of a slow orbit score alike, and five near-identical cards look like a
        # mistake rather than a capture.
        scores = sorted(probes, key=subject_score, reverse=True)
        keep = sorted(scores[: max(len(ANGLES), len(scores) // 2)], key=files.index)
        chosen = [keep[round(i * (len(keep) - 1) / (len(ANGLES) - 1))] for i in range(len(ANGLES))]
        image = stack(chosen)
        target = args.out / f"{name}.webp"
        image.save(target, "WEBP", quality=88, method=6)
        print(f"  {name:24s} {len(files):>3} images -> {image.width}x{image.height}  {target.stat().st_size / 1024:5.1f} kB")


if __name__ == "__main__":
    main()
