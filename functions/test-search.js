/* Local tests for the comic search proxy.
 *
 *   node functions/test-search.js
 *
 * Stubs Google tokeninfo and Comic Vine; runs the real handler from index.js.
 * No API key, no network, no quota consumed.
 */

'use strict';

process.env.COMICVINE_API_KEY = 'test-key';
process.env.GOOGLE_WEB_CLIENT_ID = 'web-client-id.apps.googleusercontent.com';
process.env.ALLOWED_ORIGINS = 'https://graciouscub.github.io,http://localhost:5173';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.GOOGLE_REFRESH_TOKEN = 'x';

const Module = require('module');
const handlers = {};

const stubs = {
  'firebase-admin/app': { initializeApp() {}, applicationDefault: () => ({}) },
  'firebase-admin/messaging': { getMessaging: () => ({ sendEachForMulticast: async () => ({}) }) },
  '@google-cloud/functions-framework': { http: (name, fn) => { handlers[name] = fn; } }
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request];
  return realLoad.call(this, request, ...rest);
};

/* ---------- fake upstreams ---------- */

let comicVineCalls = 0;
let tokenInfoCalls = 0;
let tokenAud = 'web-client-id.apps.googleusercontent.com';
let tokenValid = true;
let comicVineStatus = 200;
let comicVineBody = null;
let retryAfterHeader = {};
let comicVineHeadersSeen = null;
let hang = false;

const issue = (over = {}) => ({
  id: 1, name: 'Bad Seeds, Part Two', issue_number: '14',
  store_date: '2026-10-07', cover_date: '2026-12-01',
  volume: { id: 9, name: 'Batman' },
  image: { thumb_url: 'https://example.test/thumb.jpg' },
  ...over
});

global.fetch = async (url, options = {}) => {
  url = String(url);
  const json = (obj, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => obj, text: async () => JSON.stringify(obj)
  });

  if (url.includes('oauth2.googleapis.com/tokeninfo')) {
    tokenInfoCalls++;
    if (!tokenValid) return json({ error: 'invalid_token' }, 400);
    return json({ aud: tokenAud, scope: 'https://www.googleapis.com/auth/drive.appdata', expires_in: 3400 });
  }

  if (url.includes('comicvine.gamespot.com')) {
    comicVineCalls++;
    comicVineHeadersSeen = options.headers;
    if (hang) {
      // Never resolves on its own — only the abort signal ends it.
      return new Promise((_, reject) => {
        options.signal && options.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      });
    }
    if (comicVineStatus !== 200) return json({ error: 'rate limited' }, comicVineStatus, retryAfterHeader);
    return json(comicVineBody || { error: 'OK', results: [issue()] });
  }

  return json({ error: 'unexpected ' + url }, 500);
};

require('./index.js');

function call(query = {}, headers = {}, method = 'GET') {
  return new Promise((resolve) => {
    const sentHeaders = {};
    const res = {
      statusCode: 200,
      set(k, v) { sentHeaders[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, headers: sentHeaders }); },
      send(payload) { resolve({ status: this.statusCode, body: payload, headers: sentHeaders }); }
    };
    handlers.comicSearch(
      { method, query, get: (name) => headers[name.toLowerCase()] },
      res
    );
  });
}

const AUTH = { authorization: 'Bearer good-token' };

(async () => {
  const R = {};

  // 1. Happy path
  let r = await call({ q: 'batman 14' }, { ...AUTH, origin: 'https://graciouscub.github.io' });
  R.happyPath = {
    status: r.status,
    result: r.body.results[0],
    corsOrigin: r.headers['Access-Control-Allow-Origin'],
    cache: r.headers['X-Cache']
  };
  R.sendsUserAgent = !!(comicVineHeadersSeen && comicVineHeadersSeen['User-Agent']);

  // 2. Identical query must be served from cache, not re-fetched
  const before = comicVineCalls;
  r = await call({ q: 'BATMAN 14' }, AUTH);   // different case, same query
  R.cacheHit = { cache: r.headers['X-Cache'], upstreamCalls: comicVineCalls - before };

  // 3. Short queries never reach the network
  const beforeShort = comicVineCalls;
  r = await call({ q: 'ba' }, AUTH);
  R.tooShort = { status: r.status, results: r.body.results.length, upstreamCalls: comicVineCalls - beforeShort };

  // 4. No token -> refused
  r = await call({ q: 'superman' }, {});
  R.noToken = { status: r.status, error: r.body.error };

  // 5. Token from a different app -> refused
  tokenAud = 'someone-elses-client.apps.googleusercontent.com';
  r = await call({ q: 'superman' }, { authorization: 'Bearer other-app-token' });
  R.wrongAudience = { status: r.status, error: r.body.error };
  tokenAud = 'web-client-id.apps.googleusercontent.com';

  // 6. Invalid token -> refused
  tokenValid = false;
  r = await call({ q: 'wonder woman' }, { authorization: 'Bearer bad' });
  R.invalidToken = { status: r.status, error: r.body.error };
  tokenValid = true;

  // 7. tokeninfo is cached, not called per keystroke
  const tokensBefore = tokenInfoCalls;
  await call({ q: 'flash one' }, AUTH);
  await call({ q: 'flash two' }, AUTH);
  await call({ q: 'flash three' }, AUTH);
  R.tokenInfoCached = { extraTokenInfoCalls: tokenInfoCalls - tokensBefore };

  // 8. Missing store_date falls back to cover_date and says so
  comicVineBody = { error: 'OK', results: [issue({ store_date: null, cover_date: '2026-12-01' })] };
  r = await call({ q: 'no store date' }, AUTH);
  R.coverDateFallback = {
    releaseDate: r.body.results[0].releaseDate,
    approximate: r.body.results[0].dateIsApproximate
  };

  // 9. No date at all — still usable, just can't notify
  comicVineBody = { error: 'OK', results: [issue({ store_date: null, cover_date: null })] };
  r = await call({ q: 'no dates here' }, AUTH);
  R.noDate = r.body.results[0];

  // 10. Comic Vine rate limit surfaces as 429, not a generic 500
  comicVineBody = null;
  comicVineStatus = 420;
  r = await call({ q: 'rate limited now' }, AUTH);
  R.upstreamError = { status: r.status, error: r.body.error };
  comicVineStatus = 200;

  // 10b. A Retry-After from the upstream is passed through, not guessed at
  comicVineStatus = 429;
  retryAfterHeader = { 'retry-after': '42' };
  r = await call({ q: 'retry after test' }, AUTH);
  R.retryAfter = { status: r.status, error: r.body.error };
  comicVineStatus = 200;
  retryAfterHeader = {};

  // 11. Timeout aborts rather than hanging
  hang = true;
  const started = Date.now();
  const originalTimeout = 8000;
  r = await Promise.race([
    call({ q: 'this will hang' }, AUTH),
    new Promise((res) => setTimeout(() => res({ status: 'TEST-TIMED-OUT' }), originalTimeout + 2000))
  ]);
  R.timeout = { status: r.status, tookMs: Date.now() - started, error: r.body && r.body.error };
  hang = false;

  // 12. CORS preflight
  r = await call({}, { origin: 'https://graciouscub.github.io' }, 'OPTIONS');
  R.preflight = { status: r.status, allowOrigin: r.headers['Access-Control-Allow-Origin'] };

  // 13. Unknown origin gets no CORS header
  r = await call({ q: 'batman 14' }, { ...AUTH, origin: 'https://evil.test' });
  R.unknownOrigin = { allowOrigin: r.headers['Access-Control-Allow-Origin'] || null };

  console.log(JSON.stringify(R, null, 2));
})();
