// Ayudas para modelar en vóxeles dentro de un .px.js (el global `vox` cuando lo carga VoxPix, ver loadPxl). Un mapa de
// vóxeles es un Map de "x,y,z" a la tecla de color de pxl, en los ejes del modelo: x al este, y al norte, z arriba,
// con el origen donde va el pivote (el agarre de un arma, los pies de un personaje).
//
//   vox.set(m, x, y, z, k) / vox.get(m, x, y, z)       poner y leer un vóxel
//   vox.shift(m, dx, dy, dz)                           mover (un mapa nuevo)
//   vox.rotate(m, deg, { axis: 'z', about: [0,0,0] })  girar alrededor de un eje, con muestreo inverso (sin agujeros)
//   vox.recolor(m, { a: 'b' } | (k) => k)              cambiar teclas
//   vox.toneUp(m, ['cCI', 'pPQ'], n = 1)               subir n tonos dentro de sus rampas (sin pasar del último)
//   vox.merge(a, b, ...)                               unir (lo de los últimos manda)
//   vox.bounds(m)                                      { minX, maxX, minY, maxY, minZ, maxZ } o null
//   vox.layers(prefix, m, { w, h })                    las capas <prefijo>_zNN que lee import-pxl --stack, con su z de
//                                                      verdad (negativa: _z-01), así el origen del mapa es el del modelo.
//                                                      Sin w/h, el lienzo impar más pequeño que lo contiene entero.
//
// Fuera de VoxPix (pxl build a secas) el global no existe: estas fuentes son para importar.

export type VoxMap = Map<string, string>;
export interface VoxBounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

const k3 = (x: number, y: number, z: number) => `${x},${y},${z}`;
function parse(key: string): [number, number, number] {
  const [x, y, z] = key.split(',').map(Number);
  return [x!, y!, z!];
}

export function stackLayerName(prefix: string, z: number): string {
  return `${prefix}_z${z < 0 ? '-' : ''}${String(Math.abs(z)).padStart(2, '0')}`;
}

export function voxHelpers(sprite: (name: string, opts: { w: number; h: number }, draw: (c: { px(x: number, y: number, k: string): void }) => void) => void) {
  const bounds = (m: VoxMap): VoxBounds | null => {
    let b: VoxBounds | null = null;
    for (const key of m.keys()) {
      const [x, y, z] = parse(key);
      if (!b) b = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
      else {
        b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
        b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
        b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
      }
    }
    return b;
  };
  return {
    set(m: VoxMap, x: number, y: number, z: number, k: string): VoxMap { m.set(k3(x, y, z), k); return m; },
    get(m: VoxMap, x: number, y: number, z: number): string | undefined { return m.get(k3(x, y, z)); },
    bounds,
    shift(m: VoxMap, dx = 0, dy = 0, dz = 0): VoxMap {
      const out: VoxMap = new Map();
      for (const [key, k] of m) { const [x, y, z] = parse(key); out.set(k3(x + dx, y + dy, z + dz), k); }
      return out;
    },
    rotate(m: VoxMap, deg: number, opts: { axis?: 'x' | 'y' | 'z'; about?: [number, number, number] } = {}): VoxMap {
      const axis = opts.axis ?? 'z', [ax, ay, az] = opts.about ?? [0, 0, 0];
      const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
      // Los dos ejes del plano de giro (en sentido antihorario mirando desde la punta del eje)
      const plane = axis === 'z' ? [0, 1] : axis === 'x' ? [1, 2] : [2, 0];
      const [i, j] = plane as [number, number];
      const piv = [ax, ay, az];
      let R = 0;
      for (const key of m.keys()) { const p = parse(key); R = Math.max(R, Math.ceil(Math.hypot(p[i]! - piv[i]!, p[j]! - piv[j]!)) + 1); }
      const b = bounds(m);
      if (!b) return new Map();
      const lo = [b.minX, b.minY, b.minZ], hi = [b.maxX, b.maxY, b.maxZ];
      const out: VoxMap = new Map();
      const d = [0, 0, 0];
      // Cada celda de destino toma la de origen girada al revés (no quedan agujeros)
      for (let a = -R; a <= R; a++) for (let bb = -R; bb <= R; bb++) for (let t = lo[3 - i - j]!; t <= hi[3 - i - j]!; t++) {
        const si = Math.round(a * c + bb * s), sj = Math.round(-a * s + bb * c);
        d[i] = piv[i]! + si; d[j] = piv[j]! + sj; d[3 - i - j] = t;
        const k = m.get(k3(d[0]!, d[1]!, d[2]!));
        if (k === undefined) continue;
        d[i] = piv[i]! + a; d[j] = piv[j]! + bb;
        out.set(k3(d[0]!, d[1]!, d[2]!), k);
      }
      return out;
    },
    recolor(m: VoxMap, to: Record<string, string> | ((k: string) => string)): VoxMap {
      const f = typeof to === 'function' ? to : (k: string) => to[k] ?? k;
      const out: VoxMap = new Map();
      for (const [key, k] of m) out.set(key, f(k));
      return out;
    },
    toneUp(m: VoxMap, ramps: string[], n = 1): VoxMap {
      const out: VoxMap = new Map();
      for (const [key, k] of m) {
        const r = ramps.find((r) => r.includes(k));
        out.set(key, r ? r[Math.min(r.length - 1, r.indexOf(k) + n)]! : k);
      }
      return out;
    },
    merge(...maps: VoxMap[]): VoxMap {
      const out: VoxMap = new Map();
      for (const m of maps) for (const [key, k] of m) out.set(key, k);
      return out;
    },
    layers(prefix: string, m: VoxMap, opts: { w?: number; h?: number } = {}): string[] {
      const b = bounds(m);
      if (!b) return [];
      const halfX = Math.max(-b.minX, b.maxX, 0), halfY = Math.max(-b.minY, b.maxY, 0);
      const w = opts.w ?? 2 * halfX + 1, h = opts.h ?? 2 * halfY + 1;
      const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
      const names: string[] = [];
      for (let z = b.minZ; z <= b.maxZ; z++) {
        const name = stackLayerName(prefix, z);
        names.push(name);
        sprite(name, { w, h }, (c) => {
          for (const [key, k] of m) { const [x, y, zz] = parse(key); if (zz === z) c.px(x + cx, cy - y, k); }
        });
      }
      return names;
    },
  };
}
