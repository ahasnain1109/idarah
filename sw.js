/**
 * Idarah - Service Worker
 * sw.js
 * 
 * Plain-English Purpose:
 * Enables complete offline capability and PWA (Progressive Web App) installability
 * for Android and iPhone (iOS Safari). Caches all local core application files
 * so the app loads instantly even with zero internet connectivity.
 */

// build-id.js is generated on every deploy (scripts/generate-config.js). A new deploy changes it,
// so the browser sees a new service worker, replaces the old cache and tells open pages to reload.
try { importScripts('./build-id.js'); } catch (e) { /* local dev without a build: fine */ }
const CACHE_NAME = 'idarah-cache-' + (self.BUILD_ID || 'dev');

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './platform.css',
  './config.js',
  './platform-modules.js',
  './platform-core.js',
  './platform-onboarding.js',
  './platform-ui.js',
  './platform-finance.js',
  './platform-madarsa.js',
  './platform-mosque.js',
  './platform-reports.js',
  './platform-app.js',
  './manifest.json',
  './icon.svg'
];

// Install Event: pre-caches all static core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: cleans up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event: Cache-first strategy with network fallback
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Network-first: users get fresh code after every deploy; cache is the offline fallback.
  event.respondWith(
    fetch(event.request).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        // Offline fallback for HTML navigation
        if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});
