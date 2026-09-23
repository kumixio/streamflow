
const CACHE_NAME = 'streamflow-v2-cache';
const CACHE_VERSION = '1.8.1';
const FULL_CACHE_NAME = `${CACHE_NAME}-${CACHE_VERSION}`;

const STATIC_RESOURCES = [
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.30.0/tabler-icons.min.css',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.30.0/fonts/tabler-icons.woff2',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.30.0/fonts/tabler-icons.woff',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.30.0/fonts/tabler-icons.ttf',

  '/css/styles.css',
  '/js/csrf.js',
  '/js/custom-dialog.js',
  '/js/schedule-picker.js',
  '/js/stream-modal.js',

  '/images/kumix-logo.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(FULL_CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Caching static resources');
        return Promise.allSettled(
          STATIC_RESOURCES.map(resource => cache.add(resource).catch(() => {}))
        );
      })
      .then(() => {
        console.log('Service Worker: All resources cached successfully');
      })
      .catch((error) => {
        console.error('Service Worker: Failed to cache resources', error);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName.startsWith(CACHE_NAME) && cacheName !== FULL_CACHE_NAME) {
              console.log('Service Worker: Deleting old cache', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('Service Worker: Activated');
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = event.request.url;
  // Ignore non-HTTP/HTTPS schemes (e.g. chrome-extension://)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return;
  }

  const isFontRequest = url.includes('tabler-icons') ||
                        url.endsWith('.woff2') ||
                        url.endsWith('.woff') ||
                        url.endsWith('.ttf');

  if (isFontRequest) {
    event.respondWith(
      caches.match(event.request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          return fetch(event.request)
            .then((response) => {
              if (!response || response.status !== 200) {
                return response;
              }
              const responseToCache = response.clone();
              caches.open(FULL_CACHE_NAME)
                .then((cache) => {
                  cache.put(event.request, responseToCache).catch(() => {});
                })
                .catch(() => {});
              return response;
            });
        })
    );
    return;
  }

  if (isStaticResource(url)) {
    // Network-first so UI changes show up on a normal refresh; the cache
    // is only a fallback when the server is unreachable.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200 || response.type !== 'basic' && response.type !== 'cors') {
            return response;
          }

          const responseToCache = response.clone();

          caches.open(FULL_CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, responseToCache).catch(() => {});
            })
            .catch(() => {});

          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
  }
});

function isStaticResource(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  return STATIC_RESOURCES.some(resource => url.includes(resource)) ||
         url.includes('tabler-icons') ||
         url.includes('cdn.jsdelivr.net') ||
         url.endsWith('.css') ||
         url.endsWith('.js') ||
         url.endsWith('.woff2') ||
         url.endsWith('.woff') ||
         url.endsWith('.ttf') ||
         url.endsWith('.svg');
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});