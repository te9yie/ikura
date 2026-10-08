import os
import random
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

from PIL import Image

from fetch_artworks import (
    Client,
    FetchFailed,
    analyze,
    analyze_fine,
    cached_analyze,
    cell_means,
    classify,
    clean_artist,
    crop_box,
    lightness_to_gray,
    merge_index,
    order_key,
    parse_excluded,
    pixel_palette,
    srgb_to_lightness,
    validate,
)


class SrgbToLightnessTest(unittest.TestCase):
    def test_black_white_and_middle_gray(self):
        self.assertAlmostEqual(srgb_to_lightness(0, 0, 0), 0)
        self.assertAlmostEqual(srgb_to_lightness(255, 255, 255), 100, places=6)
        self.assertAlmostEqual(srgb_to_lightness(119, 119, 119), 50, delta=0.5)


class CropBoxTest(unittest.TestCase):
    def test_exact_ratios_are_kept_whole(self):
        self.assertEqual(crop_box(4000, 3000), ("landscape", 1.0, (0, 0, 4000, 3000)))
        self.assertEqual(crop_box(3000, 4000), ("portrait", 1.0, (0, 0, 3000, 4000)))

    def test_wide_image_is_cut_at_center(self):
        orientation, keep, (left, top, right, bottom) = crop_box(2000, 1000)
        self.assertEqual(orientation, "landscape")
        self.assertAlmostEqual(keep, 0.667, places=3)
        self.assertEqual((top, bottom), (0, 1000))
        self.assertEqual(right - left, 1333)
        self.assertLessEqual(abs(left - (2000 - right)), 1)

    def test_square_image(self):
        orientation, keep, (left, top, right, bottom) = crop_box(1000, 1000)
        self.assertEqual(orientation, "landscape")
        self.assertAlmostEqual(keep, 0.75)
        self.assertEqual((left, right), (0, 1000))
        self.assertEqual(bottom - top, 750)
        self.assertLessEqual(abs(top - (1000 - bottom)), 1)


class CellMeansTest(unittest.TestCase):
    def test_left_dark_right_light(self):
        lightness = ([0.0] * 400 + [100.0] * 400) * 600
        means = cell_means(lightness, 800, 600, 16, 12)
        self.assertEqual(len(means), 192)
        for r in range(12):
            row = means[r * 16 : (r + 1) * 16]
            self.assertEqual(row, [0.0] * 8 + [100.0] * 8)


class PixelPaletteTest(unittest.TestCase):
    def test_three_flat_areas_become_the_palette(self):
        # L* 10・50・90 のピクセルが 6:3:1 の絵。数の少ない明るい面もパレットの明になる
        lightness = [10.0] * 600 + [50.0] * 300 + [90.0] * 100
        grays = pixel_palette(lightness)
        self.assertEqual(grays, [lightness_to_gray(10), lightness_to_gray(50), lightness_to_gray(90)])

    def test_small_bright_spot_is_light_even_if_cells_average_it_away(self):
        # 暗い面に、マスの平均では埋もれる細い明るい帯がある
        lightness = [10.0] * 900 + [30.0] * 80 + [80.0] * 20
        grays = pixel_palette(lightness)
        self.assertEqual(grays[2], lightness_to_gray(80))


class ClassifyTest(unittest.TestCase):
    def test_cells_go_to_nearest_palette_color(self):
        grays = [lightness_to_gray(0), lightness_to_gray(50), lightness_to_gray(100)]
        means = [50.0, 100.0, 24.0, 0.0, 76.0, 26.0, 74.0]
        answer, palette, spread = classify(means, grays)
        self.assertEqual(palette, ["#000000", "#777777", "#ffffff"])
        self.assertEqual(answer, "1200211")
        self.assertAlmostEqual(spread, (100 + 76) / 2 - (24 + 0) / 2)

    def test_no_cell_near_light_gives_no_light(self):
        grays = [lightness_to_gray(10), lightness_to_gray(30), lightness_to_gray(80)]
        answer, _, spread = classify([10.0, 12.0, 30.0, 40.0], grays)
        self.assertEqual(answer, "0011")
        self.assertEqual(spread, 0)

    def test_uniform_palette_is_all_dark(self):
        g = lightness_to_gray(50)
        answer, palette, spread = classify([50.0] * 192, [g, g, g])
        self.assertEqual(answer, "0" * 192)
        self.assertEqual(len(set(palette)), 1)
        self.assertEqual(spread, 0)


class LightnessToGrayTest(unittest.TestCase):
    def test_round_trips_through_lightness(self):
        for g in (0, 1, 10, 64, 128, 200, 255):
            self.assertEqual(lightness_to_gray(srgb_to_lightness(g, g, g)), g)


class CleanArtistTest(unittest.TestCase):
    def test_unknown_becomes_empty(self):
        self.assertEqual(clean_artist("Artist unknown"), "")
        self.assertEqual(clean_artist(" Unknown "), "")

    def test_name_and_region_are_kept(self):
        self.assertEqual(clean_artist(" Claude Monet "), "Claude Monet")
        self.assertEqual(clean_artist("India"), "India")


class OrderKeyTest(unittest.TestCase):
    def test_is_stable_hex(self):
        self.assertEqual(order_key("met-436535"), order_key("met-436535"))
        self.assertNotEqual(order_key("met-436535"), order_key("aic-436535"))
        self.assertRegex(order_key("aic-1"), r"^[0-9a-f]{64}$")


class MergeIndexTest(unittest.TestCase):
    def test_keeps_order_drops_excluded_and_appends(self):
        existing = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        merged = merge_index(existing, {"b"}, [{"id": "d"}, {"id": "e"}])
        self.assertEqual([e["id"] for e in merged], ["a", "c", "d", "e"])

    def test_does_not_duplicate(self):
        merged = merge_index([{"id": "a"}], set(), [{"id": "a"}, {"id": "b"}])
        self.assertEqual([e["id"] for e in merged], ["a", "b"])


class ParseExcludedTest(unittest.TestCase):
    def test_comments_and_blank_lines(self):
        text = "# 手で外す作品\nmet-1  # 暗すぎる\n\naic-2\n"
        self.assertEqual(parse_excluded(text), {"met-1", "aic-2"})


class GetJsonTest(unittest.TestCase):
    def test_non_json_body_is_fetch_failed(self):
        client = Client()
        with mock.patch.object(Client, "get", return_value=b"<html>challenge</html>"):
            with self.assertRaises(FetchFailed):
                client.get_json("met", "https://example.com/objects/1")

    def test_json_body_is_parsed(self):
        client = Client()
        with mock.patch.object(Client, "get", return_value=b'{"total": 1}'):
            self.assertEqual(client.get_json("met", "https://example.com/search"), {"total": 1})


class CachedAnalyzeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "met-1.jpg"
        im = Image.new("RGB", (200, 150))
        im.putdata([(x, x, x) for _ in range(150) for x in range(200)])
        im.save(self.path, "JPEG")

    def test_reads_cache_while_file_is_unchanged(self):
        cache = {}
        first = cached_analyze(self.path, cache)
        self.assertEqual(first, analyze(self.path))
        self.assertEqual(list(cache), ["met-1.jpg"])
        with mock.patch("fetch_artworks.analyze", side_effect=AssertionError("計算し直した")):
            self.assertEqual(cached_analyze(self.path, cache), first)

    def test_recomputes_when_mtime_changes(self):
        cache = {}
        cached_analyze(self.path, cache)
        mtime = self.path.stat().st_mtime_ns
        os.utime(self.path, ns=(mtime + 10**9, mtime + 10**9))
        with mock.patch("fetch_artworks.analyze", return_value=("landscape", "x", ["#000000"] * 3, 1.0)) as m:
            self.assertEqual(cached_analyze(self.path, cache), ("landscape", "x", ["#000000"] * 3, 1.0))
        m.assert_called_once()
        self.assertEqual(cache["met-1.jpg"]["mtime_ns"], mtime + 10**9)


class AnalyzeFineTest(unittest.TestCase):
    def make_image(self, size):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "met-1.jpg"
        w, h = size
        im = Image.new("RGB", size)
        im.putdata([(x * 255 // w,) * 3 for _ in range(h) for x in range(w)])
        im.save(path, "JPEG")
        return path

    def test_landscape_is_24_by_18_and_dark_to_light(self):
        fine = analyze_fine(self.make_image((800, 600)))
        self.assertEqual((fine["cols"], fine["rows"]), (24, 18))
        self.assertEqual(len(fine["answer"]), 24 * 18)
        # 左から右へ明るくなる画像なので、どの行も 0、1、2 の順に並ぶ
        row = fine["answer"][:24]
        self.assertEqual(row, "".join(sorted(row)))
        self.assertEqual(set(row), {"0", "1", "2"})
        self.assertEqual(fine["palette"], analyze(self.make_image((800, 600)))[2])

    def test_portrait_is_18_by_24(self):
        fine = analyze_fine(self.make_image((600, 800)))
        self.assertEqual((fine["cols"], fine["rows"]), (18, 24))


class ValidateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        (self.dir / "met-1.jpg").write_bytes(b"")
        self.entry = {
            "id": "met-1",
            "image": "met-1.jpg",
            "cols": 2,
            "rows": 1,
            "answer": "01",
            "palette": ["#000000", "#808080", "#ffffff"],
            "fine": {"cols": 3, "rows": 1, "answer": "012", "palette": ["#000000", "#808080", "#ffffff"]},
        }

    def test_valid_entry_has_no_errors(self):
        self.assertEqual(validate([self.entry], self.dir), [])

    def test_missing_or_short_fine_is_an_error(self):
        without = {k: v for k, v in self.entry.items() if k != "fine"}
        short = {**self.entry, "fine": {**self.entry["fine"], "answer": "01"}}
        self.assertEqual(len(validate([without], self.dir)), 1)
        self.assertEqual(len(validate([short], self.dir)), 1)

    def test_missing_or_bad_palette_is_an_error(self):
        without = {k: v for k, v in self.entry.items() if k != "palette"}
        bad = {**self.entry, "fine": {**self.entry["fine"], "palette": ["#000", "#808080", "#ffffff"]}}
        self.assertEqual(len(validate([without], self.dir)), 1)
        self.assertEqual(len(validate([bad], self.dir)), 1)


if __name__ == "__main__":
    unittest.main()
