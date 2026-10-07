import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLayout, fitResultLayout, markSize } from "../lib/layout.js";

const base = { gap: 12, captionHeight: 56 };

test("fitLayout は左右と上下のうちマスが大きくなるほうを選び、収まる一番大きい cell を返す", () => {
  const cases = [
    { width: 1148, height: 700, cols: 16, rows: 12, direction: "row", cell: 35 }, // iPad横、横長の絵
    { width: 1148, height: 700, cols: 12, rows: 16, direction: "row", cell: 40 }, // iPad横、縦長の絵
    { width: 358, height: 540, cols: 16, rows: 12, direction: "column", cell: 19 }, // スマホ縦、横長の絵
    // 左右でも上下でも14になるので、縦に長い main に合わせて上下にする
    { width: 358, height: 540, cols: 12, rows: 16, direction: "column", cell: 14 }, // スマホ縦、縦長の絵
  ];
  for (const { direction, cell, ...size } of cases) {
    const layout = fitLayout({ ...size, ...base });
    assert.deepEqual(layout, { direction, cell }, JSON.stringify(size));
    if (direction === "row") {
      assert.ok(cell * size.cols * 2 + base.gap <= size.width);
      assert.ok(cell * size.rows + base.captionHeight <= size.height);
    } else {
      assert.ok(cell * size.cols <= size.width);
      assert.ok(cell * size.rows * 2 + base.gap + base.captionHeight <= size.height);
    }
  }
});

test("fitLayout は左右と上下で cell が同じなら、横に長い main では左右にする", () => {
  // 左右は min(428/2/16, 344/12) = 13.375、上下は min(440/16, 332/2/12) = 13.83 で、どちらも13になる
  assert.deepEqual(fitLayout({ width: 440, height: 400, cols: 16, rows: 12, ...base }), { direction: "row", cell: 13 });
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
