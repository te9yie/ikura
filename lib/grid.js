// マス目の計算。cells は行優先（左上から右へ、次の行へ）の Uint8Array で、0=暗、1=中、2=明。
// DOMには触らない。塗る関数は cells をその場で書き換え、1マスでも変わったら true を返す。

// answer の文字列（"0"・"1"・"2" の並び）を Uint8Array にする
export function parseAnswer(str) {
  const cells = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) cells[i] = str.charCodeAt(i) - 48;
  return cells;
}

// (c0, r0) から (c1, r1) までを両端を含めてつなぐマス（ブレゼンハム）。
// 斜めに進むところは角だけで接する
export function lineCells(c0, r0, c1, r1) {
  const result = [];
  const dc = Math.abs(c1 - c0);
  const dr = -Math.abs(r1 - r0);
  const sc = c0 < c1 ? 1 : -1;
  const sr = r0 < r1 ? 1 : -1;
  let err = dc + dr;
  let c = c0;
  let r = r0;
  for (;;) {
    result.push({ col: c, row: r });
    if (c === c1 && r === r1) return result;
    const e2 = 2 * err;
    if (e2 >= dr) {
      err += dr;
      c += sc;
    }
    if (e2 <= dc) {
      err += dc;
      r += sr;
    }
  }
}

// (col, row) の1マスを value にする
export function paintCell(cells, cols, col, row, value) {
  const i = row * cols + col;
  if (cells[i] === value) return false;
  cells[i] = value;
  return true;
}

// 触れたマスと同じ値で上下左右につながったマスを value にする。
// ブラシで斜めに引いた線を角から越えないように、斜めにはつながない
export function floodFill(cells, cols, rows, col, row, value) {
  const target = cells[row * cols + col];
  if (target === value) return false;
  const stack = [row * cols + col];
  cells[row * cols + col] = value;
  while (stack.length > 0) {
    const i = stack.pop();
    const c = i % cols;
    const r = (i - c) / cols;
    const neighbors = [];
    if (c > 0) neighbors.push(i - 1);
    if (c < cols - 1) neighbors.push(i + 1);
    if (r > 0) neighbors.push(i - cols);
    if (r < rows - 1) neighbors.push(i + cols);
    for (const n of neighbors) {
      if (cells[n] === target) {
        cells[n] = value;
        stack.push(n);
      }
    }
  }
  return true;
}

// マス目の左上からの位置 (x, y) にあるマス。外なら null。右端・下端ちょうども外にする
export function cellAt(x, y, width, height, cols, rows) {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { col: Math.floor((x / width) * cols), row: Math.floor((y / height) * rows) };
}

// { cols, rows, answer } の answer が cols × rows 文字の 0・1・2 になっているか
export function isValidGrid(grid) {
  return (
    Number.isInteger(grid?.cols) &&
    Number.isInteger(grid.rows) &&
    typeof grid.answer === "string" &&
    grid.answer.length === grid.cols * grid.rows &&
    /^[012]*$/.test(grid.answer)
  );
}

// 暗・中・明の順の "#rrggbb" が3つ並んでいるか
export function isValidPalette(palette) {
  return Array.isArray(palette) && palette.length === 3 && palette.every((c) => /^#[0-9a-f]{6}$/.test(c));
}

// 作品のマス目を { cols, rows, answer, palette } で返す。fine が true なら細かいほうを返すが、
// 細かいほうがない（細かいマス目を足す前の一覧が残っている）か形が合わなければ、粗いほうを返す。
// palette はそのマス目の絵の3色で、ない（パレットを足す前の一覧が残っている）か形が合わなければ null
export function pickGrid(artwork, fine) {
  const grid = fine && isValidGrid(artwork.fine) ? artwork.fine : artwork;
  const { cols, rows, answer } = grid;
  return { cols, rows, answer, palette: isValidPalette(grid.palette) ? grid.palette : null };
}
