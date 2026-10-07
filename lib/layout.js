// 画面に収める大きさの計算。DOMには触らない。

// width, height は main の大きさ。gap はお手本とマス目の間、captionHeight はキャプションの高さ。
// cell は1マスの一辺で、整数のpxにする。お手本もマス目も cell × cols、cell × rows の大きさで出す。
// 上下に並べるのは TODO 5 で作る。それまでは左右に並べたときの大きさだけを返す
export function fitLayout({ width, height, cols, rows, gap, captionHeight }) {
  const h = height - captionHeight;
  const row = Math.floor(Math.min((width - gap) / 2 / cols, h / rows));
  return { direction: "row", cell: Math.max(row, 1) };
}

// 答え合わせの画面は、お手本・自分の塗り・数字・3値の正解を2×2に並べ、4つとも
// cell × cols、cell × rows の大きさにする。width, height は main の大きさ
export function fitResultLayout({ width, height, cols, rows, gap }) {
  const cell = Math.floor(Math.min((width - gap) / 2 / cols, (height - gap) / 2 / rows));
  return { cell: Math.max(cell, 1) };
}

// ずれたマスに描く印の四角の一辺。マスの40%で、小さい画面でも見えるように4px より小さくしない
export function markSize(cell) {
  return Math.max(4, Math.round(cell * 0.4));
}
