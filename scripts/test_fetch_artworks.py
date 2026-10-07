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
    cached_analyze,
    cell_means,
    classify,
    crop_box,
    merge_index,
    order_key,
    parse_excluded,
    srgb_to_lightness,
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


class ClassifyTest(unittest.TestCase):
    def test_distinct_values_split_evenly(self):
        means = [float(v) for v in range(192)]
        random.Random(0).shuffle(means)
        answer, spread = classify(means)
        self.assertEqual(Counter(answer), {"0": 64, "1": 64, "2": 64})
        for v, a in zip(means, answer):
            self.assertEqual(a, "0" if v < 64 else "2" if v >= 128 else "1")
        self.assertAlmostEqual(spread, 128)

    def test_ties_at_boundaries_get_same_symbol(self):
        means = [0.0] * 60 + [1.0] * 10 + [float(v) for v in range(10, 62)] + [99.0] * 70
        random.Random(1).shuffle(means)
        answer, _ = classify(means)
        for v, a in zip(means, answer):
            if v <= 1.0:
                self.assertEqual(a, "0")
            elif v == 99.0:
                self.assertEqual(a, "2")
            else:
                self.assertEqual(a, "1")
        self.assertEqual(Counter(answer), {"0": 70, "1": 52, "2": 70})

    def test_uniform_image_is_all_dark(self):
        answer, spread = classify([50.0] * 192)
        self.assertEqual(answer, "0" * 192)
        self.assertEqual(spread, 0)


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
        with mock.patch("fetch_artworks.analyze", return_value=("landscape", "x", 1.0)) as m:
            self.assertEqual(cached_analyze(self.path, cache), ("landscape", "x", 1.0))
        m.assert_called_once()
        self.assertEqual(cache["met-1.jpg"]["mtime_ns"], mtime + 10**9)


if __name__ == "__main__":
    unittest.main()
