import { readFileSync, writeFileSync } from 'node:fs';
import { Model, render, assertClosedPalette, fitFrame, type RenderOptions } from '../core';
import { encodePNG, onBackground } from '../core/png';
import { medievalScene } from '../samples/medieval';
import { buildSampleRecipe } from '../samples/recipes';
import { describeWorld, snapshotWorld } from '../world/recipe';
import { loadPxl, paletteFromPxl, spriteToVoxels, toPxlSource, pxlAssets, stackFromPxl, toPxlStack, pxlDirectives, applyDirectives } from '../pxl/bridge';

// CLI de VoxPix.
//   voxpix render <modelo.json|sample> <salida.png> [--yaw 0] [--elev 30] [--scale 8] [--size WxH] [--origin x,y]   (sin --size: el encuadre que lo contiene)
//                [--outline outer|both|none] [--bg #8a92a6] [--turn 8]   (--turn N: una tira con N ángulos)
//   voxpix export-pxl <modelo.json|sample> <salida.px.js> [--turn 8] [--size ..] [--origin ..] [--name n]
//                (luego: node vendor/pxl/bin/pxl.js build <salida.px.js> -> PNG, hoja + JSON, vistas previas)
//   voxpix import-pxl <arte.px.js> <sprite|-> <salida.json> [--plane front|top] [--z n]
//                (sprite "-": solo la paleta; el modelo sale vacío con esas rampas)
//   voxpix import-pxl <arte.px.js> --stack <prefijo> <salida.json>   capas <prefijo>_zNN vistas desde arriba
//                [--outline #rrggbb]   color fijo del contorno (si no, el de la directiva // voxpix: outline del .px.js)
//   voxpix export-pxl <modelo.json> <salida.px.js> --stack <prefijo>    el modelo como esas capas
//   voxpix world <receta.json> <salida.png|-> [--at x,y] [--size WxH] [--ticks n] [--scale n] [--whole] [--lights no]
//                [--info info.json]   un mundo entero desde una receta (src/world/recipe.ts; con "theme", uno de muestra).
//                En la salida, lo que el agente necesita saber del mundo (describeWorld): tamaño, columnas, muebles, luces

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

function load(src: string): Model {
  if (src === 'sample') return medievalScene().model;
  return Model.fromJSON(JSON.parse(readFileSync(src, 'utf8')));
}

function importPxl(): void {
  const stack = arg('stack', '');
  if (stack) {
    const [, art, , , out] = process.argv.slice(2);
    if (!art || !out) { console.error('uso: voxpix import-pxl <arte.px.js> --stack <prefijo> <salida.json>'); process.exit(1); }
    const src = readFileSync(art, 'utf8');
    const p = loadPxl(src, art);
    const m = new Model(applyDirectives(paletteFromPxl(p, `${stack}_z00`), pxlDirectives(src), arg('outline', '') || undefined), stack);
    const n = stackFromPxl(p, stack, m);
    writeFileSync(out, JSON.stringify(m.toJSON()) + '\n');
    console.log(`${out}: ${n} vóxeles desde las capas ${stack}_zNN`);
    return;
  }
  const [, art, sprite, out] = process.argv.slice(2);
  if (!art || !sprite || !out) { console.error('uso: voxpix import-pxl <arte.px.js> <sprite|-> <salida.json>'); process.exit(1); }
  const src = readFileSync(art, 'utf8');
  const p = loadPxl(src, art);
  const names = pxlAssets(p);
  if (sprite !== '-' && !names.includes(sprite)) { console.error(`no hay sprite "${sprite}"; hay: ${names.join(', ')}`); process.exit(1); }
  const m = new Model(applyDirectives(paletteFromPxl(p, sprite === '-' ? undefined : sprite), pxlDirectives(src), arg('outline', '') || undefined), sprite === '-' ? 'importado' : sprite);
  const n = sprite === '-' ? 0 : spriteToVoxels(p, sprite, m, { plane: arg('plane', 'front') as 'front' | 'top', z: Number(arg('z', '0')) });
  writeFileSync(out, JSON.stringify(m.toJSON()) + '\n');
  console.log(`${out}: ${m.palette.ramps.length} rampas, ${n} vóxeles`);
}

function exportPxl(): void {
  const [, src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('uso: voxpix export-pxl <modelo.json|sample> <salida.px.js>'); process.exit(1); }
  const model = load(src);
  const stack = arg('stack', '');
  if (stack) {
    writeFileSync(out, toPxlStack(model, stack));
    console.log(`${out}: ${model.bounds() ? model.bounds()!.maxZ + 1 : 0} capas "${stack}_zNN"`);
    return;
  }
  // Sin --size, el encuadre que contiene el modelo en cualquier giro (fitFrame: 64x48 si cabe)
  const fit = fitFrame(model.bounds(), Number(arg('elev', '30')));
  const [w, h] = arg('size', `${fit.W}x${fit.H}`).split('x').map(Number) as [number, number];
  const [ox, oy] = arg('origin', process.argv.includes('--size') ? `${Math.floor(w / 2)},${h - 4}` : `${fit.originX},${fit.originY}`).split(',').map(Number) as [number, number];
  const turn = Number(arg('turn', '8'));
  const name = arg('name', model.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'modelo');
  const frames = Array.from({ length: turn }, (_, i) => {
    const yaw = Math.round((360 * i) / turn);
    const img = render(model, { width: w, height: h, originX: ox, originY: oy, yaw, elevation: Number(arg('elev', '30')), outline: arg('outline', 'outer') as RenderOptions['outline'] });
    assertClosedPalette(img, model);
    return { name: `${name}_a${String(yaw).padStart(3, '0')}`, ...img };
  });
  writeFileSync(out, toPxlSource(model, frames, { sheet: name, comment: `VoxPix: ${model.name}, ${turn} ángulos de ${w}x${h}, pivote en ${ox},${oy}` }));
  console.log(`${out}: ${turn} sprites + hoja "${name}"`);
}

function world(src: string | undefined, out: string | undefined): void {
  if (!src || !out) { console.error('uso: voxpix world <receta.json> <salida.png|-> [--at x,y] [--size WxH] [--ticks n] [--scale n] [--whole] [--info info.json]'); process.exit(1); }
  const built = buildSampleRecipe(JSON.parse(readFileSync(src, 'utf8')));
  const info = describeWorld(built);
  if (out !== '-') {
    const [w, h] = arg('size', '384x216').split('x').map(Number) as [number, number];
    const at = process.argv.includes('--at') ? arg('at', '').split(',').map(Number) as [number, number] : undefined;
    const shot = snapshotWorld(built, { width: w, height: h, ticks: Number(arg('ticks', '30')), lights: arg('lights', 'si') !== 'no', whole: process.argv.includes('--whole'), ...(at ? { at } : {}) });
    writeFileSync(out, encodePNG(shot.width, shot.height, shot.rgba, Number(arg('scale', '1'))));
    console.log(`${out}: ${shot.width}x${shot.height}`);
  }
  const infoOut = arg('info', '');
  if (infoOut) writeFileSync(infoOut, JSON.stringify(info, null, 1));
  else console.log(JSON.stringify(info));
}

function main(): void {
  const [cmd, src, out] = process.argv.slice(2);
  if (cmd === 'world') return world(src, out);
  if (cmd === 'import-pxl') return importPxl();
  if (cmd === 'export-pxl') return exportPxl();
  if (cmd !== 'render' || !src || !out) {
    console.error('uso: voxpix render|export-pxl|import-pxl|world ... (ver cabecera de src/cli/main.ts)');
    process.exit(1);
  }
  const model = load(src);
  // Sin --size, el encuadre que contiene el modelo en cualquier giro (fitFrame: 64x48 si cabe)
  const fit = fitFrame(model.bounds(), Number(arg('elev', '30')));
  const [w, h] = arg('size', `${fit.W}x${fit.H}`).split('x').map(Number) as [number, number];
  const [ox, oy] = arg('origin', process.argv.includes('--size') ? `${Math.floor(w / 2)},${h - 4}` : `${fit.originX},${fit.originY}`).split(',').map(Number) as [number, number];
  const base: RenderOptions = {
    width: w, height: h, originX: ox, originY: oy,
    elevation: Number(arg('elev', '30')),
    outline: arg('outline', 'outer') as RenderOptions['outline'],
    flat: process.argv.includes('--flat'),
  };
  const turn = Number(arg('turn', '1'));
  const yaw0 = Number(arg('yaw', '0'));
  const frames = Array.from({ length: turn }, (_, i) => {
    const img = render(model, { ...base, yaw: yaw0 + (360 * i) / turn });
    assertClosedPalette(img, model);
    return img;
  });
  // Tira horizontal con 1 px de separación
  const W = turn * (w + 1) - 1;
  const strip = new Uint8ClampedArray(W * h * 4);
  frames.forEach((img, i) => {
    for (let y = 0; y < h; y++) strip.set(img.rgba.subarray(y * w * 4, (y + 1) * w * 4), (y * W + i * (w + 1)) * 4);
  });
  const bg = arg('bg', '');
  const pixels = bg ? onBackground(strip, [1, 3, 5].map((k) => parseInt(bg.slice(k, k + 2), 16)) as [number, number, number]) : strip;
  writeFileSync(out, encodePNG(W, h, pixels, Number(arg('scale', '1'))));
  console.log(`${out}: ${turn} vista(s) de ${w}x${h}, ${model.size} vóxeles`);
}

main();
