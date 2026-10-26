// El motor no sabe de temas (pedido de Andrés): el mundo se construye con un WorldLook (paleta, fuente y quién hace
// las columnas) y el agua toma su color y su brillo de la rampa agua de la paleta. Los temas de muestra viven en
// samples/ y el código del motor no los importa.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateLayout, TILE } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorld, buildWorldState, worldPalette, M, DEFAULT_WORLD_RAMPS, type PillarSite } from '../src/world/build';
import { WaterLayer } from '../src/world/water';
import { rampMaterial, material } from '../src/core';
import { bakeWorld } from '../src/world/bake';
import { frame2D } from '../src/world/frame2d';

const layout = () => generateLayout(THEMES.medieval.spec, 7);
const pillarTiles = (l = layout()) => [...l.pillar].filter((v, i) => v && !l.prop[i]).length;

describe('el mundo sin temas', () => {
  it('ningún archivo del motor importa samples/ (la CLI, que es una herramienta, sí puede)', () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== 'samples' && f !== 'cli') walk(p); continue; }
        // Cualquier import (estático, de un index o dinámico) de samples
        if (/\.ts$/.test(f) && /(from|import\()\s*['"][^'"]*samples(\/|['"])/.test(readFileSync(p, 'utf8'))) bad.push(p);
      }
    };
    walk('src');
    expect(bad).toEqual([]);
  });

  it('worldPalette: las rampas en el orden de M, los colores por defecto donde no se dice nada', () => {
    const p = worldPalette({ water: { colors: ['#000', '#111', '#222', '#333', '#444'], emissive: true }, floor: ['#ff0000', '#00ff00'] });
    expect(p.ramps.length).toBe(Object.keys(M).length);
    expect(p.ramps[M.water]!.name).toBe('agua');
    expect(rampMaterial(p.ramps[M.water]!).emissive).toBe(true);
    expect(p.ramps[M.floor]!.colors).toEqual(['#ff0000', '#00ff00']);
    expect(p.ramps[M.wall]!.colors).toEqual([...DEFAULT_WORLD_RAMPS.wall]);
  });

  it('las columnas: redondas por defecto, las de quien construye, o ninguna', () => {
    const l = layout();
    const n = pillarTiles(l);
    expect(n).toBeGreaterThan(0);
    const sites: PillarSite[] = [];
    const custom = buildWorld(l, { palette: worldPalette(), pillar: (s) => {
      sites.push(s);
      for (let z = 0; z < 10; z++) for (let x = s.x0; x <= s.x1; x++) s.model.set(x, s.y0 + 7, z, material(M.metal, 2));   // una mampara fina
    } });
    expect(sites.length).toBe(n);
    for (const s of sites) { expect(s.x1 - s.x0 + 1).toBe(TILE); expect(s.y1 - s.y0 + 1).toBe(TILE); expect(s.cx).toBe(s.x0 + 7.5); expect(s.cy).toBe(s.y0 + 7.5); }
    const s0 = sites[0]!;
    expect(custom.model.get(s0.x0, s0.y0 + 7, 5)).toBe(material(M.metal, 2));
    expect(custom.model.get(Math.floor(s0.cx), Math.floor(s0.cy) + 3, 20)).toBe(0);          // nada de la columna redonda
    const round = buildWorld(l);
    expect(round.model.get(Math.floor(s0.cx), Math.floor(s0.cy), 20)).not.toBe(0);
    const none = buildWorld(l, { palette: worldPalette(), pillar: null });
    expect(none.model.get(Math.floor(s0.cx), Math.floor(s0.cy), 20)).toBe(0);
  });

  it('las piezas: el motor no lee sus nombres; lo hace el look (sin él, lo más sencillo)', () => {
    const l = generateLayout(THEMES.oficina.spec, 2);
    expect(l.props.length).toBeGreaterThan(0);
    const p = l.props[0]!, yN = l.rows * TILE - 1 - p.y * TILE, x0 = p.x * TILE;
    // Por defecto: losas sin variaciones, pared lisa, solo las luces de la fachada y los muebles como bloques
    const plain = buildWorld(l, { palette: worldPalette() });
    expect(plain.model.get(x0 + 4, yN - 4, 6)).toBe(material(M.wood, 2));
    expect(plain.lights.every((x) => String(x.id).startsWith('facade-'))).toBe(true);
    // Sin muebles: la huella queda libre
    expect(buildWorld(l, { palette: worldPalette(), prop: null }).model.get(x0 + 4, yN - 4, 6)).toBe(0);
    // Los constructores del look reciben cada pieza
    const seen = { floor: new Set<string>(), facade: [] as string[], fixture: 0, prop: 0 };
    buildWorld(l, { palette: worldPalette(),
      floor: (s) => { seen.floor.add(s.kind); return material(M.floor, 2); },
      facade: (s) => { seen.facade.push(s.piece); },
      fixture: () => { seen.fixture++; },
      prop: () => { seen.prop++; } });
    expect([...seen.floor].sort()).toEqual([...new Set(l.floor.filter((k, i) => k && l.wall[i] === 0))].sort());
    expect(seen.facade).toEqual(l.facade.slice(1, l.cols - 1).map((f) => f ?? ''));
    expect(seen.fixture).toBe(l.sources.filter((s) => s.id.startsWith('facade-')).length);
    expect(seen.prop).toBe(l.props.length);
  });

  it('la fuente solo si el look la pide', () => {
    expect(buildWorld(layout(), { palette: worldPalette() }).fountain).toBeNull();
    expect(buildWorld(layout(), THEMES.medieval.look).fountain).not.toBeNull();
  });
});

describe('el líquido por su rampa', () => {
  const COFFEE = ['#1a0e08', '#2e1a0e', '#4a2c16', '#6a4224', '#a07040'];
  it('el agua toma el color de la rampa agua; sin rampa, el azul por defecto', () => {
    const w = buildWorld(layout(), { palette: worldPalette({ water: COFFEE }), fountain: true });
    const wl = new WaterLayer(w);
    expect(wl.tones[0]).toEqual([0x1a, 0x0e, 0x08]);
    expect(wl.glow).toBe(0);
    // Una rampa de 3 tonos se reparte en los 5 del agua (del hondo a la espuma)
    const w3 = buildWorld(layout(), { palette: worldPalette({ water: ['#000000', '#808080', '#ffffff'] }) });
    expect(new WaterLayer(w3).tones.map((t) => t[0])).toEqual([0, 128, 128, 255, 255]);
    const bare = buildWorld(layout(), { palette: { ramps: [{ name: 'suelo', colors: ['#000000'] }] } });
    expect(new WaterLayer(bare).tones[4]).toEqual([0x5a, 0x9a, 0xb4]);
  });

  it('una rampa de agua emisiva brilla sola: a oscuras se ve con su color', () => {
    const TOXIC = ['#0a2a10', '#145a20', '#22a03a', '#4ee060', '#b0ffb8'];
    const shot = (emissive: boolean) => {
      // Sin luces (ni la del brasero de la fuente): solo el ambiente, casi negro
      const { state, world } = buildWorldState(layout(), { palette: worldPalette({ water: { colors: TOXIC, emissive } }), fountain: true }, { decorate: (w) => { w.lights.length = 0; } });
      const b = bakeWorld(world, { topZ: 48 });
      const f = world.fountain!;
      const [sx, sy] = b.cam.project(f.x + 9, f.y, f.level);
      const o = { vx: Math.floor(sx) - 20, vy: Math.floor(sy) - 20, vw: 40, vh: 40, time: 0, lights: true, ambient: [0.05, 0.05, 0.08] as const };
      const img = frame2D(state, b, o);
      let g = 0;
      for (let i = 0; i < img.length; i += 4) g += img[i + 1]!;
      return { g, glow: (state.water as WaterLayer).glow };
    };
    const lit = shot(true), dark = shot(false);
    expect(lit.glow).toBe(1);
    expect(dark.glow).toBe(0);
    expect(lit.g).toBeGreaterThan(dark.g * 1.5);
  });
});
