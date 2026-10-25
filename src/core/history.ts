import { key, type Model } from './model';
import type { Palette } from './palette';

// Deshacer y rehacer por DIFERENCIAS: cada paso guarda solo los vóxeles que cambió (valor antes y después),
// no una copia del modelo entero, y, si cambió la paleta, la de antes y la de después.

type Cells = Map<number, [number, number, number, number, number]>;   // clave -> x, y, z, antes, después
interface Change { cells: Cells; palette?: [Palette, Palette] }

export class History {
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private open: Change | null = null;

  constructor(private model: Model, private limit = 500) {}

  // Todo lo que se pinte entre begin() y commit() es un solo paso
  begin(): void {
    this.open = { cells: new Map() };
  }

  set(x: number, y: number, z: number, value: number): void {
    const before = this.model.get(x, y, z);
    if (before === value) return;
    const k = key(x, y, z);
    const prev = this.open?.cells.get(k);
    this.model.set(x, y, z, value);
    if (this.open) this.open.cells.set(k, [x, y, z, prev ? prev[3] : before, value]);
  }

  // Cambia la paleta del modelo dentro del paso abierto (sin paso abierto, no se puede deshacer)
  setPalette(p: Palette): void {
    if (this.open) this.open.palette = [this.open.palette?.[0] ?? this.model.palette, p];
    this.model.palette = p;
  }

  commit(): boolean {
    const step = this.open;
    this.open = null;
    if (!step || (!step.palette && ![...step.cells.values()].some((c) => c[3] !== c[4]))) return false;
    this.undoStack.push(step);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    for (const [x, y, z, before] of step.cells.values()) this.model.set(x, y, z, before);
    if (step.palette) this.model.palette = step.palette[0];
    this.redoStack.push(step);
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    for (const [x, y, z, , after] of step.cells.values()) this.model.set(x, y, z, after);
    if (step.palette) this.model.palette = step.palette[1];
    this.undoStack.push(step);
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
