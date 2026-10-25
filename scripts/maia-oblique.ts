// MAIA con la cámara oblicua del escenario (la misma del mundo) en 8 direcciones, para mirarla de cerca
import { readFileSync, writeFileSync } from 'node:fs';
import { Model, render } from '../src/core';
import { encodePNG, onBackground } from '../src/core/png';
const maia = Model.fromJSON(JSON.parse(readFileSync('models/maia/maia.json', 'utf8')));
// Filas: inclinación del suelo (cuántos píxeles sube cada vóxel hacia el norte): 1, 0.5, 0.35. Columnas: 0, 45, 90, 135, 180
const W = 40, H = 64, ys = [1, 0.5, 0.35], yaws = [0, 45, 90, 135, 180];
const SW = yaws.length * W, SH = ys.length * H;
const sheet = new Uint8ClampedArray(SW * SH * 4);
ys.forEach((oy, r) => yaws.forEach((yaw, c) => {
  const img = render(maia, { width: W, height: H, originX: 20, originY: 58, pivot: [0.5, 0, 0], yaw, oblique: { y: oy, z: 1 }, flat: true, outline: 'none' });
  for (let y = 0; y < H; y++) sheet.set(img.rgba.subarray(y * W * 4, (y + 1) * W * 4), ((r * H + y) * SW + c * W) * 4);
}));
writeFileSync('out/maia_oblicua.png', encodePNG(SW, SH, onBackground(sheet, [58, 62, 74]), 4));
