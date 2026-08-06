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

**Known limitation:** the schema stores a single token, so notifications go to
the most recently enabled device. Enabling on a phone after a laptop means the
laptop stops receiving them. Storing a list of tokens instead would be a small
change — say the word if you want it.

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
5. ⬜ Daily release check (Cloud Function + Cloud Scheduler)
6. ⬜ Recommendations (Gemini, one-shot, via Cloud Function)
7. ⬜ Polish, docs, end-to-end test
