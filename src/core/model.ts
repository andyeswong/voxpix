import { validatePalette, type Palette } from './palette';

// Modelo disperso de tamaño libre: solo se guardan los vóxeles llenos. Ejes: x hacia el este, y hacia el
// norte (lejos de la cámara en la vista frontal), z hacia arriba. El pivote (los pies) está en el origen.

const OFF = 1024;          // coordenadas válidas: -1024..1023 en cada eje
const SPAN = 2048;

export const key = (x: number, y: number, z: number): number => ((x + OFF) * SPAN + (y + OFF)) * SPAN + (z + OFF);

export function unkey(k: number): [number, number, number] {
  const z = (k % SPAN) - OFF;
  const r = Math.floor(k / SPAN);
  return [Math.floor(r / SPAN) - OFF, (r % SPAN) - OFF, z];
}

// Lo que necesita un renderizador: la paleta, qué hay en un vóxel y recorrer los vóxeles llenos. Un Model lo es;
// el mundo (src/world/state.ts) también, componiendo lo estático, las entidades y el agua sin copiar nada.
export interface VoxelSource {
  readonly palette: Palette;
  get(x: number, y: number, z: number): number;
  entries(): Iterable<[number, number, number, number]>;
}

export interface Bounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

export class Model implements VoxelSource {
  readonly voxels = new Map<number, number>();

  constructor(public palette: Palette, public name = 'model') {
    validatePalette(palette);
  }

  get(x: number, y: number, z: number): number {
    return this.voxels.get(key(x, y, z)) ?? 0;
  }

  set(x: number, y: number, z: number, value: number): void {
    if (Math.abs(x) >= OFF || Math.abs(y) >= OFF || Math.abs(z) >= OFF) throw new Error(`vóxel fuera de rango: ${x},${y},${z}`);
    if (value) this.voxels.set(key(x, y, z), value);
    else this.voxels.delete(key(x, y, z));
  }

  // Recorrido en orden de clave: el orden no depende de cómo se construyó el modelo (determinismo)
  *entries(): Generator<[number, number, number, number]> {
    const keys = [...this.voxels.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const [x, y, z] = unkey(k);
      yield [x, y, z, this.voxels.get(k)!];
    }
  }

  get size(): number {
    return this.voxels.size;
  }

  bounds(): Bounds | null {
    if (!this.voxels.size) return null;
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const k of this.voxels.keys()) {
      const [x, y, z] = unkey(k);
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
      b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
    }
    return b;
  }

  clone(): Model {
    const m = new Model(structuredClone(this.palette), this.name);
    for (const [k, v] of this.voxels) m.voxels.set(k, v);
    return m;
  }

  // Formato de fichero: JSON con la lista de vóxeles ordenada. Mismo modelo, mismo texto.
  toJSON(): ModelFile {
    return { format: 'voxpix', version: 1, name: this.name, palette: this.palette, voxels: [...this.entries()] };
  }

  static fromJSON(f: ModelFile): Model {
    if (f.format !== 'voxpix') throw new Error('no es un modelo de voxpix');
    const m = new Model(f.palette, f.name);
    for (const [x, y, z, v] of f.voxels) m.set(x, y, z, v);
    return m;
  }
}

export interface ModelFile {
  format: 'voxpix';
  version: 1;
  name: string;
  palette: Palette;
  voxels: Array<[number, number, number, number]>;
}
