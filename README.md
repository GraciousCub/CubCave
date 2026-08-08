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

### Signing in never guesses

When you sign in, the account's copy is read and compared with the device's
before anything is written. Only when **both** hold data and they differ are you
asked which to keep, with a count of each side and when it last changed. Every
other case has one obvious answer and is taken silently: an empty device pulls,
an empty account is pushed to, identical contents do nothing.

This replaced an earlier rule — "if the device has unsaved changes, the device
wins" — that could **wipe an account**. The dirty flag is set by any local
write, including the notification-token refresh that runs on launch, so a device
with no data could mark itself dirty and then push nothing over everything. That
is the bug behind data vanishing after signing in on an empty device.

**Known limitation:** still last-write-wins *after* sign-in. Editing on device A
while offline, then editing device B, then bringing A back online means A
overwrites B. With one person using one device at a time this can't really
happen — it's documented rather than engineered around.

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
gcloud functions deploy release-check --gen2 --runtime=nodejs22 --region=europe-west2 --source=./functions --entry-point=releaseCheck --trigger-http --no-allow-unauthenticated --env-vars-file=functions/.env.yaml
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

## Comic search and autofill (Phase 6)

Typing a title in the add/edit sheet searches a comic database and offers
matches. Picking one fills in the title, series and release date, and moves the
entry to **Upcoming** if the comic hasn't come out yet.

### Two sources, and why

**[Metron](https://metron.cloud/) is primary.** It ingests publisher
solicitation catalogues about three months ahead, so it knows about issues that
haven't been released — which is the entire point of a release tracker. It also
carries `year_began`, so *"Absolute Batman (2024)"* is distinguishable from
every other Batman series.

**[Comic Vine](https://comicvine.gamespot.com/api/) is the fallback**, consulted
only when Metron returns fewer than 5 matches, for back catalogue that Metron's
community coverage misses. A typical search costs one upstream request.

Comic Vine has **no forthcoming issues at all** — measured, not assumed: across
100 results for "absolute batman" the newest was #22 dated 2026-07-08, already
in the past, while Metron had #23 on 2026-08-12. That is why the sources are
ordered this way.

Neither can be called from the browser — Comic Vine sends no CORS headers, and
both need credentials — so `comicSearch` in `functions/index.js` proxies them.

**Metron result ordering:** Metron returns matches oldest-first and supports no
`ordering` parameter, so a bare "detective comics" (1,147 issues) would hand
back 1937. Queries without an issue number are therefore restricted to roughly
the last year, with no upper bound so solicited future issues are included.
Queries *with* an issue number skip that window, since a specific issue may well
be old.

**Quota discipline.** Metron allows 20 requests/minute and 5,000/day; Comic Vine
400 per 15 minutes. Typing "Absolute Batman" is 15 keystrokes. So: nothing fires
under 3 characters, keystrokes are debounced 350ms, superseded requests are
aborted, repeat queries come from a local cache without leaving the browser, the
function caches for 10 minutes on top of that, and failures are shown rather
than retried. A `Retry-After` from either upstream is passed through to the
message you see rather than guessed at.

**Access control.** The endpoint is reachable without Cloud Run authentication —
the browser can't mint an OIDC token — so the function checks it itself: the
caller must present a Google access token issued to *this app's* OAuth client.
Without that, the URL sits in your public JavaScript as a free comic-search API
billed to you. `--max-instances=3` bounds the damage if it's ever hammered.

Search needs you signed in. If you aren't, the sheet says so and sends nothing.

**Dates:** `store_date` (the day it reaches shops) is preferred. Where Comic Vine
only has `cover_date` — the printed month, often weeks later — the suggestion is
labelled *(cover date)* so you know it's approximate.

**Ranking is by similarity to what you typed**, not by date. Series-name token
coverage, exact-series and prefix bonuses, a penalty for extra words in the
series title, and a strong boost for an exact issue-number match. Date only
breaks ties between equally good matches, newest first. Up to 20 results.

Verified against the live APIs:

- `absolute batman` → #23, 2026-08-12, **upcoming**, top of the list
- `detective comics` → #1112, 2026-08-26, **upcoming**
- `batman bad seeds` → *Bad Seeds – Sunset #1*, 2026-08-26, **upcoming**

Test the proxy with no key, no network and no quota used:

```bash
node functions/test-search.js
```

## The library view

Issues are grouped into their series and shown as cover art.

- Each tab shows a **grid of series**, with a badge for how many of that series
  are in the list you're looking at, and the total tracked underneath.
- The cover shown for a series is its **earliest tracked issue's** cover.
- **Tap a series** to open it and see every issue of it, whatever list each is
  in, sorted by issue number.
- Inside a series, tap a cover to edit, or use the button under it to move that
  one issue along (Queue → Start → Read, or Unread).
- **Mark released issues read** does the whole series at once. It's a two-step
  button, and it deliberately **skips issues dated in the future** — you can't
  have read something that isn't out, and marking them would hide them from the
  release notifications they exist for.
- **Delete series** removes every issue of it and unfollows. Also two-step, and
  it names the number of issues before you confirm. There is no undo.

### Ordering

Series tiles can be **dragged into any order, on every tab**, and that order is
shared across all of them — a series you consider urgent is urgent wherever it
appears. Series you haven't arranged fall in afterwards, in whatever order the
list naturally produced (soonest release, most recently finished).

**On touch, press and hold for about a third of a second to pick a tile up.**
A swipe scrolls, a tap opens the series, a hold starts a drag. With a mouse,
just drag. Dragging one series leaves every other series exactly where it was.

### Choosing the database

The icons beside the search box pick which database to search:

- **Auto** (default) — Metron, falling back to Comic Vine when it comes back thin
- **Metron only** — the source that knows about unreleased issues
- **Comic Vine only** — deeper back catalogue

The choice is remembered, applies to both series and issue search, and with a
source pinned there is **no silent fallback**, so results genuinely come from
where the toggle says. The icons are the sites' own favicons, hotlinked, and
fall back to a monogram if they don't load.

Results are shown 8 at a time behind a **More** button, each with a cover
thumbnail.

**Series results only have art from Comic Vine.** Metron's series records carry
no image at all — not even on the detail endpoint — so its series results show
initials instead. Fetching issue #1's cover for each would cost one extra
request per result against a 20/minute limit, which isn't worth it. Issue
results have covers from both sources.

Entries with no series are grouped under **Other**.

Covers come from the comic database and are hotlinked, so they need a
connection. When one is missing or fails to load, the tile falls back to the
series initials rather than showing a broken image.

### Icons

`icons/source.png` is the artwork; `node tools/make-icons.js` regenerates every
size from it. The generator handles 8-bit RGBA non-interlaced PNGs and fails
loudly on anything else. If the artwork has its own opaque background, that
colour is extended for the maskable and iOS icons — otherwise the inset shows a
visible square where one dark meets another.

## Adding comics

**You add a series, not individual issues.** `+ Series` searches the database,
and picking one:

- imports **every issue of that run**, with cover art
- marks issues **not yet released** as Upcoming automatically
- puts the rest in your queue to mark as you read them

**Adding does not follow.** Following is a separate decision, made with the
**Follow** button in the series view — adding a finished run shouldn't sign you
up for notifications about it.

Adding the same series again is safe: issues already tracked are skipped and it
reports how many were.

`Add one issue` inside that sheet is the escape hatch for anything the database
doesn't have — the old per-issue form, unchanged.

Long runs are capped at 500 issues per import.

### Missing covers

Entries added before covers were stored show initials instead. **Find missing
covers** on the Upcoming tab fixes them: it resolves one series at a time (a
series lookup, then its issues in one request) and matches on issue number,
filling in cover art, issue number and source id. Issues with no series can't
be looked up and are left alone.

## Following a series

The **Upcoming** tab has a *Following* card. Follow a series and its new issues
are added to Upcoming automatically — which is how an issue reaches your list
even when the database doesn't know about it yet.

Following is by **series id**, not name, so "Batman (2025)" can never drift into
matching "Batman (1940)".

### Watching both catalogues

Following a series links it to **the same series in the other database**, and
the daily check then watches both. An issue announced in either one is picked
up — useful because their coverage differs: at the time of writing Metron listed
23 issues of *Absolute Batman* and Comic Vine 22.

The link is authoritative, not guesswork: Metron records the Comic Vine id of
each series it mirrors (`cv_id`) and can be queried by it, so the pairing works
in both directions without ever matching on names — which would eventually pair
the wrong *Batman*.

**Duplicates are prevented by issue number, not database id**, since the same
comic has a different id in each catalogue. Issues are filed under the name you
follow the series by, so both sources land in one series rather than two.

The logos beside a series — in the Following list and at the top of the series
view — show which catalogues it's tracked in. Two logos means both.

**Two things check for new issues:**

1. **When you follow**, immediately — so you can see what it brought in.
2. **The daily job**, before it sends notifications. An issue solicited
   overnight that turns out to be released *today* still notifies you today.

An issue added this way carries a `sourceId` (e.g. `metron:127884`), so
re-checking never creates duplicates. Unfollowing removes the subscription but
**keeps the issues** already added — they're yours now.

**This is the one case where the daily job writes to Drive**, and only on the
rare day a followed series gains an issue. Because the client syncs
last-write-wins, the job re-reads the file immediately before writing and
appends to *that* copy, so an edit made on your phone since the run started
isn't lost. On every other day it writes nothing at all.

`METRON_TOKEN` must be in **both** `functions/.env.yaml` (for the daily check)
and `functions/.env.search.yaml` (for search). Without it in the former, the
follow check silently does nothing.

### Setup

**1. Metron token** — free account at [metron.cloud](https://metron.cloud/),
then the **API Tokens** page in your profile → **Generate Token**. It's sent as
`Authorization: Bearer <token>` and doesn't expire; revoke it there if it leaks.

**2. Comic Vine API key** (optional, for back catalogue) — free account at
[comicvine.gamespot.com](https://comicvine.gamespot.com/), then open
[comicvine.gamespot.com/api/](https://comicvine.gamespot.com/api/) while signed
in. Your key is on that page.

**3. Create `functions/.env.search.yaml`** from `.env.search.yaml.example` and
paste both in. It's gitignored, and kept separate from `.env.yaml` so the search
function never holds the Drive refresh token, and the daily job never holds the
comic database credentials.

**3. Deploy:**

```bash
gcloud functions deploy comic-search --gen2 --runtime=nodejs22 --region=europe-west2 --source=./functions --entry-point=comicSearch --trigger-http --allow-unauthenticated --max-instances=3 --env-vars-file=functions/.env.search.yaml
```

**4. Get the URL and put it in `js/config.js` as `searchEndpoint`:**

```bash
gcloud functions describe comic-search --region=europe-west2 --format="value(serviceConfig.uri)"
```

Then commit and push, so GitHub Pages serves the updated config.

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
6. ⬜ Comic search + autofill (Comic Vine, via Cloud Function)
7. ⬜ Recommendations (Gemini, one-shot, via Cloud Function)
8. ⬜ Polish, docs, end-to-end test
