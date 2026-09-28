// Generación procedural determinista del escenario por bioma.
// Se arma siempre "sin espejar" (plataforma a la izquierda, búnker a la derecha) y al final
// se espeja según la seed.
import { Rng, hash2, noise1 } from './rng'
import { columnGround, createTerrain, fillRect } from './terrain'
import {
  AIR,
  BEAM,
  BEDROCK,
  BRICK,
  DIRT,
  METAL,
  POST,
  SLAT,
  STONE,
  TANK_H,
  TANK_HALF_W,
  WOOD,
  WORLD_H,
  WORLD_W,
  type Biome,
  type Prop,
  type PropKind,
  type Terrain,
} from './types'

export const BEDROCK_ROWS = 3

export const PROP_SIZE: Record<PropKind, { w: number; h: number }> = {
  barrel: { w: 10, h: 12 },
  crate: { w: 12, h: 12 },
  ladder: { w: 8, h: 4 }, // h real depende del largo
  lamp: { w: 5, h: 7 },
  flag: { w: 20, h: 36 }, // el mástil está en x; la tela va a la derecha
  windsock: { w: 2, h: 28 }, // solo el mástil; la manga la dibuja el renderer según el viento
}

export interface Generated {
  terrain: Terrain
  props: Prop[]
  spawns: number[] // x del centro de cada tanque, en orden de jugador
}

interface Layout {
  platX1: number
  platY: number
  plateauX0: number
  py: number
  bx: number
  towerX: number
  hillX: number
  hillH: number
  hillW: number
  hillKind: number
  base: number
  bumpX: number
  v1: number
  v2: number
  caveX: number
  caveY: number
  noiseSeed: number
}

interface PropSpec {
  kind: PropKind
  x: number
  y: number
  h?: number
}

const W = WORLD_W
const H = WORLD_H

export function generate(biome: Biome, rng: Rng, count: number): Generated {
  const L = layout(biome, rng)
  const t = createTerrain(W, H)
  const surf: number[] = []
  for (let x = 0; x < W; x++) surf[x] = surface(L, biome, x)
  for (let x = 0; x < W; x++) fillRect(t, x, surf[x], x, H - 1, DIRT)

  const specs: PropSpec[] = []
  if (biome === 'forest') buildForest(t, L, rng, specs)
  else if (biome === 'jungle') buildJungle(t, L, rng, specs)
  else buildIndustrial(t, L, rng, specs, surf)

  craters(t, L, rng, surf)
  fillRect(t, 0, H - BEDROCK_ROWS, W - 1, H - 1, BEDROCK, 'both')

  const spawnXs = pickSpawns(L, rng, count, biome === 'industrial')
  const targets = spawnXs.map((x) => flatten(t, x))
  ramps(t, spawnXs, targets)

  // utilería común: bandera en la plataforma, manga en el primer valle
  specs.push({ kind: 'flag', x: 20, y: L.platY })
  specs.push({ kind: 'windsock', x: L.platX1 + 58, y: 0 })

  const mirror = rng.chance(0.5)
  if (mirror) mirrorTerrain(t)
  const props: Prop[] = []
  for (const s of specs) {
    const p = placeProp(t, s, mirror, props.length, spawnXs.map((x) => (mirror ? W - x : x)))
    if (p) props.push(p)
  }
  return { terrain: t, props, spawns: spawnXs.map((x) => (mirror ? W - x : x)) }
}

function layout(biome: Biome, rng: Rng): Layout {
  const platX1 = rng.int(172, 206)
  const platY = rng.int(326, 340)
  const plateauX0 = rng.int(572, 598)
  const py = rng.int(306, 324)
  const bx = Math.min(638, plateauX0 + rng.int(46, 58))
  const towerX = Math.min(724, bx + rng.int(58, 76))
  const hillX = rng.int(385, 445)
  const hillKind = rng.int(0, 2)
  const hillH = biome === 'jungle' ? rng.int(92, 112) : biome === 'industrial' ? rng.int(68, 88) : rng.int(80, 98)
  const hillW = rng.int(38, 50)
  const base = rng.int(360, 372)
  const v1 = Math.round((platX1 + 50 + hillX - hillW) / 2)
  const v2 = Math.round((hillX + hillW * 0.9 + plateauX0 - 37) / 2)
  return {
    platX1,
    platY,
    plateauX0,
    py,
    bx,
    towerX,
    hillX,
    hillH,
    hillW,
    hillKind,
    base,
    bumpX: v2 + rng.int(-6, 6),
    v1,
    v2,
    caveX: v1 + rng.int(-14, 14),
    caveY: rng.int(394, 408),
    noiseSeed: rng.int(1, 100000),
  }
}

function hill(L: Layout, x: number): number {
  const g = (c: number, w: number) => Math.exp(-(((x - c) / w) ** 2))
  if (L.hillKind === 1) {
    // dos jorobas
    return L.hillH * Math.max(g(L.hillX - 20, L.hillW * 0.7), 0.85 * g(L.hillX + 24, L.hillW * 0.6))
  }
  if (L.hillKind === 2) {
    // cerro ancho con hombro
    return L.hillH * 0.95 * g(L.hillX, L.hillW * 1.1) + 14 * g(L.hillX + L.hillW, 14)
  }
  return L.hillH * g(L.hillX, L.hillW) + 12 * g(L.hillX - 32, 12)
}

function surface(L: Layout, biome: Biome, x: number): number {
  const s = L.noiseSeed
  const rough = biome === 'jungle' ? 22 : 15
  let v = L.base + (noise1(x, 70, s) - 0.5) * rough + (noise1(x, 17, s + 1) - 0.5) * 5
  v -= hill(L, x)
  v -= 10 * Math.exp(-(((x - L.bumpX) / 25) ** 2))
  let y = v
  if (x < L.platX1) y = L.platY
  else if (x < L.platX1 + 50) y = L.platY + (v - L.platY) * ((x - L.platX1) / 50) + (noise1(x, 6, s + 2) - 0.5) * 3
  else if (x >= L.plateauX0) y = L.py
  else if (x >= L.plateauX0 - 37) y = v + (L.py - v) * ((x - (L.plateauX0 - 37)) / 37)
  return Math.round(Math.max(120, Math.min(H - 40, y)))
}

// ---------- estructuras ----------

// Bloques de piedra en hileras, con juntas (solo cambia la forma del borde si hay hueco).
function stoneSlab(t: Terrain, x0: number, y0: number, x1: number, y1: number, m = STONE): void {
  fillRect(t, x0, y0, x1, y1, m)
}

function cave(t: Terrain, cx: number, cy0: number, halfW: number, halfH: number, seed: number): void {
  let deepest = 0
  for (let x = cx - halfW - 8; x <= cx + halfW + 8; x++) deepest = Math.max(deepest, columnGround(t, x))
  const cy = Math.min(H - BEDROCK_ROWS - halfH - 8, Math.max(cy0, deepest + halfH + 14))
  for (let y = cy - halfH - 2; y <= cy + halfH + 2; y++) {
    for (let x = cx - halfW - 4; x <= cx + halfW + 4; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H - BEDROCK_ROWS - 2) continue
      const wob = Math.sin(y / 5 + seed) * 4
      const ny = (y - cy) / halfH
      const nx = (x - cx - wob) / halfW
      const r = 1 - Math.abs(ny) * 0.55 + (hash2(x, y, seed) - 0.5) * 0.12
      if (Math.abs(ny) < 1 && Math.abs(nx) < r) {
        const i = y * W + x
        if (t.front[i] === DIRT || t.front[i] === STONE) {
          t.front[i] = AIR
          if (t.back[i] === AIR) t.back[i] = DIRT
        }
      }
    }
  }
}

// Búnker bajo la meseta: cuarto hueco (front AIR, back del material) y pozo con escalera.
function bunker(t: Terrain, L: Layout, wall: number, floor: number, specs: PropSpec[], rng: Rng): void {
  const { bx, py } = L
  fillRect(t, bx, py + 8, bx + 150, py + 68, wall)
  fillRect(t, bx, py + 57, bx + 150, py + 64, floor)
  t.back.set(t.front) // la pared de fondo es lo que había
  fillRect(t, bx + 10, py + 18, bx + 140, py + 56, AIR)
  fillRect(t, bx + 22, py, bx + 29, py + 17, AIR)
  fillRect(t, bx + 22, py, bx + 29, py + 17, wall, 'back')
  specs.push({ kind: 'ladder', x: bx + 22, y: py - 2, h: py + 57 - (py - 2) })
  specs.push({ kind: 'lamp', x: bx + 58 + rng.int(-8, 8), y: py + 18 })
  const cx = bx + 98 + rng.int(-12, 0)
  specs.push({ kind: 'crate', x: cx, y: py + 45 })
  specs.push({ kind: 'crate', x: cx + 12, y: py + 45 })
  if (rng.chance(0.7)) specs.push({ kind: 'crate', x: cx + 6, y: py + 33 })
  specs.push({ kind: 'barrel', x: bx + 124 + rng.int(-2, 4), y: py + 45 })
}

// Torre de vigilancia de madera sobre la meseta. cabin = material de la cabina.
function tower(t: Terrain, L: Layout, cabin: number, specs: PropSpec[]): void {
  const x = L.towerX
  const g = L.py
  for (const px of [x, x + 18, x + 38, x + 55]) fillRect(t, px, g - 40, px + 3, g - 1, POST)
  fillRect(t, x - 12, g - 42, x + 64, g - 38, BEAM)
  fillRect(t, x, g - 30, x + 58, g - 1, WOOD)
  fillRect(t, x, g - 30, x + 58, g - 27, BEAM)
  fillRect(t, x + 24, g - 20, x + 34, g - 1, AIR)
  fillRect(t, x + 24, g - 20, x + 34, g - 1, WOOD, 'back')
  fillRect(t, x + 2, g - 82, x + 56, g - 43, cabin)
  fillRect(t, x + 12, g - 72, x + 28, g - 58, AIR)
  fillRect(t, x + 12, g - 72, x + 28, g - 58, WOOD, 'back')
  fillRect(t, x - 4, g - 88, x + 62, g - 83, BEAM)
  for (const px of [x + 2, x + 54]) fillRect(t, px, g - 82, px + 2, g - 43, POST)
  specs.push({ kind: 'ladder', x: x - 12, y: g - 42, h: 42 })
}

function buildForest(t: Terrain, L: Layout, rng: Rng, specs: PropSpec[]): void {
  const { platX1, platY, py, plateauX0, hillX } = L
  stoneSlab(t, 14, platY, platX1 - 1, platY + 13)
  stoneSlab(t, 4, platY, 14, platY + 7)
  const b0 = rng.int(80, 110)
  stoneSlab(t, b0, platY + 14, b0 + 46, platY + 20)
  const b1 = rng.int(24, 50)
  stoneSlab(t, b1, platY + 37, b1 + 25, platY + 43)
  const hs = columnGround(t, hillX)
  stoneSlab(t, hillX - 12, hs + 20, hillX + 6, hs + 26)
  stoneSlab(t, plateauX0, py, W - 1, py + 7)
  bunker(t, L, BRICK, STONE, specs, rng)
  cave(t, L.caveX, L.caveY, 50, 12, 3)
  tower(t, L, SLAT, specs)
  specs.push({ kind: 'barrel', x: L.bx + 35, y: py - 12 })
  specs.push({ kind: 'crate', x: L.towerX + 64, y: py - 12 })
  specs.push({ kind: 'barrel', x: platX1 - 16, y: platY - 12 })
}

function buildJungle(t: Terrain, L: Layout, rng: Rng, specs: PropSpec[]): void {
  const { platX1, platY, py, plateauX0 } = L
  // ruinas: bloques de piedra rotos sobre la tierra
  for (let x = 14; x < platX1 - 4; ) {
    const w = rng.int(14, 30)
    if (rng.chance(0.75)) stoneSlab(t, x, platY, Math.min(platX1 - 1, x + w - 1), platY + rng.int(5, 9))
    x += w + rng.int(0, 3)
  }
  // pilar en el borde con dintel
  stoneSlab(t, 4, platY - 26, 11, platY - 1)
  stoneSlab(t, 2, platY - 30, 15, platY - 27)
  const b1 = rng.int(30, 120)
  stoneSlab(t, b1, platY + 30, b1 + 22, platY + 36)
  // ruina en la meseta: cap parcial de piedra, cuarto de piedra con pozo
  for (let x = plateauX0; x < W; x += 24) if (rng.chance(0.6)) stoneSlab(t, x, py, Math.min(W - 1, x + 21), py + 5)
  bunker(t, L, STONE, STONE, specs, rng)
  cave(t, L.caveX, L.caveY, 46, 13, 5)
  cave(t, Math.round((L.hillX + L.v2) / 2), L.caveY + rng.int(-4, 10), 30, 9, 11)
  tower(t, L, SLAT, specs)
  specs.push({ kind: 'crate', x: L.bx + 35, y: py - 12 })
  specs.push({ kind: 'barrel', x: L.towerX + 64, y: py - 12 })
}

function buildIndustrial(t: Terrain, L: Layout, rng: Rng, specs: PropSpec[], surf: number[]): void {
  const { platX1, platY, py, plateauX0 } = L
  // plataforma de ladrillo con chapa arriba
  fillRect(t, 4, platY, platX1 - 1, platY + 16, BRICK)
  fillRect(t, 4, platY, platX1 - 1, platY + 2, METAL)
  fillRect(t, plateauX0, py, W - 1, py + 3, METAL)
  fillRect(t, plateauX0, py + 4, W - 1, py + 7, BRICK)
  bunker(t, L, BRICK, METAL, specs, rng)
  cave(t, L.caveX, L.caveY, 44, 11, 7)
  // galpón de ladrillo en el primer valle, con techo de chapa y puerta
  const sx = L.v1 + rng.int(-4, 8)
  let g = H
  for (let x = sx; x <= sx + 34; x++) g = Math.min(g, surf[x])
  for (let x = sx; x <= sx + 34; x++) fillRect(t, x, g, x, surf[x], BRICK, 'both')
  fillRect(t, sx, g - 30, sx + 34, g - 1, BRICK)
  fillRect(t, sx - 3, g - 33, sx + 37, g - 31, METAL)
  fillRect(t, sx + 4, g - 26, sx + 30, g - 1, AIR)
  fillRect(t, sx + 4, g - 26, sx + 30, g - 1, BRICK, 'back')
  fillRect(t, sx, g - 18, sx + 3, g - 1, AIR)
  fillRect(t, sx, g - 18, sx + 3, g - 1, BRICK, 'back')
  specs.push({ kind: 'barrel', x: sx + 18, y: g - 12 })
  // plataforma de vigas sobre postes, alta en el segundo valle
  const cx = L.v2 + rng.int(36, 42)
  const cy = surf[Math.min(W - 1, cx)] - rng.int(58, 70)
  fillRect(t, cx - 20, cy, cx + 20, cy + 3, BEAM)
  for (const px of [cx - 18, cx + 15]) {
    const gy = columnGround(t, px, cy + 4)
    fillRect(t, px, cy + 4, px + 2, gy - 1, POST)
  }
  specs.push({ kind: 'barrel', x: cx - 5, y: cy - 12 })
  tower(t, L, METAL, specs)
  specs.push({ kind: 'barrel', x: L.bx + 35, y: py - 12 })
}

function craters(t: Terrain, L: Layout, rng: Rng, surf: number[]): void {
  const n = rng.int(2, 3)
  for (let k = 0; k < n; k++) {
    const x = rng.int(L.platX1 + 10, L.plateauX0 - 20)
    const r = rng.int(7, 10)
    const cy = surf[x] + rng.int(0, 3)
    for (let y = cy - r - 2; y <= cy + r + 2; y++) {
      for (let xx = x - r - 2; xx <= x + r + 2; xx++) {
        if (xx < 0 || xx >= W || y < 0 || y >= H) continue
        const d = Math.hypot(xx - x, (y - cy) * 1.1) + (hash2(xx, y, 5) - 0.5) * 2.2
        const i = y * W + xx
        if (d < r && t.front[i] === DIRT) {
          t.front[i] = AIR
          if (t.back[i] === AIR && y >= surf[xx]) t.back[i] = DIRT
        }
      }
    }
  }
}

// ---------- spawns ----------

function pickSpawns(L: Layout, rng: Rng, count: number, industrial: boolean): number[] {
  const plat = rng.int(60, Math.max(62, L.platX1 - 64))
  const plateau = Math.min(L.plateauX0 + 28, L.bx - 16)
  const middle = [L.hillX + (L.hillKind === 1 ? -20 : 0), L.v1, L.v2]
  let slots: number[]
  if (count <= 1) slots = [plat]
  else if (count === 2) slots = [plat, plateau]
  else if (count === 3) {
    // en industrial el primer valle tiene el galpón
    const pool = industrial ? [middle[0], middle[2]] : middle
    slots = [plat, pool[rng.int(0, pool.length - 1)], plateau]
  }
  else slots = [plat, middle[0], L.v2, plateau]
  const bots = slots.slice(1)
  for (let i = bots.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    const tmp = bots[i]
    bots[i] = bots[j]
    bots[j] = tmp
  }
  return [slots[0], ...bots].slice(0, Math.max(1, count))
}

// Aplana el piso bajo un tanque a la mediana y lo empalma con el terreno con rampas de 1:1 como máximo.
export const PAD_RAMP = 80

export function padBounds(cx: number): [number, number] {
  return [cx - TANK_HALF_W - 4, cx + TANK_HALF_W + 3]
}

function flatten(t: Terrain, cx: number): number {
  const [x0, x1] = padBounds(cx)
  const tops: number[] = []
  for (let x = x0; x <= x1; x++) tops.push(columnGround(t, x))
  const sorted = tops.slice().sort((a, b) => a - b)
  const target = sorted[sorted.length >> 1]
  for (let x = x0; x <= x1; x++) setColumn(t, x, target, target - TANK_H - 10)
  return target
}

// Empalma cada pad con el terreno: junto al tanque sigue plano 2 px y después baja o sube
// con pendiente 1:1 hasta alcanzar el suelo original. Cada columna la resuelve el pad más
// cercano; una estructura apoyada en el piso corta la rampa.
function ramps(t: Terrain, spawnXs: number[], targets: number[]): void {
  const pads = spawnXs.map((x) => padBounds(x))
  const near = (x: number) => {
    let best = -1
    let bd = Infinity
    pads.forEach((b, i) => {
      const d = x < b[0] ? b[0] - x : x > b[1] ? x - b[1] : 0
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return bd === 0 ? -2 : best
  }
  pads.forEach((b, i) => {
    for (const dir of [-1, 1]) {
      let prev = targets[i]
      let blocked = 0
      for (let d = 1; d <= PAD_RAMP; d++) {
        const x = dir < 0 ? b[0] - d : b[1] + d
        if (x < 0 || x >= W || near(x) !== i) break
        const orig = soilTop(t, x, targets[i])
        // postes y paredes finas: la rampa pasa de largo; una estructura ancha la corta
        if (orig < 0) {
          if (++blocked > 4) break
          continue
        }
        blocked = 0
        const step = d <= 2 ? 0 : d <= 10 ? 1 : 2
        const h = Math.max(prev - step, Math.min(prev + step, orig))
        if (h === orig && d > 8) break
        if (h !== orig) setColumn(t, x, h, Math.min(orig, h))
        prev = h
      }
    }
  })
}

// Primera fila de tierra o piedra de la columna; salta estructuras que quedan bien arriba del tanque.
// -1 si la columna arranca con una estructura a la altura del tanque.
function soilTop(t: Terrain, x: number, target: number): number {
  let y = columnGround(t, x)
  while (y < H) {
    const m = t.front[y * W + x]
    if (m === DIRT || m === STONE || m === BEDROCK) return y
    if (y >= target - TANK_H - 4) return -1
    while (y < H && t.front[y * W + x] !== AIR) y++
    y = columnGround(t, x, y)
  }
  return -1
}

// Deja la columna con el piso en `top`: aire (front y back) desde `clearFrom` y tierra hasta el suelo original.
function setColumn(t: Terrain, x: number, top: number, clearFrom: number): void {
  if (clearFrom < top) fillRect(t, x, clearFrom, x, top - 1, AIR, 'both')
  const ground = columnGround(t, x, top)
  if (ground > top) fillRect(t, x, top, x, ground - 1, DIRT, 'both')
}

// ---------- utilería ----------

function placeProp(t: Terrain, s: PropSpec, mirror: boolean, id: number, tanks: number[]): Prop | null {
  const size = PROP_SIZE[s.kind]
  const w = size.w
  const h = s.h ?? size.h
  let x = s.x
  // bandera y manga: se espeja el mástil (2 px), no el rectángulo
  if (mirror) x = s.kind === 'flag' || s.kind === 'windsock' ? W - 2 - s.x : W - s.x - w
  let y = s.y
  if (s.kind === 'flag' || s.kind === 'windsock') y = columnGround(t, x) - h
  if (s.kind === 'barrel' || s.kind === 'crate') {
    // que no quede encima de un spawn
    for (const tx of tanks) if (x + w > tx - TANK_HALF_W - 2 && x < tx + TANK_HALF_W + 2) return null
    if (!clear(t, x, y, w, h)) return null
  }
  if (x < 0 || x + w > W) return null
  return { id, kind: s.kind, x, y, w, h, alive: true }
}

function clear(t: Terrain, x: number, y: number, w: number, h: number): boolean {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (t.front[yy * W + xx] !== AIR) return false
  return true
}

function mirrorTerrain(t: Terrain): void {
  for (const g of [t.front, t.back]) {
    for (let y = 0; y < t.h; y++) {
      const row = y * t.w
      for (let a = 0, b = t.w - 1; a < b; a++, b--) {
        const tmp = g[row + a]
        g[row + a] = g[row + b]
        g[row + b] = tmp
      }
    }
  }
}
