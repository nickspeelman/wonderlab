const CACHE = 'roscoe-wonder-lab-26.5';

const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/companion-qr.png'
];

const CORE_PATHS = new Set([
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.webmanifest'
]);

function isCoreRequest(request) {
  if (request.mode === 'navigate') return true;
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return CORE_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

async function cacheFreshAsset(cache, asset) {
  // Bypass the browser HTTP cache when installing a new Wonder Lab build.
  // Otherwise Chrome can hand the new service worker an older app.js/styles.css.
  const response = await fetch(asset, { cache: 'reload' });
  if (!response.ok) throw new Error(`Could not cache ${asset}: ${response.status}`);
  await cache.put(asset, response);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(asset => cacheFreshAsset(cache, asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();

    // A newly activated worker can otherwise coexist with an already-open page
    // that was assembled from the previous cache. Reload open Wonder Lab windows
    // once so HTML, CSS and JS all come from the same build.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(client => {
      if (!client.url.startsWith(self.location.origin)) return Promise.resolve();
      return client.navigate(client.url).catch(() => {});
    }));
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (isCoreRequest(event.request)) {
    // Network-first for the application shell. A successful online request is
    // written back to the current cache; offline use falls back to cached files.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response && response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        throw new Error('Offline and no cached core asset is available.');
      }
    })());
    return;
  }

  // Cache-first remains appropriate for immutable/heavy assets such as icons,
  // audio and activity media. Fetch and cache anything we have not seen yet.
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response && response.ok && new URL(event.request.url).origin === self.location.origin) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      throw new Error('Offline and asset is not cached.');
    }
  })());
});
