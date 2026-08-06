# The Cub Cave — Personal Comic Tracker

A single-user PWA for tracking comic reading progress, with release-day push
notifications. Static site, no build step, hosted on GitHub Pages.

**Status: Phase 1 (app shell).** Full usage docs land in Phase 7.

## Layout

```
index.html          app shell
manifest.json       PWA manifest
sw.js               service worker (shell caching; push added in Phase 4)
css/styles.css
js/app.js
icons/              generated PNGs — do not edit by hand
tools/make-icons.js regenerates icons/ (node tools/make-icons.js)
```

## Running locally

Service workers need `http://localhost`, not `file://`:

```bash
npx serve .
```

Then open the printed `http://localhost:...` URL.

## Build phases

1. ✅ Scaffolding — PWA shell, manifest, service worker, GitHub Pages
2. ⬜ Core UI, local state
3. ⬜ Google Drive storage (`drive.appdata`)
4. ⬜ Push notifications (FCM, client side)
5. ⬜ Daily release check (Cloud Function + Cloud Scheduler)
6. ⬜ Recommendations (Gemini, one-shot, via Cloud Function)
7. ⬜ Polish, docs, end-to-end test
