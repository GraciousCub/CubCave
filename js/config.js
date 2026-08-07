/* The Cub Cave — configuration.
 *
 * FILL THIS IN after creating your OAuth Client ID (see README, Phase 3).
 *
 * The Client ID is NOT a secret. OAuth clients for browser apps are public by
 * design — there is no client secret involved, and Google restricts the ID to
 * the "Authorised JavaScript origins" you list in the Cloud console. Someone
 * copying it cannot use it from their own site. It is safe to commit.
 *
 * Never put an API key or client secret in this file. Anything here ships to
 * the browser and is readable by anyone. The Gemini key in Phase 6 stays
 * server-side in a Cloud Function for exactly this reason.
 */

'use strict';

var CubCave = window.CubCave || (window.CubCave = {});

CubCave.config = {
  googleClientId: '1009364728296-1at2tingike66r7bvqqok6qul5tiv685.apps.googleusercontent.com',

  // Name of the JSON file inside the app's private Drive folder.
  driveFileName: 'cubcave-data.json',

  /* Firebase Cloud Messaging (Phase 4) — fill in from the Firebase console.
   *
   * These are all public identifiers, not secrets. A Firebase "apiKey" is a
   * project identifier used to route requests; it grants nothing on its own.
   * The VAPID key below is the PUBLIC half of the web-push key pair — the
   * private half stays in the Firebase console and is never shipped here. */
  firebase: {
    apiKey: 'AIzaSyAQr66KatmAi2hwbjKI7NAwtEHdRf-r9h8',
    authDomain: 'cubcave.firebaseapp.com',
    projectId: 'cubcave',
    messagingSenderId: '1009364728296',
    appId: '1:1009364728296:web:299e1a6785159a97578c5d'
  },

  // Firebase console → Project settings → Cloud Messaging → Web Push certificates
  vapidKey: 'BB1zgwDKyVSbHp14byoeaJQZfp-yotS6aQbnPn8Am-OCquzmbtT9g9OWAOBgKqnOMuMDI5IidAa9Hcxn3SBa7PM',

  // Firebase JS SDK version pulled from the CDN when notifications are enabled.
  firebaseSdkVersion: '10.12.2',

  /* Comic search (Phase 6). The URL of the deployed comic-search function —
   * fill in after deploying. Comic Vine sends no CORS headers and needs an API
   * key, so the browser cannot call it directly; this proxies it and keeps the
   * key server-side. */
  searchEndpoint: 'https://comic-search-osxiyvcxpq-nw.a.run.app'
};
