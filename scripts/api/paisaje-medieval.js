// Ejemplo de la API para agentes (window.voxpix): el paisaje medieval de 128 x 128 hecho solo con llamadas a la app,
// como lo haría un agente que controla el navegador. Se pega en la consola de VoxPix o se evalúa por CDP
// (scripts/api/README.md). Devuelve un registro con lo que tardó cada fase y el PNG iluminado en base64.
(async () => {
  const vp = window.voxpix, t0 = performance.now(), log = [];
  const lap = (what) => log.push(`${((performance.now() - t0) / 1000).toFixed(2)} s  ${what}`);

  // Un modelo vacío de 128 x 128 x 32 con su paleta (rampas de oscuro a claro)
  vp.newModel('paisaje', 128, 128, 32);
  vp.palette([
    { name: 'hierba', colors: ['#2d4a2a', '#3f6b33', '#5a8a3c', '#7fae4f'] },
    { name: 'tierra', colors: ['#3b2a1e', '#5a3e28', '#7a5636', '#9c7146'] },
    { name: 'piedra', colors: ['#2e2f38', '#4a4c58', '#6c6f7c', '#9a9dab'] },
    { name: 'madera', colors: ['#2b1b12', '#4a2f1d', '#6e4729', '#94643a'] },
    { name: 'agua', colors: ['#16324d', '#1f4f78', '#2f74a6', '#5fa8d6'] },
    { name: 'hojas', colors: ['#1f3a22', '#2f5a2f', '#46803c', '#6aa64f'] },
    { name: 'tejado', colors: ['#4a1c1c', '#6e2a24', '#93402f', '#b85a3c'] },
    { name: 'arena', colors: ['#6b5a3a', '#8c7650', '#ad9466', '#cdb581'] },
  ]);
  lap('modelo y paleta');

  // Terreno: una columna por celda (roca, tierra y la capa de arriba), el río y el lago excavados
  const riverX = (y) => 18 + 14 * Math.sin(y / 17) + 5 * Math.sin(y / 7.3);
  const lake = { x: -30, y: -34, r: 13 };
  const ground = (x, y) => Math.round(Math.max(2, 5 + 2.2 * Math.sin(x / 13) * Math.cos(y / 11) + 1.6 * Math.sin((x + y) / 9)
    + 0.8 * Math.cos(x / 5.1 - y / 6.7) + Math.max(0, 7 - Math.hypot(x + 34, y - 30) / 3.2)));
  const H = new Map();
  const hAt = (x, y) => H.get(`${Math.round(x)},${Math.round(y)}`) ?? 0;
  const cells = [];
  for (let y = -64; y < 64; y++) for (let x = -64; x < 64; x++) {
    let h = ground(x, y);
    const dr = Math.abs(x - riverX(y)), dl = Math.hypot(x - lake.x, y - lake.y);
    if (dr < 3.5 || dl < lake.r) h = Math.min(h, 1); else if (dr < 5.5 || dl < lake.r + 2) h = Math.min(h, 2);
    H.set(`${x},${y}`, h);
    const shore = dr < 7.5 || dl < lake.r + 4;
    for (let z = 0; z <= h; z++) {
      const top = z === h;
      cells.push([x, y, z, z < h - 3 ? 'piedra:1' : !top ? (z === h - 1 ? 'tierra:2' : 'tierra:1') : shore ? (h <= 2 ? 'arena:1' : 'arena:2') : h >= 9 ? 'hierba:3' : h >= 6 ? 'hierba:2' : 'hierba:1']);
    }
  }
  vp.voxels(cells);
  lap(`terreno: ${cells.length} vóxeles`);

  // Camino de tierra de la puerta del castillo al puente
  const path = [];
  for (let t = 0; t <= 1; t += 0.004) {
    const x = Math.round(-34 + (riverX(8) - 4 + 34) * t), y = Math.round(18 - 10 * t + 3 * Math.sin(t * 6));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const h = hAt(x + dx, y + dy); if (h > 2) path.push([x + dx, y + dy, h, (dx + dy) % 2 ? 'tierra:2' : 'tierra:3']); }
  }
  vp.voxels(path);

  // Castillo: muralla con almenas y puerta, torre del homenaje con ventana (cajas)
  const cx = -34, cy = 30, base = hAt(cx, cy);
  vp.batch(() => {
    vp.box(cx - 15, cy - 15, 1, cx + 15, cy - 14, base + 6, 'piedra:2');
    vp.box(cx - 15, cy + 14, 1, cx + 15, cy + 15, base + 6, 'piedra:2');
    vp.box(cx - 15, cy - 15, 1, cx - 14, cy + 15, base + 6, 'piedra:2');
    vp.box(cx + 14, cy - 15, 1, cx + 15, cy + 15, base + 6, 'piedra:2');
    vp.box(cx - 2, cy - 15, hAt(cx, cy - 15) + 1, cx + 2, cy - 14, base + 4, null);   // puerta
    for (let x = cx - 15; x <= cx + 15; x++) for (let y = cy - 15; y <= cy + 15; y++)
      if ((x <= cx - 14 || x >= cx + 14 || y <= cy - 14 || y >= cy + 14) && (x + y) % 2 === 0) vp.set(x, y, base + 7, 'piedra:3');
    vp.box(cx - 5, cy - 5, base + 1, cx + 4, cy + 4, base + 16, 'piedra:2');
    vp.box(cx - 4, cy - 4, base + 1, cx + 3, cy + 3, base + 15, null);                   // hueca
    for (let x = cx - 5; x <= cx + 4; x++) for (let y = cy - 5; y <= cy + 4; y++)
      if ((x === cx - 5 || x === cx + 4 || y === cy - 5 || y === cy + 4) && (x + y) % 2 === 0) vp.set(x, y, base + 17, 'piedra:3');
    vp.box(cx - 1, cy - 5, base + 9, cx, cy - 5, base + 11, 'piedra:0');                // ventana
  });
  lap('castillo');

  // Casas: paredes de madera (cajas) y tejado a dos aguas
  const houses = [[-6, 8], [4, -4], [-12, -10], [44, 22], [48, 0]];
  vp.batch(() => {
    for (const [hx, hy] of houses) {
      const g = Math.max(hAt(hx, hy), 3);
      vp.box(hx - 4, hy - 3, 1, hx + 4, hy + 3, g + 4, 'madera:2');
      vp.box(hx - 3, hy - 2, g + 1, hx + 3, hy + 2, g + 4, null);
      for (let x = hx - 4; x <= hx + 4; x++) for (let y = hy - 4; y <= hy + 4; y++) {
        const roof = g + 5 + Math.min(y - (hy - 4), hy + 4 - y);
        if (roof <= g + 8) vp.set(x, y, roof, (x + y) % 2 ? 'tejado:2' : 'tejado:1');
      }
      vp.box(hx, hy - 3, g + 1, hx, hy - 3, g + 2, 'madera:0');                       // puerta
    }
  });
  lap('casas');

  // Puente de madera sobre el río
  const by = 8, bx = Math.round(riverX(by));
  vp.batch(() => { vp.box(bx - 7, by - 2, 3, bx + 7, by + 2, 3, 'madera:3'); vp.box(bx - 7, by - 2, 4, bx + 7, by - 2, 4, 'madera:1'); vp.box(bx - 7, by + 2, 4, bx + 7, by + 2, 4, 'madera:1'); });

  // Árboles: tronco (caja) y copa redonda
  let seed = 1977;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let trees = 0;
  vp.batch(() => {
    while (trees < 40) {
      const x = Math.round(rnd() * 120 - 60), y = Math.round(rnd() * 120 - 60);
      if (Math.abs(x - riverX(y)) < 9 || Math.hypot(x - lake.x, y - lake.y) < lake.r + 5 || Math.hypot(x - cx, y - cy) < 22) continue;
      if (houses.some(([a, b]) => Math.hypot(x - a, y - b) < 9)) continue;
      const g = hAt(x, y), th = 3 + Math.floor(rnd() * 3), r = 2.5 + rnd() * 1.5;
      vp.box(x, y, g + 1, x, y, g + th, 'madera:1');
      const crown = [];
      for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -3; dz <= 4; dz++)
        if (dx * dx + dy * dy + (dz * 1.3) ** 2 <= r * r) crown.push([x + dx, y + dy, g + th + 2 + dz, dz > 1 ? 'hojas:3' : dz > -1 ? 'hojas:2' : 'hojas:1']);
      vp.voxels(crown);
      trees++;
    }
  });
  lap('40 árboles');

  // Agua: el río y el lago, llenos hasta la altura 2
  const rio = vp.water(Math.round(riverX(0)), 0, 2);
  const lago = vp.water(lake.x, lake.y, 2);
  lap(`agua: río ${rio.cells} celdas (${rio.spill ? 'sale por el borde' : 'cerrado'}), lago ${lago.cells}`);

  // Luces: antorchas en la puerta y el puente, braseros en la torre, faroles en las casas
  vp.light(cx - 3, cy - 16, base + 5, 'torch'); vp.light(cx + 3, cy - 16, base + 5, 'torch');
  vp.light(cx - 5, cy - 5, base + 18, 'brazier'); vp.light(cx + 4, cy + 4, base + 18, 'brazier');
  for (const [hx, hy] of houses) vp.light(hx, hy - 4, Math.max(hAt(hx, hy), 3) + 3, 'lamp');
  vp.light(bx - 8, by, 5, 'torch'); vp.light(bx + 8, by, 5, 'torch');
  lap(`${vp.lights().length} luces`);

  // De noche, y el PNG
  vp.view({ yaw: -30, elevation: 35, lit: true, ambient: 0.35 });
  const png = await vp.png({ scale: 2 });
  lap(`PNG ${png.name}`);
  return JSON.stringify({ log, info: { ...vp.info(), ramps: undefined }, png });
})()
