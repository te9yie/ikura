import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswer, brushCells, lineCells, paintBrush, floodFill, cellAt } from "../lib/grid.js";

// "0"・"1"・"2" を行ごとに並べた文字列の配列からマス目を作る
function grid(lines) {
  return { cells: parseAnswer(lines.join("")), cols: lines[0].length, rows: lines.length };
}

function toLines(cells, cols) {
  const lines = [];
  for (let i = 0; i < cells.length; i += cols) lines.push(Array.from(cells.subarray(i, i + cols)).join(""));
  return lines;
}

function key(cells) {
  return cells.map((cell) => `${cell.col},${cell.row}`);
}

test("parseAnswer は文字を 0・1・2 の数にする", () => {
  assert.deepEqual(Array.from(parseAnswer("0120")), [0, 1, 2, 0]);
});

test("brushCells は奇数なら真ん中、偶数なら左上寄りを中心にする", () => {
  assert.deepEqual(key(brushCells(5, 5, 1, 16, 12)), ["5,5"]);
  assert.deepEqual(key(brushCells(5, 5, 3, 16, 12)), ["4,4", "5,4", "6,4", "4,5", "5,5", "6,5", "4,6", "5,6", "6,6"]);
  assert.deepEqual(key(brushCells(5, 5, 2, 16, 12)), ["5,5", "6,5", "5,6", "6,6"]);
});

test("brushCells はマス目の外にはみ出たマスを捨てる", () => {
  assert.deepEqual(key(brushCells(0, 0, 3, 16, 12)), ["0,0", "1,0", "0,1", "1,1"]);
  assert.deepEqual(key(brushCells(15, 11, 3, 16, 12)), ["14,10", "15,10", "14,11", "15,11"]);
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

test("paintBrush は変わったマスがあれば true、なければ false を返す", () => {
  const { cells, cols, rows } = grid(["1111", "1111", "1111"]);
  assert.equal(paintBrush(cells, cols, rows, 0, 0, 3, 0), true);
  assert.deepEqual(toLines(cells, cols), ["0011", "0011", "1111"]);
  assert.equal(paintBrush(cells, cols, rows, 0, 0, 1, 0), false);
});

test("floodFill は同じ値で上下左右につながったマスだけを塗る", () => {
  const { cells, cols, rows } = grid([
    "1101",
    "1101",
    "0001",
    "1111",
  ]);
  assert.equal(floodFill(cells, cols, rows, 0, 0, 2), true);
  assert.deepEqual(toLines(cells, cols), ["2201", "2201", "0001", "1111"]);
});

test("floodFill は1マスのブラシで斜めに引いた線を角から越えない", () => {
  const cols = 6;
  const rows = 6;
  const cells = new Uint8Array(cols * rows).fill(1);
  for (const { col, row } of lineCells(5, 0, 0, 5)) paintBrush(cells, cols, rows, col, row, 1, 0);
  assert.equal(floodFill(cells, cols, rows, 0, 0, 2), true);
  assert.deepEqual(toLines(cells, cols), [
    "222220",
    "222201",
    "222011",
    "220111",
    "201111",
    "011111",
  ]);
});

test("floodFill は触れたマスが既に選んだ色なら何もせず false を返す", () => {
  const { cells, cols, rows } = grid(["0011", "0011"]);
  assert.equal(floodFill(cells, cols, rows, 0, 0, 0), false);
  assert.deepEqual(toLines(cells, cols), ["0011", "0011"]);
});

test("floodFill は全部同じ値の 16×12 を塗り切る", () => {
  const cells = new Uint8Array(16 * 12).fill(1);
  assert.equal(floodFill(cells, 16, 12, 7, 5, 2), true);
  assert.ok(cells.every((value) => value === 2));
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
