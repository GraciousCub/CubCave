/* The Cub Cave — service worker (Phase 1: offline app shell only).
 *
 * Push handling is added in Phase 4.
 *
 * Bump CACHE_VERSION whenever the shell files change, otherwise returning
 * visitors keep getting the old cached copies.
 */

'use strict';

var CACHE_VERSION = 'cubcave-shell-v27';

var SHELL_FILES = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './js/store.js',
  './js/drive.js',
  './js/sync.js',
  './js/push.js',
  './js/search.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// config.js holds the OAuth Client ID and is the file most likely to be edited
// without a CACHE_VERSION bump. Always try the network for it first, so a
// freshly deployed Client ID takes effect immediately instead of being masked
// by a cached empty config.
var NETWORK_FIRST = ['/js/config.js'];

function isNetworkFirst(pathname) {
  return NETWORK_FIRST.some(function (suffix) {
    return pathname.endsWith(suffix);
  });
}

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

/* ---------- push notifications (Phase 4) ---------- */

/* Push payloads are handled here rather than via the Firebase SW SDK. One
 * worker, one handler, and no risk of both the SDK and this file showing the
 * same alert twice. Phase 5 sends data-only messages, but the parsing below
 * accepts a `notification` payload too, so a message sent either way works. */

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    // Not JSON — fall back to the raw text as the body.
    payload = { notification: { body: event.data ? event.data.text() : '' } };
  }

  var n = payload.notification || {};
  var d = payload.data || {};

  var title = n.title || d.title || 'The Cub Cave';
  var body = n.body || d.body || 'A comic on your list is out today.';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      // A shared tag means a second alert replaces the first rather than
      // stacking up if the job somehow runs twice.
      tag: d.tag || 'cubcave-release',
      renotify: true,
      data: { url: d.url || './' }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';

  // Focus the app if it's already open; only open a new window otherwise.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (windows) {
        for (var i = 0; i < windows.length; i++) {
          if ('focus' in windows[i]) return windows[i].focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
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

  // Config: network first, cache only as an offline fallback.
  if (isNetworkFirst(url.pathname)) {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return caches.match(request);
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
