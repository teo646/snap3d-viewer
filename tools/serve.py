#!/usr/bin/env python
"""Static server for the repo, with gzip - open http://127.0.0.1:8000/demo/.

`python -m http.server` serves this viewer correctly and is a fine substitute on
localhost. The one thing it does not do is compress, and a bundle is ~40 MB of which
the largest part is a float16 atlas that gzips to roughly half - so over anything but
loopback, this is the difference between a viewer that opens and one that appears to
hang. Compressed responses are cached in memory, so a bundle is gzipped once per run,
not once per reload.

Usage:
    python tools/serve.py [--port 8000] [--bind 127.0.0.1]
"""

from __future__ import annotations

import argparse
import functools
import gzip
import io
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVE_ROOT = Path(__file__).resolve().parent.parent  # demo/ imports ../src, so serve both
COMPRESSIBLE = {".html", ".js", ".css", ".json", ".bin", ".svg"}
MIN_COMPRESS_BYTES = 1024

_cache: dict[tuple[str, float], bytes] = {}


class GzipHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = Path(self.translate_path(self.path))
        # The repo root is the document root, so .git and friends are inside it.
        if any(part.startswith(".") for part in path.relative_to(SERVE_ROOT).parts):
            self.send_error(404)
            return None
        if (
            path.suffix.lower() not in COMPRESSIBLE
            or not path.is_file()
            or "gzip" not in self.headers.get("Accept-Encoding", "")
        ):
            return super().send_head()

        stat = path.stat()
        if stat.st_size < MIN_COMPRESS_BYTES:
            return super().send_head()

        key = (str(path), stat.st_mtime)
        if key not in _cache:
            _cache.clear()  # only ever a handful of files; drop stale mtimes wholesale
            # level 6 on 40 MB is ~2 s once; the browser then reads it from cache anyway.
            _cache[key] = gzip.compress(path.read_bytes(), 6)
        body = _cache[key]

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")  # re-exported bundles must not stick
        self.end_headers()
        return io.BytesIO(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    handler = functools.partial(GzipHandler, directory=str(SERVE_ROOT))
    with ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"serving {SERVE_ROOT} at http://{args.bind}:{args.port}/demo/  (ctrl-c to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
