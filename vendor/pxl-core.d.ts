// Tipos mínimos del núcleo de pxl que usa VoxPix (src/pxl/bridge.ts). El código real (vendor/pxl, commit
// 21fee41) se carga en ejecución con el alias `pxl-core`; aquí solo se declara lo que usamos, porque el código
// de pxl no pasa nuestro modo estricto (noUncheckedIndexedAccess).
declare module 'pxl-core' {
  export type Color = number;   // 0xRRGGBBAA
  export interface Img { w: number; h: number; data: Uint32Array }
  export interface PxlPalette {
    readonly keys: ReadonlyMap<string, Color>;
    readonly order: readonly string[];
    readonly ramps: readonly string[];
    readonly aliases: ReadonlySet<string>;
  }
  export class Project {
    constructor(opts?: { trace?: boolean });
    readonly assets: Map<string, { kind: string; name: string; pal: PxlPalette }>;
    pal: PxlPalette;
    env(): Record<string, unknown>;
    addFile(file: string): void;
    exported(): string[];
    image(name: string, seed?: number, t?: number): Img;
  }
  export function toHex(c: Color): string;
  export function channels(c: Color): [number, number, number, number];
}
