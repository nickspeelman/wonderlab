const CACHE = 'roscoe-wonder-lab-v24.1';
const ASSETS = [
  './', './index.html', './css/styles.css', './js/config.js', './js/app.js', './manifest.webmanifest',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(resp => {
    const clone = resp.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, clone));
    return resp;
  }).catch(() => caches.match('./index.html'))));
});
