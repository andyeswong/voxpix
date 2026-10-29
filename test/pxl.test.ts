import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Model, render, decode } from '../src/core';
import { loadPxl, paletteFromPxl, spriteToVoxels, toPxlSource, pxlAssets } from '../src/pxl/bridge';
import { sampleScene } from '../src/samples/basic';

const OPTS = { width: 48, height: 36, originX: 24, originY: 30 };

describe('pxl: exportar', () => {
  it('ida y vuelta: lo que pxl construye desde el .px.js es idéntico al render de VoxPix', () => {
    const m = sampleScene();
    const frames = [0, 45, 90, 200].map((yaw) => ({ name: `muestra_a${yaw}`, ...render(m, { ...OPTS, yaw }) }));
    const src = toPxlSource(m, frames, { sheet: 'muestra' });
    const p = loadPxl(src, 'muestra.px.js');
    expect(pxlAssets(p)).toEqual(expect.arrayContaining(frames.map((f) => f.name)));
    for (const f of frames) {
      const img = p.image(f.name);
      expect([img.w, img.h]).toEqual([f.width, f.height]);
      for (let i = 0; i < img.w * img.h; i++) {
        const c = img.data[i]!;
        const ours = f.rgba[i * 4 + 3] ? ((f.rgba[i * 4]! << 24) | (f.rgba[i * 4 + 1]! << 16) | (f.rgba[i * 4 + 2]! << 8) | 255) >>> 0 : 0;
        if (c !== ours) throw new Error(`${f.name}: píxel ${i % img.w},${Math.floor(i / img.w)} difiere (${c.toString(16)} vs ${ours.toString(16)})`);
      }
    }
  });

  it('las rampas de VoxPix salen como ramps() de pxl, en el mismo orden de oscuro a claro', () => {
    const m = sampleScene();
    const p = loadPxl(toPxlSource(m, []));
    expect(paletteFromPxl(p).ramps.slice(0, m.palette.ramps.length).map((r) => r.colors)).toEqual(m.palette.ramps.map((r) => r.colors));
  });

  it('es determinista', () => {
    const m = sampleScene();
    const f = [{ name: 'a', ...render(m, OPTS) }];
    expect(toPxlSource(m, f)).toBe(toPxlSource(sampleScene(), [{ name: 'a', ...render(sampleScene(), OPTS) }]));
  });
});

describe('pxl: importar', () => {
  const SRC = `
pal({ k: "#0b0812", h: "#1e1e42", H: "#554275", s: "#d69aae", W: "#f7ddd7" })
ramps("khH", "sW")
sprite("cara", \`
  .hhh.
  hHHHh
  hsWsh
  .sss.\`)`;

  it('toma la paleta con sus rampas (y los colores sueltos como rampas de un tono)', () => {
    const pal = paletteFromPxl(loadPxl(SRC));
    expect(pal.ramps.map((r) => r.colors)).toEqual([['#0b0812', '#1e1e42', '#554275'], ['#d69aae', '#f7ddd7']]);
  });

  it('pone un sprite como vóxeles de frente, con la fila de abajo en z = 0 y centrado en x', () => {
    const p = loadPxl(SRC);
    const m = new Model(paletteFromPxl(p));
    const n = spriteToVoxels(p, 'cara', m, { plane: 'front' });
    expect(n).toBe(16);
    // Fila de abajo ".sss." -> z = 0, x = -1..1, color s (rampa 1 tono 0)
    expect(decode(m.get(0, 0, 0))).toEqual({ ramp: 1, tone: 0 });
    expect(m.get(-2, 0, 0)).toBe(0);
    // Fila de arriba ".hhh." -> z = 3
    expect(decode(m.get(0, 0, 3))).toEqual({ ramp: 0, tone: 1 });
  });

  // Con VOXPIX_REAL_PXL=<ruta a un .px.js con sprites> se prueba también con arte real (p. ej. maia24-ropa.px.js)
  it.skipIf(!process.env.VOXPIX_REAL_PXL)('lee arte real (VOXPIX_REAL_PXL)', () => {
    const path = process.env.VOXPIX_REAL_PXL!;
    const src = readFileSync(path, 'utf8');
    const p = loadPxl(src, path);
    const names = pxlAssets(p);
    expect(names.length).toBeGreaterThan(0);
    const pal = paletteFromPxl(p, names[0]);
    expect(pal.ramps.length).toBeGreaterThan(2);
    const m = new Model(pal);
    expect(spriteToVoxels(p, names[0]!, m, { plane: 'front' })).toBeGreaterThan(50);
  });
});

describe('pxl: pila de capas', () => {
  it('ida y vuelta: modelo -> capas .px.js -> modelo, idéntico vóxel a vóxel', async () => {
    const { toPxlStack, stackFromPxl, stackPrefixes } = await import('../src/pxl/bridge');
    const m = sampleScene();
    const src = toPxlStack(m, 'muestra');
    const p = loadPxl(src);
    expect(stackPrefixes(p)).toEqual(['muestra']);
    const back = new Model(m.palette);
    expect(stackFromPxl(p, 'muestra', back)).toBe(m.size);
    expect([...back.entries()]).toEqual([...m.entries()]);
  });

  it('las capas son vistas desde arriba con el norte arriba y el pivote en el centro', async () => {
    const { toPxlStack } = await import('../src/pxl/bridge');
    const m = new Model(TEST_PAL);
    m.set(0, 0, 0, 1);         // pivote
    m.set(2, 1, 0, 1);         // al este y al norte
    const src = toPxlStack(m, 't');
    // 5x3: fila de arriba = y 1 (norte), columna central = x 0
    expect(src).toContain('sprite("t_z00", { w: 5, h: 3 }, `\n  ....a\n  ..a..\n  .....`)');
  });

  it('las capas de distinto tamaño son un error claro', async () => {
    const { stackFromPxl } = await import('../src/pxl/bridge');
    const p = loadPxl('pal({ a: "#ff0000" })\nsprite("x_z00", `aa`)\nsprite("x_z01", `aaa`)');
    expect(() => stackFromPxl(p, 'x', new Model(paletteFromPxl(p)))).toThrow(/todas iguales/);
  });
});

const TEST_PAL = { ramps: [{ name: 'r', colors: ['#ff0000'] }] };

describe('directivas de VoxPix en el .px.js (contorno y rampas emisivas)', () => {
  it('se leen, se aplican y hacen la ida y vuelta por capas', async () => {
    const { pxlDirectives, applyDirectives, toPxlStack, stackFromPxl } = await import('../src/pxl/bridge');
    const { box, material } = await import('../src/core');
    const pal = { ramps: [{ name: 'metal', colors: ['#1c1a2e', '#353650', '#8f99ab'] }, { name: 'plasma', colors: ['#1f6f8a', '#6ff2ff'], emissive: true }], outline: '#12101c' };
    const m = new Model(pal, 'arma');
    box(m, -1, -1, 0, 1, 1, 2, material(0, 1));
    box(m, 0, -3, 1, 0, -2, 1, material(1, 1));
    const src = toPxlStack(m, 'arma');
    expect(src).toContain('// voxpix: outline #12101c');
    const d = pxlDirectives(src);
    expect(d.outline).toBe('#12101c');
    expect(d.emissive).toHaveLength(1);
    const p = loadPxl(src, 'arma.px.js');
    const back = new Model(applyDirectives(paletteFromPxl(p, 'arma_z00'), d), 'arma');
    stackFromPxl(p, 'arma', back);
    expect(back.palette.outline).toBe('#12101c');
    expect(back.palette.ramps.filter((r) => r.emissive).map((r) => r.colors)).toEqual([['#1f6f8a', '#6ff2ff']]);
    expect(back.size).toBe(m.size);
    // Un contorno explícito (el flag --outline del CLI) gana a la directiva
    expect(applyDirectives(paletteFromPxl(p, 'arma_z00'), d, '#000000').outline).toBe('#000000');
  });
});

describe('pxl: lo que cae fuera del lienzo', () => {
  it('se apunta con el sprite y la coordenada; lo de dentro, no', async () => {
    const { pxlClipped } = await import('../src/pxl/bridge');
    const p = loadPxl('pal({ a: "#ff0000" })\nsprite("dentro", { w: 4, h: 4 }, (c) => { c.px(0, 0, "a"); c.px(3, 3, "a") })\n' +
      'sprite("punta", { w: 4, h: 4 }, (c) => { for (let x = 0; x < 7; x++) c.px(x, 1, "a") })');
    p.image('dentro'); p.image('punta');
    expect(pxlClipped(p)).toEqual([{ sprite: 'punta', x: 4, y: 1 }, { sprite: 'punta', x: 5, y: 1 }, { sprite: 'punta', x: 6, y: 1 }]);
  });

  it('un proyecto sin recortes no apunta nada, y no se mezcla con otro', async () => {
    const { pxlClipped } = await import('../src/pxl/bridge');
    const a = loadPxl('pal({ a: "#ff0000" })\nsprite("s", { w: 2, h: 2 }, (c) => c.px(9, 9, "a"))');
    const b = loadPxl('pal({ a: "#ff0000" })\nsprite("s", { w: 2, h: 2 }, (c) => c.px(1, 1, "a"))');
    a.image('s'); b.image('s');
    expect(pxlClipped(a).length).toBe(1);
    expect(pxlClipped(b)).toEqual([]);
  });
});

describe('pxl: capas con z negativa y el global vox', () => {
  it('_z-01 es z = -1: el origen del modelo no depende de la capa más baja, y la ida y vuelta lo respeta', async () => {
    const { toPxlStack, stackFromPxl } = await import('../src/pxl/bridge');
    const m = new Model(TEST_PAL);
    m.set(0, 0, 0, 1); m.set(1, 0, -2, 1); m.set(0, 1, 3, 1);
    const src = toPxlStack(m, 'arma');
    expect(src).toContain('sprite("arma_z-02"');
    const back = new Model(TEST_PAL);
    expect(stackFromPxl(loadPxl(src), 'arma', back)).toBe(3);
    expect([...back.entries()].sort()).toEqual([...m.entries()].sort());
  });

  it('vox: girar, mover, subir tono y sacar capas; importado, el agarre sigue en el origen', async () => {
    const { stackFromPxl } = await import('../src/pxl/bridge');
    const src = `pal({ a: "#300000", b: "#900000", c: "#ff0000" })\nramps("abc")
      const arma = new Map([["0,0,0", "a"], ["0,1,0", "a"], ["0,2,0", "b"], ["0,2,1", "b"]])
      globalThis.__t = {
        rot: [...vox.rotate(arma, 90).entries()].sort(),
        pitch: [...vox.rotate(arma, 90, { axis: 'x' }).entries()].sort(),
        up: [...vox.toneUp(arma, ["abc"], 5).values()],
        shift: [...vox.shift(arma, 0, -2, -1).keys()].sort(),
      }
      vox.layers("pose", vox.shift(arma, 0, 0, -1))`;
    const p = loadPxl(src);
    const t = (globalThis as unknown as { __t: Record<string, unknown> }).__t;
    expect(t.rot).toEqual([['-1,0,0', 'a'], ['-2,0,0', 'b'], ['-2,0,1', 'b'], ['0,0,0', 'a']].sort());
    expect(t.pitch).toEqual([['0,-1,2', 'b'], ['0,0,0', 'a'], ['0,0,1', 'a'], ['0,0,2', 'b']].sort());
    expect(t.up).toEqual(['c', 'c', 'c', 'c']);
    expect(t.shift).toEqual(['0,-1,-1', '0,-2,-1', '0,0,-1', '0,0,0'].sort());
    expect(pxlAssets(p)).toEqual(['pose_z-01', 'pose_z00']);
    const m = new Model(paletteFromPxl(p, 'pose_z00'));
    expect(stackFromPxl(p, 'pose', m)).toBe(4);
    expect(decode(m.get(0, 0, -1)).tone).toBe(0);                  // el agarre bajado 1
    expect(decode(m.get(0, 2, 0)).tone).toBe(1);
    delete (globalThis as unknown as { __t?: unknown }).__t;
  });
});
