/* The Cub Cave — service worker (Phase 1: offline app shell only).
 *
 * Push handling is added in Phase 4.
 *
 * Bump CACHE_VERSION whenever the shell files change, otherwise returning
 * visitors keep getting the old cached copies.
 */

'use strict';

var CACHE_VERSION = 'cubcave-shell-v1';

var SHELL_FILES = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(SHELL_FILES); })
      // Take over immediately rather than waiting for every tab to close.
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE_VERSION ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;

  // Only same-origin traffic is cached. Google Drive, Firebase and Gemini
  // calls in later phases must always hit the network.
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, so a deployed update is picked up on the next
  // launch; fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Assets: cache first for instant offline load, filling the cache on miss.
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      });
    })
  );
});
