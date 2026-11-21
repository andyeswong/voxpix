// La ventana viva, 2 (bake.ts, shiftBaked): correr la ventana horneada (vóxeles e imagen, con las luces fijas en su sitio
// nuevo) y rehornear lo que entra da lo mismo que hornear de nuevo la ventana en ese sitio: la imagen, la profundidad
// (a 1e-3: se corrige restando), la cara, el vóxel de cada píxel, el cielo y los pesos de cada luz. Con dos
// corrimientos de signo contrario incluidos (el vóxel de cada píxel sigue bien: las claves son lineales)
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, type RegionSpec } from '../src/world/regiongen';

const B = 8, ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'tronco', 'hojas', 'flor'];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${(30 + i * 20).toString(16)}2020`, `#${(40 + i * 20).toString(16)}3030`] })) };
const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, (x + y + z) % 2)]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 't', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: id === 'flor' ? [[3, 3, 0, material(i, 0)], [3, 3, 1, material(i, 1)]] : cube(i), ...(id === 'hierba' ? { props: { covered: 'tierra' } } : {}) })) } as unknown as VoxsetFile);
const T = (id: string) => set.index(id);
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) leaves.push([dx, dy, 4, T('hojas')]);
const H = 8;
const SPEC: RegionSpec = {
  seed: 5, width: 48, depth: 48, height: H,
  surface: { base: 4, amplitude: 2, scale: 6 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 1 }, { material: T('piedra') }],
  seaLevel: 3, water: T('agua'), shore: { material: T('arena') },
  veins: [{ material: T('carbon'), in: [T('piedra')], z: [0, 3], density: 0.1, size: [2, 4] }],
  caves: { count: 6, z: [1, 3], length: [8, 16], radius: [1, 1.5] },
  scatter: [
    { on: [T('hierba')], density: 0.05, spacing: 3, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves] },
    { on: [T('hierba')], density: 0.1, structure: [[0, 0, 1, T('flor')]] },
  ],
};
const TB = 4, TV = TB * B;                       // un trozo: 4 x 4 bloques = 32 x 32 vóxeles (2 x 2 trozos de vóxeles)
const T0 = -3, NT = 6;                           // el mundo fijo: los trozos -3..2 en x y en y
import { bakeWorld, shiftBaked, shiftBakedJob, rebakeChanged, rebakeChangedJobs, rebakeJobs, exposureFaults, type Baked } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';
import { unkey } from '../src/core';

const N = 3, WV = N * TV, ZT = H * B - 1;
const stamp = (s: StaticVoxels, tx: number, ty: number, ltx: number, lty: number) =>
  new BlockGrid(new WorldState(s, [], null), set).stampRegion(generateRegion(SPEC, { x0: tx * TB, y0: ty * TB, z0: 0, width: TB, depth: TB, height: H }), [ltx * TB, lty * TB, 0]);
// Antorchas fijas por el mundo (coordenadas del mundo), en el aire sobre el relieve
const LIGHTS: WorldLight[] = [];
for (let k = 0; k < 14; k++) LIGHTS.push({ id: `t${k}`, kind: 'torch', x: -100 + ((k * 53) % 220) + 0.5, y: -100 + ((k * 37) % 220) + 0.5, z: 44 + (k % 3) * 4, baked: true });
const local = (tx0: number, ty0: number): WorldLight[] => LIGHTS.filter((l) => l.x >= tx0 * TV && l.x < (tx0 + N) * TV && l.y >= ty0 * TV && l.y < (ty0 + N) * TV)
  .map((l) => ({ ...l, x: l.x - tx0 * TV, y: l.y - ty0 * TV }));
const OPTS = { topZ: ZT + 1, incline: 0.5, sky: true, outline: 'both' as const };
// (dig: un hueco en coordenadas del mundo, x0..x1 y0..y1 z0..z1)
type Box = [number, number, number, number, number, number];
const dig = (s: StaticVoxels, tx0: number, ty0: number, [x0, y0, z0, x1, y1, z1]: Box) => {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const lx = x - tx0 * TV, ly = y - ty0 * TV;
    if (lx >= 0 && ly >= 0 && lx < WV && ly < WV) s.set(lx, ly, z, 0);
  }
};
const fresh = (tx0: number, ty0: number, holes: Box[] = []): Baked => {
  const s = new StaticVoxels(pal, WV, WV, 0, ZT);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) stamp(s, tx0 + i, ty0 + j, i, j);
  for (const h of holes) dig(s, tx0, ty0, h);
  return bakeWorld({ model: s, lights: local(tx0, ty0), width: WV, depth: WV }, OPTS);
};
// Las diferencias entre dos horneados (0 en todo si son iguales)
const diff = (b: Baked, r: Baked) => {
  let rgba = 0, face = 0, pick = 0, sky = 0, depth = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    for (let c = 0; c < 4; c++) if (b.rgba[i * 4 + c] !== r.rgba[i * 4 + c]) { rgba++; break; }
    if (b.face[i] !== r.face[i]) face++;
    if (!(b.pick[i] === r.pick[i] || (Number.isNaN(b.pick[i]!) && Number.isNaN(r.pick[i]!)))) pick++;
    if (b.sky![i] !== r.sky![i]) sky++;
    if (!(b.depth[i] === r.depth[i] || Math.abs(b.depth[i]! - r.depth[i]!) <= 1e-3)) depth++;
  }
  return { rgba, face, pick, sky, depth };
};
const K = TV / 16;                                // trozos de vóxeles por trozo del mundo

describe('ventana viva: correr lo horneado', () => {
  it('correr y rehornear lo que entra = hornear de nuevo ahí (con luces a los dos lados del borde)', () => {
    let tx0 = 0, ty0 = 0;
    const b = fresh(tx0, ty0);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, -1], [0, -1], [1, 1]] as const) {
      shiftBaked(b, dx * K, dy * K);
      const nx = tx0 + dx, ny = ty0 + dy;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const tx = nx + i, ty = ny + j;
        if (tx >= tx0 && tx < tx0 + N && ty >= ty0 && ty < ty0 + N) continue;
        stamp(b.source, tx, ty, i, j);
      }
      tx0 = nx; ty0 = ny;
      rebakeChanged(b, local(tx0, ty0));
      const r = fresh(tx0, ty0), at = `${tx0},${ty0}`;
      let rgba = 0, face = 0, pick = 0, sky = 0, depth = 0;
      for (let i = 0; i < r.width * r.height; i++) {
        for (let c = 0; c < 4; c++) if (b.rgba[i * 4 + c] !== r.rgba[i * 4 + c]) { rgba++; break; }
        if (b.face[i] !== r.face[i]) face++;
        if (!(b.pick[i] === r.pick[i] || (Number.isNaN(b.pick[i]!) && Number.isNaN(r.pick[i]!)))) pick++;
        if (b.sky![i] !== r.sky![i]) sky++;
        if (!(b.depth[i] === r.depth[i] || Math.abs(b.depth[i]! - r.depth[i]!) <= 1e-3)) depth++;
      }
      expect({ at, rgba, face, pick, sky, depth }).toEqual({ at, rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
      // Las luces: las mismas, con la misma zona y los mismos pesos
      const byId = (x: Baked) => new Map(x.lights.map((l) => [l.light.id, l]));
      const lb = byId(b), lr = byId(r);
      expect([...lb.keys()].sort()).toEqual([...lr.keys()].sort());
      for (const [id, z] of lr) {
        const y = lb.get(id)!;
        expect({ id, rect: y.rect }).toEqual({ id, rect: z.rect });
        let off = 0;
        for (let i = 0; i < z.weight.length; i++) if (Math.abs(y.weight[i]! - z.weight[i]!) > 1e-6) off++;
        expect({ id, at, off }).toEqual({ id, at, off: 0 });
      }
      // Un píxel con vóxel: su clave es la del vóxel que se ve, en las coordenadas de ahora
      const i = r.pick.findIndex((k) => !Number.isNaN(k));
      expect(unkey(b.pick[i]!)).toEqual(unkey(r.pick[i]!));
    }
  });

  it('por pasos: con un rehorneado en la imagen vieja a mitad de la copia y otro borde cruzado antes de acabar (se suman)', () => {
    const b = fresh(0, 0);
    const job = shiftBakedJob(b, K, 0, { band: 8 });
    for (let k = 0; k < 4; k++) expect(job.run(-Infinity)).toBe(false);        // un paso por llamada (sin plazo)
    // Picar en el mundo de antes de correr (en la imagen vieja) y rehornearlo
    const hole: Box = [40, 30, 20, 55, 45, 63];
    dig(b.source, 0, 0, hole);
    rebakeChanged(b, local(0, 0));
    // Otro borde: hacia el norte también
    job.merge(0, K);
    expect(job.shift).toEqual([K, K]);
    let steps = 0;
    while (!job.run(-Infinity)) steps++;
    expect(steps).toBeGreaterThan(5);
    expect(job.done).toBe(true);
    // Lo que entra (la ventana está ahora en el trozo 1, 1)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (i === N - 1 || j === N - 1) stamp(b.source, 1 + i, 1 + j, i, j);
    rebakeChanged(b, local(1, 1));
    expect(diff(b, fresh(1, 1, [hole]))).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
  });

  it('manual: preparado del todo, un rehorneado publicado mientras espera el cambio se recopia (solo sus columnas) y da lo mismo', () => {
    const b = fresh(0, 0);
    const job = shiftBakedJob(b, K, 0, { band: 8, manual: true });
    while (!job.run(-Infinity));
    expect(job.prepared).toBe(true);
    // Picar y rehornear en la imagen vieja, ya preparado: lo recopia la llamada siguiente (no el cambio)
    const hole: Box = [40, 30, 20, 55, 45, 63];
    dig(b.source, 0, 0, hole);
    rebakeChanged(b, local(0, 0));
    expect(job.run(-Infinity)).toBe(true);
    expect(job.canCommit()).toBe(true);
    job.commit();
    expect(job.done).toBe(true);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (i === N - 1) stamp(b.source, 1 + i, j, i, j);
    rebakeChanged(b, local(1, 0));
    expect(diff(b, fresh(1, 0, [hole]))).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
  });

  it('lo expuesto (exposureJob) a medias cuando se corre la ventana: para sin error (las máscaras caducan al correrse)', () => {
    // Llamadas con plazo corto (las tandas se cuentan dentro de una llamada): con plazos distintos, alguna se corta a
    // mitad de un trozo. Solo importa que no dé error: las imágenes, aquí, no se comparan
    // (y sin apuntar ningún fallo de cuenta: con el tope que ya no para el juego, el fallo se vería solo ahí)
    const faults = exposureFaults.length;
    for (const ms of [0.02, 0.05, 0.1, 0.2, 0.4, 0.8]) {
      const n = ms;
      const b = fresh(0, 0);
      expect(b.exposurePending).toBe(true);
      const exp = rebakeChangedJobs(b, local(0, 0)).find((j) => j.key.startsWith('exposure:'))!;
      expect(exp).toBeDefined();
      // Varios corrimientos con el trabajo a medias (en la página de un juego cruzaba ~12), de ida y vuelta
      for (let k = 0; k < 8; k++) { exp.run(performance.now() + ms); shiftBaked(b, k % 2 ? -K : K, 0); }
      // Antes contaba las tandas de antes del corrimiento contra el tope de un trozo: "lo expuesto no acaba"
      let done = false;
      for (let k = 0; k < 100000 && !done; k++) done = exp.run(performance.now() + 5);
      expect([n, done]).toEqual([n, true]);
    }
    expect(exposureFaults.slice(faults)).toEqual([]);
  });

  it('el cambio no espera al rehorneado de la cola: lo descarta (uno a medias, otros sin empezar, luces) y lo vuelve a marcar corrido', () => {
    const b = fresh(0, 0);
    const job = shiftBakedJob(b, K, 0, { band: 8, manual: true });
    while (!job.run(-Infinity));
    // Dos huecos que siguen dentro después de correr, con antorchas cerca: recuadros, cielo y luces en la cola
    const holes: Box[] = [[40, 30, 20, 55, 45, 63], [70, 60, 16, 80, 75, 63]];
    for (const h of holes) dig(b.source, 0, 0, h);
    const jobs = rebakeChangedJobs(b, local(0, 0));
    expect(jobs.length).toBeGreaterThan(2);
    // El primero, a medias (una llamada sin plazo); los demás, sin empezar
    expect(jobs[0]!.run(-Infinity)).toBe(false);
    expect(job.run(-Infinity)).toBe(true);
    expect(job.canCommit()).toBe(true);
    job.commit();
    // Lo que quedaba en la cola ya no hace nada
    for (const j of jobs) expect(j.run(Infinity)).toBe(true);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (i === N - 1) stamp(b.source, 1 + i, j, i, j);
    rebakeChanged(b, local(1, 0));
    expect(diff(b, fresh(1, 0, holes))).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
    const byId = (x: Baked) => new Map(x.lights.map((l) => [l.light.id, l]));
    const lb = byId(b), lr = byId(fresh(1, 0, holes));
    expect([...lb.keys()].sort()).toEqual([...lr.keys()].sort());
    for (const [id, z] of lr) {
      const y = lb.get(id)!;
      let off = 0;
      for (let i = 0; i < z.weight.length; i++) if (Math.abs(y.weight[i]! - z.weight[i]!) > 1e-6) off++;
      expect({ id, off }).toEqual({ id, off: 0 });
    }
  });
  // Sin luces: una tanda que toca luces se descarta y se vuelve a marcar, como antes (shiftRebakes)
  // (nx trozos de ancho; los de N de alto)
  const freshNL = (tx0: number, ty0: number, holes: Box[] = [], nx = N): Baked => {
    const s = new StaticVoxels(pal, nx * TV, WV, 0, ZT);
    for (let j = 0; j < N; j++) for (let i = 0; i < nx; i++) stamp(s, tx0 + i, ty0 + j, i, j);
    for (const h of holes) dig(s, tx0, ty0, h);
    return bakeWorld({ model: s, lights: [], width: nx * TV, depth: WV }, OPTS);
  };
  const SHAPE = { band: 16, rows: 16, merge: true };

  it('el cambio traslada lo que puede seguir: recuadros a medias y su cielo siguen en el sitio nuevo, y al acabar queda igual que hornear de nuevo ahí', () => {
    const b = freshNL(0, 0);
    // (un hueco que, con lo que leen su recuadro y su cielo, sigue dentro tras correr un trozo al este)
    const hole: Box = [66, 34, 20, 78, 44, 63];
    dig(b.source, 0, 0, hole);
    const jobs = rebakeChangedJobs(b, [], { shape: SHAPE });
    const rects = jobs.filter((j) => j.key.startsWith('rect:')), skies = jobs.filter((j) => j.key.startsWith('sky:'));
    expect(rects.length).toBeGreaterThan(0);
    expect(skies.length).toBeGreaterThan(0);
    // Los recuadros, a medias (dos pasos cada uno); el cielo, esperándolos
    for (const j of rects) { expect(j.run(-Infinity)).toBe(false); expect(j.run(-Infinity)).toBe(false); }
    const job = shiftBakedJob(b, K, 0);
    while (!job.run(Infinity));
    // Siguen vivos (trasladados), y sus claves quedan apartadas para los recuadros nuevos
    expect(rects.every((j) => !j.dead!())).toBe(true);
    expect(skies.every((j) => !j.dead!())).toBe(true);
    expect(b.movedKeys!.size).toBe(rects.length + skies.length);
    // Lo que entra, escrito; y lo que queda, hasta el final
    for (let j = 0; j < N; j++) stamp(b.source, N, j, N - 1, j);
    for (let k = 0; k < 10000 && jobs.some((j) => !j.dead!() && !done.has(j)); k++) for (const j of jobs) if (!done.has(j) && j.run(Infinity)) done.add(j);
    rebakeChanged(b, []);
    expect(diff(b, freshNL(1, 0, [hole]))).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
    expect(b.movedKeys!.size).toBe(0);
  });
  const done = new Set<unknown>();

  it('un corrimiento a mitad del recuadro de lo que entra (andando: corrimientos más seguidos que lo que tarda): sigue en su sitio nuevo sin empezar de nuevo, y acaba horneado', () => {
    // (una ventana de NX trozos de ancho: lo que entra cruza en NX - 1 corrimientos)
    const NX = 5;
    // Lo que entra al correrse un trozo al este, y el recuadro de su rehorneado
    const enter = (b: Baked, tx0: number) => {
      const job = shiftBakedJob(b, K, 0);
      while (!job.run(Infinity));
      for (let j = 0; j < N; j++) stamp(b.source, tx0 + NX, j, NX - 1, j);
      return rebakeChangedJobs(b, [], { shape: SHAPE });
    };
    const isEntering = (j: { key: string }) => /^rect:126,/.test(j.key);
    // Cuántos pasos necesita, sin nada en medio
    const c = freshNL(0, 0, [], NX), solo = enter(c, 0).find(isEntering)!;
    let S = 1;
    while (!solo.run(-Infinity)) S++;
    expect(S).toBeGreaterThan(4);
    // Andando: la mitad de los pasos, y otro corrimiento (con lo siguiente que entra escrito)
    const b = freshNL(0, 0, [], NX), jobs = enter(b, 0), J = jobs.find(isEntering)!;
    for (let k = 0; k < Math.floor(S / 2); k++) expect(J.run(-Infinity)).toBe(false);
    const more = enter(b, 1);
    expect(J.dead!()).toBe(false);
    let T = Math.floor(S / 2), ok = false;
    for (; T < 4 * S && !ok; T++) ok = J.run(-Infinity);
    expect(ok).toBe(true);
    expect(J.dead!()).toBe(false);
    // (lo pintado no se tiró: le faltó como mucho lo que hay que preparar de nuevo junto a lo que entró al lado)
    expect(T).toBeLessThan(Math.ceil(1.75 * S));
    // Publicó en su sitio nuevo (un trozo más al oeste)
    expect(b.published.rects.some((r) => !r.sky && r.x0 === 126 - TV && r.x1 === 161 - TV)).toBe(true);
    // Y al acabar todo, igual que hornear de nuevo ahí
    const all = [...jobs, ...more];
    for (let k = 0; k < 100000 && all.length; k++) {
      const i = all.findIndex((x) => !x.dead!() && !x.waiting?.());
      if (i < 0) break;
      if (all[i]!.run(-Infinity)) all.splice(i, 1);
    }
    rebakeChanged(b, []);
    expect(diff(b, freshNL(2, 0, [], NX))).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
  });
  it('un recuadro sustituido por otro con su misma clave (la cola se queda con el nuevo) no se espera ni se traslada, y al acabar no queda nada apuntado', () => {
    const b = freshNL(0, 0);
    // (los mismos trozos dos veces, sin cajas: el mismo recuadro, la misma clave)
    const cs = [2 * (b.source.cols) + 4];
    const first = rebakeJobs(b, cs, [], undefined, SHAPE), second = rebakeJobs(b, cs, [], undefined, SHAPE);
    const r1 = first.find((j) => j.key.startsWith('rect:'))!, r2 = second.find((j) => j.key.startsWith('rect:'))!;
    expect(r1.key).toBe(r2.key);
    expect(r1.dead!()).toBe(true);
    expect(r2.dead!()).toBe(false);
    for (const j of second) while (!j.run(Infinity));
    expect(b.rebakeBatches!.size).toBe(0);
    expect(b.liveKeys!.size).toBe(0);
    expect(b.movedKeys!.size).toBe(0);
    // Con un corrimiento: el sustituido no se traslada; el vigente, a medias, sí
    const third = rebakeJobs(b, cs, [], undefined, SHAPE), fourth = rebakeJobs(b, cs, [], undefined, SHAPE);
    const r4 = fourth.find((j) => j.key.startsWith('rect:'))!;
    expect(r4.run(-Infinity)).toBe(false);
    // (al este: el trozo 4 de 6 queda en el 2, dentro)
    const job = shiftBakedJob(b, K, 0);
    while (!job.run(Infinity));
    expect(third.every((j) => j.dead!())).toBe(true);
    expect(r4.dead!()).toBe(false);
    expect([...b.movedKeys!]).toEqual(fourth.filter((j) => !j.dead!()).map((j) => j.key));
    for (const j of fourth) while (!j.run(Infinity));
    expect(b.rebakeBatches!.size).toBe(0);
    expect(b.liveKeys!.size).toBe(0);
    expect(b.movedKeys!.size).toBe(0);
  });

  it('el cielo y las luces de un rehorneado esperan solo a sus recuadros (los que pintan en su recuadro o su zona), no a todos: lo cercano acaba con un recuadro lejano sin pintar, y al final igual que hornear de nuevo', () => {
    // A, junto a una antorcha de radio 10 (su zona no llega a B); B, lejos. El mismo rehorneado, recuadros distintos
    const A: Box = [54, 6, 14, 63, 16, 63], B2: Box = [4, 40, 14, 12, 48, 63];
    const L: WorldLight[] = [{ id: 'p', kind: 'torch', x: 59.5, y: 11.5, z: 44, radius: 10 }];
    const bake = (holes: Box[]) => {
      const s = new StaticVoxels(pal, WV, WV, 0, ZT);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) stamp(s, i, j, i, j);
      for (const h of holes) dig(s, 0, 0, h);
      return bakeWorld({ model: s, lights: L, width: WV, depth: WV }, OPTS);
    };
    const b = bake([]);
    dig(b.source, 0, 0, A); dig(b.source, 0, 0, B2);
    const jobs = rebakeChangedJobs(b, L, { shape: SHAPE });
    const rectOf = (k: string) => { const [x0, y0, x1, y1] = k.slice(k.indexOf(':') + 1).split('#')[0]!.split(',').map(Number); return { x0: x0!, y0: y0!, x1: x1!, y1: y1! }; };
    const over = (a: { x0: number; x1: number; y0: number; y1: number }, c: { x0: number; x1: number; y0: number; y1: number }) => a.x1 >= c.x0 && a.x0 <= c.x1 && a.y1 >= c.y0 && a.y0 <= c.y1;
    const rects = jobs.filter((j) => j.key.startsWith('rect:'));
    // (el de B: el que pinta la columna x = 8)
    const far = rects.filter((j) => rectOf(j.key).x0 <= 8 && rectOf(j.key).x1 >= 8);
    const near = rects.filter((j) => !far.includes(j));
    expect(far.length).toBeGreaterThan(0);
    expect(near.length).toBeGreaterThan(0);
    const skies = jobs.filter((j) => j.key.startsWith('sky:')), lights = jobs.filter((j) => j.key.startsWith('light:p#'));
    // (la zona de la luz no toca el recuadro de B)
    const z = b.lights[0]!.rect;
    expect(far.some((r) => over(rectOf(r.key), { x0: z.x, y0: z.y, x1: z.x + z.w - 1, y1: z.y + z.h - 1 }))).toBe(false);
    const nearSky = skies.filter((j) => near.some((r) => over(rectOf(j.key), rectOf(r.key))) && !far.some((r) => over(rectOf(j.key), rectOf(r.key))));
    expect(nearSky.length).toBeGreaterThan(0);
    expect(lights.length).toBe(1);
    // Su recuadro sin publicar: el cielo espera (no se calcula con el pick de antes)
    for (const j of nearSky) { expect(j.waiting?.()).toBe(true); expect(j.run(Infinity)).toBe(false); }
    expect(lights[0]!.run(Infinity)).toBe(false);
    // Lo cercano acaba; el recuadro de B, sin pintar
    for (const j of near) while (!j.run(Infinity));
    for (const j of nearSky) { expect(j.waiting?.()).toBe(false); expect(j.run(Infinity)).toBe(true); }
    let k = 0;
    while (!lights[0]!.run(Infinity)) if (++k > 200) throw new Error('la luz no acaba');
    for (const j of far) expect(j.waiting?.() ?? false).toBe(false);
    // Al final, todo: igual que hornear de nuevo (imagen y luces)
    for (const j of jobs) while (!j.run(Infinity));
    rebakeChanged(b, L);
    const r = bake([A, B2]);
    expect(diff(b, r)).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
    const byId = (x: Baked) => new Map(x.lights.map((l) => [l.light.id, l]));
    const lb = byId(b), lr = byId(r);
    expect([...lb.keys()].sort()).toEqual([...lr.keys()].sort());
    for (const [id, z] of lr) {
      const y = lb.get(id)!;
      let off = 0;
      for (let i = 0; i < z.weight.length; i++) if (Math.abs(y.weight[i]! - z.weight[i]!) > 1e-6) off++;
      expect({ id, rect: y.rect, off }).toEqual({ id, rect: z.rect, off: 0 });
    }
  });

  it('un recuadro a medias con su margen cambiado (un vecino) y el rehorneado del vecino publicado antes encima: empieza de nuevo y queda igual que hornear de nuevo', () => {
    const b = freshNL(0, 0);
    // A, junto al borde de su trozo de vóxeles (y 32..47); B, en el de al lado (48..63), delante (al sur): fuera del plan de A, pero
    // el recuadro de A pinta lo que se ve en sus píxeles, y eso incluye 7 de B. Antes la comprobación de "algo cambió" miraba solo
    // los trozos del plan, y A publicaba lo de antes de cavar B (también con la regla de antes de trasladar)
    const A: Box = [40, 40, 14, 46, 46, 63], B2: Box = [40, 49, 14, 46, 54, 63];
    // (cuántos pasos necesita el recuadro de A, en una copia; aquí se le dan todos menos uno: lo pintado incluye el borde)
    const c = freshNL(0, 0);
    dig(c.source, 0, 0, A);
    const rc = rebakeChangedJobs(c, [], { shape: SHAPE }).find((j) => j.key.startsWith('rect:'))!;
    let S = 1;
    while (!rc.run(-Infinity)) S++;
    dig(b.source, 0, 0, A);
    const ja = rebakeChangedJobs(b, [], { shape: SHAPE });
    const ra = ja.find((j) => j.key.startsWith('rect:'))!;
    for (let k = 0; k < S - 1; k++) expect(ra.run(-Infinity)).toBe(false);
    dig(b.source, 0, 0, B2);
    const jb = rebakeChangedJobs(b, [], { shape: SHAPE });
    for (const j of jb) while (!j.run(Infinity));
    for (const j of ja) while (!j.run(Infinity));
    rebakeChanged(b, []);
    expect(diff(b, freshNL(0, 0, [A, B2]))).toEqual({ rgba: 0, face: 0, pick: 0, sky: 0, depth: 0 });
  });
});
