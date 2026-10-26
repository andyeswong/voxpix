// Vegetación en el mundo del juego: lo de antes no cambia (huellas sacadas del motor de antes del follaje, 0b8df5e),
// el agua no cuenta el follaje como fondo, la hierba se atraviesa y los arbustos no, y la luz horneada atraviesa la
// copa.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorldState, worldWaterDepth, type World } from '../src/world/build';
import { bakeWorld } from '../src/world/bake';
import { frame2D } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { render, camera, lightField3D, material, unkey, planFoliage, FOLIAGE_RAMPS } from '../src/core';
import { medievalScene } from '../src/samples/medieval';

const h = (a: ArrayBufferView) => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex').slice(0, 16);

describe('sin follaje, todo da lo mismo que antes', () => {
  it('horneado, pesos de las luces, cuadro 2D, render y luz del editor: las huellas del motor anterior', () => {
    const { world, state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval');
    const b = bakeWorld(world, { topZ: 40, incline: 0.5 });
    state.lights.add({ kind: 'lantern', x: 180, y: 170, z: 6 });
    const f = frame2D(state, b, { vx: 60, vy: 120, vw: 384, vh: 216, time: 0.5, lights: true, ambient: THEMES.medieval.ambient });
    const m = medievalScene().model;
    const o = { width: 200, height: 160, originX: 100, originY: 120, yaw: 33, elevation: 35, outline: 'outer' as const, pick: true };
    const img = render(m, o);
    const t = lightField3D(m, img, camera(o), [{ x: 3.5, y: 2.5, z: 6.5, radius: 30, color: [1, 0.6, 0.3], intensity: 1.2 }], [0.3, 0.3, 0.35]);
    expect({ bake: h(b.rgba), weights: h(new Float32Array(b.lights.flatMap((l) => [...l.weight]))), frame: h(f), render: h(img.rgba), light: h(t) })
      // frame: el cuadro lleva agua, y el tono del agua honda cambió a propósito (paso con trama en vez de corte seco, por
      // los "picos" que vio Andrés) y después dejó de recortarse el agua de arriba y abajo de la vista: la huella de antes de
      // los dos cambios era 131238de0fec0c86
      .toEqual({ bake: '16ba0b9afa358c56', weights: '1b8e8448d24159ed', frame: '6605829d81b3542e', render: 'bb67a43624a8b6d9', light: 'd4d74866a7d23f78' });
  }, 60000);
});

// Un mundo pequeño: suelo de piedra, una cuenca (agua de 2) a la izquierda, y rampas de follaje
const PAL = { ramps: [
  { name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] },
  { name: 'hojas', colors: ['#14301f', '#1f4a2a', '#2f6b32', '#4f8f3c'], kind: 'foliage' as const },
  structuredClone(FOLIAGE_RAMPS['hierba-alta']!),
  structuredClone(FOLIAGE_RAMPS.arbusto!),
] };
function smallWorld(): World {
  const W = 48, D = 32;
  const model = new StaticVoxels(structuredClone(PAL), W, D, -4, 24);
  const wet = new Uint8Array(W * D), waterTop = new Int8Array(W * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const basin = x < 16;
    for (let z = -2; z <= (basin ? -2 : 0); z++) model.set(x, y, z, material(0, 1));
    if (basin) { wet[y * W + x] = 1; waterTop[y * W + x] = 1; }
  }
  return { model, lights: [], width: W, depth: D, wet, waterTop, fountain: null };
}

describe('follaje en el mundo', () => {
  it('el agua no cuenta el follaje como fondo: hierba sumergida y un arbusto alto en la orilla', () => {
    const plain = smallWorld(), veg = smallWorld();
    // Hierba en el fondo de la cuenca y un arbusto de 10 de alto pegado a la orilla (dentro del agua)
    for (let y = 4; y < 28; y += 3) for (let x = 2; x < 14; x += 2) veg.model.set(x, y, -1, material(2, 1));
    for (let z = -1; z < 9; z++) for (let y = 12; y < 16; y++) for (let x = 12; x < 16; x++) veg.model.set(x, y, z, material(3, 1));
    const a = new WaterLayer(plain, 'medieval'), b = new WaterLayer(veg, 'medieval');
    expect(Buffer.from(b.sim.ground.buffer).equals(Buffer.from(a.sim.ground.buffer))).toBe(true);
    expect(Buffer.from(b.sim.solid).equals(Buffer.from(a.sim.solid))).toBe(true);     // el arbusto no es pared
    expect(veg.model.floorAt(13, 13)).toBe(-1);
    expect(veg.model.height[13 * veg.width + 13]).toBe(9);                           // la rejilla de siempre no cambia
  });

  it('la hierba se atraviesa andando y el arbusto no; las alturas siguen al día al cambiar vóxeles', () => {
    const w = smallWorld();
    const s = new WorldState(w.model, [], null);
    w.model.set(30, 10, 1, material(2, 1)); w.model.set(30, 10, 2, material(2, 2));      // una mata de hierba de 2
    for (let z = 1; z <= 3; z++) w.model.set(34, 10, z, material(3, 1));                 // un arbusto de 3
    expect(s.groundAt(30.5, 10.5)).toBe(1);
    expect(s.solidAt(30.5, 10.5, 1.5)).toBe(false);
    expect(s.groundAt(34.5, 10.5)).toBe(4);
    expect(s.solidAt(34.5, 10.5, 2.5)).toBe(true);
    expect(s.raycast([28.5, 10.5, 1.5], [36.5, 10.5, 1.5])!.hit[0]).toBeCloseTo(34, 5);  // cruza la hierba, para en el arbusto
    // Se arranca el arbusto y se pone piedra encima de la hierba
    for (let z = 1; z <= 3; z++) w.model.set(34, 10, z, 0);
    w.model.set(30, 10, 3, material(0, 1));
    expect(s.groundAt(34.5, 10.5)).toBe(1);
    expect(s.groundAt(30.5, 10.5)).toBe(4);
    expect(w.model.floorAt(30, 10)).toBe(4);
  });

  it('la luz horneada atraviesa una copa de follaje: más luz debajo que con la copa sólida, menos que sin copa', () => {
    const lightUnder = (kind: 'foliage' | 'solid' | 'none') => {
      const w = smallWorld();
      if (kind === 'solid') w.model.palette = { ramps: w.model.palette.ramps.map((r) => ({ name: r.name, colors: r.colors })) };
      if (kind !== 'none') for (let z = 8; z <= 9; z++) for (let y = 8; y < 24; y++) for (let x = 24; x < 40; x++) w.model.set(x, y, z, material(1, 2));
      w.lights.push({ id: 'arriba', kind: 'torch', x: 32.5, y: 16.5, z: 14, radius: 30 });
      const b = bakeWorld(w, { topZ: 20 });
      // Los pesos en las caras de arriba del suelo (z = 0) bajo la copa
      let sum = 0;
      const bl = b.lights[0]!;
      for (let j = 0; j < bl.rect.h; j++) for (let i = 0; i < bl.rect.w; i++) {
        const idx = (bl.rect.y + j) * b.width + bl.rect.x + i;
        const k = b.pick[idx]!;
        if (Number.isNaN(k) || b.face[idx] !== 4) continue;
        const [x, y, z] = unkey(k);
        if (z !== 0 || x < 24 || x >= 40 || y < 8 || y >= 24) continue;   // el suelo justo debajo de la copa
        sum += bl.weight[j * bl.rect.w + i]!;
      }
      return sum;
    };
    const fol = lightUnder('foliage'), solid = lightUnder('solid'), none = lightUnder('none');
    expect(fol).toBeGreaterThan(solid);
    expect(fol).toBeLessThan(none);
  });

  it('con el agua como fluido (el juego), juncos en la orilla poco honda y nenúfares a ras del agua', () => {
    let world!: World;
    buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval', { decorate: (w) => { world = w; } });
    const m = world.model, depth = worldWaterDepth(world);
    const pal = { ...m.palette, ramps: [...m.palette.ramps, structuredClone(FOLIAGE_RAMPS.junco!), structuredClone(FOLIAGE_RAMPS.nenufar!)] };
    m.palette = pal;
    const all = [0, 0, m.width - 1, m.depth - 1] as const;
    const reeds = planFoliage(m, ...all, m.zMax, { type: 'reeds', ramp: pal.ramps.length - 2, zMin: m.zMin, waterDepth: depth, density: 1 });
    const lilies = planFoliage(m, ...all, m.zMax, { type: 'lilies', ramp: pal.ramps.length - 1, zMin: m.zMin, waterDepth: depth, density: 0.2 });
    expect(reeds.plants).toBeGreaterThan(20);
    expect(lilies.plants).toBeGreaterThan(20);
    for (const [x, y] of reeds.voxels) { const d = Math.round(depth(x, y)); expect(d).toBeGreaterThanOrEqual(1); expect(d).toBeLessThanOrEqual(2); }
    // Con el agua fluida, los nenúfares no son vóxeles sino flotantes (floaters.ts), sobre agua de 1 o más
    expect(lilies.voxels.length).toBe(0);
    expect(lilies.floats.length).toBe(lilies.plants);
    for (const [x, y] of lilies.floats) expect(Math.round(depth(Math.floor(x), Math.floor(y)))).toBeGreaterThanOrEqual(1);
  });
});
