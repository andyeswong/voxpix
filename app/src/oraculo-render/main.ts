// ORÁCULO del render en la GPU (src/view/gpu/voxrender.ts): los mismos modelos y opciones renderizados por la CPU
// (render de src/core, la referencia) y por la GPU, comparados píxel a píxel. Corre en un navegador de verdad;
// scripts/oracle/oracle.ps1 (con -Url a esta página) lo abre en Edge sin ventana y recoge window.__oracle.
//
// Qué se compara: el color final (RGBA, byte a byte), el vóxel y la cara de cada píxel (pickKey, pickFace) y la
// profundidad. Tolerancia: como mucho el 0,1 % de los píxeles con otro color o con otro vóxel/cara (empates de
// profundidad y umbrales de tono en coma flotante de 32 bits frente a 64), y la profundidad a 1e-3.
import { Model, render, box, material, camera, lightField3D, renderFirstPerson, type ModelFile, type RenderOptions, type Rendered, type PointLight3D, type FpCamera } from '@core/index';
import { GpuVoxelRenderer } from '../../../src/view/gpu/voxrender';
import { sampleScene } from '../../../src/samples/basic';
import { medievalScene } from '../../../src/samples/medieval';
import { vegetationScene } from '../../../src/samples/vegetacion';
import { generateLayout } from '../../../src/worldgen';
import { THEMES } from '../../../src/samples/themes';
import { buildWorldState } from '../../../src/world/build';
import { loadPxl, paletteFromPxl, stackFromPxl, pxlDirectives, applyDirectives } from '../../../src/pxl/bridge';
import maiaFile from '../../../models/maia/maia.json';
import antorcha from '../../../models/luces/antorcha.json';
import paisajeSrc from '../../../models/paisaje/medieval_capas.px.js?raw';

const TOL_SHARE = 0.001;
// En primera persona los rayos van en coma flotante de 32 bits en la GPU y de 64 en la CPU: en las aristas de un vóxel
// (lejos, donde un vóxel ocupa menos de un píxel) alguno toca el vecino
const FP_TOL = 0.005;
const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };

function paisaje(): Model {
  const p = loadPxl(paisajeSrc, 'medieval_capas.px.js');
  const m = new Model(applyDirectives(paletteFromPxl(p, 'paisaje_z00'), pxlDirectives(paisajeSrc)), 'paisaje');
  stackFromPxl(p, 'paisaje', m);
  return m;
}

// Vidrio (sistema de materiales): un cuarto con paredes de vidrio y de piedra, el suelo alrededor; las luces del
// oráculo caen dentro y fuera, así la luz atraviesa el vidrio y no la piedra
function vidrio(): Model {
  const m = new Model({ ramps: [{ name: 'suelo', colors: ['#202030', '#404050', '#606070', '#8a8a9a'] }, { name: 'piedra', colors: ['#2e2f38', '#4a4c58', '#6c6f7c'] }, { name: 'vidrio', colors: ['#24465a', '#3f7a96', '#7ab8d6'], material: 'vidrio' }] }, 'vidrio');
  box(m, -16, -16, 0, 16, 16, 0, material(0, 2));
  box(m, -8, -8, 1, 8, -8, 9, material(2, 1)); box(m, -8, 8, 1, 8, 8, 9, material(1, 1));
  box(m, -8, -8, 1, -8, 8, 9, material(2, 1)); box(m, 8, -8, 1, 8, 8, 9, material(1, 1));
  box(m, -8, -8, 10, 8, 8, 10, material(2, 2));                  // techo de vidrio: el sol lo atraviesa
  return m;
}

// Casos raros: coordenadas negativas lejos del origen, una pared de un vóxel y vóxeles sueltos
function raro(): Model {
  const m = new Model({ ramps: [{ name: 'a', colors: ['#202030', '#505070', '#9090b0', '#d0d0f0'] }, { name: 'b', colors: ['#402010', '#a05020', '#f0a050'] }] }, 'raro');
  box(m, -40, -30, 0, -20, -28, 12, material(0, 2));
  box(m, -30, -26, 0, -30, -10, 6, material(1, 1));
  for (let i = 0; i < 12; i++) m.set(-10 + i * 3, 5 - i, i, material(i % 2, 1));
  return m;
}

const models: Array<[string, Model]> = [
  ['basica', sampleScene()],
  ['medieval', medievalScene().model],
  ['maia', Model.fromJSON(maiaFile as unknown as ModelFile)],
  ['antorcha', Model.fromJSON(antorcha as unknown as ModelFile)],
  ['raro', raro()],
  ['paisaje', paisaje()],
  ['vegetacion', vegetationScene()],
  ['vidrio', vidrio()],
];

// Opciones: las de la vista previa, la exportación, el editor 3D (zoom) y el juego (oblicua, plana)
function cases(name: string): Array<[string, RenderOptions]> {
  const big = name === 'paisaje' || name === 'raro' || name === 'vegetacion';
  const W = big ? 260 : 64, H = big ? 220 : 48, oy = big ? 150 : 42;
  const base = { width: W, height: H, originX: Math.floor(W / 2), originY: oy, pick: true };
  const list: Array<[string, RenderOptions]> = [];
  for (const yaw of [0, 33, 90, 145, 270]) list.push([`yaw ${yaw}`, { ...base, yaw, elevation: 30, outline: 'outer' }]);
  list.push(['elev 60 interior', { ...base, yaw: -30, elevation: 60, outline: 'both' }]);
  list.push(['elev 10 sin contorno', { ...base, yaw: 20, elevation: 10, outline: 'none' }]);
  list.push(['sin sombras ni ao', { ...base, yaw: 45, elevation: 35, outline: 'outer', shadows: false, ao: false }]);
  list.push(['oblicua plana', { ...base, yaw: 90, oblique: { y: 0.5, z: 1 }, flat: true, outline: 'outer', outlineColor: '#0d0c12', pivot: [0.5, 0, 0] }]);
  list.push(['editor 3D zoom', { width: 640, height: 520, originX: 320, originY: 405, yaw: -30, elevation: 35, ppu: big ? 3 : 12, pick: true, outline: 'none', ao: true }]);
  return list;
}

function compare(a: Rendered, b: Rendered) {
  const n = a.width * a.height;
  let rgba = 0, pick = 0, depthMax = 0, filled = 0;
  for (let i = 0; i < n; i++) {
    if (a.rgba[i * 4 + 3]) filled++;
    if (a.rgba[i * 4] !== b.rgba[i * 4] || a.rgba[i * 4 + 1] !== b.rgba[i * 4 + 1] || a.rgba[i * 4 + 2] !== b.rgba[i * 4 + 2] || a.rgba[i * 4 + 3] !== b.rgba[i * 4 + 3]) rgba++;
    const ka = a.pickKey?.[i], kb = b.pickKey?.[i];
    if (!(Number.isNaN(ka) && Number.isNaN(kb)) && (ka !== kb || a.pickFace?.[i] !== b.pickFace?.[i])) pick++;
    const da = a.depth[i]!, db = b.depth[i]!;
    if (Number.isFinite(da) && Number.isFinite(db) && a.pickKey?.[i] === b.pickKey?.[i]) depthMax = Math.max(depthMax, Math.abs(da - db));
  }
  return { rgba, pick, depthMax, filled, n };
}

async function main(): Promise<void> {
  const gpu = GpuVoxelRenderer.create();
  if (!gpu) { log('SIN WEBGL2: no se puede comparar'); (window as unknown as { __oracle: unknown }).__oracle = { ok: false, error: 'sin webgl2' }; return; }
  const results: Array<Record<string, unknown>> = [];
  let ok = true;
  for (const [name, m] of models) {
    for (const [label, o] of cases(name)) {
      await new Promise((r) => setTimeout(r, 0));
      let t = performance.now();
      const a = render(m, o);
      const cpuMs = performance.now() - t;
      t = performance.now();
      const b = gpu.render(m, o, 1)!;
      const gpuMs = performance.now() - t;
      const c = compare(a, b);
      const share = Math.max(c.rgba, c.pick) / Math.max(1, c.filled);
      const pass = share <= TOL_SHARE && c.depthMax <= 1e-3;
      ok &&= pass;
      results.push({ model: name, label, ...c, share, pass, cpuMs, gpuMs, gpu: { ...gpu.stats } });
      log(`${pass ? 'ok  ' : 'MAL '} ${name.padEnd(12)} ${label.padEnd(22)} color ${String(c.rgba).padStart(5)} · vóxel ${String(c.pick).padStart(5)} de ${String(c.filled).padStart(6)} (${(share * 100).toFixed(3)} %) · prof ${c.depthMax.toExponential(1)} · cpu ${cpuMs.toFixed(0)} ms · gpu ${gpuMs.toFixed(0)} ms`);
    }
  }
  // La luz (lightField3D): la misma luz por píxel, con fuentes dentro y fuera del modelo, un foco y el suelo
  log('\nLuz por píxel (lightField3D):');
  const LIGHT_TOL = 1e-3;
  for (const [name, m] of models) {
    const b = m.bounds()!;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const lights: PointLight3D[] = [
      { x: cx - span * 0.3 + 0.5, y: cy - span * 0.4 + 0.5, z: b.maxZ * 0.6 + 0.5, radius: span * 0.9, color: [1, 0.62, 0.28], intensity: 1.3 },
      { x: cx + span * 0.35 + 0.5, y: cy + 0.5, z: 3.5, radius: span * 0.6, color: [0.3, 0.8, 1], intensity: 1 },
      { x: cx + 0.5, y: cy - span * 0.5 + 0.5, z: b.maxZ + 2.5, radius: span, color: [1, 1, 0.8], intensity: 0.9, spot: { dir: [0, 0.6, -0.8], cosOuter: 0.8, cosInner: 0.92 } },
    ];
    for (const [label, o] of cases(name).filter(([l]) => ['yaw 33', 'elev 60 interior', 'oblicua plana'].includes(l))) {
      const img = render(m, { ...o, pick: true });
      let t = performance.now();
      const a = lightField3D(m, img, camera(o), lights, [0.3, 0.3, 0.35]);
      const cpuMs = performance.now() - t;
      t = performance.now();
      const g = gpu.lightField(m, o, camera(o), lights, [0.3, 0.3, 0.35], {}, 1)!;
      const gpuMs = performance.now() - t;
      let bad = 0, max = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]! - g[i]!); max = Math.max(max, d); if (d > LIGHT_TOL) bad++; }
      const share = bad / (a.length / 3);
      const pass = share <= TOL_SHARE;
      ok &&= pass;
      results.push({ model: name, label: `luz ${label}`, bad, max, share, pass, cpuMs, gpuMs });
      log(`${pass ? 'ok  ' : 'MAL '} ${name.padEnd(12)} ${label.padEnd(22)} luz distinta ${String(bad).padStart(5)} de ${a.length / 3} (${(share * 100).toFixed(3)} %) · máx ${max.toExponential(1)} · cpu ${cpuMs.toFixed(0)} ms · gpu ${gpuMs.toFixed(0)} ms`);
    }
  }
  // Explorar en primera persona (renderFirstPerson): desde fuera mirando hacia abajo y desde dentro, a ras del suelo
  log('\nPrimera persona (explorar):');
  for (const [name, m] of models) {
    const b = m.bounds()!;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 8);
    const cams: Array<[string, FpCamera]> = [
      ['desde fuera', { x: cx - span * 0.6 + 0.37, y: cy - span * 0.7 + 0.21, z: b.maxZ + span * 0.4 + 0.13, yaw: 38, pitch: -28 }],
      ['a ras del suelo', { x: cx + 0.31, y: b.minY - 2.6, z: b.minZ + 1.7, yaw: 7, pitch: 4, fov: 80 }],
    ];
    for (const [label, cam] of cams) {
      const o = { width: 200, height: 120, outline: 'both' as const };
      let t = performance.now();
      const a = renderFirstPerson(m, cam, o);
      const cpuMs = performance.now() - t;
      t = performance.now();
      const g = gpu.firstPerson(m, cam, o, 1)!;
      const gpuMs = performance.now() - t;
      const c = compare(a, g);
      const share = Math.max(c.rgba, c.pick) / Math.max(1, c.filled);
      const pass = share <= FP_TOL;
      ok &&= pass;
      results.push({ model: name, label: `fp ${label}`, ...c, share, pass, cpuMs, gpuMs });
      log(`${pass ? 'ok  ' : 'MAL '} ${name.padEnd(12)} ${label.padEnd(22)} color ${String(c.rgba).padStart(5)} · vóxel ${String(c.pick).padStart(5)} de ${String(c.filled).padStart(6)} (${(share * 100).toFixed(3)} %) · cpu ${cpuMs.toFixed(0)} ms · gpu ${gpuMs.toFixed(0)} ms`);
      // Y su luz: las mismas tres fuentes de antes, alrededor del modelo
      const lights: PointLight3D[] = [
        { x: cx - span * 0.3 + 0.5, y: cy - span * 0.4 + 0.5, z: b.maxZ * 0.6 + 0.5, radius: span * 0.9, color: [1, 0.62, 0.28], intensity: 1.3 },
        { x: cx + span * 0.35 + 0.5, y: cy + 0.5, z: 3.5, radius: span * 0.6, color: [0.3, 0.8, 1], intensity: 1 },
      ];
      const lc = lightField3D(m, a, camera({ width: 1, height: 1, originX: 0, originY: 0 }), lights, [0.3, 0.3, 0.35], { floor: false });
      const lg = gpu.lightFieldFirstPerson(m, cam, o, lights, [0.3, 0.3, 0.35], 1)!;
      let bad = 0, max = 0;
      for (let i = 0; i < lc.length; i++) {
        if (Number.isNaN(a.pickKey![Math.floor(i / 3)]!) || a.pickKey![Math.floor(i / 3)] !== g.pickKey![Math.floor(i / 3)]) continue;   // solo donde los dos ven el mismo vóxel
        const d = Math.abs(lc[i]! - lg[i]!); max = Math.max(max, d); if (d > 1e-3) bad++;
      }
      const ls = bad / (lc.length / 3), lpass = ls <= TOL_SHARE;
      ok &&= lpass;
      results.push({ model: name, label: `fp luz ${label}`, bad, max, share: ls, pass: lpass });
      log(`${lpass ? 'ok  ' : 'MAL '} ${name.padEnd(12)} ${('luz ' + label).padEnd(22)} luz distinta ${String(bad).padStart(5)} · máx ${max.toExponential(1)}`);
    }
  }
  // Explorar un mundo del juego, con el agua como fluido aparte (FpWater): desde la orilla del lago, mirando al agua
  log('\nPrimera persona en un mundo con agua:');
  {
    const { world: w, state: st } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), THEMES.medieval.look);
    const water = st.water!.firstPersonWater(w.model.palette)!;
    const bw = { minX: 0, maxX: w.width - 1, minY: 0, maxY: w.depth - 1, minZ: w.model.zMin, maxZ: w.model.zMax };
    for (const [label, cam] of [['orilla del lago', { x: 186.3, y: 168.2, z: 14.5, yaw: 250, pitch: -22 }], ['de lejos', { x: 230.4, y: 120.3, z: 40.2, yaw: 300, pitch: -25, fov: 90 }]] as Array<[string, FpCamera]>) {
      const o = { width: 200, height: 120, outline: 'both' as const, water, bounds: bw };
      let t = performance.now();
      const a = renderFirstPerson(w.model, cam, o);
      const cpuMs = performance.now() - t;
      t = performance.now();
      const g = gpu.firstPerson(w.model, cam, o, 2)!;
      const gpuMs = performance.now() - t;
      const c = compare(a, g);
      let wpx = 0;
      const wr = water.ramp;
      for (let p = 0; p < 200 * 120; p++) if (Number.isNaN(a.pickKey![p]!) && a.rgba[p * 4 + 3]) wpx++;
      const share = Math.max(c.rgba, c.pick) / Math.max(1, c.filled);
      const pass = share <= FP_TOL && wpx > 500;
      ok &&= pass;
      results.push({ model: 'mundo', label: `fp ${label}`, ...c, share, pass, cpuMs, gpuMs, water: wpx });
      log(`${pass ? 'ok  ' : 'MAL '} mundo        ${label.padEnd(22)} color ${String(c.rgba).padStart(5)} · vóxel ${String(c.pick).padStart(5)} de ${String(c.filled).padStart(6)} (${(share * 100).toFixed(3)} %) · agua ${wpx} px (rampa ${wr}) · cpu ${cpuMs.toFixed(0)} ms · gpu ${gpuMs.toFixed(0)} ms`);
    }
  }
  log(ok ? '\nTODO BIEN' : '\nHAY DIFERENCIAS');
  (window as unknown as { __oracle: unknown }).__oracle = { ok, results };
}

main().catch((e) => { log(`ERROR ${e}`); (window as unknown as { __oracle: unknown }).__oracle = { ok: false, error: String(e?.stack ?? e) }; });
