import { hash2 } from './rng'
import { AIR, BEDROCK, DIRT, MATERIALS, WORLD_H, WORLD_W, type Material, type Terrain } from './types'

export function createTerrain(w = WORLD_W, h = WORLD_H): Terrain {
  return { w, h, front: new Uint8Array(w * h), back: new Uint8Array(w * h) }
}

export function cloneTerrain(t: Terrain): Terrain {
  return { w: t.w, h: t.h, front: t.front.slice(), back: t.back.slice() }
}

// Fuera de la grilla: los costados y el cielo son aire; debajo del mapa es sólido.
export function isSolid(terrain: Terrain, x: number, y: number): boolean {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 0 || ix >= terrain.w || iy < 0) return false
  if (iy >= terrain.h) return true
  return terrain.front[iy * terrain.w + ix] !== AIR
}

export function materialAt(terrain: Terrain, x: number, y: number): Material {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 0 || ix >= terrain.w || iy < 0) return AIR
  if (iy >= terrain.h) return BEDROCK
  return terrain.front[iy * terrain.w + ix]
}

// Primera fila sólida de una columna, buscando desde fromY hacia abajo.
export function columnGround(terrain: Terrain, x: number, fromY = 0): number {
  const ix = Math.floor(x)
  if (ix < 0 || ix >= terrain.w) return terrain.h
  const w = terrain.w
  for (let y = Math.max(0, Math.floor(fromY)); y < terrain.h; y++) {
    if (terrain.front[y * w + ix] !== AIR) return y
  }
  return terrain.h
}

// La y del piso bajo la franja [x - halfW, x + halfW): la fila sólida más alta de esas columnas,
// buscando desde fromY hacia abajo. Sin fromY busca desde el cielo.
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
export function deform(terrain: Terrain, cx: number, cy: number, radius: number, mode: 'destroy' | 'build' | 'dig'): Debris {
  const debris: Debris = {}
  const { w, h, front, back } = terrain
  const r = Math.ceil(radius) + 2
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // borde irregular pero determinista
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + (hash2(x, y, 91) - 0.5) * 1.6
      const i = y * w + x
      if (mode === 'build') {
        if (d <= radius && front[i] === AIR) {
          front[i] = DIRT
          if (back[i] === AIR) back[i] = DIRT
        }
        continue
      }
      const m = front[i]
      if (m === AIR) continue
      // dig: la excavadora atraviesa todo salvo la roca madre
      const tough = mode === 'dig' ? (m === BEDROCK ? 0 : 1) : (MATERIALS[m]?.toughness ?? 1)
      if (tough <= 0 || d > radius * tough) continue
      front[i] = AIR
      debris[m] = (debris[m] ?? 0) + 1
    }
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
