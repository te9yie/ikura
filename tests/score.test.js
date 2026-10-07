import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswer } from "../lib/grid.js";
import { score, percent } from "../lib/score.js";

// 暗・中・明を4マスずつ持つ 4×3 の正解
const answer = parseAnswer("000011112222");

test("score は全部合っていれば一致率100%で、ずれがない", () => {
  const result = score(answer.slice(), answer);
  assert.equal(result.total, 12);
  assert.equal(result.matched, 12);
  assert.equal(percent(result.matched, result.total), 100);
  for (const { count, matched } of result.byValue) assert.equal(percent(matched, count), 100);
  assert.deepEqual(Array.from(result.mismatch), new Array(12).fill(0));
});

test("score は全部「中」のとき、中だけが100%で明と暗は0%になる", () => {
  const result = score(new Uint8Array(12).fill(1), answer);
  assert.equal(result.matched, 4);
  assert.equal(percent(result.matched, result.total), 33);
  assert.deepEqual(result.byValue, [
    { count: 4, matched: 0 },
    { count: 4, matched: 4 },
    { count: 4, matched: 0 },
  ]);
});

test("score の mismatch は塗りが正解と違うマスだけが1になる", () => {
  const cells = parseAnswer("010011102221");
  const result = score(cells, answer);
  assert.deepEqual(Array.from(result.mismatch), [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(result.matched, 9);
  assert.deepEqual(result.byValue, [
    { count: 4, matched: 3 },
    { count: 4, matched: 3 },
    { count: 4, matched: 3 },
  ]);
});

test("percent は整数に丸め、分母が0なら null を返す", () => {
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(0, 0), null);
});
