/* Pre-deploy check: does the refresh token actually reach the Drive file?
 *
 *   node tools/check-daily-job.js
 *   node tools/check-daily-job.js 2026-10-07     (pretend it's another day)
 *
 * Reads functions/.env.yaml, exchanges the refresh token, reads the data file,
 * and reports exactly what the scheduled job would do today. Sends nothing and
 * needs no cloud deployment — this is the cheapest way to prove the auth chain
 * works end to end.
 *
 * Prints titles and counts, never tokens.
 */

'use strict';

var fs = require('fs');
var path = require('path');

var ENV_FILE = path.join(__dirname, '..', 'functions', '.env.yaml');

function loadEnvFile() {
  var out = {};
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(function (line) {
    if (line.trim().startsWith('#')) return;
    var match = line.match(/^\s*([A-Z_]+)\s*:\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  });
  return out;
}

function todayInZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

(async function main() {
  var config;
  try {
    config = loadEnvFile();
  } catch (err) {
    console.error('Could not read functions/.env.yaml — has it been created?');
    process.exit(1);
  }

  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].forEach(function (key) {
    if (!config[key] || /^PASTE-/.test(config[key])) {
      console.error('Missing ' + key + ' in functions/.env.yaml');
      process.exit(1);
    }
  });

  var timezone = config.TIMEZONE || 'Europe/London';
  var fileName = config.DRIVE_FILE_NAME || 'cubcave-data.json';
  var today = process.argv[2] || todayInZone(timezone);

  console.log('\n--- Cub Cave: what would the daily job do? ---\n');
  console.log('Timezone   : ' + timezone);
  console.log('Date used  : ' + today + (process.argv[2] ? '  (overridden)' : ''));

  // 1. Refresh token -> access token
  var tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: config.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  var tokenBody = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenBody.access_token) {
    console.error('\nFAILED to exchange the refresh token:');
    console.error(JSON.stringify(tokenBody, null, 2));
    if (tokenBody.error === 'invalid_grant') {
      console.error('\nThe token is dead already. Usual causes:');
      console.error('  - consent screen still in "Testing" (7-day expiry)');
      console.error('  - access revoked at myaccount.google.com/permissions');
      console.error('Re-run tools/mint-refresh-token.js after publishing.');
    }
    process.exit(1);
  }
  console.log('Auth       : OK — access token issued');

  var headers = { Authorization: 'Bearer ' + tokenBody.access_token };

  // 2. Find the file in appDataFolder
  var query = encodeURIComponent("name='" + fileName + "' and trashed=false");
  var listResponse = await fetch(
    'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + query +
    '&fields=files(id,name,modifiedTime)&pageSize=10', { headers });

  if (!listResponse.ok) {
    console.error('\nDrive list failed (' + listResponse.status + '): ' + await listResponse.text());
    process.exit(1);
  }

  var files = (await listResponse.json()).files || [];
  if (!files.length) {
    console.log('Drive      : no ' + fileName + ' in appDataFolder yet.');
    console.log('\nSign in inside the app and add an entry, then run this again.\n');
    process.exit(0);
  }
  console.log('Drive      : found ' + fileName + ', modified ' + files[0].modifiedTime);

  // 3. Read it
  var fileResponse = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + files[0].id + '?alt=media', { headers });
  if (!fileResponse.ok) {
    console.error('\nDrive read failed (' + fileResponse.status + '): ' + await fileResponse.text());
    process.exit(1);
  }
  var data = await fileResponse.json();

  var entries = Array.isArray(data.entries) ? data.entries : [];
  var subscriptions = Array.isArray(data.pushSubscriptions)
    ? data.pushSubscriptions
    : (data.pushSubscription ? [data.pushSubscription] : []);

  console.log('\nEntries    : ' + entries.length);
  var byStatus = {};
  entries.forEach(function (e) { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });
  Object.keys(byStatus).forEach(function (s) {
    console.log('  ' + s.padEnd(9) + byStatus[s]);
  });

  console.log('\nDevices    : ' + subscriptions.length);
  subscriptions.forEach(function (s) {
    console.log('  - ' + (s.label || 'unlabelled') + '  (registered ' +
                String(s.registeredAt || '?').slice(0, 10) + ')');
  });

  var upcoming = entries.filter(function (e) { return e.status === 'upcoming'; });
  var due = upcoming.filter(function (e) { return e.releaseDate === today; });
  var undated = upcoming.filter(function (e) { return !e.releaseDate; });

  console.log('\nUpcoming with a date:');
  upcoming.filter(function (e) { return e.releaseDate; })
    .sort(function (a, b) { return a.releaseDate < b.releaseDate ? -1 : 1; })
    .slice(0, 10)
    .forEach(function (e) {
      console.log('  ' + e.releaseDate + '  ' + e.title +
                  (e.releaseDate === today ? '   <-- TODAY' : ''));
    });
  if (!upcoming.some(function (e) { return e.releaseDate; })) console.log('  (none)');
  if (undated.length) {
    console.log('\n  ' + undated.length + ' upcoming entr' +
                (undated.length === 1 ? 'y has' : 'ies have') +
                ' no release date — these can never notify.');
  }

  console.log('\n--- Verdict ---');
  if (!due.length) {
    console.log('Nothing releases today. The job would send no notification.');
    console.log('To test properly: set an upcoming entry to ' + today + ', or run');
    console.log('  node tools/check-daily-job.js <a date from the list above>');
  } else if (!subscriptions.length) {
    console.log(due.length + ' due today, but NO devices registered — nothing would send.');
    console.log('Turn notifications on in the app first.');
  } else {
    console.log(due.length + ' due today; would notify ' + subscriptions.length + ' device(s):');
    due.forEach(function (e) { console.log('  - ' + e.title); });
  }
  console.log('');
})().catch(function (err) {
  console.error('\nError:', err.message);
  process.exit(1);
});
