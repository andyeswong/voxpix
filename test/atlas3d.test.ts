// El atlas 3D de cuerpos de la GPU (Atlas3D, en GpuCompositor: los cuerpos para el rayo de la luz propia y los de la
// sombra de las entidades): un cuerpo nuevo se sube solo; el atlas se rehace entero solo cuando no cabe (el doble de
// ancho), así que con N cuerpos se rehace unas log2(N) veces y no N. Y lo que lee el shader (texelFetch dentro de cada
// cuerpo) es lo mismo que con la subida entera de antes. Con una GPU de mentira que guarda lo subido
import { describe, it, expect } from 'vitest';
import { Atlas3D } from '../src/view/gpu/compositor';

// Un WebGL2 de mentira: una textura 3D R8 (lo último de texImage3D, y texSubImage3D encima)
function fakeGl() {
  const t = { w: 0, h: 0, d: 0, data: new Uint8Array(0), full: 0, parts: 0 };
  const gl = {
    TEXTURE_3D: 1, TEXTURE0: 2, R8: 3, RED: 4, UNSIGNED_BYTE: 5,
    activeTexture() {}, bindTexture() {},
    texImage3D(_t: number, _l: number, _i: number, w: number, h: number, d: number, _b: number, _f: number, _ty: number, data: Uint8Array) {
      t.w = w; t.h = h; t.d = d; t.data = new Uint8Array(w * h * d); if (data) t.data.set(data); t.full++;
    },
    texSubImage3D(_t: number, _l: number, x0: number, y0: number, z0: number, w: number, h: number, d: number, _f: number, _ty: number, data: Uint8Array) {
      for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t.data[((z0 + z) * t.h + y0 + y) * t.w + x0 + x] = data[(z * h + y) * w + x]!;
      t.parts++;
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, t };
}
const at = (t: ReturnType<typeof fakeGl>['t'], x: number, y: number, z: number) => t.data[(z * t.h + y) * t.w + x]!;

describe('el atlas 3D de cuerpos', () => {
  it('sube cada cuerpo nuevo solo, se rehace unas log2(N) veces, y se lee lo mismo que subiéndolo entero', () => {
    const { gl, t } = fakeGl();
    const atlas = new Atlas3D({} as WebGLTexture);
    const bodies: Array<{ ax: number; size: [number, number, number]; data: Uint8Array }> = [];
    let seed = 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 200; k++) {
      const size: [number, number, number] = [3 + Math.floor(rnd() * 14), 3 + Math.floor(rnd() * 14), 4 + Math.floor(rnd() * 30)];
      const data = new Uint8Array(size[0] * size[1] * size[2]);
      for (let i = 0; i < data.length; i++) data[i] = rnd() < 0.4 ? 255 : 0;
      bodies.push({ ax: atlas.add(size, data), size, data });
      atlas.sync(gl);                                                       // como prewarm: uno por llamada
      // Lo que lee el shader de cada cuerpo hasta ahora: su dato, celda a celda
      for (const b of k % 20 === 19 ? bodies : [bodies[k]!]) {
        const [sx, sy, sz] = b.size;
        for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (at(t, b.ax + x, y, z) !== b.data[(z * sy + y) * sx + x]) expect(`cuerpo ${bodies.indexOf(b)}, ${x},${y},${z}`).toBe('igual');
      }
    }
    // Uno detrás de otro en x, como antes
    for (let k = 1; k < bodies.length; k++) expect(bodies[k]!.ax).toBe(bodies[k - 1]!.ax + bodies[k - 1]!.size[0]);
    expect(atlas.stats.full + atlas.stats.parts).toBe(200);
    expect(atlas.stats.full).toBeLessThan(20);                            // antes, 200: una vez por cuerpo nuevo
    expect(atlas.stats.full).toBe(t.full);
    expect(atlas.stats.parts).toBe(t.parts);
    // Sin nada nuevo, sync no sube nada
    atlas.sync(gl);
    expect(t.full + t.parts).toBe(200);
  });
});
