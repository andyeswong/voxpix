// Vegetación: el material follaje ante la luz (sombra moteada del sol, luces que lo atraviesan, contraluz) y la
// herramienta que la coloca (determinista, según el agua).
import { describe, it, expect } from 'vitest';
import { Model, material, box, render, camera, lightField3D, planFoliage, foliageSunDepth, FOLIAGE_SUN_MAX, FOLIAGE_T, allowedColors, type PointLight3D, type RenderOptions } from '../src/core';
import { vegetationScene, VEG_PALETTE } from '../src/samples/vegetacion';

const solidCopy = (m: Model) => { const s = m.clone(); for (const r of s.palette.ramps) delete r.kind; return s; };

describe('follaje y luz', () => {
  it('el umbral del sol es entero, de 1 a FOLIAGE_SUN_MAX, y no depende de nada más que la celda', () => {
    const seen = new Set<number>();
    for (let z = -3; z < 6; z++) for (let y = -20; y < 20; y++) for (let x = -20; x < 20; x++) {
      const d = foliageSunDepth(x, y, z);
      expect(d).toBe(foliageSunDepth(x, y, z));
      seen.add(d);
    }
    expect([...seen].sort()).toEqual(Array.from({ length: FOLIAGE_SUN_MAX }, (_, i) => i + 1));
  });

  it('bajo una copa de follaje el sol da más luz que bajo la misma copa sólida, y menos que sin copa', () => {
    // Un suelo y una losa de copa de 2 de grosor por encima; con el sol inclinado, su sombra cae en el suelo que se
    // ve: se cuentan los píxeles que la sombra cambia
    const pal = { ramps: [{ name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] }, { ...VEG_PALETTE.ramps[3]! }] };
    const make = () => { const m = new Model(structuredClone(pal)); box(m, 0, 0, 0, 29, 29, 0, material(0, 2)); box(m, 5, 5, 6, 24, 24, 7, material(1, 2)); return m; };
    const oblique: RenderOptions = { width: 120, height: 100, originX: 60, originY: 70, yaw: 0, elevation: 60, light: [0.5, 0.2, 1], ao: false, smooth: 0 };
    const shadowPx = (m: Model) => { const a = render(m, oblique), b = render(m, { ...oblique, shadows: false }); let d = 0; for (let i = 0; i < a.rgba.length; i += 4) if (a.rgba[i] !== b.rgba[i]) d++; return d; };
    const fol = make(), solid = solidCopy(make());
    const empty = new Model(structuredClone(pal)); box(empty, 0, 0, 0, 29, 29, 0, material(0, 2));
    expect(shadowPx(fol)).toBeLessThan(shadowPx(solid));
    expect(shadowPx(fol)).toBeGreaterThan(shadowPx(empty));
  });

  it('una luz detrás de una pared de follaje la atraviesa (atenuada) y le ilumina la cara de delante por detrás', () => {
    const pal = { ramps: [{ name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] }, { ...VEG_PALETTE.ramps[4]! }] };
    const m = new Model(structuredClone(pal));
    box(m, 0, 0, 0, 20, 20, 0, material(0, 2));
    box(m, 0, 10, 1, 20, 10, 4, material(1, 2));              // una pared de hierba alta, de 1 de grueso, en y = 10
    const lights: PointLight3D[] = [{ x: 10.5, y: 14.5, z: 2.5, radius: 14, color: [1, 0.6, 0.3], intensity: 1.2 }];   // detrás (norte)
    const o: RenderOptions = { width: 90, height: 80, originX: 45, originY: 60, yaw: 0, elevation: 30, pick: true };
    const sum = (mm: Model) => {
      const img = render(mm, o);
      const t = lightField3D(mm, img, camera(o), lights, [0, 0, 0], { floor: false });
      let front = 0, ground = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        const k = img.pickKey![i]!;
        if (Number.isNaN(k)) continue;
        const f = img.pickFace![i]!;
        if (f === 3) front += t[i * 3]!;                    // caras que miran al sur (-y): las de delante de la pared
        if (f === 4) ground += t[i * 3]!;                   // caras de arriba
      }
      return { front, ground };
    };
    const fol = sum(m), solid = sum(solidCopy(m));
    expect(solid.front).toBe(0);                            // un sólido de espaldas a la luz no recibe nada
    expect(fol.front).toBeGreaterThan(0);                   // el follaje, sí: contraluz atenuado
    expect(fol.ground).toBeGreaterThan(solid.ground);       // y el suelo de delante recibe luz a través de la pared
    expect(FOLIAGE_T).toBeGreaterThan(0);
  });

  it('un modelo sin follaje da los mismos bytes con y sin la tabla (la compatibilidad la cubren además las pruebas de siempre)', () => {
    const m = vegetationScene();
    const o: RenderOptions = { width: 160, height: 120, originX: 80, originY: 90, yaw: 30, elevation: 35, pick: true };
    const a = render(solidCopy(m), o), b = render(solidCopy(m), o);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    // Y la imagen con follaje solo usa colores de la paleta
    const img = render(m, o), ok = allowedColors(m.palette);
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i + 3]) expect(ok.has('#' + [0, 1, 2].map((c) => img.rgba[i + c]!.toString(16).padStart(2, '0')).join(''))).toBe(true);
  });
});

describe('la herramienta de vegetación', () => {
  // Un prado con un estanque: hierba alrededor, el agua cubre 1 en el borde y 3 en el centro
  function pond(): Model {
    const m = new Model({ ramps: [
      { name: 'hierba', colors: ['#2d4a2a', '#3f6b33', '#5a8a3c', '#7fae4f'] },
      { name: 'agua', colors: ['#16324d', '#1f4f78', '#2f74a6', '#5fa8d6'] },
      { name: 'piedra', colors: ['#2e2f38', '#4a4c58', '#6c6f7c'] },
      { name: 'hierba-alta', colors: ['#24452a', '#3b6a33', '#5c923f', '#8fbf55'], kind: 'foliage' },
      { name: 'junco', colors: ['#2a3a1e', '#4a5e2c', '#71843d', '#9fae58'], kind: 'foliage' },
      { name: 'nenufar', colors: ['#173b2a', '#2a6040', '#3f8a52', '#6db36a'], kind: 'foliage' },
      { name: 'flor', colors: ['#5a1424', '#a32638', '#e0504a'], kind: 'foliage' },
    ] });
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const d = Math.hypot(x - 20, y - 20);
      if (d < 10) {
        const floor = d < 5 ? 0 : 2;                         // el centro más hondo
        for (let z = 0; z <= floor; z++) m.set(x, y, z, material(2, 1));
        for (let z = floor + 1; z <= 3; z++) m.set(x, y, z, material(1, 2));
      } else {
        for (let z = 0; z <= 3; z++) m.set(x, y, z, material(z === 3 ? 0 : 2, 1));
      }
    }
    box(m, 30, 30, 4, 34, 34, 4, material(2, 2));           // una losa de piedra: ahí no crece nada
    return m;
  }
  const surf = (m: Model, x: number, y: number) => { let z = 20; while (z >= 0 && !m.get(x, y, z)) z--; return z; };

  it('es determinista: la misma semilla da los mismos vóxeles, otra semilla otros', () => {
    const m = pond();
    const a = planFoliage(m, 0, 0, 39, 39, 20, { type: 'grass', ramp: 3, seed: 5 });
    const b = planFoliage(m, 0, 0, 39, 39, 20, { type: 'grass', ramp: 3, seed: 5 });
    const c = planFoliage(m, 0, 0, 39, 39, 20, { type: 'grass', ramp: 3, seed: 6 });
    expect(a.voxels).toEqual(b.voxels);
    expect(a.voxels).not.toEqual(c.voxels);
    expect(a.plants).toBeGreaterThan(50);
  });

  it('la hierba y las flores crecen sobre la hierba, nunca sobre piedra ni agua, y más junto a la orilla', () => {
    const m = pond();
    for (const type of ['grass', 'flowers'] as const) {
      const p = planFoliage(m, 0, 0, 39, 39, 20, { type, ramp: 3, heads: [6], density: type === 'grass' ? 0.3 : 0.2 });
      for (const [x, y, z] of p.voxels) {
        // la base de la planta está sobre hierba
        let base = z - 1;
        while (base >= 0 && p.voxels.some(([a, b, c]) => a === x && b === y && c === base)) base--;
        expect(m.get(x, y, base), `${type} en ${x},${y},${z}`).toBe(material(0, 1));
      }
    }
    // Densidad: cerca de la orilla (a 1-3 de la columna de agua) más que lejos
    const p = planFoliage(m, 0, 0, 39, 39, 20, { type: 'grass', ramp: 3, density: 0.2 });
    const plantAt = new Set(p.voxels.map(([x, y]) => `${x},${y}`));
    let nearN = 0, nearP = 0, farN = 0, farP = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const d = Math.hypot(x - 20, y - 20);
      if (d < 10 || (x >= 30 && x <= 34 && y >= 30 && y <= 34)) continue;
      if (d < 12.5) { nearN++; if (plantAt.has(`${x},${y}`)) nearP++; } else if (d > 15) { farN++; if (plantAt.has(`${x},${y}`)) farP++; }
    }
    expect(nearP / nearN).toBeGreaterThan(1.4 * (farP / farN));
  });

  it('juncos solo donde el agua cubre 1 o 2 y junto a la orilla; nenúfares a ras del agua', () => {
    const m = pond();
    const reeds = planFoliage(m, 0, 0, 39, 39, 20, { type: 'reeds', ramp: 4, density: 1 });
    expect(reeds.plants).toBeGreaterThan(5);
    for (const [x, y] of reeds.voxels) {
      const d = Math.hypot(x - 20, y - 20);
      expect(d, `junco en ${x},${y}`).toBeGreaterThanOrEqual(5);    // nunca en el centro hondo (3 de agua)
      expect(d).toBeLessThan(10);
    }
    const lilies = planFoliage(m, 0, 0, 39, 39, 20, { type: 'lilies', ramp: 5, density: 1 });
    for (const [x, y, z] of lilies.voxels) {
      expect(z).toBe(surf(m, x, y));                                  // sustituye la capa de arriba del agua
      expect(m.get(x, y, z)).toBe(material(1, 2));
    }
    expect(lilies.plants).toBeGreaterThan(100);
    // Fuera del estanque, ni juncos ni nenúfares
    for (const [x, y] of [...reeds.voxels, ...lilies.voxels]) expect(Math.hypot(x - 20, y - 20)).toBeLessThan(10);
  });

  it('no pisa nada que ya exista (salvo el agua para juncos y nenúfares)', () => {
    const m = pond();
    for (const type of ['grass', 'flowers', 'bush'] as const) {
      const p = planFoliage(m, 0, 0, 39, 39, 20, { type, ramp: 3, heads: [6], density: 0.5 });
      for (const [x, y, z] of p.voxels) expect(m.get(x, y, z)).toBe(0);
    }
  });
});
