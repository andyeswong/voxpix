import { key, type Model } from './model';

// Deshacer y rehacer por DIFERENCIAS: cada paso guarda solo los vóxeles que cambió (valor antes y después),
// no una copia del modelo entero.

type Change = Map<number, [number, number, number, number, number]>;   // clave -> x, y, z, antes, después

export class History {
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private open: Change | null = null;

  constructor(private model: Model, private limit = 500) {}

  // Todo lo que se pinte entre begin() y commit() es un solo paso
  begin(): void {
    this.open = new Map();
  }

  set(x: number, y: number, z: number, value: number): void {
    const before = this.model.get(x, y, z);
    if (before === value) return;
    const k = key(x, y, z);
    const prev = this.open?.get(k);
    this.model.set(x, y, z, value);
    if (this.open) this.open.set(k, [x, y, z, prev ? prev[3] : before, value]);
  }

  commit(): boolean {
    const step = this.open;
    this.open = null;
    if (!step || ![...step.values()].some((c) => c[3] !== c[4])) return false;
    this.undoStack.push(step);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    for (const [x, y, z, before] of step.values()) this.model.set(x, y, z, before);
    this.redoStack.push(step);
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    for (const [x, y, z, , after] of step.values()) this.model.set(x, y, z, after);
    this.undoStack.push(step);
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
