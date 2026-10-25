import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorldState, type WorldTheme } from '../../src/world/build';
import { generateLayout, TILE } from '../../src/worldgen';
import { THEMES } from '../../src/content/themes';
import { FixedLoop, Runtime, type TickInput } from '../../src/runtime/runtime';
import { Model, material } from '../../src/core';

// Las partidas largas tardan: en oficina, una de 2400 ticks por partida pasa de los 5 s por defecto
const SLOW = 30_000;

// La partida es función de la semilla y de la entrada de cada tick, nada más: ni del ritmo de cuadros, ni del orden
// en que se construyó el mundo, ni del reloj. Es lo que permite, p. ej., medir el balance de un juego con muchas semillas.

function game(theme: WorldTheme, seed: number): Runtime {
  const layout = generateLayout(THEMES[theme].spec, seed);
  const { state } = buildWorldState(layout, theme);
  return new Runtime(state, { x: layout.spawn.x, y: layout.rows * TILE - 1 - layout.spawn.y }, { radius: 4, speed: 70 });
}

// Una entrada pseudoaleatoria por tick, fija para una semilla: cambia de rumbo cada 30 ticks y pisa fuerte a veces
function script(seed: number): (tick: number) => TickInput {
  const inputs: TickInput[] = [];
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let dx = 0, dy = 0;
  return (tick) => {
    while (inputs.length <= tick) {
      if (inputs.length % 30 === 0) { const ang = rand() * Math.PI * 2; dx = Math.cos(ang); dy = Math.sin(ang); }
      inputs.push({ dx, dy, stomp: rand() < 0.05 });
    }
    return inputs[tick]!;
  };
}

function run(rt: Runtime, input: (tick: number) => TickInput, until: number): void {
  while (rt.tick < until) rt.step(input(rt.tick));
}

// medieval 7 tiene agua y fuente: las ondas, las gotas y el chorro entran en juego
const CASES: Array<[WorldTheme, number]> = [['medieval', 7], ['cyberpunk', 3], ['oficina', 2]];

describe('determinismo del runtime', () => {
  it.each(CASES)('%s, semilla %i: misma semilla y misma entrada, misma huella en cada control', (theme, seed) => {
    const a = game(theme, seed), b = game(theme, seed);
    const input = script(seed);
    const seen = new Set<string>();
    let wet = false;
    for (const t of [60, 600, 1200, 2400]) {
      while (a.tick < t) { a.step(input(a.tick)); b.step(input(b.tick)); wet ||= a.player.inWater; }
      expect(a.hash(), `tick ${t}`).toBe(b.hash());
      seen.add(a.hash());
    }
    expect(seen.size, 'la partida tiene que cambiar entre controles').toBe(4);
    // En el mapa con agua, el guion tiene que meterse en ella: si no, las ondas y las gotas no se prueban
    if (theme === 'medieval') expect(wet, 'el jugador nunca pisó el agua').toBe(true);
  }, SLOW);

  it('un solo pisotón de diferencia en el agua cambia la huella', () => {
    const a = game('medieval', 7), b = game('medieval', 7);
    const base = script(7);
    // El primer tick que acaba con los pies en el agua (el pisotón se mira después de moverse): lo encuentra una partida de prueba
    const probe = game('medieval', 7);
    let wet = -1;
    for (let t = 0; t < 3000 && wet < 0; t++) { probe.step(base(t)); if (probe.player.inWater) wet = t; }
    expect(wet, "el guion tiene que meter al jugador en el agua").toBeGreaterThanOrEqual(0);
    const changed = (t: number) => (t === wet ? { ...base(t), stomp: !base(t).stomp } : base(t));
    run(a, base, wet + 120); run(b, changed, wet + 120);
    expect(a.hash()).not.toBe(b.hash());
  }, SLOW);

  it('otra semilla, otra partida', () => {
    const a = game('medieval', 7), b = game('medieval', 8);
    run(a, script(1), 120); run(b, script(1), 120);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('instantánea a mitad, seguir, volver a ella y repetir: misma huella', () => {
    const rt = game('medieval', 7);
    const input = script(7);
    run(rt, input, 300);
    const snap = rt.snapshot();
    run(rt, input, 600);
    const first = rt.hash();
    rt.restore(snap);
    expect(rt.tick).toBe(300);
    run(rt, input, 600);
    expect(rt.hash()).toBe(first);
  });

  it('el ritmo de cuadros no cambia la partida: 60 Hz, 30 Hz, 144 Hz y cuadros irregulares dan la misma huella', () => {
    const input = script(7);
    const N = 600;
    const hashes = new Set<string>();
    const frames: Array<(i: number) => number> = [
      () => 1 / 60, () => 1 / 30, () => 1 / 144,
      (i) => [0.011, 0.023, 0.017, 0.041, 0.006][i % 5]!,
    ];
    for (const dt of frames) {
      const rt = game('medieval', 7);
      const loop = new FixedLoop(rt, input);
      let elapsed = 0;
      for (let i = 0; rt.tick < N; i++) { const d = dt(i); elapsed += d; loop.advance(d); }
      expect(rt.tick).toBe(N);
      // Y el tiempo de juego sigue al real: N ticks tras N/60 s (más, como mucho, el último cuadro)
      expect(elapsed).toBeGreaterThanOrEqual(N / 60 - 1e-6);
      expect(elapsed).toBeLessThan(N / 60 + 0.05);
      hashes.add(rt.hash());
    }
    expect(hashes.size).toBe(1);
  }, SLOW);

  it('un cuadro enorme no encadena más de 5 ticks: la partida se frena, no se acumula', () => {
    const rt = game('oficina', 2);
    const loop = new FixedLoop(rt, script(2));
    expect(loop.advance(10)).toBe(5);
    expect(loop.advance(1 / 60)).toBe(1);
  });

  it('con modelo, el runtime crea la entidad del mundo, la lleva con el cuerpo y entra en la huella', () => {
    const layout = generateLayout(THEMES.medieval.spec, 7);
    const model = new Model({ ramps: [{ name: 'tela', colors: ['#202040', '#404080', '#6060c0'] }] }, 'cubo');
    for (let z = 0; z < 6; z++) for (let y = -2; y < 2; y++) for (let x = -2; x < 2; x++) model.set(x, y, z, material(0, 1));
    const make = () => {
      const { state } = buildWorldState(layout, 'medieval');
      return new Runtime(state, { x: layout.spawn.x, y: layout.rows * TILE - 1 - layout.spawn.y }, { radius: 4, speed: 70, model });
    };
    const a = make(), b = make();
    const input = script(7);
    run(a, input, 300); run(b, input, 300);
    const e = a.world.entities.get(a.entityId!)!;
    expect([e.x, e.y, e.z]).toEqual([Math.round(a.player.x), Math.round(a.player.y), a.player.z]);
    expect(e.yaw).toBe(a.player.facing * 45);
    expect(a.hash()).toBe(b.hash());
    // Si la entidad se moviera distinto, la huella lo vería
    b.world.entities.move(b.entityId!, e.x + 1, e.y, e.z, e.yaw);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('con walk, andando cambia de cuadro cada WALK_FRAME_MS, en orden, y parado vuelve al quieto', () => {
    const layout = generateLayout(THEMES.oficina.spec, 2);
    const pal = { ramps: [{ name: 'tela', colors: ['#202040', '#404080', '#6060c0'] }] };
    const cube = (h: number) => {
      const m = new Model(pal, `cubo${h}`);
      for (let z = 0; z < h; z++) m.set(0, 0, z, material(0, 1));
      return m;
    };
    const idle = cube(4), frames = [1, 2, 3, 5, 6, 7, 8, 9].map(cube);
    const { state } = buildWorldState(layout, 'oficina');
    const rt = new Runtime(state, { x: layout.spawn.x, y: layout.rows * TILE - 1 - layout.spawn.y }, { radius: 4, speed: 70, model: idle, walk: frames });
    const e = () => state.entities.get(rt.entityId!)!;
    const idleId = e().modelId;
    const seen: number[] = [];
    for (let t = 0; t < 47; t++) { rt.step({ dx: 1, dy: 0, stomp: false }); seen.push(e().modelId); }
    // 6 ticks por cuadro (100 ms a 60 Hz): en 47 ticks, los 8 cuadros una vez cada uno y en orden, sin el quieto
    const distinct = seen.filter((m, i) => i === 0 || m !== seen[i - 1]);
    expect(distinct).toEqual(frames.map((f) => state.models.register(f)));
    expect(seen.filter((m) => m === distinct[1]).length).toBe(6);
    expect(seen).not.toContain(idleId);
    // El tick 48 cierra el ciclo: vuelve al primero
    rt.step({ dx: 1, dy: 0, stomp: false });
    expect(e().modelId).toBe(distinct[0]);
    rt.step({ dx: 0, dy: 0, stomp: false });
    expect(e().modelId).toBe(idleId);
  });

  it('la luz en la mano: la entidad va junto al cuerpo girada con él, su luz sale de la lente y la partida se repite', () => {
    const layout = generateLayout(THEMES.oficina.spec, 2);
    const pal = { ramps: [{ name: 'metal', colors: ['#202040', '#404080', '#6060c0'] }] };
    const cube = (h: number) => { const m = new Model(pal, `c${h}`); for (let z = 0; z < h; z++) m.set(0, 0, z, material(0, 1)); return m; };
    const carry = { model: cube(2), kind: 'lantern' as const, cone: 40, hand: [8, -2, 6] as const, emit: [0, -7, 1] as const };
    const make = () => {
      const { state } = buildWorldState(layout, 'oficina');
      return new Runtime(state, { x: layout.spawn.x, y: layout.rows * TILE - 1 - layout.spawn.y }, { radius: 4, speed: 70, model: cube(6), carry });
    };
    const a = make(), b = make();
    const input = script(4);
    run(a, input, 200); run(b, input, 200);
    expect(a.hash()).toBe(b.hash());
    const hand = a.world.entities.get(a.carryId!)!;
    const p = a.player, yaw = p.facing * 45, r = (yaw * Math.PI) / 180;
    // La mano: el agarre girado con el facing del cuerpo
    expect(hand.x).toBe(Math.round(p.x + 8 * Math.cos(r) + 2 * Math.sin(r)));
    expect(hand.y).toBe(Math.round(p.y + 8 * Math.sin(r) - 2 * Math.cos(r)));
    expect(hand.z).toBe(p.z + 6);
    expect(hand.yaw).toBe(yaw);
    // La luz: un foco en la lente (mano + emit, girados con el cuerpo) que apunta hacia donde mira, y cuyo dueño es el
    // cuerpo, para que no la tape
    const body = a.world.entities.get(a.entityId!)!;
    const light = a.world.lights.get(a.carryLightId!)!;
    expect(light.cone).toBe(40);
    expect(light.owner).toBe(a.entityId);
    expect(light.x).toBeCloseTo(body.x + 0.5 + 8 * Math.cos(r) + 9 * Math.sin(r), 6);
    expect(light.y).toBeCloseTo(body.y + 8 * Math.sin(r) - 9 * Math.cos(r), 6);
    expect(light.z).toBe(body.z + 7);
  });

  it('el runtime y la simulación (src/runtime, src/sim) no usan reloj ni azar del navegador', () => {
    const files = ['../../src/runtime', '../../src/sim'].flatMap((d) =>
      (readdirSync(join(__dirname, d), { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => join(__dirname, d, f)));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.random|performance\.now|Date\.now|new Date\(/);
    }
  });
});
