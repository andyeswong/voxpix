// CÁMARA CON OBJETIVO: la ventana de la vista (vx, vy de Frame2DOptions, en píxeles de la imagen horneada) sigue a un
// punto, normalmente un cuerpo, con zona muerta y suavizado. Es de la vista, no de la simulación: no toca el mundo ni
// la huella, y avanza con el tiempo real del cuadro.
//
//   const cam = new FollowCamera({ viewW: 384, viewH: 216, deadZone: [24, 16], speed: 6, bounds: baked });
//   cam.snap(...targetPixel(view, baked, body.x, body.y, body.z));        // al empezar o tras un salto
//   cada cuadro:
//   cam.follow(...targetPixel(view, baked, body.x, body.y, body.z), dt);
//   compositor.frame(state, baked, { ...opts, vx: cam.vx, vy: cam.vy });
//
// - Zona muerta: un rectángulo de deadZone[0] x deadZone[1] píxeles centrado en la ventana. Mientras el objetivo está
//   dentro, la cámara no se mueve; al salir, va a por él hasta que vuelve a quedar en su borde.
// - Suavizado: cada cuadro recorre la parte 1 - e^(-speed * dt) de lo que le falta (speed por segundo: con 6, el 90 %
//   en ~0,38 s, igual a 30 que a 144 cuadros por segundo). speed Infinity: sin suavizado, va de golpe.
// - bounds (opcional): la ventana no sale de la imagen horneada (si la imagen es más pequeña, se centra).
// - Los 4 giros: targetPixel pasa el punto del mundo a la vista girada (WorldView.camera) y lo proyecta con la cámara
//   de su horneado. Al cambiar de giro hay otra imagen: snap con el objetivo en la nueva.
import type { Baked } from '../world/bake';
import type { ViewCamera } from '../world/view';

export interface FollowOptions {
  viewW: number;                       // la ventana, en píxeles
  viewH: number;
  deadZone?: readonly [number, number];   // ancho y alto de la zona muerta, en píxeles (por defecto 0 x 0: siempre al centro)
  speed?: number;                      // por segundo (por defecto 6; Infinity, de golpe)
  bounds?: { width: number; height: number } | null;   // la imagen en que se mueve la ventana (un Baked vale)
}

export class FollowCamera {
  // La esquina de la ventana, sin redondear (el suavizado necesita los decimales)
  x = 0;
  y = 0;
  viewW: number;
  viewH: number;
  deadZone: [number, number];
  speed: number;
  bounds: { width: number; height: number } | null;

  constructor(o: FollowOptions) {
    this.viewW = o.viewW; this.viewH = o.viewH;
    this.deadZone = [o.deadZone?.[0] ?? 0, o.deadZone?.[1] ?? 0];
    this.speed = o.speed ?? 6;
    this.bounds = o.bounds ?? null;
  }

  // La esquina, en píxeles enteros (lo que va a Frame2DOptions)
  get vx(): number { return Math.round(this.x); }
  get vy(): number { return Math.round(this.y); }

  // Centra la ventana en el punto de golpe (dentro de bounds)
  snap(px: number, py: number): void {
    this.x = px - this.viewW / 2; this.y = py - this.viewH / 2;
    this.clamp();
  }

  // Un cuadro de `dt` segundos siguiendo al punto (px, py) de la imagen
  follow(px: number, py: number, dt: number): void {
    const [tx, ty] = this.wanted(px, py);
    const k = this.speed === Infinity ? 1 : 1 - Math.exp(-this.speed * Math.max(0, dt));
    this.x += (tx - this.x) * k; this.y += (ty - this.y) * k;
    this.clamp();
  }

  // Dónde tendría que estar la esquina para que el punto quede dentro de la zona muerta (la más cercana a la de ahora)
  private wanted(px: number, py: number): [number, number] {
    const cx = this.x + this.viewW / 2, cy = this.y + this.viewH / 2, hw = this.deadZone[0] / 2, hh = this.deadZone[1] / 2;
    let nx = cx, ny = cy;
    if (px < cx - hw) nx = px + hw; else if (px > cx + hw) nx = px - hw;
    if (py < cy - hh) ny = py + hh; else if (py > cy + hh) ny = py - hh;
    return [nx - this.viewW / 2, ny - this.viewH / 2];
  }

  private clamp(): void {
    const b = this.bounds;
    if (!b) return;
    this.x = b.width <= this.viewW ? (b.width - this.viewW) / 2 : Math.max(0, Math.min(b.width - this.viewW, this.x));
    this.y = b.height <= this.viewH ? (b.height - this.viewH) / 2 : Math.max(0, Math.min(b.height - this.viewH, this.y));
  }
}

// Dónde cae en la imagen horneada el punto (x, y, z) del mundo, con la vista girada `camera` (la de WorldView; sin
// girar, la del giro 0) y la cámara de su horneado: coordenadas continuas (las de Camera.project), el píxel es su floor
export function targetPixel(camera: Pick<ViewCamera, 'pointToView'> | null, baked: Pick<Baked, 'cam'>, x: number, y: number, z: number): [number, number] {
  const [vx, vy] = camera ? camera.pointToView(x, y) : [x, y];
  const [sx, sy] = baked.cam.project(vx, vy, z);
  return [sx, sy];
}
