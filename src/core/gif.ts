// GIF animado mínimo (GIF89a, una paleta global de hasta 256 colores, LZW, en bucle). Para láminas de revisión:
// los sprites tienen pocos colores, así que no hace falta cuantizar; si hay más de 256, falla.
export function encodeGIF(width: number, height: number, frames: Uint8ClampedArray[], delayMs: number, scale = 1): Uint8Array {
  const W = width * scale, H = height * scale;
  // Paleta: índice 0 = transparente
  const index = new Map<number, number>();
  const pal: number[] = [0, 0, 0];
  const idx = frames.map((rgba) => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
      if (!rgba[s + 3]) continue;
      const c = (rgba[s]! << 16) | (rgba[s + 1]! << 8) | rgba[s + 2]!;
      let i = index.get(c);
      if (i === undefined) {
        i = index.size + 1;
        if (i > 255) throw new Error('más de 255 colores');
        index.set(c, i);
        pal.push(rgba[s]!, rgba[s + 1]!, rgba[s + 2]!);
      }
      out[y * W + x] = i;
    }
    return out;
  });
  let bits = 1;
  while (1 << bits < pal.length / 3) bits++;
  while (pal.length < (1 << bits) * 3) pal.push(0);
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  bytes.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(W); u16(H);
  bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0, ...pal);
  // Bucle infinito
  bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  for (const f of idx) {
    // Control: retardo en centésimas, transparente = 0, cada cuadro se borra al fondo
    bytes.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(Math.round(delayMs / 10)); bytes.push(0, 0);
    bytes.push(0x2c); u16(0); u16(0); u16(W); u16(H); bytes.push(0);
    const min = Math.max(2, bits);
    bytes.push(min);
    const data = lzw(f, min);
    for (let o = 0; o < data.length; o += 255) { const n = Math.min(255, data.length - o); bytes.push(n, ...data.subarray(o, o + n)); }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function lzw(px: Uint8Array, minBits: number): Uint8Array {
  const clear = 1 << minBits, end = clear + 1;
  const out: number[] = [];
  let cur = 0, nbits = 0, size = minBits + 1;
  const emit = (code: number) => {
    cur |= code << nbits; nbits += size;
    while (nbits >= 8) { out.push(cur & 255); cur >>= 8; nbits -= 8; }
  };
  let dict = new Map<string, number>(), next = end + 1;
  emit(clear);
  let w = String(px[0]);
  for (let i = 1; i < px.length; i++) {
    const k = String(px[i]), wk = `${w},${k}`;
    if (dict.has(wk)) { w = wk; continue; }
    emit(w.includes(',') ? dict.get(w)! : Number(w));
    if (next < 4096) {
      dict.set(wk, next++);
      if (next > 1 << size && size < 12) size++;
    } else { emit(clear); dict = new Map(); next = end + 1; size = minBits + 1; }
    w = k;
  }
  emit(w.includes(',') ? dict.get(w)! : Number(w));
  emit(end);
  if (nbits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}
