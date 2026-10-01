// Prueba de look v2: mapa Grande (2400×450) por tramos, con agua, lava y abismo, y la pantalla
// 800×450 con cámara, minimapa e indicadores de enemigos fuera de vista. No es código del juego.
// Uso: node scripts/lookdev/v2-bigmap.mjs  → preview/v2-*.png
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Canvas, rgb, c8, mix, mul, rnd, makeRand, bayer, noise1, OUT, FOG, FONT, gradient, pine, waterTower,
  stoneColor, brickColor, dirtColor, plankColor, slatColor, beamColor, postColor,
  BARREL, BARREL_PAL, crate, ladder, windsock, flag,
  TANK, TANK_W, TANK_H, PIVOT, BARREL_LEN, CREW_W, CREW_X, HULLS, tankPal, treads, barrel, antenna,
  CREW_BANDANA, CREW_SARGE, SKIN, BANDANA_PAL, SARGE_PAL, BUBBLE_ALERT, BUBBLE_PAL, text as textAt,
} from './pixel.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })

const W = 2400
const H = 450
const VW = 800

// fuente: la de pixel.mjs más lo que falta para el HUD
const F5 = {
  ...FONT,
  C: ['.####', '#....', '#....', '#....', '.####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '.###.'],
  X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  2: ['###.', '...#', '.##.', '#...', '####'],
  3: ['###.', '...#', '.##.', '...#', '###.'],
  4: ['#..#', '#..#', '####', '...#', '...#'],
  5: ['####', '#...', '###.', '...#', '###.'],
  6: ['.##.', '#...', '###.', '#..#', '.##.'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
}
const text = (cv, s, x, y, c, sh = OUT) => textAt(cv, s, x, y, c, sh, F5)

// ---------- materiales ----------

const AIR = 0, DIRT = 1, STONE = 2, BRICK = 3, WOOD = 4, SLAT = 5, BEAM = 6, POST = 7, METAL = 8, BEDROCK = 9
const WATER = 10, LAVA = 11
const LIQUID = new Set([WATER, LAVA])
const WOODISH = new Set([WOOD, SLAT, BEAM, POST])

const front = new Uint8Array(W * H)
const back = new Uint8Array(W * H)
const idx = (x, y) => y * W + x
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H
const F = (x, y) => (inside(x, y) ? front[idx(x, y)] : AIR)
const B = (x, y) => (inside(x, y) ? back[idx(x, y)] : AIR)
const solid = (x, y) => { const m = F(x, y); return m !== AIR && !LIQUID.has(m) }
const fill = (x0, y0, x1, y1, m, grid = front) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x, y)) grid[idx(x, y)] = m
}

// ---------- geografía por tramos ----------
// plataforma | lago | montaña con cueva | abismo | meseta con búnker y torre | pozo de lava | colinas con ruinas

const ABYSS = [1040, 1128]
const LAKE = [372, 560]
const LAVA_PIT = [1622, 1744]
const MESA = [1150, 1470]
const PY = 300 // meseta

const g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2))
const surf = new Array(W)

function surface(x) {
  const n = (noise1(x, 70, 7) - 0.5) * 16 + (noise1(x, 17, 8) - 0.5) * 5
  if (x < 250) return 330 // plataforma
  let y = 362 + n
  // lago: cuenca
  y += 58 * g(x, 466, 70)
  // montaña de dos picos
  y -= 225 * g(x, 790, 95) + 70 * g(x, 900, 40) + 30 * g(x, 690, 30)
  // borde del abismo
  if (x >= MESA[0] && x < MESA[1]) y = PY
  else if (x >= MESA[1] && x < MESA[1] + 40) y = PY + (y - PY) * ((x - MESA[1]) / 40)
  // pozo de lava
  y += 44 * g(x, 1683, 52)
  // colinas del final
  y -= 70 * g(x, 1960, 60) + 45 * g(x, 2130, 45) + 20 * g(x, 2300, 30)
  if (x >= 250 && x < 290) y = 330 + (y - 330) * ((x - 250) / 40)
  return Math.round(Math.max(110, Math.min(H - 30, y)))
}

function caveAt(cx, cy, hw, hh, s) {
  for (let y = cy - hh - 2; y <= cy + hh + 2; y++) {
    for (let x = cx - hw - 6; x <= cx + hw + 6; x++) {
      const wob = Math.sin(y / 5 + s) * 4
      const ny = (y - cy) / hh
      const nx = (x - cx - wob) / hw
      const r = 1 - Math.abs(ny) * 0.55 + (rnd(x, y, s) - 0.5) * 0.12
      if (Math.abs(ny) < 1 && Math.abs(nx) < r && inside(x, y) && F(x, y) !== AIR) {
        front[idx(x, y)] = AIR
        if (back[idx(x, y)] === AIR) back[idx(x, y)] = DIRT
      }
    }
  }
}

function crater(cx, cy, r) {
  for (let y = cy - r - 2; y <= cy + r + 2; y++) {
    for (let x = cx - r - 2; x <= cx + r + 2; x++) {
      const d = Math.hypot(x - cx, (y - cy) * 1.1) + (rnd(x, y, 5) - 0.5) * 2.2
      if (d < r && inside(x, y) && F(x, y) === DIRT) front[idx(x, y)] = AIR
    }
  }
}

const towerX = 1360
function tower(x, gy, cabin) {
  for (const px of [x, x + 18, x + 38, x + 55]) fill(px, gy - 40, px + 3, gy - 1, POST)
  fill(x - 12, gy - 42, x + 64, gy - 38, BEAM)
  fill(x, gy - 30, x + 58, gy - 1, WOOD)
  fill(x, gy - 30, x + 58, gy - 27, BEAM)
  fill(x + 24, gy - 20, x + 34, gy - 1, AIR)
  fill(x + 24, gy - 20, x + 34, gy - 1, WOOD, back)
  fill(x + 2, gy - 82, x + 56, gy - 43, cabin)
  fill(x + 12, gy - 72, x + 28, gy - 58, AIR)
  fill(x + 12, gy - 72, x + 28, gy - 58, WOOD, back)
  fill(x - 4, gy - 88, x + 62, gy - 83, BEAM)
  for (const px of [x + 2, x + 54]) fill(px, gy - 82, px + 2, gy - 43, POST)
}

const craters = [
  { x: 330, y: 340, r: 9 },
  { x: 1012, y: 0, r: 10 },
  { x: 1560, y: 0, r: 8 },
  { x: 1878, y: 0, r: 13 }, // último impacto de P3, corto
  { x: 2060, y: 0, r: 9 },
]

function buildTerrain() {
  for (let x = 0; x < W; x++) surf[x] = surface(x)
  for (let x = 0; x < W; x++) for (let y = surf[x]; y < H; y++) front[idx(x, y)] = DIRT
  // plataforma de piedra a la izquierda
  fill(10, 330, 249, 343, STONE)
  fill(90, 344, 136, 350, STONE)
  // rocas en la montaña
  for (const [cx, w, d] of [[760, 30, 22], [812, 22, 46], [705, 26, 70], [880, 24, 30], [640, 20, 34]]) {
    const top = surf[cx] + d
    fill(cx - w / 2, top, cx + w / 2, top + 6, STONE)
  }
  // fondo del lago de piedra
  for (let x = LAKE[0]; x <= LAKE[1]; x++) fill(x, surf[x], x, surf[x] + 4, STONE)
  // meseta: tapa de piedra y búnker
  fill(MESA[0], PY, MESA[1] - 1, PY + 7, STONE)
  // pozo de lava: costra de piedra en las paredes
  for (let x = LAVA_PIT[0] - 10; x <= LAVA_PIT[1] + 10; x++) fill(x, surf[x], x, surf[x] + 3, STONE)
  // ruinas de ladrillo en las colinas
  fill(2190, surf[2190] - 24, 2196, surf[2190] - 1, BRICK)
  fill(2190, surf[2190] - 28, 2240, surf[2190] - 25, BRICK)
  fill(2234, surf[2234] - 24, 2240, surf[2234] - 1, BRICK)
  // roca madre
  fill(0, H - 6, W - 1, H - 1, BEDROCK)

  back.set(front)

  // búnker bajo la meseta
  const bx = 1240
  fill(bx, PY + 8, bx + 150, PY + 68, BRICK)
  fill(bx, PY + 57, bx + 150, PY + 64, STONE)
  for (let y = PY + 8; y <= PY + 68; y++) for (let x = bx; x <= bx + 150; x++) back[idx(x, y)] = front[idx(x, y)]
  fill(bx + 10, PY + 18, bx + 140, PY + 56, AIR)
  fill(bx + 22, PY, bx + 29, PY + 17, AIR)
  fill(bx + 22, PY, bx + 29, PY + 17, BRICK, back)

  // cueva bajo la montaña
  caveAt(770, 392, 60, 13, 3)

  // abismo: no hay piso; las paredes se ven atrás
  for (let x = ABYSS[0]; x <= ABYSS[1]; x++) {
    const jag = Math.round((noise1(x, 9, 4) - 0.5) * 6)
    for (let y = 0; y < H; y++) {
      if (x < ABYSS[0] + 4 + jag || x > ABYSS[1] - 4 + jag) continue
      front[idx(x, y)] = AIR
      back[idx(x, y)] = y > surf[x] + 6 ? DIRT : AIR
    }
  }

  tower(towerX, PY, SLAT)

  for (const c of craters) {
    if (!c.y) c.y = surf[c.x] + 3
    crater(c.x, c.y, c.r)
  }

  // líquidos: llenan la cuenca hasta su nivel
  const lakeLevel = 382
  for (let x = LAKE[0]; x <= LAKE[1]; x++) for (let y = lakeLevel; y < H; y++) if (F(x, y) === AIR && y < surf[x] + 1) front[idx(x, y)] = WATER
  for (let x = LAKE[0] - 40; x <= LAKE[1] + 40; x++) for (let y = lakeLevel; y < surf[x]; y++) if (F(x, y) === AIR) front[idx(x, y)] = WATER
  const lavaLevel = 382
  for (let x = LAVA_PIT[0] - 40; x <= LAVA_PIT[1] + 40; x++) for (let y = lavaLevel; y < H; y++) if (F(x, y) === AIR) front[idx(x, y)] = LAVA
}

// ---------- pintado ----------

const bg = new Canvas(W, H) // cielo y capas lejanas (parallax)
const fg = new Canvas(W, H) // terreno, utilería, tanques (alfa donde hay aire)

function paintBackground() {
  const R = makeRand(42)
  const r = R.next
  const stops = [[0, 0xc4ad8e], [0.3, 0xd9c3a4], [0.62, 0xebd8bf], [0.85, 0xf3e4cf], [1, 0xf6e9d7]]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = gradient(stops, Math.min(1, Math.floor((y / H) * 22 + bayer(x, y)) / 22))
      const d = Math.hypot(x - 1500, (y - 92) * 1.2)
      const gg = Math.max(0, 1 - d / 420)
      c = mix(c, 0xfff7e8, (Math.floor(gg * gg * 8 + bayer(x + 1, y)) / 8) * 0.75)
      bg.put(x, y, c)
    }
  }
  const fog = (a) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bg.put(x, y, FOG, typeof a === 'function' ? a(x, y) : a) }
  for (let i = 0; i < 74; i++) pine(bg, Math.round(i * 33 + r() * 20), 417, 233 + r() * 150, { dark: 0xc8b193 }, 100 + i, r() < 0.4 ? 0.3 : 0)
  fog(0.35)
  waterTower(bg, 300, 422, 0xb29c7e, 208)
  waterTower(bg, 1720, 422, 0xb29c7e, 190)
  for (let i = 0; i < 58; i++) pine(bg, Math.round(20 + i * 42 + r() * 18), 421, 175 + r() * 125, { dark: 0xa8957a }, 200 + i, r() < 0.3 ? 0.35 : 0)
  fog(0.3)
  for (let i = 0; i < 47; i++) pine(bg, Math.round(i * 52 + r() * 24), 425, 125 + r() * 92, { dark: 0x7d7660, light: 0x8e8770 }, 300 + i)
  fog(0.18)
  fog((x, y) => (y < 242 ? 0 : Math.floor(Math.min(1, (y - 242) / 142) * 0.6 * 10 + bayer(x, y)) / 10))
}

function materialColor(m, x, y) {
  switch (m) {
    case DIRT: return dirtColor(x, y)
    case STONE: return stoneColor(x, y)
    case BRICK: return brickColor(x, y)
    case WOOD: return plankColor(x, y)
    case SLAT: return slatColor(x, y)
    case BEAM: { let y0 = y; while (F(x, y0 - 1) === BEAM) y0--; return beamColor(x, y, y0) }
    case POST: return postColor(x - towerX)
    case BEDROCK: return mix(stoneColor(x, y), 0x1a1614, 0.6)
    default: return 0xff00ff
  }
}

function paintTerrain() {
  // pared de fondo
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = B(x, y)
      if (m === AIR || F(x, y) !== AIR) continue
      let c = mix(mul(materialColor(m, x, y), 0.3), 0x0e0806, 0.3)
      let occ = 0
      for (let k = 1; k <= 6; k++) if (solid(x, y - k)) occ = Math.max(occ, 1 - k / 7)
      for (let k = 1; k <= 3; k++) if (solid(x - k, y) || solid(x + k, y)) occ = Math.max(occ, (1 - k / 4) * 0.6)
      c = mix(c, 0x080504, occ * 0.7)
      // abismo: se pierde en la oscuridad
      if (x >= ABYSS[0] && x <= ABYSS[1]) c = mix(c, 0x050302, Math.min(1, Math.floor(((y - 300) / 150) * 8 + bayer(x, y)) / 8))
      fg.put(x, y, c)
    }
  }
  // frente
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = F(x, y)
      if (m === AIR || LIQUID.has(m)) continue
      let c = materialColor(m, x, y)
      const up = !solid(x, y - 1), down = !solid(x, y + 1), left = !solid(x - 1, y), right = !solid(x + 1, y)
      if (WOODISH.has(m) && (up || down || left || right)) c = OUT
      else if (m === DIRT) {
        if (up) c = rnd(x, y, 3) > 0.5 ? 0x46352a : 0x3a2c21
        else if (!solid(x, y - 2)) c = 0x2e2118
        else if (down) c = 0x100a07
        else if (left || right) c = mul(c, 0.7)
      } else if (down) c = mul(c, 0.5)
      else if (left || right) c = mul(c, 0.72)
      for (const cr of craters) {
        const d = Math.hypot(x - cr.x, y - cr.y)
        if (d < cr.r + 6) { const k = 1 - (d - cr.r) / 6; if (k > bayer(x, y) * 0.9) c = mix(c, 0x0c0706, Math.min(0.6, 0.2 + k * 0.45)) }
      }
      // tierra cocida junto a la lava
      for (let k = 1; k <= 10; k++) if (F(x, y - k) === LAVA || F(x - k, y) === LAVA || F(x + k, y) === LAVA) { c = mix(c, 0x1a0806, 0.5 * (1 - k / 11)); c = mix(c, 0xff5a1a, 0.18 * (1 - k / 11)); break }
      fg.put(x, y, c)
    }
  }
  // pasto
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H; y++) {
      const m = F(x, y)
      if (!(m === DIRT || m === STONE) || F(x, y - 1) !== AIR) continue
      if (craters.some((c) => Math.hypot(x - c.x, y - c.y) < c.r + 10)) continue
      if (x > LAVA_PIT[0] - 60 && x < LAVA_PIT[1] + 60) continue
      if (rnd(x, y, 81) > 0.55) {
        const h = 1 + Math.floor(rnd(x, y, 82) * (m === STONE ? 2 : 4))
        for (let k = 1; k <= h; k++) fg.put(x, y - k, k === h ? 0x8a8456 : k === 1 ? 0x3d4a2c : 0x5d6640)
      }
    }
  }
}

function paintLiquids() {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = F(x, y)
      if (m === WATER) {
        const top = F(x, y - 1) !== WATER
        const depth = (() => { let d = 0; while (F(x, y - d - 1) === WATER) d++; return d })()
        let c = mix(0x5a8a92, 0x1c3a48, Math.min(1, Math.floor((depth / 50) * 6 + bayer(x, y)) / 6))
        let a = 0.78
        if (top) { c = 0xcfe4dc; a = 1 }
        else if (depth === 1) { c = 0x8ab8b8; a = 0.9 }
        else if (depth < 6 && rnd(x >> 2, y, 12) > 0.93) { c = 0xb0d4d0; a = 0.8 }
        fg.put(x, y, c, a)
      } else if (m === LAVA) {
        const top = F(x, y - 1) !== LAVA
        let d = 0; while (F(x, y - d - 1) === LAVA) d++
        const n = noise1(x + y * 0.5, 11, 31)
        let c = gradient([[0, 0xfff1a8], [0.12, 0xffb43e], [0.35, 0xf77a28], [0.7, 0xd24a1c], [1, 0x8a2814]], Math.min(1, Math.floor(((d / 46) * 0.8 + n * 0.35) * 8 + bayer(x, y)) / 8))
        if (top) c = rnd(x, y, 3) > 0.7 ? 0xffffff : 0xfff1a8
        else if (rnd(x >> 3, y >> 2, 44) > 0.9 && d > 3) c = 0x3a1810 // costra flotante
        fg.put(x, y, c)
      }
    }
  }
  // burbujas sobre la lava
  for (const [bx, r] of [[1650, 2], [1690, 1.5], [1722, 2.5]]) fg.disc(bx, 380 - r, r, (d) => (d > r - 0.8 ? 0xffb43e : 0xfff1a8))
}

// brillo sumado (sobre bg + fg compuestos)
function light(cv, cx, cy, R, tint, k) {
  const [tr, tg, tb] = rgb(tint)
  for (let y = Math.max(0, cy - R); y < Math.min(cv.h, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x < Math.min(cv.w, cx + R); x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d >= R) continue
      const f = Math.floor((1 - d / R) ** 2 * 10 + bayer(x, y)) / 10
      if (f <= 0) continue
      const i = (y * cv.w + x) * 4
      cv.px[i] = c8(cv.px[i] + tr * f * k)
      cv.px[i + 1] = c8(cv.px[i + 1] + tg * f * k)
      cv.px[i + 2] = c8(cv.px[i + 2] + tb * f * k)
    }
  }
}

// ---------- tanques ----------

const STRIPES8 = [
  [0x1f58b8, 0x3d8cf0], [0x9a1e1a, 0xe23d3d], [0xa88a14, 0xe2c13d], [0x2a8a4a, 0x3dbe5a],
  [0x6a2a9a, 0xa65ae0], [0xb0581a, 0xf0903a], [0x1a8a8a, 0x3ad0c8], [0xa82a6a, 0xe85aa0],
]
const ROOKIE_PAL = { b: 0x2a2a2a, B: 0x4a4a4a, g: 0x6a3a1a, G: 0xc89a4a, c: 0x6b3e1f, e: 0xff8a30, n: 0x3a4454 }
const DESERT_PAL = { H: 0x8a7650, J: 0xb09a6c, M: 0x8a8a84, n: 0x6a5a3a }
const groundUnder = (cx) => {
  let best = H
  for (let d = -12; d <= 12; d += 3) { let y = 60; while (!solid(cx + d, y) && y < H - 1) y++; best = Math.min(best, y) }
  return best
}

const players = [
  { n: 1, x: 130, angle: 48, crew: CREW_BANDANA, pal: BANDANA_PAL, hull: 0 },
  { n: 2, x: 830, angle: 130, crew: CREW_SARGE, pal: SARGE_PAL, hull: 1 },
  { n: 3, x: 1205, angle: 34, crew: CREW_BANDANA, pal: ROOKIE_PAL, hull: 2, active: true },
  { n: 4, x: 1500, angle: 140, crew: CREW_SARGE, pal: DESERT_PAL, hull: 3 },
  { n: 5, x: 1955, angle: 150, crew: CREW_SARGE, pal: SARGE_PAL, hull: 0 },
  { n: 6, x: 2290, angle: 140, crew: CREW_BANDANA, pal: BANDANA_PAL, hull: 1 },
]


function drawTank(p) {
  const flip = p.angle > 90
  const x0 = Math.round(p.x - TANK_W / 2)
  const bodyTop = p.ground - TANK_H
  const stripe = STRIPES8[p.n - 1]
  const pal = tankPal(HULLS[p.hull], stripe)
  const fx = (x) => (flip ? x0 + TANK_W - 1 - x : x0 + x)
  antenna(fg, fx(9), bodyTop, stripe[1], flip)
  barrel(fg, fx(PIVOT.x), bodyTop + PIVOT.y, p.angle, HULLS[p.hull])
  fg.sprite(TANK, x0, bodyTop, pal, flip)
  treads(fg, x0, bodyTop + TANK.length)
  const crewX = flip ? x0 + TANK_W - CREW_X - CREW_W : x0 + CREW_X
  fg.sprite(p.crew, crewX, bodyTop - p.crew.length + 1, { k: OUT, ...SKIN, ...p.pal }, flip)
}

function tag(cv, label, cx, bottom, color) {
  const w = label.length * 6 + 5
  const x0 = Math.round(cx - w / 2)
  const y0 = bottom - 13
  cv.rect(x0, y0, w, 11, OUT)
  cv.rect(x0 + 1, y0 + 1, w - 2, 9, color)
  cv.sprite(['kwwwk', '.kwk.', '..k..'], Math.round(cx - 2), y0 + 10, { k: OUT, w: color })
  text(cv, label, x0 + 3, y0 + 3, 0xffffff)
}

// ---------- composición del mundo ----------

paintBackground()
buildTerrain()
paintTerrain()
for (const p of players) p.ground = groundUnder(p.x)

// utilería
ladder(fg, 1261, PY - 2, PY + 55)
crate(fg, 1338, PY + 45); crate(fg, 1350, PY + 45); crate(fg, 1344, PY + 33)
fg.sprite(BARREL, 1364, PY + 45, BARREL_PAL)
ladder(fg, towerX - 12, PY - 42, PY - 1)
fg.sprite(BARREL, 1280, PY - 12, BARREL_PAL)
crate(fg, 1440, PY - 12)
flag(fg, 20, 330)
windsock(fg, 300, surf[300], 4)
fg.sprite(BARREL, 2208, surf[2208] - 12, BARREL_PAL)

for (const p of players) drawTank(p)
paintLiquids()

// tiro de P3 en vuelo hacia P5 (hoy cae corto: marca de impacto en 1878)
const shot = []
{
  const p = players[2]
  const rad = (p.angle * Math.PI) / 180
  let x = p.x + 5 + Math.cos(rad) * (BARREL_LEN + 3), y = p.ground - TANK_H + 3 - Math.sin(rad) * (BARREL_LEN + 3)
  let vx = Math.cos(rad) * 505, vy = Math.sin(rad) * 505
  for (let n = 0; n < 240 * 1.15; n++) {
    vx += 4 * 9 / 240; vy -= 220 / 240; x += vx / 240; y -= vy / 240
    if (n % 4 === 0) shot.push({ x, y })
  }
}
for (let i = 0; i < shot.length; i += 2) {
  const t = i / (shot.length - 1), age = 1 - t, p = shot[i]
  const r = 0.9 + age * 2.6
  fg.disc(p.x + age * age * 10, p.y - age * 4, r, (d) => (d > r - 1 ? 0xb8ada0 : 0xf7f2ea), 0.2 + (1 - age) * 0.6)
}
const tip = shot[shot.length - 1]
fg.disc(tip.x, tip.y, 2.2, (d) => (d > 1.4 ? OUT : 0xfff1a8))

// mundo completo = fondo + frente
const world = new Canvas(W, H)
world.blit(bg, 0, 0)
world.blit(fg, 0, 0)
light(world, 1683, 386, 110, 0xff6a20, 0.32)
for (const p of players) tag(world, `P${p.n}`, p.x, p.ground - 32, STRIPES8[p.n - 1][1])

// ---------- pantalla 800×450: cámara + HUD + minimapa ----------

const CAM_X = 1060 // izquierda del viewport en el mundo
const screen = new Canvas(VW, H)
// fondo con parallax: se mueve a 0,45 de la velocidad de la cámara
const bgX = Math.round(CAM_X * 0.45)
for (let y = 0; y < H; y++) for (let x = 0; x < VW; x++) screen.put(x, y, bg.get(bgX + x, y))
for (let y = 0; y < H; y++) {
  for (let x = 0; x < VW; x++) {
    const i = (y * W + CAM_X + x) * 4
    const a = fg.px[i + 3]
    if (a) screen.put(x, y, (fg.px[i] << 16) | (fg.px[i + 1] << 8) | fg.px[i + 2], a / 255)
  }
}
light(screen, 1683 - CAM_X, 386, 110, 0xff6a20, 0.32)
for (const p of players) if (p.x > CAM_X && p.x < CAM_X + VW) tag(screen, `P${p.n}`, p.x - CAM_X, p.ground - 32, STRIPES8[p.n - 1][1])
screen.sprite(BUBBLE_ALERT, players[3].x - CAM_X - 5, players[3].ground - 58, BUBBLE_PAL)

// minimapa: mapa entero a 1/10
const MM = { s: 10, w: W / 10, h: H / 10 }
MM.x = Math.round((VW - MM.w) / 2)
MM.y = 6
function paintMinimap(cv, ox, oy) {
  cv.rect(ox - 3, oy - 3, MM.w + 6, MM.h + 6, OUT)
  cv.rect(ox - 2, oy - 2, MM.w + 4, MM.h + 4, 0x6a5a48)
  cv.rect(ox - 1, oy - 1, MM.w + 2, MM.h + 2, OUT)
  for (let my = 0; my < MM.h; my++) {
    for (let mx = 0; mx < MM.w; mx++) {
      const count = {}
      for (let y = my * 10; y < my * 10 + 10; y++) for (let x = mx * 10; x < mx * 10 + 10; x++) { const m = F(x, y); count[m] = (count[m] ?? 0) + 1 }
      let best = AIR, bn = 0
      for (const [m, n] of Object.entries(count)) if (+m !== AIR && n > bn) { best = +m; bn = n }
      let c
      if (bn < 35) c = mix(0x1e2a30, 0x2e3e44, my / MM.h)
      else c = { [DIRT]: 0x6a4e36, [STONE]: 0x8a8169, [BRICK]: 0x9a5038, [BEDROCK]: 0x3a3430, [WATER]: 0x4a9ac8, [LAVA]: 0xff7a2a }[best] ?? 0x8a6a40
      // borde superior del terreno más claro
      if (bn >= 35 && my > 0) {
        let above = 0
        for (let y = my * 10 - 10; y < my * 10; y++) for (let x = mx * 10; x < mx * 10 + 10; x++) if (F(x, y) !== AIR) above++
        if (above < 35 && !LIQUID.has(best)) c = mix(c, 0xd8c8a0, 0.45)
      }
      cv.put(ox + mx, oy + my, c)
    }
  }
  // viewport
  const vx = ox + Math.round(CAM_X / 10), vw = VW / 10
  for (let x = vx; x < vx + vw; x++) { cv.put(x, oy - 1, 0xffffff); cv.put(x, oy + MM.h, 0xffffff) }
  for (let y = oy - 1; y <= oy + MM.h; y++) { cv.put(vx, y, 0xffffff); cv.put(vx + vw - 1, y, 0xffffff) }
  for (let y = oy; y < oy + MM.h; y++) for (let x = vx + 1; x < vx + vw - 1; x++) cv.put(x, y, 0xffffff, 0.12)
  // último impacto de P3 (el jugador del turno): cruz de su color
  const ix = ox + Math.round(1878 / 10), iy = oy + Math.round(craters[3].y / 10)
  for (const [dx, dy] of [[-1, -1], [1, 1], [-1, 1], [1, -1], [0, 0]]) cv.put(ix + dx, iy + dy, STRIPES8[2][1])
  // proyectil en vuelo
  cv.put(ox + Math.round(tip.x / 10), oy + Math.round(tip.y / 10), 0xfff1a8)
  // tanques
  for (const p of players) {
    const tx = ox + Math.round(p.x / 10), ty = oy + Math.round(p.ground / 10) - 2
    cv.rect(tx - 2, ty - 1, 5, 4, p.active ? 0xffffff : OUT)
    cv.rect(tx - 1, ty, 3, 2, STRIPES8[p.n - 1][1])
  }
}
paintMinimap(screen, MM.x, MM.y)
text(screen, 'MAPA', MM.x - 30, MM.y + 2, 0xf2ece2)

// flechas a los enemigos fuera de pantalla
function edgeArrow(p, side) {
  const y = Math.max(70, Math.min(H - 60, p.ground - 16))
  const c = STRIPES8[p.n - 1][1]
  const x = side < 0 ? 3 : VW - 4
  for (let k = 0; k < 7; k++) {
    for (let j = -k; j <= k; j++) screen.put(x - side * k, y + j, k === 6 || Math.abs(j) === k ? OUT : c)
  }
  const label = `P${p.n}`
  text(screen, label, side < 0 ? x + 9 : x - 9 - label.length * 6, y - 3, 0xffffff)
}
for (const p of players) {
  if (p.x < CAM_X) edgeArrow(p, -1)
  else if (p.x > CAM_X + VW) edgeArrow(p, 1)
}

// placa del jugador del turno (como en v1) y viento
{
  const p = players[2], col = STRIPES8[2][1], y = H - 34, x = 2
  screen.rect(x, y, 40, 32, OUT); screen.rect(x + 1, y + 1, 38, 30, col); screen.rect(x + 3, y + 3, 34, 26, 0x1c1614)
  screen.spriteScaled(p.crew.slice(0, 12), x + 8, y + 4, { k: OUT, ...SKIN, ...p.pal }, 2)
  const bx = x + 39
  screen.rect(bx, y + 10, 92, 22, OUT); screen.rect(bx + 1, y + 11, 90, 20, col); screen.rect(bx + 2, y + 12, 88, 18, 0x0e0a09)
  text(screen, 'P3  VOS', bx + 5, y + 14, 0xffffff)
  text(screen, 'ANG 34  POT 64', bx + 5, y + 22, 0xffe27a)
  text(screen, 'VIENTO >> 4', VW - 80, H - 14, 0xf2ece2)
}

// ---------- salida ----------

fs.writeFileSync(path.join(outDir, 'v2-world.png'), world.scaledPng(1))
fs.writeFileSync(path.join(outDir, 'v2-screen-x2.png'), screen.scaledPng(2))
fs.writeFileSync(path.join(outDir, 'v2-minimap-x5.png'), screen.scaledPng(5, MM.x - 34, 0, MM.w + 40, MM.h + 12))
console.log('v2 bigmap ok')
