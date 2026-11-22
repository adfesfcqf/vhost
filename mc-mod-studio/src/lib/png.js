// Encodeur PNG minimal (RGBA 8 bits) pour générer les textures de départ.
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** pixels: Uint8Array de taille w*h*4 (RGBA) */
function encodePNG(w, h, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Texture 16x16 de départ, couleur dérivée du nom.
 * kind: 'block' (plein, texturé), 'item' (gemme), 'tool' (épée/pioche simplifiée), 'food' (rond)
 */
function placeholderTexture(name, kind = 'item') {
  const W = 16;
  const px = new Uint8Array(W * W * 4);
  let seed = hashString(name);
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const hue = hashString(name) % 360;
  const set = (x, y, rgb, a = 255) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a;
  };
  const shade = (l) => hsl(hue, 0.55, l);

  if (kind === 'block') {
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) set(x, y, shade(0.38 + rnd() * 0.18));
    for (let i = 0; i < W; i++) { set(i, 0, shade(0.6)); set(0, i, shade(0.6)); set(i, 15, shade(0.25)); set(15, i, shade(0.25)); }
  } else if (kind === 'tool') {
    const handle = [120, 85, 50];
    for (let i = 0; i < 6; i++) set(2 + i, 13 - i, handle);
    for (let i = 0; i < 8; i++) { set(7 + i, 8 - i, shade(0.55)); set(8 + i, 8 - i, shade(0.4)); }
    set(5, 9, shade(0.3)); set(6, 10, shade(0.3)); set(4, 10, shade(0.3)); set(6, 8, shade(0.3));
  } else if (kind === 'food') {
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 7.5, y - 8.5);
      if (d < 6) set(x, y, shade(0.45 + (6 - d) * 0.04 - (x + y > 18 ? 0.08 : 0)));
      else if (d < 7) set(x, y, shade(0.22));
    }
    set(8, 1, [60, 130, 40]); set(8, 2, [60, 130, 40]); set(9, 1, [80, 160, 50]);
  } else {
    // gemme en losange
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
      if (d < 6) set(x, y, shade(0.4 + (x < 8 && y < 8 ? 0.2 : 0) + rnd() * 0.06));
      else if (d < 7) set(x, y, shade(0.2));
    }
    set(5, 5, [255, 255, 255]); set(6, 5, [230, 230, 230]);
  }
  return encodePNG(W, W, px);
}

module.exports = { encodePNG, placeholderTexture };
