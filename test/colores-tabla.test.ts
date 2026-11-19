// render pasaba cada color de "#rrggbb" a RGB con una expresión regular en cada píxel (~8 % del pintado de un recuadro);
// ahora con paletteRgb, una vez por color y render. Aquí: la tabla da lo mismo que rgbOf en todos los colores de todas las
// paletas del motor, y la imagen sale byte a byte igual que con la expresión regular (huellas tomadas en c9ded81)
import { it, expect } from 'vitest';
import { Model, material, box, render, rgbOf, rampOf, paletteRgb, type Palette } from '../src/core';
import { TEST_PALETTE } from '../src/samples/basic';
import { MEDIEVAL_PALETTE } from '../src/samples/medieval';
import { VEG_PALETTE } from '../src/samples/vegetacion';
import { PRESET_PALETTES } from '../src/samples/palettes';

// (las de la comunidad son listas planas: en rampas de 8)
const PALETTES: Array<[string, Palette]> = [
  ['test', TEST_PALETTE], ['medieval', MEDIEVAL_PALETTE], ['vegetacion', VEG_PALETTE],
  ...PRESET_PALETTES.map((p): [string, Palette] => [p.id, { ramps: Array.from({ length: Math.ceil(p.colors.length / 8) }, (_, r) => ({ name: `${p.id}${r}`, colors: p.colors.slice(r * 8, r * 8 + 8) })) }]),
];

it('paletteRgb: cada tono de cada rampa, y el contorno de cada rampa, igual que rgbOf, en todas las paletas', () => {
  let n = 0;
  for (const [, pal] of PALETTES) {
    const t = paletteRgb(pal);
    pal.ramps.forEach((ramp, r) => {
      ramp.colors.forEach((hex, k) => { expect(t.at(r * 16 + k)).toEqual(rgbOf(hex)); n++; });
      expect(t.line(r)).toEqual(rgbOf(rampOf(pal, r).colors[0]!));
    });
  }
  expect(n).toBeGreaterThan(100);
});

// Una escena con todas las rampas: escalones de altura distinta (luz y sombra distintas, varios tonos) y contorno
function scene(pal: Palette): Model {
  const m = new Model(pal);
  pal.ramps.forEach((_, r) => {
    const x = (r % 4) * 7 - 12, y = Math.floor(r / 4) * 7 - 8;
    box(m, x, y, 0, x + 4, y + 4, 2 + (r % 3) * 3, material(r, 1));
    box(m, x + 1, y + 1, 0, x + 2, y + 2, 9 + (r % 2) * 4, material(r, 2));
  });
  return m;
}
function fnv(a: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i]!, 0x01000193);
  return (h >>> 0).toString(16);
}
function prints(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, pal] of PALETTES) {
    const m = scene(pal);
    const all: string[] = [];
    for (const yaw of [0, 37, 90, 200]) for (const o of [{}, { outline: 'both' as const }, { outlineColor: '#102030' }]) {
      all.push(fnv(render(m, { width: 80, height: 70, originX: 40, originY: 52, yaw, ...o }).rgba));
    }
    out[id] = all.join(',');
  }
  return out;
}

const GOLDEN: Record<string, string> = {
  'test': 'fadc3649,70e27b2c,ec34b809,7df7d026,cb1e6666,1dbdc3de,aa9de319,38bf5207,9b6f6993,cba88a13,d9b553f2,f6f096f',
  'medieval': '728d3e23,8843ede5,cf053a48,6a6a8082,443db6a4,73034742,f3825a0,b01f72fc,e2117420,8c2b8312,1498d509,624c0189',
  'vegetacion': 'd034fa83,3afe66b,5ab71a4f,80678a1e,a75296f4,d15068e7,a9ccb718,843bf920,893c4d46,7e38b968,ba352b96,4280f79e',
  'pico-8': 'b737d07a,b6e226fe,dd9fa6f6,d7597a46,7d56f6e6,a69207f2,403fb051,cbdece07,129748fb,6ba0c28c,37dda97c,faf82cc2',
  'sweetie-16': '71d772c1,1e97d436,d2234245,4a4aa512,cd040596,4900508a,25ec9bb4,7f0e53a7,36dc011a,18a0c402,cde014cf,8321a31a',
  'endesga-32': 'e4c26cd,3af98c23,fe409735,9967a2bc,f6d952bf,1a2ac01c,3de72f26,fb27c0ae,dd86e8a8,a11b10ec,65a339df,1059b6fe',
  'apollo': '199075ef,ff2a4acf,b1ab1772,44520118,c6c95c69,df14e683,2088c714,5fb75965,60b51753,8315e6d4,52cc3431,f8cd15a0',
  'endesga-64': '63eb4b86,df5dd90b,9fabf97a,7b6279c4,95775125,9455b860,872630a1,44c4ec31,cb6f7f68,77542566,1ccb3d93,c7b77447',
  'aap-64': 'e9b68c0d,70288d8b,20bd0d88,3c929955,dd01816a,4217d53,94314603,da797a86,eeb6663e,f53672f0,b7a10ea1,135f74f1',
  'resurrect-64': '649948,caa9022f,bdb1e976,cc20ef15,f0d765ef,cd06a6d4,2f667696,30901869,93cd1c10,646be54c,59ff7232,cdfc238',
};

it('la imagen, byte a byte la de la expresión regular (huellas de c9ded81), en todas las paletas, ángulos y contornos', () => {
  expect(prints()).toEqual(GOLDEN);
});
