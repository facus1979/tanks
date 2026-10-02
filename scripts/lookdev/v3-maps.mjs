// QA de V3 (descartable, no es código del juego): pinta mapas generados por el sim con colores
// planos por material, para mirar la geografía por tramos sin levantar el juego.
// Uso: node scripts/lookdev/v3-maps.mjs [size=large] [n=3] [seed0=1]  → preview/v4-maps.png
// V4: agua y lava con su color plano (las cuencas ya vienen llenas; el resto de la cuenca que quede
// seca se marca semitransparente como antes).
// Por bioma, n mapas (un renglón cada uno). Referencias: back oscurecido, abismo con franja roja
// abajo, cuencas con su nivel (agua celeste, lava naranja, semitransparentes), tanques como cajas
// del color del jugador, utilería en amarillo y cortes de tramo como marcas arriba.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { encodePng } from './pixel.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outFile = path.join(root, 'dist-sim', 'v3-maps-sim.cjs')
buildSync({
  stdin: {
    contents: "export * from './src/sim'; export { generate } from './src/sim/gen'; export { Rng } from './src/sim/rng'",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
  logLevel: 'warning',
})
const sim = createRequire(import.meta.url)(outFile)

const size = process.argv[2] ?? 'large'
const n = Number(process.argv[3] ?? 3)
const seed0 = Number(process.argv[4] ?? 1)
const { w: W, h: H } = sim.MAP_SIZES[size]
const GAP = 6
const LABEL = 0

const COLORS = {
  0: null,
  1: [92, 64, 44], // tierra
  2: [150, 146, 136], // piedra
  3: [168, 78, 52], // ladrillo
  4: [112, 74, 40], // madera
  5: [196, 160, 104], // tabla
  6: [134, 96, 52], // viga
  7: [100, 70, 40], // poste
  8: [120, 136, 150], // chapa
  9: [40, 36, 40], // roca madre
  10: [70, 150, 220], // agua (v4)
  11: [255, 120, 20], // lava (v4)
}
const SKY = { forest: [226, 212, 188], jungle: [196, 222, 196], industrial: [232, 190, 160] }
const PLAYER = [
  [61, 140, 240],
  [226, 61, 61],
  [226, 193, 61],
  [61, 190, 90],
]

const rows = sim.BIOMES.length * n
const IH = rows * (H + GAP) + LABEL
const px = new Uint8ClampedArray(W * IH * 4).fill(255)
const put = (x, y, c, a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= IH) return
  const i = (y * W + x) * 4
  px[i] = px[i] * (1 - a) + c[0] * a
  px[i + 1] = px[i + 1] * (1 - a) + c[1] * a
  px[i + 2] = px[i + 2] * (1 - a) + c[2] * a
  px[i + 3] = 255
}

let row = 0
for (const biome of sim.BIOMES) {
  for (let k = 0; k < n; k++) {
    const seed = seed0 + k
    const state = sim.createMatch({ slots: [{ kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }], rounds: 1, difficulty: 'normal', biome, seed, size })
    // el mismo mapa que createMatch, con las cuencas y los tramos (salida interna del generador)
    const gen = sim.generate(biome, new sim.Rng(sim.roundSeed(seed, 1)), 4, W, H)
    const t = state.terrain
    const oy = row * (H + GAP)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const f = t.front[y * W + x]
        const b = t.back[y * W + x]
        let c = COLORS[f]
        if (!c && b) c = COLORS[b].map((v) => v * 0.45)
        if (!c) c = SKY[biome]
        put(x, oy + y, c)
      }
    }
    for (const q of gen.basins ?? []) {
      const col = q.kind === 'water' ? [70, 150, 220] : [255, 120, 20]
      for (let x = q.x0; x < q.x1; x++) for (let y = q.level; y < H; y++) if (t.front[y * W + x] === 0) put(x, oy + y, col, 0.55)
    }
    if (t.pits) for (let x = 0; x < W; x++) if (t.pits[x]) for (let y = H - 4; y < H; y++) put(x, oy + y, [255, 0, 0])
    for (const s of gen.segments ?? []) for (let y = 0; y < 6; y++) put(s.x0, oy + y, [0, 0, 0])
    for (const p of state.props) {
      if (!p.alive) continue
      for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) {
        if (p.kind === 'flag' && x > p.x + 1 && y > p.y + 14) continue
        put(x, oy + y, p.kind === 'barrel' ? [220, 40, 40] : p.kind === 'lamp' ? [255, 255, 120] : [240, 220, 60], p.kind === 'ladder' ? 0.6 : 1)
      }
    }
    state.players.forEach((p, i) => {
      for (let y = p.y - 20; y < p.y; y++) for (let x = p.x - 14; x < p.x + 14; x++) put(x, oy + y, PLAYER[i % 4])
    })
    console.log(`${biome} seed ${seed}: ${(gen.segments ?? []).map((s) => `${s.kind}(${s.x1 - s.x0})`).join(' ')}`)
    row++
  }
}

const out = path.join(root, 'preview', 'v4-maps.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, encodePng(W, IH, px))
console.log(`→ ${path.relative(root, out)} (${W}×${IH})`)
