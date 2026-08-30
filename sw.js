self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("formcoach-v1").then((c) => c.addAll(["./", "./index.html", "./styles.css", "./app.js", "./manifest.json"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
