// 答え合わせの採点。DOMには触らない。
// cells と answer は行優先の Uint8Array で、0=暗、1=中、2=明。

// byValue[v] は { count: 正解が v のマスの数, matched: そのうち v で塗ったマスの数 }。
// mismatch[i] は、i 番目のマスの塗りが正解と違えば 1、同じなら 0
export function score(cells, answer) {
  const byValue = [0, 1, 2].map(() => ({ count: 0, matched: 0 }));
  const mismatch = new Uint8Array(answer.length);
  let matched = 0;
  for (let i = 0; i < answer.length; i++) {
    const value = answer[i];
    byValue[value].count++;
    if (cells[i] === value) {
      matched++;
      byValue[value].matched++;
    } else {
      mismatch[i] = 1;
    }
  }
  return { total: answer.length, matched, byValue, mismatch };
}

// 百分率を整数に丸める。分母が0なら null（画面では「—」にする）
export function percent(matched, count) {
  return count === 0 ? null : Math.round((matched / count) * 100);
}
