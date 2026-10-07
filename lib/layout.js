// 画面に収める大きさの計算。DOMには触らない。

// width, height は main の大きさ。gap はお手本とマス目の間、captionHeight はキャプションの高さ。
// cell は1マスの一辺で、整数のpxにする。お手本もマス目も cell × cols、cell × rows の大きさで出す。
// お手本とマス目を左右（row）と上下（column）のどちらに並べるかは、マスが大きくなるほうにする。
// 向きのメディアクエリで決めないのは、縦長の絵と横長の絵で収まり方が違うためである
export function fitLayout({ width, height, cols, rows, gap, captionHeight }) {
  const h = height - captionHeight;
  const row = Math.max(Math.floor(Math.min((width - gap) / 2 / cols, h / rows)), 1);
  const column = Math.max(Math.floor(Math.min(width / cols, (h - gap) / 2 / rows)), 1);
  if (row !== column) return row > column ? { direction: "row", cell: row } : { direction: "column", cell: column };
  // 同じなら画面の長いほうに並べる。スマホの縦向きで縦長の絵のときに上下になる
  return width >= height ? { direction: "row", cell: row } : { direction: "column", cell: column };
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
