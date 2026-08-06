/* Generates the PWA icon set. Dependency-free: raw pixels -> PNG via zlib.
 *
 *   node tools/make-icons.js
 *
 * Re-run after changing the palette or artwork below.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

/* ---------- minimal PNG encoder ---------- */

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  var stride = width * 4;
  var raw = Buffer.alloc((stride + 1) * height);
  for (var y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- tiny drawing surface (with 3x supersampling for smooth edges) ---------- */

var SS = 3;

function Surface(size) {
  this.size = size * SS;
  this.scale = SS;
  this.px = Buffer.alloc(this.size * this.size * 4);
}

Surface.prototype.blend = function (x, y, color) {
  if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
  var i = (y * this.size + x) * 4;
  var a = color[3] / 255;
  this.px[i]     = Math.round(this.px[i]     * (1 - a) + color[0] * a);
  this.px[i + 1] = Math.round(this.px[i + 1] * (1 - a) + color[1] * a);
  this.px[i + 2] = Math.round(this.px[i + 2] * (1 - a) + color[2] * a);
  this.px[i + 3] = Math.round(this.px[i + 3] + (255 - this.px[i + 3]) * a);
};

// x, y, w, h, r are in unscaled units.
Surface.prototype.roundRect = function (x, y, w, h, r, color) {
  var s = this.scale;
  var x0 = Math.round(x * s), y0 = Math.round(y * s);
  var x1 = Math.round((x + w) * s), y1 = Math.round((y + h) * s);
  var rr = r * s;

  for (var py = y0; py < y1; py++) {
    for (var px = x0; px < x1; px++) {
      // Distance into the corner boxes, if any.
      var dx = px < x0 + rr ? x0 + rr - px : (px > x1 - rr - 1 ? px - (x1 - rr - 1) : 0);
      var dy = py < y0 + rr ? y0 + rr - py : (py > y1 - rr - 1 ? py - (y1 - rr - 1) : 0);
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > rr * rr) continue;
      this.blend(px, py, color);
    }
  }
};

Surface.prototype.fill = function (color) {
  this.roundRect(0, 0, this.size / this.scale, this.size / this.scale, 0, color);
};

// Box-downsample back to the requested size.
Surface.prototype.toPNG = function () {
  var out = this.size / this.scale;
  var buf = Buffer.alloc(out * out * 4);
  var n = this.scale * this.scale;

  for (var y = 0; y < out; y++) {
    for (var x = 0; x < out; x++) {
      var r = 0, g = 0, b = 0, a = 0;
      for (var sy = 0; sy < this.scale; sy++) {
        for (var sx = 0; sx < this.scale; sx++) {
          var i = ((y * this.scale + sy) * this.size + (x * this.scale + sx)) * 4;
          r += this.px[i]; g += this.px[i + 1]; b += this.px[i + 2]; a += this.px[i + 3];
        }
      }
      var o = (y * out + x) * 4;
      buf[o] = Math.round(r / n);
      buf[o + 1] = Math.round(g / n);
      buf[o + 2] = Math.round(b / n);
      buf[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(out, out, buf);
};

/* ---------- artwork: a stack of three comic issues ---------- */

var BG      = [15, 18, 24, 255];
var PAPER   = [231, 234, 240, 255];
var SPINE_A = [242, 193, 78, 255];   // gold
var SPINE_B = [78, 168, 222, 255];   // blue
var SPINE_C = [224, 82, 99, 255];    // red
var INK     = [15, 18, 24, 60];

/* `inset` is the fraction of the canvas left as padding around the artwork.
   Maskable icons need a bigger margin because launchers crop to a circle. */
function draw(size, inset) {
  var s = new Surface(size);
  s.fill(BG);

  var art = size * (1 - inset * 2);
  var ox = size * inset;
  var oy = size * inset;

  var bookW = art;
  var bookH = art * 0.235;
  var gap = art * 0.13;
  var radius = bookH * 0.22;
  var spines = [SPINE_A, SPINE_B, SPINE_C];

  for (var i = 0; i < 3; i++) {
    // Slight stair-step so the stack reads as separate issues.
    var x = ox + (i * art * 0.055);
    var y = oy + art * 0.075 + i * (bookH + gap);
    var w = bookW - (i * art * 0.055);

    s.roundRect(x, y, w, bookH, radius, PAPER);
    s.roundRect(x, y, w * 0.17, bookH, radius, spines[i]);

    // Two hint lines standing in for cover text.
    var lineX = x + w * 0.26;
    s.roundRect(lineX, y + bookH * 0.3,  w * 0.5,  bookH * 0.12, bookH * 0.06, INK);
    s.roundRect(lineX, y + bookH * 0.56, w * 0.33, bookH * 0.12, bookH * 0.06, INK);
  }

  return s.toPNG();
}

/* ---------- write files ---------- */

var outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

var targets = [
  ['icon-192.png',           192, 0.14],
  ['icon-512.png',           512, 0.14],
  ['icon-maskable-512.png',  512, 0.24],  // wider safe zone for adaptive cropping
  ['apple-touch-icon-180.png', 180, 0.14],
  ['favicon-32.png',          32, 0.10]
];

targets.forEach(function (t) {
  var file = path.join(outDir, t[0]);
  fs.writeFileSync(file, draw(t[1], t[2]));
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
});
