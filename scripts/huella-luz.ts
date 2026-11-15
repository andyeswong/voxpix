// Huella de una escena con bloques que emiten, horneada en los 4 cuartos: la de test/luz-girada.test.ts, para medirla
// sobre cualquier commit del motor. Uso: bun scripts/huella-luz.ts <raíz del motor>
const root = process.argv[2]!;
const { material } = await import(`${root}/src/core/index.ts`);
const { StaticVoxels, WorldState } = await import(`${root}/src/world/state.ts`);
const { BlockSet, BlockGrid } = await import(`${root}/src/world/blocks.ts`);
const { bakeWorld } = await import(`${root}/src/world/bake.ts`);
const { WorldView } = await import(`${root}/src/world/view.ts`);
const N = 8;
const PAL = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'llama', colors: ['#a04010', '#f0a020', '#fff0a0'], emissive: true, material: 'atravesable' },
] };
const cube = () => { const o: number[][] = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(0, 1 + ((x + y + z) % 3))]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'huella', size: N, palette: PAL, blocks: [
  { id: 'piedra', voxels: cube() },
  // una antorcha con la llama en (4, 4, 4..6) y la luz en 4,5 / 4,5 / 5,5, fuera del centro del bloque (4 / 4)
  { id: 'antorcha', voxels: [[4, 4, 4, material(1, 1)], [4, 4, 5, material(1, 2)], [4, 4, 6, material(1, 2)]], props: { emits: { kind: 'torch', at: [4.5, 4.5, 5.5] } } },
  // centrada: la luz por defecto (centro de arriba)
  { id: 'farol', voxels: [[3, 3, 0, material(1, 1)], [4, 3, 0, material(1, 1)], [3, 4, 0, material(1, 1)], [4, 4, 0, material(1, 1)], [3, 3, 1, material(1, 2)]], props: { emits: { kind: 'lamp' } } },
] } as never);
const C = 12, s = new StaticVoxels(PAL as never, C * N, C * N, 0, 4 * N - 1), st = new WorldState(s, [], null), g = new BlockGrid(st, set);
const P = set.index('piedra'), A = set.index('antorcha'), F = set.index('farol');
for (let by = 0; by < C; by++) for (let bx = 0; bx < C; bx++) g.set(bx, by, 0, P);
for (let k = 2; k < 9; k++) { g.set(k, 6, 1, P); g.set(k, 6, 2, P); g.set(6, k, 1, P); }
g.set(3, 3, 1, A); g.set(8, 4, 1, A); g.set(4, 9, 1, A); g.set(9, 9, 3, A);
g.set(2, 8, 1, F, 0); g.set(9, 2, 1, F, 90); g.set(10, 7, 1, F, 180); g.set(5, 10, 1, F, 270);
const fnv = (b: ArrayLike<number>) => { let h = 2166136261; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ (b[i]! & 255), 16777619) >>> 0; return h.toString(16); };
const bytes = (a: { buffer: ArrayBuffer; byteOffset: number; byteLength: number }) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
console.log('huella', st.hash());
console.log('luces', st.lights.filter((l: { baked: boolean }) => l.baked).map((l: { kind: string; x: number; y: number; z: number }) => `${l.kind}@${l.x},${l.y},${l.z}`).join(' '));
for (const q of [0, 1, 2, 3]) {
  const v = new WorldView(st, q, {}), b = bakeWorld(v.bakeable(), { topZ: 4 * N + 8, incline: 0.5 });
  console.log(`cuarto ${q} rgba ${fnv(b.rgba)} luz ${fnv(bytes(new Float32Array(b.lights.flatMap((l: { weight: Float32Array }) => [...l.weight]))))} ${b.lights.length}`);
}
