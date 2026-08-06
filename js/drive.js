/* The Cub Cave — Google auth + Drive appDataFolder access (Phase 3).
 *
 * SECURITY NOTES
 *
 * Scope: only `drive.appdata`. That grants access to a hidden per-app folder
 * in your Drive and nothing else — this app cannot see, list, or touch any of
 * your other Drive files, even if its code were compromised. It is the
 * narrowest scope that does the job.
 *
 * We deliberately do NOT request `profile`, `email` or `openid`. The app never
 * learns your name or address; "who you are" is implicit in whose Drive the
 * token opens. Fewer scopes, less to leak, and a shorter consent screen.
 *
 * Token storage: the access token lives in a module variable in memory only.
 * It is never written to localStorage, sessionStorage, or a cookie, so a
 * stored-XSS bug cannot lift a long-lived credential off the device. The cost
 * is that a page reload requires a fresh token — which Google issues silently
 * while your session is active, so in practice you rarely see a prompt.
 *
 * There is no refresh token. Browser apps use the OAuth implicit/token flow,
 * which intentionally does not issue one; tokens expire after about an hour.
 */

'use strict';

var CubCave = window.CubCave || (window.CubCave = {});

CubCave.drive = (function () {

  var SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  var API = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  var tokenClient = null;
  var accessToken = null;   // in memory only — see note above
  var tokenExpiry = 0;
  var fileId = null;
  var listeners = [];

  function emit() {
    listeners.forEach(function (fn) { fn(isSignedIn()); });
  }

  function onAuthChange(fn) { listeners.push(fn); }

  function isConfigured() {
    return !!(CubCave.config && CubCave.config.googleClientId);
  }

  function gisLoaded() {
    return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiry;
  }

  function init() {
    if (!isConfigured() || !gisLoaded() || tokenClient) return isConfigured() && gisLoaded();
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CubCave.config.googleClientId,
      scope: SCOPE,
      callback: function () {}   // replaced per request below
    });
    return true;
  }

  /* ---------- tokens ---------- */

  // interactive:true is only valid from a user gesture (button click) —
  // browsers block the Google popup otherwise.
  function requestToken(interactive) {
    return new Promise(function (resolve, reject) {
      if (!init()) {
        reject(new Error(isConfigured() ? 'gis-unavailable' : 'not-configured'));
        return;
      }

      tokenClient.callback = function (response) {
        if (response && response.access_token) {
          accessToken = response.access_token;
          // Retire the token a minute early so a call can't die mid-flight.
          var ttl = (Number(response.expires_in) || 3600) - 60;
          tokenExpiry = Date.now() + ttl * 1000;
          emit();
          resolve(accessToken);
        } else {
          reject(new Error((response && response.error) || 'no-token'));
        }
      };

      tokenClient.error_callback = function (err) {
        reject(new Error((err && err.type) || 'auth-failed'));
      };

      try {
        // prompt:'' asks Google to reuse an existing grant without showing UI
        // where it can. First run still shows the consent screen.
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch (err) {
        reject(err);
      }
    });
  }

  function signIn() { return requestToken(false); }

  // Force the consent/account screen — used when silent renewal has failed.
  function reauthorize() { return requestToken(true); }

  function signOut() {
    var token = accessToken;
    accessToken = null;
    tokenExpiry = 0;
    fileId = null;
    if (token && gisLoaded() && window.google.accounts.oauth2.revoke) {
      try { window.google.accounts.oauth2.revoke(token); } catch (err) { /* best effort */ }
    }
    emit();
  }

  // Drop the token without revoking the grant — used when Drive rejects it, so
  // the UI can offer a plain "Sign in" instead of a pointless retry.
  function clearToken() {
    accessToken = null;
    tokenExpiry = 0;
    emit();
  }

  function ensureToken() {
    if (isSignedIn()) return Promise.resolve(accessToken);
    return requestToken(false);
  }

  /* ---------- REST helpers ---------- */

  // Single retry on 401 only, after one silent token refresh. Never loops:
  // a second failure propagates to the UI.
  function apiFetch(url, options, isRetry) {
    options = options || {};
    return ensureToken().then(function (token) {
      var headers = Object.assign({}, options.headers || {});
      headers.Authorization = 'Bearer ' + token;
      return fetch(url, Object.assign({}, options, { headers: headers }));
    }).then(function (response) {
      if (response.status === 401 && !isRetry) {
        accessToken = null;
        tokenExpiry = 0;
        return apiFetch(url, options, true);
      }
      if (!response.ok) {
        return response.text().then(function (body) {
          var err = new Error('Drive ' + response.status + ': ' + body.slice(0, 200));
          err.status = response.status;
          throw err;
        });
      }
      return response;
    });
  }

  /* ---------- the data file ---------- */

  // appDataFolder is a hidden, per-app folder. It does not appear in the
  // normal Drive UI and does not count against a visible file list.
  function findFile() {
    if (fileId) return Promise.resolve(fileId);
    var url = API + '/files'
      + '?spaces=appDataFolder'
      + '&q=' + encodeURIComponent("name='" + CubCave.config.driveFileName + "' and trashed=false")
      + '&fields=' + encodeURIComponent('files(id,name,modifiedTime)')
      + '&pageSize=10';

    return apiFetch(url).then(function (r) { return r.json(); }).then(function (body) {
      var files = (body && body.files) || [];
      fileId = files.length ? files[0].id : null;
      return fileId;
    });
  }

  function createFile(dataObject) {
    var boundary = 'cubcave-' + Date.now();
    var metadata = {
      name: CubCave.config.driveFileName,
      parents: ['appDataFolder'],
      mimeType: 'application/json'
    };
    var body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(dataObject) + '\r\n' +
      '--' + boundary + '--';

    return apiFetch(UPLOAD + '/files?uploadType=multipart&fields=id,modifiedTime', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    }).then(function (r) { return r.json(); }).then(function (file) {
      fileId = file.id;
      return file;
    });
  }

  // Returns { data, modifiedTime } or null when no file exists yet.
  function read() {
    return findFile().then(function (id) {
      if (!id) return null;
      return apiFetch(API + '/files/' + id + '?alt=media')
        .then(function (r) { return r.json(); })
        .then(function (data) { return { data: data }; });
    });
  }

  // Creates the file on first save, updates it thereafter.
  function write(dataObject) {
    return findFile().then(function (id) {
      if (!id) return createFile(dataObject);
      return apiFetch(UPLOAD + '/files/' + id + '?uploadType=media&fields=id,modifiedTime', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(dataObject)
      }).then(function (r) { return r.json(); });
    });
  }

  return {
    init: init,
    isConfigured: isConfigured,
    gisLoaded: gisLoaded,
    isSignedIn: isSignedIn,
    signIn: signIn,
    reauthorize: reauthorize,
    signOut: signOut,
    clearToken: clearToken,
    onAuthChange: onAuthChange,
    read: read,
    write: write
  };
})();
