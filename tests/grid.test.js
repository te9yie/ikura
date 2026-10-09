import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnswer,
  lineCells,
  paintCell,
  cellAt,
  isValidGrid,
  isValidPalette,
  pickGrid,
} from "../lib/grid.js";

// "0"・"1"・"2" を行ごとに並べた文字列の配列からマス目を作る
function grid(lines) {
  return { cells: parseAnswer(lines.join("")), cols: lines[0].length, rows: lines.length };
}

function toLines(cells, cols) {
  const lines = [];
  for (let i = 0; i < cells.length; i += cols) lines.push(Array.from(cells.subarray(i, i + cols)).join(""));
  return lines;
}

test("parseAnswer は文字を 0・1・2 の数にする", () => {
  assert.deepEqual(Array.from(parseAnswer("0120")), [0, 1, 2, 0]);
});

test("lineCells は両端を含み、隣りのマスへ1つずつ進む", () => {
  const cases = [
    [0, 0, 0, 0],
    [0, 0, 15, 0],
    [3, 11, 3, 0],
    [0, 0, 15, 11],
    [15, 0, 0, 11],
    [2, 9, 13, 4],
    [7, 7, 5, 1],
  ];
  for (const [c0, r0, c1, r1] of cases) {
    const cells = lineCells(c0, r0, c1, r1);
    const label = `${c0},${r0} → ${c1},${r1}`;
    assert.deepEqual(cells[0], { col: c0, row: r0 }, label);
    assert.deepEqual(cells.at(-1), { col: c1, row: r1 }, label);
    assert.equal(cells.length, Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0)) + 1, label);
    for (let i = 1; i < cells.length; i++) {
      const dc = Math.abs(cells[i].col - cells[i - 1].col);
      const dr = Math.abs(cells[i].row - cells[i - 1].row);
      assert.ok(dc <= 1 && dr <= 1 && dc + dr > 0, `${label}: ${i}番目で飛んだ`);
    }
  }
});

test("paintCell は変わったら true、同じ値なら false を返す", () => {
  const { cells, cols } = grid(["1111", "1111", "1111"]);
  assert.equal(paintCell(cells, cols, 1, 1, 0), true);
  assert.deepEqual(toLines(cells, cols), ["1111", "1011", "1111"]);
  assert.equal(paintCell(cells, cols, 1, 1, 0), false);
});

test("cellAt は位置からマスを出し、外と右端・下端ちょうどは null にする", () => {
  assert.deepEqual(cellAt(0, 0, 560, 420, 16, 12), { col: 0, row: 0 });
  assert.deepEqual(cellAt(34.9, 35, 560, 420, 16, 12), { col: 0, row: 1 });
  assert.deepEqual(cellAt(559.9, 419.9, 560, 420, 16, 12), { col: 15, row: 11 });
  assert.equal(cellAt(560, 100, 560, 420, 16, 12), null);
  assert.equal(cellAt(100, 420, 560, 420, 16, 12), null);
  assert.equal(cellAt(-0.1, 100, 560, 420, 16, 12), null);
  assert.equal(cellAt(100, -1, 560, 420, 16, 12), null);
});

test("isValidGrid は answer の長さと文字を確かめる", () => {
  assert.equal(isValidGrid({ cols: 2, rows: 1, answer: "02" }), true);
  assert.equal(isValidGrid({ cols: 2, rows: 1, answer: "0" }), false);
  assert.equal(isValidGrid({ cols: 2, rows: 1, answer: "03" }), false);
  assert.equal(isValidGrid({ cols: "2", rows: 1, answer: "02" }), false);
  assert.equal(isValidGrid(undefined), false);
});

test("pickGrid は fine なら細かいほうを、なければ粗いほうを返す", () => {
  const coarse = { cols: 2, rows: 1, answer: "02" };
  const artwork = { id: "a", ...coarse, fine: { cols: 3, rows: 1, answer: "012" } };
  assert.deepEqual(pickGrid(artwork, false), { ...coarse, palette: null });
  assert.deepEqual(pickGrid(artwork, true), { cols: 3, rows: 1, answer: "012", palette: null });
  assert.deepEqual(pickGrid({ id: "a", ...coarse }, true), { ...coarse, palette: null });
  assert.deepEqual(pickGrid({ ...artwork, fine: { cols: 3, rows: 1, answer: "01" } }, true), { ...coarse, palette: null });
});

test("pickGrid はマス目ごとのパレットを返し、形が合わなければ null にする", () => {
  const palette = ["#101010", "#555555", "#aaaaaa"];
  const finePalette = ["#0f0f0f", "#565656", "#acacac"];
  const artwork = { id: "a", cols: 2, rows: 1, answer: "02", palette, fine: { cols: 3, rows: 1, answer: "012", palette: finePalette } };
  assert.deepEqual(pickGrid(artwork, false).palette, palette);
  assert.deepEqual(pickGrid(artwork, true).palette, finePalette);
  assert.equal(pickGrid({ ...artwork, palette: ["#101010", "#555555"] }, false).palette, null);
  assert.equal(pickGrid({ ...artwork, palette: ["#101010", "#555555", "white"] }, false).palette, null);
});

test("isValidPalette は #rrggbb が3つ並んでいるかを確かめる", () => {
  assert.equal(isValidPalette(["#000000", "#808080", "#eeeeee"]), true);
  assert.equal(isValidPalette(["#000", "#808080", "#eeeeee"]), false);
  assert.equal(isValidPalette("#000000"), false);
  assert.equal(isValidPalette(undefined), false);
});
