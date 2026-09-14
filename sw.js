/* Cyber Portal サービスワーカー
   - アプリシェル(HTML/CSS/JS/アイコン/ヒーロー画像)をキャッシュしてオフライン起動可能に
   - HTML はネットワーク優先(デプロイが即反映)、静的アセットは stale-while-revalidate
   - バックエンド API(別オリジン)は素通し
   - 通知クリックでポータルを前面化 */
// このバージョン番号を上げるだけでデプロイ反映が完結する(index.html 側の ?v= は廃止)。
// install で {cache:"reload"} 指定の fetch を使い、GitHub Pages の CDN エッジキャッシュ
// (max-age=600)を貫通して常に最新のシェルを取り込む。フッターの vX.Y.Z は表示用。
const CACHE = "cyber-portal-shell-v157";
// ヒーロー画像はここに入れない。install 時に全部(4枚)を事前DLしていたが、
// 実際は1枚しか使わない(スマホは0枚)。fetch ハンドラの stale-while-revalidate
// で、実際に表示されたものだけ実行時にキャッシュされる。
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./auth.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

// 起動に必須のシェル。1つでも取れなければ install を失敗させ、旧 SW と旧キャッシュを残す
// (以前は失敗を握りつぶして skipWaiting → activate で旧キャッシュを消し、欠けたシェルで動いていた)。
const CORE = ["./index.html", "./style.css", "./app.js", "./auth.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(
        SHELL.map((u) =>
          fetch(new Request(u, { cache: "reload" }))
            .then((res) => {
              if (res && res.ok) return c.put(u, res);
              throw new Error("shell fetch failed: " + u + " " + (res && res.status));
            })
            .catch((err) => { if (CORE.includes(u)) throw err; })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API 等はブラウザ既定に任せる

  const isHTML =
    req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    e.respondWith(
      // 既定の HTTP キャッシュ(Pages の max-age=600)に当たると、デプロイ直後に古い index.html が
      // 返って新しい app.js と食い違う。no-cache で毎回再検証する(変わっていなければ 304 で軽い)。
      fetch(new Request(req, { cache: "no-cache" }))
        .then((res) => {
          // エラーページはキャッシュしない。SPA なので保存先は index.html 1つに正規化する。
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("./index.html").then((m) => m || caches.match("./")))
    );
    return;
  }

  // 静的アセット: キャッシュ即返し + 裏で更新
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        // 裏の更新も no-cache で再検証する。HTTP キャッシュの古いコピーが、install で
        // 取り込んだ新しい app.js / style.css を上書きするのを防ぐ。
        const network = fetch(new Request(req, { cache: "no-cache" }))
          .then((res) => {
            if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
