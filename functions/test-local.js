/* Local test harness for the daily release check.
 *
 *   node functions/test-local.js
 *
 * Stubs Google's token endpoint, Drive, and FCM, then runs the REAL handler
 * from index.js against a set of scenarios. No credentials, no network, no
 * messages actually sent.
 */

'use strict';

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh';
process.env.TIMEZONE = 'Europe/London';

/* ---------- stub firebase-admin before index.js loads it ---------- */

const Module = require('module');
const realResolve = Module._resolveFilename;
const sent = [];
let sendBehaviour = () => ({ successCount: 0, failureCount: 0, responses: [] });
let handler = null;

const stubs = {
  'firebase-admin/app': { initializeApp() {}, applicationDefault: () => ({}) },
  'firebase-admin/messaging': {
    getMessaging: () => ({
      sendEachForMulticast(message) {
        sent.push(message);
        return Promise.resolve(sendBehaviour(message));
      }
    })
  },
  // The real module exposes `http` as a getter, so it can't be reassigned —
  // replace the module wholesale to capture the registered handler.
  '@google-cloud/functions-framework': {
    http: (name, fn) => { handler = fn; }
  }
};

Module._resolveFilename = function (request, ...rest) {
  if (stubs[request]) return request;
  return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request];
  return realLoad.call(this, request, ...rest);
};

/* ---------- fake Google endpoints ---------- */

let driveFile = null;
let tokenStatus = 200;
let tokenBody = { access_token: 'fake-access-token', expires_in: 3600 };
let driveListStatus = 200;
const calls = [];

global.fetch = async (url, options = {}) => {
  url = String(url);
  calls.push((options.method || 'GET') + ' ' + url.split('?')[0]);
  const json = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  });

  if (url.includes('oauth2.googleapis.com/token')) return json(tokenBody, tokenStatus);
  if (url.includes('/drive/v3/files?')) {
    if (driveListStatus !== 200) return json({ error: 'nope' }, driveListStatus);
    return json({ files: driveFile ? [{ id: 'FILE1', name: 'cubcave-data.json' }] : [] });
  }
  if (url.includes('alt=media')) return json(driveFile);
  return json({ error: 'unhandled ' + url }, 500);
};

require('./index.js');

/* ---------- run scenarios ---------- */

function run(query = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); }
    };
    handler({ query }, res);
  });
}

const entry = (over = {}) => ({
  id: 'x', title: 'Batman #14', series: 'Batman (2025)', status: 'upcoming',
  releaseDate: '2026-10-07', notes: '', dateAdded: '2026-08-01T00:00:00Z',
  dateRead: null, sortOrder: 0, ...over
});

const device = (t, label) => ({ fcmToken: t, label, registeredAt: '2026-08-01T00:00:00Z' });

(async () => {
  const results = {};
  const show = (name, value) => { results[name] = value; };

  // 1. Nothing due today
  driveFile = { entries: [entry()], pushSubscriptions: [device('tok-a', 'Phone')] };
  show('nothingDue', await run({ date: '2026-10-06' }));

  // 2. One comic due, two devices
  sent.length = 0;
  sendBehaviour = (m) => ({
    successCount: m.tokens.length, failureCount: 0,
    responses: m.tokens.map(() => ({ success: true }))
  });
  driveFile = {
    entries: [entry(), entry({ id: 'y', title: 'Nightwing #5', releaseDate: '2026-11-01' })],
    pushSubscriptions: [device('tok-a', 'Phone'), device('tok-b', 'Laptop')]
  };
  const one = await run({ date: '2026-10-07' });
  show('oneDue', { result: one, payload: sent[0] && sent[0].data, tokens: sent[0] && sent[0].tokens });

  // 3. Several due on the same day
  sent.length = 0;
  driveFile = {
    entries: [
      entry({ id: 'a', title: 'Batman #14' }),
      entry({ id: 'b', title: 'Detective Comics #1104' }),
      entry({ id: 'c', title: 'Absolute Batman #9' })
    ],
    pushSubscriptions: [device('tok-a', 'Phone')]
  };
  const many = await run({ date: '2026-10-07' });
  show('threeDue', { body: sent[0] && sent[0].data, sent: many.body.sent });

  // 4. Statuses other than "upcoming" must never fire
  driveFile = {
    entries: [
      entry({ status: 'read' }), entry({ status: 'next' }),
      entry({ status: 'reading' })
    ],
    pushSubscriptions: [device('tok-a', 'Phone')]
  };
  show('otherStatusesIgnored', (await run({ date: '2026-10-07' })).body);

  // 5. Dry run sends nothing
  sent.length = 0;
  driveFile = { entries: [entry()], pushSubscriptions: [device('tok-a', 'Phone')] };
  const dry = await run({ date: '2026-10-07', dryRun: '1' });
  show('dryRun', { body: dry.body, messagesSent: sent.length });

  // 6. Legacy single-token document still works
  driveFile = {
    entries: [entry()],
    pushSubscription: { fcmToken: 'legacy-tok', registeredAt: '2026-08-01T00:00:00Z' }
  };
  show('legacyShape', (await run({ date: '2026-10-07', dryRun: '1' })).body);

  // 7. Comics due but no devices registered
  driveFile = { entries: [entry()], pushSubscriptions: [] };
  show('noDevices', (await run({ date: '2026-10-07' })).body);

  // 8. No file in Drive yet (never signed in)
  driveFile = null;
  show('noDriveFile', (await run({ date: '2026-10-07' })).body);

  // 9. Dead refresh token must fail loudly, with a usable message
  driveFile = { entries: [entry()], pushSubscriptions: [device('tok-a', 'Phone')] };
  tokenStatus = 400;
  tokenBody = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };
  const dead = await run({ date: '2026-10-07' });
  show('deadRefreshToken', { status: dead.status, error: dead.body.error.slice(0, 150) });
  tokenStatus = 200;
  tokenBody = { access_token: 'fake-access-token', expires_in: 3600 };

  // 10. One device dead, one alive — partial success reported, no crash
  sent.length = 0;
  sendBehaviour = () => ({
    successCount: 1, failureCount: 1,
    responses: [
      { success: true },
      { success: false, error: { code: 'messaging/registration-token-not-registered' } }
    ]
  });
  driveFile = {
    entries: [entry()],
    pushSubscriptions: [device('tok-a', 'Phone'), device('tok-dead', 'Old laptop')]
  };
  show('partialFailure', (await run({ date: '2026-10-07' })).body);

  // 11. Timezone correctness — the date used must be London's, not UTC's
  const londonToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  driveFile = { entries: [entry({ releaseDate: londonToday })], pushSubscriptions: [device('tok-a', 'Phone')] };
  const tz = await run({ dryRun: '1' });   // no date param: uses the real clock
  show('timezone', { londonToday, functionUsed: tz.body.today, matched: tz.body.today === londonToday });

  console.log(JSON.stringify(results, null, 2));
})();
