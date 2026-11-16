// La cámara con objetivo (src/view/follow.ts): la zona muerta, el suavizado (el mismo a 30 que a 144 cuadros por
// segundo), los límites de la imagen, y targetPixel en los 4 giros (cae en el objetivo de verdad: un pilar rojo)
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { bakeWorld } from '../src/world/bake';
import { FollowCamera, targetPixel } from '../src/view/follow';

describe('cámara con objetivo', () => {
  it('zona muerta: dentro no se mueve; fuera va a por el objetivo hasta dejarlo en su borde', () => {
    const cam = new FollowCamera({ viewW: 200, viewH: 100, deadZone: [40, 20], speed: 6 });
    cam.snap(500, 300);
    expect([cam.x, cam.y]).toEqual([400, 250]);
    for (const [px, py] of [[519, 300], [481, 309], [500, 291]] as const) { cam.follow(px, py, 1 / 60); expect([cam.x, cam.y]).toEqual([400, 250]); }
    // Un salto a la derecha y abajo: al primer cuadro, solo una parte; al final, el objetivo en el borde de la zona
    cam.follow(600, 380, 1 / 60);
    const k = 1 - Math.exp(-6 / 60);
    expect(cam.x).toBeCloseTo(400 + (600 - 20 - 100 - 400) * k, 9);
    for (let i = 0; i < 300; i++) cam.follow(600, 380, 1 / 60);
    expect(cam.x + 100 + 20).toBeCloseTo(600, 3);                         // el objetivo, en el borde derecho de la zona
    expect(cam.y + 50 + 10).toBeCloseTo(380, 3);
  });

  it('el suavizado no depende de los cuadros por segundo', () => {
    const a = new FollowCamera({ viewW: 100, viewH: 100, speed: 5 }), b = new FollowCamera({ viewW: 100, viewH: 100, speed: 5 });
    a.snap(0, 0); b.snap(0, 0);
    for (let i = 0; i < 30; i++) a.follow(300, -120, 1 / 30);
    for (let i = 0; i < 144; i++) b.follow(300, -120, 1 / 144);
    expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6);
    const c = new FollowCamera({ viewW: 100, viewH: 100, speed: Infinity });
    c.snap(0, 0); c.follow(300, -120, 1 / 60);
    expect([c.x + 50, c.y + 50]).toEqual([300, -120]);                  // sin suavizado, de golpe
  });

  it('la ventana no sale de la imagen, y si la imagen es más pequeña se centra', () => {
    const cam = new FollowCamera({ viewW: 100, viewH: 60, speed: Infinity, bounds: { width: 400, height: 50 } });
    cam.snap(10, 10);
    expect([cam.vx, cam.vy]).toEqual([0, -5]);
    cam.follow(399, 0, 1 / 60);
    expect(cam.vx).toBe(300);
  });

  it('en los 4 giros, el píxel del objetivo cae en él (un pilar rojo en un suelo gris)', () => {
    const pal = { ramps: [{ name: 'suelo', colors: ['#404040', '#606060', '#808080'] }, { name: 'rojo', colors: ['#a01010', '#d02020', '#ff3030'] }] };
    const s = new StaticVoxels(pal, 40, 32, 0, 15);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) s.set(x, y, 0, material(0, 1));
    for (let z = 1; z <= 6; z++) for (const [x, y] of [[27, 9], [28, 9], [27, 10], [28, 10]] as const) s.set(x, y, z, material(1, 1));
    const st = new WorldState(s, [], null);
    for (const q of [0, 1, 2, 3] as Quarter[]) {
      const view = new WorldView(st, q);
      const b = bakeWorld(view.bakeable(), { topZ: 15 });
      const [px, py] = targetPixel(view.camera, b, 28, 10, 7);            // lo alto del pilar, en su centro
      const i = (Math.floor(py) * b.width + Math.floor(px)) * 4;           // floor: el píxel en que cae
      expect(b.rgba[i]! - b.rgba[i + 1]!, `giro ${q}`).toBeGreaterThan(60);   // rojo
      // Y la cámara que lo sigue lo deja en el centro de la ventana
      const cam = new FollowCamera({ viewW: 64, viewH: 48, speed: Infinity });
      cam.follow(px, py, 1 / 60);
      expect(Math.abs(cam.x + 32 - px)).toBeLessThan(1e-9);
    }
  });
});
