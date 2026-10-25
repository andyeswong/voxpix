// Un cuadro del modo vóxel a partir del MISMO estado del mundo que el modo 2D: lo estático, las entidades y el agua
// salen de state.view (compuestos al vuelo, sin copias), con la luz 2.5D de las mismas fuentes (las entidades y el
// agua también tapan la luz).
import { render, camera, lightField3D, type PointLight3D, type RenderOptions } from '../core';
import { resolveLight } from './lightutil';
import { buildLayers, applyLayers } from '../lighting/shade';
import type { WorldState } from './state';

export interface Frame3DOptions {
  width: number; height: number;
  center: [number, number];               // punto del mundo (vóxeles del modelo) en el centro de la vista
  radius: number;                         // recorte alrededor del centro
  yaw: number; elevation: number; zoom: number;
  time: number;
  lights: boolean;
  ambient: readonly [number, number, number];
  edges?: boolean;                        // marcar las aristas entre vóxeles
  outline?: 'none' | 'outer' | 'both';    // contorno del render (por defecto, ninguno)
  outlineColor?: string;
}

export function frame3D(state: WorldState, o: Frame3DOptions): Uint8ClampedArray {
  const [cx, cy] = o.center;
  const src = state.view({ x0: cx - o.radius, y0: cy - Math.round(o.radius * 0.75), x1: cx + o.radius, y1: cy + Math.round(o.radius * 0.75) });
  const ro: RenderOptions = {
    width: o.width, height: o.height, originX: o.width / 2, originY: Math.round(o.height * 0.62), pivot: [cx + 0.5, cy + 0.5, 0],
    yaw: o.yaw, elevation: o.elevation, ppu: o.zoom, smooth: 0, shadows: false, ao: true, outline: o.outline ?? 'none', ...(o.outlineColor ? { outlineColor: o.outlineColor } : {}), pick: true,
  };
  const img = render(src, ro);
  const { width: W, height: H } = o;
  const rgba = img.rgba;
  const pk = img.pickKey!;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!rgba[i * 4 + 3]) { rgba[i * 4] = 13; rgba[i * 4 + 1] = 12; rgba[i * 4 + 2] = 18; rgba[i * 4 + 3] = 255; continue; }
    if (Number.isNaN(pk[i]!) || !(o.edges ?? o.zoom >= 3)) continue;   // el contorno no lleva aristas
    const r = x + 1 < W ? pk[i + 1]! : NaN, d = y + 1 < H ? pk[i + W]! : NaN;
    if ((!Number.isNaN(r) && r !== pk[i]) || (!Number.isNaN(d) && d !== pk[i])) for (let ch = 0; ch < 3; ch++) rgba[i * 4 + ch] = rgba[i * 4 + ch]! * 0.75;
  }
  if (!o.lights) return rgba;
  const lights: PointLight3D[] = state.lights
    .filter((l) => Math.abs(l.x - cx) < o.radius + 70 && Math.abs(l.y - cy) < o.radius + 70)
    .map((l) => { const p = resolveLight(l, o.time); return { x: l.x, y: l.y, z: l.z, radius: p.radius, color: p.color, intensity: p.intensity, spot: p.spot }; });
  const total = lightField3D(src, img, camera(ro), lights, o.ambient, { floor: false });
  return applyLayers(rgba, buildLayers({ cell: 1, cols: W, rows: H, ambient: o.ambient, total }, { x: 0, y: 0, width: W, height: H }, { steps: 8, softGlow: true }));
}
