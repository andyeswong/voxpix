import { deflateSync } from 'node:zlib';

// PNG RGBA de 8 bits, sin filtro y con compresión fija: mismos píxeles, mismos bytes.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePNG(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array, scale = 1): Uint8Array {
  const W = width * scale, H = height * scale;
  const raw = new Uint8Array(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    const row = y * (W * 4 + 1);
    raw[row] = 0;
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const s = (sy * width + Math.floor(x / scale)) * 4, d = row + 1 + x * 4;
      raw[d] = rgba[s]!; raw[d + 1] = rgba[s + 1]!; raw[d + 2] = rgba[s + 2]!; raw[d + 3] = rgba[s + 3]!;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Pone una imagen RGBA sobre un fondo opaco (para mirarla)
export function onBackground(rgba: Uint8ClampedArray, bg: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < rgba.length; p += 4) {
    const opaque = rgba[p + 3]! > 0;
    out[p] = opaque ? rgba[p]! : bg[0]; out[p + 1] = opaque ? rgba[p + 1]! : bg[1]; out[p + 2] = opaque ? rgba[p + 2]! : bg[2]; out[p + 3] = 255;
  }
  return out;
}
