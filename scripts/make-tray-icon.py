#!/usr/bin/env python3
"""Copies the menu bar icons (macOS "template" images) into src/assets/.

The PNGs are rendered from build/tray.svg (pure black, the drawing lives in the alpha).
"""

import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "build", "icons")
ASSETS = os.path.join(ROOT, "src", "assets")


def main():
    os.makedirs(ASSETS, exist_ok=True)
    for name in ("trayTemplate.png", "trayTemplate@2x.png"):
        shutil.copyfile(os.path.join(ICONS, name), os.path.join(ASSETS, name))
        print(os.path.join(ASSETS, name))


if __name__ == "__main__":
    main()
