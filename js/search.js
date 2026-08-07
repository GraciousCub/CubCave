/* The Cub Cave — live comic search (Phase 6).
 *
 * Talks to the comic-search Cloud Function, which proxies Comic Vine. The
 * browser cannot call Comic Vine directly: it sends no CORS headers, and the
 * API key has to stay server-side.
 *
 * QUOTA DISCIPLINE
 * Comic Vine allows 400 requests per 15 minutes. Typing "Absolute Batman"
 * unthrottled is 15 requests for one search. So:
 *   - nothing fires under 3 characters
 *   - keystrokes are debounced (350ms)
 *   - a superseded request is aborted, not left running
 *   - repeat queries come from a local cache and never leave the browser
 *   - failures are reported, never silently retried
 * The function caches too, so even a cache miss here is often free upstream.
 */

'use strict';

var CubCave = window.CubCave || (window.CubCave = {});

CubCave.search = (function () {

  var MIN_CHARS = 3;
  var DEBOUNCE_MS = 350;
  var TIMEOUT_MS = 9000;
  var MAX_CACHE = 60;

  var cache = {};
  var cacheOrder = [];
  var controller = null;
  var timer = null;
  var lastQuery = '';

  function isConfigured() {
    return !!(CubCave.config && CubCave.config.searchEndpoint);
  }

  // Why search is unavailable, so the UI can say something specific.
  function readiness() {
    if (!isConfigured()) return 'unconfigured';
    if (!navigator.onLine) return 'offline';
    if (!CubCave.drive.currentAccessToken()) return 'signed-out';
    return 'ready';
  }

  function normalise(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function remember(key, results) {
    if (!(key in cache)) {
      cacheOrder.push(key);
      if (cacheOrder.length > MAX_CACHE) delete cache[cacheOrder.shift()];
    }
    cache[key] = results;
  }

  function cancel() {
    clearTimeout(timer);
    if (controller) { controller.abort(); controller = null; }
  }

  function endpointUrl(params) {
    var base = CubCave.config.searchEndpoint;
    var pairs = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] != null && params[k] !== '') {
        pairs.push(k + '=' + encodeURIComponent(params[k]));
      }
    });
    return base + (base.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
  }

  /* One request. Rejects with an Error whose message is fit to show a user. */
  function fetchResults(query, params) {
    var token = CubCave.drive.currentAccessToken();
    if (!token) return Promise.reject(new Error('Sign in to search.'));

    if (controller) controller.abort();
    controller = window.AbortController ? new AbortController() : null;

    var timeout = setTimeout(function () {
      if (controller) controller.abort();
    }, TIMEOUT_MS);

    var url = endpointUrl(Object.assign({ q: query }, params || {}));

    return fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; })
        .then(function (body) {
          if (!response.ok) {
            var message = body.error || ('Search failed (' + response.status + ')');
            if (response.status === 401 || response.status === 403) {
              message = 'Sign-in expired — sign in again to search.';
            } else if (response.status === 429) {
              message = 'Too many searches just now. Wait a moment.';
            } else if (response.status === 503) {
              message = 'Search is not set up yet.';
            }
            throw new Error(message);
          }
          return body.results || [];
        });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err;   // superseded; not a failure
      if (/Failed to fetch|NetworkError/i.test(err.message)) {
        throw new Error('Could not reach the search service.');
      }
      throw err;
    }).then(function (results) {
      clearTimeout(timeout);
      return results;
    }, function (err) {
      clearTimeout(timeout);
      throw err;
    });
  }

  /* Debounced entry point.
   *
   * handlers: { onState(state), onResults(results, query), onError(message) }
   * state is one of: 'idle' | 'searching' | 'unconfigured' | 'offline' |
   * 'signed-out' | 'too-short'
   */
  function onInput(text, handlers, options) {
    handlers = handlers || {};
    options = options || {};
    var query = String(text || '').trim();
    var key = (options.type || 'issue') + '|' + normalise(query);

    cancel();

    if (normalise(query).length < MIN_CHARS) {
      lastQuery = '';
      if (handlers.onState) handlers.onState(key.length ? 'too-short' : 'idle');
      return;
    }

    var state = readiness();
    if (state !== 'ready') {
      if (handlers.onState) handlers.onState(state);
      return;
    }

    // Served locally: no request, no debounce, no quota.
    if (cache[key]) {
      lastQuery = key;
      if (handlers.onResults) handlers.onResults(cache[key], query);
      return;
    }

    if (handlers.onState) handlers.onState('searching');

    timer = setTimeout(function () {
      fetchResults(query, { type: options.type }).then(function (results) {
        remember(key, results);
        // Ignore a response that arrived after the user moved on. Which box
        // "current" refers to depends on the caller, so it can supply its own.
        var readCurrent = options.currentText || currentText;
        if (normalise(query) !== normalise(readCurrent())) return;
        lastQuery = key;
        if (handlers.onResults) handlers.onResults(results, query);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (handlers.onError) handlers.onError(err.message);
      });
    }, DEBOUNCE_MS);
  }

  // Set by the UI so a late response can be discarded if the box has changed.
  var currentTextFn = function () { return ''; };
  function currentText() { return currentTextFn(); }
  function bindCurrentText(fn) { currentTextFn = fn; }

  /* Issues in a followed series that haven't been released yet. Used the
   * moment you follow something, so you see straight away what it brought in
   * rather than waiting for tomorrow's scheduled check. */
  function upcomingForSeries(seriesId) {
    var token = CubCave.drive.currentAccessToken();
    if (!token) return Promise.reject(new Error('Sign in first.'));

    return fetch(endpointUrl({ seriesId: seriesId }), {
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (response) {
      return response.json().catch(function () { return {}; })
        .then(function (body) {
          if (!response.ok) throw new Error(body.error || 'Could not check the series.');
          return body.results || [];
        });
    });
  }

  return {
    MIN_CHARS: MIN_CHARS,
    isConfigured: isConfigured,
    readiness: readiness,
    onInput: onInput,
    upcomingForSeries: upcomingForSeries,
    cancel: cancel,
    bindCurrentText: bindCurrentText
  };
})();
