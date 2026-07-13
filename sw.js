/**
 * UniMap Service Worker
 * Provides offline caching, fast load times, and low-network resilience
 */

const CACHE_VERSION = 'unimap-v1';
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/unimap.css',
  '/unimap.js'
];

// Install: Cache critical assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker');
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('[SW] Caching critical assets');
      return cache.addAll(CACHE_ASSETS).catch((err) => {
        console.warn('[SW] Some assets failed to cache:', err);
        // Don't fail install if some assets fail
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_VERSION) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: Network-first with cache fallback for APIs, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // API calls: Network-first with timeout fallback
  if (url.pathname.includes('/api/') || url.pathname.includes('geojson')) {
    event.respondWith(fetchWithTimeout(request, 5000).catch(() => {
      return caches.match(request) || createOfflineResponse();
    }));
    return;
  }

  // Assets (CSS, JS, HTML): Cache-first, network fallback
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        // Only cache successful responses
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        return createOfflineResponse();
      });
    })
  );
});

/**
 * Fetch with timeout
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
 * Create offline fallback response
 */
function createOfflineResponse() {
  return new Response(
    '<h1>Connection Issue</h1><p>You are offline or have a poor connection. Using cached data.</p>',
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({
        'Content-Type': 'text/html'
      })
    }
  );
}
