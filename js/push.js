/* The Cub Cave — push notifications, client side (Phase 4).
 *
 * Flow: user taps Enable → load the Firebase SDK → ask for permission →
 * fetch an FCM token → store it in the Drive JSON so the daily Cloud Function
 * (Phase 5) knows where to send.
 *
 * WHY PERMISSION IS ONLY REQUESTED ON A TAP
 * Asking on page load is the classic way to get permanently denied: browsers
 * increasingly auto-block prompts that aren't tied to a user gesture, and a
 * denial cannot be re-requested by the page — the user has to dig through
 * browser settings to undo it. One tap on an explicit button is also what iOS
 * requires.
 *
 * IOS
 * Web push works on iOS 16.4+ ONLY for apps added to the Home Screen. In a
 * normal Safari tab the Notification API is typically absent altogether, so
 * we detect that and explain rather than failing silently.
 *
 * The Firebase SDK is loaded on demand rather than on every launch — it is
 * ~150KB and most launches never touch notifications.
 */

'use strict';

var CubCave = window.CubCave || (window.CubCave = {});

CubCave.push = (function () {

  var store = CubCave.store;
  var messaging = null;
  var sdkPromise = null;
  var listeners = [];

  function onChange(fn) {
    listeners.push(fn);
  }

  function emit() {
    var s = state();
    listeners.forEach(function (fn) { fn(s); });
  }

  /* ---------- capability detection ---------- */

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           // iPadOS reports as Mac; the touch points give it away.
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isSupported() {
    return 'Notification' in window &&
           'serviceWorker' in navigator &&
           'PushManager' in window;
  }

  function isConfigured() {
    var f = CubCave.config.firebase;
    return !!(f && f.apiKey && f.projectId && f.messagingSenderId && f.appId &&
              CubCave.config.vapidKey);
  }

  function permission() {
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  }

  function savedToken() {
    var sub = store.getPushSubscription();
    return (sub && sub.fcmToken) || null;
  }

  // A single value the UI can switch on.
  function state() {
    if (isIOS() && !isStandalone()) return 'ios-needs-install';
    if (!isSupported()) return 'unsupported';
    if (!isConfigured()) return 'unconfigured';
    if (permission() === 'denied') return 'denied';
    if (permission() === 'granted' && savedToken()) return 'enabled';
    return 'available';
  }

  /* ---------- Firebase SDK, loaded on demand ---------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(el);
    });
  }

  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    var base = 'https://www.gstatic.com/firebasejs/' +
               CubCave.config.firebaseSdkVersion + '/';
    // The "compat" builds expose a global `firebase`, which suits this app's
    // plain-script setup — no bundler needed.
    sdkPromise = loadScript(base + 'firebase-app-compat.js')
      .then(function () { return loadScript(base + 'firebase-messaging-compat.js'); })
      .catch(function (err) {
        sdkPromise = null;   // allow a later retry
        throw err;
      });
    return sdkPromise;
  }

  function initMessaging() {
    if (messaging) return Promise.resolve(messaging);
    return loadSdk().then(function () {
      if (!window.firebase.apps.length) {
        window.firebase.initializeApp(CubCave.config.firebase);
      }
      messaging = window.firebase.messaging();

      // Foreground messages don't raise an OS notification on their own,
      // because the page is already open. Show one anyway so a release that
      // lands while you're using the app isn't missed.
      messaging.onMessage(function (payload) {
        var d = (payload && (payload.data || payload.notification)) || {};
        if (CubCave.showToast) {
          CubCave.showToast(d.title || 'A comic on your list is out today.');
        }
      });

      return messaging;
    });
  }

  /* ---------- enable ---------- */

  // Must be called from a user gesture.
  function enable() {
    if (state() === 'ios-needs-install') {
      return Promise.reject(new Error('ios-needs-install'));
    }
    if (!isSupported()) return Promise.reject(new Error('unsupported'));
    if (!isConfigured()) return Promise.reject(new Error('unconfigured'));

    return Notification.requestPermission().then(function (result) {
      if (result !== 'granted') {
        emit();
        throw new Error(result === 'denied' ? 'denied' : 'dismissed');
      }
      return initMessaging();
    }).then(function () {
      // Reuse the app's own service worker rather than letting Firebase
      // register a second one at /firebase-messaging-sw.js — one worker
      // means one cache and one push handler.
      return navigator.serviceWorker.ready;
    }).then(function (registration) {
      return messaging.getToken({
        vapidKey: CubCave.config.vapidKey,
        serviceWorkerRegistration: registration
      });
    }).then(function (token) {
      if (!token) throw new Error('no-token');
      saveToken(token);
      emit();
      return token;
    });
  }

  function saveToken(token) {
    var existing = store.getPushSubscription();
    if (existing && existing.fcmToken === token) return;
    // Written into the Drive JSON, which is where Phase 5's scheduled job
    // reads it from.
    store.setPushSubscription({
      fcmToken: token,
      registeredAt: new Date().toISOString()
    });
  }

  /* ---------- keep the stored token fresh ---------- */

  // FCM tokens rotate (reinstall, cleared storage, long silence). A stale
  // token means notifications quietly stop arriving, so re-check on launch
  // when notifications are already on. Never prompts — permission is granted
  // by this point, so getToken() is silent.
  function refreshIfEnabled() {
    if (!isConfigured() || !isSupported()) return Promise.resolve();
    if (permission() !== 'granted') return Promise.resolve();

    return initMessaging()
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function (registration) {
        return messaging.getToken({
          vapidKey: CubCave.config.vapidKey,
          serviceWorkerRegistration: registration
        });
      })
      .then(function (token) {
        if (token) { saveToken(token); emit(); }
      })
      .catch(function (err) {
        console.warn('Could not refresh the notification token:', err);
      });
  }

  /* ---------- local test ---------- */

  // Fires a notification straight from the service worker — no server
  // involved. Confirms permission, the worker, and the display path all work
  // before Phase 5 exists.
  function sendTestNotification() {
    return navigator.serviceWorker.ready.then(function (registration) {
      return registration.showNotification('The Cub Cave', {
        body: 'Test notification — this is what a release-day alert looks like.',
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'cubcave-test'
      });
    });
  }

  return {
    state: state,
    permission: permission,
    isSupported: isSupported,
    isConfigured: isConfigured,
    isStandalone: isStandalone,
    isIOS: isIOS,
    savedToken: savedToken,
    enable: enable,
    refreshIfEnabled: refreshIfEnabled,
    sendTestNotification: sendTestNotification,
    onChange: onChange
  };
})();
