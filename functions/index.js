/* The Cub Cave — daily release check (Phase 5).
 *
 * Cloud Function (2nd gen), triggered once a day by Cloud Scheduler:
 *   1. exchange the stored refresh token for a short-lived access token
 *   2. read the JSON file from the user's Drive appDataFolder
 *   3. find entries with status "upcoming" and releaseDate == today
 *   4. push one FCM message to every registered device
 *
 * IT NEVER WRITES TO DRIVE.
 * The client uses last-write-wins sync, so a server write could silently
 * clobber edits made on a phone between the read and the write. Pruning dead
 * tokens here isn't worth that risk — invalid tokens are logged instead, and
 * the client cleans them up when it re-registers.
 *
 * Query parameters (handy for testing; the endpoint requires authentication,
 * so only you can reach them):
 *   ?dryRun=1            report what would be sent, send nothing
 *   ?date=2026-10-07     pretend today is this date
 */

'use strict';

const functions = require('@google-cloud/functions-framework');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp({ credential: applicationDefault() });

const DRIVE_FILE_NAME = process.env.DRIVE_FILE_NAME || 'cubcave-data.json';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';

/* ---------- dates ---------- */

/* "Today" has to mean today where the reader lives, not UTC. A job running at
 * 08:00 London time in late October is still 07:00 UTC — using UTC would fire
 * the wrong day's notifications around midnight. en-CA formats as YYYY-MM-DD,
 * which is exactly the shape releaseDate uses. */
function todayInZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/* ---------- Google auth ---------- */

async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN'
    );
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const body = await response.json();

  if (!response.ok || !body.access_token) {
    // invalid_grant almost always means the token was revoked, or the consent
    // screen is still in Testing and the 7-day clock ran out.
    throw new Error(
      `Token refresh failed (${response.status}): ${JSON.stringify(body)}` +
      (body.error === 'invalid_grant'
        ? ' — the refresh token is dead. Re-run tools/mint-refresh-token.js, ' +
          'and check the OAuth consent screen is published to production.'
        : '')
    );
  }

  return body.access_token;
}

/* ---------- Drive ---------- */

async function readDataFile(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  const query = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const listUrl =
    'https://www.googleapis.com/drive/v3/files' +
    `?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)&pageSize=10`;

  const listResponse = await fetch(listUrl, { headers });
  if (!listResponse.ok) {
    throw new Error(`Drive list failed (${listResponse.status}): ${await listResponse.text()}`);
  }

  const { files = [] } = await listResponse.json();
  if (!files.length) return null;   // app installed but never signed in yet

  const fileResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`,
    { headers }
  );
  if (!fileResponse.ok) {
    throw new Error(`Drive read failed (${fileResponse.status}): ${await fileResponse.text()}`);
  }

  return fileResponse.json();
}

/* ---------- message shape ---------- */

function buildMessage(dueEntries) {
  const first = dueEntries[0];
  // Series names usually carry their own year — "Batman (2025)" — so joining
  // with a separator rather than brackets avoids "Batman #14 (Batman (2025))".
  const name = [first.title, first.series].filter(Boolean).join(' · ');

  if (dueEntries.length === 1) {
    return { title: 'Out today', body: name };
  }
  return {
    title: `${dueEntries.length} comics out today`,
    body: `${name} and ${dueEntries.length - 1} more`
  };
}

/* ==================================================================
 * Comic search proxy (Phase 6)
 *
 * Comic Vine sends no CORS headers and requires an API key, so the browser
 * cannot call it directly. This proxies the search and keeps the key here.
 *
 * Access control: the caller must present a Google access token issued to
 * THIS app's OAuth client. Without that check the endpoint is a free, public
 * comic-search API attached to your billing account and your Comic Vine quota.
 * ================================================================== */

const COMICVINE_KEY = process.env.COMICVINE_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://graciouscub.github.io,http://localhost:5173').split(',');
const EXPECTED_AUDIENCE = process.env.GOOGLE_WEB_CLIENT_ID || '';

const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 8;

/* Comic Vine's search has no date relevance: asking for 8 results for
 * "batman 14" returns eight issues all titled "Batman #14" from runs going
 * back decades, and the current one isn't among them. The volume stub in
 * search results carries no start year, so those rows are indistinguishable.
 *
 * Fetching a wider set and sorting newest-first — for the same single upstream
 * request — puts current and forthcoming issues at the top, which is what
 * someone tracking releases is looking for. Undated records sink to the
 * bottom: they can never drive a notification. */
const UPSTREAM_LIMIT = 30;

/* Two caches, both bounded. The search cache spares Comic Vine's 400-per-15-
 * minutes limit while typing; the token cache spares Google a tokeninfo call
 * on every keystroke. */
const searchCache = new Map();
const tokenCache = new Map();
const SEARCH_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

function cacheGet(cache, key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(cache, key, value) {
  // Crude bound: a long-lived instance must not grow without limit.
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

async function verifyCaller(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Missing access token'), { status: 401 });

  const cached = cacheGet(tokenCache, token, TOKEN_TTL_MS);
  if (cached) return cached;

  const response = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token)
  );
  if (!response.ok) {
    throw Object.assign(new Error('Invalid access token'), { status: 401 });
  }
  const info = await response.json();

  // The token must have been issued to this app, not merely be a valid Google
  // token from anywhere.
  if (EXPECTED_AUDIENCE && info.aud !== EXPECTED_AUDIENCE) {
    throw Object.assign(new Error('Token was not issued to this app'), { status: 403 });
  }

  cacheSet(tokenCache, token, info);
  return info;
}

function normaliseDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
}

function mapIssue(issue) {
  const seriesName = (issue.volume && issue.volume.name) || '';
  const number = issue.issue_number ? `#${issue.issue_number}` : '';
  return {
    sourceId: issue.id,
    // store_date is the day it reaches shops; cover_date is the printed month
    // and is often weeks later. Prefer the real one.
    releaseDate: normaliseDate(issue.store_date) || normaliseDate(issue.cover_date),
    dateIsApproximate: !normaliseDate(issue.store_date),
    title: [seriesName, number].filter(Boolean).join(' ') || (issue.name || 'Untitled'),
    series: seriesName,
    issueNumber: issue.issue_number || '',
    storyTitle: issue.name || '',
    coverUrl: (issue.image && (issue.image.thumb_url || issue.image.icon_url)) || ''
  };
}

functions.http('comicSearch', async (req, res) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).send('');

  const query = String(req.query.q || '').trim();

  try {
    if (!COMICVINE_KEY) {
      throw Object.assign(new Error('Search is not configured'), { status: 503 });
    }
    if (query.length < 3) {
      return res.status(200).json({ results: [], reason: 'query too short' });
    }

    await verifyCaller(req.get('authorization'));

    const key = query.toLowerCase();
    const cached = cacheGet(searchCache, key, SEARCH_TTL_MS);
    if (cached) {
      res.set('X-Cache', 'hit');
      return res.status(200).json({ results: cached });
    }

    const url = 'https://comicvine.gamespot.com/api/search/?' + new URLSearchParams({
      api_key: COMICVINE_KEY,
      format: 'json',
      resources: 'issue',
      limit: String(UPSTREAM_LIMIT),
      query,
      field_list: 'id,name,issue_number,store_date,cover_date,volume,image'
    });

    // Bounded wait, and no retry: a failure surfaces rather than doubling load
    // on an upstream that rate-limits hard.
    const abort = AbortController ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), SEARCH_TIMEOUT_MS) : null;

    let upstream;
    try {
      upstream = await fetch(url, {
        signal: abort ? abort.signal : undefined,
        headers: {
          // Comic Vine rejects requests with no/!default User-Agent.
          'User-Agent': 'CubCave-ComicTracker/1.0 (personal comic reading tracker)',
          Accept: 'application/json'
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(
          new Error('The comic database took too long to answer'), { status: 504 }
        );
      }
      throw Object.assign(new Error('Could not reach the comic database'), { status: 502 });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!upstream.ok) {
      // Comic Vine signals throttling with 420 as well as the standard 429.
      const throttled = upstream.status === 429 || upstream.status === 420;
      throw Object.assign(
        new Error(throttled
          ? 'The comic database is rate limiting us — try again shortly'
          : `Comic database returned ${upstream.status}`),
        { status: throttled ? 429 : 502 }
      );
    }

    const body = await upstream.json();
    if (body.error && body.error !== 'OK') {
      // It also reports throttling in the body with HTTP 200 (status_code 107).
      const throttled = /rate limit/i.test(body.error) || body.status_code === 107;
      throw Object.assign(
        new Error(throttled
          ? 'The comic database is rate limiting us — try again shortly'
          : `Comic database: ${body.error}`),
        { status: throttled ? 429 : 502 }
      );
    }

    /* A trailing number in the query is almost always an issue number
     * ("batman 14"), so matches on it rank first — otherwise a #69 whose story
     * title happens to contain "14" outranks the issue actually asked for. */
    const wantedNumber = (query.match(/(\d+)\s*$/) || [])[1] || null;

    const results = (body.results || [])
      .map(mapIssue)
      // An entry with no date at all can't drive a release notification, but
      // it's still a valid thing to track, so keep it and let the UI say so.
      .filter((r) => r.title)
      .sort((a, b) => {
        if (wantedNumber) {
          const aExact = a.issueNumber === wantedNumber ? 0 : 1;
          const bExact = b.issueNumber === wantedNumber ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
        }
        // Then dated before undated, and newest first — forthcoming at the top.
        if (!a.releaseDate && !b.releaseDate) return 0;
        if (!a.releaseDate) return 1;
        if (!b.releaseDate) return -1;
        return b.releaseDate.localeCompare(a.releaseDate);
      })
      .slice(0, MAX_RESULTS);

    cacheSet(searchCache, key, results);
    res.set('X-Cache', 'miss');
    return res.status(200).json({ results });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Comic search failed:', err);
    return res.status(status).json({ error: err.message, results: [] });
  }
});

/* ---------- the function ---------- */

functions.http('releaseCheck', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const today = req.query.date || todayInZone(TIMEZONE);

  try {
    const accessToken = await getAccessToken();
    const data = await readDataFile(accessToken);

    if (!data) {
      const message = `No ${DRIVE_FILE_NAME} in appDataFolder yet — nothing to check.`;
      console.log(message);
      return res.status(200).json({ ok: true, today, message });
    }

    const entries = Array.isArray(data.entries) ? data.entries : [];
    const due = entries.filter(
      (e) => e && e.status === 'upcoming' && e.releaseDate === today
    );

    // Tolerate the original single-token shape as well as the list.
    const subscriptions = Array.isArray(data.pushSubscriptions)
      ? data.pushSubscriptions
      : (data.pushSubscription ? [data.pushSubscription] : []);
    const tokens = subscriptions
      .map((s) => s && s.fcmToken)
      .filter((t) => typeof t === 'string' && t);

    console.log(
      `today=${today} entries=${entries.length} due=${due.length} devices=${tokens.length}`
    );

    if (!due.length) {
      return res.status(200).json({ ok: true, today, due: 0, sent: 0 });
    }
    if (!tokens.length) {
      console.warn('Comics are out today but no devices are registered.');
      return res.status(200).json({
        ok: true, today, due: due.length, sent: 0,
        warning: 'no registered devices'
      });
    }

    const { title, body } = buildMessage(due);

    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun: true, today,
        wouldNotify: due.map((e) => e.title),
        deviceCount: tokens.length,
        notification: { title, body }
      });
    }

    /* Data-only, deliberately. The service worker's push handler builds the
     * notification itself; sending a `notification` payload as well would let
     * the browser display its own copy alongside ours. */
    const response = await getMessaging().sendEachForMulticast({
      tokens,
      data: {
        title,
        body,
        url: './',
        tag: `cubcave-release-${today}`
      },
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' }
      }
    });

    // Log dead tokens rather than deleting them — see the note at the top.
    response.responses.forEach((result, i) => {
      if (result.success) return;
      const code = result.error && result.error.code;
      const label = subscriptions[i] && subscriptions[i].label;
      console.warn(`Send failed for device "${label || 'unknown'}": ${code}`);
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        console.warn('  ^ this token is dead; it clears when that device re-registers.');
      }
    });

    console.log(`Sent ${response.successCount}/${tokens.length}`);

    return res.status(200).json({
      ok: true,
      today,
      due: due.map((e) => e.title),
      sent: response.successCount,
      failed: response.failureCount
    });
  } catch (err) {
    console.error('Release check failed:', err);
    // 500 so a failure is visible in Cloud Scheduler's run history rather than
    // looking like a silent success.
    return res.status(500).json({ ok: false, today, error: err.message });
  }
});
