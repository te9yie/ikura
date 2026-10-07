# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""アプリのアイコンを描いて icons/ にPNGで書き出す。

    uv run scripts/make_icons.py

暗い灰色の地に、いくら色の粒を1つ置く。色は style.css の :root から読む。
書き出したPNGはコミットする。GitHub Pagesではこのスクリプトは動かないためである。
"""

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
STYLE_PATH = ROOT / "style.css"
ICONS_DIR = ROOT / "icons"

# 一辺512に対する座標。粒の外周は中心から168で、maskable の安全な範囲（半径204.8）に収まる
BASE = 512
GRAIN = (256, 256, 168)
CORE = (286, 286, 60)
SHINE = (196, 196, 34)
# 粒の芯の色。いくら色を暗くしたもので、style.css にはない
CORE_COLOR = "#c0441e"

# 大きく描いてから縮め、円の縁をなめらかにする
SUPERSAMPLE = 4

OUTPUTS = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    "apple-touch-icon.png": 180,
    "favicon-32.png": 32,
}


def read_colors(css):
    """style.css の :root から --bg・--ikura・--v2 を読む。見つからなければ止める。"""
    root = re.search(r":root\s*\{([^}]*)\}", css)
    if root is None:
        sys.exit("style.css に :root がない")
    colors = {}
    for name in ("bg", "ikura", "v2"):
        match = re.search(rf"--{name}\s*:\s*(#[0-9a-fA-F]{{6}})\s*;", root.group(1))
        if match is None:
            sys.exit(f"style.css の :root に --{name} の色がない")
        colors[name] = match.group(1)
    return colors


def draw_icon(size, colors):
    canvas = size * SUPERSAMPLE
    scale = canvas / BASE
    image = Image.new("RGB", (canvas, canvas), colors["bg"])
    draw = ImageDraw.Draw(image)
    for (x, y, r), color in ((GRAIN, colors["ikura"]), (CORE, CORE_COLOR), (SHINE, colors["v2"])):
        draw.ellipse(((x - r) * scale, (y - r) * scale, (x + r) * scale, (y + r) * scale), fill=color)
    return image.resize((size, size), Image.LANCZOS)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    colors = read_colors(STYLE_PATH.read_text(encoding="utf-8"))
    ICONS_DIR.mkdir(exist_ok=True)
    for name, size in OUTPUTS.items():
        path = ICONS_DIR / name
        draw_icon(size, colors).save(path, optimize=True)
        print(f"{path.relative_to(ROOT).as_posix()} {size}×{size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
