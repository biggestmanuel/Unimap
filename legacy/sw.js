/**
 * UniMap Service Worker v2
 * Advanced caching, stale-while-revalidate, smart prefetching
 */

const CACHE_VERSION = 'unimap-v2';
const CRITICAL_ASSETS = [
  '/',
  '/index.html',
  '/unimap.css',
  '/unimap.js'
];
const DATA_CACHE = 'unimap-data-v1';
const TILE_CACHE = 'unimap-tiles-v1';

// Install: Cache critical assets only
self.addEventListener('install', (event) => {
  console.log('[SW] Installing');
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(CRITICAL_ASSETS).catch((err) => {
        console.warn('[SW] Non-critical asset cache failed');
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate: Cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (![CACHE_VERSION, DATA_CACHE, TILE_CACHE].includes(name)) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: Smart routing based on asset type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin and POST requests
  if (url.origin !== self.location.origin || request.method !== 'GET') {
    return;
  }

  // Map tiles: Cache-first (rarely change)
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(cacheFirstStrategy(request, TILE_CACHE));
    return;
  }

  // API data (geojson, events): Stale-while-revalidate (fast + fresh)
  if (url.pathname.includes('.geojson') || url.pathname.includes('events.json')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // HTML/CSS/JS: Cache-first with network refresh
  if (url.pathname.match(/\.(html|css|js|woff2|svg)$/)) {
    event.respondWith(cacheFirstStrategy(request, CACHE_VERSION));
    return;
  }

  // Other: Network-first
  event.respondWith(networkFirstStrategy(request));
});

/**
 * Cache-first strategy: Use cached, fall back to network
 */
function cacheFirstStrategy(request, cacheName) {
  return caches.open(cacheName).then((cache) => {
    return cache.match(request).then((response) => {
      if (response) return response;
      return fetchWithTimeout(request, 5000).then((response) => {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(() => {
        return createOfflineResponse();
      });
    });
  });
}

/**
 * Stale-while-revalidate: Return cached immediately, update in background
 */
function staleWhileRevalidate(request) {
  return caches.open(DATA_CACHE).then((cache) => {
    return cache.match(request).then((cachedResponse) => {
      const fetchPromise = fetchWithTimeout(request, 8000)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      return cachedResponse || fetchPromise || createOfflineResponse();
    });
  });
}

/**
 * Network-first strategy: Try network first, fall back to cache
 */
function networkFirstStrategy(request) {
  return fetchWithTimeout(request, 5000)
    .then((response) => {
      if (response && response.status === 200) {
        caches.open(CACHE_VERSION).then((cache) => {
          cache.put(request, response.clone());
        });
      }
      return response;
    })
    .catch(() => {
      return caches.match(request) || createOfflineResponse();
    });
}

/**
 * Fetch with strict timeout
 */
function fetchWithTimeout(request, timeout) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeout)
    )
  ]);
}

/**
 * Offline fallback
 */
function createOfflineResponse() {
  return new Response(JSON.stringify({ error: 'Offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}
