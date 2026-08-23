const CACHE = 'companion-v1';
const SHELL = ['.', 'index.html', 'app.js', 'manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('api.github.com')) return; // данные всегда из сети
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
