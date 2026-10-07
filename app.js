// 入口。状態を持ち、DOMとイベントをつなぐ。ブラウザに触るのはこのファイルだけにする
import { localDateKey, readSwap, writeSwap, clearSwap, pickArtwork } from "./lib/day.js";
import { parseAnswer, lineCells, paintBrush, floodFill, cellAt } from "./lib/grid.js";
import { fitLayout } from "./lib/layout.js";

// 戻せる回数。写しは1回 cols × rows バイトなので、100回でも20KBに届かない
const HISTORY_LIMIT = 100;
const BRUSH_SIZE = { brush1: 1, brush3: 3 };

const state = {
  view: "loading", // "loading" | "paint" | "error"
  artworks: [], // index.json の artworks のうち、形の正しいもの
  today: null, // 絵を選んだときのローカル日付
  artwork: null, // 今出している作品（index.json の1件）
  imageFailed: false, // お手本の画像を読めなかった
  answer: null, // Uint8Array(cols*rows)。answer の文字列を 0/1/2 にしたもの
  cells: null, // Uint8Array(cols*rows)。自分の塗り。最初は全部 1
  color: 0, // 0=暗, 1=中, 2=明
  tool: "brush3", // "brush1" | "brush3" | "fill"
  history: [], // 塗る操作の前の cells の写し。最大 HISTORY_LIMIT
  stroke: null, // 指を置いている間だけ { pointerId, last: {col,row}|null, before, changed, rect }
  timer: { elapsed: 0, since: null }, // since は performance.now() の値。止まっているときは null
  cell: 0, // マスの一辺（CSSのpx）。main の大きさを測るまでは 0
  dpr: 1,
};

const els = {
  main: document.querySelector("main"),
  model: document.querySelector(".model"),
  image: document.querySelector(".model img"),
  imageMessage: document.querySelector(".model-message"),
  title: document.querySelector(".model .title"),
  meta: document.querySelector(".model .meta"),
  grid: document.querySelector("#grid"),
  loadError: document.querySelector(".load-error"),
  retry: document.querySelector("#retry"),
  toolbar: document.querySelector(".toolbar"),
  swatches: document.querySelectorAll(".swatch"),
  tools: document.querySelectorAll("[data-tool]"),
  undo: document.querySelector("#undo"),
  timer: document.querySelector(".timer"),
  swap: document.querySelector("#swap"),
};

// 色と寸法は style.css の :root にだけ書き、ここでは読むだけにする
const rootStyle = getComputedStyle(document.documentElement);
const cssValue = (name) => rootStyle.getPropertyValue(name).trim();
const colors = { values: [cssValue("--v0"), cssValue("--v1"), cssValue("--v2")], line: cssValue("--line") };
const GAP = parseFloat(cssValue("--gap"));
const CAPTION_HEIGHT = parseFloat(cssValue("--caption-height"));

let mainSize = null; // ResizeObserver で測った main の中身の大きさ

// プライベートブラウズなどでは localStorage を触るだけで例外になる
function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidArtwork(artwork) {
  return (
    typeof artwork?.id === "string" &&
    typeof artwork.image === "string" &&
    typeof artwork.answer === "string" &&
    artwork.answer.length === artwork.cols * artwork.rows &&
    /^[012]*$/.test(artwork.answer)
  );
}

async function loadArtworks() {
  const response = await fetch("artworks/index.json");
  if (!response.ok) throw new Error(`artworks/index.json: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.artworks)) throw new Error("artworks/index.json に artworks の配列がない");
  const artworks = data.artworks.filter((artwork) => {
    if (isValidArtwork(artwork)) return true;
    console.warn("形の合わない作品を外した", artwork?.id);
    return false;
  });
  if (artworks.length === 0) throw new Error("artworks/index.json に形の正しい作品が1つもない");
  return artworks;
}

function imagePath(artwork) {
  return "artworks/" + artwork.image;
}

// 塗りと経過時間は捨て、全部「中」から始める
function showArtwork(artwork) {
  state.artwork = artwork;
  state.view = "loading";
  state.imageFailed = false;
  state.answer = parseAnswer(artwork.answer);
  state.cells = new Uint8Array(artwork.cols * artwork.rows).fill(1);
  state.history = [];
  state.stroke = null;
  state.timer = { elapsed: 0, since: null };
  const src = imagePath(artwork);
  els.image.alt = artwork.title;
  els.title.textContent = artwork.title;
  els.meta.textContent = artwork.artist ? `${artwork.artist} · ${artwork.museum}` : artwork.museum;
  if (els.image.getAttribute("src") === src && els.image.complete && els.image.naturalWidth > 0) {
    // 作品が1枚しかないときなど、同じ画像のままなら load を待たない
    state.view = "paint";
  } else {
    els.image.src = src;
  }
  updateLayout();
  render();
}

function showToday() {
  state.today = localDateKey(new Date());
  const storage = getStorage();
  const swapId = readSwap(storage, state.today);
  const artwork = pickArtwork(state.artworks, state.today, swapId);
  // 替えた絵が index.json からなくなっていたら、今日の絵に戻してキーも消す
  if (swapId && artwork.id !== swapId) clearSwap(storage);
  showArtwork(artwork);
}

function swapArtwork() {
  // index.json を読み終える前と、読めなかったときは何もしない
  if (state.artwork === null) return;
  if (state.history.length > 0 && !confirm("塗ったマスが消えます。別の絵にしますか")) return;
  const index = state.artworks.indexOf(state.artwork);
  const next = state.artworks[(index + 1) % state.artworks.length];
  writeSwap(getStorage(), state.today, next.id);
  showArtwork(next);
}

// main の大きさと作品の向きから、お手本とマス目の大きさを決める
function updateLayout() {
  if (state.artwork === null || mainSize === null) return;
  const { cols, rows } = state.artwork;
  const { direction, cell } = fitLayout({
    width: mainSize.width,
    height: mainSize.height,
    cols,
    rows,
    gap: GAP,
    captionHeight: CAPTION_HEIGHT,
  });
  state.cell = cell;
  state.dpr = window.devicePixelRatio || 1;
  els.main.style.setProperty("--cell", `${cell}px`);
  els.main.style.setProperty("--cols", cols);
  els.main.style.setProperty("--rows", rows);
  els.main.dataset.direction = direction;
  // 中身の画素は devicePixelRatio 倍にして、高精細の画面でぼやけないようにする
  els.grid.width = Math.round(cell * cols * state.dpr);
  els.grid.height = Math.round(cell * rows * state.dpr);
  drawGrid();
}

// 192マスを全部描き直す。境目の線は内側にだけ、幅1px（CSSのpx）で引く
function drawGrid() {
  if (state.view !== "paint" || state.cell === 0) return;
  const { cols, rows } = state.artwork;
  const { cell, cells } = state;
  const ctx = els.grid.getContext("2d");
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ctx.fillStyle = colors.values[cells[row * cols + col]];
      ctx.fillRect(col * cell, row * cell, cell, cell);
    }
  }
  ctx.fillStyle = colors.line;
  for (let col = 1; col < cols; col++) ctx.fillRect(col * cell, 0, 1, rows * cell);
  for (let row = 1; row < rows; row++) ctx.fillRect(0, row * cell, cols * cell, 1);
}

function elapsedMs() {
  const { elapsed, since } = state.timer;
  return since === null ? elapsed : elapsed + (performance.now() - since);
}

// m:ss。60分を超えたら 75:03 のように分を伸ばす
function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// 塗る画面が見えている間だけ数える。画面を消して置いた時間は入れない
function syncTimer() {
  const running = state.view === "paint" && document.visibilityState === "visible";
  const now = performance.now();
  if (running && state.timer.since === null) {
    state.timer.since = now;
  } else if (!running && state.timer.since !== null) {
    state.timer.elapsed += now - state.timer.since;
    state.timer.since = null;
  }
}

// 秒が変わったときだけ書き換える
function updateTimerText() {
  const text = formatElapsed(elapsedMs());
  if (els.timer.textContent !== text) els.timer.textContent = text;
}

function render() {
  const error = state.view === "error";
  const painting = state.view === "paint";
  document.body.dataset.view = state.view;
  els.model.hidden = error;
  els.loadError.hidden = !error;
  els.toolbar.hidden = error;
  els.imageMessage.hidden = !state.imageFailed;
  for (const button of els.swatches) {
    button.disabled = !painting;
    button.setAttribute("aria-pressed", String(Number(button.dataset.color) === state.color));
  }
  for (const button of els.tools) {
    button.disabled = !painting;
    button.setAttribute("aria-pressed", String(button.dataset.tool === state.tool));
  }
  els.undo.disabled = !painting || state.history.length === 0;
  syncTimer();
  updateTimerText();
  drawGrid();
}

// 前の絵の読み込みが遅れて届いたときは無視する
function isCurrentImage() {
  return state.artwork !== null && els.image.getAttribute("src") === imagePath(state.artwork);
}

els.image.addEventListener("load", () => {
  if (!isCurrentImage() || state.view !== "loading") return;
  state.view = "paint";
  render();
});

els.image.addEventListener("error", () => {
  if (!isCurrentImage()) return;
  console.error("お手本の画像を読めなかった", els.image.src);
  state.imageFailed = true;
  render();
});

// 指の位置のマス。外なら null
function strokeCell(event) {
  const { rect } = state.stroke;
  const { cols, rows } = state.artwork;
  return cellAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, cols, rows);
}

// 前に塗ったマスから今のマスまでを線でつないで塗る。速く動かすと pointermove の間に何マスも進むため
function brushTo(cell) {
  const { stroke } = state;
  const { cols, rows } = state.artwork;
  const from = stroke.last ?? cell;
  let changed = false;
  for (const { col, row } of lineCells(from.col, from.row, cell.col, cell.row)) {
    if (paintBrush(state.cells, cols, rows, col, row, BRUSH_SIZE[state.tool], state.color)) changed = true;
  }
  stroke.last = cell;
  return changed;
}

els.grid.addEventListener("pointerdown", (event) => {
  // 2本目の指は、1本目を離すまで無視する
  if (state.view !== "paint" || state.stroke !== null) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  els.grid.setPointerCapture(event.pointerId);
  state.stroke = {
    pointerId: event.pointerId,
    last: null,
    before: state.cells.slice(),
    changed: false,
    rect: els.grid.getBoundingClientRect(),
  };
  const cell = strokeCell(event);
  if (cell === null) return;
  const { cols, rows } = state.artwork;
  const changed =
    state.tool === "fill"
      ? floodFill(state.cells, cols, rows, cell.col, cell.row, state.color)
      : brushTo(cell);
  if (changed) {
    state.stroke.changed = true;
    drawGrid();
  }
});

els.grid.addEventListener("pointermove", (event) => {
  const { stroke } = state;
  if (stroke === null || stroke.pointerId !== event.pointerId || state.tool === "fill") return;
  const cell = strokeCell(event);
  if (cell === null) {
    // 外に出たら塗らず、戻ってきた所から塗り直す
    stroke.last = null;
    return;
  }
  if (brushTo(cell)) {
    stroke.changed = true;
    drawGrid();
  }
});

// 指を置いてから離すまでを、戻すの1回にする
function endStroke(event) {
  const { stroke } = state;
  if (stroke === null || stroke.pointerId !== event.pointerId) return;
  if (stroke.changed) {
    state.history.push(stroke.before);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
  }
  state.stroke = null;
  render();
}

els.grid.addEventListener("pointerup", endStroke);
els.grid.addEventListener("pointercancel", endStroke);
els.grid.addEventListener("contextmenu", (event) => event.preventDefault());

for (const button of els.swatches) {
  button.addEventListener("click", () => {
    state.color = Number(button.dataset.color);
    render();
  });
}

for (const button of els.tools) {
  button.addEventListener("click", () => {
    state.tool = button.dataset.tool;
    render();
  });
}

els.undo.addEventListener("click", () => {
  // 別の指で塗っている途中は戻さない
  if (state.stroke !== null || state.history.length === 0) return;
  state.cells.set(state.history.pop());
  render();
});

els.swap.addEventListener("click", swapArtwork);
els.retry.addEventListener("click", () => location.reload());

new ResizeObserver(([entry]) => {
  mainSize = { width: entry.contentRect.width, height: entry.contentRect.height };
  updateLayout();
}).observe(els.main);

setInterval(updateTimerText, 250);

document.addEventListener("visibilitychange", () => {
  // 開いたまま朝を迎えたとき、見えたところで今日の絵に替える
  if (document.visibilityState === "visible" && state.artwork !== null && localDateKey(new Date()) !== state.today) {
    showToday();
    return;
  }
  syncTimer();
  updateTimerText();
});

try {
  state.artworks = await loadArtworks();
} catch (error) {
  console.error("作品の一覧を読めませんでした", error);
  state.view = "error";
  render();
}
if (state.view !== "error") showToday();
