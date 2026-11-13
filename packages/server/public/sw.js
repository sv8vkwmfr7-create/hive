/* 蜂巢审批 PWA Service Worker：壳缓存 + API 直连（数据永远走网络，不缓存决策数据） */
const CACHE = "hive-approve-v2"; // 改壳资源（style.css/approve.*）必须 bump 版本，否则已装 PWA 永远拿旧缓存
const SHELL = ["/approve.html", "/approve.css", "/approve.js", "/style.css", "/manifest.json", "/icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return; // 决策数据直连
  e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request)));
});
