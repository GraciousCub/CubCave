# The Cub Cave — Personal Comic Tracker

A single-user PWA for tracking comic reading progress, with release-day push
notifications. Static site, no build step, hosted on GitHub Pages.

**Status: Phase 2 (core UI, local storage).** Full usage docs land in Phase 7.

## Layout

```
index.html          app shell + add/edit sheet
manifest.json       PWA manifest
sw.js               service worker (shell caching; push added in Phase 4)
css/styles.css
js/store.js         data model + persistence (localStorage; Drive in Phase 3)
js/app.js           rendering and input handling
icons/              generated PNGs — do not edit by hand
tools/make-icons.js regenerates icons/ (node tools/make-icons.js)
tools/serve.js      local dev server (node tools/serve.js)
```

Data lives under the `cubcave.data.v1` localStorage key until Phase 3 moves it
to Google Drive. All reads and writes go through `js/store.js`, so that swap
only touches `readRaw`/`writeRaw` there.

**Note:** after changing any shell file, bump `CACHE_VERSION` in `sw.js` —
otherwise the service worker keeps serving the old cached copies.

## Running locally

Service workers need `http://localhost`, not `file://`:

```bash
node tools/serve.js
```

Then open http://localhost:5173.

## Build phases

1. ✅ Scaffolding — PWA shell, manifest, service worker, GitHub Pages
2. ✅ Core UI, local state
3. ⬜ Google Drive storage (`drive.appdata`)
4. ⬜ Push notifications (FCM, client side)
5. ⬜ Daily release check (Cloud Function + Cloud Scheduler)
6. ⬜ Recommendations (Gemini, one-shot, via Cloud Function)
7. ⬜ Polish, docs, end-to-end test
