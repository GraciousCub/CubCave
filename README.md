# The Cub Cave — Personal Comic Tracker

A single-user PWA for tracking comic reading progress, with release-day push
notifications. Static site, no build step, hosted on GitHub Pages.

**Status: Phase 3 (Google Drive sync).** Full usage docs land in Phase 7.

## Layout

```
index.html          app shell + add/edit sheet
manifest.json       PWA manifest
sw.js               service worker (shell caching; push added in Phase 4)
css/styles.css
js/config.js        YOUR OAuth Client ID goes here
js/store.js         data model + local mirror
js/drive.js         Google auth + Drive appDataFolder access
js/sync.js          reconciles the local mirror with Drive
js/push.js          notification permission + FCM token (lazy-loads the SDK)
js/app.js           rendering and input handling
icons/              generated PNGs — do not edit by hand
tools/make-icons.js regenerates icons/ (node tools/make-icons.js)
tools/serve.js      local dev server (node tools/serve.js)
tools/mint-refresh-token.js  one-time: refresh token for the daily job
functions/          Cloud Function: daily release check (see Phase 5 below)
```

**Note:** after changing any shell file, bump `CACHE_VERSION` in `sw.js` —
otherwise the service worker keeps serving the old cached copies. (`config.js`
is exempt: it is fetched network-first precisely because it gets edited.)

## How storage works

Google Drive is the source of truth. `localStorage` is a mirror, so the app
opens instantly and keeps working offline.

- Edits save to the mirror immediately and mark the data **dirty**.
- A dirty flag triggers a debounced (1.5s) upload to Drive.
- On open, reconnect, or returning to the app: if dirty, local is pushed up
  (nothing you typed is discarded); if clean, Drive is pulled down (so another
  device's changes appear).

**Known limitation:** last-write-wins. Editing on device A while offline, then
editing device B, then bringing A back online means A overwrites B. With one
person using one device at a time this can't really happen — it's documented
rather than engineered around.

The Drive file is `cubcave-data.json` in the **appDataFolder**: a hidden,
per-app folder. It does not show up in your normal Drive, and no other app can
read it.

## Google Cloud setup (one time)

1. **Create a project** — [console.cloud.google.com](https://console.cloud.google.com/),
   project picker → **New project**, name it `CubCave`.
2. **Enable the Drive API** — *APIs & Services → Library* → search
   "Google Drive API" → **Enable**.
3. **Configure the OAuth consent screen** — *APIs & Services → OAuth consent
   screen*. User type **External**. Fill in app name, your email for both
   support and developer contact. Add the scope
   `https://www.googleapis.com/auth/drive.appdata`. Add your own Google account
   under **Test users**. Leave publishing status as **Testing** — a personal
   app never needs Google verification.
4. **Create the Client ID** — *APIs & Services → Credentials → Create
   credentials → OAuth client ID*, type **Web application**. Under
   **Authorised JavaScript origins** add both:
   - `https://graciouscub.github.io`
   - `http://localhost:5173`

   Leave *Authorised redirect URIs* empty — the token flow doesn't use them.
   Origins are scheme + host + port only, never a path.
5. **Paste the Client ID** into `googleClientId` in `js/config.js`, then commit
   and push.

Because the app stays in Testing mode, Google shows an "unverified app" screen
on first sign-in. That is expected. Click **Advanced → Go to CubCave
(unsafe)** — "unsafe" here only means Google hasn't reviewed it, and the app is
yours.

## Notifications

The **Upcoming** tab carries a card that turns on release-day alerts. It asks
for permission only when you tap **Enable** — never on load, because a browser
that auto-blocks an unprompted request records a *denial*, and a denied site
cannot ask again from code.

Once on, the FCM token is written into the Drive JSON as
`pushSubscription.fcmToken`. Phase 5's scheduled job reads it from there.

A **Test** button appears once enabled. It fires a notification straight from
the service worker with no server involved — useful for proving permission, the
worker, and the display path all work before the scheduled job exists.

**iOS:** web push works on iOS 16.4+ **only for apps added to the Home
Screen**. In a normal Safari tab the app detects this and says so instead of
offering a button that cannot work.

### Browser support

Verified working in **Chrome**. **Opera GX does not work** and cannot be made
to — it fails at the browser's own push layer, before Firebase is involved:

```
rawSubscribe: "FAILED — AbortError: Registration failed - push service error"
```

…with permission granted, service worker active, secure context, and valid
config. Opera doesn't ship a working Google push service. Use Chrome, Edge or
Firefox on desktop; on mobile this is moot, since the target is the installed
PWA.

If notifications ever misbehave, run this in the browser console — it tests the
raw push layer with Firebase bypassed, which separates "browser problem" from
"app problem" in one step:

```js
await CubCave.push.diagnose()
```

**Multiple devices** each get their own entry in `pushSubscriptions`, so
enabling on a phone doesn't stop the laptop being notified. Re-registering the
same device updates its entry rather than duplicating it, and a rotated token
replaces the one it superseded. Documents written in the original
single-`pushSubscription` shape are migrated automatically on load.

## Firebase setup (one time)

1. **Create the Firebase project** — [console.firebase.google.com](https://console.firebase.google.com/)
   → **Add project**. When it asks for a name, pick the **existing `CubCave`
   Google Cloud project** from the dropdown rather than making a new one. That
   keeps auth, messaging, and Phase 5's function in one place.
2. **Skip Google Analytics** when offered — not needed, and it adds setup.
3. **Register a web app** — Project Overview → the **`</>`** (Web) icon.
   Nickname it `Cub Cave Web`. **Do not** tick "Also set up Firebase Hosting" —
   the app is hosted on GitHub Pages.
4. **Copy the config** shown as `firebaseConfig` into the `firebase` block in
   `js/config.js`: `apiKey`, `authDomain`, `projectId`, `messagingSenderId`,
   `appId`. (Ignore `storageBucket` and `measurementId`.)
5. **Generate the VAPID key** — Project settings (gear) → **Cloud Messaging**
   tab → **Web Push certificates** → **Generate key pair**. Copy the key string
   into `vapidKey` in `js/config.js`.
6. Commit and push.

This is all on the free **Spark** plan: Cloud Messaging is free with no usage
cap and **no payment method required**. (Phase 5's Cloud Function is the part
that needs billing enabled — see the note there.)

## Daily release check (Phase 5)

`functions/index.js` runs once a day on Cloud Functions (2nd gen): it reads the
Drive file, finds `upcoming` entries whose `releaseDate` is today in
`Europe/London`, and pushes one FCM message to every registered device.

**It never writes to Drive.** The client syncs last-write-wins, so a server
write could clobber an edit made on your phone between the read and the write.
Dead tokens are logged instead; the client clears them when it re-registers.

Test the handler with no credentials, no network, and nothing sent:

```bash
node functions/test-local.js
```

Check what the job **would do against your real Drive data**, without deploying
and without sending anything — the quickest answer to "why didn't I get a
notification?":

```bash
node tools/check-daily-job.js
```

It reports whether the refresh token still works, whether the data file is
reachable, how many devices are registered, and which entries are due. Pass a
date to pretend it is another day: `node tools/check-daily-job.js 2026-10-07`.

### Why a refresh token, and why the app must be published

`appDataFolder` is private per-user *and* per-app, so a service account cannot
read it — only a token issued to you can. Google's docs are explicit that a
project whose consent screen is **External + Testing** gets refresh tokens that
**expire after 7 days**, which would break the job weekly. Publishing to
production removes that limit. It does not make the app public or listed; you
will still see the unverified-app screen, which is expected.

### One-time setup

**1. Publish the OAuth app.** Google Auth Platform → **Audience** → **Publish
app**. Status must read *In production*.

**2. Create a Desktop OAuth client.** Google Auth Platform → **Clients** →
**Create client** → type **Desktop app**. Note its ID and secret. It lives in
the same project as the web client, so it opens the same `appDataFolder`.

**3. Mint the refresh token:**

```bash
node tools/mint-refresh-token.js
```

**4. Create `functions/.env.yaml`** from `.env.yaml.example` and paste in the
client ID, secret, and refresh token. This file is gitignored — the refresh
token is a real credential.

**5. Install the gcloud CLI** — https://cloud.google.com/sdk/docs/install —
then:

```bash
gcloud auth login
```

### Deploy

```bash
gcloud config set project cubcave
```

```bash
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com
```

```bash
gcloud functions deploy release-check --gen2 --runtime=nodejs20 --region=europe-west2 --source=./functions --entry-point=releaseCheck --trigger-http --no-allow-unauthenticated --env-vars-file=functions/.env.yaml
```

`--no-allow-unauthenticated` matters: without it the endpoint is open to the
internet and anyone could trigger your notifications.

Let the function's runtime account send messages:

```bash
gcloud projects add-iam-policy-binding cubcave --member="serviceAccount:1009364728296-compute@developer.gserviceaccount.com" --role="roles/firebasemessaging.admin"
```

### Schedule it

```bash
gcloud iam service-accounts create cubcave-scheduler --display-name="Cub Cave scheduler"
```

```bash
gcloud run services add-iam-policy-binding release-check --region=europe-west2 --member="serviceAccount:cubcave-scheduler@cubcave.iam.gserviceaccount.com" --role="roles/run.invoker"
```

Get the URL:

```bash
gcloud functions describe release-check --region=europe-west2 --format="value(serviceConfig.uri)"
```

Then create the job, substituting that URL twice:

```bash
gcloud scheduler jobs create http cubcave-daily-check --location=europe-west2 --schedule="0 8 * * *" --time-zone="Europe/London" --uri="FUNCTION_URL" --http-method=GET --oidc-service-account-email="cubcave-scheduler@cubcave.iam.gserviceaccount.com" --oidc-token-audience="FUNCTION_URL"
```

**To change the time**, edit the cron: `0 8 * * *` is 08:00 daily.

```bash
gcloud scheduler jobs update http cubcave-daily-check --location=europe-west2 --schedule="0 7 * * *"
```

### Testing and troubleshooting

Run it now without waiting for 08:00:

```bash
gcloud scheduler jobs run cubcave-daily-check --location=europe-west2
```

Logs:

```bash
gcloud functions logs read release-check --region=europe-west2 --limit=50
```

A dry run reports what *would* be sent and sends nothing. Append
`?dryRun=1` to the function URL, or `?date=2026-10-07` to pretend it is another
day. The endpoint requires authentication, so call it with:

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "FUNCTION_URL?dryRun=1"
```

If logs show `invalid_grant`, the refresh token is dead — re-run
`tools/mint-refresh-token.js`, and check the consent screen really is published
to production.

### Cost

One scheduled job against 3 free per month; roughly 30 invocations against
2,000,000 free. Expected spend £0. Billing must still be enabled on the
project, which is Google policy rather than a charge.

## Security notes

- **Scope is `drive.appdata` only.** The app can reach its own hidden folder
  and nothing else — not your documents, not your photos, not any other file.
- **No `profile`, `email`, or `openid` scopes.** The app never learns your name
  or address; identity is implicit in whose Drive the token opens.
- **The access token lives in memory only** — never in localStorage, session
  storage, or a cookie, so it can't be lifted off the device later.
- **You tap "Sign in" once per app launch.** Google's token flow always opens a
  popup, and browsers block popups that no one clicked, so silent auto-sign-in
  on load cannot work. Until you tap it, edits are saved on the device and
  marked pending; they upload on the next successful sync. Nothing is lost by
  using the app signed out.
- **There is no client secret.** Browser OAuth clients are public by design;
  the Client ID is safe to commit, and Google restricts it to the origins you
  listed above.
- **Signing out clears the local mirror** as well as revoking the token, so the
  device is left with no reading data on it.

## Running locally

Service workers need `http://localhost`, not `file://`:

```bash
node tools/serve.js
```

Then open http://localhost:5173.

## Build phases

1. ✅ Scaffolding — PWA shell, manifest, service worker, GitHub Pages
2. ✅ Core UI, local state
3. ✅ Google Drive storage (`drive.appdata`)
4. ✅ Push notifications (FCM, client side)
5. ✅ Daily release check (Cloud Function + Cloud Scheduler)
6. ⬜ Recommendations (Gemini, one-shot, via Cloud Function)
7. ⬜ Polish, docs, end-to-end test
