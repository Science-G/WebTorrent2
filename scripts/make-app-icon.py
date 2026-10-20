#!/usr/bin/env python3
"""Builds build/icon.icns and build/icon.png from build/icons/, standard library only.

The PNGs in build/icons/ are rendered from build/logo.svg, then downscaled (Lanczos).
"""

import os
import shutil
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
ICONS = os.path.join(BUILD, "icons")

# icns type -> PNG size in pixels
MAPPING = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic13", 256),
    (b"ic09", 512),
    (b"ic14", 512),
    (b"ic10", 1024),
]


def read_png(size):
    path = os.path.join(ICONS, f"icon-{size}.png")
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"invalid PNG: {path}")
    width, height = struct.unpack(">II", data[16:24])
    if (width, height) != (size, size):
        raise SystemExit(f"{path} is {width}x{height}, expected {size}x{size}")
    return data


def main():
    chunks = []
    for kind, size in MAPPING:
        data = read_png(size)
        chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)

    target = os.path.join(BUILD, "icon.icns")
    with open(target, "wb") as handle:
        handle.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    shutil.copyfile(os.path.join(ICONS, "icon-1024.png"), os.path.join(BUILD, "icon.png"))

    print(f"{target}: {len(body) + 8} bytes, {len(MAPPING)} images")


if __name__ == "__main__":
    main()
