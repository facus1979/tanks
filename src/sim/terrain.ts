import { hash2 } from './rng'
import { AIR, BEDROCK, DIRT, LAVA, MATERIALS, STONE, WATER, WORLD_H, WORLD_W, type Material, type Terrain } from './types'

// v4: tablas por material. SOLID[m] = 1 si colisiona (todo menos el aire y los líquidos); LIQUID[m] = 1
// para agua y lava. Tablas en vez de consultar MATERIALS en cada pixel: isSolid es lo más llamado.
export const SOLID = new Uint8Array(256)
export const LIQUID = new Uint8Array(256)
for (let m = 1; m < 256; m++) {
  if (MATERIALS[m]?.liquid) LIQUID[m] = 1
  else SOLID[m] = 1
}

export function createTerrain(w = WORLD_W, h = WORLD_H): Terrain {
  return { w, h, front: new Uint8Array(w * h), back: new Uint8Array(w * h) }
}

export function cloneTerrain(t: Terrain): Terrain {
  const c: Terrain = { w: t.w, h: t.h, front: t.front.slice(), back: t.back.slice() }
  // v3: las columnas de abismo viajan con la grilla (deform nunca las cambia)
  if (t.pits) c.pits = t.pits.slice()
  return c
}

// ---------- v4: rectángulo sucio ----------

// Lo que cambió el terreno desde la última vez que el flujo lo tomó (takeDirty). deform y el napalm lo
// marcan; el flujo de la IA arranca solo desde ahí. Va en un WeakMap para no tocar el contrato de
// Terrain (y así la grilla de trabajo de la IA lleva el suyo).
export interface Rect {
  x0: number // inclusivos
  y0: number
  x1: number
  y1: number
}
const dirtyOf = new WeakMap<Terrain, Rect>()

export function markDirty(t: Terrain, x0: number, y0: number, x1: number, y1: number): void {
  const ax = Math.max(0, Math.floor(Math.min(x0, x1)))
  const bx = Math.min(t.w - 1, Math.ceil(Math.max(x0, x1)))
  const ay = Math.max(0, Math.floor(Math.min(y0, y1)))
  const by = Math.min(t.h - 1, Math.ceil(Math.max(y0, y1)))
  if (ax > bx || ay > by) return
  const r = dirtyOf.get(t)
  if (!r) dirtyOf.set(t, { x0: ax, y0: ay, x1: bx, y1: by })
  else {
    r.x0 = Math.min(r.x0, ax)
    r.y0 = Math.min(r.y0, ay)
    r.x1 = Math.max(r.x1, bx)
    r.y1 = Math.max(r.y1, by)
  }
}

// Devuelve y limpia el rectángulo sucio (null si no se tocó nada desde la última vez).
export function takeDirty(t: Terrain): Rect | null {
  const r = dirtyOf.get(t) ?? null
  dirtyOf.delete(t)
  return r
}

// ---------- consultas ----------

// v3: la columna ix es de abismo (sin fondo). Sin pits, ninguna.
export function isPit(terrain: Terrain, ix: number): boolean {
  return terrain.pits !== undefined && ix >= 0 && ix < terrain.w && terrain.pits[ix] === 1
}

// Fuera de la grilla: los costados y el cielo son aire; debajo del mapa es sólido (roca madre),
// salvo en las columnas de abismo (v3), donde debajo del mapa no hay nada. v4: agua y lava no son
// sólidas: tanques, utilería y proyectiles las atraviesan (materialAt dice qué hay).
export function isSolid(terrain: Terrain, x: number, y: number): boolean {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 0 || ix >= terrain.w || iy < 0) return false
  if (iy >= terrain.h) return !isPit(terrain, ix)
  return SOLID[terrain.front[iy * terrain.w + ix]] === 1
}

export function materialAt(terrain: Terrain, x: number, y: number): Material {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 0 || ix >= terrain.w || iy < 0) return AIR
  if (iy >= terrain.h) return isPit(terrain, ix) ? AIR : BEDROCK
  return terrain.front[iy * terrain.w + ix]
}

// v4: el líquido de esa celda (WATER o LAVA), o AIR si no hay. Fuera de la grilla, nunca hay.
export function liquidAt(terrain: Terrain, x: number, y: number): Material {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 0 || ix >= terrain.w || iy < 0 || iy >= terrain.h) return AIR
  const m = terrain.front[iy * terrain.w + ix]
  return LIQUID[m] ? m : AIR
}

// v4: hay alguna celda de ese líquido en el rectángulo [x0, x1) × [y0, y1) (recortado a la grilla).
export function hasLiquid(terrain: Terrain, m: Material, x0: number, y0: number, x1: number, y1: number): boolean {
  const ax = Math.max(0, Math.floor(x0))
  const bx = Math.min(terrain.w, Math.ceil(x1))
  const ay = Math.max(0, Math.floor(y0))
  const by = Math.min(terrain.h, Math.ceil(y1))
  const { w, front } = terrain
  for (let y = ay; y < by; y++) {
    const row = y * w
    for (let x = ax; x < bx; x++) if (front[row + x] === m) return true
  }
  return false
}

// Primera fila sólida de una columna, buscando desde fromY hacia abajo. Si no hay ninguna devuelve
// terrain.h: en una columna normal es el borde de la roca madre de abajo; en una de abismo (v3)
// significa "sin piso" (ver isPit). v4: saltea los líquidos (el piso de un lago es su lecho).
export function columnGround(terrain: Terrain, x: number, fromY = 0): number {
  const ix = Math.floor(x)
  if (ix < 0 || ix >= terrain.w) return terrain.h
  const { w, front } = terrain
  for (let y = Math.max(0, Math.floor(fromY)); y < terrain.h; y++) {
    if (SOLID[front[y * w + ix]]) return y
  }
  return terrain.h
}

// v4: primera fila que no es aire (sólido o líquido) buscando desde fromY. La usa la línea de cielo
// de los proyectiles, que sí se enteran del agua (frena) y de la lava (derrite).
export function columnTop(terrain: Terrain, x: number, fromY = 0): number {
  const ix = Math.floor(x)
  if (ix < 0 || ix >= terrain.w) return terrain.h
  const { w, front } = terrain
  for (let y = Math.max(0, Math.floor(fromY)); y < terrain.h; y++) {
    if (front[y * w + ix] !== AIR) return y
  }
  return terrain.h
}

// La y del piso bajo la franja [x - halfW, x + halfW): la fila sólida más alta de esas columnas,
// buscando desde fromY hacia abajo. Sin fromY busca desde el cielo. terrain.h si ninguna columna
// tiene piso (solo puede pasar con toda la franja sobre un abismo).
export function groundAt(terrain: Terrain, x: number, halfW: number, fromY = 0): number {
  const cx = Math.round(x)
  let top = terrain.h
  for (let ix = cx - halfW; ix < cx + halfW; ix++) {
    const g = columnGround(terrain, ix, fromY)
    if (g < top) top = g
  }
  return top
}

export function fillRect(
  terrain: Terrain,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  m: Material,
  layer: 'front' | 'back' | 'both' = 'front',
): void {
  const ax = Math.max(0, Math.min(x0, x1))
  const bx = Math.min(terrain.w - 1, Math.max(x0, x1))
  const ay = Math.max(0, Math.min(y0, y1))
  const by = Math.min(terrain.h - 1, Math.max(y0, y1))
  for (let y = ay; y <= by; y++) {
    const row = y * terrain.w
    for (let x = ax; x <= bx; x++) {
      if (layer !== 'back') terrain.front[row + x] = m
      if (layer !== 'front') terrain.back[row + x] = m
    }
  }
}

export type Debris = Partial<Record<Material, number>>

// Rompe o agrega terreno en un círculo. destroy: cada material se rompe hasta radius*toughness;
// BEDROCK nunca; back queda. build: DIRT donde había aire (front y back).
// v4: los líquidos no se rompen, ni con destroy ni con dig (al romper el borde de una cuenca, el
// líquido corre). build sobre lava pone piedra (la tierra se enfría); sobre agua pone tierra y cada
// celda de agua tapada sube por su columna hasta el primer aire por encima del círculo (el flujo
// después la reparte; si no hay lugar se pierde). Marca el rectángulo como sucio para el flujo.
// Pulido v2: stoneFrom (build): desde esa fila hacia abajo la tierra cae sobre la lava de muerte súbita
// (GameState.lava) y queda piedra, igual que sobre la lava de la grilla.
export function deform(terrain: Terrain, cx: number, cy: number, radius: number, mode: 'destroy' | 'build' | 'dig', stoneFrom = Infinity): Debris {
  const debris: Debris = {}
  const { w, h, front, back } = terrain
  const r = Math.ceil(radius) + 2
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  if (x0 > x1 || y0 > y1) return debris
  markDirty(terrain, x0 - 1, y0 - 1, x1 + 1, y1 + 1)
  let displaced: number[] | null = null // build: índice de cada celda de agua tapada
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // borde irregular pero determinista
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + (hash2(x, y, 91) - 0.5) * 1.6
      const i = y * w + x
      const m = front[i]
      if (mode === 'build') {
        if (d > radius) continue
        if (m === AIR || m === WATER) {
          front[i] = y >= stoneFrom ? STONE : DIRT
          if (back[i] === AIR) back[i] = DIRT
          if (m === WATER) {
            if (!displaced) displaced = []
            displaced.push(i)
          }
        } else if (m === LAVA) {
          front[i] = STONE
          if (back[i] === AIR) back[i] = DIRT
        }
        continue
      }
      if (m === AIR || LIQUID[m]) continue
      // dig: la excavadora atraviesa todo salvo la roca madre
      const tough = mode === 'dig' ? (m === BEDROCK ? 0 : 1) : (MATERIALS[m]?.toughness ?? 1)
      if (tough <= 0 || d > radius * tough) continue
      front[i] = AIR
      debris[m] = (debris[m] ?? 0) + 1
    }
  }
  if (displaced) {
    let top = y0
    for (const i of displaced) {
      const x = i % w
      let y = (i - x) / w - 1
      while (y >= 0 && front[y * w + x] !== AIR) y--
      if (y < 0) continue
      front[y * w + x] = WATER
      if (y < top) top = y
    }
    markDirty(terrain, x0 - 1, top - 1, x1 + 1, y0)
  }
  return debris
}

// Cuántos pixels sólidos hay en la columna x, subiendo desde y-1 sin cortar.
export function solidRunUp(terrain: Terrain, x: number, y: number, max: number): number {
  let n = 0
  for (let yy = y - 1; yy >= 0 && n < max; yy--) {
    if (!isSolid(terrain, x, yy)) break
    n++
  }
  return n
}
