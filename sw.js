const CACHE = 'roscoe-wonder-lab-27.0';

const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/companion-qr.png',
  './assets/icons/favicon.ico',
  './assets/images/santa.png',
  './assets/images/trick-or-treaters.png',
  './audio/ui/broom.mp3',
  './audio/ui/click.mp3',
  './audio/ui/home.mp3',
  './audio/ui/pop.mp3',
  './audio/ui/toggle.mp3',
  './audio/switches/bubbles.mp3',
  './audio/switches/light.mp3',
  './audio/switches/lightning.mp3',
  './audio/switches/rain.mp3',
  './audio/switches/rainbow.mp3',
  './audio/switches/snow.mp3',
  './audio/switches/stars.mp3',
  './audio/switches/train.mp3',
  './audio/switches/wind.mp3',
  './audio/motion/bounce.mp3',
  './audio/motion/collision.mp3',
  './audio/motion/drop.mp3',
  './audio/motion/pickup.mp3',
  './audio/motion/remove.mp3',
  './audio/motion/spawn.mp3',
  './audio/time/bell.mp3',
  './audio/time/birds.mp3',
  './audio/time/clock-tick.mp3',
  './audio/time/crickets.mp3',
  './audio/time/fireworks.mp3',
  './audio/time/leaves.mp3',
  './audio/time/owl.mp3',
  './audio/time/rooster.mp3',
  './audio/time/sleigh-bells.mp3',
  './audio/time/trick-or-treat.mp3',
  './audio/time/winter-wind.mp3'
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


function isAudioRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin &&
      url.pathname.startsWith('/audio/') &&
      url.pathname.toLowerCase().endsWith('.mp3');
  } catch {
    return false;
  }
}

async function getFullAudioResponse(request) {
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);

  // Match by URL rather than by the Range-bearing Request object. This makes
  // sure a cached full MP3 can satisfy media requests such as bytes=0-.
  let response = await cache.match(url.href, { ignoreSearch: true });
  if (response) return response;

  // If an audio file somehow missed precaching, fetch the complete file (not
  // the requested byte range), cache it, and then serve from that full copy.
  try {
    response = await fetch(url.href, { cache: 'no-store' });
    if (response && response.ok) {
      await cache.put(url.href, response.clone());
      return response;
    }
  } catch {
    // Fall through to a clean 503 response below.
  }

  return null;
}

async function serveAudioRequest(request) {
  const rangeHeader = request.headers.get('range');

  // Let the network/server satisfy Range requests when online. This avoids the
  // old worker path that materialized an entire multi-megabyte MP3 in memory for
  // every requested slice. ChromeOS is especially sensitive to that overhead.
  if (rangeHeader) {
    try {
      const ranged = await fetch(request);
      if (ranged && (ranged.ok || ranged.status === 206)) return ranged;
    } catch {
      // Offline: fall back to the complete precached response below. Browsers can
      // play a full 200 response even when the speculative request used Range.
    }
  }

  const fullResponse = await getFullAudioResponse(request);
  if (!fullResponse) {
    return new Response('Audio asset unavailable.', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
  return fullResponse;
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

  // Media elements commonly use HTTP Range requests. Serve MP3s from the
  // full precached file and synthesize a proper 206 Partial Content response.
  if (isAudioRequest(event.request)) {
    event.respondWith(serveAudioRequest(event.request));
    return;
  }

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
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response && response.ok && new URL(event.request.url).origin === self.location.origin) {
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      if (event.request.mode === 'navigate') return cache.match('./index.html');
      return new Response('Asset unavailable.', {
        status: 503,
        statusText: 'Service Unavailable'
      });
    }
  })());
});
