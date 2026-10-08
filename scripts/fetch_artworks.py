# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Art Institute of ChicagoとMetropolitan Museum of Artから、パブリックドメインの絵画を取ってきて、
artworks/ に画像と index.json を書く。

    uv run scripts/fetch_artworks.py                # index.json が30枚になるまで足す
    uv run scripts/fetch_artworks.py --count 300
    uv run scripts/fetch_artworks.py --offline      # ネットワークに出ず、キャッシュだけで判定する

キャッシュと確認用の .cache/review.html は .cache/ に置く。
"""

import argparse
import hashlib
import html
import http.client
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
ARTWORKS_DIR = ROOT / "artworks"
INDEX_PATH = ARTWORKS_DIR / "index.json"
EXCLUDED_PATH = ROOT / "scripts" / "excluded.txt"
CACHE_DIR = ROOT / ".cache"
RECORDS_DIR = CACHE_DIR / "records"
IMG_DIR = CACHE_DIR / "img"
CANDIDATES_PATH = CACHE_DIR / "candidates.json"
REVIEW_PATH = CACHE_DIR / "review.html"
ANALYSIS_PATH = CACHE_DIR / "analysis.json"

USER_AGENT = "ikura-fetch/1 (+https://github.com/te9yie/ikura)"
AIC_USER_AGENT = "ikura (https://github.com/te9yie/ikura)"
TIMEOUT = 60
# 同じ館へのリクエストの間隔（秒）。APIと画像を区別しない。
INTERVALS = {"aic": 1.0, "met": 0.5}
RETRY_WAITS = (10, 30, 90)
MAX_CONSECUTIVE_SKIPS = 10

MUSEUMS = ("met", "aic")
MUSEUM_NAMES = {
    "met": "The Metropolitan Museum of Art",
    "aic": "Art Institute of Chicago",
}

AIC_SEARCH_URL = "https://api.artic.edu/api/v1/artworks/search"
AIC_SEARCH_PARAMS = [
    ("query[bool][must][0][term][is_public_domain]", "true"),
    ("query[bool][must][1][term][artwork_type_id]", "1"),
    ("query[bool][must][2][exists][field]", "image_id"),
    ("fields", "id,title,artist_title,artist_display,image_id,thumbnail,is_public_domain"),
    ("sort[id][order]", "asc"),
]
# 検索は offset が1000に届くと（limit=100 で page=11）403 "Invalid number of results" を返す。
# page は1のままにし、前に取った最後のIDより大きいIDを条件にして続きを取る。
AIC_SEARCH_AFTER = "query[bool][must][3][range][id][gt]"
AIC_SEARCH_LIMIT = 100
AIC_IIIF_URL = "https://www.artic.edu/iiif/2/{image_id}/full/{width},/0/default.jpg"
MET_SEARCH_URL = "https://collectionapi.metmuseum.org/public/collection/v1.1/search"
MET_SEARCH_LIMIT = 500
MET_SEARCH_MAX = 10000
MET_OBJECT_URL = "https://collectionapi.metmuseum.org/public/collection/v1/objects/{id}"

LONG_SIDE = 800
SHORT_SIDE = 600
# 向きごとのマス目の (cols, rows)。明暗の幅は粗いほうで見る
GRIDS = {"landscape": (16, 12), "portrait": (12, 16)}
FINE_GRIDS = {"landscape": (24, 18), "portrait": (18, 24)}
# AICのIIIFで843幅を取ると、横長で縦横比がこれを超えたとき4:3に切った幅が800pxに届かない。
AIC_WIDE_ASPECT = 843 / 800 * 4 / 3


# ---- 計算（ネットワークやファイルに触らない） ----


def _srgb_to_linear(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


LINEAR = [_srgb_to_linear(c) for c in range(256)]
_EPSILON = 216 / 24389
_KAPPA = 24389 / 27


def luminance_to_lightness(y):
    f = y ** (1 / 3) if y > _EPSILON else (_KAPPA * y + 16) / 116
    return 116 * f - 16


def srgb_to_lightness(r, g, b):
    return luminance_to_lightness(0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b])


def crop_box(w, h):
    """元の大きさから、向き、切り抜いたあとに残る面積の割合、中央の切り抜き枠を返す。"""
    if w >= h:
        orientation, r = "landscape", 4 / 3
    else:
        orientation, r = "portrait", 3 / 4
    a = w / h
    keep = min(a / r, r / a)
    if a > r:
        cw = round(h * r)
        left = (w - cw) // 2
        box = (left, 0, left + cw, h)
    else:
        ch = round(w / r)
        top = (h - ch) // 2
        box = (0, top, w, top + ch)
    return orientation, keep, box


def size_check(w, h, min_keep):
    """縦横比か大きさで外すなら (理由, 表示用の値) を、外さないなら (None, "") を返す。"""
    _, keep, (left, top, right, bottom) = crop_box(w, h)
    if keep < min_keep:
        return "aspect", f"keep={keep:.2f}"
    if max(right - left, bottom - top) < LONG_SIDE:
        return "too_small", f"size={w}x{h}"
    return None, ""


def cell_means(lightness, width, height, cols, rows):
    """ピクセルごとのL*（行優先の一次元リスト）から、行優先のマスの平均を返す。"""
    xs = [c * width // cols for c in range(cols + 1)]
    ys = [r * height // rows for r in range(rows + 1)]
    means = []
    for r in range(rows):
        sums = [0.0] * cols
        for y in range(ys[r], ys[r + 1]):
            base = y * width
            for c in range(cols):
                sums[c] += sum(lightness[base + xs[c] : base + xs[c + 1]])
        n_rows = ys[r + 1] - ys[r]
        means.extend(s / ((xs[c + 1] - xs[c]) * n_rows) for c, s in enumerate(sums))
    return means


def classify(means):
    """マスの平均を明るさの順に三等分し、(行優先の "0"/"1"/"2" の文字列, 明暗の幅) を返す。

    境目に同じ値が並んだときは、同じ値を同じ記号にする。暗と明の境目が重なったら暗を優先する。
    """
    n = len(means)
    k = n // 3
    if k == 0:
        raise ValueError("マスが3つより少ない")
    s = sorted(means)
    t_dark, t_light = s[k - 1], s[n - k]
    answer, dark, light = [], [], []
    for v in means:
        if v <= t_dark:
            answer.append("0")
            dark.append(v)
        elif v >= t_light:
            answer.append("2")
            light.append(v)
        else:
            answer.append("1")
    spread = sum(light) / len(light) - sum(dark) / len(dark) if light else 0.0
    return "".join(answer), spread


def order_key(artwork_id):
    return hashlib.sha256(("ikura:" + artwork_id).encode()).hexdigest()


def merge_index(existing, excluded, new_entries):
    """前からある作品の順番を保ったまま、外すIDを除き、新しいものを末尾に足す。"""
    merged, seen = [], set()
    for entry in [*existing, *new_entries]:
        if entry["id"] in excluded or entry["id"] in seen:
            continue
        seen.add(entry["id"])
        merged.append(entry)
    return merged


def parse_excluded(text):
    ids = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            ids.add(line)
    return ids


def aic_image_width(record):
    thumb = record.get("thumbnail") or {}
    w, h = thumb.get("width"), thumb.get("height")
    if w and h and w / h > AIC_WIDE_ASPECT:
        return 1686
    return 843


# AICは作者が分からない絵の artist_display に、空ではなくこの文字を入れてくる
UNKNOWN_ARTISTS = {"artist unknown", "unknown", "unknown artist"}


def clean_artist(artist):
    artist = artist.strip()
    return "" if artist.lower() in UNKNOWN_ARTISTS else artist


def make_entry(artwork_id, record, orientation, answer, fine):
    museum, number = artwork_id.split("-", 1)
    if museum == "met":
        title = record.get("title") or ""
        artist = record.get("artistDisplayName") or ""
        url = record.get("objectURL") or f"https://www.metmuseum.org/art/collection/search/{number}"
    else:
        title = record.get("title") or ""
        artist = record.get("artist_title") or (record.get("artist_display") or "").split("\n", 1)[0]
        url = f"https://www.artic.edu/artworks/{number}"
    cols, rows = GRIDS[orientation]
    return {
        "id": artwork_id,
        "image": f"{artwork_id}.jpg",
        "title": title.strip(),
        "artist": clean_artist(artist),
        "museum": MUSEUM_NAMES[museum],
        "url": url,
        "orientation": orientation,
        "cols": cols,
        "rows": rows,
        "answer": answer,
        "fine": fine,
    }


def validate(artworks, image_dir):
    errors, seen = [], set()
    for entry in artworks:
        artwork_id = entry.get("id")
        if artwork_id in seen:
            errors.append(f"{artwork_id}: IDが重なっている")
        seen.add(artwork_id)
        answer = entry.get("answer", "")
        if len(answer) != entry.get("cols", 0) * entry.get("rows", 0):
            errors.append(f"{artwork_id}: answer の長さが cols×rows と合わない")
        if set(answer) - set("012"):
            errors.append(f"{artwork_id}: answer に 0・1・2 以外の文字がある")
        fine = entry.get("fine") or {}
        fine_answer = fine.get("answer", "")
        if not fine_answer or len(fine_answer) != fine.get("cols", 0) * fine.get("rows", 0):
            errors.append(f"{artwork_id}: fine.answer がないか、長さが fine.cols×fine.rows と合わない")
        if set(fine_answer) - set("012"):
            errors.append(f"{artwork_id}: fine.answer に 0・1・2 以外の文字がある")
        if not (image_dir / entry.get("image", "")).is_file():
            errors.append(f"{artwork_id}: 画像がない")
    return errors


# ---- ネットワーク ----


class Blocked(Exception):
    """AICのIIIFでCloudflareのチャレンジが返った。"""


class NotFound(Exception):
    pass


class FetchFailed(Exception):
    pass


class Client:
    def __init__(self):
        self._last = {}

    def _wait(self, museum):
        last = self._last.get(museum)
        if last is not None:
            rest = INTERVALS[museum] - (time.monotonic() - last)
            if rest > 0:
                time.sleep(rest)

    def get(self, museum, url):
        headers = {"User-Agent": USER_AGENT}
        if museum == "aic":
            headers["AIC-User-Agent"] = AIC_USER_AGENT
        request = urllib.request.Request(url, headers=headers)
        error = ""
        for attempt in range(len(RETRY_WAITS) + 1):
            if attempt:
                wait = RETRY_WAITS[attempt - 1]
                print(f"        {error}。{wait}秒待って取り直す: {url}")
                time.sleep(wait)
            self._wait(museum)
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                    return response.read()
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise NotFound(url) from e
                if museum == "aic" and e.code == 403 and (e.headers.get("Cf-Mitigated") or "").lower() == "challenge":
                    raise Blocked(url) from e
                if not (e.code == 429 or e.code >= 500 or (museum == "met" and e.code == 403)):
                    raise FetchFailed(f"HTTP {e.code}: {url}") from e
                error = f"HTTP {e.code}"
            except (OSError, http.client.HTTPException) as e:
                error = f"{type(e).__name__}: {e}"
            finally:
                self._last[museum] = time.monotonic()
        raise FetchFailed(f"{error}: {url}")

    def get_json(self, museum, url):
        try:
            return json.loads(self.get(museum, url))
        except ValueError as e:
            raise FetchFailed(f"JSONでない: {url}") from e


def list_aic(client):
    records = []
    last_id = 0
    while True:
        query = urllib.parse.urlencode(
            [*AIC_SEARCH_PARAMS, (AIC_SEARCH_AFTER, str(last_id)), ("limit", str(AIC_SEARCH_LIMIT)), ("page", "1")]
        )
        page = client.get_json("aic", f"{AIC_SEARCH_URL}?{query}")["data"]
        records.extend(page)
        if len(page) < AIC_SEARCH_LIMIT:
            break
        last_id = page[-1]["id"]
    ids = []
    for record in records:
        record.pop("_score", None)
        artwork_id = f"aic-{record['id']}"
        # 前の実行で書き足した source_size と not_found は残す。
        old = load_record(artwork_id)
        if old:
            for key in ("source_size", "not_found"):
                if key in old:
                    record[key] = old[key]
        if record != old:
            save_record(artwork_id, record)
        ids.append(artwork_id)
    return ids


def list_met(client):
    ids = []
    offset = 0
    while True:
        query = urllib.parse.urlencode(
            {"departmentId": 11, "hasImages": "true", "offset": offset, "limit": MET_SEARCH_LIMIT}
        )
        data = client.get_json("met", f"{MET_SEARCH_URL}?{query}")
        ids.extend(f"met-{n}" for n in data.get("objectIDs") or [])
        offset += MET_SEARCH_LIMIT
        if offset >= min(data["total"], MET_SEARCH_MAX):
            break
    return ids


LISTERS = {"aic": list_aic, "met": list_met}


# ---- キャッシュとファイル ----


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, data, indent=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
        f.write("\n")
    os.replace(tmp, path)


def load_record(artwork_id):
    return load_json(RECORDS_DIR / f"{artwork_id}.json")


def save_record(artwork_id, record):
    write_json(RECORDS_DIR / f"{artwork_id}.json", record)


def load_index():
    data = load_json(INDEX_PATH, {"version": 1, "artworks": []})
    return data["artworks"]


def write_index(artworks):
    write_json(INDEX_PATH, {"version": 1, "artworks": artworks}, indent=2)


def load_excluded():
    try:
        return parse_excluded(EXCLUDED_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set()


# ---- 画像 ----


def open_image(data):
    # Metの原寸は大きく、既定の上限では爆弾画像として止まる。配布元は信用する。
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(io.BytesIO(data)) as im:
        im.draft("RGB", (1600, 1600))
        return ImageOps.exif_transpose(im).convert("RGB")


def save_cropped(im, path):
    orientation, _, box = crop_box(*im.size)
    size = (LONG_SIDE, SHORT_SIDE) if orientation == "landscape" else (SHORT_SIDE, LONG_SIDE)
    out = im.crop(box).resize(size, Image.Resampling.LANCZOS)
    out.info = {}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    out.save(tmp, "JPEG", quality=85, optimize=True, progressive=True)
    os.replace(tmp, path)


def image_lightness(path):
    """保存した画像から (幅, 高さ, 向き, ピクセルごとのL*の行優先のリスト) を出す。"""
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        data = im.tobytes()
    lin = LINEAR
    lightness = [
        luminance_to_lightness(0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b])
        for r, g, b in zip(data[0::3], data[1::3], data[2::3])
    ]
    return w, h, "landscape" if w >= h else "portrait", lightness


_analysis = {}


def analyze(path):
    """保存した画像から (向き, 3値の正解, 明暗の幅) を出す。"""
    key = str(path)
    if key not in _analysis:
        w, h, orientation, lightness = image_lightness(path)
        answer, spread = classify(cell_means(lightness, w, h, *GRIDS[orientation]))
        _analysis[key] = (orientation, answer, spread)
    return _analysis[key]


def analyze_fine(path):
    """保存した画像から、細かいマス目の {"cols", "rows", "answer"} を出す。境目は細かいマスの分布で決め直す。"""
    w, h, orientation, lightness = image_lightness(path)
    cols, rows = FINE_GRIDS[orientation]
    answer, _ = classify(cell_means(lightness, w, h, cols, rows))
    return {"cols": cols, "rows": rows, "answer": answer}


def cached_analyze(path, cache):
    """analyze の結果を、ファイル名と更新時刻を鍵にして cache から読む。なければ出して cache に書く。"""
    mtime = path.stat().st_mtime_ns
    hit = cache.get(path.name)
    if hit and hit["mtime_ns"] == mtime:
        return hit["orientation"], hit["answer"], hit["spread"]
    orientation, answer, spread = analyze(path)
    cache[path.name] = {"mtime_ns": mtime, "orientation": orientation, "answer": answer, "spread": spread}
    return orientation, answer, spread


# ---- 1枚ずつの判定 ----


def record_reason(museum, record):
    if museum == "met":
        if record.get("isPublicDomain") is not True:
            return "not_public_domain"
        if record.get("classification") != "Paintings":
            return "not_painting"
        if not record.get("primaryImage"):
            return "no_image"
    else:
        if record.get("is_public_domain") is not True:
            return "not_public_domain"
        if not record.get("image_id"):
            return "no_image"
    return None


def image_url(museum, record):
    if museum == "met":
        return urllib.parse.quote(record["primaryImage"], safe=":/?#[]@!$&'()*+,;=%")
    return AIC_IIIF_URL.format(image_id=record["image_id"], width=aic_image_width(record))


def judge(artwork_id, client, online, args):
    """候補を1件判定する。キャッシュになく、ネットワークにも出られないときは None を返す。"""
    museum = artwork_id.split("-", 1)[0]
    result = {"id": artwork_id, "downloaded": False, "title": ""}

    def exclude(reason, detail=""):
        return {**result, "status": "exclude", "reason": reason, "detail": detail}

    record = load_record(artwork_id)
    if record is None:
        # AICのレコードは一覧を取ったときに書いてある。
        if museum != "met" or not online[museum]:
            return None
        try:
            record = client.get_json("met", MET_OBJECT_URL.format(id=artwork_id.split("-", 1)[1]))
        except NotFound:
            save_record(artwork_id, {"not_found": True})
            return exclude("not_found")
        save_record(artwork_id, record)
    if record.get("not_found"):
        return exclude("not_found")
    result["title"] = (record.get("title") or "").strip()
    reason = record_reason(museum, record)
    if reason:
        return exclude(reason)

    size = record.get("source_size")
    if not size and museum == "aic":
        # AICは元画像の大きさが thumbnail に入っているので、落とす前に外せる。
        thumb = record.get("thumbnail") or {}
        if thumb.get("width") and thumb.get("height"):
            size = (thumb["width"], thumb["height"])
    if size:
        reason, detail = size_check(*size, args.min_keep)
        if reason:
            return exclude(reason, detail)

    img_path = IMG_DIR / f"{artwork_id}.jpg"
    if not img_path.exists():
        if not online[museum]:
            return None
        try:
            data = client.get(museum, image_url(museum, record))
        except NotFound:
            record["not_found"] = True
            save_record(artwork_id, record)
            return exclude("not_found")
        try:
            im = open_image(data)
        except OSError as e:
            raise FetchFailed(f"画像を開けない（{e}）") from e
        result["downloaded"] = True
        record["source_size"] = list(im.size)
        save_record(artwork_id, record)
        reason, detail = size_check(*im.size, args.min_keep)
        if reason:
            return exclude(reason, detail)
        save_cropped(im, img_path)

    orientation, answer, spread = analyze(img_path)
    result.update(spread=spread, orientation=orientation, answer=answer)
    if spread < args.min_spread:
        return exclude("low_spread", f"spread={spread:.1f}")
    entry = make_entry(artwork_id, record, orientation, answer, analyze_fine(img_path))
    return {**result, "status": "adopt", "entry": entry}


# ---- 確認用のHTML ----

REVIEW_STYLE = """
body { background: #3a3a3a; color: #eee; font: 14px/1.5 sans-serif; margin: 16px; }
.item { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; margin: 0 0 20px; }
.item img, .grid { display: block; }
.landscape img, .landscape .grid { width: 320px; }
.portrait img, .portrait .grid { width: 240px; }
.grid { display: grid; }
.grid i { aspect-ratio: 1; }
.c0 { background: #000; }
.c1 { background: #808080; }
.c2 { background: #fff; }
.info { max-width: 360px; }
.adopted { color: #9d9; }
.excluded { color: #e88; }
.threshold { border-top: 2px solid #e85; color: #e85; margin: 24px 0 16px; padding-top: 4px; }
"""


def write_review(artworks, excluded, min_spread):
    in_index = {entry["id"] for entry in artworks}
    items = []
    paths = {p.stem: (p, f"img/{p.name}") for p in IMG_DIR.glob("*.jpg")}
    for entry in artworks:
        if entry["id"] not in paths and (ARTWORKS_DIR / entry["image"]).is_file():
            paths[entry["id"]] = (ARTWORKS_DIR / entry["image"], f"../artworks/{entry['image']}")
    # 3値化は1枚0.3秒ほどかかるので、前の実行の結果を使う。index.json の answer は judge で出し直す。
    loaded = load_json(ANALYSIS_PATH, {})
    cache = dict(loaded)
    for artwork_id, (path, src) in paths.items():
        orientation, answer, spread = cached_analyze(path, cache)
        record = load_record(artwork_id) or {}
        if artwork_id in in_index:
            status, cls = "採用", "adopted"
        elif artwork_id in excluded:
            status, cls = "除外 excluded.txt", "excluded"
        elif spread < min_spread:
            status, cls = "除外 low_spread", "excluded"
        else:
            status, cls = "未採用", ""
        items.append((spread, artwork_id, orientation, answer, src, (record.get("title") or "").strip(), status, cls))
    items.sort()
    cache = {path.name: cache[path.name] for path, _ in paths.values()}
    if cache != loaded:
        write_json(ANALYSIS_PATH, cache)

    parts = [
        "<!doctype html>",
        '<html lang="ja"><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>ikura 作品の確認</title>",
        f"<style>{REVIEW_STYLE}</style>",
        f"<h1>作品の確認（{len(items)}件、明暗の幅の小さい順）</h1>",
    ]
    marked = False
    for spread, artwork_id, orientation, answer, src, title, status, cls in items:
        if not marked and spread >= min_spread:
            parts.append(f'<div class="threshold">ここから下は --min-spread {min_spread:g} 以上</div>')
            marked = True
        cols = GRIDS[orientation][0]
        cells = "".join(f'<i class="c{v}"></i>' for v in answer)
        parts.append(
            f'<div class="item {orientation}">'
            f'<img src="{html.escape(src)}" alt="">'
            f'<div class="grid" style="grid-template-columns: repeat({cols}, 1fr)">{cells}</div>'
            f'<div class="info"><div>{html.escape(artwork_id)}</div><div>{html.escape(title)}</div>'
            f'<div>spread={spread:.1f}</div><div class="{cls}">{status}</div></div>'
            "</div>"
        )
    REVIEW_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(REVIEW_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(parts) + "\n")


# ---- 全体の手順 ----


def parse_args(argv):
    parser = argparse.ArgumentParser(description="作品を取ってきて artworks/ に書く")
    parser.add_argument("--count", type=int, default=30, help="index.json の作品がこの数になるまで足す")
    parser.add_argument("--sources", default="met,aic", help="使う館（met,aic）")
    parser.add_argument("--min-spread", type=float, default=15, help="明暗の幅がこれより小さい絵を外す")
    parser.add_argument("--min-keep", type=float, default=0.8, help="切り抜いたあとに残る面積の割合がこれより小さい絵を外す")
    parser.add_argument("--offline", action="store_true", help="ネットワークに出ず、キャッシュにある候補だけで判定する")
    args = parser.parse_args(argv)
    args.sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    for source in args.sources:
        if source not in MUSEUMS:
            parser.error(f"--sources に知らない館がある: {source}")
    return args


def collect_candidates(client, args, online):
    """候補のIDをハッシュの順に並べて返す。一覧を取れた館がなければ None を返す。"""
    candidates = load_json(CANDIDATES_PATH, {})
    if args.offline:
        ids = [i for m in args.sources for i in candidates.get(m, [])]
    else:
        ids = []
        for museum in args.sources:
            try:
                museum_ids = LISTERS[museum](client)
            except (Blocked, NotFound, FetchFailed, KeyError, TypeError, ValueError) as e:
                print(f"警告: {MUSEUM_NAMES[museum]} の一覧を取れなかったので、この回は使わない（{e!r}）")
                online[museum] = False
                continue
            print(f"{MUSEUM_NAMES[museum]}: 候補 {len(museum_ids)}件")
            candidates[museum] = museum_ids
            ids.extend(museum_ids)
        if not any(online[m] for m in args.sources):
            return None
        write_json(CANDIDATES_PATH, candidates)
    return sorted(set(ids), key=order_key)


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    exit_code = 0

    excluded = load_excluded()
    existing = load_index()
    artworks = merge_index(existing, excluded, [])
    if len(artworks) != len(existing):
        for entry in existing:
            if entry["id"] in excluded:
                (ARTWORKS_DIR / entry["image"]).unlink(missing_ok=True)
                print(f"excluded.txt にあるので外した: {entry['id']}")
        write_index(artworks)

    # 細かいマス目を足す前に入れた作品には、artworks/ の画像から細かいマスの正解を作って足す
    missing = [entry for entry in artworks if "fine" not in entry]
    for n, entry in enumerate(missing, 1):
        entry["fine"] = analyze_fine(ARTWORKS_DIR / entry["image"])
        print(f"[{n}/{len(missing)}] {entry['id']} 細かいマスの正解を足した")
    if missing:
        write_index(artworks)

    counts = Counter()
    downloaded = 0
    if len(artworks) >= args.count:
        print(f"index.json に既に{len(artworks)}枚あるので、取らない")
    else:
        client = Client()
        online = {m: m in args.sources and not args.offline for m in MUSEUMS}
        ids = collect_candidates(client, args, online)
        if ids is None:
            print("エラー: どの館の一覧も取れなかった")
            return 1
        in_index = {entry["id"] for entry in artworks}
        skips = 0
        for artwork_id in ids:
            if len(artworks) >= args.count:
                break
            if artwork_id in in_index or artwork_id in excluded:
                continue
            try:
                result = judge(artwork_id, client, online, args)
            except Blocked:
                online["aic"] = False
                print("警告: Art Institute of ChicagoでCloudflareのチャレンジが返ったので、この回はAICを使わない")
                continue
            except FetchFailed as e:
                skips += 1
                counts["skip"] += 1
                print(f"        {artwork_id} 飛ばす {e}")
                if skips >= MAX_CONSECUTIVE_SKIPS:
                    print(f"エラー: 候補を{skips}件続けて飛ばした。弾かれていると見て止める")
                    exit_code = 1
                    break
                continue
            if result is None:
                continue
            skips = 0
            if result["downloaded"]:
                downloaded += 1
            note = "（画像を取得）" if result["downloaded"] else ""
            if result["status"] == "adopt":
                entry = result["entry"]
                ARTWORKS_DIR.mkdir(parents=True, exist_ok=True)
                (ARTWORKS_DIR / entry["image"]).write_bytes((IMG_DIR / entry["image"]).read_bytes())
                artworks = merge_index(artworks, excluded, [entry])
                in_index.add(entry["id"])
                write_index(artworks)
                counts["adopt"] += 1
                print(f"[{len(artworks)}/{args.count}] {artwork_id} 採用 spread={result['spread']:.1f} {entry['title']}{note}")
            else:
                counts[result["reason"]] += 1
                detail = f" {result['detail']}" if result["detail"] else ""
                title = f" {result['title']}" if result["title"] else ""
                print(f"        {artwork_id} 除外 {result['reason']}{detail}{title}{note}")
        if len(artworks) < args.count and exit_code == 0:
            print(f"警告: 候補が尽きて{len(artworks)}枚までしか取れなかった")

    keep_images = {entry["image"] for entry in artworks}
    for path in ARTWORKS_DIR.glob("*.jpg"):
        if path.name not in keep_images:
            path.unlink()
            print(f"index.json にない画像を消した: {path.name}")

    write_review(artworks, excluded, args.min_spread)

    adopted = counts.pop("adopt", 0)
    skipped = counts.pop("skip", 0)
    reasons = "、".join(f"{reason} {n}" for reason, n in sorted(counts.items())) or "なし"
    print(f"採用 {adopted}枚（index.json は{len(artworks)}枚）。除外: {reasons}。飛ばした候補 {skipped}件")
    print(f"画像を落とした数 {downloaded}。確認用のHTML: {REVIEW_PATH.relative_to(ROOT).as_posix()}")

    errors = validate(artworks, ARTWORKS_DIR)
    for error in errors:
        print(f"エラー: {error}")
    return 1 if errors else exit_code


if __name__ == "__main__":
    sys.exit(main())
