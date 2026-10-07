// 今日の1枚の選び方と、「別の絵」の保存。DOMには触らず、localStorage は引数で受け取る。

// 決めたあとは変えない。変えると、その日から出る絵がずれる
export const BASE_DATE = "2026-01-01";

export const SWAP_KEY = "ikura.swap";

// 端末のローカル日付を "YYYY-MM-DD" にする
export function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 年月日だけを UTC の暦に載せて数えるので、時差と夏時間が入らない
function dayNumber(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function dailyIndex(todayKey, count) {
  const days = dayNumber(todayKey) - dayNumber(BASE_DATE);
  return ((days % count) + count) % count;
}

// 今日「別の絵」で替えた作品のIDを返す。日付が違う値や読めない値は消して null を返す
export function readSwap(storage, todayKey) {
  let raw;
  try {
    raw = storage.getItem(SWAP_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // 下で消す
  }
  if (value?.date === todayKey && typeof value.id === "string") return value.id;
  clearSwap(storage);
  return null;
}

// 書けなくても絵は替える。開き直すと今日の絵に戻るだけなので、失敗は無視する
export function writeSwap(storage, todayKey, id) {
  try {
    storage.setItem(SWAP_KEY, JSON.stringify({ date: todayKey, id }));
  } catch {
    // 無視する
  }
}

export function clearSwap(storage) {
  try {
    storage.removeItem(SWAP_KEY);
  } catch {
    // 無視する
  }
}

// swapId の作品が artworks にあればそれを、なければ今日の1枚を返す
export function pickArtwork(artworks, todayKey, swapId) {
  if (swapId) {
    const swapped = artworks.find((artwork) => artwork.id === swapId);
    if (swapped) return swapped;
  }
  return artworks[dailyIndex(todayKey, artworks.length)];
}
