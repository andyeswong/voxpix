// Efectos y partículas (src/core/effects.ts y src/world/effects.ts): deterministas, con topes que descartan siempre lo
// mismo; los visuales no tocan la huella de la partida; las gotas (la primera partícula de simulación) siguen dando las
// mismas huellas; y en el cuadro se pintan con su color, detrás de lo que las tapa y con luz propia si la llevan.
import { describe, it, expect } from 'vitest';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { FxSystem, fxRandom, FX_PRESETS, FX_STRIDE, Model, box, material, type EmitterSpec } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D, frame2DParts, type Frame2DOptions } from '../src/world/frame2d';

const pts = (fx: FxSystem) => Array.from(fx.packed.subarray(0, fx.count * FX_STRIDE));

describe('efectos: el sistema', () => {
  it('misma semilla y mismos pasos, mismas partículas', () => {
    const run = () => {
      const fx = new FxSystem(fxRandom(5));
      fx.add('humo', 10, 10, 2);
      fx.burst('chispas', 4, 4, 3);
      for (let k = 0; k < 90; k++) fx.step(1 / 60);
      return pts(fx);
    };
    const a = run();
    expect(a.length).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  });

  it('cada efecto ya hecho se crea, se mueve y muere', () => {
    for (const name of Object.keys(FX_PRESETS) as Array<keyof typeof FX_PRESETS>) {
      const fx = new FxSystem(fxRandom(1));
      const id = fx.add(name, 0, 0, 10);
      fx.burst(name, 0, 0, 10, 5);
      for (let k = 0; k < 30; k++) fx.step(1 / 60);
      expect(fx.alive, name).toBeGreaterThan(0);
      fx.remove(id);
      for (let k = 0; k < 60 * 10; k++) fx.step(1 / 60);
      expect(fx.alive, name).toBe(0);
    }
  });

  it('el tope de vivas descarta las nuevas, y lo que sale después no cambia', () => {
    const spec: EmitterSpec = { life: [5, 5], speed: [1, 3], spread: 180, colors: ['#ffffff'] };
    const big = new FxSystem(fxRandom(9)), small = new FxSystem(fxRandom(9), { maxAlive: 10 });
    for (const fx of [big, small]) { fx.burst(spec, 0, 0, 0, 30); fx.step(0.1); }
    expect(small.alive).toBe(10);
    expect(small.dropped).toBe(20);
    expect(pts(small)).toEqual(pts(big).slice(0, 10 * FX_STRIDE));
    // El azar se gastó igual: lo siguiente que nace es lo mismo en los dos
    const b2 = new FxSystem(fxRandom(9)), s2 = new FxSystem(fxRandom(9), { maxAlive: 10 });
    for (const fx of [b2, s2]) { fx.burst(spec, 0, 0, 0, 30); }
    s2.clear(); b2.clear();
    for (const fx of [b2, s2]) { fx.burst(spec, 0, 0, 0, 3); fx.step(0.1); }
    expect(pts(s2)).toEqual(pts(b2));
  });

  it('el tope de luces: como mucho maxLights, las primeras, y se apagan al morir', () => {
    const fx = new FxSystem(fxRandom(2), { maxLights: 3 });
    fx.burst('chispas', 0, 0, 20, 12);
    fx.step(1 / 60);
    const l = fx.lights();
    expect(l.length).toBe(3);
    const d = fx.packed;
    expect([l[0]!.x, l[0]!.y, l[0]!.z].map((v) => Math.fround(v))).toEqual([d[0], d[1], d[2]]);
    expect(l[0]!.intensity).toBeLessThan(FX_PRESETS.chispas.light.intensity);
    expect(new FxSystem(fxRandom(2), { maxLights: 0 }).lights()).toEqual([]);
  });

  it('chocan con lo sólido: se paran, rebotan o mueren', () => {
    const floor = (_x: number, _y: number, z: number) => z < 0;
    const drop = (collide: EmitterSpec['collide']) => {
      const fx = new FxSystem(fxRandom(3));
      fx.burst({ life: [3, 3], speed: [20, 20], dir: [0, 0, -1], spread: 0, gravity: 50, colors: ['#ffffff'], collide }, 0, 0, 2, 1);
      for (let k = 0; k < 60; k++) fx.step(1 / 60, floor);
      return fx;
    };
    const stop = drop('stop');
    expect(stop.alive).toBe(1);
    expect(stop.packed[2]).toBeGreaterThanOrEqual(0);
    const bounce = drop('bounce');
    expect(bounce.alive).toBe(1);
    expect(bounce.packed[2]).toBeGreaterThanOrEqual(0);
    expect(drop('die').alive).toBe(0);
    expect(drop('none').packed[2]).toBeLessThan(-5);
  });

  it('la instantánea devuelve lo mismo', () => {
    const fx = new FxSystem(fxRandom(4));
    fx.add('brasas', 0, 0, 0);
    for (let k = 0; k < 30; k++) fx.step(1 / 60);
    const s = fx.exportState();
    for (let k = 0; k < 30; k++) fx.step(1 / 60);
    const after = pts(fx);
    fx.importState(s);
    expect(fx.alive).toBe(s.n);
    // (el azar propio no va en la instantánea: se compara la posición, no lo que nace después)
    expect(fx.packed.subarray(0, 3)).toEqual(new Float32Array(s.data.subarray(0, 3)));
    void after;
  });
});

// Una partida corta (la de determinism.test.ts) con o sin efectos visuales
function play(fxMode: 'sin' | 'con' | 'apagados', ticks = 100): string[] {
  const { state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), THEMES.medieval.look);
  const m = new Model({ ramps: [{ name: 'x', colors: ['#ff0000'] }] });
  box(m, -1, -1, 0, 1, 1, 6, material(0, 0));
  const e = state.addEntity('cuerpo', m, 100, 100, 1);
  const w = state.water!;
  let wet: [number, number] = [0, 0];
  for (let i = 0; i < w.sim.depth.length; i++) if (!w.sim.solid[i] && w.sim.depth[i]! > 2) { wet = [(i % w.gw) * 2, Math.floor(i / w.gw) * 2]; break; }
  if (fxMode !== 'sin') { state.fx.add('humo', 100, 100, 4); state.fx.add('lluvia', 100, 100, 30); }
  if (fxMode === 'apagados') state.effectsOn = false;
  const hashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    if (t === 20) state.events.disturb(wet[0], wet[1], 0.4, 3);
    if (t === 40) state.events.splash(wet[0], wet[1], 1, 25, 90);
    if (t % 10 === 0) { e.x += 1; e.yaw = (e.yaw + 45) % 360; if (fxMode !== 'sin') state.fx.burst('chispas', e.x, e.y, 3); }
    state.step();
    if (t % 50 === 49) hashes.push(state.hash());
  }
  return hashes;
}

describe('efectos en el mundo', () => {
  it('los visuales, encendidos o apagados, no cambian la huella; las gotas dan la de siempre', () => {
    const base = play('sin');
    // La huella de esta partida con gotas desde antes de los efectos (las gotas son la primera partícula de simulación)
    expect(base).toEqual(['2000e11e', 'f7c71f7f']);
    expect(play('con')).toEqual(base);
    expect(play('apagados')).toEqual(base);
  });

  it('las de simulación entran en la huella y en la instantánea', () => {
    const { state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), THEMES.medieval.look);
    const h0 = state.hash();
    state.simFx.add('polvo', 100, 100, 2);
    expect(state.hash()).not.toBe(h0);
    for (let k = 0; k < 10; k++) state.step();
    const snap = state.snapshot(), h1 = state.hash();
    for (let k = 0; k < 20; k++) state.step();
    const h2 = state.hash();
    state.restore(snap);
    expect(state.hash()).toBe(h1);
    for (let k = 0; k < 20; k++) state.step();
    expect(state.hash()).toBe(h2);
  });
});

describe('efectos en el cuadro', () => {
  const PAL = { ramps: [{ name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] }, { name: 'muro', colors: ['#302040', '#504070', '#8070b0'] }] };
  function scene(): { state: WorldState; s: StaticVoxels } {
    const s = new StaticVoxels(structuredClone(PAL), 40, 40, -2, 16);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) s.set(x, y, 0, material(0, 1));
    // Un muro alto en y = 30 (y grande = más lejos de la cámara: lo que está detrás, en y > 30, queda tapado)
    for (let z = 1; z <= 12; z++) for (let x = 5; x < 35; x++) s.set(x, 30, z, material(1, 1));
    return { state: new WorldState(s, [], null), s };
  }
  const RED: EmitterSpec = { life: [9, 9], speed: [0, 0], colors: ['#ff0000'], px: 2 };
  const GLOW: EmitterSpec = { life: [9, 9], speed: [0, 0], colors: ['#00ff00'], light: { radius: 8, intensity: 1 } };

  it('se pintan con su color y tamaño, y lo que hay delante las tapa', () => {
    const { state, s } = scene();
    const b = bakeWorld({ model: s, lights: [], width: 40, depth: 40 }, { topZ: 16 });
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: false, ambient: [1, 1, 1] };
    state.fx.burst(RED, 20.5, 15.5, 6, 1);      // a la vista
    state.fx.burst(RED, 20.5, 34.5, 6, 1);      // detrás del muro
    const img = frame2D(state, b, o);
    const red = (x: number, y: number, z: number) => {
      const [sx, sy] = b.cam.project(x, y, z), t = (Math.floor(sy) * b.width + Math.floor(sx)) * 4;
      return [img[t], img[t + 1], img[t + 2]];
    };
    expect(red(20.5, 15.5, 6)).toEqual([255, 0, 0]);
    expect(red(20.5, 34.5, 6)).not.toEqual([255, 0, 0]);
    let n = 0;
    for (let i = 0; i < img.length; i += 4) if (img[i] === 255 && img[i + 1] === 0 && img[i + 2] === 0) n++;
    expect(n).toBe(4);                            // 2 x 2 píxeles: solo la de delante
    // Apagados, no se pintan
    state.effectsOn = false;
    const off = frame2D(state, b, o);
    let m = 0;
    for (let i = 0; i < off.length; i += 4) if (off[i] === 255 && off[i + 1] === 0) m++;
    expect(m).toBe(0);
  });

  it('las que llevan luz se ven con luz propia y alumbran alrededor (hasta el tope)', () => {
    const { state, s } = scene();
    const b = bakeWorld({ model: s, lights: [], width: 40, depth: 40 }, { topZ: 16 });
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.15, 0.15, 0.2] };
    const dark = frame2DParts(state, b, o).total!;
    state.fx.burst(GLOW, 15.5, 15.5, 2, 1);
    const { total } = frame2DParts(state, b, o);
    const [sx, sy] = b.cam.project(15.5, 15.5, 2), t = Math.floor(sy) * b.width + Math.floor(sx);
    expect(total![t * 3]).toBe(1);
    // El suelo cerca, más claro que sin la partícula
    const [fx, fy] = b.cam.project(18.5, 15.5, 1), f = Math.floor(fy) * b.width + Math.floor(fx);
    expect(total![f * 3 + 1]!).toBeGreaterThan(dark[f * 3 + 1]! + 0.05);
    // Sin luces de partícula (tope 0), el suelo queda como estaba
    state.fx.maxLights = 0;
    expect(frame2DParts(state, b, o).total![f * 3 + 1]).toBeCloseTo(dark[f * 3 + 1]!, 5);
  });
});
