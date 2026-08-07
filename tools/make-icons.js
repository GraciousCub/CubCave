/* Generates the PWA icon set from icons/source.png.
 *
 *   node tools/make-icons.js
 *
 * Dependency-free: decodes the source PNG, box-downsamples it, and re-encodes.
 * Only 8-bit RGBA, non-interlaced PNGs are supported — that's what the source
 * is, and handling every PNG variant isn't worth the code here. It fails with
 * a clear message rather than producing something subtly wrong.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var SOURCE = path.join(__dirname, '..', 'icons', 'source.png');
var OUT_DIR = path.join(__dirname, '..', 'icons');

/* Matches the app background, so icons that composite onto a solid colour
   sit on the same dark as the app itself. */
var BACKDROP = [15, 18, 24, 255];

/* ---------- PNG decode ---------- */

function decodePNG(buffer) {
  if (buffer.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Not a PNG file.');
  }

  var width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  var idat = [];
  var offset = 8;

  while (offset < buffer.length) {
    var length = buffer.readUInt32BE(offset);
    var type = buffer.toString('ascii', offset + 4, offset + 8);
    var data = buffer.slice(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;   // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      'Only 8-bit RGBA, non-interlaced PNGs are supported ' +
      '(got bitDepth=' + bitDepth + ', colorType=' + colorType +
      ', interlace=' + interlace + '). Re-export the source as RGBA PNG.'
    );
  }

  var raw = zlib.inflateSync(Buffer.concat(idat));
  var bpp = 4;
  var stride = width * bpp;
  var out = Buffer.alloc(stride * height);

  /* Undo the per-scanline filters. Each row is prefixed with a filter byte;
     types 1-4 predict each byte from its left/up/upper-left neighbours. */
  for (var y = 0; y < height; y++) {
    var filter = raw[y * (stride + 1)];
    var line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    var prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    var row = out.slice(y * stride, (y + 1) * stride);

    for (var x = 0; x < stride; x++) {
      var value = line[x];
      var a = x >= bpp ? row[x - bpp] : 0;   // left
      var b = prev[x];                        // up
      var c = x >= bpp ? prev[x - bpp] : 0;   // upper-left

      switch (filter) {
        case 0: row[x] = value; break;
        case 1: row[x] = (value + a) & 0xff; break;
        case 2: row[x] = (value + b) & 0xff; break;
        case 3: row[x] = (value + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          var p = a + b - c;
          var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          var pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          row[x] = (value + pred) & 0xff;
          break;
        }
        default: throw new Error('Unknown PNG filter type ' + filter);
      }
    }
  }

  return { width: width, height: height, data: out };
}

/* ---------- PNG encode ---------- */

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
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- resize ---------- */

/* Box filter: averages every source pixel falling inside each destination
   pixel. For big downscales that beats nearest-neighbour comfortably, and
   alpha is weighted so transparent edges don't darken. */
function resize(src, size) {
  var out = Buffer.alloc(size * size * 4);
  var scale = src.width / size;

  for (var y = 0; y < size; y++) {
    var sy0 = Math.floor(y * scale);
    var sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.ceil((y + 1) * scale)));

    for (var x = 0; x < size; x++) {
      var sx0 = Math.floor(x * scale);
      var sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.ceil((x + 1) * scale)));

      var r = 0, g = 0, b = 0, a = 0, n = 0;
      for (var sy = sy0; sy < sy1; sy++) {
        for (var sx = sx0; sx < sx1; sx++) {
          var i = (sy * src.width + sx) * 4;
          var alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += src.data[i + 3];
          n++;
        }
      }

      var o = (y * size + x) * 4;
      var alphaAvg = a / n;
      var weight = alphaAvg / 255;
      out[o] = weight ? Math.round(r / n / weight) : 0;
      out[o + 1] = weight ? Math.round(g / n / weight) : 0;
      out[o + 2] = weight ? Math.round(b / n / weight) : 0;
      out[o + 3] = Math.round(alphaAvg);
    }
  }

  return { width: size, height: size, data: out };
}

/* Places an image on a solid background, optionally inset. Maskable icons
   need the inset: launchers crop them to a circle and anything in the outer
   ~10% can be cut off. */
function compose(image, size, inset, background) {
  var canvas = Buffer.alloc(size * size * 4);
  for (var i = 0; i < size * size; i++) {
    canvas[i * 4] = background[0];
    canvas[i * 4 + 1] = background[1];
    canvas[i * 4 + 2] = background[2];
    canvas[i * 4 + 3] = background[3];
  }

  var inner = Math.round(size * (1 - inset * 2));
  var scaled = resize(image, inner);
  var offset = Math.round((size - inner) / 2);

  for (var y = 0; y < inner; y++) {
    for (var x = 0; x < inner; x++) {
      var s = (y * inner + x) * 4;
      var alpha = scaled.data[s + 3] / 255;
      if (!alpha) continue;
      var d = ((y + offset) * size + (x + offset)) * 4;
      canvas[d] = Math.round(canvas[d] * (1 - alpha) + scaled.data[s] * alpha);
      canvas[d + 1] = Math.round(canvas[d + 1] * (1 - alpha) + scaled.data[s + 1] * alpha);
      canvas[d + 2] = Math.round(canvas[d + 2] * (1 - alpha) + scaled.data[s + 2] * alpha);
      canvas[d + 3] = 255;
    }
  }

  return { width: size, height: size, data: canvas };
}

/* ---------- go ---------- */

if (!fs.existsSync(SOURCE)) {
  console.error('Missing icons/source.png — put the artwork there first.');
  process.exit(1);
}

var source = decodePNG(fs.readFileSync(SOURCE));
console.log('source: ' + source.width + 'x' + source.height);

/* If the artwork already has its own opaque background, extend THAT rather
   than the app's colour — otherwise the inset maskable icon shows a visible
   square where one dark meets the other. */
if (source.data[3] === 255) {
  BACKDROP = [source.data[0], source.data[1], source.data[2], 255];
  console.log('backdrop taken from the artwork: rgb(' + BACKDROP.slice(0, 3).join(',') + ')');
}

var targets = [
  // name, size, inset, background (null keeps transparency)
  ['icon-192.png', 192, 0, null],
  ['icon-512.png', 512, 0, null],
  // Cropped to a circle by Android launchers, so keep clear of the edges.
  ['icon-maskable-512.png', 512, 0.14, BACKDROP],
  // iOS ignores transparency and composites on black, so do it deliberately.
  ['apple-touch-icon-180.png', 180, 0, BACKDROP],
  ['favicon-32.png', 32, 0, null]
];

targets.forEach(function (t) {
  var name = t[0], size = t[1], inset = t[2], background = t[3];
  var image = background ? compose(source, size, inset, background) : resize(source, size);
  fs.writeFileSync(path.join(OUT_DIR, name), encodePNG(size, size, image.data));
  console.log('wrote icons/' + name + '  (' + size + 'px' +
              (background ? ', on backdrop' : ', transparent') + ')');
});
