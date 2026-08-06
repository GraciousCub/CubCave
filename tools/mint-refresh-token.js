/* One-time: mint a long-lived refresh token for the daily Cloud Function.
 *
 *   node tools/mint-refresh-token.js
 *
 * WHY THIS EXISTS
 * The scheduled job has to read your private appDataFolder file. That folder is
 * per-user AND per-app, so a service account cannot reach it — only a token
 * issued to *you* can. The browser app uses the implicit flow, which never
 * issues a refresh token, so this script runs the authorization-code flow once
 * and prints one.
 *
 * BEFORE RUNNING
 *  1. OAuth consent screen publishing status must be "In production", or the
 *     refresh token silently dies after 7 days.
 *  2. Create an OAuth client of type "Desktop app" in the SAME Cloud project,
 *     and put its ID and secret below (or in the environment).
 *
 * The desktop client lives in the same project as the web client, so it opens
 * the same appDataFolder — the folder belongs to the project, not the client.
 *
 * WHAT COMES OUT
 * A refresh token. Treat it as a password: it grants ongoing access to this
 * app's Drive folder for your account. It goes into the Cloud Function's
 * config and nowhere else. Never commit it.
 */

'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var url = require('url');
var fs = require('fs');
var path = require('path');
var readline = require('readline');

var ENV_FILE = path.join(__dirname, '..', 'functions', '.env.yaml');

/* Read the deploy config if it exists, so the client ID and secret don't have
 * to be retyped — they already live there, and pasting long strings into a
 * terminal prompt is exactly where typos happen. Deliberately minimal: this
 * file is a flat list of KEY: "value" lines, not general YAML. */
function loadEnvFile() {
  try {
    var out = {};
    fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(function (line) {
      var match = line.match(/^\s*([A-Z_]+)\s*:\s*(.*?)\s*$/);
      if (!match || line.trim().startsWith('#')) return;
      out[match[1]] = match[2].replace(/^["']|["']$/g, '');
    });
    return out;
  } catch (err) {
    return {};
  }
}

function looksUnset(value) {
  return !value || /^PASTE-/.test(value);
}

var fileConfig = loadEnvFile();

var CLIENT_ID = process.env.OAUTH_CLIENT_ID || fileConfig.GOOGLE_CLIENT_ID || '';
var CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || fileConfig.GOOGLE_CLIENT_SECRET || '';
var SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
var PORT = 53682;                          // loopback redirect target
var REDIRECT = 'http://localhost:' + PORT;

function ask(question) {
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(function (resolve) {
    rl.question(question, function (answer) { rl.close(); resolve(answer.trim()); });
  });
}

function postForm(hostname, path, form) {
  var body = Object.keys(form).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(form[k]);
  }).join('&');

  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: hostname,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      var chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch (err) { reject(new Error('Bad response: ' + chunks.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// PKCE, so the flow is safe even though a "desktop" client secret is not
// genuinely secret.
function pkce() {
  var verifier = crypto.randomBytes(32).toString('base64url');
  var challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier: verifier, challenge: challenge };
}

function waitForCode(expectedState) {
  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      var query = url.parse(req.url, true).query;
      if (!query.code && !query.error) { res.writeHead(404).end(); return; }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2 style="font-family:sans-serif">' +
              (query.error ? 'Authorisation failed: ' + query.error
                           : 'Done — you can close this tab and return to the terminal.') +
              '</h2>');
      server.close();

      if (query.error) reject(new Error(query.error));
      else if (query.state !== expectedState) reject(new Error('State mismatch — aborting.'));
      else resolve(query.code);
    });
    server.listen(PORT, function () {
      console.log('Listening on ' + REDIRECT + ' for the redirect…\n');
    });
    server.on('error', reject);
  });
}

(async function main() {
  console.log('\n--- Cub Cave: mint a refresh token for the daily job ---\n');

  if (looksUnset(CLIENT_ID)) {
    CLIENT_ID = await ask('Desktop OAuth client ID: ');
  } else {
    console.log('Client ID     : ' + CLIENT_ID.slice(0, 28) + '…  (from functions/.env.yaml)');
  }

  if (looksUnset(CLIENT_SECRET)) {
    CLIENT_SECRET = await ask('Desktop OAuth client secret: ');
  } else {
    console.log('Client secret : ' + CLIENT_SECRET.slice(0, 10) + '…  (from functions/.env.yaml)');
  }

  if (!/\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) {
    console.warn('\nWarning: that client ID looks wrong — it should end in');
    console.warn('.apps.googleusercontent.com\n');
  }

  var v = pkce();
  var state = crypto.randomBytes(16).toString('hex');

  var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + [
    'client_id=' + encodeURIComponent(CLIENT_ID),
    'redirect_uri=' + encodeURIComponent(REDIRECT),
    'response_type=code',
    'scope=' + encodeURIComponent(SCOPE),
    // Both are required to be *issued* a refresh token at all.
    'access_type=offline',
    'prompt=consent',
    'code_challenge=' + v.challenge,
    'code_challenge_method=S256',
    'state=' + state
  ].join('&');

  console.log('\nOpen this URL in your browser, signed in as the account whose');
  console.log('Drive holds the data:\n');
  console.log(authUrl + '\n');
  console.log('You will see the "Google hasn\'t verified this app" screen —');
  console.log('choose Advanced, then continue.\n');

  var code = await waitForCode(state);

  var result = await postForm('oauth2.googleapis.com', '/token', {
    code: code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
    code_verifier: v.verifier
  });

  if (result.status !== 200 || !result.body.refresh_token) {
    console.error('\nFailed to get a refresh token:');
    console.error(JSON.stringify(result.body, null, 2));
    if (result.body && result.body.error === 'invalid_grant') {
      console.error('\nTip: the code expires within seconds — try again promptly.');
    }
    process.exit(1);
  }

  var token = result.body.refresh_token;

  console.log('\n=====================================================');
  console.log('REFRESH TOKEN (treat as a password — never commit it):\n');
  console.log(token);
  console.log('\n=====================================================\n');

  // Write it straight into the deploy config. That file is gitignored, it is
  // where the token has to end up anyway, and copying a 100-character
  // credential by hand is a needless chance to get it wrong.
  if (fs.existsSync(ENV_FILE)) {
    try {
      var text = fs.readFileSync(ENV_FILE, 'utf8');
      var line = 'GOOGLE_REFRESH_TOKEN: "' + token + '"';
      var updated = /^\s*GOOGLE_REFRESH_TOKEN\s*:.*$/m.test(text)
        ? text.replace(/^\s*GOOGLE_REFRESH_TOKEN\s*:.*$/m, line)
        : text.replace(/\s*$/, '\n') + line + '\n';
      fs.writeFileSync(ENV_FILE, updated);
      console.log('Written to functions/.env.yaml — nothing to copy.\n');
    } catch (err) {
      console.warn('Could not update functions/.env.yaml: ' + err.message);
      console.warn('Paste the token in by hand as GOOGLE_REFRESH_TOKEN.\n');
    }
  } else {
    console.log('Create functions/.env.yaml from the example and paste it in');
    console.log('as GOOGLE_REFRESH_TOKEN.\n');
  }

  console.log('If the consent screen is still in "Testing", this token will');
  console.log('stop working in 7 days. Publish the app first.\n');
})().catch(function (err) {
  console.error('\nError:', err.message);
  process.exit(1);
});
