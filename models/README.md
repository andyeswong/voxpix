# Example models

Every model here is an example of how to build voxel art with VoxPix, and each one is made from source that lives
in this repository: either a script for the editor API (`window.voxpix`, see [docs/api-agentes.md](../docs/api-agentes.md))
or a layer file (`.px.js`) for the command line (`import-pxl --stack`, see
[docs/linea-de-comandos.md](../docs/linea-de-comandos.md)). They are deterministic: running the source again gives
the same file, byte for byte.

| Example | What it is | What it shows | Size (voxels) | Source |
|---|---|---|---|---|
| `enano/enano.voxpix.json`, `enano/enano-b.voxpix.json` | A dwarf miner with a pickaxe, in two variants (A: two-layer gold helmet; B: one-layer iron helmet with a narrow gold band) | A character built only with the API: palette ramps (one emissive, the head lamp), animation clips (`quieto` 2 frames, `andar` 5, `atacar` 4) with a rig of moving parts, a variant switch, `vp.save()` to a version 3 `.voxpix.json` | 6 x 6 x 14 (A), 6 x 6 x 13 (B) | `scripts/enano.js` |
| `flores/flores.voxset.json` | Three flower blocks: red, yellow, white | A block set (`newSet`, `addBlock`, `saveSet`) with ramps of material `follaje`: blocks that are not solid and let light through | 3 blocks of 8 x 8 x 8 | `scripts/flores.js` |
| `medieval/medieval.voxset.json` | Twelve medieval blocks: iron and gold ore, cobblestone, planks, sand, workbench, furnace (off and lit), chest (closed and open), ladder, bone | Block textures painted with a deterministic hash (ore specks, plank seams, cobblestone courses), an emissive ramp (the lit furnace), non-solid blocks (ladder, bone), and ramps meant to be appended to another set's palette | 12 blocks of 8 x 8 x 8 | `scripts/bloques-medievales.js` |
| `objetos/objetos.voxset.json` | Hand-held items: a stick, wooden/stone/iron pickaxes and swords, iron and gold ingots | Items kept in a block set so their icons come from `iconSheet`, with a grip point per item (`OBJETOS_GRIP`) for holding them in a hand | 9 items in cubes of 8 x 8 x 8 | `scripts/objetos.js` |
| `mochila/mochila.voxset.json` | A leather backpack, for an inventory icon | A model designed to read at 16 px: big blocks of colour, no overhangs (an overhang darkens what is below it), measured on the icon itself | 1 block of 8 x 8 x 8 | `scripts/mochila.js` |
| `luces/linterna.json`, `luces/antorcha.json`, `luces/linterna-neon.json` | Hand-held lights: a slate flashlight, a torch, a neon flashlight | A layer file with three stacks (`linterna_zNN`, `antorcha_zNN`, `linterna-neon_zNN`) and emissive ramps, grip at the origin | 3 x 9 x 3, 3 x 3 x 11, 3 x 9 x 3 | `luces/luces_capas.px.js` |
| `maia/maia.json`, `maia/walk/maia_walk_0..7.json` | A character turned into voxels from approved 2D art (front and back), and her 8 walk frames | Giving volume to pixel art layer by layer (each layer a horizontal cut); walk frames generated from the model (`walkFrames`) | 19 x 17 x 32 | `maia/maia_capas.px.js`, `scripts/maia-walk.ts` |
| `paisaje/medieval_capas.px.js` | A 128 x 128 medieval landscape: hills, river, lake, castle, houses, bridge, trees | A whole landscape written as code in a layer file (no saved model: the layer file is the source) | 128 x 128 x 30, 102,776 voxels | itself; the same landscape with the editor API is `scripts/api/paisaje-medieval.js` |

## Regenerating them

### From an editor script (`scripts/*.js`)

The scripts run in the editor page and return the file as an object.

1. `bun run dev` and open the editor (http://localhost:5190). Reload the page before each script: the scripts
   declare top-level constants.
2. Run the script in the page:
   - by hand, paste it in the browser console;
   - from a tool (CDP, Playwright), evaluate its source with `awaitPromise: true` and `returnByValue: true`.
   For the dwarf, `scripts/enano.js` returns a promise. Set `window.__enanoVariante = 'B'` first for variant B (unset
   for A).
3. The file is `JSON.stringify(result)`, with no trailing newline. In the console, `copy(JSON.stringify(result))`
   puts it on the clipboard (`result` being the value the script returned, e.g. `$_`).
4. Compare: write it over the model and run `git diff --exit-code models/<example>/`. It must show no change.

| Script | Writes |
|---|---|
| `scripts/enano.js` | `enano/enano.voxpix.json` (variant A), `enano/enano-b.voxpix.json` (variant B) |
| `scripts/flores.js` | `flores/flores.voxset.json` |
| `scripts/bloques-medievales.js` | `medieval/medieval.voxset.json` |
| `scripts/objetos.js` | `objetos/objetos.voxset.json` |
| `scripts/mochila.js` | `mochila/mochila.voxset.json` |

The block scripts also export their palette ramps and a function that adds their blocks to a set that is already
open (`floresBlocks`, `medievalBlocks`, `objetosBlocks`, `mochilaBlocks`), to merge them into another set. Their
ramps go at the end of that set's palette, so no existing index moves.

### From a layer file (`.px.js`)

    bun run voxpix import-pxl models/luces/luces_capas.px.js --stack linterna /tmp/linterna.json
    bun run voxpix import-pxl models/luces/luces_capas.px.js --stack antorcha /tmp/antorcha.json
    bun run voxpix import-pxl models/luces/luces_capas.px.js --stack linterna-neon /tmp/linterna-neon.json
    bun run voxpix import-pxl models/maia/maia_capas.px.js --stack maia /tmp/maia.json
    cmp /tmp/linterna.json models/luces/linterna.json      # and the same for the others: no output means identical

    bunx tsx --tsconfig tsconfig.runtime.json scripts/maia-walk.ts    # rewrites models/maia/walk/
    git diff --exit-code models/maia/walk/

    bun run voxpix import-pxl models/paisaje/medieval_capas.px.js --stack paisaje /tmp/paisaje.json
    # prints "102776 vóxeles desde las capas paisaje_zNN"

Checked on 2026-11-16: every file above regenerates byte for byte.

## Tests

`test/enano.test.ts`, `test/flores.test.ts`, `test/bloques-medievales.test.ts`, `test/objetos-mano.test.ts` and
`test/mochila.test.ts` load these files and check what each example promises (ids, which blocks are solid or emissive,
boxes, clips, grips, the backpack's flap and buckle).
