// BakeWorker (src/world/horno.ts): los recuadros del rehorneado de la ventana viva pintados con un espejo en un worker (aquí,
// en el mismo hilo, con los mensajes clonados como en un worker de verdad, y el worker pinta cuando se le deja). Lo que
// sale tiene que ser lo mismo que hornear aquí, al andar, picar y girar; sin envolver nada; y girar no rehace el espejo
import { describe, it, expect } from 'vitest';
import { material, Model, type Palette } from '../src/core';
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
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import { FrameBudget } from '../src/view/budget';
import { LiveWindow, type Trozo, type LiveWindowOptions } from '../src/world/live';
import { rebakeChangedJobs, type Baked } from '../src/world/bake';
import { BakeWorker, BakeWorkerHost, type BakeWorkerPort, type ToWorker, type FromWorker } from '../src/world/horno';
import type { Quarter } from '../src/world/view';

const OPTS = { incline: 0.5, sky: true, outline: 'both' as const };
// El "juego": lo picado, en coordenadas del mundo; al entrar un trozo se vuelve a poner
const dug = new Set<string>();
const make = (center: Trozo, log?: { unload: string[]; load: string[] }, extra: Partial<LiveWindowOptions> = {}) => new LiveWindow({
  blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS, ...extra,
  onUnload: (t) => log?.unload.push(`${t[0]},${t[1]}`),
  onLoad: (t, ctx) => {
    log?.load.push(`${t[0]},${t[1]}`);
    for (const k of dug) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; if (Math.floor(x / TV) === t[0] && Math.floor(y / TV) === t[1]) ctx.write(x, y, z, 0); }
  },
});
const diff = (b: Baked, r: Baked, rect?: { x0: number; y0: number; x1: number; y1: number }) => {
  let n = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    if (rect) { const x = i % r.width, y = Math.floor(i / r.width); if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) continue; }
    let d = b.face[i] !== r.face[i] || !(b.pick[i] === r.pick[i] || (Number.isNaN(b.pick[i]!) && Number.isNaN(r.pick[i]!))) || b.sky![i] !== r.sky![i];
    for (let c = 0; c < 4 && !d; c++) d = b.rgba[i * 4 + c] !== r.rgba[i * 4 + c];
    if (d) n++;
  }
  return n;
};


// El worker en el mismo hilo: los mensajes se clonan (como al cruzar a un worker) y se cuentan por tipo; step() le pasa al
// worker lo que le llegó, le deja pintar `paint` recuadros y devuelve al principal lo pintado
function channel() {
  const toHost: ToWorker[] = [], toMain: FromWorker[] = [], tasks: Array<() => void> = [];
  // (holdSky: los pedidos de cielo se quedan sin llegar al worker hasta release())
  let holdSky = false;
  const held: ToWorker[] = [];
  const kinds: Record<string, number> = {};
  // (un trozo mandado otra vez con la misma versión y el mismo contenido: el espejo ya lo tenía, p. ej. tras correrse)
  const seen = new Set<string>();
  let again = 0;
  const port: BakeWorkerPort = { onmessage: null, postMessage: (m) => {
    kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    if (m.kind === 'chunks') for (const ch of m.list) {
      let h = 0;
      for (let i = 0; i < ch.tops.length; i++) h = Math.imul(h ^ ch.tops[i]!, 16777619);
      const k = `${m.id}:${ch.v}:${h}`;
      if (seen.has(k)) again++; else seen.add(k);
    }
    (holdSky && m.kind === 'sky' ? held : toHost).push(structuredClone(m));
  } };
  const host = new BakeWorkerHost((m) => toMain.push(structuredClone(m)), (fn) => tasks.push(fn));
  // (onStep: lo que hace el principal en cada cuadro antes de que el worker lea, p. ej. BakeWorker.frame)
  let onStep: (() => void) | null = null;
  const step = (paint = 1) => {
    onStep?.();
    while (toHost.length) host.receive(toHost.shift()!);
    for (let k = 0; k < paint && tasks.length; k++) tasks.shift()!();
    while (toMain.length) port.onmessage?.({ data: toMain.shift()! });
  };
  return { port, host, step, kinds, again: () => again, held: () => held.length, setStep: (f: () => void) => { onStep = f; },
    hold: (on: boolean) => { holdSky = on; }, release: () => { toHost.push(...held.splice(0)); },
    idle: () => !toHost.length && !tasks.length && !toMain.length && !held.length };
}
type Ch = ReturnType<typeof channel>;
const Y = TV / 2;
// Andar hacia el este hasta `to`, con 6 vueltas de cola por paso. El worker pinta un recuadro cada dos pasos: se queda
// atrás, y hay recuadros fuera al correrse la ventana
const walk = (win: LiveWindow, ch: Ch | null, budget: FrameBudget, from: number, to: number, each?: (x: number) => void) => {
  let x = from, n = 0;
  while (x < to) {
    x += TV / 8; n++;
    win.update(x, Y, budget);
    for (let k = 0; k < 6; k++) { budget.run(); ch?.step(k === 5 && n % 2 === 0 ? 1 : 0); win.update(x, Y, budget); }
    each?.(x);
  }
  return x;
};
const drain = (win: LiveWindow, ch: Ch | null, budget: FrameBudget, x: number) => {
  for (let k = 0; k < 3000 && (win.busy || budget.pending || (ch && !ch.idle())); k++) { budget.run(); ch?.step(4); win.update(x, Y, budget); }
  // (nada se queda esperando para siempre: un pedido saltado que nadie descartó colgaría su trabajo en la cola)
  if (win.busy || budget.pending || (ch && !ch.idle())) throw new Error(`no se vacía: cola ${budget.pending}, ocupada ${win.busy}`);
  for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) for (let k = 0; !j.run(Infinity); k++) { ch?.step(4); if (k > 1000) throw new Error('no acaba'); }
};
// Picar un hoyo en coordenadas del mundo
const pit = (win: LiveWindow, wx: number, wy: number) => {
  const [lx, ly] = win.toLocal(wx, wy);
  for (let z = 20; z < 64; z++) for (let y = ly - 4; y < ly + 4; y++) for (let x = lx - 4; x < lx + 4; x++) if (x >= 0 && x < win.store.width && y >= 0 && y < win.store.depth) win.store.set(x, y, z, 0);
};
// Andar, picar mientras hay recuadros fuera, girar a 1, andar, volver a 0 y andar: con worker (ch) o sin él
const scenario = (ch: Ch | null, turnTo = false) => {
  const win = make([0, 0], undefined, turnTo ? {} : { quarters: [0, 1] });
  const bw = ch ? new BakeWorker(ch.port) : null;
  bw?.attach(win);
  const budget = new FrameBudget(1e6);
  let x = TV / 2;
  let dug = 0;
  x = walk(win, ch, budget, x, x + TV * 1.5, (wx) => { if (dug++ % 4 === 1) pit(win, wx + TV, Y + 9); });
  const turnTo1 = (q: Quarter) => {
    const before = ch?.kinds.mirror ?? 0;
    if (turnTo) { win.turnTo(q); for (let k = 0; k < 3000 && win.quarter !== q; k++) { budget.run(); ch?.step(); win.update(x, Y, budget); } }
    else win.turn(q);
    return before;
  };
  const m1 = turnTo1(1);
  const mirrorsAtSwitch1 = ch?.kinds.mirror ?? 0;
  x = walk(win, ch, budget, x, x + TV * 1.25, (wx) => { if (dug++ % 3 === 0) pit(win, wx - TV / 2, Y - 7); });
  turnTo1(0);
  x = walk(win, ch, budget, x, x + TV);
  drain(win, ch, budget, x);
  return { win, bw, x, m1, mirrorsAtSwitch1 };
};

describe('BakeWorker: el horno en un worker', () => {
  it('andar con corrimientos, picar con recuadros fuera y girar (turn): igual que hornear aquí; lo pedido antes de un corrimiento se salta', () => {
    const ch = channel();
    const a = scenario(ch), b = scenario(null);
    expect(a.bw!.stats.asked).toBeGreaterThan(20);
    expect(a.bw!.stats.got).toBeGreaterThan(10);
    expect(a.bw!.stats.skipped).toBeGreaterThan(0);
    // (el cielo también fuera: cada pedido de cielo llega o se salta como los recuadros)
    expect(a.bw!.stats.skies).toBeGreaterThan(10);
    expect(a.bw!.stats.skyMs).toBeGreaterThan(0);
    expect(a.bw!.stats.got + a.bw!.stats.skipped).toBeLessThanOrEqual(a.bw!.stats.asked + a.bw!.stats.skies);
    // Lo mandado: solo lo que el espejo no tenía (un corrimiento no hace volver a mandar lo que se corrió con él)
    expect(a.bw!.stats.chunks).toBeGreaterThan(0);
    expect(ch.again()).toBe(0);
    expect(diff(a.win.baked, b.win.baked)).toBe(0);
    // Y el otro giro, también al día
    a.win.turn(1); b.win.turn(1);
    drain(a.win, ch, new FrameBudget(1e6), a.x); drain(b.win, null, new FrameBudget(1e6), b.x);
    expect(diff(a.win.baked, b.win.baked)).toBe(0);
  });

  it('un cielo pedido fuera cuando la ventana se corre no se traslada: se descarta (el worker lo salta) y nada se queda esperando', () => {
    const ch = channel(), win = make([0, 0]), bw = new BakeWorker(ch.port), budget = new FrameBudget(1e6);
    bw.attach(win);
    ch.hold(true);
    let x = TV / 2;
    // Andar hasta tener cielos retenidos y que la ventana se corra después
    let shiftsAtHeld = -1;
    for (let n = 0; n < 200 && !(shiftsAtHeld >= 0 && (ch.kinds.shift ?? 0) > shiftsAtHeld); n++) {
      x += TV / 16;
      win.update(x, Y, budget);
      for (let k = 0; k < 4; k++) { budget.run(); ch.step(4); win.update(x, Y, budget); }
      if (shiftsAtHeld < 0 && ch.held() > 0) shiftsAtHeld = ch.kinds.shift ?? 0;
    }
    expect(shiftsAtHeld).toBeGreaterThanOrEqual(0);
    expect(ch.kinds.shift).toBeGreaterThan(shiftsAtHeld);
    const skipped = bw.stats.skipped;
    ch.hold(false); ch.release();
    drain(win, ch, budget, x);
    expect(bw.stats.skipped).toBeGreaterThan(skipped);
    const ref = make([0, 0]), rb = new FrameBudget(1e6);
    let rx = TV / 2;
    while (rx < x) { rx += TV / 16; ref.update(rx, Y, rb); for (let k = 0; k < 4; k++) { rb.run(); ref.update(rx, Y, rb); } }
    drain(ref, null, rb, x);
    expect(diff(win.baked, ref.baked)).toBe(0);
  });

  it('marcar para rehornear (touch) no vuelve a mandar trozos; picar manda solo los que cambian; y la imagen igual', () => {
    const ch = channel(), win = make([0, 0]), bw = new BakeWorker(ch.port), budget = new FrameBudget(1e6);
    bw.attach(win);
    const ref = make([0, 0]), rb = new FrameBudget(1e6);
    drain(win, ch, budget, TV / 2); drain(ref, null, rb, TV / 2);
    // Todo marcado: se rehornea todo (fuera), sin mandar ningún trozo más que los que el espejo aún no tenía
    const s = win.view.static, n = s.cols * s.rows;
    for (let c = 0; c < n; c++) { s.touch(c); ref.view.static.touch(c); }
    drain(win, ch, budget, TV / 2); drain(ref, null, rb, TV / 2);
    const sent = bw.stats.chunks, asked = bw.stats.asked;
    for (let c = 0; c < n; c++) s.touch(c);
    drain(win, ch, budget, TV / 2);
    expect(bw.stats.asked).toBeGreaterThan(asked);
    expect(bw.stats.chunks).toBe(sent);
    expect(bw.stats.resent).toBe(0);
    // Picar: solo lo que cambió se vuelve a mandar
    pit(win, TV / 2 + 6, Y + 2); pit(ref, TV / 2 + 6, Y + 2);
    drain(win, ch, budget, TV / 2); drain(ref, null, rb, TV / 2);
    expect(bw.stats.resent).toBeGreaterThan(0);
    expect(bw.stats.resent).toBeLessThanOrEqual(4);
    expect(diff(win.baked, ref.baked)).toBe(0);
  });

  it('lo que está fuera y pasa a ser cercano (near) se retira: el worker no lo pinta, se pinta aquí sin esperarlo, y la imagen igual', () => {
    const ch = channel(), win = make([0, 0]), budget = new FrameBudget(1e6);
    // (cercano: lo que toca la caja, solo desde que se "entra")
    let inside = false;
    const box = { x0: 0, y0: 0, x1: 4000, y1: 4000 };
    const bw = new BakeWorker(ch.port, { near: (r) => inside && r.x1 >= box.x0 && r.x0 <= box.x1 && r.y1 >= box.y0 && r.y0 <= box.y1 });
    bw.attach(win);
    ch.setStep(() => bw.frame());
    const ref = make([0, 0]), rb = new FrameBudget(1e6);
    drain(win, ch, budget, TV / 2); drain(ref, null, rb, TV / 2);
    // Picar: sus recuadros y su cielo se piden fuera; el worker no pinta nada todavía
    pit(win, TV / 2 + 6, Y + 2); pit(ref, TV / 2 + 6, Y + 2);
    // (lo que pica el juego lo rehornea él)
    for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j);
    for (let k = 0; k < 20; k++) { budget.run(); ch.step(0); win.update(TV / 2, Y, budget); }
    const asked = bw.stats.asked + bw.stats.skies, got = bw.stats.got;
    expect(asked).toBeGreaterThan(0);
    // Se "entra": todo es cercano. Lo de fuera se retira; la cola lo pinta aquí sin que el worker pinte nada
    inside = true;
    for (let k = 0; k < 50 && (budget.pending || win.busy); k++) { ch.step(0); budget.run(); win.update(TV / 2, Y, budget); }
    expect(budget.pending).toBe(0);
    expect(bw.stats.retired).toBeGreaterThan(0);
    expect(bw.stats.got).toBe(got);
    // (el worker los quita de su cola sin pintarlos)
    ch.step(4);
    expect(ch.host.canceled).toBe(bw.stats.retired + bw.stats.retiredSky);
    expect(ch.host.pending).toBe(0);
    drain(ref, null, rb, TV / 2);
    expect(diff(win.baked, ref.baked)).toBe(0);
  });

  it('lo que ya llegó del worker no se retira aunque ahora sea cercano: se usa', () => {
    const ch = channel(), win = make([0, 0]), budget = new FrameBudget(1e6);
    let inside = false;
    // (perFrame 0: lo llegado se queda sin entregar, en la bandeja)
    const bw = new BakeWorker(ch.port, { perFrame: 0, near: () => inside });
    bw.attach(win);
    ch.setStep(() => bw.frame());
    drain(win, null, budget, TV / 2);
    pit(win, TV / 2 + 6, Y + 2);
    for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j);
    for (let k = 0; k < 20; k++) { budget.run(); ch.step(4); win.update(TV / 2, Y, budget); }
    expect(bw.stats.got).toBeGreaterThan(0);
    inside = true;
    ch.step(0);
    expect(bw.stats.retired).toBe(0);
  });

  it('girar no rehace el espejo: uno por fuente (giro 0 y giro 1), ninguno tirado, y al volver se mandan pocos trozos', () => {
    const ch = channel();
    const a = scenario(ch);
    expect(ch.kinds.mirror).toBe(2);
    expect(ch.kinds.drop ?? 0).toBe(0);
    expect(a.bw!.stats.mirrors).toBe(2);
  });

  it('turnTo: el núcleo del giro nuevo se pinta aquí (ningún espejo nuevo antes del cambio) y lo demás fuera; igual que hornear aquí', () => {
    const ch = channel();
    const a = scenario(ch, true), b = scenario(null, true);
    expect(a.mirrorsAtSwitch1).toBe(a.m1);
    expect(ch.kinds.mirror).toBeGreaterThan(1);
    expect(diff(a.win.baked, b.win.baked)).toBe(0);
  });

  it('sin envolver: la ventana, sus fuentes y sus horneados no ganan propiedades propias (salvo remote y remoteStats), y shift, shiftJob y touch siguen en el prototipo', () => {
    const ch = channel();
    const win = make([0, 0], undefined, { quarters: [0, 1] });
    const objs = () => [win, win.store, win.view.static, win.baked] as object[];
    // (remote es el enganche; remoteStats, lo que cuenta rebakeJobs de lo llegado de fuera: los dos son del motor)
    const mine = (k: string) => k !== 'remote' && k !== 'remoteStats';
    const own = () => objs().map((o) => Object.getOwnPropertyNames(o).filter(mine).sort().join(','));
    const before = own();
    const bw = new BakeWorker(ch.port);
    bw.attach(win);
    const budget = new FrameBudget(1e6);
    const x = walk(win, ch, budget, TV / 2, TV * 2);
    drain(win, ch, budget, x);
    expect(bw.stats.asked).toBeGreaterThan(0);
    // (el corrimiento rehace algunos campos privados de la ventana: se compara con una ventana sin worker que anduvo igual)
    const ref = make([0, 0], undefined, { quarters: [0, 1] }), rb = new FrameBudget(1e6);
    drain(ref, null, rb, walk(ref, null, rb, TV / 2, TV * 2));
    const ownRef = [ref, ref.store, ref.view.static, ref.baked].map((o) => Object.getOwnPropertyNames(o).filter(mine).sort().join(','));
    expect(own()).toEqual(ownRef);
    void before;
    for (const s of [win.store, win.view.static]) for (const k of ['shift', 'shiftJob', 'touch', 'set']) expect([k, Object.getOwnPropertyDescriptor(s, k)]).toEqual([k, undefined]);
    expect(win.baked.remote).toBeDefined();
    bw.detach();
    expect(win.baked.remote).toBeUndefined();
  });
});
