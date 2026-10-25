import { describe, it, expect, vi } from 'vitest';
import { decode } from '../src/core';

// La herramienta de la app usa el estado de Vue y window.setInterval: se prueba con temporizadores simulados
vi.stubGlobal('window', globalThis);

describe('herramienta Fluido', () => {
  it('vierte, se calma, se fija como vóxeles de agua y deshacer la quita entera', async () => {
    vi.useFakeTimers();
    const store = await import('../app/src/store');
    const { startPour, stopPour, fluidState } = await import('../app/src/fluidTool');
    const m = store.model.value;
    const n0 = m.size;
    store.editor.ramp = 3; store.editor.tone = 3;          // rampa "agua" de la muestra
    startPour(12, 0, 7);                                     // sobre la caja de madera (z 0..5)
    vi.advanceTimersByTime(33 * 40);                         // 40 pasos vertiendo
    stopPour();
    vi.advanceTimersByTime(33 * 2000);                       // hasta que se calma y se fija
    expect(fluidState.running).toBe(false);
    const water = [...m.entries()].filter(([, , , v]) => decode(v).ramp === 3);
    expect(water.length).toBeGreaterThan(10);
    // Cayó: hay agua en el suelo de la rejilla (z = 0), al lado de la caja, no solo encima
    expect(water.some(([, , z]) => z === 0)).toBe(true);
    // Todo el agua es un solo paso de deshacer
    expect(store.history.value.undo()).toBe(true);
    expect(m.size).toBe(n0);
    vi.useRealTimers();
  });

  it('un grifo sigue vertiendo hasta que se cierra, y entonces se fija como un paso', async () => {
    vi.useFakeTimers();
    const store = await import('../app/src/store');
    const { toggleFaucet, settleNow, fluidState } = await import('../app/src/fluidTool');
    const m = store.model.value;
    const n0 = m.size;
    store.editor.ramp = 3; store.editor.tone = 2;
    toggleFaucet(-9, 0, 13);                                  // encima de la esfera
    vi.advanceTimersByTime(33 * 300);
    expect(fluidState.running).toBe(true);                    // abierto: no se fija solo
    const mid = fluidState.cells;
    vi.advanceTimersByTime(33 * 300);
    expect(fluidState.cells).toBeGreaterThan(mid);            // y sigue saliendo agua
    settleNow();
    expect(fluidState.running).toBe(false);
    expect(fluidState.faucets.length).toBe(0);
    expect(m.size).toBeGreaterThan(n0);
    expect(store.history.value.undo()).toBe(true);
    expect(m.size).toBe(n0);
    vi.useRealTimers();
  });
});
