/* The Cub Cave — Drive synchronisation (Phase 3).
 *
 * Ties CubCave.store (local mirror) to CubCave.drive (network).
 *
 * RECONCILIATION RULE
 * There is one user, so a full merge engine would be overkill. Instead:
 *
 *   - "dirty" means this device has edits that Drive has not accepted yet.
 *   - On open/reconnect: if dirty, push local up (local wins, nothing you
 *     typed is ever silently discarded). If clean, pull from Drive, so a
 *     second device picks up changes made elsewhere.
 *   - Returning to the app re-pulls when clean, keeping devices current.
 *
 * The gap this leaves: edit device A while offline, edit device B, then bring
 * A back online — A's push overwrites B. For one person using one device at a
 * time this cannot really happen; it is documented rather than engineered
 * around. Nothing here retries forever — a failure surfaces in the UI and
 * waits for the next natural trigger.
 */

'use strict';

var CubCave = window.CubCave || (window.CubCave = {});

CubCave.sync = (function () {

  var DIRTY_KEY = 'cubcave.dirty.v1';
  var PUSH_DEBOUNCE_MS = 1500;

  var store = CubCave.store;
  var drive = CubCave.drive;

  var state = { status: 'starting', message: '' };
  var listeners = [];
  var pushTimer = null;
  var busy = false;

  /* Set by the UI. Given a summary of both sides, resolves to 'local' or
   * 'remote'. Until one is registered, the account always wins — losing the
   * copy you can't see is worse than losing the one you can. */
  var conflictHandler = null;

  function onConflict(fn) {
    conflictHandler = fn;
  }

  /* ---------- status ---------- */

  function onStatus(fn) {
    listeners.push(fn);
    fn(state);
  }

  function setStatus(status, message) {
    state = { status: status, message: message || '' };
    listeners.forEach(function (fn) { fn(state); });
  }

  function status() { return state; }

  /* ---------- dirty flag ---------- */

  function isDirty() {
    try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch (err) { return false; }
  }

  function setDirty(value) {
    try {
      if (value) localStorage.setItem(DIRTY_KEY, '1');
      else localStorage.removeItem(DIRTY_KEY);
    } catch (err) { /* storage blocked — sync still works, just less resilient */ }
  }

  /* ---------- error reporting ---------- */

  function describeError(err) {
    var msg = (err && err.message) || String(err);
    if (msg === 'not-configured') return 'Google sign-in is not configured yet.';
    if (msg === 'gis-unavailable') return 'Could not reach Google sign-in.';
    if (/popup_closed|popup_failed_to_open|user_cancel|access_denied/i.test(msg)) {
      return 'Sign-in was cancelled.';
    }
    if (err && err.status === 403) return 'Drive refused the request (check the API is enabled).';
    if (err && err.status >= 500) return 'Drive is having problems. Try again shortly.';
    if (/Failed to fetch|NetworkError/i.test(msg)) return 'No connection to Drive.';
    return msg;
  }

  function fail(err) {
    console.warn('Sync error:', err);

    // A 401 that survived the one silent retry means the grant is genuinely
    // gone (expired session, revoked access). Retrying can't fix that, so drop
    // the dead token and ask for a fresh sign-in instead of offering "Retry".
    if (err && err.status === 401) {
      drive.clearToken();
      setStatus('signed-out', 'Sign-in expired — sign in again');
      return;
    }

    setStatus('error', describeError(err));
  }

  /* ---------- push / pull ---------- */

  function push() {
    if (busy) return Promise.resolve();
    busy = true;
    setStatus('syncing', 'Saving to Drive…');

    return drive.write(store.snapshot())
      .then(function () {
        setDirty(false);
        setStatus('synced', 'Saved to Drive');
      })
      .catch(fail)
      .then(function () { busy = false; });
  }

  /* ---------- signing in ----------
   *
   * Signing in must never silently pick a winner. The old rule — "dirty means
   * local wins" — could wipe an account: `dirty` is set by any local write,
   * including the notification-token refresh that runs on launch, so an empty
   * device could mark itself dirty and then push nothing over everything.
   *
   * Now the remote document is read first and compared. A choice is only put
   * to you when both sides genuinely hold data and they differ; every other
   * case has an obviously correct answer and is taken automatically.
   */

  function hasContent(doc) {
    if (!doc) return false;
    var entries = doc.entries || [];
    var subs = doc.subscriptions || [];
    return entries.length > 0 || subs.length > 0;
  }

  /* Both sides go through normalize first, so key order and missing optional
   * fields can't make identical data look different. updatedAt is left out
   * deliberately — it always differs and says nothing about the contents. */
  function contentOf(doc) {
    var clean = store.normalizeDoc(doc);
    return JSON.stringify({
      entries: clean.entries,
      subscriptions: clean.subscriptions,
      seriesOrder: clean.seriesOrder
    });
  }

  function summarise(doc) {
    var entries = (doc && doc.entries) || [];
    var series = {};
    entries.forEach(function (e) {
      series[(e && e.series) || 'Other'] = true;
    });
    return {
      entries: entries.length,
      series: Object.keys(series).length,
      subscriptions: ((doc && doc.subscriptions) || []).length,
      updatedAt: (doc && doc.updatedAt) || null
    };
  }

  function applyRemote(remote) {
    store.replaceAll(remote);
    setDirty(false);
    setStatus('synced', 'Loaded from Drive');
  }

  function afterSignIn() {
    if (busy) return Promise.resolve();
    busy = true;
    setStatus('syncing', 'Checking your Drive…');

    return drive.read().then(function (result) {
      var remote = result && result.data;
      var local = store.snapshot();
      busy = false;

      // Nothing in Drive yet: this account's first run.
      if (!remote) return push();

      // One side empty — no decision to make.
      if (!hasContent(local)) { applyRemote(remote); return; }
      if (!hasContent(remote)) return push();

      // Same contents, just different timestamps.
      if (contentOf(local) === contentOf(remote)) { applyRemote(remote); return; }

      // Genuine conflict. Without a handler, prefer the account — never
      // destroy the copy that isn't in front of you.
      if (!conflictHandler) { applyRemote(remote); return; }

      setStatus('conflict', 'Two versions of your data');
      return conflictHandler({
        local: summarise(local),
        remote: summarise(remote)
      }).then(function (choice) {
        if (choice === 'local') return push();
        applyRemote(remote);
      });
    }).catch(function (err) {
      busy = false;
      fail(err);
    });
  }

  function pull() {
    if (busy) return Promise.resolve();
    busy = true;
    setStatus('syncing', 'Loading from Drive…');

    return drive.read()
      .then(function (result) {
        if (!result) {
          // First run on this account: no file exists yet. Create it from
          // whatever is local (usually empty) so later saves have a target.
          busy = false;
          return push();
        }
        store.replaceAll(result.data);
        setDirty(false);
        setStatus('synced', 'Loaded from Drive');
      })
      .catch(fail)
      .then(function () { busy = false; });
  }

  // Decide which direction to move, based on whether this device has
  // unsaved edits. See the reconciliation rule at the top of the file.
  function reconcile() {
    if (!drive.isConfigured()) {
      setStatus('unconfigured', 'Google sign-in not configured');
      return Promise.resolve();
    }
    if (!navigator.onLine) {
      setStatus('offline', 'Offline — changes saved on this device');
      return Promise.resolve();
    }
    if (!drive.isSignedIn()) {
      setStatus('signed-out', 'Not signed in');
      return Promise.resolve();
    }
    return isDirty() ? push() : pull();
  }

  function schedulePush() {
    setDirty(true);

    if (!drive.isConfigured()) return;
    if (!navigator.onLine) {
      setStatus('offline', 'Offline — changes saved on this device');
      return;
    }
    if (!drive.isSignedIn()) {
      setStatus('signed-out', 'Not signed in — changes saved on this device');
      return;
    }

    setStatus('pending', 'Saving…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DEBOUNCE_MS);
  }

  // Called on pagehide: no time for a debounce, and no time for a promise.
  function flush() {
    clearTimeout(pushTimer);
    if (isDirty() && drive.isSignedIn() && navigator.onLine) push();
  }

  /* ---------- sign in / out ---------- */

  function signIn() {
    setStatus('syncing', 'Signing in…');
    return drive.signIn()
      .then(afterSignIn)
      .catch(function () {
        // A silent grant can fail simply because none exists yet; ask properly.
        return drive.reauthorize().then(afterSignIn).catch(fail);
      });
  }

  function signOut() {
    // Don't strand edits that never made it up.
    var pending = (isDirty() && drive.isSignedIn() && navigator.onLine)
      ? push() : Promise.resolve();

    return pending.then(function () {
      drive.signOut();
      // Clear the local mirror too — leaving one account's reading list on the
      // device after signing out would be both confusing and a privacy leak.
      store.replaceAll({ entries: [] });
      setDirty(false);
      setStatus('signed-out', 'Signed out');
    });
  }

  /* ---------- boot ---------- */

  function start() {
    if (!drive.isConfigured()) {
      setStatus('unconfigured', 'Google sign-in not configured');
      return;
    }
    if (!drive.gisLoaded()) {
      setStatus('error', 'Could not load Google sign-in.');
      return;
    }

    drive.init();

    if (!navigator.onLine) {
      setStatus('offline', 'Offline — changes saved on this device');
      return;
    }

    // Deliberately no automatic sign-in here.
    //
    // Google's token flow always opens a popup, and browsers block popups that
    // aren't triggered by a user gesture — so an auto-attempt on load fails
    // every time, logs a GSI error, and can trip the browser's popup-blocked
    // indicator. Since the access token is memory-only by design, that costs
    // one tap on Sign in per app launch. Edits made before signing in are kept
    // locally and pushed up on the next successful sync.
    setStatus('signed-out', 'Not signed in — tap Sign in to sync');
  }

  store.onLocalChange(schedulePush);

  window.addEventListener('online', function () {
    if (drive.isSignedIn()) reconcile();
    else setStatus('signed-out', 'Not signed in');
  });

  window.addEventListener('offline', function () {
    setStatus('offline', 'Offline — changes saved on this device');
  });

  // Coming back to the app is the natural moment to pick up edits made on
  // another device — but only when this one has nothing pending.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || busy) return;
    if (drive.isSignedIn() && navigator.onLine && !isDirty()) pull();
  });

  window.addEventListener('pagehide', flush);

  return {
    start: start,
    status: status,
    onStatus: onStatus,
    onConflict: onConflict,
    signIn: signIn,
    signOut: signOut,
    reconcile: reconcile,
    isDirty: isDirty
  };
})();
