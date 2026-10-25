// Color para la paleta (src/core/color.ts) y el deshacer de los cambios de paleta (History.setPalette)
import { describe, it, expect } from 'vitest';
import { rampFromColor, groupIntoRamps, parsePaletteText, hexToLch, hexToLab, labToHex, hueName, Model, History, material } from '../src/core';
import { PRESET_PALETTES } from '../src/samples/palettes';

describe('rampFromColor', () => {
  for (const base of ['#3f6b33', '#c0392b', '#2f74a6', '#808080', '#f4e04d', '#1a1020']) {
    it(`de ${base}: n tonos válidos, el base dentro, de oscuro a claro`, () => {
      for (const tones of [3, 5, 8]) {
        const r = rampFromColor(base, { tones });
        expect(r).toHaveLength(tones);
        expect(r).toContain(base);
        for (const c of r) expect(c).toMatch(/^#[0-9a-f]{6}$/);
        const L = r.map((c) => hexToLch(c)[0]);
        for (let i = 1; i < L.length; i++) expect(L[i]!).toBeGreaterThan(L[i - 1]!);
      }
    });
  }
  it('las sombras giran hacia el frío y las luces hacia el cálido (en un verde)', () => {
    const r = rampFromColor('#3f6b33', { tones: 5 });
    const h = r.map((c) => hexToLch(c)[2]);
    const b = r.indexOf('#3f6b33');
    expect(h[0]!).toBeGreaterThan(h[b]!);           // más hacia el azul (más grados)
    expect(h[r.length - 1]!).toBeLessThan(h[b]!);   // más hacia el amarillo
  });
  it('un gris sigue gris', () => {
    for (const c of rampFromColor('#808080', { tones: 5 })) expect(hexToLch(c)[1]).toBeLessThan(0.02);
  });
});

describe('OKLab', () => {
  it('ida y vuelta sin perder el color', () => {
    for (const c of ['#000000', '#ffffff', '#ff004d', '#29adff', '#3f6b33']) expect(labToHex(hexToLab(c))).toBe(c);
  });
  it('nombres de tono', () => {
    expect(hueName('#3f6b33')).toBe('verde');
    expect(hueName('#2f74a6')).toBe('azul');
    expect(hueName('#808080')).toBe('gris');
  });
});

describe('groupIntoRamps', () => {
  for (const p of PRESET_PALETTES) {
    it(`${p.name}: todos sus colores, una vez, en rampas de oscuro a claro`, () => {
      const ramps = groupIntoRamps(p.colors);
      const all = ramps.flatMap((r) => r.colors);
      expect(all.sort()).toEqual([...new Set(p.colors)].sort());
      for (const r of ramps) {
        expect(r.colors.length).toBeLessThanOrEqual(16);
        const L = r.colors.map((c) => hexToLch(c)[0]);
        for (let i = 1; i < L.length; i++) expect(L[i]!).toBeGreaterThanOrEqual(L[i - 1]!);
      }
      expect(new Set(ramps.map((r) => r.name)).size).toBe(ramps.length);   // nombres distintos
    });
  }
});

describe('parsePaletteText', () => {
  it('lee .hex, .gpl y listas sueltas', () => {
    expect(parsePaletteText('ff004d\n29ADFF\n\n')).toEqual(['#ff004d', '#29adff']);
    expect(parsePaletteText('GIMP Palette\nName: x\n#\n255   0  77\tRojo\n 41 173 255 Azul\n')).toEqual(['#ff004d', '#29adff']);
    expect(parsePaletteText('#ff004d, #29adff #ff004d')).toEqual(['#ff004d', '#29adff']);
  });
});

describe('deshacer un cambio de paleta', () => {
  it('la paleta y los vóxeles vuelven juntos', () => {
    const m = new Model({ ramps: [{ name: 'a', colors: ['#000000', '#ffffff'] }] });
    m.set(0, 0, 0, material(0, 1));
    const h = new History(m);
    const before = m.palette;
    h.begin();
    h.set(0, 0, 0, material(1, 0));
    h.setPalette({ ramps: [...before.ramps, { name: 'b', colors: ['#ff0000'] }] });
    expect(h.commit()).toBe(true);
    expect(m.palette.ramps).toHaveLength(2);
    h.undo();
    expect(m.palette).toBe(before);
    expect(m.get(0, 0, 0)).toBe(material(0, 1));
    h.redo();
    expect(m.palette.ramps).toHaveLength(2);
    expect(m.get(0, 0, 0)).toBe(material(1, 0));
  });
  it('un paso con solo un cambio de paleta también cuenta', () => {
    const m = new Model({ ramps: [{ name: 'a', colors: ['#000000'] }] });
    const h = new History(m);
    h.begin();
    h.setPalette({ ramps: [{ name: 'a', colors: ['#111111'] }] });
    expect(h.commit()).toBe(true);
    h.undo();
    expect(m.palette.ramps[0]!.colors[0]).toBe('#000000');
  });
});
