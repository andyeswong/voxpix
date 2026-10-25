import { describe, it, expect } from 'vitest';
import { Model, material, box } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D, entitySprite, entityRenderCount, MAX_ENTITY_RENDERS } from '../src/world/frame2d';
import type { World } from '../src/world/build';

const PAL = { ramps: [{ name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] }] };
const AMB = [0.3, 0.3, 0.3] as const;

function world(): { state: WorldState; bake: () => ReturnType<typeof bakeWorld>; body: Model } {
  const s = new StaticVoxels(structuredClone(PAL), 96, 64, -4, 30);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) s.set(x, y, 0, material(0, 2));
  const state = new WorldState(s, [], null);
  const body = new Model({ ramps: [{ name: 'cuerpo', colors: ['#400000', '#800000', '#c00000'] }] });
  box(body, -2, -2, 0, 2, 2, 12, material(0, 1));
  const w = { model: s, lights: [], width: 96, depth: 64 } as unknown as World;
  return { state, body, bake: () => bakeWorld(w, { topZ: 30, incline: 0.5 }) };
}

const lum = (rgba: Uint8ClampedArray, i: number) => rgba[i * 4]! + rgba[i * 4 + 1]! + rgba[i * 4 + 2]!;

describe('entidades con id', () => {
  it('add da un id numérico; move y remove; la huella y restore las incluyen', () => {
    const { state, body } = world();
    const id = state.entities.add({ model: body, x: 40, y: 30, z: 1, facing: 90 });
    expect(typeof id).toBe('number');
    expect(state.entities.get(id)!.yaw).toBe(90);
    const h0 = state.hash();
    const snap = state.snapshot();
    state.entities.move(id, 45, 30, 1, 180);
    expect(state.hash()).not.toBe(h0);
    const id2 = state.entities.add({ model: body, x: 10, y: 10, z: 1 });
    state.entities.remove(id);
    expect(state.entities.get(id)).toBeUndefined();
    state.restore(snap);
    expect(state.entities.get(id)!.x).toBe(40);
    expect(state.entities.get(id2)).toBeUndefined();
    expect(state.hash()).toBe(h0);
  });

  it('el mismo modelo se registra una vez (sus rampas no se repiten en la paleta)', () => {
    const { state, body } = world();
    const n0 = state.palette.ramps.length;
    state.entities.add({ model: body, x: 10, y: 10, z: 1 });
    state.entities.add({ model: body, x: 20, y: 10, z: 1 });
    expect(state.palette.ramps.length).toBe(n0 + 1);
  });

  it('setModel cambia el modelo (los cuadros de un walk comparten rampas), entra en la huella y marca la zona', () => {
    const { state, body } = world();
    const step = new Model(body.palette);                 // otro cuadro: la misma paleta
    box(step, -2, -2, 0, 2, 2, 11, material(0, 2));
    const n0 = state.palette.ramps.length;
    const id = state.entities.add({ model: body, x: 40, y: 30, z: 1 });
    const snap = state.snapshot();
    const h0 = state.hash();
    const v0 = state.solid.clock;
    state.entities.setModel(id, step);
    const e = state.entities.get(id)!;
    expect(e.model).toBe(step);
    expect(state.palette.ramps.length).toBe(n0 + 1);
    expect(state.hash()).not.toBe(h0);
    expect(state.changedSince(v0, 'all').length).toBeGreaterThan(0);
    // el mismo modelo otra vez (por id): no cambia nada ni marca
    const v1 = state.solid.clock;
    state.entities.setModel(id, e.modelId);
    expect(state.changedSince(v1, 'all')).toEqual([]);
    state.restore(snap);
    expect(state.entities.get(id)!.model).toBe(body);
    expect(state.hash()).toBe(h0);
  });
});

describe('luces con id', () => {
  it('una luz dinámica alumbra el suelo cerca, y al quitarla todo vuelve a estar como antes', () => {
    const { state, bake } = world();
    const b = bake();
    const opts = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: AMB };
    const before = frame2D(state, b, opts);
    const [sx, sy] = b.cam.project(48, 32, 1);
    const i = Math.floor(sy) * b.width + Math.floor(sx);
    const id = state.lights.add({ kind: 'lamp', x: 48, y: 32, z: 10 });
    const lit = frame2D(state, b, opts);
    expect(lum(lit, i)).toBeGreaterThan(lum(before, i) + 30);
    state.lights.move(id, 5, 5, 10);
    expect(lum(frame2D(state, b, opts), i)).toBeLessThan(lum(lit, i));
    state.lights.remove(id);
    expect(frame2D(state, b, opts)).toEqual(before);
  });

  it('las luces del worldgen están horneadas: no se mueven', () => {
    const s = new StaticVoxels(structuredClone(PAL), 16, 16, -2, 10);
    const state = new WorldState(s, [{ id: 'antorcha', kind: 'torch', x: 4, y: 4, z: 6 }], null);
    expect(state.lights[0]!.baked).toBe(true);
    expect(() => state.lights.move('antorcha', 1, 1, 1)).toThrow(/horneada/);
  });
});

describe('sombra de las entidades', () => {
  it('el suelo detrás del cuerpo (respecto a la luz) queda más oscuro con castsShadow', () => {
    const { state, bake, body } = world();
    const b = bake();
    state.lights.add({ kind: 'lamp', x: 64, y: 32, z: 8 });              // luz al este, baja
    const id = state.entities.add({ model: body, x: 44, y: 32, z: 1 });
    const opts = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: AMB };
    // Un punto del suelo al oeste del cuerpo: el cuerpo está entre él y la luz
    const [sx, sy] = b.cam.project(36, 32, 1);
    const i = Math.floor(sy) * b.width + Math.floor(sx);
    const withShadow = frame2D(state, b, opts);
    state.entities.get(id)!.castsShadow = false;
    const without = frame2D(state, b, opts);
    expect(lum(withShadow, i)).toBeLessThan(lum(without, i) - 20);
    // Y un punto al este (entre el cuerpo y la luz) no cambia
    const [ex, ey] = b.cam.project(52, 32, 1);
    const j = Math.floor(ey) * b.width + Math.floor(ex);
    expect(lum(withShadow, j)).toBe(lum(without, j));
  });
});

describe('ids deterministas (los tres detalles de FERN)', () => {
  it('restore seguido de add da el mismo id que en la partida original', () => {
    const { state, body } = world();
    state.entities.add({ model: body, x: 1, y: 1, z: 1 });
    const snap = state.snapshot();
    const a = state.entities.add({ model: body, x: 2, y: 2, z: 1 });
    const la = state.lights.add({ kind: 'torch', x: 5, y: 5, z: 5 });
    state.restore(snap);
    expect(state.entities.add({ model: body, x: 2, y: 2, z: 1 })).toBe(a);
    expect(state.lights.add({ kind: 'torch', x: 5, y: 5, z: 5 })).toBe(la);
  });

  it('remove no devuelve su id: los nuevos siempre crecen', () => {
    const { state, body } = world();
    const a = state.entities.add({ model: body, x: 1, y: 1, z: 1 }) as number;
    state.entities.remove(a);
    const b = state.entities.add({ model: body, x: 1, y: 1, z: 1 }) as number;
    expect(b).toBeGreaterThan(a);
    const l1 = state.lights.add({ kind: 'lamp', x: 1, y: 1, z: 4 }) as number;
    state.lights.remove(l1);
    expect(state.lights.add({ kind: 'lamp', x: 1, y: 1, z: 4 }) as number).toBeGreaterThan(l1);
  });

  it('una luz dinámica es estado: añadirla, moverla o quitarla cambia la huella', () => {
    const { state } = world();
    const h0 = state.hash();
    const id = state.lights.add({ kind: 'lamp', x: 10, y: 10, z: 6 });
    const h1 = state.hash();
    state.lights.move(id, 11, 10, 6);
    const h2 = state.hash();
    expect(new Set([h0, h1, h2]).size).toBe(3);
  });
});


describe('quién da sombra de verdad', () => {
  it("castsShadow 'always' entra siempre en las MAX_CASTERS, aunque esté lejos del centro", async () => {
    const { shadowCasters, MAX_CASTERS } = await import('../src/world/frame2d');
    const { state, body, bake } = world();
    const b = bake();
    const o = { vx: 0, vy: 0, vw: 96, vh: 60, time: 0, lights: true, ambient: AMB };
    // muchas cerca del centro, y la 'always' en una esquina
    const far = state.entities.add({ model: body, x: 2, y: 2, z: 1, castsShadow: 'always' });
    for (let k = 0; k < MAX_CASTERS + 4; k++) state.entities.add({ model: body, x: 44 + (k % 4), y: 28 + Math.floor(k / 4), z: 1 });
    const casters = shadowCasters(state, b, o);
    expect(casters).toHaveLength(MAX_CASTERS);
    expect(casters.map((e) => e.id)).toContain(far);
    // y la huella distingue 'always' de true
    const h = state.hash();
    state.entities.get(far)!.castsShadow = true;
    expect(state.hash()).not.toBe(h);
  });
});

describe('luces que van con una entidad (follow)', () => {
  it('se colocan con el offset y la dirección girados con su facing, al final del tick, y entran en la huella', () => {
    const { state, body } = world();
    const id = state.entities.add({ model: body, x: 40, y: 30, z: 1, facing: 0 });
    const lid = state.lights.add({ kind: 'lamp', x: 0, y: 0, z: 0, cone: 40, follow: { entity: id, offset: [0, -7, 1], dir: [0, -1, -0.3] } });
    const l = state.lights.get(lid)!;
    expect(l.owner).toBe(id);
    // mirando al sur (facing 0): delante es -y
    expect([l.x, l.y, l.z]).toEqual([40.5, 23, 2]);
    expect(l.dir![1]).toBeCloseTo(-1);
    const h0 = state.hash();
    // mirando al este (facing 90): delante es +x
    state.entities.move(id, 50, 30, 1, 90);
    state.step();
    expect(l.x).toBeCloseTo(57.5); expect(l.y).toBeCloseTo(30); expect(l.z).toBe(2);
    expect(l.dir![0]).toBeCloseTo(1); expect(l.dir![1]).toBeCloseTo(0);
    expect(state.hash()).not.toBe(h0);
  });
});

describe('caché de renders de entidad', () => {
  it('con giros libres no crece sin fin: suelta los menos usados', () => {
    const { state, body, bake } = world();
    const b = bake();
    const id = state.entities.add({ model: body, x: 40, y: 30, z: 1, facing: 0 });
    const e = state.entities.get(id)!;
    const o = { vx: 0, vy: 0, vw: 96, vh: 64, time: 0, lights: false, ambient: AMB };
    for (let i = 0; i < MAX_ENTITY_RENDERS + 200; i++) { e.yaw = i * 0.25; entitySprite(b, e, o); }
    expect(entityRenderCount()).toBe(MAX_ENTITY_RENDERS);
    // El último sigue en la caché (mismo objeto) y uno de los primeros se volvió a renderizar
    e.yaw = (MAX_ENTITY_RENDERS + 199) * 0.25;
    const last = entitySprite(b, e, o).img;
    expect(entitySprite(b, e, o).img).toBe(last);
  });
});

describe('tinte de entidad (destello de golpe)', () => {
  it('pinta sus vóxeles del color del tinte con luz propia, el contorno se queda, y se quita con null', () => {
    const { state, body, bake } = world();
    const b = bake();
    const id = state.entities.add({ model: body, x: 40, y: 30, z: 1, facing: 0 });
    const o = { vx: 0, vy: 0, vw: 96, vh: 64, time: 0, lights: true, ambient: [0.2, 0.2, 0.2] as const, outline: 'outer' as const, outlineColor: '#0d0c12' };
    const plain = frame2D(state, b, o);
    state.entities.setTint(id, [1, 1, 1]);
    const white = frame2D(state, b, o);
    let tinted = 0, other = 0;
    for (let i = 0; i < 96 * 64; i++) {
      const w = [white[i * 4]!, white[i * 4 + 1]!, white[i * 4 + 2]!];
      if (w.every((v) => v === 255)) { tinted++; continue; }
      if (w.some((v, c) => v !== plain[i * 4 + c])) other++;
    }
    expect(tinted).toBeGreaterThan(20);                     // el cuerpo, blanco puro aunque el ambiente sea 0,2
    expect(other).toBe(0);                                  // y lo demás (el contorno, el suelo) no cambia
    state.entities.setTint(id, null);
    expect(frame2D(state, b, o)).toEqual(plain);
  });
});
