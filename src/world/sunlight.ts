// EL SOL: una luz direccional que se suma a lo que ve el cielo (bake.ts, Baked.sky), según la cara, con la sombra de las nubes
// que pasan (climate.ts). Se suma al componer, sin rehornear; no proyecta sombras de los vóxeles (lo tapado lo dice el cielo
// horneado). La misma cuenta en la CPU y la GPU (FRAG_SCENE, FRAG_SHADE, FRAG_WATER y FRAG_ENTITY).
import { DIR_VECTORS } from '../core';
import { SKY_RAYS, type Baked } from './bake';
import { climateTie, climateStep, CLIMATE_CX, CLIMATE_CY, type ClimateTable, type WeatherFrame } from './climate';

export const CLOUD_DARK = 0.8;                  // lo que quita una nube del todo encima
const ENT = 0.75;                               // lo que le llega a una entidad, sobre lo que le llega al suelo

// faces: lo que se suma a cada cara (6 x rgb) con todo el cielo y sin nubes; entity: lo de una entidad
export interface SunLook { faces: Float32Array<ArrayBuffer>; entity: [number, number, number] }
export function sunLook(b: Baked, f: WeatherFrame | null | undefined): SunLook | null {
  const s = f?.sunlight;
  if (!f || !s || !b.sky) return null;
  const k = Math.max(0, s.intensity) * f.weather.levels(climateStep(f.tick)).sun;
  const d = s.dir ?? [-0.4, -0.5, 0.77], len = Math.hypot(d[0], d[1], d[2]) || 1;
  if (k <= 0 || d[2] <= 0) return null;                                            // (por debajo del horizonte)
  const [vx, vy] = f.camera ? f.camera.dirToView(d[0] / len, d[1] / len) : [d[0] / len, d[1] / len], vz = d[2] / len;
  const faces = new Float32Array(18);
  DIR_VECTORS.forEach((n, i) => { const w = Math.max(0, n[0] * vx + n[1] * vy + n[2] * vz) * k; for (let c = 0; c < 3; c++) faces[i * 3 + c] = s.color[c]! * w; });
  return { faces, entity: [0, 1, 2].map((c) => Math.fround(faces[4 * 3 + c]! * ENT)) as [number, number, number] };
}

// La sombra de las nubes en un punto de la vista (1 sin nube): entre las cuatro casillas de alrededor
export function cloudShade(t: ClimateTable, x: number, wy: number): number {
  const u = (x + t.kx) / CLIMATE_CX - 0.5, v = (Math.fround(wy) + t.ky + climateTie) / CLIMATE_CY - 0.5;
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
  const at = (i: number, j: number) => t.data[(Math.max(0, Math.min(t.h - 1, j - t.y0)) * t.w + Math.max(0, Math.min(t.w - 1, i - t.x0))) * 4 + 3]!;
  const a = at(iu, iv) * (1 - fu) + at(iu + 1, iv) * fu, c = at(iu, iv + 1) * (1 - fu) + at(iu + 1, iv + 1) * fu;
  return 1 - CLOUD_DARK * (a * (1 - fv) + c * fv);
}
// Cuánto sol le llega a un punto: su cielo (0..5) y las nubes
export const sunAmount = (t: ClimateTable, x: number, wy: number, sky: number): number => (sky / SKY_RAYS) * cloudShade(t, x, wy);
