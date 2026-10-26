// Recetas sobre los temas de MUESTRA: { theme: 'medieval', seed: 3, ramps: { water: [...] } } se completa con el
// generador, los colores, la fuente, la luz ambiente y las piezas de ese tema (puertas, ventanas, escritorios). Lo usan
// la API de mundos del navegador y la CLI; un juego arma sus recetas con su propio generator.
import { buildRecipe, rampsOf, type BuiltRecipe, type WorldRecipe } from '../world/recipe';
import { THEMES, THEME_IDS, type ThemeId } from './themes';
import { SAMPLE_PIECES } from './pieces';

export type RecipeInput = WorldRecipe | (Partial<WorldRecipe> & { theme: ThemeId; seed?: number });

// La receta completa conserva `theme` (el motor no lo lee): así, guardada y vuelta a leer, sigue con las piezas del tema
export function resolveRecipe(input: RecipeInput): { recipe: WorldRecipe & { theme?: ThemeId }; samplePieces: boolean } {
  if (!('theme' in input) || input.theme === undefined) return { recipe: input as WorldRecipe, samplePieces: false };
  const t = THEMES[input.theme];
  if (!t) throw new Error(`no hay tema "${input.theme}"; los temas de muestra son: ${THEME_IDS.join(', ')}`);
  return {
    recipe: {
      ...input,
      seed: input.seed ?? 7,
      generator: input.generator ?? t.spec,
      ramps: { ...rampsOf(t.look.palette), ...(input.ramps ?? {}) },
      fountain: input.fountain ?? t.look.fountain ?? false,
      ambient: input.ambient ?? t.ambient,
    },
    samplePieces: true,
  };
}

// Construye una receta (con tema de muestra o sin él): las del tema, con sus piezas de muestra
export function buildSampleRecipe(input: RecipeInput): BuiltRecipe & { recipe: WorldRecipe & { theme?: ThemeId } } {
  const { recipe, samplePieces } = resolveRecipe(input);
  return { ...buildRecipe(recipe, samplePieces ? SAMPLE_PIECES : {}), recipe };
}
