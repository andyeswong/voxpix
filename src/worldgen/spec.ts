// Motor de escenario: la especificación del generador (qué piezas, cuántas, dónde).
// PARTE PURA: la descripción de un tema de mapa. Es solo DATOS: los nombres son claves de animación de la
// hoja del nivel (el motor no sabe qué son: eso es contenido). Un nivel que quiera un mapa distinto en cada
// partida declara un GeneratorSpec en vez de un mapa fijo.
import type { SourceKind } from '../lighting/lights';

export interface Pick {
  anim: string;
  weight: number;
}

export interface FacadeSpec {
  fill: readonly Pick[];                   // piezas que rellenan la fachada
  neutral: string;                         // la única que puede repetirse seguida
  door: string;                            // se ponen dos
  flank?: string;                          // a cada lado de cada puerta
  banner?: string;                         // repartidos por la fachada
  crest?: string;                          // dos juntos, en el centro
  emits: Readonly<Record<string, SourceKind>>;   // qué piezas son fuente de luz y de qué tipo
}

export interface WaterSpec {
  ocean: boolean;
  lake: boolean;
  puddles: number;
}

// Un mueble o prop con huella w x h celdas (escritorio, mesa...): bloquea paso y luz como una columna. Su dibujo
// mide w*16 de ancho y sale hacia arriba de su huella (el monitor sobresale). Si emite (la pantalla), es una fuente.
export interface PropSpec {
  anim: string;                            // animación del dibujo, con el pie en la fila de abajo de la huella
  w: number;
  h: number;
  count: number;
  emits?: SourceKind;
  edge?: boolean;                          // pegado a una pared: no estorba el espacio de la arena y es lo normal en una oficina
}

export interface GeneratorSpec {
  cols: number;                            // en tiles de 16 px: la arena mide cols*16 x rows*16
  rows: number;
  floors: readonly Pick[];                 // suelo, al azar con peso
  caps: readonly [string, string];         // tapa de las paredes: se alternan
  facade: FacadeSpec;
  water: WaterSpec;
  pillars: number;                         // columnas que bloquean luz y paso
  props?: readonly PropSpec[];             // muebles que bloquean luz y paso
  materials: number;                       // materiales sueltos por el suelo
}
