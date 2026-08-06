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

  var DEVICE_TOKEN_KEY = 'cubcave.deviceToken.v1';

  /* The Drive document holds tokens for every device. To decide whether THIS
   * device is registered we need to know which of them is ours, so the token
   * is also kept locally. It is a delivery address, not a credential — it
   * grants no access to anything. */
  function deviceToken() {
    try { return localStorage.getItem(DEVICE_TOKEN_KEY); } catch (err) { return null; }
  }

  function rememberDeviceToken(token) {
    try { localStorage.setItem(DEVICE_TOKEN_KEY, token); } catch (err) { /* non-fatal */ }
  }

  function savedToken() {
    var token = deviceToken();
    if (!token) return null;
    var known = store.getPushSubscriptions().some(function (s) {
      return s.fcmToken === token;
    });
    return known ? token : null;
  }

  function registeredDeviceCount() {
    return store.getPushSubscriptions().length;
  }

  // A rough, human-readable name so a list of tokens isn't unreadable.
  function deviceLabel() {
    var ua = navigator.userAgent;
    var os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad'
           : /Android/.test(ua) ? 'Android'
           : /Mac OS X/.test(ua) ? 'Mac'
           : /Windows/.test(ua) ? 'Windows'
           : 'Device';
    var browser = /Edg\//.test(ua) ? 'Edge'
                : /OPR\/|Opera/.test(ua) ? 'Opera'
                : /Firefox/.test(ua) ? 'Firefox'
                : /Chrome/.test(ua) ? 'Chrome'
                : /Safari/.test(ua) ? 'Safari'
                : 'Browser';
    return os + ' · ' + browser + (isStandalone() ? ' (installed)' : '');
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

  /* ---------- stale subscription cleanup ---------- */

  /* A browser refuses to create a push subscription when one already exists
   * for this origin under a DIFFERENT applicationServerKey — it fails with
   * "Registration failed - push service error", which says nothing useful.
   * That happens after regenerating a VAPID key pair, or from a leftover
   * subscription created by earlier testing. Clearing the mismatched one first
   * makes Enable work instead of dead-ending. */

  function urlBase64ToUint8Array(value) {
    var padding = '='.repeat((4 - (value.length % 4)) % 4);
    var base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function sameKey(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // force:true drops any subscription at all, not just a mismatched one.
  function clearConflictingSubscription(registration, force) {
    return registration.pushManager.getSubscription().then(function (sub) {
      if (!sub) return false;
      if (!force) {
        var existing = sub.options && sub.options.applicationServerKey;
        var wanted;
        try { wanted = urlBase64ToUint8Array(CubCave.config.vapidKey); } catch (err) { wanted = null; }
        if (existing && wanted && sameKey(new Uint8Array(existing), wanted)) return false;
      }
      return sub.unsubscribe().then(function () { return true; });
    }).catch(function () {
      return false;   // best effort; the retry below is the real safety net
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
      var request = function () {
        return messaging.getToken({
          vapidKey: CubCave.config.vapidKey,
          serviceWorkerRegistration: registration
        });
      };

      return clearConflictingSubscription(registration, false)
        .then(request)
        .catch(function (err) {
          // Exactly one retry, after dropping any subscription outright.
          // If it fails again the error is real and goes to the UI — no loop.
          console.warn('First token attempt failed, retrying once:', err);
          return clearConflictingSubscription(registration, true).then(request);
        });
    }).then(function (token) {
      if (!token) throw new Error('no-token');
      saveToken(token);
      emit();
      return token;
    });
  }

  function saveToken(token) {
    var previous = deviceToken();
    rememberDeviceToken(token);

    // A rotated token leaves the old one dead in the list; drop it so the
    // scheduled job isn't sending to an address that no longer exists.
    if (previous && previous !== token) store.removePushSubscription(previous);

    // Written into the Drive JSON, which is where Phase 5's scheduled job
    // reads it from.
    store.addPushSubscription(token, deviceLabel());
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

  /* Fires a notification straight from the service worker — no server
   * involved. Confirms permission, the worker, and the display path all work.
   *
   * The tag is unique per press. Reusing one tag makes the second and later
   * notifications REPLACE the first silently — no banner, no sound — which
   * looks exactly like the feature having broken.
   *
   * Resolves true when the notification is really on screen, false when the
   * system accepted it and then showed nothing (Do Not Disturb, Focus assist,
   * or notifications muted for the browser). Those are very different
   * problems and the UI should say which one happened. */
  function sendTestNotification() {
    if (permission() !== 'granted') {
      return Promise.reject(new Error('permission-' + permission()));
    }

    var tag = 'cubcave-test-' + Date.now();

    return navigator.serviceWorker.ready.then(function (registration) {
      return registration.showNotification('The Cub Cave', {
        body: 'Test notification — this is what a release-day alert looks like.',
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: tag,
        renotify: true,
        data: { url: './' }
      }).then(function () {
        return registration.getNotifications({ tag: tag });
      }).then(function (shown) {
        return shown.length > 0;
      });
    });
  }

  /* ---------- diagnostics ---------- */

  /* Tests the browser's own push layer directly, with no Firebase involved.
   * If this succeeds but Enable fails, the fault is in FCM/config. If this
   * fails too, the browser or network can't reach its push service at all —
   * which no amount of app code can fix. Run CubCave.push.diagnose() from the
   * console. */
  function diagnose() {
    var report = {
      permission: permission(),
      supported: isSupported(),
      configured: isConfigured(),
      standalone: isStandalone(),
      secureContext: window.isSecureContext,
      browser: navigator.userAgent,
      vapidKeyLength: (CubCave.config.vapidKey || '').length
    };

    if (!('serviceWorker' in navigator)) return Promise.resolve(report);

    return navigator.serviceWorker.ready.then(function (registration) {
      report.serviceWorkerActive = !!registration.active;
      report.scope = registration.scope;
      return registration.pushManager.getSubscription().then(function (sub) {
        report.existingSubscription = sub ? sub.endpoint.slice(0, 60) + '…' : null;

        // The decisive test: raw browser push subscribe, bypassing Firebase.
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(CubCave.config.vapidKey)
        }).then(function (fresh) {
          report.rawSubscribe = 'OK — the browser push service works';
          report.endpointHost = new URL(fresh.endpoint).host;
          return fresh.unsubscribe();
        }).catch(function (err) {
          report.rawSubscribe = 'FAILED — ' + err.name + ': ' + err.message;
        });
      });
    }).then(function () { return report; })
      .catch(function (err) {
        report.error = String(err);
        return report;
      });
  }

  return {
    state: state,
    diagnose: diagnose,
    permission: permission,
    isSupported: isSupported,
    isConfigured: isConfigured,
    isStandalone: isStandalone,
    isIOS: isIOS,
    savedToken: savedToken,
    registeredDeviceCount: registeredDeviceCount,
    deviceLabel: deviceLabel,
    enable: enable,
    refreshIfEnabled: refreshIfEnabled,
    sendTestNotification: sendTestNotification,
    onChange: onChange
  };
})();
