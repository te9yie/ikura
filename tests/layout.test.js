import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLayout, fitResultLayout, markSize } from "../lib/layout.js";

const base = { gap: 12, captionHeight: 56 };

// 上下に並べるのは TODO 5 で作るので、ここでは左右に並べたときの cell だけを見る
test("fitLayout は左右に並べたときに収まる一番大きい cell を返す", () => {
  const cases = [
    { width: 1148, height: 700, cols: 16, rows: 12, cell: 35 }, // iPad横、横長の絵
    { width: 1148, height: 700, cols: 12, rows: 16, cell: 40 }, // iPad横、縦長の絵
    { width: 358, height: 540, cols: 16, rows: 12, cell: 10 }, // スマホ縦、横長の絵
    { width: 358, height: 540, cols: 12, rows: 16, cell: 14 }, // スマホ縦、縦長の絵
  ];
  for (const { cell, ...size } of cases) {
    const layout = fitLayout({ ...size, ...base });
    assert.deepEqual(layout, { direction: "row", cell }, JSON.stringify(size));
    assert.ok(layout.cell * size.cols * 2 + base.gap <= size.width);
    assert.ok(layout.cell * size.rows + base.captionHeight <= size.height);
  }
});

test("fitLayout は main がとても小さくても cell を1より小さくしない", () => {
  assert.equal(fitLayout({ width: 0, height: 0, cols: 16, rows: 12, ...base }).cell, 1);
});

test("fitResultLayout は2×2に並べて収まる一番大きい cell を返す", () => {
  const cases = [
    { width: 1148, height: 700, cols: 16, rows: 12, cell: 28 }, // iPad横、横長の絵
    { width: 1148, height: 700, cols: 12, rows: 16, cell: 21 }, // iPad横、縦長の絵
    { width: 358, height: 540, cols: 16, rows: 12, cell: 10 }, // スマホ縦、横長の絵
    { width: 358, height: 540, cols: 12, rows: 16, cell: 14 }, // スマホ縦、縦長の絵
  ];
  for (const { cell, ...size } of cases) {
    const layout = fitResultLayout({ ...size, gap: base.gap });
    assert.deepEqual(layout, { cell }, JSON.stringify(size));
    assert.ok(layout.cell * size.cols * 2 + base.gap <= size.width);
    assert.ok(layout.cell * size.rows * 2 + base.gap <= size.height);
  }
  assert.equal(fitResultLayout({ width: 0, height: 0, cols: 16, rows: 12, gap: 12 }).cell, 1);
});

test("markSize はマスの40%で、4px より小さくしない", () => {
  assert.equal(markSize(28), 11);
  assert.equal(markSize(35), 14);
  assert.equal(markSize(10), 4);
  assert.equal(markSize(5), 4);
});
