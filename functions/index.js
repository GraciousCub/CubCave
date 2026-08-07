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
const METRON_TOKEN = process.env.METRON_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://graciouscub.github.io,http://localhost:5173').split(',');
const EXPECTED_AUDIENCE = process.env.GOOGLE_WEB_CLIENT_ID || '';

const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 20;

/* Comic Vine's search has no date relevance: asking for 8 results for
 * "batman 14" returns eight issues all titled "Batman #14" from runs going
 * back decades, and the current one isn't among them. The volume stub in
 * search results carries no start year, so those rows are indistinguishable.
 *
 * Fetching a wider set and sorting newest-first — for the same single upstream
 * request — puts current and forthcoming issues at the top, which is what
 * someone tracking releases is looking for. Undated records sink to the
 * bottom: they can never drive a notification. */
const UPSTREAM_LIMIT = 100;

/* ---------- relevance ----------
 *
 * Upstream search returns matches in its own order, which is neither
 * similarity nor date. Ranking here means one request can be cast wide and
 * still show the right thing first.
 */

function normaliseText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* A trailing number is almost always an issue number ("batman 14"), so it is
 * split off and matched separately from the series words. */
function parseQuery(query) {
  const cleaned = normaliseText(query);
  const match = cleaned.match(/^(.*?)\s*(\d+)$/);
  const text = match ? match[1] : cleaned;
  return {
    tokens: text ? text.split(' ').filter(Boolean) : [],
    number: match ? match[2] : null
  };
}

function relevanceScore(parsed, item) {
  const series = normaliseText(item.series);
  const seriesTokens = series ? series.split(' ') : [];
  let score = 0;

  // How much of what was typed appears in the series name.
  if (parsed.tokens.length) {
    let matched = 0;
    parsed.tokens.forEach((token) => {
      if (seriesTokens.includes(token)) matched += 1;
      else if (seriesTokens.some((s) => s.startsWith(token))) matched += 0.7;
      else if (series.includes(token)) matched += 0.4;
    });
    score += (matched / parsed.tokens.length) * 100;
  }

  const joined = parsed.tokens.join(' ');
  if (series && series === joined) score += 60;            // exact series
  else if (series.startsWith(joined + ' ')) score += 25;    // "Batman ..."

  /* Words in the series that weren't typed usually mean a different book:
   * "Batman: Urban Legends" is not what someone typing "batman" wants. */
  score -= Math.max(0, seriesTokens.length - parsed.tokens.length) * 6;

  if (parsed.number) {
    if (item.issueNumber === parsed.number) score += 70;
    else score -= 15;
  }

  return score;
}

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

function mapComicVineIssue(issue) {
  const seriesName = (issue.volume && issue.volume.name) || '';
  const number = issue.issue_number ? `#${issue.issue_number}` : '';
  return {
    source: 'comicvine',
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

/* Metron carries the year the series began, so "Absolute Batman (2024)" is
 * distinguishable from every other Batman book — the ambiguity that makes
 * Comic Vine results hard to choose between. */
function mapMetronIssue(issue) {
  const series = issue.series || {};
  const seriesName = series.name || '';
  const seriesLabel = series.year_began
    ? `${seriesName} (${series.year_began})`
    : seriesName;
  const number = issue.number ? `#${issue.number}` : '';
  return {
    source: 'metron',
    sourceId: issue.id,
    releaseDate: normaliseDate(issue.store_date) || normaliseDate(issue.cover_date),
    dateIsApproximate: !normaliseDate(issue.store_date),
    title: [seriesName, number].filter(Boolean).join(' ') || (issue.issue || 'Untitled'),
    series: seriesLabel,
    issueNumber: issue.number || '',
    storyTitle: '',
    coverUrl: issue.image || ''
  };
}

/* Shared fetch: bounded wait, single attempt. Retrying an upstream that rate
 * limits this tightly would make things worse, not better. */
async function fetchJson(url, headers, sourceLabel) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SEARCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: abort.signal, headers });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(
        new Error(`${sourceLabel} took too long to answer`), { status: 504 }
      );
    }
    throw Object.assign(new Error(`Could not reach ${sourceLabel}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429 || response.status === 420) {
    // Metron sends Retry-After; pass it on rather than guessing.
    const retryAfter = response.headers ? response.headers.get('retry-after') : null;
    throw Object.assign(
      new Error(`${sourceLabel} is rate limiting us — try again${
        retryAfter ? ` in ${retryAfter}s` : ' shortly'}`),
      { status: 429, retryAfter }
    );
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(`${sourceLabel} returned ${response.status}`), { status: 502 }
    );
  }
  return response.json();
}

const USER_AGENT = 'CubCave-ComicTracker/1.0 (personal comic reading tracker)';

/* Metron is the primary source: it ingests publisher solicitations about three
 * months ahead, so it knows about issues that haven't come out yet. Comic Vine
 * does not, which is the whole reason for tracking releases. */
async function searchMetron(parsed) {
  if (!METRON_TOKEN) return [];

  const params = new URLSearchParams();
  const seriesName = parsed.tokens.join(' ');
  if (seriesName) params.set('series_name', seriesName);
  if (!seriesName && !parsed.number) return [];

  if (parsed.number) {
    // A specific issue was asked for, so don't constrain by date — it may
    // well be an old one.
    params.set('number', parsed.number);
  } else {
    /* Metron returns matches oldest-first and supports no ordering parameter,
     * so a bare "detective comics" (1,147 issues) hands back 1937. Restricting
     * to roughly the last year — with no upper bound, so solicited future
     * issues are included — is both what a release tracker wants and small
     * enough to come back in a single page. Back catalogue is Comic Vine's
     * job, via the fallback below. */
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    params.set('store_date_range_after', since.toISOString().slice(0, 10));
  }

  const body = await fetchJson(
    `https://metron.cloud/api/issue/?${params}`,
    {
      Authorization: `Bearer ${METRON_TOKEN}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    },
    'Metron'
  );

  return (body.results || []).map(mapMetronIssue);
}

/* Comic Vine fills in back catalogue that Metron's community coverage misses.
 * Only consulted when Metron came back thin, to stay well inside both quotas. */
async function searchComicVine(query) {
  if (!COMICVINE_KEY) return [];

  const url = 'https://comicvine.gamespot.com/api/search/?' + new URLSearchParams({
    api_key: COMICVINE_KEY,
    format: 'json',
    resources: 'issue',
    limit: String(UPSTREAM_LIMIT),
    query,
    field_list: 'id,name,issue_number,store_date,cover_date,volume,image'
  });

  const body = await fetchJson(
    url,
    // Comic Vine rejects requests with no/default User-Agent.
    { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    'Comic Vine'
  );

  if (body.error && body.error !== 'OK') {
    const throttled = /rate limit/i.test(body.error) || body.status_code === 107;
    throw Object.assign(
      new Error(throttled
        ? 'Comic Vine is rate limiting us — try again shortly'
        : `Comic Vine: ${body.error}`),
      { status: throttled ? 429 : 502 }
    );
  }

  return (body.results || []).map(mapComicVineIssue);
}

/* Same issue from both sources: keep Metron's, which has the better date. */
function dedupe(items) {
  const seen = new Map();
  items.forEach((item) => {
    const key = `${normaliseText(item.series).replace(/\s*\(\d{4}\)\s*$/, '')}|${item.issueNumber}|${item.releaseDate || ''}`;
    const existing = seen.get(key);
    if (!existing || (existing.source !== 'metron' && item.source === 'metron')) {
      seen.set(key, item);
    }
  });
  return Array.from(seen.values());
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
    if (!METRON_TOKEN && !COMICVINE_KEY) {
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

    const parsed = parseQuery(query);

    /* Metron first — it's the only one of the two that knows about issues yet
     * to be released. Comic Vine is consulted only when Metron comes back
     * thin, so a typical search costs one upstream request, not two. */
    let found = [];
    let metronFailure = null;

    try {
      found = await searchMetron(parsed);
    } catch (err) {
      // A Metron outage shouldn't take search down if Comic Vine can answer.
      metronFailure = err;
      console.warn('Metron search failed:', err.message);
    }

    if (found.length < 5 && COMICVINE_KEY) {
      try {
        found = found.concat(await searchComicVine(query));
      } catch (err) {
        // Both down, or Metron already failed and this was the last hope.
        if (!found.length) throw metronFailure || err;
        console.warn('Comic Vine search failed:', err.message);
      }
    }

    if (!found.length && metronFailure) throw metronFailure;

    const results = dedupe(found)
      // An entry with no date at all can't drive a release notification, but
      // it's still a valid thing to track, so keep it and let the UI say so.
      .filter((r) => r.title)
      .map((r) => ({ item: r, score: relevanceScore(parsed, r) }))
      .sort((a, b) => {
        // Similarity to what was typed decides the order. Date only breaks
        // ties between equally good matches — newest first, since a tracker
        // is usually reaching for a current issue.
        if (b.score !== a.score) return b.score - a.score;
        if (!a.item.releaseDate && !b.item.releaseDate) return 0;
        if (!a.item.releaseDate) return 1;
        if (!b.item.releaseDate) return -1;
        return b.item.releaseDate.localeCompare(a.item.releaseDate);
      })
      .slice(0, MAX_RESULTS)
      .map((scored) => scored.item);

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
