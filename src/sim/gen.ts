// Generación procedural determinista del escenario por bioma.
// El mapa Chico es el escenario de v1 (single): plataforma a la izquierda, valle, cerro, valle y
// meseta con búnker y torre a la derecha; da exactamente los mapas de v1 para la misma seed.
// V3: Mediano y Grande (chain) son una secuencia de tramos de ancho variable elegidos con el rng
// según el bioma (plataforma, valle, cerro, montaña, meseta, colinas con ruinas, abismo, cuenca de
// lago y pozo de lava), empalmados a la misma altura. Todo se arma "sin espejar" y al final se
// espeja según la seed.
import { Rng, hash2, noise1 } from './rng'
import { flowLiquids } from './flow'
import { LIQUID, columnGround, columnTop, createTerrain, fillRect } from './terrain'
import { sinkIntoSnow } from './snow'
import {
  AIR,
  BEAM,
  BEDROCK,
  BRICK,
  DIRT,
  ICE,
  LAVA,
  METAL,
  POST,
  SLAT,
  SNOW,
  STONE,
  TANK_H,
  TANK_HALF_W,
  WATER,
  WOOD,
  WORLD_H,
  WORLD_W,
  type Biome,
  type MapSize,
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
  loot: { w: 14, h: 12 }, // v3 caja de botín
  target: { w: 32, h: 20 }, // v3 objetivo pago
}

export interface Generated {
  terrain: Terrain
  props: Prop[]
  spawns: number[] // x del centro de cada tanque, en orden de jugador
  // v2.4 (Mediano y Grande): por cada spawn, si sirve para un humano (humanSafe). Ausente = todos (Chico).
  safe?: boolean[]
  // v3 (solo Mediano y Grande; interno de sim): cuencas secas que V4 llena de agua o lava. El
  // líquido ocupa las columnas [x0, x1) desde la fila `level` (y de la superficie) hasta el fondo.
  basins?: Basin[]
  // v3: los tramos del mapa en orden, ya espejados (para sim-check y herramientas de QA)
  segments?: Segment[]
  // v2.3 (Mediano y Grande): columnas de la boca de cada abismo (donde se termina el piso a la altura de
  // la superficie) y las cornisas y puentes generados, ya espejados
  mouth?: Uint8Array
  ledges?: LedgeInfo[]
}

// v2.3: una cornisa (costra fina sobre el vacío, columnas [x0, x1)) o un puente que cruza la boca.
export interface LedgeInfo {
  kind: 'cornice' | 'bridge'
  x0: number
  x1: number
  thick: number // espesor de la costra o del puente
}

// v3: tipos de tramo de los mapas Mediano y Grande.
export type SegKind = 'plat' | 'valley' | 'hill' | 'mountain' | 'mesa' | 'hills' | 'abyss' | 'lake' | 'lavapit'

export interface Segment {
  kind: SegKind
  x0: number // [x0, x1)
  x1: number
  bunker?: boolean // meseta con búnker
  tower?: boolean // meseta con torre
}

export interface Basin {
  kind: 'water' | 'lava'
  x0: number // [x0, x1)
  x1: number
  level: number // y de la superficie del líquido (el borde más bajo de la cuenca)
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
  // v3: barril o caja apoyado en la superficie: la y se recalcula al ubicarlo (las rampas de los
  // spawns pueden haber movido el piso). Solo lo usan los mapas por tramos.
  ground?: boolean
}

// Medidas de un tramo. Las funciones que arman un tramo trabajan sobre una grilla propia de
// TRAMO_W × TRAMO_H; las que trabajan sobre el mapa entero (spawns, rampas, utilería) usan t.w/t.h.
export const TRAMO_W = WORLD_W
const TRAMO_H = WORLD_H
const W = TRAMO_W
const H = TRAMO_H

// Separación mínima entre spawns en los mapas de varios tramos.
const SPAWN_GAP = 80
// v5: separación buscada con más de 4 tanques (6 en Mediano, 8 en Grande).
export const SPAWN_GAP_CROWD = 120
// Medición (para sim-check; no afecta la generación): cuántos spawns salieron de cada nivel de la
// búsqueda de spreadSpawns (0 = lugar bueno del tramo, 1-3 = columna que sirve a la separación buscada,
// 4 = a 64 px, 5-6 = sin el chequeo estricto de piso, 7 = cualquier columna).
export const spawnStats = { levels: [0, 0, 0, 0, 0, 0, 0, 0], brinks: [0, 0, 0] }

interface Tramo {
  terrain: Terrain // TRAMO_W × TRAMO_H, sin espejar
  specs: PropSpec[] // coordenadas del tramo
}

// width/height: tamaño del mapa (state.width/height). Con 800×450 da los mismos mapas que v1.
// v2.4: safe = cuántos de los lugares tienen que ser seguros para un humano (ver humanSafe): uno por jugador
// humano. Solo cambia el mapa si sin esa condición no alcanzaban (ver spreadSpawns).
export function generate(biome: Biome, rng: Rng, count: number, width = WORLD_W, height = WORLD_H, safe = 0): Generated {
  if (width === W && height === H) return biome === 'snow' ? singleSnow(rng, count) : single(biome, rng, count)
  return chain(biome, rng, count, width, height, safe)
}

// v2.4: un humano nunca nace sobre una cornisa ni con la caja a menos de HUMAN_PIT_GAP px de un abismo
// (se mide hasta las columnas de abismo, que incluyen el socavón bajo los labios y las cornisas: más
// estricto que la boca). Las IA sí pueden (SPAWN_PIT_GAP), así sigue habiendo tanques a un empujón del vacío.
export const HUMAN_PIT_GAP = 40
export function humanSafe(t: Terrain, x: number): boolean {
  // +1: la caja es [x - TANK_HALF_W, x + TANK_HALF_W) y al espejar se corre un px (como en spawnOk)
  return !nearPit(t, x, TANK_HALF_W + HUMAN_PIT_GAP + 1)
}

// Un tramo: superficie, estructuras del bioma y cráteres.
function buildTramo(biome: Biome, rng: Rng, L: Layout): Tramo {
  const t = createTerrain(W, H)
  const surf: number[] = []
  for (let x = 0; x < W; x++) surf[x] = surface(L, biome, x)
  for (let x = 0; x < W; x++) fillRect(t, x, surf[x], x, H - 1, DIRT)

  const specs: PropSpec[] = []
  if (biome === 'forest') buildForest(t, L, rng, specs)
  else if (biome === 'jungle') buildJungle(t, L, rng, specs)
  else buildIndustrial(t, L, rng, specs, surf)

  craters(t, L, rng, surf)
  return { terrain: t, specs }
}

// Utilería común de un tramo: bandera en la plataforma, manga en el primer valle.
function tramoSpecs(L: Layout, x0: number): PropSpec[] {
  return [
    { kind: 'flag', x: x0 + 20, y: L.platY },
    { kind: 'windsock', x: x0 + L.platX1 + 58, y: 0 },
  ]
}

// Mapa Chico: un tramo, con el orden de sorteos de v1 (mismos mapas para la misma seed).
function single(biome: Biome, rng: Rng, count: number): Generated {
  const L = layout(biome, rng)
  const { terrain: t, specs } = buildTramo(biome, rng, L)
  fillRect(t, 0, H - BEDROCK_ROWS, W - 1, H - 1, BEDROCK, 'both')

  const spawnXs = pickSpawns(L, rng, count, biome === 'industrial')
  const targets = spawnXs.map((x) => flatten(t, x))
  ramps(t, spawnXs, targets)
  specs.push(...tramoSpecs(L, 0))
  return finish(t, specs, spawnXs, rng)
}

// Espejado y utilería, igual para todos los tamaños.
function finish(t: Terrain, specs: PropSpec[], spawnXs: number[], rng: Rng): Generated {
  const mirror = rng.chance(0.5)
  if (mirror) mirrorTerrain(t)
  const spawns = spawnXs.map((x) => (mirror ? t.w - x : x))
  const props: Prop[] = []
  for (const s of specs) {
    const p = placeProp(t, s, mirror, props.length, spawns)
    if (p) props.push(p)
  }
  return { terrain: t, props, spawns }
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

// Spawns repartidos a lo ancho: cada jugador apunta a una posición pareja (con algo de azar) y
// toma el lugar bueno (slot) libre más cercano si está a menos de un tercio del espacio parejo; si
// no, la columna que sirva más cercana a la posición ideal. El jugador 0 queda en la punta y las IA
// se mezclan en el resto.
// ok: el lugar sirve para un tanque (lejos de abismos y cuencas, piso donde entra, sin estructuras).
// loose: lo mínimo cuando no hay nada mejor (muchos jugadores): lejos de abismos y cuencas.
// v2.4: safeCount = cuántos lugares tienen que cumplir safe (los humanos). Se eligen como siempre y, solo
// cuando lo que falta para llegar a safeCount es igual a los lugares que quedan por elegir, los que siguen se
// eligen entre los seguros. Así, si el sorteo de siempre ya daba suficientes lugares seguros, el mapa es
// exactamente el mismo; y el rng se consume igual en los dos casos (un next por lugar y la mezcla final).
function spreadSpawns(t: Terrain, slots: number[], rng: Rng, count: number, ok0: (x: number) => boolean, loose0: (x: number) => boolean, brink: Set<number> = new Set(), safeCount = 0, safe: (x: number) => boolean = () => true): number[] {
  const n = Math.max(1, count)
  let forced = false
  const ok = (x: number) => ok0(x) && (!forced || safe(x))
  const loose = (x: number) => loose0(x) && (!forced || safe(x))
  const span = t.w / n
  const taken: number[] = []
  const away = (x: number, d: number) => taken.every((q) => Math.abs(q - x) >= d)
  // separación buscada: SPAWN_GAP o un tercio del espacio parejo, lo que sea más. v5: con más de 4
  // tanques (Mediano hasta 6, Grande hasta 8) el tercio no llega a SPAWN_GAP_CROWD; ese es el piso
  // para que ningún tiro de arranque alcance a dos tanques a la vez (ni la nuke: radio 60 + media caja).
  const gap = Math.max(SPAWN_GAP, span * 0.32, n > 4 ? SPAWN_GAP_CROWD : 0)
  for (let i = 0; i < n; i++) {
    const ideal = span * (i + 0.5) + (rng.next() - 0.5) * span * 0.3
    forced = safeCount - taken.filter(safe).length >= n - i
    let best = -1
    let level = 0
    for (const x of slots) {
      if (!away(x, gap) || Math.abs(x - ideal) > span * 0.34 || !ok(x)) continue
      // v2.3: los lugares al borde de un abismo (brink) ganan dentro de la ventana: que haya tanques cerca del vacío
      const cost = (q: number) => Math.abs(q - ideal) - (brink.has(q) ? span : 0)
      if (best < 0 || cost(x) < cost(best)) best = x
    }
    // los de las puntas buscan primero de su lado (que los tanques cubran el ancho del mapa)
    const edge = (x: number) => (i === 0 ? x < span : i === n - 1 && n > 1 ? x > t.w - span : true)
    const tries: ((x: number) => boolean)[] = [
      (x) => edge(x) && away(x, gap) && ok(x),
      (x) => away(x, gap) && ok(x),
      (x) => away(x, SPAWN_GAP) && ok(x),
      // sin lugar libre a SPAWN_GAP: el más cercano que sirva aunque quede más pegado a otro
      (x) => away(x, 64) && ok(x),
      (x) => away(x, 64) && loose(x),
    ]
    for (let k = 0; best < 0 && k < tries.length; k++) {
      level = k + 1
      best = scanSpawn(t, ideal, tries[k]) ?? -1
    }
    // nunca en un abismo ni en una cuenca, aunque quede pegado a otro tanque
    if (best < 0) {
      level = 6
      best = scanSpawn(t, ideal, loose, 1) ?? -1
    }
    if (best < 0) {
      level = 7
      best = Math.round(Math.max(40, Math.min(t.w - 40, ideal)))
    }
    spawnStats.levels[level]++
    taken.push(best)
  }
  taken.sort((a, b) => a - b)
  const bots = taken.slice(1)
  for (let i = bots.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    const tmp = bots[i]
    bots[i] = bots[j]
    bots[j] = tmp
  }
  return [taken[0], ...bots]
}

// Columna que cumple ok más cercana a x (de a `step` px hacia los dos lados).
function scanSpawn(t: Terrain, x: number, ok: (x: number) => boolean, step = 6): number | null {
  const x0 = Math.round(x)
  for (let d = 0; d < t.w; d += step) {
    for (const c of d === 0 ? [x0] : [x0 - d, x0 + d]) {
      if (c < 40 || c > t.w - 40) continue
      if (ok(c)) return c
    }
  }
  return null
}

const STRUCTURE = new Set([BRICK, WOOD, SLAT, BEAM, POST, METAL])

// El lugar de un tanque en x (mapas por tramos): piso por encima de la roca madre, a ras de la
// superficie natural del terreno (surf; así no nace arriba de una torre, un galpón o una ruina) y sin
// estructura en la caja ni al lado. Lo que haya debajo del piso no importa: la losa de ladrillo y
// chapa de una plataforma o una meseta industrial es piso, como en v1.
function openGround(t: Terrain, cx: number, surf: number[]): boolean {
  const [x0, x1] = padBounds(cx)
  let top = t.h
  for (let x = x0; x <= x1; x++) {
    const g = columnGround(t, x)
    if (g < surf[x] - 3) return false
    top = Math.min(top, g)
  }
  if (top >= t.h - BEDROCK_ROWS - 4) return false
  for (let x = x0 - 6; x <= x1 + 6; x++) {
    for (let y = Math.max(0, top - TANK_H - 16); y < top; y++) {
      const i = y * t.w + x
      if (STRUCTURE.has(t.front[i]) || STRUCTURE.has(t.back[i])) return false
    }
  }
  return true
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
// v3 (mapas por tramos): stop = columnas que la rampa no puede tocar (abismos, cuencas), ahí se
// corta; long = la rampa puede seguir hasta RAMP_LONG px y, lejos del tanque, empinarse hasta 4 px
// por columna, para que en la falda de una montaña llegue a empalmar con el terreno en vez de dejar
// una pared. Sin opciones, la rampa de v1 (el mapa Chico no cambia).
const RAMP_LONG = 200
function ramps(t: Terrain, spawnXs: number[], targets: number[], opts: { stop?: (x: number) => boolean; long?: boolean } = {}): void {
  const { stop, long } = opts
  const reach = long ? RAMP_LONG : PAD_RAMP
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
      for (let d = 1; d <= reach; d++) {
        const x = dir < 0 ? b[0] - d : b[1] + d
        if (x < 0 || x >= t.w || near(x) !== i || stop?.(x)) break
        const orig = soilTop(t, x, targets[i])
        // postes y paredes finas: la rampa pasa de largo; una estructura ancha la corta
        if (orig < 0) {
          if (++blocked > 4) break
          continue
        }
        blocked = 0
        const step = d <= 2 ? 0 : d <= 10 ? 1 : d <= 30 || !long ? 2 : d <= 50 ? 3 : 4
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
  while (y < t.h) {
    const m = t.front[y * t.w + x]
    if (m === DIRT || m === STONE || m === BEDROCK) return y
    if (y >= target - TANK_H - 4) return -1
    while (y < t.h && t.front[y * t.w + x] !== AIR) y++
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
  if (mirror) x = s.kind === 'flag' || s.kind === 'windsock' ? t.w - 2 - s.x : t.w - s.x - w
  let y = s.y
  if (s.kind === 'flag' || s.kind === 'windsock') y = columnGround(t, x) - h
  if (s.ground) {
    // apoyado en la fila sólida más alta bajo su ancho
    let top = t.h
    for (let xx = x; xx < x + w; xx++) top = Math.min(top, columnGround(t, xx))
    if (top >= t.h - BEDROCK_ROWS) return null
    y = top - h
  }
  if (s.kind === 'barrel' || s.kind === 'crate') {
    // que no quede encima de un spawn
    for (const tx of tanks) if (x + w > tx - TANK_HALF_W - 2 && x < tx + TANK_HALF_W + 2) return null
    if (!clear(t, x, y, w, h)) return null
  }
  if (x < 0 || x + w > t.w) return null
  // v4: nada de utilería dentro de un líquido (bandera y manga: solo el mástil)
  const lw = s.kind === 'flag' || s.kind === 'windsock' ? 2 : w
  for (let yy = Math.max(0, y); yy < Math.min(t.h, y + h); yy++) for (let xx = x; xx < x + lw; xx++) if (LIQUID[t.front[yy * t.w + xx]]) return null
  return { id, kind: s.kind, x, y, w, h, alive: true }
}

function clear(t: Terrain, x: number, y: number, w: number, h: number): boolean {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (t.front[yy * t.w + xx] !== AIR) return false
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

// =====================================================================================
// v3: mapas Mediano y Grande por tramos de ancho variable
// =====================================================================================
//
// planSegments sortea la secuencia de tramos (tipo y ancho) y la altura de cada empalme; cada
// tramo arranca a la altura en que terminó el anterior, así que la superficie es continua. Después
// se arma la grilla en pasadas, como en v1:
//   1. superficie (tierra en front) según la forma de cada tramo;
//   2. sólidos: losas, paredes del búnker, rocas, ruinas, revestimiento de los pozos;
//   3. back = front (la pared de fondo es lo que había);
//   4. tallado: cuarto del búnker, cuevas, cráteres y abismos (front a aire, el back queda);
//   5. lo que va delante de la pared de fondo: torres, galpones, plataformas de vigas, castilletes;
//   6. roca madre abajo, salvo en las columnas de abismo (Terrain.pits).
// Spawns, rampas y utilería, igual que en v1 pero esquivando abismos y cuencas.

interface Seg extends Segment {
  yIn: number // y de la superficie en x0
  yOut: number // y de la superficie en x1 - 1
  first: boolean // toca el borde izquierdo (sin espejar)
  last: boolean // toca el borde derecho
  mesa?: 'full' | 'bunker' | 'tower'
  // parámetros sorteados del tramo (los arma params)
  p: Record<string, number>
}

// Anchos [min, max] por tipo. abismo, lago y lava incluyen los bordes; la meseta depende de lo que lleva.
const SEG_W: Record<SegKind, [number, number]> = {
  plat: [150, 210],
  valley: [100, 200],
  hill: [170, 240],
  mountain: [300, 400],
  mesa: [200, 240],
  hills: [240, 330],
  abyss: [140, 210],
  lake: [160, 260],
  lavapit: [160, 250],
}
const MESA_W: Record<'full' | 'bunker' | 'tower', [number, number]> = { full: [290, 340], bunker: [270, 300], tower: [200, 240] }

// Sabor por bioma: peso de cada tipo de tramo. Bosque: montañas y lagos. Jungla: barrancos
// (abismos), ruinas y lagos. Industrial: pozos de lava (fundición), pozos de mina (abismo) y
// estructuras de chapa y ladrillo.
const SEG_WEIGHT: Record<Biome, Partial<Record<SegKind, number>>> = {
  forest: { valley: 2, hill: 2, mountain: 3, lake: 2.6, hills: 1.2, mesa: 1, plat: 1, abyss: 0.5 },
  jungle: { valley: 1.4, hill: 1.5, mountain: 1.5, lake: 2, hills: 3, mesa: 1, plat: 1, abyss: 2.6 },
  industrial: { valley: 2, hill: 1, mountain: 0.6, lake: 0.3, hills: 1.5, mesa: 1.6, plat: 1.5, abyss: 2, lavapit: 2.6 },
  // v3 nieve: montañas nevadas con glaciares, lagos congelados y grietas (abismos con paredes de hielo)
  snow: { valley: 1.8, hill: 1.6, mountain: 3.2, lake: 2.4, hills: 1, mesa: 1, plat: 1, abyss: 1.8 },
}

// Lo que queda después de un tramo que no es el último: lo justo para que entre un tramo final.
const MIN_TAIL = 200
// Ancho del último tramo cuando ya entra contra el borde.
const LAST_MAX = 340
// Rampa de los costados de la meseta (la de v1).
const MESA_SLOPE = 37
// Distancia mínima entre el borde de un abismo y la caja de un tanque al nacer. v2.3: se mide hasta la
// boca (donde se termina el piso; ver spawnOk) y baja de 40 a 14: un tanque puede nacer a un empujón
// del vacío (el empuje llega a KNOCKBACK_MAX = 24 px; con 20 o más, las muertes por abismo no llegaban
// a 1 de cada 20), sobre una cornisa o al pie de ella.
export const SPAWN_PIT_GAP = 14
// v2.3: sobre una cornisa (columnas de abismo con costra), el piso bajo la caja no puede variar más que
// esto: el pad se aplana sin comerse la costra.
export const CORNICE_SPAWN_FLAT = 3
// v2.3: cuánto se aleja de la boca, como mucho, el lugar al borde de un abismo si el primero no sirve.
const BRINK_SCAN = 30

const isHole = (k: SegKind) => k === 'abyss' || k === 'lake' || k === 'lavapit'

function pick<T>(rng: Rng, opts: [T, number][]): T {
  let total = 0
  for (const o of opts) total += o[1]
  let r = rng.next() * total
  for (const o of opts) {
    r -= o[1]
    if (r < 0) return o[0]
  }
  return opts[opts.length - 1][0]
}

function clampN(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

// Secuencia de tramos. Reglas: arranca con una plataforma (la de la bandera, como en v1); a lo sumo
// un tramo de cada tipo "grande" (montaña, meseta, abismo, lago, lava) cada 800 px; nunca dos
// iguales seguidos (salvo valles), ni un abismo o una cuenca pegados a otro abismo o cuenca, ni un
// abismo contra el borde; siempre hay una meseta con búnker y torre y, si hay más de una, sus
// centros quedan a 800 px o más (a lo sumo una cada 800 px).
function planSegments(biome: Biome, rng: Rng, width: number): Seg[] {
  const per = Math.max(1, Math.floor(width / TRAMO_W))
  const segs: Seg[] = []
  const count: Partial<Record<SegKind, number>> = {}
  const full: number[] = [] // centros de las mesetas con búnker y torre
  let x = 0
  let lvl = rng.int(326, 340)
  const push = (kind: SegKind, w: number, mesa?: Seg['mesa']) => {
    const x0 = x
    const x1 = Math.min(width, x + w)
    const last = x1 >= width
    const yOut = isHole(kind) || last ? lvl : clampN(lvl + rng.int(-20, 20), 322, 372)
    segs.push({ kind, x0, x1, yIn: lvl, yOut, first: x0 === 0, last, mesa, p: {} })
    count[kind] = (count[kind] ?? 0) + 1
    if (mesa === 'full') full.push((x0 + x1) / 2)
    x = x1
    lvl = yOut
  }
  const fullOk = (c: number) => full.length < per && full.every((f) => Math.abs(f - c) >= TRAMO_W)
  // dónde cae la meseta con búnker y torre obligatoria (que no quede siempre contra el borde)
  const fullAt = rng.int(240, width - 620)
  push('plat', rng.int(150, 210))
  while (x < width) {
    const rem = width - x
    const prev = segs[segs.length - 1].kind
    if (full.length === 0 && x >= fullAt && rem >= MESA_W.full[0] + MIN_TAIL) {
      push('mesa', Math.min(rng.int(MESA_W.full[0], MESA_W.full[1]), rem - MIN_TAIL), 'full')
      continue
    }
    if (full.length === 0 && rem <= 660) {
      // todavía no hubo meseta con búnker y torre: va ahora (la última, si ya no entra otra cosa)
      push('mesa', rem < MESA_W.full[0] + MIN_TAIL ? rem : Math.min(rng.int(MESA_W.full[0], MESA_W.full[1]), rem - MIN_TAIL), 'full')
      continue
    }
    if (rem <= LAST_MAX) {
      // último tramo, contra el borde: lo que se pueda apoyar en el borde del mapa
      const opts: [SegKind, number][] = [['plat', 2], ['hill', 1], ['valley', 1]]
      if (rem >= MESA_W.tower[0] && (count.mesa ?? 0) < per + 1) opts.push(['mesa', 2])
      const kind = pick(rng, opts.filter((o) => o[0] !== prev || o[0] === 'valley'))
      let mesa: Seg['mesa']
      if (kind === 'mesa') mesa = rem >= MESA_W.full[0] && fullOk(x + rem / 2) ? 'full' : rem >= MESA_W.bunker[0] && rng.chance(0.5) ? 'bunker' : 'tower'
      push(kind, rem, mesa)
      continue
    }
    const opts: [SegKind, number][] = []
    for (const [k, wgt] of Object.entries(SEG_WEIGHT[biome]) as [SegKind, number][]) {
      if (k === prev && k !== 'valley') continue
      if (isHole(k) && (isHole(prev) || (count[k] ?? 0) >= per)) continue
      if (k === 'mesa' && (count[k] ?? 0) >= per) continue
      if (k === 'mountain' && (count[k] ?? 0) >= Math.max(1, per - 1)) continue
      if (k === 'plat' && (count.plat ?? 0) > per) continue
      opts.push([k, wgt])
    }
    let kind = pick(rng, opts)
    let mesa: Seg['mesa']
    let [a, b] = SEG_W[kind]
    if (kind === 'mesa') {
      // la primera meseta del mapa es siempre la completa (así nunca quedan dos mesetas pegadas)
      mesa = fullOk(x + 160) && (full.length === 0 || rng.chance(0.6)) ? 'full' : rng.chance(0.5) ? 'bunker' : 'tower'
      ;[a, b] = MESA_W[mesa]
    }
    let w = rng.int(a, b)
    if (rem - w < MIN_TAIL) {
      if (rem - a >= MIN_TAIL) w = rem - MIN_TAIL
      else {
        // no entra: un valle de relleno
        kind = 'valley'
        mesa = undefined
        w = Math.min(SEG_W.valley[1], rem - MIN_TAIL)
      }
    }
    push(kind, w, mesa)
  }
  return segs
}

// Parámetros sorteados de cada tramo (antes de la superficie: el orden de sorteos es fijo).
function params(seg: Seg, biome: Biome, rng: Rng): void {
  const { x0, x1 } = seg
  const w = x1 - x0
  const p = seg.p
  switch (seg.kind) {
    case 'plat':
      p.px0 = seg.first ? 4 : x0 + 6 // losa
      p.px1 = seg.last ? x1 - 5 : x1 - 46
      break
    case 'valley':
      p.bump = x0 + w * rng.range(0.3, 0.7)
      p.bumpH = rng.int(0, 12)
      break
    case 'hill':
      p.c = x0 + w * rng.range(0.42, 0.58)
      p.kind = rng.int(0, 2)
      p.h = biome === 'jungle' ? rng.int(88, 112) : biome === 'industrial' ? rng.int(64, 88) : rng.int(78, 98)
      p.w = rng.int(38, 50)
      break
    case 'mountain': {
      p.c1 = x0 + w * rng.range(0.38, 0.62)
      p.top = rng.int(110, 150) // y de la cima
      p.w1 = w * rng.range(0.15, 0.19)
      p.two = rng.chance(biome === 'forest' ? 0.55 : 0.45) ? 1 : 0
      const side = rng.chance(0.5) ? 1 : -1
      p.c2 = p.c1 + side * w * rng.range(0.2, 0.27)
      p.k2 = rng.range(0.55, 0.85) // alto del segundo pico respecto del primero
      p.w2 = p.w1 * rng.range(0.55, 0.8)
      p.cave = rng.chance(biome === 'forest' ? 0.6 : 0.45) ? 1 : 0
      p.rocks = rng.int(3, 6)
      break
    }
    case 'mesa': {
      const tx0 = seg.first ? x0 : x0 + MESA_SLOPE
      const tx1 = seg.last ? x1 - 1 : x1 - 1 - MESA_SLOPE
      p.tx0 = tx0
      p.tx1 = tx1
      p.py = clampN(Math.min(seg.yIn, seg.yOut) - rng.int(28, 50), 282, 330)
      if (seg.mesa === 'full') {
        p.bx = tx0 + rng.int(40, 52)
        p.towerX = Math.min(tx1 - 66, p.bx + rng.int(58, 76))
      } else if (seg.mesa === 'bunker') {
        p.bx = tx0 + rng.int(40, Math.max(40, tx1 - tx0 - 160))
      } else {
        p.towerX = tx0 + rng.int(46, Math.max(46, tx1 - tx0 - 70))
      }
      break
    }
    case 'hills': {
      const n = w > 290 ? 3 : 2
      p.n = n
      for (let i = 0; i < n; i++) {
        p['c' + i] = x0 + w * ((i + 0.5) / n) + rng.int(-12, 12)
        p['h' + i] = rng.int(24, 54)
        p['w' + i] = rng.int(26, 38)
      }
      break
    }
    case 'abyss': {
      const pit = clampN(w - 2 * rng.int(30, 42), 60, 130)
      p.a = x0 + Math.floor((w - pit) / 2) + rng.int(-6, 6)
      p.b = p.a + pit - 1
      p.seed = rng.int(1, 100000)
      // v2.3: cornisas y puentes (ver ledgeParams). Salen de p.seed, sin sortear con el rng: el resto
      // del mapa (y los mapas sin abismo) quedan iguales.
      ledgeParams(seg, biome)
      break
    }
    case 'lake':
    case 'lavapit': {
      const bw = clampN(w - 2 * rng.int(28, 40), 100, 200)
      p.b0 = x0 + Math.floor((w - bw) / 2)
      p.b1 = p.b0 + bw // exclusivo
      p.depth = rng.int(30, 60)
      break
    }
  }
}

// v2.3: abismo que mata. Hasta v2.2 las paredes del abismo eran tierra hasta el fondo: el que pasaba el
// borde quedaba enganchado en la pared y casi nadie caía. Ahora, en la mayoría de los abismos, uno o los
// dos labios son una cornisa: una costra fina (CORNICE_CRUST px de tierra) que sobresale sobre el vacío,
// con la pared socavada debajo (el abismo es más ancho abajo que en la boca). Un tanque parado en la
// cornisa se sostiene, pero un tiro que rompe la costra o un empujón que lo pasa del borde lo tira al
// vacío sin pared que lo frene. A veces, además, un puente fino cruza la boca (piedra en la jungla,
// vigas en industrial, tierra en el bosque).
// cornL / cornR: largo de la cornisa de cada lado (0 = labio común); crust: espesor de la costra;
// bridge: 1 si hay puente; bridgeT: su espesor.
export const CORNICE_LEN: [number, number] = [30, 56]
export const CORNICE_CRUST: [number, number] = [6, 9]
// Lo que baja el techo del socavón desde la punta de la cornisa hasta la pared (forma de arco).
const CORNICE_ARCH = 28
export const CORNICE_SPILL = 16
// Labio sin cornisa: socavón de LIP_UNDERCUT px (la pared serpentea ±8 px por fila: con 18 o más, un
// tanque que pasa el borde no encuentra pared debajo) con costra gruesa.
export const LIP_UNDERCUT = 18
export const LIP_CRUST = 20
function ledgeParams(seg: Seg, biome: Biome): void {
  const { p, x0, x1 } = seg
  const roll = (k: number) => hash2(p.seed, k, 0x51ed)
  // 20%: sin cornisa; 25% izquierda; 25% derecha; 30% las dos
  const r = roll(1)
  const left = r >= 0.2 && (r < 0.45 || r >= 0.7)
  const right = r >= 0.45
  // el socavón puede meterse hasta CORNICE_SPILL px bajo el tramo vecino (por debajo de su superficie): así
  // la cornisa llega a ser más larga que un tanque (la pared serpentea hasta 8 px)
  const len = (k: number, room: number) => Math.max(0, Math.min(Math.round(CORNICE_LEN[0] + roll(k) * (CORNICE_LEN[1] - CORNICE_LEN[0])), room + CORNICE_SPILL - 9))
  p.cornL = left ? len(2, p.a - x0) : 0
  p.cornR = right ? len(3, x1 - 1 - p.b) : 0
  if (p.cornL < 16) p.cornL = 0
  if (p.cornR < 16) p.cornR = 0
  p.crust = Math.round(CORNICE_CRUST[0] + roll(4) * (CORNICE_CRUST[1] - CORNICE_CRUST[0]))
  // el lado sin cornisa es un labio grueso, pero también socavado: la pared no sigue derecha hasta el
  // fondo, así que el que pasa el borde cae al vacío en vez de quedar enganchado en la pared
  p.lipL = p.cornL ? 0 : Math.min(LIP_UNDERCUT, Math.max(0, p.a - x0 - 9))
  p.lipR = p.cornR ? 0 : Math.min(LIP_UNDERCUT, Math.max(0, x1 - 1 - p.b - 9))
  p.bridge = roll(5) < (biome === 'jungle' ? 0.4 : 0.25) ? 1 : 0
  p.bridgeT = biome === 'industrial' ? 4 : biome === 'jungle' ? 6 : 7
}

function smooth01(u: number): number {
  const v = clampN(u, 0, 1)
  return v * v * (3 - 2 * v)
}

const gauss = (x: number, c: number, w: number) => Math.exp(-(((x - c) / w) ** 2))

// y de la superficie del tramo en x (antes de clampear).
function segSurface(seg: Seg, biome: Biome, x: number, noiseSeed: number): number {
  const { x0, x1, yIn, yOut, p } = seg
  const w = x1 - x0
  const u = w > 1 ? (x - x0) / (w - 1) : 0
  const base = yIn + (yOut - yIn) * smooth01(u)
  // el ruido se apaga en los empalmes: así cada tramo arranca y termina justo en yIn / yOut
  const taper = smooth01(Math.min(x - x0, x1 - 1 - x) / 30)
  const rough = biome === 'jungle' ? 22 : 15
  const noise = ((noise1(x, 70, noiseSeed) - 0.5) * rough + (noise1(x, 17, noiseSeed + 1) - 0.5) * 5) * taper
  switch (seg.kind) {
    case 'plat': {
      if (x <= p.px1 + 4 || seg.last) return yIn
      const f = (x - p.px1 - 4) / Math.max(1, x1 - 1 - p.px1 - 4)
      return yIn + (yOut - yIn) * smooth01(f) + noise * 0.3 * Math.sin(Math.PI * f)
    }
    case 'valley':
      return base + noise - p.bumpH * gauss(x, p.bump, 25)
    case 'hill': {
      const big = smooth01(Math.min(x - x0, x1 - 1 - x) / 45)
      return base + noise - hillShape(x, p.c, p.h, p.w, p.kind) * big
    }
    case 'mountain': {
      const big = smooth01(Math.min(x - x0, x1 - 1 - x) / (w * 0.22))
      const h1 = yIn + (yOut - yIn) * smooth01((p.c1 - x0) / (w - 1)) - p.top
      let m = h1 * gauss(x, p.c1, p.w1)
      if (p.two) m = Math.max(m, h1 * p.k2 * gauss(x, p.c2, p.w2))
      // hombro bajo del lado contrario al segundo pico, para que la falda no sea una campana perfecta
      m += 18 * gauss(x, p.c1 - (p.c2 - p.c1) * 0.9, p.w1 * 0.8)
      return base + noise - m * big
    }
    case 'mesa': {
      const ny = noise * 0.6
      if (x < p.tx0) return yIn + ny + (p.py - yIn - ny) * smooth01((x - x0) / Math.max(1, p.tx0 - x0))
      if (x > p.tx1) return p.py + (yOut + ny - p.py) * smooth01((x - p.tx1) / Math.max(1, x1 - 1 - p.tx1))
      return p.py
    }
    case 'hills': {
      const big = smooth01(Math.min(x - x0, x1 - 1 - x) / 40)
      let m = 0
      for (let i = 0; i < p.n; i++) m = Math.max(m, p['h' + i] * gauss(x, p['c' + i], p['w' + i]))
      return base + noise * 0.8 - m * big
    }
    case 'abyss':
      return base + noise * 0.3
    case 'lake':
    case 'lavapit': {
      let y = base + noise * 0.25
      if (x >= p.b0 && x < p.b1) {
        const half = (p.b1 - p.b0) / 2
        const v = Math.abs(x + 0.5 - (p.b0 + half)) / half
        y += p.depth * (1 - v * v * v)
      }
      return y
    }
  }
}

// La forma del cerro de v1 (tres variantes), con centro y medidas propias.
function hillShape(x: number, c: number, h: number, w: number, kind: number): number {
  if (kind === 1) return h * Math.max(gauss(x, c - 20, w * 0.7), 0.85 * gauss(x, c + 24, w * 0.6))
  if (kind === 2) return h * 0.95 * gauss(x, c, w * 1.1) + 14 * gauss(x, c + w, 14)
  return h * gauss(x, c, w) + 12 * gauss(x, c - 32, 12)
}

interface Build {
  t: Terrain
  biome: Biome
  rng: Rng
  surf: number[]
  specs: PropSpec[]
  slots: number[] // lugares buenos para un tanque
  brinks: { x: number; dir: -1 | 1 }[] // v2.3: lugares al borde de cada abismo y hacia dónde alejarse si no sirven
  socks: number[] // lugares para la manga de viento
  pits: Uint8Array
  bowls: { kind: 'water' | 'lava'; b0: number; b1: number }[]
  // v2.3: boca del abismo (columnas abiertas a la altura de la superficie: sin cornisa debajo del
  // borde) y las cornisas y puentes que arma el tallado
  mouth: Uint8Array
  ledges: LedgeInfo[]
  // v3 nieve: cabañas (x izquierda, ancho) que arma la pasada de adelante y tramos de hielo en la
  // superficie (glaciares y pistas)
  cabins: { x: number; w: number }[]
  ice: { x0: number; x1: number; depth: number }[]
}

function chain(biome: Biome, rng: Rng, count: number, width: number, height: number, safeCount = 0): Generated {
  const segs = planSegments(biome, rng, width)
  for (const seg of segs) params(seg, biome, rng)
  const noiseSeed = rng.int(1, 100000)
  const t = createTerrain(width, height)
  const surf: number[] = new Array(width)
  for (const seg of segs) {
    for (let x = seg.x0; x < seg.x1; x++) surf[x] = Math.round(clampN(segSurface(seg, biome, x, noiseSeed), 100, height - 40))
  }
  for (let x = 0; x < width; x++) fillRect(t, x, surf[x], x, height - 1, DIRT)
  const b: Build = { t, biome, rng, surf, specs: [], slots: [], socks: [], pits: new Uint8Array(width), bowls: [], mouth: new Uint8Array(width), ledges: [], brinks: [], cabins: [], ice: [] }

  for (const seg of segs) solids(b, seg)
  t.back.set(t.front) // la pared de fondo es lo que había
  for (const seg of segs) carve(b, seg)
  for (const seg of segs) front(b, seg)
  for (const c of b.cabins) cabin(t, c.x, c.w, surf)
  for (let x = 0; x < width; x++) if (!b.pits[x]) fillRect(t, x, height - BEDROCK_ROWS, x, height - 1, BEDROCK, 'both')
  t.pits = b.pits

  // cuencas: el líquido llega hasta el borde más bajo
  const basins: Basin[] = []
  for (const bw of b.bowls) {
    const level = Math.max(columnGround(t, bw.b0 - 1), columnGround(t, bw.b1))
    let x0 = bw.b0
    let x1 = bw.b1
    while (x0 < x1 && columnGround(t, x0) <= level) x0++
    while (x1 > x0 && columnGround(t, x1 - 1) <= level) x1--
    if (x1 - x0 >= 20) basins.push({ kind: bw.kind, x0, x1, level })
  }

  // spawns: lejos de abismos y cuencas, en piso donde entra el tanque
  const ok = (x: number) => spawnOk(t, b.mouth, x, basins, surf)
  const slots = b.slots.map((x) => Math.round(x)).filter((x) => x >= 40 && x <= width - 40 && ok(x))
  // v2.3: al borde de cada abismo, el primer lugar que sirva alejándose de la boca (hasta BRINK_SCAN px):
  // spreadSpawns los prefiere, así casi siempre hay alguien a un empujón del vacío
  const brinks = new Set<number>()
  for (const q of b.brinks) {
    for (let k = 0; k <= BRINK_SCAN; k += 2) {
      const x = q.x + q.dir * k
      if (x < 40 || x > width - 40 || !ok(x)) continue
      brinks.add(x)
      slots.push(x)
      break
    }
  }
  const safe = (x: number) => humanSafe(t, x)
  const spawnXs = spreadSpawns(t, slots, rng, count, ok, (x) => spawnOk(t, b.mouth, x, basins, null), brinks, safeCount, safe)
  // v2.4: seguro para un humano (antes de espejar; el orden es el de spawns)
  const safeFlags = spawnXs.map(safe)
  spawnStats.brinks[0] += b.brinks.length
  spawnStats.brinks[1] += brinks.size
  spawnStats.brinks[2] += spawnXs.filter((x) => brinks.has(x)).length
  const targets = spawnXs.map((x) => flatten(t, x))
  ramps(t, spawnXs, targets, { stop: (x) => nearCols(b.mouth, x, 3) || basins.some((q) => x >= q.x0 - 2 && x < q.x1 + 2), long: true })
  // v4: las cuencas se llenan con su líquido hasta level y el flujo asienta lo que haya quedado suelto
  fillBasins(t, basins)
  // v3 nieve: capa de nieve, hielo (glaciares, pistas, lagos congelados) y los tanques hundidos en la nieve
  if (biome === 'snow') snowFinish(t, b.ice, basins, spawnXs, noiseSeed)

  // una manga de viento cada 800 px
  for (let w0 = 0; w0 < width; w0 += TRAMO_W) {
    const opts = b.socks.filter((x) => x >= w0 && x < w0 + TRAMO_W && x > 4 && x < width - 6)
    if (opts.length > 0) b.specs.push({ kind: 'windsock', x: Math.round(opts[rng.int(0, opts.length - 1)]), y: 0 })
  }

  // espejado: grilla, abismos, cuencas, tramos y spawns
  const mirror = rng.chance(0.5)
  if (mirror) {
    mirrorTerrain(t)
    t.pits.reverse()
    b.mouth.reverse()
  }
  const flipX = (x0: number, x1: number): [number, number] => (mirror ? [width - x1, width - x0] : [x0, x1])
  const spawns = spawnXs.map((x) => (mirror ? width - x : x))
  const props: Prop[] = []
  for (const s of b.specs) {
    const p = placeProp(t, s, mirror, props.length, spawns)
    if (p) props.push(p)
  }
  return {
    terrain: t,
    props,
    spawns,
    safe: safeFlags,
    basins: basins.map((q) => {
      const [x0, x1] = flipX(q.x0, q.x1)
      return { ...q, x0, x1 }
    }),
    mouth: b.mouth,
    ledges: b.ledges.map((l) => {
      const [x0, x1] = flipX(l.x0, l.x1)
      return { ...l, x0, x1 }
    }),
    segments: segs.map((s) => {
      const [x0, x1] = flipX(s.x0, s.x1)
      const seg: Segment = { kind: s.kind, x0, x1 }
      if (s.p.bx !== undefined) seg.bunker = true
      if (s.p.towerX !== undefined) seg.tower = true
      return seg
    }),
  }
}

// v4: llena cada cuenca: en las columnas [x0, x1), desde la fila level hasta el lecho, el aire pasa a
// ser agua o lava (lo sólido queda: estructuras y piedras del lecho no se pisan). Después corre el flujo
// sobre la zona (sin animar) por si alguna celda quedó sin apoyo o con un costado abierto: así nunca
// queda líquido flotando. No usa el rng: el resto del mapa no cambia.
function fillBasins(t: Terrain, basins: Basin[]): void {
  if (basins.length === 0) return
  let x0 = t.w
  let x1 = -1
  let y0 = t.h
  for (const q of basins) {
    const m = q.kind === 'lava' ? LAVA : WATER
    // relleno por inundación desde el aire de la cuenca: así también se llenan los huecos debajo de
    // las piedras del lecho (si no, el flujo los llenaría bajando la superficie). Sin salir de
    // [x0, x1) ni subir de level.
    const stack: number[] = []
    for (let x = q.x0; x < q.x1; x++) {
      const i = Math.max(0, q.level) * t.w + x
      if (t.front[i] === AIR) {
        t.front[i] = m
        stack.push(i)
      }
    }
    while (stack.length > 0) {
      const i = stack.pop()!
      const x = i % t.w
      const y = (i - x) / t.w
      for (let d = 0; d < 4; d++) {
        const xx = d === 0 ? x - 1 : d === 1 ? x + 1 : x
        const yy = d === 2 ? y - 1 : d === 3 ? y + 1 : y
        if (xx < q.x0 || xx >= q.x1 || yy < q.level || yy >= t.h) continue
        const j = yy * t.w + xx
        if (t.front[j] !== AIR) continue
        t.front[j] = m
        stack.push(j)
      }
    }
    x0 = Math.min(x0, q.x0)
    x1 = Math.max(x1, q.x1 - 1)
    y0 = Math.min(y0, q.level)
  }
  flowLiquids(t, { seed: { x0, y0, x1, y1: t.h - 1 }, record: false })
}

// Alguna columna marcada en cols a menos de d px de x.
function nearCols(cols: Uint8Array, x: number, d: number): boolean {
  for (let i = Math.max(0, x - d); i <= Math.min(cols.length - 1, x + d); i++) if (cols[i]) return true
  return false
}

// La columna x tiene un abismo a menos de d px.
function nearPit(t: Terrain, x: number, d: number): boolean {
  const pits = t.pits
  if (!pits) return false
  for (let i = Math.max(0, x - d); i <= Math.min(t.w - 1, x + d); i++) if (pits[i]) return true
  return false
}

// Un tanque puede nacer con centro en x: la caja a SPAWN_PIT_GAP px o más de cualquier abismo y
// fuera de las cuencas (V4 las llena), con 20 px de margen. Con strict (la superficie natural del
// mapa, antes de las rampas), además: piso a ras de la superficie y libre de estructuras
// (openGround) y donde entra, no en la cima filosa de una montaña (el piso no varía más de 26 px en
// ±24 px). Sin strict, lo mínimo: lejos de abismos y cuencas y con piso.
// v2.3: con las cornisas, SPAWN_PIT_GAP se mide hasta la boca del abismo (donde se termina el piso). Puede
// nacer sobre una cornisa (nunca sobre un puente: está en la boca), pero estable: costra en todas las
// columnas del pad y piso parejo (CORNICE_SPAWN_FLAT), así el pad no la corta y el tanque no se vuelca
// solo; para caer hace falta que un tiro rompa la costra o lo empuje hasta el borde.
export function spawnOk(t: Terrain, mouth: Uint8Array | undefined, x: number, basins: Basin[], strict: number[] | null): boolean {
  // +1: la caja del tanque es [x - TANK_HALF_W, x + TANK_HALF_W) y al espejar se corre un px
  if (mouth ? nearCols(mouth, x, TANK_HALF_W + SPAWN_PIT_GAP + 1) : nearPit(t, x, TANK_HALF_W + SPAWN_PIT_GAP + 1)) return false
  if (nearPit(t, x, TANK_HALF_W + 5)) {
    const [x0, x1] = padBounds(x)
    let lo = Infinity
    let hi = -Infinity
    for (let i = x0 - 1; i <= x1 + 1; i++) {
      const g = columnGround(t, i)
      lo = Math.min(lo, g)
      hi = Math.max(hi, g)
    }
    if (hi >= t.h || hi - lo > CORNICE_SPAWN_FLAT) return false
  }
  for (const q of basins) if (x + TANK_HALF_W + 20 > q.x0 && x - TANK_HALF_W - 20 < q.x1) return false
  if (!strict) return columnGround(t, x) < t.h - BEDROCK_ROWS - 4
  let lo = Infinity
  let hi = -Infinity
  for (let i = x - 24; i <= x + 24; i++) {
    const g = columnGround(t, i)
    lo = Math.min(lo, g)
    hi = Math.max(hi, g)
  }
  if (hi - lo > 26) return false
  return openGround(t, x, strict)
}

// ---------- pasada 2: sólidos (antes de copiar la pared de fondo) ----------

function solids(b: Build, seg: Seg): void {
  const { t, biome, rng, surf, specs } = b
  const { x0, x1, p } = seg
  const mid = Math.round((x0 + x1) / 2)
  switch (seg.kind) {
    case 'plat': {
      const y = seg.yIn
      const a = p.px0
      const z = p.px1
      if (biome === 'forest') {
        stoneSlab(t, a + (seg.first ? 10 : 0), y, z, y + 13)
        if (seg.first) stoneSlab(t, a, y, a + 10, y + 7)
        const s0 = rng.int(a + 20, Math.max(a + 20, z - 60))
        stoneSlab(t, s0, y + 14, s0 + 46, y + 20)
      } else if (biome === 'jungle') {
        // ruinas: bloques de piedra rotos sobre la tierra; el pilar con dintel solo contra el borde del mapa
        for (let x = a + (seg.first ? 10 : 0); x < z - 4; ) {
          const w = rng.int(14, 30)
          if (rng.chance(0.75)) stoneSlab(t, x, y, Math.min(z, x + w - 1), y + rng.int(5, 9))
          x += w + rng.int(0, 3)
        }
        if (seg.first) {
          stoneSlab(t, a, y - 26, a + 7, y - 1)
          stoneSlab(t, a - 2, y - 30, a + 11, y - 27)
        }
        const s0 = rng.int(a + 20, Math.max(a + 20, z - 40))
        stoneSlab(t, s0, y + 30, s0 + 22, y + 36)
      } else if (biome === 'snow') {
        // v3 nieve: losa enterrada bajo la nieve y una cabaña de madera en la punta de afuera
        stoneSlab(t, a + (seg.first ? 10 : 0), y + 9, z, y + 15)
        b.cabins.push({ x: a + 1, w: 28 })
      } else {
        fillRect(t, a, y, z, y + 16, BRICK)
        fillRect(t, a, y, z, y + 2, METAL)
      }
      // bandera en la punta (la primera, como en v1), barril del otro lado
      specs.push({ kind: 'flag', x: seg.first ? 20 : a + 8, y })
      specs.push({ kind: 'barrel', x: z - 16, y: y - 12, ground: true })
      const lo = seg.first ? 60 : a + (biome === 'snow' ? 62 : 40) // v3 nieve: lejos de la cabaña
      const hi = z - 40
      b.slots.push(hi > lo ? rng.int(lo, hi) : Math.round((a + z) / 2))
      b.socks.push(z - 30)
      break
    }
    case 'valley': {
      b.slots.push(mid + rng.int(-10, 10))
      // v3 nieve: la mitad de los valles tiene una pista de hielo a ras del suelo
      if (biome === 'snow' && hash2(x0, x1, 0x1ce) < 0.5) {
        const iw = 50 + Math.round(hash2(x0, 7, 0x1ce) * 40)
        const ic = Math.round(x0 + (x1 - x0) * (0.3 + 0.4 * hash2(x1, 9, 0x1ce)))
        b.ice.push({ x0: ic - (iw >> 1), x1: ic + (iw >> 1), depth: 5 })
      }
      if (biome !== 'industrial') {
        // losa de piedra medio enterrada
        if (rng.chance(0.5)) {
          const sx = rng.int(x0 + 10, Math.max(x0 + 10, x1 - 40))
          stoneSlab(t, sx, surf[sx] + 10, sx + rng.int(16, 26), surf[sx] + 16)
        }
      }
      b.socks.push(x0 + 24)
      break
    }
    case 'hill': {
      const c = Math.round(p.c + (p.kind === 1 ? -20 : 0))
      b.slots.push(c)
      // v3 nieve: lengua de glaciar en una falda (lejos de la cima, donde puede nacer un tanque)
      if (biome === 'snow' && hash2(x0, 3, 0x91ac) < 0.6) {
        const side = hash2(x0, 5, 0x91ac) < 0.5 ? -1 : 1
        const a = c + side * 26
        const z = c + side * (26 + 30 + Math.round(hash2(x0, 6, 0x91ac) * 24))
        b.ice.push({ x0: Math.min(a, z), x1: Math.max(a, z), depth: 7 })
      }
      if (biome !== 'industrial' || rng.chance(0.4)) {
        const hs = surf[c]
        stoneSlab(t, c - 12, hs + 20, c + 6, hs + 26)
      }
      b.socks.push(x0 + 26)
      break
    }
    case 'mountain': {
      // rocas incrustadas: la mitad asoma de la falda como un saliente (el lado de cuesta abajo queda
      // afuera, el de cuesta arriba metido en la tierra); el resto, enterradas, aparecen al romper
      for (let i = 0; i < p.rocks; i++) {
        const rx = rng.int(x0 + 30, x1 - 50)
        const rw = rng.int(14, 26)
        const rh = rng.int(5, 7)
        let lo = 0
        for (let x = rx; x <= rx + rw; x++) lo = Math.max(lo, surf[x])
        // el saliente solo en una falda empinada y pareja (sobre una cima parecería un bloque cortado)
        const steep = Math.abs(surf[rx + rw] - surf[rx]) >= rw * 0.6 && Math.min(surf[rx], surf[rx + rw]) <= Math.min(...surf.slice(rx, rx + rw + 1))
        const ry = rng.chance(0.5) && steep ? lo - rh + rng.int(1, 3) : surf[rx] + rng.int(8, 26)
        stoneSlab(t, rx, ry, rx + rw, ry + rh)
      }
      if (biome === 'snow') {
        // v3 nieve: glaciar en una o las dos faldas del pico mayor (hielo a la vista bajo la cima)
        for (const side of [-1, 1]) {
          if (side === 1 && hash2(x0, 11, 0x61ac) < 0.4) continue
          const a = Math.round(p.c1 + side * p.w1 * 0.35)
          const z = Math.round(p.c1 + side * p.w1 * (1.3 + hash2(x0, side + 12, 0x61ac) * 0.6))
          b.ice.push({ x0: Math.max(x0 + 10, Math.min(a, z)), x1: Math.min(x1 - 10, Math.max(a, z)), depth: 9 })
        }
      }
      break
    }
    case 'mesa': {
      const { tx0, tx1, py } = p
      if (biome === 'forest') stoneSlab(t, tx0, py, tx1, py + 7)
      else if (biome === 'snow') {
        // v3 nieve: la meseta queda de tierra (la nieve la cubre); la estación va en el búnker
      } else if (biome === 'jungle') {
        for (let x = tx0; x < tx1; x += 24) if (rng.chance(0.6)) stoneSlab(t, x, py, Math.min(tx1, x + 21), py + 5)
      } else {
        fillRect(t, tx0, py, tx1, py + 3, METAL)
        fillRect(t, tx0, py + 4, tx1, py + 7, BRICK)
      }
      if (p.bx !== undefined) {
        const wall = biome === 'jungle' ? STONE : BRICK
        const floor = biome === 'industrial' ? METAL : STONE
        fillRect(t, p.bx, py + 8, p.bx + 150, py + 68, wall)
        fillRect(t, p.bx, py + 57, p.bx + 150, py + 64, floor)
      }
      // tanque en la punta izquierda de la meseta, antes del pozo del búnker o de la torre
      const before = Math.min(p.bx ?? Infinity, (p.towerX ?? Infinity) - 12)
      const slot = Math.min(tx0 + 28, before - 20)
      if (slot - 20 >= tx0 - (seg.first ? 0 : 10)) b.slots.push(slot)
      // y otro del lado de afuera de la torre, si sobra meseta
      if (p.towerX !== undefined && tx1 - (p.towerX + 64) > 46) b.slots.push(p.towerX + 64 + 24)
      break
    }
    case 'hills': {
      for (let i = 0; i < p.n; i++) b.slots.push(Math.round(p['c' + i]))
      // ruinas en los bajos entre lomas
      for (let i = 0; i + 1 < p.n; i++) {
        const rx = Math.round((p['c' + i] + p['c' + (i + 1)]) / 2) + rng.int(-6, 6)
        // v3 nieve: en vez de ruinas, cabañas de madera en los bajos
        if (biome === 'snow') b.cabins.push({ x: rx, w: 26 })
        else ruin(b, rx)
      }
      if (p.n === 2 || rng.chance(0.5)) {
        const rx = Math.round(p.c0) - rng.int(30, 40)
        if (biome !== 'snow') ruin(b, rx)
      }
      b.socks.push(Math.round((p.c0 + p.c1) / 2) + 14)
      break
    }
    case 'abyss': // v2.3: los lugares al borde del abismo se agregan al tallar (ver carve)
      break
    case 'lake':
    case 'lavapit': {
      const lava = seg.kind === 'lavapit'
      b.bowls.push({ kind: lava ? 'lava' : 'water', b0: p.b0, b1: p.b1 })
      if (lava) {
        // pozo revestido (fundición en industrial): que la lava de V4 no se escurra por la tierra
        const lining = biome === 'industrial' ? BRICK : STONE
        for (let x = p.b0 - 2; x < p.b1 + 2; x++) fillRect(t, x, surf[x], x, surf[x] + 3, lining)
        if (biome === 'industrial') {
          // labios de chapa en los bordes y barriles cerca (explotan si les pega algo)
          fillRect(t, p.b0 - 10, surf[p.b0 - 10], p.b0 - 2, surf[p.b0 - 10] + 2, METAL)
          fillRect(t, p.b1 + 1, surf[p.b1 + 1], p.b1 + 9, surf[p.b1 + 1] + 2, METAL)
          specs.push({ kind: 'barrel', x: p.b0 - 24, y: 0, ground: true })
          if (rng.chance(0.6)) specs.push({ kind: 'barrel', x: p.b1 + 12, y: 0, ground: true })
        }
      } else if (biome === 'forest') {
        // piedras en el lecho del lago
        for (let i = 0; i < 3; i++) {
          const sx = rng.int(p.b0 + 10, p.b1 - 24)
          stoneSlab(t, sx, surf[sx] + 1, sx + rng.int(8, 16), surf[sx] + 4)
        }
      }
      break
    }
  }
}

// Ruina sobre la superficie en x: pilar con dintel (jungla), pared rota de piedra (bosque) o
// pared de ladrillo con chapa (industrial). Se apoya en la fila más alta de su ancho y rellena abajo.
function ruin(b: Build, x: number): void {
  const { t, biome, rng, surf } = b
  const w = biome === 'jungle' ? 34 : rng.int(16, 26)
  let g = t.h
  for (let i = x; i <= x + w; i++) g = Math.min(g, surf[i])
  for (let i = x; i <= x + w; i++) fillRect(t, i, g, i, surf[i] + 2, biome === 'industrial' ? BRICK : STONE)
  if (biome === 'jungle') {
    const h = rng.int(22, 30)
    stoneSlab(t, x, g - h, x + 7, g - 1)
    if (rng.chance(0.7)) stoneSlab(t, x + w - 7, g - h + rng.int(0, 8), x + w, g - 1)
    if (rng.chance(0.6)) stoneSlab(t, x - 2, g - h - 4, x + w + 2 - rng.int(0, 14), g - h - 1)
  } else if (biome === 'forest') {
    let top = g
    for (let k = rng.int(2, 3); k > 0; k--) {
      const a = x + rng.int(0, 6)
      stoneSlab(t, a, top - 6, a + w - rng.int(4, 10), top - 1)
      top -= 6
    }
  } else {
    const h = rng.int(18, 30)
    fillRect(t, x, g - h, x + 6, g - 1, BRICK)
    fillRect(t, x + 7, g - h + 8, x + w, g - 1, BRICK)
    fillRect(t, x - 2, g - h - 2, x + 8, g - h - 1, METAL)
  }
}

// ---------- pasada 4: tallado (después de copiar la pared de fondo) ----------

function carve(b: Build, seg: Seg): void {
  const { t, biome, rng, surf, specs } = b
  const { x0, x1, p } = seg
  switch (seg.kind) {
    case 'mesa':
      if (p.bx !== undefined) {
        const { bx, py } = p
        const wall = biome === 'jungle' ? STONE : BRICK
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
      break
    case 'mountain':
      if (p.cave) {
        // cueva adentro de la montaña, bien por debajo de la superficie
        const cx = Math.round(p.c1 + rng.int(-20, 20))
        const hw = rng.int(28, 46)
        const hh = rng.int(10, 14)
        let deepest = 0
        for (let x = cx - hw - 8; x <= cx + hw + 8; x++) deepest = Math.max(deepest, surf[x])
        const cy = Math.min(t.h - BEDROCK_ROWS - hh - 12, Math.max(rng.int(300, 340), deepest + hh + 18))
        if (cy - hh - 4 > deepest + 12) {
          blob(t, cx, cy, hw, hh, rng.int(1, 99))
          if (biome === 'snow') iceCave(t, cx - hw - 8, cy - hh - 6, cx + hw + 8, cy + hh + 6)
        }
      }
      break
    case 'valley':
    case 'hill':
    case 'hills':
      bigCraters(b, x0 + 20, x1 - 20, rng.int(0, 2))
      if (seg.kind === 'hill' && rng.chance(0.35)) {
        // cueva chica bajo el cerro
        const cx = Math.round(p.c)
        const cy = Math.max(surf[cx] + 40, rng.int(380, 400))
        const hw = rng.int(26, 40)
        const hh = rng.int(8, 11)
        blob(t, cx, cy, hw, hh, rng.int(1, 99))
        if (biome === 'snow') iceCave(t, cx - hw - 8, cy - hh - 6, cx + hw + 8, cy + hh + 6)
      }
      break
    case 'abyss': {
      // paredes irregulares; abajo (las últimas filas) el ancho queda fijo y esas columnas son el abismo
      const { a, b: z, seed } = p
      const wob = (y: number, s: number) => Math.round((noise1(y, 19, seed + s) - 0.5) * 12 + (noise1(y, 5, seed + s + 7) - 0.5) * 4)
      const yb = t.h - 12
      // la pared de fondo (back de tierra) asoma unas filas por encima del labio, con borde irregular
      const lip = Math.min(surf[a - 12], surf[z + 12])
      // v2.3: cornisas (ver ledgeParams). Debajo de la costra, la pared se socava cornL / cornR px: el
      // techo del socavón baja en arco desde la punta (crust px bajo la superficie) hasta la pared.
      // Los labios sin cornisa se socavan igual (lipL / lipR px, con costra de LIP_CRUST).
      const { cornL, cornR, crust } = p
      const uL = cornL || p.lipL
      const uR = cornR || p.lipR
      const cL = cornL ? crust : LIP_CRUST
      const cR = cornR ? crust : LIP_CRUST
      const under = (x: number, c: number, f: number) => surf[x] + c + Math.round(CORNICE_ARCH * f * f)
      for (let y = 0; y < t.h; y++) {
        const yy = Math.min(y, yb)
        const xl = a + wob(yy, 0)
        const xr = z + wob(yy, 3)
        for (let x = xl - uL; x <= xr + uR; x++) {
          if (x < xl && y <= under(x, cL, (xl - x) / uL)) continue
          if (x > xr && y <= under(x, cR, (x - xr) / uR)) continue
          const i = y * t.w + x
          t.front[i] = AIR
          if (t.back[i] === AIR && y >= lip - 4 - Math.round(noise1(x, 9, seed + 11) * 8)) t.back[i] = DIRT
        }
      }
      const pa = a + wob(yb, 0) - uL
      const pz = z + wob(yb, 3) + uR
      for (let x = pa; x <= pz; x++) b.pits[x] = 1
      // la boca: de punta a punta de los labios, a la altura de la superficie
      const ma = uL ? a + wob(Math.min(surf[a], yb), 0) : pa
      const mz = uR ? z + wob(Math.min(surf[z], yb), 3) : pz
      for (let x = ma; x <= mz; x++) b.mouth[x] = 1
      // un lugar para un tanque a cada lado de la boca, a SPAWN_PIT_GAP del borde (sobre la cornisa o el
      // labio, si spawnOk lo acepta); spreadSpawns los prefiere
      b.brinks.push({ x: ma - SPAWN_PIT_GAP - TANK_HALF_W - 2, dir: -1 }, { x: mz + SPAWN_PIT_GAP + TANK_HALF_W + 2, dir: 1 })
      // v3 nieve: la grieta tiene las paredes de hielo (debajo de la costra de la boca)
      if (biome === 'snow') iceWalls(t, pa - 8, pz + 8, (x) => surf[Math.max(x0, Math.min(x1 - 1, x))] + 14)
      if (cornL) b.ledges.push({ kind: 'cornice', x0: pa, x1: ma, thick: crust })
      if (cornR) b.ledges.push({ kind: 'cornice', x0: mz + 1, x1: pz + 1, thick: crust })
      if (p.bridge) b.ledges.push({ kind: 'bridge', x0: ma, x1: mz + 1, thick: p.bridgeT })
      break
    }
  }
}

// Hueco de cueva (front a aire en tierra y piedra; el back queda de tierra).
function blob(t: Terrain, cx: number, cy: number, halfW: number, halfH: number, seed: number): void {
  for (let y = cy - halfH - 2; y <= cy + halfH + 2; y++) {
    for (let x = cx - halfW - 4; x <= cx + halfW + 4; x++) {
      if (x < 0 || x >= t.w || y < 0 || y >= t.h - BEDROCK_ROWS - 2) continue
      const wob = Math.sin(y / 5 + seed) * 4
      const ny = (y - cy) / halfH
      const nx = (x - cx - wob) / halfW
      const r = 1 - Math.abs(ny) * 0.55 + (hash2(x, y, seed) - 0.5) * 0.12
      if (Math.abs(ny) < 1 && Math.abs(nx) < r) {
        const i = y * t.w + x
        if (t.front[i] === DIRT || t.front[i] === STONE) {
          t.front[i] = AIR
          if (t.back[i] === AIR) t.back[i] = DIRT
        }
      }
    }
  }
}

// Cráteres viejos en [xa, xb]: poco hondos, para no dejar escalones.
function bigCraters(b: Build, xa: number, xb: number, n: number): void {
  const { t, rng, surf } = b
  if (xb - xa < 30) return
  for (let k = 0; k < n; k++) {
    const x = rng.int(xa, xb)
    const r = rng.int(7, 10)
    const cy = surf[x] + rng.int(-2, 1)
    // solo en piso casi llano: en una falda el círculo pasaría por debajo de la superficie cuesta
    // arriba y dejaría una costra de tierra colgando sobre el hueco (un escalón al primer tiro)
    let lo = Infinity
    let hi = -Infinity
    for (let xx = Math.max(0, x - r - 2); xx <= Math.min(t.w - 1, x + r + 2); xx++) {
      lo = Math.min(lo, surf[xx])
      hi = Math.max(hi, surf[xx])
    }
    if (hi - lo > 4) continue
    for (let y = cy - r - 2; y <= cy + r + 2; y++) {
      for (let xx = x - r - 2; xx <= x + r + 2; xx++) {
        if (xx < 0 || xx >= t.w || y < 0 || y >= t.h) continue
        const d = Math.hypot(xx - x, (y - cy) * 1.1) + (hash2(xx, y, 5) - 0.5) * 2.2
        const i = y * t.w + xx
        if (d < r && t.front[i] === DIRT) {
          t.front[i] = AIR
          if (t.back[i] === AIR && y >= surf[xx]) t.back[i] = DIRT
        }
      }
    }
  }
}

// ---------- pasada 5: lo que va delante de la pared de fondo ----------

function front(b: Build, seg: Seg): void {
  const { t, biome, rng, surf, specs } = b
  const { x0, x1, p } = seg
  switch (seg.kind) {
    case 'mesa': {
      const { py } = p
      if (p.towerX !== undefined) {
        // v3 nieve: en vez de la torre, el observatorio de la estación
        if (biome === 'snow') observatory(t, p.towerX, py)
        else tower(t, { towerX: p.towerX, py } as Layout, biome === 'industrial' ? METAL : SLAT, specs)
      }
      // utilería arriba de la meseta
      if (p.bx !== undefined) specs.push({ kind: biome === 'jungle' ? 'crate' : 'barrel', x: p.bx + 35, y: py - 12, ground: true })
      if (p.towerX !== undefined) specs.push({ kind: biome === 'jungle' ? 'barrel' : 'crate', x: p.towerX + 64, y: py - 12, ground: true })
      break
    }
    case 'valley':
      if (biome === 'industrial') {
        if (rng.chance(0.55) && x1 - x0 >= 80) shed(b, Math.round((x0 + x1) / 2) - 17 + rng.int(-6, 6))
        else beamDeck(b, Math.round((x0 + x1) / 2) + rng.int(-10, 10))
      }
      break
    case 'abyss': {
      const { a, b: z } = p
      if (biome === 'industrial') {
        // pozo de mina: castillete de postes y viga sobre la boca, escalera colgada de una pared
        const gl = surf[a - 8]
        const gr = surf[z + 8]
        const top = Math.min(gl, gr) - rng.int(40, 50)
        // v2.3: los postes van en la pared de fondo (detrás de los tanques): en el frente eran una pared
        // al borde de la boca y ningún empujón podía tirar a un tanque al pozo
        fillRect(t, a - 9, top, a - 7, gl - 1, POST, 'back')
        fillRect(t, z + 6, top, z + 8, gr - 1, POST, 'back')
        fillRect(t, a - 13, top - 4, z + 12, top - 1, BEAM)
        specs.push({ kind: 'lamp', x: Math.round((a + z) / 2) - 2, y: top })
        // la escalera va pegada a la pared real (las paredes son irregulares)
        const ly = Math.min(t.h - 20, gl + 24)
        let lx = a - 12
        while (lx < z && t.front[ly * t.w + lx] !== AIR) lx++
        specs.push({ kind: 'ladder', x: lx, y: gl - 2, h: rng.int(50, 80) })
      } else if (biome === 'jungle' && rng.chance(0.5)) {
        // restos de un puente de piedra: dos cabezales contra el borde
        stoneSlab(t, a - 16, surf[a - 16] - 6, a - 2, surf[a - 16] - 1)
        stoneSlab(t, z + 2, surf[z + 16] - 6, z + 16, surf[z + 16] - 1)
      }
      if (p.bridge) {
        // v2.3: puente fino de labio a labio, a ras de la superficie (de una punta a la otra en línea
        // recta); solo llena el aire de la boca, así que empalma con las cornisas o las paredes
        const xa = a - 10
        const xz = z + 10
        const ya = surf[xa]
        const yz = surf[xz]
        const m = biome === 'industrial' ? BEAM : biome === 'jungle' ? STONE : biome === 'snow' ? ICE : DIRT // v3: puente de hielo
        for (let x = xa; x <= xz; x++) {
          const y0 = Math.round(ya + ((yz - ya) * (x - xa)) / (xz - xa))
          for (let y = y0; y < y0 + p.bridgeT; y++) {
            const i = y * t.w + x
            if (t.front[i] === AIR) t.front[i] = m
          }
        }
      }
      break
    }
  }
}

// Galpón de ladrillo con techo de chapa y puerta (el de v1).
function shed(b: Build, sx: number): void {
  const { t, surf, specs } = b
  let g = t.h
  for (let x = sx; x <= sx + 34; x++) g = Math.min(g, surf[x])
  for (let x = sx; x <= sx + 34; x++) fillRect(t, x, g, x, surf[x], BRICK, 'both')
  fillRect(t, sx, g - 30, sx + 34, g - 1, BRICK)
  fillRect(t, sx - 3, g - 33, sx + 37, g - 31, METAL)
  fillRect(t, sx + 4, g - 26, sx + 30, g - 1, AIR)
  fillRect(t, sx + 4, g - 26, sx + 30, g - 1, BRICK, 'back')
  fillRect(t, sx, g - 18, sx + 3, g - 1, AIR)
  fillRect(t, sx, g - 18, sx + 3, g - 1, BRICK, 'back')
  specs.push({ kind: 'barrel', x: sx + 18, y: g - 12 })
}

// Plataforma de vigas sobre postes, alta (la de v1), con un barril arriba.
function beamDeck(b: Build, cx: number): void {
  const { t, rng, surf, specs } = b
  const cy = surf[cx] - rng.int(58, 70)
  fillRect(t, cx - 20, cy, cx + 20, cy + 3, BEAM)
  for (const px of [cx - 18, cx + 15]) {
    const gy = columnGround(t, px, cy + 4)
    fillRect(t, px, cy + 4, px + 2, gy - 1, POST)
  }
  specs.push({ kind: 'barrel', x: cx - 5, y: cy - 12 })
}

// =====================================================================================
// v3: bioma nieve
// =====================================================================================
//
// Materiales: SNOW (nieve blanda, se rompe más fácil que la tierra y se compacta bajo los tanques: ver
// snow.ts) e ICE (hielo resbaloso). El terreno se arma como en los otros biomas (tierra, piedra y
// estructuras) y al final una nevada cubre la tierra de la superficie con SNOW_DEPTH px de nieve; el hielo
// va en glaciares (faldas de montañas y cerros), pistas en los valles, las paredes de las grietas y las
// cuevas, los puentes de las grietas y la capa de los lagos congelados (agua de V4 con ICE_CRUST px de
// hielo encima: se pisa; una explosión rompe el hielo y deja el agua a la vista).
// Estructuras: cabañas de madera con techo nevado (plataformas y lomas) y la estación de la meseta: el
// búnker de siempre como sótano y un observatorio con cúpula de chapa en vez de la torre.
// Chico: una pantalla con plataforma y cabaña, lago congelado en el primer valle, cerro nevado más alto
// con glaciar y cueva de hielo, una grieta (sin fondo de abismo: Chico no tiene pits) y la estación.
// Los tanques nacen ya hundidos en la nieve (sinkIntoSnow).

export const SNOW_DEPTH: [number, number] = [5, 9]
export const ICE_CRUST = 5

// Cabaña de madera con techo de vigas y nieve encima, apoyada en la fila más alta de su ancho (cimiento
// de piedra hasta el suelo). x: columna izquierda, w: ancho. Va después de copiar la pared de fondo.
function cabin(t: Terrain, x: number, w: number, surf: (number | undefined)[]): void {
  if (x < 2 || x + w >= t.w - 2) return
  const h = 22
  let g = t.h
  for (let i = x; i <= x + w; i++) g = Math.min(g, surf[i] ?? columnGround(t, i))
  for (let i = x; i <= x + w; i++) {
    const s = surf[i] ?? columnGround(t, i)
    if (s > g) fillRect(t, i, g, i, s, STONE, 'both')
  }
  fillRect(t, x, g - h, x + w, g - 1, WOOD)
  // adentro: aire con la pared de fondo de madera; ventana
  fillRect(t, x + 3, g - h + 4, x + w - 3, g - 1, AIR)
  fillRect(t, x + 3, g - h + 4, x + w - 3, g - 1, WOOD, 'back')
  fillRect(t, x + 6, g - h + 7, x + 11, g - h + 11, SLAT)
  fillRect(t, x + 7, g - h + 8, x + 10, g - h + 10, AIR)
  // techo a dos aguas de vigas con nieve encima
  for (let k = 0; k <= 6; k++) {
    const a = x - 3 + k * 2
    const z = x + w + 3 - k * 2
    if (a > z) break
    fillRect(t, a, g - h - 1 - k, z, g - h - 1 - k, BEAM)
    if (a + 1 <= z - 1) fillRect(t, a + 1, g - h - 3 - k, z - 1, g - h - 2 - k, SNOW)
  }
}

// Observatorio de la estación sobre la meseta (en el lugar de la torre): base de ladrillo, cúpula de chapa
// con la ranura del telescopio y una antena. g: y del piso de la meseta.
function observatory(t: Terrain, x: number, g: number): void {
  fillRect(t, x, g - 30, x + 58, g - 1, BRICK)
  fillRect(t, x + 4, g - 26, x + 54, g - 1, AIR)
  fillRect(t, x + 4, g - 26, x + 54, g - 1, BRICK, 'back')
  fillRect(t, x, g - 33, x + 58, g - 31, METAL)
  const cx = x + 29
  const cy = g - 33
  const R = 22
  for (let y = cy - R - 3; y < cy; y++) {
    for (let xx = cx - R - 3; xx <= cx + R + 3; xx++) {
      if (y < 0 || xx < 0 || xx >= t.w) continue
      const d = Math.hypot(xx - cx, y - cy)
      const i = y * t.w + xx
      if (d <= R - 3) {
        t.front[i] = AIR
        t.back[i] = METAL
      } else if (d <= R) t.front[i] = METAL
      else if (d <= R + 2 && y < cy - R + 8) t.front[i] = SNOW // nieve en lo alto de la cúpula
    }
  }
  // ranura del telescopio (diagonal) y el telescopio adentro
  for (let k = 0; k < 12; k++) {
    const sx = cx + 8 + k
    const sy = cy - 8 - k
    for (let j = -1; j <= 1; j++) {
      const i = (sy + j) * t.w + sx
      if (t.front[i] === METAL || t.front[i] === SNOW) {
        t.front[i] = AIR
        t.back[i] = METAL
      }
    }
  }
  for (let k = 0; k < 14; k++) fillRect(t, cx - 2 + k, cy - 2 - k, cx - 1 + k, cy - 1 - k, POST)
  // antena del lado de afuera
  fillRect(t, x + 2, g - 58, x + 3, g - 34, POST)
  fillRect(t, x - 2, g - 52, x + 7, g - 51, POST)
}

// Cueva de hielo: en el rectángulo, la tierra, la nieve y la piedra que tocan (a 2 px) el aire de la cueva
// (aire por debajo de la superficie de su columna) pasan a hielo, el fondo de la cueva también, y del techo
// cuelgan algunas estalactitas.
function iceCave(t: Terrain, x0: number, y0: number, x1: number, y1: number): void {
  const ax = Math.max(2, x0)
  const bx = Math.min(t.w - 3, x1)
  const ay = Math.max(2, y0)
  const by = Math.min(t.h - BEDROCK_ROWS - 1, y1)
  const top: number[] = []
  for (let x = ax - 2; x <= bx + 2; x++) top[x] = columnTop(t, x)
  const cave = (x: number, y: number) => t.front[y * t.w + x] === AIR && y > (top[x] ?? t.h)
  iceAround(t, ax, ay, bx, by, cave)
  for (let x = ax; x <= bx; x++) {
    for (let y = ay; y <= by; y++) {
      if (!cave(x, y)) continue
      const i = y * t.w + x
      if (t.back[i] === DIRT || t.back[i] === STONE) t.back[i] = ICE
      // estalactita: desde el techo, 2 a 5 px de hielo
      if (t.front[i - t.w] === ICE && hash2(x, y, 0x1c1c) < 0.1) {
        const n = 2 + Math.floor(hash2(x, y, 0x1c1d) * 4)
        for (let k = 0; k < n && y + k <= by && t.front[(y + k) * t.w + x] === AIR; k++) t.front[(y + k) * t.w + x] = ICE
      }
    }
  }
}

// Paredes de hielo de una grieta (columnas [x0, x1]): lo sólido junto al aire de las columnas de abismo, por
// debajo de from(x) (la costra de la boca y las cornisas quedan de nieve).
function iceWalls(t: Terrain, x0: number, x1: number, from: (x: number) => number): void {
  const pits = t.pits ?? null
  const ax = Math.max(2, x0)
  const bx = Math.min(t.w - 3, x1)
  iceAround(t, ax, 0, bx, t.h - BEDROCK_ROWS - 1, (x, y) => t.front[y * t.w + x] === AIR && (pits ? pits[x] === 1 : false) && y > from(x))
}

// Lo sólido blando (tierra, nieve, piedra) a 2 px o menos de una celda `open` pasa a hielo.
function iceAround(t: Terrain, x0: number, y0: number, x1: number, y1: number, open: (x: number, y: number) => boolean): void {
  const hits: number[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const m = t.front[y * t.w + x]
      if (m !== DIRT && m !== SNOW && m !== STONE) continue
      let near = false
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2 && !near; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && xx < t.w && yy >= 0 && yy < t.h && open(xx, yy)) near = true
        }
      }
      if (near) hits.push(y * t.w + x)
    }
  }
  for (const i of hits) t.front[i] = ICE
}

// Nevada: en cada columna, la tierra de la superficie (la primera celda que no es aire, si es tierra) pasa a
// nieve SNOW_DEPTH px (varía con un ruido suave); la pared de fondo de esas filas también.
function snowfall(t: Terrain, seed: number): void {
  for (let x = 0; x < t.w; x++) {
    const y0 = columnTop(t, x)
    if (y0 >= t.h || t.front[y0 * t.w + x] !== DIRT) continue
    const depth = SNOW_DEPTH[0] + Math.floor(noise1(x, 23, seed) * (SNOW_DEPTH[1] - SNOW_DEPTH[0] + 1))
    for (let y = y0; y < Math.min(t.h, y0 + depth); y++) {
      const i = y * t.w + x
      if (t.front[i] !== DIRT) break
      t.front[i] = SNOW
      if (t.back[i] === DIRT) t.back[i] = SNOW
    }
  }
}

// Hielo a la vista en [x0, x1): la nieve o tierra de la superficie pasa a hielo `depth` px. No toca las
// columnas de la caja de un tanque (ni 6 px al lado): un glaciar o una pista no arrancan bajo un spawn.
function iceSheet(t: Terrain, x0: number, x1: number, depth: number, spawns: number[]): void {
  for (let x = Math.max(0, x0); x < Math.min(t.w, x1); x++) {
    if (spawns.some((s) => x >= s - TANK_HALF_W - 6 && x < s + TANK_HALF_W + 6)) continue
    const y0 = columnTop(t, x)
    if (y0 >= t.h) continue
    for (let y = y0; y < Math.min(t.h, y0 + depth); y++) {
      const i = y * t.w + x
      const m = t.front[i]
      if (m !== SNOW && m !== DIRT) break
      t.front[i] = ICE
      if (t.back[i] === SNOW || t.back[i] === DIRT) t.back[i] = ICE
    }
  }
}

// Lago congelado: las ICE_CRUST primeras filas de agua desde la superficie de la cuenca pasan a hielo.
function freeze(t: Terrain, x0: number, x1: number, level: number): void {
  for (let x = Math.max(0, x0); x < Math.min(t.w, x1); x++) {
    for (let y = Math.max(0, level); y < Math.min(t.h, level + ICE_CRUST); y++) {
      const i = y * t.w + x
      if (t.front[i] === WATER) t.front[i] = ICE
    }
  }
}

// Terminación de un mapa de nieve (cualquier tamaño, antes de espejar): nevada, hielo, lagos congelados y
// los tanques hundidos en la nieve (como si ya se hubieran apoyado).
function snowFinish(t: Terrain, ice: { x0: number; x1: number; depth: number }[], basins: Basin[], spawnXs: number[], seed: number): void {
  snowfall(t, seed)
  for (const q of ice) iceSheet(t, q.x0, q.x1, q.depth, spawnXs)
  for (const q of basins) if (q.kind === 'water') freeze(t, q.x0, q.x1, q.level)
  for (const x of spawnXs) sinkIntoSnow(t, x, tankFloorAt(t, x))
}

// Piso de un tanque en x (como tankFloor de physics, sin importarlo).
function tankFloorAt(t: Terrain, x: number): number {
  const cx = Math.round(x)
  for (let y = 0; y < t.h; y++) {
    let n = 0
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) {
      if (ix < 0 || ix >= t.w) continue
      const m = t.front[y * t.w + ix]
      if (m !== AIR && !LIQUID[m]) n++
    }
    if (n >= 3) return y
  }
  return t.h
}

// Mapa Chico de nieve (ver arriba). Usa layout y surface de v1 con el cerro más alto.
function singleSnow(rng: Rng, count: number): Generated {
  const L = layout('snow', rng)
  L.hillH += 34 // cerro nevado: más alto que el de los otros biomas
  const t = createTerrain(W, H)
  const surf: number[] = []
  for (let x = 0; x < W; x++) surf[x] = surface(L, 'snow', x)
  for (let x = 0; x < W; x++) fillRect(t, x, surf[x], x, H - 1, DIRT)
  const specs: PropSpec[] = []
  const { platX1, platY, py } = L
  // losas enterradas bajo la nieve (plataforma y la ladera del cerro)
  stoneSlab(t, 14, platY + 9, platX1 - 1, platY + 16)
  const hs = columnGround(t, L.hillX)
  stoneSlab(t, L.hillX - 12, hs + 24, L.hillX + 6, hs + 30)
  // estación: el búnker es el sótano (piedra, piso de chapa) y el observatorio va donde iba la torre
  bunker(t, L, STONE, METAL, specs, rng)
  cave(t, L.caveX, L.caveY, 46, 12, 9)
  iceCave(t, L.caveX - 60, L.caveY - 30, L.caveX + 60, L.caveY + 30)
  observatory(t, L.towerX, py)
  cabin(t, 5, 28, surf)
  specs.push({ kind: 'barrel', x: L.bx + 35, y: py - 12 })
  specs.push({ kind: 'crate', x: L.towerX + 64, y: py - 12 })
  specs.push({ kind: 'barrel', x: platX1 - 16, y: platY - 12 })
  craters(t, L, rng, surf)
  fillRect(t, 0, H - BEDROCK_ROWS, W - 1, H - 1, BEDROCK, 'both')

  const spawnXs = pickSnowSpawns(L, rng, count)
  const targets = spawnXs.map((x) => flatten(t, x))
  ramps(t, spawnXs, targets)
  const lake = frozenLake(t, L, rng, spawnXs)
  crevasse(t, L, rng, spawnXs, lake)
  // glaciar en la falda del cerro que mira a la meseta
  const hx = L.hillX + (L.hillKind === 1 ? -20 : 0)
  const ice = [{ x0: hx + 24, x1: hx + 24 + rng.int(28, 46), depth: 8 }]
  snowFinish(t, ice, lake ? [lake] : [], spawnXs, L.noiseSeed)
  specs.push(...tramoSpecs(L, 0))
  return finish(t, specs, spawnXs, rng)
}

// Lugares de Chico en la nieve: plataforma, cima del cerro, segundo valle y meseta (el primer valle es el lago).
function pickSnowSpawns(L: Layout, rng: Rng, count: number): number[] {
  const plat = rng.int(60, Math.max(62, L.platX1 - 64))
  const plateau = Math.min(L.plateauX0 + 28, L.bx - 16)
  const hill = L.hillX + (L.hillKind === 1 ? -20 : 0)
  let slots: number[]
  if (count <= 1) slots = [plat]
  else if (count === 2) slots = [plat, plateau]
  else if (count === 3) slots = [plat, rng.chance(0.5) ? hill : L.v2, plateau]
  else slots = [plat, hill, L.v2, plateau]
  const bots = slots.slice(1)
  for (let i = bots.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    const tmp = bots[i]
    bots[i] = bots[j]
    bots[j] = tmp
  }
  return [slots[0], ...bots].slice(0, Math.max(1, count))
}

// Lago congelado de Chico en el primer valle (entre la rampa de la plataforma y el pie del cerro, a 22 px o
// más de la caja de cualquier tanque). Devuelve la cuenca (null si no entra).
function frozenLake(t: Terrain, L: Layout, rng: Rng, spawns: number[]): Basin | null {
  let b0 = Math.max(L.platX1 + 54, L.v1 - 46)
  let b1 = L.v1 + 46
  for (const s of spawns) {
    if (s > L.v1) b1 = Math.min(b1, s - TANK_HALF_W - 4 - 22)
    else b0 = Math.max(b0, s + TANK_HALF_W + 4 + 22)
  }
  const depth = rng.int(18, 26)
  if (b1 - b0 < 44) return null
  const mid = (b0 + b1) / 2
  const half = (b1 - b0) / 2
  for (let x = b0; x < b1; x++) {
    const g = columnGround(t, x)
    const v = Math.abs(x + 0.5 - mid) / half
    const bottom = g + Math.round(depth * (1 - v * v * v))
    for (let y = g; y < bottom; y++) if (t.front[y * t.w + x] === DIRT) t.front[y * t.w + x] = AIR
  }
  const level = Math.max(columnGround(t, b0 - 1), columnGround(t, b1))
  for (let x = b0; x < b1; x++) {
    for (let y = level; y < t.h && t.front[y * t.w + x] === AIR; y++) t.front[y * t.w + x] = WATER
  }
  return { kind: 'water', x0: b0, x1: b1, level }
}

// Grieta de Chico: un tajo de 34-44 px (más ancho que un tanque: el que cae no se engancha) hasta cerca del
// fondo, con paredes de hielo, a 30 px o más de la caja de los tanques y del lago. Sin lugar, no hay grieta.
function crevasse(t: Terrain, L: Layout, rng: Rng, spawns: number[], lake: Basin | null): void {
  const cw = rng.int(34, 44)
  const seed = rng.int(1, 100000)
  for (let k = 0; k < 16; k++) {
    const x0 = rng.int(L.platX1 + 56, L.plateauX0 - 40 - cw)
    const x1 = x0 + cw
    if (spawns.some((s) => x1 > s - TANK_HALF_W - 30 && x0 < s + TANK_HALF_W + 30)) continue
    if (lake && x1 > lake.x0 - 30 && x0 < lake.x1 + 30) continue
    let top = t.h
    for (let x = x0 - 8; x <= x1 + 8; x++) top = Math.min(top, columnGround(t, x))
    const bottom = H - BEDROCK_ROWS - 8 - rng.int(0, 24)
    if (bottom - top < 70) continue
    const wob = (y: number, s: number) => Math.round((noise1(y, 17, seed + s) - 0.5) * 8)
    for (let y = top; y < bottom; y++) {
      // se angosta en las últimas 14 filas (fondo en V)
      const narrow = Math.max(0, y - (bottom - 14)) * 1.2
      const xl = Math.round(x0 + wob(y, 0) + narrow)
      const xr = Math.round(x1 + wob(y, 5) - narrow)
      for (let x = xl; x <= xr; x++) {
        const i = y * t.w + x
        const m = t.front[i]
        if (m !== DIRT && m !== STONE && m !== AIR) continue
        if (m !== AIR) t.back[i] = ICE
        t.front[i] = AIR
      }
    }
    iceAround(t, x0 - 10, top + 10, x1 + 10, bottom + 2, (x, y) => t.front[y * t.w + x] === AIR && y > top + 12 && x >= x0 - 6 && x <= x1 + 6)
    return
  }
}

// ---------- v3: objetivos pagos ----------

// Objetivos pagos (PropKind 'target', 32×20): 0 o 1 en Chico, 1 en Mediano, 1 o 2 en Grande. Sobre piso
// firme y parejo (sin líquido, lejos de abismos), a TARGET_SPAWN_GAP px o más de los tanques y sin pisar otra
// utilería ni estructuras. Los ubica createMatch con un rng propio después de generate (así generate y los
// mapas de los otros biomas no cambian). Devuelve la utilería con los objetivos agregados.
export const TARGET_SPAWN_GAP = 100
const TARGET_TRIES = 60
export function placeTargets(t: Terrain, props: Prop[], spawns: number[], rng: Rng, size: MapSize): Prop[] {
  const n = size === 'small' ? (rng.chance(0.5) ? 1 : 0) : size === 'medium' ? 1 : rng.chance(0.5) ? 2 : 1
  const out = props.slice()
  const { w, h } = PROP_SIZE.target
  for (let k = 0, placed = 0; k < TARGET_TRIES && placed < n; k++) {
    const x = rng.int(30, t.w - 30 - w)
    let lo = t.h
    let hi = -1
    let ok = true
    for (let ix = x - 2; ix < x + w + 2 && ok; ix++) {
      const g = columnGround(t, ix)
      if (t.pits?.[ix] || columnTop(t, ix) < g || g >= t.h - BEDROCK_ROWS - 4) ok = false
      lo = Math.min(lo, g)
      hi = Math.max(hi, g)
    }
    if (!ok || hi - lo > 2 || nearPit(t, Math.round(x + w / 2), w / 2 + 40)) continue
    const y = lo - h
    if (y < 10) continue
    // caja libre, sin estructuras alrededor
    let clearBox = true
    for (let yy = y - 6; yy < lo && clearBox; yy++) {
      for (let xx = x - 4; xx < x + w + 4 && clearBox; xx++) {
        const i = yy * t.w + xx
        if (t.front[i] !== AIR || STRUCTURE.has(t.back[i])) clearBox = false
      }
    }
    if (!clearBox) continue
    if (spawns.some((s) => Math.abs(s - (x + w / 2)) < TARGET_SPAWN_GAP)) continue
    if (out.some((q) => x + w + 8 > q.x && x - 8 < q.x + q.w && y - 8 < q.y + q.h && lo + 8 > q.y)) continue
    out.push({ id: out.length, kind: 'target', x, y, w, h, alive: true })
    placed++
  }
  return out
}
