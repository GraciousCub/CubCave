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
  driveFileName: 'cubcave-data.json'
};
