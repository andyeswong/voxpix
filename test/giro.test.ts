// La vista girada en cuartos de vuelta (src/world/view.ts): la transformación y sus inversas, los vóxeles girados al
// día con el mundo, el rehorneado, el puntero (lo que se toca cae en el vóxel correcto) y el giro de las entidades.
import { describe, it, expect } from 'vitest';
import { Model, material, box } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld, bakeWorldJob, rebakeChanged } from '../src/world/bake';
import { entitySprite } from '../src/world/frame2d';
import { ViewCamera, WorldView, prepareViewJob, type Quarter } from '../src/world/view';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';

const PAL = { ramps: [
  { name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const Q: Quarter[] = [0, 1, 2, 3];

// Un mundo rectangular de lados impares, con algo distinto en cada esquina para que un giro mal hecho se note
function oddWorld(): WorldState {
  const W = 37, D = 23;
  const s = new StaticVoxels(structuredClone(PAL), W, D, -4, 16);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) s.set(x, y, 0, material(0, (x * 7 + y * 3) % 5));
  for (let z = 1; z < 9; z++) for (let y = 15; y < 19; y++) for (let x = 3; x < 6; x++) s.set(x, y, z, material(0, 3));   // torre al noroeste
  for (let z = 1; z < 4; z++) for (let x = 25; x < 35; x++) s.set(x, 2, z, material(0, 4));                               // muro bajo al sureste
  return new WorldState(s, [{ id: 'l1', kind: 'torch', x: 10.5, y: 8.25, z: 6 }], null);
}

describe('ViewCamera', () => {
  it('celdas, puntos, direcciones y giros vuelven con sus inversas en los 4 cuartos', () => {
    for (const q of Q) {
      const c = new ViewCamera(q, 37, 23);
      expect([c.viewWidth, c.viewDepth]).toEqual(q % 2 ? [23, 37] : [37, 23]);
      for (const [x, y] of [[0, 0], [36, 22], [5, 17], [12.25, 3.75]] as const) {
        const [vx, vy] = c.cellToView(x, y);
        expect(c.cellToWorld(vx, vy)).toEqual([x, y]);
        const [px, py] = c.pointToView(x, y);
        expect(c.pointToWorld(px, py)).toEqual([x, y]);
        if (Number.isInteger(x)) { expect(vx).toBeGreaterThanOrEqual(0); expect(vx).toBeLessThan(c.viewWidth); expect(vy).toBeGreaterThanOrEqual(0); expect(vy).toBeLessThan(c.viewDepth); }
      }
      expect(c.dirToWorld(...c.dirToView(0.6, -0.8))).toEqual([0.6, -0.8]);
      for (const yaw of [0, 45, 90, 270]) expect(c.yawToWorld(c.yawToView(yaw))).toBe(yaw);
    }
  });

  it('girar un cuarto 4 veces seguidas vuelve al mismo sitio (y el lado largo se alterna)', () => {
    let W = 37, D = 23, x = 4, y = 17, px = 4.5, py = 17.25;
    for (let k = 0; k < 4; k++) {
      const c = new ViewCamera(1, W, D);
      [x, y] = c.cellToView(x, y);
      [px, py] = c.pointToView(px, py);
      [W, D] = [c.viewWidth, c.viewDepth];
    }
    expect([x, y, px, py, W, D]).toEqual([4, 17, 4.5, 17.25, 37, 23]);
  });

  it('la celda y el punto coinciden: el centro de la celda va al centro de su celda girada', () => {
    for (const q of Q) {
      const c = new ViewCamera(q, 37, 23);
      const [cx, cy] = c.cellToView(8, 3);
      expect(c.pointToView(8.5, 3.5)).toEqual([cx + 0.5, cy + 0.5]);
    }
  });
});

describe('WorldView', () => {
  it('los vóxeles girados son los del mundo, en los 4 cuartos', () => {
    const st = oddWorld();
    for (const q of Q) {
      const v = new WorldView(st, q);
      let n = 0;
      for (const [x, y, z, val] of st.solid.entries()) {
        const [vx, vy] = v.camera.cellToView(x, y);
        expect(v.static.get(vx, vy, z)).toBe(val);
        n++;
      }
      expect(v.static.width * v.static.depth).toBe(37 * 23);
      let m = 0;
      for (const _ of v.static.entries()) m++;
      expect(m).toBe(n);
    }
  });

  it('lo que cambia en el mundo llega a la vista, y el rehorneado da lo mismo que hornear de nuevo', () => {
    for (const q of [1, 2, 3] as Quarter[]) {
      const st = oddWorld();
      const v = new WorldView(st, q);
      const b = bakeWorld(v.bakeable(), { topZ: 20 });
      // Se rompe la torre y se levanta otra cosa en el mundo
      for (let z = 1; z < 9; z++) st.solid.set(4, 16, z, 0);
      for (let z = 1; z < 6; z++) st.solid.set(20, 11, z, material(0, 2));
      const rs = v.frame();
      rebakeChanged(b, rs.lights);
      const fresh = bakeWorld(v.bakeable(), { topZ: 20 });
      expect(Buffer.from(b.rgba).equals(Buffer.from(fresh.rgba))).toBe(true);
      expect(Buffer.from(b.depth.buffer).equals(Buffer.from(fresh.depth.buffer))).toBe(true);
      const [vx, vy] = v.camera.cellToView(20, 11);
      expect(v.static.get(vx, vy, 3)).toBe(material(0, 2));
    }
  });

  it('el puntero: cada píxel cae en un vóxel que existe en el mundo, y el punto exacto está en ese vóxel', () => {
    const st = oddWorld();
    for (const q of Q) {
      const v = new WorldView(st, q);
      const b = bakeWorld(v.bakeable(), { topZ: 20 });
      let checked = 0;
      for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
        const vox = v.voxelAt(b, sx, sy);
        if (!vox) continue;
        const [x, y, z] = vox;
        expect(st.solid.get(x, y, z), `cuarto ${q}, píxel ${sx},${sy}`).not.toBe(0);
        const p = v.pointAt(b, sx, sy)!;
        expect(p[0]).toBeGreaterThanOrEqual(x - 0.51); expect(p[0]).toBeLessThanOrEqual(x + 1.51);
        expect(p[1]).toBeGreaterThanOrEqual(y - 0.51); expect(p[1]).toBeLessThanOrEqual(y + 1.51);
        checked++;
      }
      expect(checked).toBeGreaterThan(200);
      // Lo más alto del mundo (la torre del noroeste) se toca en su sitio
      let tower = 0;
      for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) { const vox = v.voxelAt(b, sx, sy); if (vox && vox[2] === 8) { expect(vox[0]).toBeGreaterThanOrEqual(3); expect(vox[0]).toBeLessThan(6); expect(vox[1]).toBeGreaterThanOrEqual(15); expect(vox[1]).toBeLessThan(19); tower++; } }
      expect(tower).toBeGreaterThan(0);
    }
  });

  it('una entidad que mira al este se pinta mirando a la cámara desde el este, de espaldas desde el oeste y de lado desde el norte', () => {
    const st = oddWorld();
    const body = new Model({ ramps: [{ name: 'c', colors: ['#400000', '#800000', '#c00000'] }, { name: 'cara', colors: ['#ffffff'] }] });
    box(body, -2, -1, 0, 2, 1, 6, material(0, 1));
    body.set(1, -1, 5, material(1, 0));                 // un ojo en la cara (el frente es -y), algo descentrado
    st.entities.add({ model: body, x: 18, y: 11, z: 1, facing: 90 });
    const expected: Record<Quarter, number> = { 0: 90, 1: 0, 2: 270, 3: 180 };
    for (const q of Q) {
      const v = new WorldView(st, q);
      const rs = v.frame();
      const e = rs.entities[0]!;
      expect(e.yaw).toBe(expected[q]);
      const b = bakeWorld(v.bakeable(), { topZ: 20 });
      const o = { vx: 0, vy: 0, vw: 64, vh: 64, time: 0, lights: false, ambient: [1, 1, 1] as const };
      const ref = entitySprite(b, { ...e, yaw: expected[q] }, o).img;
      expect(Buffer.from(entitySprite(b, e, o).img.rgba).equals(Buffer.from(ref.rgba))).toBe(true);
      // Desde el este (cuarto 1) se le ve la cara: el ojo blanco está en el sprite; desde el oeste (3), no
      const white = (img: { rgba: Uint8ClampedArray }) => { for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] === 255 && img.rgba[i + 1] === 255 && img.rgba[i + 3]) return true; return false; };
      if (q === 1) expect(white(ref)).toBe(true);
      if (q === 3) expect(white(ref)).toBe(false);
    }
  });

  it('dar la vuelta entera vuelve a la misma imagen, píxel a píxel, con rehorneados por trozos en cada giro', () => {
    const st = oddWorld();
    const same = (a: ReturnType<typeof bakeWorld>, b: ReturnType<typeof bakeWorld>) =>
      Buffer.from(a.rgba).equals(Buffer.from(b.rgba)) && Buffer.from(a.depth.buffer).equals(Buffer.from(b.depth.buffer)) && Buffer.from(a.pick.buffer).equals(Buffer.from(b.pick.buffer));
    // Los 4 giros guardados (modo caché), cada uno con su horneado
    const views = Q.map((q) => new WorldView(st, q));
    const baked = views.map((v) => bakeWorld(v.bakeable(), { topZ: 20 }));
    const first = { rgba: baked[0]!.rgba.slice(), depth: baked[0]!.depth.slice(), pick: baked[0]!.pick.slice() } as ReturnType<typeof bakeWorld>;
    // En cada giro el mundo cambia (se rompe la torre, se levanta un muro, se repara la torre, se quita el muro) y solo
    // se rehornea la vista que se ve
    const edits: Array<() => void> = [
      () => { for (let z = 1; z < 9; z++) st.solid.set(4, 16, z, 0); },
      () => { for (let z = 1; z < 6; z++) for (let y = 9; y < 14; y++) st.solid.set(20, y, z, material(0, 2)); },
      () => { for (let z = 1; z < 9; z++) st.solid.set(4, 16, z, material(0, 3)); },
      () => { for (let z = 1; z < 6; z++) for (let y = 9; y < 14; y++) st.solid.set(20, y, z, 0); },
    ];
    for (let k = 0; k < 4; k++) {
      const q = (k + 1) % 4;
      edits[k]!();
      const rs = views[q]!.frame();
      rebakeChanged(baked[q]!, rs.lights);
      expect(same(baked[q]!, bakeWorld(views[q]!.bakeable(), { topZ: 20 })), `giro ${q}`).toBe(true);
    }
    // De vuelta en el giro 0, con el mundo como al principio: la misma imagen que la primera vez
    expect(same(baked[0]!, first)).toBe(true);
    // Y los otros giros, que se quedaron atrás varios cambios, se ponen al día al volver a verlos
    for (const q of [1, 2, 3]) {
      rebakeChanged(baked[q]!, views[q]!.frame().lights);
      expect(same(baked[q]!, bakeWorld(views[q]!.bakeable(), { topZ: 20 })), `giro ${q} al volver`).toBe(true);
    }
  });

  it('las luces van a su sitio en la vista con el mismo id (el mismo parpadeo)', () => {
    const st = oddWorld();
    for (const q of Q) {
      const v = new WorldView(st, q);
      const l = v.frame().lights[0]!;
      expect(l.id).toBe('l1');
      expect(v.camera.pointToWorld(l.x, l.y)).toEqual([10.5, 8.25]);
    }
  });
});

describe('hornear sin congelar la vista', () => {
  const same = (a: ReturnType<typeof bakeWorld>, b: ReturnType<typeof bakeWorld>) =>
    a.width === b.width && a.height === b.height && Buffer.from(a.rgba).equals(Buffer.from(b.rgba)) && Buffer.from(a.depth.buffer).equals(Buffer.from(b.depth.buffer)) &&
    Buffer.from(a.pick.buffer).equals(Buffer.from(b.pick.buffer)) && Buffer.from(a.face.buffer).equals(Buffer.from(b.face.buffer)) && Buffer.from(a.occ).equals(Buffer.from(b.occ)) &&
    a.lights.length === b.lights.length && a.lights.every((l, i) => l.light.id === b.lights[i]!.light.id && JSON.stringify(l.rect) === JSON.stringify(b.lights[i]!.rect) && Buffer.from(l.weight.buffer).equals(Buffer.from(b.lights[i]!.weight.buffer)));

  it('bakeWorldJob, troceado al mínimo, da lo mismo que bakeWorld (un mundo con luces y agua)', () => {
    const layout = generateLayout(THEMES.medieval.spec, 7);
    const { world } = buildWorldState(layout, THEMES.medieval.look);
    const ref = bakeWorld(world, { topZ: 40, incline: 0.5 });
    const { baked, job } = bakeWorldJob(world, { topZ: 40, incline: 0.5 });
    let steps = 0;
    while (!job.run(0)) steps++;
    expect(steps).toBeGreaterThan(100);
    expect(ref.lights.length).toBeGreaterThan(3);
    expect(same(baked, ref)).toBe(true);
  }, 120000);

  it('prepareViewJob va por etapas (copy, view, alloc, bake, done) y run() no cruza de una a otra en la misma llamada', () => {
    for (const q of Q) {
      const st = oddWorld();
      const prep = prepareViewJob(st, q, { topZ: 20 });
      const seen: string[] = [prep.stage()];
      for (;;) {
        const before = prep.stage();
        const finished = prep.job.run(Infinity);                // aun con todo el plazo del mundo
        const after = prep.stage();
        if (after !== before) {
          expect(finished, `${before} -> ${after}`).toBe(after === 'done' && before === 'bake');
          seen.push(after);
        }
        if (finished) break;
      }
      expect(seen).toEqual(q === 0 ? ['view', 'alloc', 'bake', 'done'] : ['copy', 'view', 'alloc', 'bake', 'done']);
      expect(prep.result()).not.toBeNull();
    }
  });

  it('prepareViewJob con el mundo cambiando a medias: al acabar, ponerse al día da lo mismo que hornear de nuevo', () => {
    for (const q of Q) {
      const st = oddWorld();
      const prep = prepareViewJob(st, q, { topZ: 20 });
      let steps = 0;
      while (!prep.job.run(0)) {
        expect(prep.result()).toBeNull();
        // Cambios en mitad del trabajo: mientras se copian los vóxeles (6 trozos) y ya horneando
        if (steps === 2) for (let z = 1; z < 9; z++) st.solid.set(4, 16, z, 0);
        if (steps === 10) for (let z = 1; z < 6; z++) st.solid.set(30, 20, z, material(0, 2));
        steps++;
      }
      expect(steps).toBeGreaterThan(10);
      const { view, baked } = prep.result()!;
      rebakeChanged(baked, view.frame().lights);
      const fresh = new WorldView(st, q);
      expect(same(baked, bakeWorld(fresh.bakeable(), { topZ: 20 })), `giro ${q}`).toBe(true);
    }
  });
});

describe('vestir la vista según el lado de la cámara', () => {
  // Un vestido de prueba: la franja de delante de la vista (las 4 filas más cercanas a la cámara) se queda a ras de
  // suelo, y la luz l1 deja de verse
  const FRONT = 4;
  const calls: Array<readonly number[] | null> = [];
  const dress = (v: WorldView, changed: readonly number[] | null) => {
    calls.push(changed);
    const s = v.static;
    for (let y = 0; y < FRONT; y++) for (let x = 0; x < s.width; x++) for (let z = 1; z <= s.zMax; z++) if (s.get(x, y, z)) s.set(x, y, z, 0);
    v.hideLight = (l) => l.id === 'l1';
  };
  const same = (a: ReturnType<typeof bakeWorld>, b: ReturnType<typeof bakeWorld>) =>
    Buffer.from(a.rgba).equals(Buffer.from(b.rgba)) && Buffer.from(a.depth.buffer).equals(Buffer.from(b.depth.buffer)) && a.lights.length === b.lights.length;

  it('el vestido va sobre la copia de la vista, también en el giro 0: el mundo no se toca', () => {
    for (const q of Q) {
      const st = oddWorld();
      const before = [...st.solid.entries()].length;
      const v = new WorldView(st, q, { dress });
      expect(v.copied).toBe(true);
      expect([...st.solid.entries()].length).toBe(before);
      // La franja de delante quedó a ras de suelo y hay menos vóxeles en la vista que en el mundo (el muro del sureste,
      // o la torre, o lo que caiga delante en este giro)
      for (let x = 0; x < v.static.width; x++) for (let y = 0; y < FRONT; y++) expect(v.static.get(x, y, 1)).toBe(0);
      expect(v.frame()).toBe(v);
      expect(v.frame().lights.some((l) => l.id === 'l1')).toBe(false);
      expect(v.bakeable().lights.some((l) => l.id === 'l1')).toBe(false);
    }
  });

  it('si cambia el mundo donde hay vestido, se vuelve a vestir y el rehorneado da lo mismo que hornear de nuevo', () => {
    for (const q of Q) {
      const st = oddWorld();
      const v = new WorldView(st, q, { dress });
      const b = bakeWorld(v.bakeable(), { topZ: 20 });
      // Algo nuevo en el mundo justo donde cae la franja de delante de esta vista
      const [wx, wy] = v.camera.cellToWorld(10, 1);
      calls.length = 0;
      for (let z = 1; z < 7; z++) st.solid.set(wx, wy, z, material(0, 2));
      const rs = v.frame();
      expect(calls.length).toBe(1);
      expect(calls[0]!.length).toBeGreaterThan(0);
      expect(v.static.get(10, 1, 3)).toBe(0);                        // vestido otra vez
      expect(st.solid.get(wx, wy, 3)).toBe(material(0, 2));          // y en el mundo sigue
      rebakeChanged(b, rs.lights);
      expect(same(b, bakeWorld(new WorldView(st, q, { dress }).bakeable(), { topZ: 20 })), `giro ${q}`).toBe(true);
    }
  });

  it('prepareViewJob con vestido da lo mismo que la vista vestida horneada de golpe', () => {
    for (const q of Q) {
      const st = oddWorld();
      const prep = prepareViewJob(st, q, { topZ: 20 }, { dress });
      while (!prep.job.run(0)) { /* por pasos */ }
      const { view, baked } = prep.result()!;
      expect(view.copied).toBe(true);
      expect(baked.lights.some((l) => l.light.id === 'l1')).toBe(false);
      expect(bakeWorld(new WorldView(st, q).bakeable(), { topZ: 20 }).lights.some((l) => l.light.id === 'l1')).toBe(true);   // sin vestido, sí
      expect(same(baked, bakeWorld(new WorldView(st, q, { dress }).bakeable(), { topZ: 20 }))).toBe(true);
    }
  });
});
