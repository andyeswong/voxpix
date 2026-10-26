// Explorar el mundo de la demo en primera persona (NARUTO, pedido de Andrés): el mismo render que la vista Explorar
// del editor (renderFirstPerson del núcleo, en la GPU si hay) sobre los vóxeles estáticos del mundo, con el agua del
// simulador como superficie (se mueve con las ondas) y las luces del mundo con su parpadeo. El personaje invisible
// sale de donde está MAIA. Las entidades (MAIA, los flotantes) no se ven todavía: solo el escenario y el agua.
import { Walker, renderFirstPerson, camera, lightField3D, fpBasis, type FpCamera, type FpOptions, type PointLight3D, type Rendered } from '@core/index';
import { GpuVoxelRenderer } from '../../../src/view/gpu/voxrender';
import { buildLayers, applyLayers } from '../../../src/lighting/shade';
import { resolveLight } from '../../../src/world/lightutil';
import type { WorldState } from '../../../src/world/state';

const VIEW_DIST = 160;     // hasta dónde se ve (vóxeles)

export class WorldExplorer {
  walker: Walker | null = null;
  private gpu: GpuVoxelRenderer | null | undefined;
  private state: WorldState | null = null;
  renderMs = 0;
  readonly parts = { scene: 0, light: 0, layers: 0 };

  start(state: WorldState, from: { x: number; y: number; z: number }, height: number): void {
    this.state = state;
    this.walker = new Walker(from.x + 0.5, from.y + 0.5, from.z, { height });
    this.walker.yaw = 0; this.walker.pitch = -4;
  }
  stop(): void { this.walker = null; }
  get on(): boolean { return !!this.walker; }

  look(dx: number, dy: number): void {
    const w = this.walker;
    if (!w) return;
    w.yaw = (((w.yaw + dx * 0.15) % 360) + 360) % 360;
    w.pitch = Math.max(-89, Math.min(89, w.pitch - dy * 0.15));
  }

  setHeight(h: number): void {
    const w = this.walker;
    if (!w) return;
    w.height = Math.max(1, Math.min(48, h));
    w.radius = Math.min(0.3, w.height * 0.3);
    w.speed = 4 + w.height * 1.5;
  }

  // Lo que bloquea: lo que no se atraviesa del escenario (materiales) y nada por debajo del fondo del mundo
  private solid = (x: number, y: number, z: number): boolean => {
    const s = this.state!.solid;
    if (z < s.zMin) return true;
    return s.blocks(s.get(x, y, z));
  };

  step(dt: number, keys: Set<string>): void {
    const w = this.walker;
    if (!w) return;
    const k = (...c: string[]) => c.some((x) => keys.has(x));
    w.step(dt, {
      forward: (k('w', 'arrowup') ? 1 : 0) - (k('s', 'arrowdown') ? 1 : 0),
      strafe: (k('d', 'arrowright') ? 1 : 0) - (k('a', 'arrowleft') ? 1 : 0),
      jump: k(' '), run: k('shift'),
    }, this.solid);
  }

  // Un cuadro de W x H: el escenario, el agua y, con luces, las fuentes del mundo por las capas MULTIPLY/ADD
  frame(W: number, H: number, time: number, lights: boolean, ambient: readonly [number, number, number], outline: 'none' | 'outer' | 'both'): Uint8ClampedArray {
    const st = this.state!, w = this.walker!, s = st.solid;
    const cam: FpCamera = { ...w.eye(), fov: 75 };
    const water = st.water?.firstPersonWater(s.palette) ?? undefined;
    const o: FpOptions = { width: W, height: H, outline, maxDist: VIEW_DIST, bounds: { minX: 0, maxX: s.width - 1, minY: 0, maxY: s.depth - 1, minZ: s.zMin, maxZ: s.zMax }, ...(water ? { water } : {}) };
    if (this.gpu === undefined) this.gpu = GpuVoxelRenderer.create();
    const t0 = performance.now();
    // La versión de los VÓXELES (la más alta de sus trozos): el reloj del mundo también avanza con el agua, y subir el
    // mundo entero en cada cuadro costaba ~100 ms
    let rev = 0;
    for (let c = 0; c < s.versions.length; c++) if (s.versions[c]! > rev) rev = s.versions[c]!;
    const img: Rendered = (this.gpu && this.gpu.firstPerson(s, cam, o, rev)) || renderFirstPerson(s, cam, o);
    const t1 = performance.now();
    this.parts.scene = this.parts.scene * 0.9 + (t1 - t0) * 0.1;
    let rgba = img.rgba;
    if (lights) {
      // Las fuentes que pueden alumbrar algo de lo que se ve (su radio llega a menos de VIEW_DIST), las más cercanas
      // primero y como mucho 48 (la GPU toma 64), con su parpadeo
      const ls: PointLight3D[] = st.lights.map((l) => ({ l, d: Math.hypot(l.x - cam.x, l.y - cam.y, l.z - cam.z) - resolveLight(l, 0).radius }))
        .filter((e) => e.d < VIEW_DIST).sort((a, b) => a.d - b.d).slice(0, 48)
        .map(({ l }) => { const p = resolveLight(l, time); return { x: l.x, y: l.y, z: l.z, radius: p.radius, color: p.color, intensity: p.intensity, ...(p.spot ? { spot: p.spot } : {}) }; });
      const total = (this.gpu && this.gpu.lightFieldFirstPerson(s, cam, o, ls, ambient, rev))
        || lightField3D(s, img, camera({ width: 1, height: 1, originX: 0, originY: 0 }), ls, ambient, { floor: false });
      // El agua y el contorno, sin vóxel: con la luz de un vecino que lo tenga (si no, el ambiente)
      for (let i = 0; i < W * H; i++) {
        if (!Number.isNaN(img.pickKey![i]!) || img.rgba[i * 4 + 3] === 0) continue;
        const x = i % W;
        for (const n of [i - 1, i + 1, i - W, i + W]) {
          if (n < 0 || n >= W * H || Math.abs((n % W) - x) > 1 || Number.isNaN(img.pickKey![n]!)) continue;
          total[i * 3] = total[n * 3]!; total[i * 3 + 1] = total[n * 3 + 1]!; total[i * 3 + 2] = total[n * 3 + 2]!;
          break;
        }
      }
      const t2 = performance.now();
      this.parts.light = this.parts.light * 0.9 + (t2 - t1) * 0.1;
      const layers = buildLayers({ cell: 1, cols: W, rows: H, ambient, total }, { x: 0, y: 0, width: W, height: H }, { steps: 8, softGlow: true });
      rgba = applyLayers(img.rgba, layers) as Uint8ClampedArray<ArrayBuffer>;
      this.parts.layers = this.parts.layers * 0.9 + (performance.now() - t2) * 0.1;
    }
    // El cielo: un degradado oscuro hacia el horizonte (lo vacío del render)
    const out = new Uint8ClampedArray(W * H * 4);
    const { f, u } = fpBasis(cam);
    for (let j = 0; j < H; j++) {
      const up = Math.max(0, Math.min(1, f[2] + u[2] * (1 - ((j + 0.5) / H) * 2) * 0.6));
      const sky = [26 + 30 * (1 - up), 25 + 32 * (1 - up), 38 + 44 * (1 - up)];
      for (let i = 0; i < W; i++) {
        const p = (j * W + i) * 4;
        if (img.rgba[p + 3]) { out[p] = rgba[p]!; out[p + 1] = rgba[p + 1]!; out[p + 2] = rgba[p + 2]!; }
        else { out[p] = sky[0]!; out[p + 1] = sky[1]!; out[p + 2] = sky[2]!; }
        out[p + 3] = 255;
      }
    }
    this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;
    return out;
  }
}
