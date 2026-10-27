// El sistema de materiales (src/core/materials.ts): cada rampa es un juego de propiedades que el motor lee por
// separado. El vidrio deja pasar la luz pero no el agua ni el paso; un material solo de reflejo no cambia nada aún.
import { describe, it, expect } from 'vitest';
import { Model, box, material, unkey, render, camera, lightField3D, rampMaterial, materialsOf, sunCost, SUN_OPAQUE, SUN_UNIT, MATERIALS, type PointLight3D, type RenderOptions, type Ramp } from '../src/core';
import { bakeWorld } from '../src/world/bake';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import type { World } from '../src/world/build';
import { Runtime } from '../src/runtime/runtime';

describe('las propiedades de una rampa', () => {
  it('sin material es el sólido; los materiales con nombre y las props se suman encima; la forma vieja sigue valiendo', () => {
    const r = (x: Partial<Ramp>): Ramp => ({ name: 'r', colors: ['#000000'], ...x });
    expect(rampMaterial(r({}))).toEqual({ light: 0, backlit: 0, bed: true, blocks: true, climb: true, emissive: false, reflect: 0, density: 2400, crush: false });
    expect(rampMaterial(r({ material: 'vidrio' }))).toMatchObject({ light: 0.85, bed: true, blocks: true });
    expect(rampMaterial(r({ material: 'vidrio', props: { light: 0.6 } })).light).toBe(0.6);
    expect(rampMaterial(r({ kind: 'foliage' }))).toEqual(rampMaterial(r({ material: 'follaje' })));
    expect(rampMaterial(r({ kind: 'foliage', blocks: true }))).toEqual(rampMaterial(r({ material: 'arbusto' })));
    expect(rampMaterial(r({ emissive: true })).emissive).toBe(true);
    expect(() => rampMaterial(r({ material: 'plastilina' }))).toThrow('no hay material "plastilina" (rampa r); los materiales son: solido, follaje, arbusto, atravesable, vidrio, metal');
    expect(() => rampMaterial(r({ props: { brillo: 1 } as never }))).toThrow(/propiedad "brillo"/);
    expect(() => new Model({ ramps: [r({ material: 'plastilina' })] })).toThrow(/no hay material/);
    expect(Object.keys(MATERIALS)).toEqual(expect.arrayContaining(['solido', 'follaje', 'arbusto', 'vidrio', 'metal']));
  });

  it('el sol en enteros: el follaje gasta una hoja (SUN_UNIT), el vidrio poco, lo opaco todo', () => {
    expect(sunCost(0.5)).toBe(SUN_UNIT);
    expect(sunCost(0.85)).toBe(1);
    expect(sunCost(0)).toBe(SUN_OPAQUE);
    expect(sunCost(1)).toBe(0);
  });

  it('una paleta sin nada especial (o solo con reflejo, que aún no pinta nadie) no tiene tabla: el camino de siempre', () => {
    expect(materialsOf({ ramps: [{ name: 'a', colors: ['#101010'] }] })).toBeNull();
    expect(materialsOf({ ramps: [{ name: 'a', colors: ['#101010'], material: 'metal' }] })).toBeNull();
    const t = materialsOf({ ramps: [{ name: 'a', colors: ['#101010'] }, { name: 'v', colors: ['#88aacc', '#aaccee'], material: 'vidrio' }] })!;
    expect(t.light[material(1, 1)]).toBeCloseTo(0.85, 6);
    expect(t.light[material(0, 0)]).toBe(0);
    expect(t.blocks[material(1, 0)]).toBe(1);
  });
});

const PAL = { ramps: [
  { name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] },
  { name: 'vidrio', colors: ['#2a4a5e', '#4a7a94', '#8ab8d0'], material: 'vidrio' },
] };

describe('el vidrio', () => {
  it('deja pasar la luz de una lámpara: el suelo de detrás de una pared de vidrio recibe casi toda la luz, y tras una opaca nada', () => {
    const make = (glass: boolean) => {
      const m = new Model(structuredClone(PAL));
      box(m, 0, 0, 0, 30, 30, 0, material(0, 2));
      box(m, 0, 15, 1, 30, 15, 8, material(glass ? 1 : 0, 1));          // una pared en y = 15
      return m;
    };
    const lights: PointLight3D[] = [{ x: 15.5, y: 20.5, z: 4.5, radius: 20, color: [1, 1, 1], intensity: 1 }];   // al norte
    const o: RenderOptions = { width: 120, height: 100, originX: 60, originY: 75, yaw: 0, elevation: 60, pick: true };
    const southFloor = (m: Model) => {
      const img = render(m, o);
      const t = lightField3D(m, img, camera(o), lights, [0, 0, 0], { floor: false });
      let s = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        const k = img.pickKey![i]!;
        if (Number.isNaN(k) || img.pickFace![i] !== 4) continue;
        const [, y, z] = unkey(k);
        if (z === 0 && y < 15) s += t[i * 3]!;                         // caras de arriba del suelo al sur de la pared
      }
      return s;
    };
    const glass = southFloor(make(true)), wall = southFloor(make(false));
    expect(wall).toBe(0);
    expect(glass).toBeGreaterThan(0);
  });

  it('en el mundo: no deja pasar el agua (es fondo y pared) ni al jugador, y la luz horneada lo atraviesa', () => {
    const W = 32, D = 24;
    const mk = (mat: number): World => {
      const model = new StaticVoxels(structuredClone(PAL), W, D, -4, 20);
      const wet = new Uint8Array(W * D), waterTop = new Int8Array(W * D);
      for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) model.set(x, y, 0, material(0, 1));
      for (let z = 1; z <= 9; z++) for (let y = 0; y < D; y++) model.set(16, y, z, mat);    // una pared en x = 16
      return { model, lights: [{ id: 'l', kind: 'torch', x: 22.5, y: 12.5, z: 5, radius: 24 }], width: W, depth: D, wet, waterTop, fountain: null };
    };
    const glass = mk(material(1, 1)), stone = mk(material(0, 2));
    // El agua: el vidrio cuenta como fondo y como pared (más de 8 de alto), igual que la piedra
    const wg = new WaterLayer(glass), ws = new WaterLayer(stone);
    expect(Buffer.from(wg.sim.solid).equals(Buffer.from(ws.sim.solid))).toBe(true);
    expect(glass.model.floorAt(16, 5)).toBe(10);
    // El paso
    const s = new WorldState(glass.model, [], null);
    expect(s.solidAt(16.5, 5.5, 3)).toBe(true);
    expect(s.groundAt(16.5, 5.5)).toBe(10);
    // La luz horneada (al este de la pared) llega al suelo del oeste a través del vidrio y no a través de la piedra
    const west = (w: World) => {
      const b = bakeWorld(w, { topZ: 16 });
      const bl = b.lights[0]!;
      let sum = 0;
      for (let j = 0; j < bl.rect.h; j++) for (let i = 0; i < bl.rect.w; i++) {
        const sx = bl.rect.x + i;
        if (sx > 14) continue;                                  // a la izquierda (oeste) de la pared en pantalla
        sum += bl.weight[j * bl.rect.w + i]!;
      }
      return sum;
    };
    expect(west(stone)).toBe(0);
    expect(west(glass)).toBeGreaterThan(0);
  });
});

// FERN (medieval, semilla 1): la cúpula de un arbusto (alturas 1-2-3-4) se subía como una escalera con step 2, y desde
// la cima el cuerpo pasaba a lo alto de la pared sur. Un arbusto no se sube ni se pisa (climb: false), a cualquier altura
describe('los arbustos no se suben', () => {
  const PAL = { ramps: [{ name: 'suelo', colors: ['#404040'] }, { name: 'arbusto', colors: ['#2f6b32'], material: 'arbusto' }, { name: 'muro', colors: ['#606060'] }] };
  function scene(): WorldState {
    const s = new StaticVoxels(structuredClone(PAL), 40, 24, -2, 12);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 40; x++) s.set(x, y, 0, material(0, 0));
    // Una escalera de arbusto (1, 2, 3, 4 de alto, de 2 en 2 columnas) y una pared de 6 justo detrás de la cima
    for (let k = 0; k < 4; k++) for (let x = 10 + k * 2; x < 12 + k * 2; x++) for (let y = 4; y < 20; y++) for (let z = 1; z <= k + 1; z++) s.set(x, y, z, material(1, 0));
    for (let x = 18; x < 22; x++) for (let y = 4; y < 20; y++) for (let z = 1; z <= 6; z++) s.set(x, y, z, material(2, 0));
    return new WorldState(s, [], null);
  }

  it('la columna de arbusto no se pisa a ninguna altura; el suelo y la pared, como siempre', () => {
    const w = scene();
    expect(w.standable(10.5, 10.5, 1, 2)).toBe(false);      // el primer escalón (1 sobre el suelo)
    expect(w.standable(16.5, 10.5, 4, 2)).toBe(false);      // la cima, viniendo de su misma altura
    expect(w.standable(16.5, 10.5, 9, 2)).toBe(false);      // ni cayendo desde arriba
    expect(w.standable(5.5, 10.5, 1, 2)).toBe(true);
    expect(w.standable(19.5, 10.5, 6, 2)).toBe(true);       // lo alto de la pared sigue siendo pisable desde su altura
    expect(w.solid.climbableAt(5, 10)).toBe(true);
  });

  it('un cuerpo que empuja contra la escalera de arbusto se queda en el suelo', () => {
    const w = scene();
    const rt = new Runtime(w, { x: 5, y: 12 }, { radius: 4, speed: 70 });
    for (let t = 0; t < 240; t++) rt.step({ dx: 1, dy: 0, stomp: false });
    expect(rt.player.z).toBe(1);
    expect(rt.player.x).toBeLessThan(10);
  });

  it('una paleta sin materiales que no se suben sigue por el camino de siempre', () => {
    expect(materialsOf({ ramps: [{ name: 'a', colors: ['#000000'] }] })).toBeNull();
  });
});
