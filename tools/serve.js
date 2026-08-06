/* Minimal static file server for local testing. Node built-ins only.
 *
 *   node tools/serve.js          -> http://localhost:5173
 *   node tools/serve.js 8080     -> http://localhost:8080
 *
 * Service workers only run over http://localhost or https://, so this is
 * required for testing — opening index.html as a file:// URL will not work.
 *
 * To test from a phone on the same Wi-Fi, use this machine's LAN IP. Note that
 * iOS will not install a PWA over plain http from a LAN IP; for on-device
 * install testing, use the deployed GitHub Pages URL instead.
 */

'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = path.join(__dirname, '..');
var PORT = parseInt(process.argv[2], 10) || 5173;

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

http.createServer(function (req, res) {
  var pathname = decodeURIComponent(url.parse(req.url).pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT only — no path traversal out of the project folder.
  var filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // No caching in dev, so edits show up on reload without a hard refresh.
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, function () {
  console.log('The Cub Cave dev server: http://localhost:' + PORT);
});
