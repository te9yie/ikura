import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { runInContext, createContext } from "node:vm";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url));
const readText = (path) => read(path).toString("utf8");
const exists = (path) => existsSync(new URL("../" + path, import.meta.url));

// sw.js は classic script なので import できない。self と globals を持つ文脈で流し、トップレベルの値を取り出す
function loadServiceWorker(globals = {}) {
  const context = createContext({ self: { addEventListener() {} }, ...globals });
  runInContext(readText("sw.js"), context);
  return runInContext("({ VERSION, PRECACHE, INDEX, routeOf, fromApp, fromIndex, fromArtworks })", context);
}

const { VERSION, PRECACHE, INDEX, routeOf } = loadServiceWorker();
const manifest = JSON.parse(readText("manifest.webmanifest"));
const indexHtml = readText("index.html");
const bg = readText("style.css").match(/--bg:\s*(#[0-9a-fA-F]{6})\s*;/)?.[1];

// "./" は index.html の中身
const fileOf = (path) => (path === "./" ? "index.html" : path);

// index.html の src・href の値
const htmlRefs = [...indexHtml.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1]);

// ルートからの相対パス path を、from のファイルからの相対で解決する
const resolve = (path, from) => new URL(path, "https://example.com/" + from).pathname.slice(1);

// .js が相対で import するファイル。静的な import・export … from・import() を拾う
function jsImports(file) {
  const specs = readText(file).matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g);
  return [...specs].map((match) => resolve(match[1], file));
}

// style.css の url(...) が読むファイル。data: と外部のURLは除く
function cssUrls(file) {
  const urls = readText(file).matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g);
  return [...urls].map((match) => match[1]).filter((url) => !/^(data:|[a-z]+:\/\/|\/\/|#)/i.test(url)).map((url) => resolve(url, file));
}

// rel が rel の link の href
function linkHref(rel) {
  const tag = indexHtml.match(new RegExp(`<link[^>]*\\brel="${rel}"[^>]*>`))?.[0];
  return tag?.match(/\bhref="([^"]*)"/)?.[1];
}

// PNGの幅と高さ。IHDRの16〜19バイト目と20〜23バイト目にビッグエンディアンで入っている
function pngSize(path) {
  const data = read(path);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test("VERSION は PRECACHE のファイルの中身のハッシュ", () => {
  const hash = createHash("sha256");
  for (const path of PRECACHE) {
    const file = fileOf(path);
    hash.update(file + "\n");
    // 端末によってCRLFとLFが違うので、そろえてから計る
    hash.update(readText(file).replace(/\r\n/g, "\n"));
  }
  const expected = hash.digest("hex").slice(0, 12);
  assert.equal(VERSION, expected, `sw.js の VERSION を "${expected}" にする`);
});

test("PRECACHE のファイルがある", () => {
  for (const path of PRECACHE) assert.ok(exists(fileOf(path)), path);
  assert.ok(exists(INDEX));
});

test("index.html・app.js・lib の .js・style.css が読むファイルが PRECACHE にある", () => {
  for (const ref of htmlRefs) {
    if (ref === "manifest.webmanifest" || ref.startsWith("icons/")) continue;
    assert.ok(PRECACHE.includes(ref), `${ref} を PRECACHE に足す（index.html が読む）`);
  }
  // app.js と lib の下の .js から import をたどる。lib の外に置いたモジュールも、たどった先で見る
  const libs = readdirSync(new URL("../lib/", import.meta.url), { recursive: true })
    .map((name) => "lib/" + name.replaceAll("\\", "/"))
    .filter((path) => path.endsWith(".js"));
  const queue = ["app.js", ...libs];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.shift();
    for (const path of jsImports(file)) {
      assert.ok(PRECACHE.includes(path), `${path} を PRECACHE に足す（${file} が import する）`);
      if (!seen.has(path) && exists(path)) {
        seen.add(path);
        queue.push(path);
      }
    }
  }
  for (const path of cssUrls("style.css")) {
    assert.ok(PRECACHE.includes(path), `${path} を PRECACHE に足す（style.css が読む）`);
  }
});

test("Cache Storage が例外を投げても、ネットワークの結果を返す", async () => {
  const response = { ok: true, status: 200, clone() { return this; } };
  const broken = () => Promise.reject(new Error("broken"));
  const sw = loadServiceWorker({ caches: { open: broken }, fetch: async () => response });
  const event = { waitUntil() {} };
  assert.equal(await sw.fromApp("app.js", "app.js"), response);
  assert.equal(await sw.fromIndex(event, INDEX), response);
  assert.equal(await sw.fromArtworks("artworks/a.jpg"), response);
  // オフラインで画像が取れないときは、今までどおり失敗させる
  const offline = loadServiceWorker({ caches: { open: broken }, fetch: broken });
  await assert.rejects(offline.fromArtworks("artworks/a.jpg"));
});

test("PRECACHE に sw.js・manifest・アイコンを入れない", () => {
  for (const path of PRECACHE) {
    assert.ok(path !== "sw.js" && path !== "manifest.webmanifest" && !path.startsWith("icons/"), path);
  }
});

test("routeOf は scope からの相対パスで扱いを決める", () => {
  const scope = "https://te9yie.github.io/ikura/";
  const cases = [
    ["https://te9yie.github.io/ikura/", "app"],
    ["https://te9yie.github.io/ikura/index.html", "app"],
    ["https://te9yie.github.io/ikura/lib/day.js", "app"],
    ["https://te9yie.github.io/ikura/artworks/index.json", "index"],
    ["https://te9yie.github.io/ikura/artworks/index.json?x=1", "index"],
    ["https://te9yie.github.io/ikura/artworks/met-436065.jpg", "artwork"],
    ["https://te9yie.github.io/ikura/manifest.webmanifest", null],
    ["https://te9yie.github.io/ikura/icons/icon-192.png", null],
    ["https://te9yie.github.io/ikura/sw.js", null],
    ["https://te9yie.github.io/other/app.js", null],
    ["https://example.com/ikura/app.js", null],
  ];
  for (const [url, route] of cases) assert.equal(routeOf(url, scope), route, url);
});

test("manifest のパスは相対で、色は style.css の --bg と同じ", () => {
  // id は start_url のオリジンを基準に解決されるので "ikura" は /ikura になり、start_url の /ikura/ と違う値になる
  assert.equal(manifest.id, "ikura");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  for (const icon of manifest.icons) assert.doesNotMatch(icon.src, /^(\/|http)/, icon.src);
  assert.ok(bg, "style.css に --bg がない");
  assert.equal(manifest.background_color, bg);
  assert.equal(manifest.theme_color, bg);
});

test("manifest のアイコンがあり、大きさが sizes と合う", () => {
  for (const icon of manifest.icons) {
    assert.ok(exists(icon.src), icon.src);
    const { width, height } = pngSize(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
  assert.equal(manifest.icons.filter((icon) => icon.purpose === "maskable").length, 1);
});

test("index.html の manifest とアイコンがあり、パスは相対", () => {
  for (const rel of ["manifest", "apple-touch-icon", "icon"]) {
    const href = linkHref(rel);
    assert.ok(href && exists(href), rel);
  }
  assert.deepEqual(pngSize(linkHref("apple-touch-icon")), { width: 180, height: 180 });
  assert.deepEqual(pngSize(linkHref("icon")), { width: 32, height: 32 });
  for (const ref of htmlRefs) assert.doesNotMatch(ref, /^\//, ref);
});
