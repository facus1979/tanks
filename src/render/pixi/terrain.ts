// Terreno por pixel: misma lógica visual que paintTerrainBack/paintTerrainFront/paintTufts de look-test.mjs.
// Se pinta en dos buffers (pared de fondo y frente) para que la utilería quede entre los dos.
import { AIR, BEAM, DIRT, POST, SLAT, STONE, WOOD } from '../../sim/types'
import type { Terrain } from '../../sim/types'
import type { Art, BiomePalette } from './assets'
import { MATERIAL_FLAT, OUT } from './fallback'
import { Raster, bayer, mix, mul, rnd } from './raster'

export interface Crater {
  x: number
  y: number
  r: number
}

const WOODISH = new Set([WOOD, SLAT, BEAM, POST])
const DEFAULT_RIM = 0x46352a
const MAX_CRATERS = 96

export interface Rect {
  x0: number
  y0: number
  x1: number // exclusivo
  y1: number
}

export class TerrainPainter {
  readonly back: Raster
  readonly front: Raster
  craters: Crater[] = []
  private prevFront: Uint8Array | null = null
  private prevBack: Uint8Array | null = null
  private pending: Rect | null = null

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.back = new Raster(w, h)
    this.front = new Raster(w, h)
  }

  reset(): void {
    this.craters = []
    this.prevFront = null
    this.prevBack = null
    this.pending = null
  }

  addCrater(x: number, y: number, r: number): void {
    this.craters.push({ x: Math.round(x), y: Math.round(y), r })
    if (this.craters.length > MAX_CRATERS) this.craters.shift()
    const m = r + 12
    this.markDirty({ x0: Math.floor(x - m), y0: Math.floor(y - m), x1: Math.ceil(x + m), y1: Math.ceil(y + m) })
  }

  markDirty(r: Rect): void {
    const p = this.pending
    this.pending = p ? { x0: Math.min(p.x0, r.x0), y0: Math.min(p.y0, r.y0), x1: Math.max(p.x1, r.x1), y1: Math.max(p.y1, r.y1) } : r
  }

  // Devuelve el rectángulo repintado, o null si no hizo falta.
  update(terrain: Terrain, art: Art, pal: BiomePalette, changed: boolean): Rect | null {
    if (changed) {
      const diff = this.diff(terrain)
      if (diff) this.markDirty(diff)
    }
    const p = this.pending
    if (!p) return null
    this.pending = null
    const M = 8
    const r: Rect = {
      x0: Math.max(0, p.x0 - M),
      y0: Math.max(0, p.y0 - M),
      x1: Math.min(this.w, p.x1 + M),
      y1: Math.min(this.h, p.y1 + M),
    }
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return null
    this.paint(terrain, art, pal, r)
    this.back.flush(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
    this.front.flush(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
    return r
  }

  // true si la grilla nueva difiere en más pixels de los que puede cambiar un tiro (partida nueva)
  bigChange(t: Terrain): boolean {
    const pf = this.prevFront
    if (!pf || pf.length !== t.front.length) return false
    const f = t.front
    let n = 0
    for (let i = 0; i < f.length; i += 3) if (f[i] !== pf[i] && ++n > 8000) return true
    return false
  }

  private diff(t: Terrain): Rect | null {
    const pf = this.prevFront
    const pb = this.prevBack
    let rect: Rect | null = null
    if (!pf || !pb || pf.length !== t.front.length) {
      rect = { x0: 0, y0: 0, x1: t.w, y1: t.h }
    } else {
      let x0 = t.w
      let y0 = t.h
      let x1 = -1
      let y1 = -1
      const f = t.front
      const b = t.back
      for (let i = 0; i < f.length; i++) {
        if (f[i] !== pf[i] || b[i] !== pb[i]) {
          const y = (i / t.w) | 0
          const x = i - y * t.w
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
      if (x1 >= 0) rect = { x0, y0, x1: x1 + 1, y1: y1 + 1 }
    }
    this.prevFront = t.front.slice()
    this.prevBack = t.back.slice()
    return rect
  }

  private paint(t: Terrain, art: Art, pal: BiomePalette, r: Rect): void {
    const W = t.w
    const H = t.h
    const front = t.front
    const back = t.back
    const F = (x: number, y: number): number => (x >= 0 && y >= 0 && x < W && y < H ? front[y * W + x] : AIR)
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H
    const hole = (x: number, y: number): boolean => inside(x, y) && front[y * W + x] === AIR && back[y * W + x] !== AIR

    const materials = art.materials
    const matColor = (m: number, x: number, y: number): number => {
      const tx = materials[m]
      if (tx) {
        const i = ((y % tx.height) * tx.width + (x % tx.width)) * 4
        const d = tx.data
        return (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
      }
      const base = MATERIAL_FLAT[m] ?? 0x808080
      return mix(base, 0x000000, rnd(x >> 1, y >> 1, 31) * 0.18)
    }

    const rim = pal.rim
    const def = rim === DEFAULT_RIM
    const rimA = rim
    const rimB = def ? 0x3a2c21 : mul(rim, 0.82)
    const rimC = def ? 0x2e2118 : mul(rim, 0.66)
    const rimLight = def ? 0x4e3b2a : mix(rim, 0xffffff, 0.08)
    const grass = pal.grass
    const gRoot = grass[0]
    const gMid = grass[Math.min(1, grass.length - 1)]
    const gTip = grass[grass.length - 1]

    const craters = this.craters.filter((c) => c.x + c.r + 12 >= r.x0 && c.x - c.r - 12 < r.x1 && c.y + c.r + 12 >= r.y0 && c.y - c.r - 12 < r.y1)

    const bd = this.back.data
    const fd = this.front.data
    const set = (d: Uint8ClampedArray, x: number, y: number, c: number): void => {
      const i = (y * W + x) * 4
      d[i] = (c >> 16) & 255
      d[i + 1] = (c >> 8) & 255
      d[i + 2] = c & 255
      d[i + 3] = 255
    }

    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = y * W + x
        const pi = i * 4
        bd[pi + 3] = 0
        fd[pi + 3] = 0
        const m = front[i]
        if (m === AIR) {
          const bm = back[i]
          if (bm === AIR) continue
          let c = mix(mul(matColor(bm, x, y), 0.3), 0x0e0806, 0.3)
          let occ = 0
          for (let k = 1; k <= 6; k++) {
            if (F(x, y - k) !== AIR) {
              occ = 1 - k / 7
              break
            }
          }
          for (let k = 1; k <= 3; k++) {
            if (F(x - k, y) !== AIR || F(x + k, y) !== AIR) {
              occ = Math.max(occ, (1 - k / 4) * 0.6)
              break
            }
          }
          c = mix(c, 0x080504, occ * 0.7)
          for (const cr of craters) {
            const d = Math.hypot(x - cr.x, y - cr.y)
            if (d < cr.r + 2) c = mix(c, 0x0a0605, 0.35 + 0.35 * (1 - d / cr.r))
          }
          set(bd, x, y, c)
          continue
        }

        let c = matColor(m, x, y)
        const up = F(x, y - 1) === AIR
        const down = F(x, y + 1) === AIR
        const left = F(x - 1, y) === AIR
        const right = F(x + 1, y) === AIR
        if (WOODISH.has(m) && (up || down || left || right)) {
          c = OUT
        } else if (m === DIRT) {
          if (up) c = rnd(x, y, 3) > 0.5 ? rimA : rimB
          else if (F(x, y - 2) === AIR) c = rimC
          else if (down) c = 0x100a07
          else if (left || right) c = mul(c, 0.7)
        } else {
          if (down) c = mul(c, 0.5)
          else if (left || right) c = mul(c, 0.72)
        }
        for (const cr of craters) {
          const d = Math.hypot(x - cr.x, y - cr.y)
          if (d < cr.r + 6) {
            const k = 1 - (d - cr.r) / 6
            if (k > bayer(x, y) * 0.9) c = mix(c, 0x0c0706, Math.min(0.6, 0.2 + k * 0.45))
          }
        }
        if (!up && (hole(x, y - 1) || hole(x - 1, y) || hole(x + 1, y))) c = m === DIRT ? rimLight : mix(c, 0xb0a68c, 0.35)
        else if (hole(x, y + 1)) c = 0x0a0605
        set(fd, x, y, c)
      }
    }

    // pasto, musgo y raíces: las fuentes pueden estar hasta 4 px fuera del rectángulo
    const put = (x: number, y: number, c: number): void => {
      if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) set(fd, x, y, c)
    }
    for (let x = r.x0; x < r.x1; x++) {
      for (let y = Math.max(1, r.y0 - 4); y < Math.min(H, r.y1 + 4); y++) {
        const m = front[y * W + x]
        if (m === AIR) continue
        if (front[(y - 1) * W + x] === AIR && (m === DIRT || m === STONE)) {
          let near = false
          for (const c of craters) {
            if (Math.hypot(x - c.x, y - c.y) < c.r + 10) {
              near = true
              break
            }
          }
          if (!near) {
            const rr = rnd(x, y, 81)
            if (rr > 0.55) {
              const h = 1 + Math.floor(rnd(x, y, 82) * (m === STONE ? 2 : 4))
              for (let k = 1; k <= h; k++) put(x, y - k, k === h ? gTip : k === 1 ? gRoot : gMid)
            }
            if (m === STONE && rr > 0.8) put(x, y, pal.moss)
          }
        }
        if (m === DIRT && y + 1 < H && front[(y + 1) * W + x] === AIR && back[(y + 1) * W + x] !== AIR && rnd(x, y, 83) > 0.8) {
          const h = 1 + Math.floor(rnd(x, y, 84) * 4)
          for (let k = 1; k <= h; k++) put(x, y + k, k === h ? 0x1a110c : 0x2a1c13)
        }
      }
    }
  }
}
