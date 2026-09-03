/* Cyber Portal サービスワーカー
   - アプリシェル(HTML/CSS/JS/アイコン/ヒーロー画像)をキャッシュしてオフライン起動可能に
   - HTML はネットワーク優先(デプロイが即反映)、静的アセットは stale-while-revalidate
   - バックエンド API(別オリジン)は素通し
   - 通知クリックでポータルを前面化 */
const CACHE = "cyber-portal-shell-v8";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./auth.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./hero1.jpg",
  "./hero2.jpg",
  "./hero3.jpg",
  "./hero4.jpg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
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
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
    );
    return;
  }

  // 静的アセット: キャッシュ即返し + 裏で更新
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
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
