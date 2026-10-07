// 入口。状態を持ち、DOMとイベントをつなぐ。ブラウザに触るのはこのファイルだけにする
import { localDateKey, readSwap, writeSwap, clearSwap, pickArtwork } from "./lib/day.js";

const state = {
  view: "loading", // "loading" | "paint" | "error"
  artworks: [], // index.json の artworks のうち、形の正しいもの
  today: null, // 絵を選んだときのローカル日付
  artwork: null, // 今出している作品（index.json の1件）
  imageFailed: false, // お手本の画像を読めなかった
};

const els = {
  model: document.querySelector(".model"),
  image: document.querySelector(".model img"),
  imageMessage: document.querySelector(".model-message"),
  title: document.querySelector(".model .title"),
  meta: document.querySelector(".model .meta"),
  loadError: document.querySelector(".load-error"),
  retry: document.querySelector("#retry"),
  toolbar: document.querySelector(".toolbar"),
  swap: document.querySelector("#swap"),
};

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

function showArtwork(artwork) {
  state.artwork = artwork;
  state.view = "loading";
  state.imageFailed = false;
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
  const index = state.artworks.indexOf(state.artwork);
  const next = state.artworks[(index + 1) % state.artworks.length];
  writeSwap(getStorage(), state.today, next.id);
  showArtwork(next);
}

function render() {
  const error = state.view === "error";
  document.body.dataset.view = state.view;
  els.model.hidden = error;
  els.loadError.hidden = !error;
  els.toolbar.hidden = error;
  els.imageMessage.hidden = !state.imageFailed;
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

els.swap.addEventListener("click", swapArtwork);
els.retry.addEventListener("click", () => location.reload());

// 開いたまま朝を迎えたとき、見えたところで今日の絵に替える
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || state.artwork === null) return;
  if (localDateKey(new Date()) !== state.today) showToday();
});

try {
  state.artworks = await loadArtworks();
} catch (error) {
  console.error("作品の一覧を読めませんでした", error);
  state.view = "error";
  render();
}
if (state.view !== "error") showToday();
