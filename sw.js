// service worker。scope を /ikura/ 全体にするため、リポジトリのルートに置く。
// アプリのファイルは版ごとのキャッシュから出し、作品の一覧は毎回取りに行き、作品の画像は開いたものだけを残す

// PRECACHE のファイルの中身のハッシュ。ファイルを変えると tests/pwa.test.js が落ち、入れる値を出す
const VERSION = "c7e19148a355";

// "./" が index.html の中身になる。manifest・アイコン・sw.js はオフラインで要らないので入れない
const PRECACHE = ["./", "style.css", "app.js", "lib/day.js", "lib/grid.js", "lib/layout.js", "lib/score.js"];
const INDEX = "artworks/index.json";

// te9yie.github.io のほかのリポジトリのPagesも同じオリジンでCache Storageを分け合うので、名前は ikura- で始める
const APP_CACHE = `ikura-app-${VERSION}`;
// 開いた作品の画像。アプリを直すたびに消えないよう、版と分ける
const ARTWORK_CACHE = "ikura-artworks";

// 作品の一覧をネットワークで待つ長さ。弱いWi-Fiで「読み込み中」のまま止まらないようにする
const INDEX_TIMEOUT_MS = 3000;

// scope からの相対パス。クエリとフラグメントは外す。scope の外なら null
function pathOf(url, scope) {
  if (!url.startsWith(scope)) return null;
  return url.slice(scope.length).split(/[?#]/)[0];
}

// scope からの相対パスで扱いを決める。"app" | "index" | "artwork" | null
function routeOf(url, scope) {
  const path = pathOf(url, scope);
  if (path === null) return null;
  if (path === INDEX) return "index";
  if (path.startsWith("artworks/") && path.endsWith(".jpg")) return "artwork";
  if (path === "" || path === "index.html" || PRECACHE.includes(path)) return "app";
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) =>
      // HTTPのキャッシュに残った古いファイルを入れないよう、必ずネットワークから取る
      cache.addAll([...PRECACHE, INDEX].map((path) => new Request(path, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("ikura-app-") && name !== APP_CACHE) await caches.delete(name);
      }
      // 初めて開いた画面は service worker なしで読まれているので、claim してその画面の画像もキャッシュに入れる
      await self.clients.claim();
    })(),
  );
});

// 開いたまま日付が変わったとき、app.js から呼ばれて新しい版に替わる
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const scope = self.registration.scope;
  const route = routeOf(request.url, scope);
  if (route === "app") event.respondWith(fromApp(request, scope + appKey(pathOf(request.url, scope))));
  else if (route === "index") event.respondWith(fromIndex(event, scope + INDEX));
  else if (route === "artwork") event.respondWith(fromArtworks(request));
});

// index.html は "./" で入れてあるので、/ikura/index.html を開いたときも "./" を返す
function appKey(path) {
  return path === "index.html" ? "" : path;
}

// cache-first。全部が同じ版でそろい、起動がネットワークを待たない
async function fromApp(request, key) {
  try {
    const cached = await (await caches.open(APP_CACHE)).match(key);
    if (cached) return cached;
  } catch {
    // Cache Storage が使えなければネットワークから取る
  }
  return fetch(request);
}

// network-first。作品を足した日にiPadとAndroidで同じ絵を出すため、起動のたびに最新を取る。
// GitHub Pagesは max-age=600 を返すので、no-cache でETagを確かめさせる
function fromIndex(event, url) {
  const network = fetch(url, { cache: "no-cache" }).then(async (response) => {
    if (response.ok) {
      try {
        await (await caches.open(APP_CACHE)).put(url, response.clone());
      } catch {
        // 入れられなくても、取れた一覧は返す
      }
    }
    return response;
  });
  // 待つのを諦めたあとも、返ってきたらキャッシュを書き換える。次に開いたときに使われる
  event.waitUntil(network.catch(() => {}));
  return (async () => {
    let cached;
    try {
      cached = await (await caches.open(APP_CACHE)).match(url);
    } catch {
      return network;
    }
    if (!cached) return network;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), INDEX_TIMEOUT_MS));
    const response = await Promise.race([network.catch(() => null), timeout]);
    return response?.ok ? response : cached;
  })();
}

// cache-first。なければネットワークから取り、200ならキャッシュに入れる。
// オフラインで取れなければ失敗させ、<img> に error を届ける
async function fromArtworks(request) {
  let cache;
  try {
    cache = await caches.open(ARTWORK_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
  } catch {
    // Cache Storage が使えなければネットワークから取り、入れずに返す
    return fetch(request);
  }
  const response = await fetch(request);
  if (response.status === 200) await cache.put(request, response.clone()).catch(() => {});
  return response;
}
