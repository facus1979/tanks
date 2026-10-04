// v3: efectos de terreno de las armas nuevas: muro, terremoto (derrumbe granular de una zona) y agujero negro
// (atrae el terreno suelto hacia el centro). Todo determinista (orden fijo, sin rng) y con parches para animar
// en el formato de 'collapse' (patches[0] = el rectángulo total como estaba antes; aplicarlos en orden deja la
// grilla final).
import { patchOf } from './flow'
import { hash2 } from './rng'
import { markDirty } from './terrain'
import { AIR, DIRT, LAVA, SNOW, STONE, TANK_H, TANK_HALF_W, WATER, type Player, type Terrain, type TerrainPatch } from './types'

// ---------- grabador de cambios (como en collapse.ts) ----------

// Sellos por celda (como en collapse.ts): la celda ya guardó su valor original en esta grabación.
let stamp = new Uint32Array(0)
let stampGen = 0

// v3: la IA simula sin armar parches (recordFx = false); fire los arma siempre.
export let recordFx = true
export function setRecordFx(v: boolean): void {
  recordFx = v
}

class Recorder {
  origIdx: number[] = []
  origVal: number[] = []
  gen: number
  patches: TerrainPatch[] = []
  wx0 = Infinity
  wy0 = Infinity
  wx1 = -1
  wy1 = -1
  tx0 = Infinity
  ty0 = Infinity
  tx1 = -1
  ty1 = -1
  constructor(
    public t: Terrain,
    public record: boolean,
  ) {
    const n = t.w * t.h
    if (stamp.length < n) {
      stamp = new Uint32Array(n)
      stampGen = 0
    }
    stampGen++
    if (stampGen === 0xffffffff) {
      stamp.fill(0)
      stampGen = 1
    }
    this.gen = stampGen
    this.record = record && recordFx
  }
  set(i: number, m: number): void {
    const t = this.t
    if (this.record && stamp[i] !== this.gen) {
      stamp[i] = this.gen
      this.origIdx.push(i)
      this.origVal.push(t.front[i])
    }
    t.front[i] = m
    const x = i % t.w
    const y = (i - x) / t.w
    if (x < this.wx0) this.wx0 = x
    if (x > this.wx1) this.wx1 = x
    if (y < this.wy0) this.wy0 = y
    if (y > this.wy1) this.wy1 = y
  }
  flush(): void {
    if (this.wx1 < 0) return
    this.tx0 = Math.min(this.tx0, this.wx0)
    this.ty0 = Math.min(this.ty0, this.wy0)
    this.tx1 = Math.max(this.tx1, this.wx1)
    this.ty1 = Math.max(this.ty1, this.wy1)
    if (this.record) this.patches.push(patchOf(this.t, this.wx0, this.wy0, this.wx1, this.wy1))
    this.wx0 = this.wy0 = Infinity
    this.wx1 = this.wy1 = -1
  }
  // Cierra: arma el parche 0 (antes) y marca sucio. Devuelve los parches (vacío si no cambió nada).
  finish(): TerrainPatch[] {
    this.flush()
    if (this.tx1 < 0) return []
    const t = this.t
    markDirty(t, this.tx0 - 1, this.ty0 - 1, this.tx1 + 1, this.ty1 + 1)
    if (!this.record) return []
    const p0 = patchOf(t, this.tx0, this.ty0, this.tx1, this.ty1)
    for (let k = 0; k < this.origIdx.length; k++) {
      const i = this.origIdx[k]
      const x = i % t.w
      const y = (i - x) / t.w
      p0.front[(y - this.ty0) * p0.w + (x - this.tx0)] = this.origVal[k]
    }
    this.patches.unshift(p0)
    return this.patches
  }
  get changed(): boolean {
    return this.tx1 >= 0 || this.wx1 >= 0
  }
}

export interface TerrainFx {
  changed: boolean
  cells: number // celdas que se movieron (o se perdieron)
  patches: TerrainPatch[] // vacío si record = false
}

// ---------- muro ----------

// Pared vertical de tierra de WALL_W px de ancho y WALL_H de alto (2 · radio del arma) parada sobre el piso en
// la columna del impacto. Solo llena aire (la lava que toca se vuelve piedra); no se mete en la caja de ningún
// tanque vivo; en una columna sin piso (abismo) no hay muro.
export const WALL_W = 8
export function buildWall(t: Terrain, players: Player[], x: number, y: number, height: number): number {
  const cx = Math.round(x)
  let n = 0
  for (let ix = cx - WALL_W / 2; ix < cx + WALL_W / 2; ix++) {
    if (ix < 0 || ix >= t.w) continue
    // piso: la primera fila sólida desde un poco arriba del impacto
    let g = Math.max(0, Math.floor(y) - 4)
    while (g < t.h && (t.front[g * t.w + ix] === AIR || t.front[g * t.w + ix] === WATER || t.front[g * t.w + ix] === LAVA)) g++
    if (g >= t.h && t.pits?.[ix]) continue
    for (let iy = g - 1; iy >= Math.max(0, g - height); iy--) {
      if (players.some((p) => p.alive && ix >= Math.round(p.x) - TANK_HALF_W && ix < Math.round(p.x) + TANK_HALF_W && iy >= p.y - TANK_H && iy < p.y)) continue
      const i = iy * t.w + ix
      const m = t.front[i]
      if (m === AIR || m === WATER) t.front[i] = DIRT
      else if (m === LAVA) t.front[i] = STONE
      else continue
      if (t.back[i] === AIR) t.back[i] = DIRT
      n++
    }
  }
  markDirty(t, cx - WALL_W, Math.floor(y) - height - 4, cx + WALL_W, Math.floor(y) + 8)
  return n
}

// ---------- terremoto ----------

// Derrumbe granular. En la zona (el círculo de radio r más la franja de columnas por debajo de su centro hasta
// QUAKE_DEPTH px más abajo del círculo) la tierra y la nieve se comportan como arena durante QUAKE_ITERS
// iteraciones: caen si tienen aire (o agua) abajo y, si no, resbalan en diagonal si el costado y su diagonal
// están libres. La piedra solo cae derecho. Así las laderas empinadas se desmoronan, las cornisas y los techos
// de cueva se caen y los salientes se aplanan. Las estructuras (ladrillo, madera, metal...) no se mueven.
// Tierra sobre lava → piedra; lo que sale por el fondo de un abismo se pierde.
export const QUAKE_ITERS = 32
export const QUAKE_DEPTH = 48
export const QUAKE_FRAME_ITERS = 2
export function quakeTerrain(t: Terrain, x: number, y: number, r: number, record: boolean, band = Infinity): TerrainFx {
  const { w, h, front } = t
  const rec = new Recorder(t, record)
  const cx = Math.round(x)
  const cy = Math.round(y)
  const x0 = Math.max(0, cx - r)
  const x1 = Math.min(w - 1, cx + r)
  const y0 = Math.max(0, cy - r)
  const y1 = Math.min(h - 1, cy + r + QUAKE_DEPTH)
  const r2 = r * r
  let cells = 0
  for (let iter = 0; iter < QUAKE_ITERS; iter++) {
    let moved = false
    for (let yy = y1; yy >= y0; yy--) {
      const dy = yy - cy
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - cx
        if (dy < 0 && dx * dx + dy * dy > r2) continue // arriba del centro, solo el círculo
        const i = yy * w + xx
        const m = front[i]
        if (m !== DIRT && m !== SNOW && m !== STONE) continue
        if (yy + 1 >= h) {
          if (t.pits?.[xx]) {
            rec.set(i, AIR)
            cells++
            moved = true
          }
          continue
        }
        const below = front[i + w]
        if (below === AIR || below === WATER) {
          rec.set(i, below)
          rec.set(i + w, m === DIRT && yy + 1 >= band ? STONE : m)
          cells++
          moved = true
          continue
        }
        if (below === LAVA) {
          if (m === DIRT) rec.set(i, STONE)
          continue
        }
        if (m === STONE) continue
        // granular: resbala en diagonal si el costado y su diagonal están libres (si puede a los dos lados, el
        // lado sale de un hash de la celda y la iteración: determinista)
        const left = xx > x0 && front[i - 1] === AIR && front[i + w - 1] === AIR
        const right = xx < x1 && front[i + 1] === AIR && front[i + w + 1] === AIR
        if (!left && !right) continue
        const d = left && right ? (hash2(xx, yy, 311 + iter) < 0.5 ? -1 : 1) : left ? -1 : 1
        rec.set(i, AIR)
        rec.set(i + w + d, m)
        cells++
        moved = true
      }
    }
    if ((iter + 1) % QUAKE_FRAME_ITERS === 0) rec.flush()
    if (!moved) break
  }
  const changed = rec.changed
  const patches = rec.finish()
  return { changed, cells, patches }
}

// ---------- agujero negro ----------

// Atrae el terreno suelto (tierra y nieve de la superficie: celdas con aire hacia el centro) hacia el centro:
// PULL_ITERS iteraciones de a 1 px, de las celdas más cercanas al centro a las más lejanas. El paso va por el eje
// en que más le falta. Lo que no tiene lugar libre hacia el centro se queda.
export const PULL_ITERS = 14
const pullOrder = new Map<number, Int32Array>() // radio → offsets (dx, dy) ordenados por distancia
function orderFor(r: number): Int32Array {
  const cached = pullOrder.get(r)
  if (cached) return cached
  const list: [number, number, number][] = []
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r && (dx !== 0 || dy !== 0)) list.push([dx, dy, dx * dx + dy * dy])
  list.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0])
  const out = new Int32Array(list.length * 2)
  list.forEach(([dx, dy], k) => {
    out[2 * k] = dx
    out[2 * k + 1] = dy
  })
  pullOrder.set(r, out)
  return out
}
export function pullTerrain(t: Terrain, x: number, y: number, r: number, record: boolean): TerrainFx {
  const { w, h, front } = t
  const rec = new Recorder(t, record)
  const cx = Math.round(x)
  const cy = Math.round(y)
  const order = orderFor(Math.round(r))
  let cells = 0
  for (let iter = 0; iter < PULL_ITERS; iter++) {
    let moved = false
    for (let k = 0; k < order.length; k += 2) {
      const dx = order[k]
      const dy = order[k + 1]
      const xx = cx + dx
      const yy = cy + dy
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue
      const i = yy * w + xx
      const m = front[i]
      if (m !== DIRT && m !== SNOW) continue
      // un paso hacia el centro por el eje dominante
      let sx = 0
      let sy = 0
      if (Math.abs(dx) >= Math.abs(dy)) sx = dx > 0 ? -1 : 1
      else sy = dy > 0 ? -1 : 1
      const nx = xx + sx
      const ny = yy + sy
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const j = ny * w + nx
      if (front[j] !== AIR) continue
      rec.set(i, AIR)
      rec.set(j, m)
      cells++
      moved = true
    }
    rec.flush()
    if (!moved) break
  }
  const changed = rec.changed
  const patches = rec.finish()
  return { changed, cells, patches }
}
