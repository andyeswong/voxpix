// Editar la paleta desde la interfaz y la API: cambiar un tono, añadir o quitar tonos, rampas nuevas (a mano, desde un
// color o desde una paleta), renombrar, reordenar, emisiva, quitar las que no se usan y cambiar la paleta entera.
// Un vóxel guarda (rampa, tono): si una operación mueve o quita rampas o tonos, sus vóxeles se renumeran o pasan al
// color más parecido. Cada operación es UN paso de deshacer (la paleta y los vóxeles juntos).
import { decode, material, validatePalette, hexToLab, labDistance, rampFromColor, groupIntoRamps, MAX_RAMPS, MAX_TONES, type Palette, type Ramp, type RampOptions } from '@core/index';
import { model, history, editor, touch } from './store';

const clone = (p: Palette): Palette => structuredClone(p);

// Aplica una paleta nueva: `map` da el material nuevo de cada material viejo (0 = vacío). Sin map, los mismos.
function apply(next: Palette, map?: (v: number) => number): void {
  validatePalette(next);
  history.value.begin();
  if (map) {
    const changes: Array<[number, number, number, number]> = [];
    for (const [x, y, z, v] of model.value.entries()) { const w = map(v); if (w !== v) changes.push([x, y, z, w]); }
    for (const [x, y, z, w] of changes) history.value.set(x, y, z, w);
  }
  history.value.setPalette(next);
  history.value.commit();
  // La rampa y el tono elegidos siguen existiendo
  editor.ramp = Math.max(0, Math.min(editor.ramp, next.ramps.length - 1));
  editor.tone = Math.max(0, Math.min(editor.tone, next.ramps[editor.ramp]!.colors.length - 1));
  touch();
}

// Qué rampas usa el modelo (índice -> cuántos vóxeles)
export function rampUsage(): Map<number, number> {
  const n = new Map<number, number>();
  for (const [, , , v] of model.value.entries()) { const r = decode(v).ramp; n.set(r, (n.get(r) ?? 0) + 1); }
  return n;
}

// El material de `next` más parecido a un color (para lo que se queda sin su rampa o su tono)
function nearestIn(next: Palette, hex: string, skipRamp = -1): number {
  const lab = hexToLab(hex);
  let best = material(0, 0), bd = Infinity;
  next.ramps.forEach((r, ri) => {
    if (ri === skipRamp) return;
    r.colors.forEach((c, ti) => { const d = labDistance(lab, hexToLab(c)); if (d < bd) { bd = d; best = material(ri, ti); } });
  });
  return best;
}

const colorOf = (p: Palette, v: number) => { const d = decode(v); return p.ramps[d.ramp]?.colors[d.tone] ?? '#ff00ff'; };

export function setTone(ramp: number, tone: number, hex: string): void {
  const p = clone(model.value.palette);
  p.ramps[ramp]!.colors[tone] = hex.toLowerCase();
  apply(p);
}

export function renameRamp(ramp: number, name: string): void {
  const p = clone(model.value.palette);
  p.ramps[ramp]!.name = name.trim() || p.ramps[ramp]!.name;
  apply(p);
}

export function toggleEmissive(ramp: number): void {
  const p = clone(model.value.palette);
  const r = p.ramps[ramp]!;
  if (r.emissive) delete r.emissive; else r.emissive = true;
  apply(p);
}

// Un tono más al final de la rampa (más claro que el último) o al principio (más oscuro que el primero)
export function addTone(ramp: number, where: 'claro' | 'oscuro'): void {
  const p = clone(model.value.palette);
  const r = p.ramps[ramp]!;
  if (r.colors.length >= MAX_TONES) throw new Error(`una rampa tiene ${MAX_TONES} tonos como mucho`);
  // El tono nuevo sale de una rampa generada desde el extremo
  const edge = where === 'claro' ? r.colors[r.colors.length - 1]! : r.colors[0]!;
  const gen = rampFromColor(edge, { tones: 3 });
  const idx = gen.indexOf(edge.toLowerCase());
  const extra = where === 'claro' ? gen[Math.min(gen.length - 1, idx + 1)]! : gen[Math.max(0, idx - 1)]!;
  if (where === 'claro') { r.colors.push(extra); apply(p); return; }
  r.colors.unshift(extra);
  apply(p, (v) => { if (!v) return v; const d = decode(v); return d.ramp === ramp ? material(ramp, d.tone + 1) : v; });
}

export function removeTone(ramp: number, tone: number): void {
  const old = model.value.palette;
  const p = clone(old);
  const r = p.ramps[ramp]!;
  if (r.colors.length <= 1) throw new Error('una rampa necesita al menos un tono');
  r.colors.splice(tone, 1);
  apply(p, (v) => {
    if (!v) return v;
    const d = decode(v);
    if (d.ramp !== ramp) return v;
    if (d.tone < tone) return v;
    if (d.tone > tone) return material(ramp, d.tone - 1);
    // Los de ese tono, al más parecido que queda en la rampa
    const lab = hexToLab(old.ramps[ramp]!.colors[tone]!);
    let best = 0, bd = Infinity;
    r.colors.forEach((c, i) => { const dd = labDistance(lab, hexToLab(c)); if (dd < bd) { bd = dd; best = i; } });
    return material(ramp, best);
  });
}

// Una rampa nueva al final; la deja elegida. Devuelve su índice.
export function addRamp(r: Ramp): number {
  const p = clone(model.value.palette);
  if (p.ramps.length >= MAX_RAMPS) throw new Error(`la paleta tiene ${MAX_RAMPS} rampas como mucho`);
  p.ramps.push({ name: r.name, colors: r.colors.map((c) => c.toLowerCase()), ...(r.emissive ? { emissive: true } : {}) });
  apply(p);
  editor.ramp = p.ramps.length - 1;
  editor.tone = Math.floor((r.colors.length - 1) / 2);
  return editor.ramp;
}

export function addRampFromColor(name: string, base: string, opts: RampOptions = {}): number {
  return addRamp({ name, colors: rampFromColor(base, opts) });
}

// Quita una rampa: sus vóxeles pasan al color más parecido de las demás
export function deleteRamp(ramp: number): void {
  const old = model.value.palette;
  if (old.ramps.length <= 1) throw new Error('la paleta necesita al menos una rampa');
  const p = clone(old);
  p.ramps.splice(ramp, 1);
  apply(p, (v) => {
    if (!v) return v;
    const d = decode(v);
    if (d.ramp < ramp) return v;
    if (d.ramp > ramp) return material(d.ramp - 1, d.tone);
    return nearestIn(p, colorOf(old, v));
  });
}

// Mueve una rampa a otra posición (los vóxeles siguen con su color)
export function moveRamp(from: number, to: number): void {
  const p = clone(model.value.palette);
  if (to < 0 || to >= p.ramps.length || from === to) return;
  const [r] = p.ramps.splice(from, 1);
  p.ramps.splice(to, 0, r!);
  const order = model.value.palette.ramps.map((_, i) => i);
  const [o] = order.splice(from, 1);
  order.splice(to, 0, o!);
  const newIndex = new Map(order.map((old, i) => [old, i]));
  apply(p, (v) => { if (!v) return v; const d = decode(v); return material(newIndex.get(d.ramp)!, d.tone); });
  editor.ramp = newIndex.get(editor.ramp) ?? editor.ramp;
}

// Quita las rampas que ningún vóxel usa (siempre queda al menos una)
export function removeUnusedRamps(): number {
  const used = rampUsage();
  const old = model.value.palette;
  const keep = old.ramps.map((_, i) => i).filter((i) => used.has(i));
  if (!keep.length) keep.push(0);
  if (keep.length === old.ramps.length) return 0;
  const newIndex = new Map(keep.map((old, i) => [old, i]));
  apply({ ...clone(old), ramps: keep.map((i) => clone(old).ramps[i]!) }, (v) => { if (!v) return v; const d = decode(v); return material(newIndex.get(d.ramp)!, d.tone); });
  return old.ramps.length - keep.length;
}

// Una paleta de colores sueltos (preset o archivo): 'añadir' pone sus rampas detrás de las que hay; 'reemplazar' la
// cambia entera y lo pintado pasa al color más parecido de la nueva
export function loadColors(colors: readonly string[], mode: 'añadir' | 'reemplazar', name?: string): number {
  const ramps = groupIntoRamps(colors).map((r) => (name ? { ...r, name: `${name} · ${r.name}` } : r));
  if (!ramps.length) throw new Error('no hay colores');
  const old = model.value.palette;
  if (mode === 'añadir') {
    const p = clone(old);
    if (p.ramps.length + ramps.length > MAX_RAMPS) throw new Error(`no caben: ${p.ramps.length} + ${ramps.length} rampas (como mucho ${MAX_RAMPS})`);
    p.ramps.push(...ramps);
    apply(p);
    editor.ramp = old.ramps.length;
    return ramps.length;
  }
  const p: Palette = { ramps, ...(old.outline ? { outline: old.outline } : {}) };
  apply(p, (v) => (v ? nearestIn(p, colorOf(old, v)) : v));
  return ramps.length;
}
