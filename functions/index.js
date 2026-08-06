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
