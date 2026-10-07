// 画面に収める大きさの計算。DOMには触らない。

// width, height は main の大きさ。gap はお手本とマス目の間、captionHeight はキャプションの高さ。
// cell は1マスの一辺で、整数のpxにする。お手本もマス目も cell × cols、cell × rows の大きさで出す。
// 上下に並べるのは TODO 5 で作る。それまでは左右に並べたときの大きさだけを返す
export function fitLayout({ width, height, cols, rows, gap, captionHeight }) {
  const h = height - captionHeight;
  const row = Math.floor(Math.min((width - gap) / 2 / cols, h / rows));
  return { direction: "row", cell: Math.max(row, 1) };
}
