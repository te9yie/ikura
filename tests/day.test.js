import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SWAP_KEY,
  localDateKey,
  dailyIndex,
  readSwap,
  writeSwap,
  clearSwap,
  pickArtwork,
} from "../lib/day.js";

// localStorage の代わり。Map を包んで getItem・setItem・removeItem だけを持つ
function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

// プライベートブラウズなどで読み書きが例外になる localStorage
const brokenStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
};

const artworks = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("dailyIndex は基準日を0として数える", () => {
  assert.equal(dailyIndex("2026-01-01", 30), 0);
  assert.equal(dailyIndex("2026-01-02", 30), 1);
  assert.equal(dailyIndex("2026-10-07", 30), 9);
});

test("dailyIndex は基準日より前の日付でも0から作品数-1に入る", () => {
  assert.equal(dailyIndex("2025-12-31", 30), 29);
  for (const key of ["2025-12-01", "2024-02-29", "2000-01-01"]) {
    const index = dailyIndex(key, 30);
    assert.ok(Number.isInteger(index) && index >= 0 && index < 30, `${key} → ${index}`);
  }
});

test("dailyIndex は夏時間の切り替わりの前後でも1日に1つずつ進む", () => {
  // ヨーロッパは3月29日、アメリカは3月8日に切り替わる
  assert.equal(dailyIndex("2026-03-29", 1000) - dailyIndex("2026-03-28", 1000), 1);
  assert.equal(dailyIndex("2026-03-30", 1000) - dailyIndex("2026-03-29", 1000), 1);
  assert.equal(dailyIndex("2026-03-09", 1000) - dailyIndex("2026-03-08", 1000), 1);
});

test("localDateKey はローカルの年月日を返す", () => {
  assert.equal(localDateKey(new Date(2026, 9, 7, 6, 0)), "2026-10-07");
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  // 夏時間の切り替わりの日。アメリカの時間帯では 2:30 がなく 3:30 になるが、日付は変わらない
  assert.equal(localDateKey(new Date(2026, 2, 29, 0, 30)), "2026-03-29");
  assert.equal(localDateKey(new Date(2026, 2, 8, 2, 30)), "2026-03-08");
});

test("readSwap は今日の値なら id を返し、キーを残す", () => {
  const storage = fakeStorage({ [SWAP_KEY]: JSON.stringify({ date: "2026-10-07", id: "b" }) });
  assert.equal(readSwap(storage, "2026-10-07"), "b");
  assert.ok(storage.map.has(SWAP_KEY));
});

test("readSwap は日付の違う値を消して null を返す", () => {
  const storage = fakeStorage({ [SWAP_KEY]: JSON.stringify({ date: "2026-10-06", id: "b" }) });
  assert.equal(readSwap(storage, "2026-10-07"), null);
  assert.ok(!storage.map.has(SWAP_KEY));
});

test("readSwap は壊れた値を消して null を返す", () => {
  for (const raw of ["{", "null", "\"b\"", JSON.stringify({ date: "2026-10-07" }), JSON.stringify({ date: "2026-10-07", id: 3 })]) {
    const storage = fakeStorage({ [SWAP_KEY]: raw });
    assert.equal(readSwap(storage, "2026-10-07"), null, raw);
    assert.ok(!storage.map.has(SWAP_KEY), raw);
  }
});

test("readSwap はキーがなければ null を返す", () => {
  assert.equal(readSwap(fakeStorage(), "2026-10-07"), null);
});

test("writeSwap は日付と id をJSONで書く", () => {
  const storage = fakeStorage();
  writeSwap(storage, "2026-10-07", "c");
  assert.deepEqual(JSON.parse(storage.map.get(SWAP_KEY)), { date: "2026-10-07", id: "c" });
  assert.equal(readSwap(storage, "2026-10-07"), "c");
});

test("clearSwap はキーを消す", () => {
  const storage = fakeStorage({ [SWAP_KEY]: "x" });
  clearSwap(storage);
  assert.ok(!storage.map.has(SWAP_KEY));
});

test("localStorage が使えなくても例外を投げない", () => {
  assert.equal(readSwap(brokenStorage, "2026-10-07"), null);
  assert.doesNotThrow(() => writeSwap(brokenStorage, "2026-10-07", "a"));
  assert.doesNotThrow(() => clearSwap(brokenStorage));
  assert.equal(readSwap(null, "2026-10-07"), null);
  assert.doesNotThrow(() => writeSwap(null, "2026-10-07", "a"));
});

test("pickArtwork は替えた id があればその作品を返す", () => {
  assert.equal(pickArtwork(artworks, "2026-01-01", "c").id, "c");
});

test("pickArtwork は id がないときと、artworks にない id のときは今日の1枚を返す", () => {
  assert.equal(pickArtwork(artworks, "2026-01-01", null).id, "a");
  assert.equal(pickArtwork(artworks, "2026-01-02", null).id, "b");
  assert.equal(pickArtwork(artworks, "2026-01-02", "zzz").id, "b");
});
