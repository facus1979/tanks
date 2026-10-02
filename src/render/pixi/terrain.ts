// Terreno por pixel: misma lógica visual que paintTerrainBack/paintTerrainFront/paintTufts de look-test.mjs.
// Se pinta en dos capas (pared de fondo y frente) para que la utilería quede entre las dos.
// v2: el mundo puede medir hasta 2400 de ancho. Cada capa guarda los pixels del mundo entero en memoria,
// pero se sube a la GPU en trozos de CHUNK_W de ancho: solo se repinta y se sube el trozo que cambió, y
// los trozos fuera de la vista se pintan de a uno por frame (o cuando entran en la vista).
import { AIR, BEAM, DIRT, POST, SLAT, STONE, WOOD } from '../../sim/types'
import type { Terrain } from '../../sim/types'
import { PitMap, vnoise } from './abyss'
import type { Art, BiomePalette } from './assets'
import { MATERIAL_FLAT, OUT } from './fallback'
import { bayer, mix, mul, rnd } from './raster'

export const CHUNK_W = 256

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

export interface Chunk {
  x0: number
  w: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

// Pixels RGBA del mundo entero, volcados a canvases de CHUNK_W de ancho (uno por trozo).
export class ChunkLayer {
  readonly data: Uint8ClampedArray
  private image: ImageData
  readonly chunks: Chunk[] = []

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.image = new ImageData(w, h)
    this.data = this.image.data
    for (let x0 = 0; x0 < w; x0 += CHUNK_W) {
      const cw = Math.min(CHUNK_W, w - x0)
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Sin canvas 2D')
      this.chunks.push({ x0, w: cw, canvas, ctx })
    }
  }

  // Copia el rectángulo (ya recortado a un solo trozo) al canvas de ese trozo.
  flush(i: number, r: Rect): void {
    const c = this.chunks[i]
    c.ctx.putImageData(this.image, -c.x0, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
  }
}

export class TerrainPainter {
  readonly back: ChunkLayer
  readonly front: ChunkLayer
  craters: Crater[] = []
  // v3: columnas de abismo (peso, labio, pared de fondo); vacío en mapas sin abismos (Chico queda igual)
  readonly pits = new PitMap()
  fog = 0xf0dfc8 // color de la niebla del bioma (la pone el renderer): flota sobre la boca de los abismos
  private prevFront: Uint8Array | null = null
  private prevBack: Uint8Array | null = null
  private pending: (Rect | null)[] // por trozo, ya con el margen de los bordes
  private changed: number[] = []

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.back = new ChunkLayer(w, h)
    this.front = new ChunkLayer(w, h)
    this.pending = this.back.chunks.map(() => null)
  }

  get chunkCount(): number {
    return this.pending.length
  }

  reset(): void {
    this.craters = []
    this.prevFront = null
    this.prevBack = null
    this.pits.reset()
    this.pending.fill(null)
  }

  addCrater(x: number, y: number, r: number): void {
    this.craters.push({ x: Math.round(x), y: Math.round(y), r })
    if (this.craters.length > MAX_CRATERS) this.craters.shift()
    const m = r + 12
    this.markDirty({ x0: Math.floor(x - m), y0: Math.floor(y - m), x1: Math.ceil(x + m), y1: Math.ceil(y + m) })
  }

  // Marca para repintar (con 8 px de margen: bordes, oclusión y pasto dependen de los vecinos), repartido por trozo.
  markDirty(p: Rect): void {
    const M = 8
    const r: Rect = {
      x0: Math.max(0, p.x0 - M),
      y0: Math.max(0, p.y0 - M),
      x1: Math.min(this.w, p.x1 + M),
      y1: Math.min(this.h, p.y1 + M),
    }
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return
    const i0 = Math.floor(r.x0 / CHUNK_W)
    const i1 = Math.min(this.pending.length - 1, Math.floor((r.x1 - 1) / CHUNK_W))
    for (let i = i0; i <= i1; i++) {
      const c = this.back.chunks[i]
      const q: Rect = { x0: Math.max(r.x0, c.x0), y0: r.y0, x1: Math.min(r.x1, c.x0 + c.w), y1: r.y1 }
      const p0 = this.pending[i]
      this.pending[i] = p0 ? { x0: Math.min(p0.x0, q.x0), y0: Math.min(p0.y0, q.y0), x1: Math.max(p0.x1, q.x1), y1: Math.max(p0.y1, q.y1) } : q
    }
  }

  // Repinta lo pendiente de los trozos que tocan [viewX0, viewX1) y, como mucho, de un trozo más fuera de la vista.
  // Devuelve los índices de los trozos repintados (para subir sus texturas).
  update(terrain: Terrain, art: Art, pal: BiomePalette, changed: boolean, viewX0 = 0, viewX1 = Infinity): number[] {
    if (this.pits.sync(terrain)) this.markDirty({ x0: 0, y0: 0, x1: this.w, y1: this.h })
    if (changed) {
      const diff = this.diff(terrain)
      if (diff) this.markDirty(diff)
    }
    const out = this.changed
    out.length = 0
    let spare = 1
    for (let i = 0; i < this.pending.length; i++) {
      const r = this.pending[i]
      if (!r) continue
      const c = this.back.chunks[i]
      const visible = c.x0 + c.w > viewX0 && c.x0 < viewX1
      if (!visible) {
        if (spare <= 0) continue
        spare--
      }
      this.pending[i] = null
      this.paint(terrain, art, pal, r)
      this.back.flush(i, r)
      this.front.flush(i, r)
      out.push(i)
    }
    return out
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

    // abismo: peso por columna (0 = normal), primera fila de la pared de fondo y niebla del bioma
    const pits = this.pits
    const pw = pits.weight
    const pTop = pits.top
    const pIn = pits.inPit
    const fog = this.fog
    const stoneTex = materials[STONE]

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
          let bm = back[i]
          // en el abismo la pared de fondo sigue hasta abajo aunque el generador no haya puesto back
          const deep = pw !== null && pIn![x] === 1 && y >= pTop![x]
          if (bm === AIR) {
            if (!deep) continue
            bm = DIRT
          }
          let c = mix(mul(matColor(bm, x, y), 0.3), 0x0e0806, 0.3)
          if (deep) {
            // rocas salientes en la pared del abismo: manchas de piedra con el canto de arriba claro
            const n = vnoise(x, y, 10, 7, 91)
            if (n > 0.8) {
              const sc = stoneTex ? matColor(STONE, x, y) : 0x6c6a64
              c = mix(mul(sc, n > 0.83 ? 0.34 : 0.26), 0x0e0806, 0.3)
              if (vnoise(x, y - 2, 10, 7, 91) <= 0.8) c = mix(c, 0xb0a68c, 0.16)
              else if (vnoise(x, y + 2, 10, 7, 91) <= 0.8) c = mul(c, 0.55)
            }
          }
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
          if (pw !== null && pw[x] > 0) c = pits.shade(c, x, y, H, fog, false)
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
        if (pw !== null && pw[x] > 0) c = pits.shade(c, x, y, H, fog, true)
        set(fd, x, y, c)
      }
    }

    // pasto, musgo y raíces: las fuentes pueden estar hasta 4 px fuera del rectángulo
    const put = (x: number, y: number, c: number): void => {
      if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) set(fd, x, y, pw !== null && pw[x] > 0 ? pits.shade(c, x, y, H, fog, true) : c)
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
    if (pw !== null) this.pitRoots(t, r, put)
  }

  // Raíces que cuelgan de las paredes de tierra hacia el abismo: arrancan en el canto de la pared,
  // bajan y se separan un poco de ella. Las fuentes pueden estar hasta 14 px fuera del rectángulo.
  private pitRoots(t: Terrain, r: Rect, put: (x: number, y: number, c: number) => void): void {
    const W = t.w
    const H = t.h
    const front = t.front
    const pIn = this.pits.inPit!
    const rim = this.pits.rim!
    for (let x = Math.max(1, r.x0 - 6); x < Math.min(W - 1, r.x1 + 6); x++) {
      for (const side of [-1, 1]) {
        const nx = x + side
        if (!pIn[nx]) continue
        const y0 = Math.max(0, rim[nx] - 30, r.y0 - 14)
        const y1 = Math.min(H - 1, rim[nx] + 90, r.y1)
        for (let y = y0; y < y1; y++) {
          if (front[y * W + x] !== DIRT || front[y * W + nx] !== AIR) continue
          if (rnd(x, y, 85) < 0.93) continue
          const len = 4 + Math.floor(rnd(x, y, 86) * 11)
          let rx = nx
          for (let k = 0; k < len; k++) {
            const yy = y + k
            if (yy >= H || front[yy * W + rx] !== AIR) break
            put(rx, yy, k >= len - 2 ? 0x1a110c : 0x2e1f15)
            if (k % 4 === 3 && rnd(x, y + k, 87) > 0.4) rx += side
          }
        }
      }
    }
  }
}
