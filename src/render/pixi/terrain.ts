// Terreno por pixel: misma lógica visual que paintTerrainBack/paintTerrainFront/paintTufts de look-test.mjs.
// Se pinta en dos capas (pared de fondo y frente) para que la utilería quede entre las dos.
// v2: el mundo puede medir hasta 2400 de ancho. Cada capa guarda los pixels del mundo entero en memoria,
// pero se sube a la GPU en trozos de CHUNK_W de ancho: solo se repinta y se sube el trozo que cambió, y
// los trozos fuera de la vista se pintan de a uno por frame (o cuando entran en la vista).
// v4: agua y lava (materiales líquidos de front) se pintan en una tercera capa, `liquid`, que va por encima de
// los tanques (el agua translúcida los tiñe); para el terreno cuentan como aire (bordes, oclusión, pozos), sin
// pasto debajo. Junto a la lava el terreno se cuece (más oscuro y rojizo) y no crece pasto. Ver liquids.ts.
import { AIR, BEAM, DIRT, LAVA, POST, SLAT, STONE, WATER, WOOD } from '../../sim/types'
import type { Terrain } from '../../sim/types'
import { PitMap, vnoise } from './abyss'
import type { Art, BiomePalette } from './assets'
import { MATERIAL_FLAT, OUT } from './fallback'
import { LIQ, W_ALPHA, W_LIGHT, W_LIGHT_ALPHA, W_SURF, baked, lavaBody, waterBody } from './liquids'
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
const LB = 8 // lado de los bloques del mapa de lava (para buscar lava cerca sin recorrer la grilla)
const BAKE = 10 // alcance del terreno cocido
const LAVA_MARGIN = 48 // repintado extra alrededor de la lava al terminar un flujo (pasto)
const BAKE_MARGIN = BAKE + 2 // repintado extra alrededor de la lava que cambió, durante el flujo (cocido)
const FRESH_MAX = 96 // celdas de frente de flujo que se juntan por cambio (espuma, chispas)
const LIQ_QUIET = 6 // frames sin cambios que cierran un flujo (repintado final de lo que tocó: pasto)

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

// v4: pixel del cuerpo del líquido m a d filas bajo su superficie (agua translúcida, lava opaca).
const A_LIGHT = Math.round(W_LIGHT_ALPHA * 255)
const A_BODY = Math.round(W_ALPHA * 255)
function liquidPixel(d: Uint8ClampedArray, o: number, m: number, x: number, y: number, depth: number, fog: number): void {
  let c: number
  let a = 255
  if (m === WATER) {
    if (depth === 0) c = W_SURF
    else if (depth === 1) {
      c = W_LIGHT
      a = A_LIGHT
    } else {
      c = waterBody(x, y, depth, fog)
      a = A_BODY
    }
  } else c = lavaBody(x, depth)
  d[o] = (c >> 16) & 255
  d[o + 1] = (c >> 8) & 255
  d[o + 2] = c & 255
  d[o + 3] = a
}

export class TerrainPainter {
  readonly back: ChunkLayer
  readonly front: ChunkLayer
  readonly liquid: ChunkLayer // v4: cuerpo del agua y la lava (encima de los tanques)
  // v4, por trozo: si tiene líquido (su capa liquid se muestra y se sube), si su capa liquid cambió en el
  // último update y las celdas de superficie (índices de la grilla, por fila) para la animación
  readonly liqChunk: Uint8Array
  readonly liqFlushed: Uint8Array
  readonly bfFlushed: Uint8Array // capas back y front cambiadas en el último update (por trozo)
  readonly surfaces: (Int32Array | null)[]
  surfStamp = 0 // sube cada vez que cambian las superficies de algún trozo
  // v4: celdas que se volvieron líquido en el último cambio de la grilla (x, y, material): frente del flujo
  readonly fresh: number[] = []
  private lavaB: Uint8Array | null = null // bloques de LB×LB con lava (null = el mapa no tiene lava)
  private lbW: number
  private lbH: number
  private liqUnion: Rect | null = null // lo que cambió de líquido en el flujo en curso
  private liqQuiet = 0
  craters: Crater[] = []
  // v3: columnas de abismo (peso, labio, pared de fondo); vacío en mapas sin abismos (Chico queda igual)
  readonly pits = new PitMap()
  fog = 0xf0dfc8 // color de la niebla del bioma (la pone el renderer): flota sobre la boca de los abismos
  private prevFront: Uint8Array | null = null
  private prevBack: Uint8Array | null = null
  private pending: (Rect | null)[] // por trozo, ya con el margen de los bordes
  // v4, por trozo: solo el cuerpo del líquido (agua que corre sin tocar el terreno: no cambian back ni front)
  private pendingLiq: (Rect | null)[]
  private changed: number[] = []

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.back = new ChunkLayer(w, h)
    this.front = new ChunkLayer(w, h)
    this.liquid = new ChunkLayer(w, h)
    this.pending = this.back.chunks.map(() => null)
    this.pendingLiq = this.back.chunks.map(() => null)
    const n = this.pending.length
    this.liqChunk = new Uint8Array(n)
    this.liqFlushed = new Uint8Array(n)
    this.bfFlushed = new Uint8Array(n)
    this.surfaces = new Array<Int32Array | null>(n).fill(null)
    this.lbW = Math.ceil(w / LB)
    this.lbH = Math.ceil(h / LB)
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
    this.pendingLiq.fill(null)
    this.liqChunk.fill(0)
    this.surfaces.fill(null)
    this.surfStamp++
    this.lavaB = null
    this.liqUnion = null
    this.fresh.length = 0
  }

  // Celdas de superficie de lava de todos los trozos (resplandor de los pozos).
  lavaSurfaces(t: Terrain): Int32Array[] {
    const out: Int32Array[] = []
    if (!this.lavaB) return out
    for (const s of this.surfaces) {
      if (!s) continue
      let n = 0
      for (let k = 0; k < s.length; k++) if (t.front[s[k]] === LAVA) n++
      if (n === 0) continue
      const a = new Int32Array(n)
      n = 0
      for (let k = 0; k < s.length; k++) if (t.front[s[k]] === LAVA) a[n++] = s[k]
      out.push(a)
    }
    return out
  }

  addCrater(x: number, y: number, r: number): void {
    this.craters.push({ x: Math.round(x), y: Math.round(y), r })
    if (this.craters.length > MAX_CRATERS) this.craters.shift()
    const m = r + 12
    this.markDirty({ x0: Math.floor(x - m), y0: Math.floor(y - m), x1: Math.ceil(x + m), y1: Math.ceil(y + m) })
  }

  // Marca para repintar (con 8 px de margen: bordes, oclusión y pasto dependen de los vecinos), repartido por trozo.
  markDirty(p: Rect): void {
    this.mark(this.pending, p, 8)
  }

  // v4: marca para repintar solo el cuerpo del líquido (1 px de margen).
  private markLiquid(p: Rect): void {
    this.mark(this.pendingLiq, p, 1)
  }

  private mark(pending: (Rect | null)[], p: Rect, M: number): void {
    const r: Rect = {
      x0: Math.max(0, p.x0 - M),
      y0: Math.max(0, p.y0 - M),
      x1: Math.min(this.w, p.x1 + M),
      y1: Math.min(this.h, p.y1 + M),
    }
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return
    const i0 = Math.floor(r.x0 / CHUNK_W)
    const i1 = Math.min(pending.length - 1, Math.floor((r.x1 - 1) / CHUNK_W))
    for (let i = i0; i <= i1; i++) {
      const c = this.back.chunks[i]
      const q: Rect = { x0: Math.max(r.x0, c.x0), y0: r.y0, x1: Math.min(r.x1, c.x0 + c.w), y1: r.y1 }
      const p0 = pending[i]
      pending[i] = p0 ? { x0: Math.min(p0.x0, q.x0), y0: Math.min(p0.y0, q.y0), x1: Math.max(p0.x1, q.x1), y1: Math.max(p0.y1, q.y1) } : q
    }
  }

  // Repinta lo pendiente de los trozos que tocan [viewX0, viewX1) y, como mucho, de un trozo más fuera de la vista.
  // Devuelve los índices de los trozos repintados (para subir sus texturas).
  // focus (v4): mientras corre un flujo, el rectángulo que tocan sus parches (el diff mira solo ahí).
  update(terrain: Terrain, art: Art, pal: BiomePalette, changed: boolean, viewX0 = 0, viewX1 = Infinity, focus: Rect | null = null): number[] {
    if (this.pits.sync(terrain)) this.markDirty({ x0: 0, y0: 0, x1: this.w, y1: this.h })
    this.fresh.length = 0
    this.liqFlushed.fill(0)
    this.bfFlushed.fill(0)
    if (changed) {
      const d = this.diff(terrain, focus)
      if (d) {
        if (d.solid) this.markDirty(d.solid)
        const q = d.liq
        if (q) {
          // agua que corre: solo el cuerpo, hasta el fondo (el color depende de la profundidad); la lava cuece el
          // terreno vecino (repintado completo cerca) y al terminar el flujo se repinta más ancho (pasto)
          // (y el pasto, que no crece bajo el agua, se pone al día al terminar)
          this.markLiquid({ x0: q.x0, y0: q.y0, x1: q.x1, y1: this.h })
          if (d.lava) this.markDirty({ x0: q.x0 - BAKE_MARGIN, y0: q.y0 - BAKE_MARGIN, x1: q.x1 + BAKE_MARGIN, y1: q.y1 + BAKE_MARGIN })
          const u = this.liqUnion
          const m = d.lava ? LAVA_MARGIN : 0
          this.liqUnion = u
            ? { x0: Math.min(u.x0, q.x0 - m), y0: Math.min(u.y0, q.y0 - m), x1: Math.max(u.x1, q.x1 + m), y1: Math.max(u.y1, q.y1 + m) }
            : { x0: q.x0 - m, y0: q.y0 - m, x1: q.x1 + m, y1: q.y1 + m }
          this.liqQuiet = 0
        }
      }
    } else if (this.liqUnion && ++this.liqQuiet >= LIQ_QUIET) {
      this.markDirty(this.liqUnion)
      this.liqUnion = null
    }
    const out = this.changed
    out.length = 0
    let spare = 1
    for (let i = 0; i < this.pending.length; i++) {
      const r = this.pending[i]
      const rl = this.pendingLiq[i]
      if (!r && !rl) continue
      const c = this.back.chunks[i]
      const visible = c.x0 + c.w > viewX0 && c.x0 < viewX1
      if (!visible) {
        if (spare <= 0) continue
        spare--
      }
      this.pending[i] = null
      this.pendingLiq[i] = null
      const had = this.liqChunk[i]
      let liq: Rect | null = null
      if (r) {
        const found = this.paint(terrain, art, pal, r)
        if (found) this.liqChunk[i] = 1
        else if (had && r.x0 <= c.x0 && r.x1 >= c.x0 + c.w && r.y0 === 0 && r.y1 === this.h) this.liqChunk[i] = 0
        this.back.flush(i, r)
        this.front.flush(i, r)
        this.bfFlushed[i] = 1
        if (had || this.liqChunk[i]) liq = r
      }
      if (rl) {
        if (this.paintLiquid(terrain, rl)) this.liqChunk[i] = 1
        liq = liq ? { x0: Math.min(liq.x0, rl.x0), y0: Math.min(liq.y0, rl.y0), x1: Math.max(liq.x1, rl.x1), y1: Math.max(liq.y1, rl.y1) } : rl
      }
      if (liq && (had || this.liqChunk[i])) {
        this.liquid.flush(i, liq)
        this.liqFlushed[i] = 1
        this.surfaces[i] = this.liqChunk[i] ? this.rescan(terrain, this.surfaces[i], c, liq) : null
        this.surfStamp++
      }
      out.push(i)
    }
    return out
  }

  // Celdas de superficie de líquido (sin el mismo líquido arriba) del trozo c, por fila: se conservan las de
  // fuera del rectángulo (y de la fila de abajo, que depende de la última) y se vuelven a buscar las de adentro.
  private rescan(t: Terrain, old: Int32Array | null, c: Chunk, r: Rect): Int32Array | null {
    const W = t.w
    const f = t.front
    const x0 = Math.max(c.x0, r.x0)
    const x1 = Math.min(c.x0 + c.w, r.x1)
    const y0 = r.y0
    const y1 = Math.min(t.h, r.y1 + 1)
    const tmp: number[] = []
    if (old) {
      for (let k = 0; k < old.length; k++) {
        const idx = old[k]
        const y = (idx / W) | 0
        const x = idx - y * W
        if (y >= y0 && y < y1 && x >= x0 && x < x1) continue
        tmp.push(idx)
      }
    }
    for (let y = y0; y < y1; y++) {
      const row = y * W
      for (let x = x0; x < x1; x++) {
        const m = f[row + x]
        if (LIQ[m] && (y === 0 || f[row - W + x] !== m)) tmp.push(row + x)
      }
    }
    if (!tmp.length) return null
    const a = Int32Array.from(tmp)
    a.sort()
    return a
  }

  // ¿Hay lava en el rectángulo? (por bloques; lavaB null = no hay lava en el mapa)
  private lavaIn(x0: number, y0: number, x1: number, y1: number): boolean {
    const B = this.lavaB
    if (!B) return false
    const bx0 = Math.max(0, Math.floor(x0 / LB))
    const by0 = Math.max(0, Math.floor(y0 / LB))
    const bx1 = Math.min(this.lbW - 1, Math.floor(x1 / LB))
    const by1 = Math.min(this.lbH - 1, Math.floor(y1 / LB))
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) if (B[by * this.lbW + bx]) return true
    return false
  }

  // Recalcula los bloques de lava que tocan el rectángulo (todo el mapa la primera vez).
  private updateLava(t: Terrain, r: Rect): void {
    if (!this.lavaB) this.lavaB = new Uint8Array(this.lbW * this.lbH)
    const B = this.lavaB
    const W = t.w
    const bx0 = Math.max(0, Math.floor(r.x0 / LB))
    const by0 = Math.max(0, Math.floor(r.y0 / LB))
    const bx1 = Math.min(this.lbW - 1, Math.floor((r.x1 - 1) / LB))
    const by1 = Math.min(this.lbH - 1, Math.floor((r.y1 - 1) / LB))
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        let any = 0
        for (let y = by * LB; y < Math.min(t.h, by * LB + LB) && !any; y++) {
          for (let x = bx * LB; x < Math.min(W, bx * LB + LB); x++) {
            if (t.front[y * W + x] === LAVA) {
              any = 1
              break
            }
          }
        }
        B[by * this.lbW + bx] = any
      }
    }
  }

  // Rectángulo que cambió desde el último diff; v4: también el de las celdas de líquido que cambiaron, si
  // alguna era o es lava, y el frente del flujo (fresh). Con focus (un flujo en curso) solo mira ese rectángulo:
  // lo de afuera queda para el próximo diff completo. Si no, compara de a 4 bytes.
  private diff(t: Terrain, focus: Rect | null): { solid: Rect | null; liq: Rect | null; lava: boolean } | null {
    const pf = this.prevFront
    const pb = this.prevBack
    const f = t.front
    const b = t.back
    const W = t.w
    if (!pf || !pb || pf.length !== f.length) {
      this.prevFront = f.slice()
      this.prevBack = b.slice()
      // primera vez: ¿hay lava en el mapa?
      this.lavaB = null
      for (let i = 0; i < f.length; i++) {
        if (f[i] === LAVA) {
          this.updateLava(t, { x0: 0, y0: 0, x1: t.w, y1: t.h })
          break
        }
      }
      return { solid: { x0: 0, y0: 0, x1: t.w, y1: t.h }, liq: null, lava: false }
    }
    let x0 = t.w
    let y0 = t.h
    let x1 = -1
    let y1 = -1
    let lx0 = t.w
    let ly0 = t.h
    let lx1 = -1
    let ly1 = -1
    let lava = false
    const fresh = this.fresh
    const cell = (k: number): void => {
      const nf = f[k]
      const of = pf[k]
      if (nf === of && b[k] === pb[k]) return
      const y = (k / W) | 0
      const x = k - y * W
      // agua que reemplaza aire o al revés, con la misma pared de fondo: el terreno no cambia
      const wet = b[k] === pb[k] && (nf === AIR || nf === WATER) && (of === AIR || of === WATER)
      if (!wet) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      if (LIQ[nf] || LIQ[of]) {
        if (x < lx0) lx0 = x
        if (x > lx1) lx1 = x
        if (y < ly0) ly0 = y
        if (y > ly1) ly1 = y
        if (nf === LAVA || of === LAVA) lava = true
        // frente del flujo: celdas que recién se mojaron (una de cada cuatro, más o menos)
        if (LIQ[nf] && !LIQ[of] && fresh.length < FRESH_MAX * 3 && (fresh.length === 0 || ((x * 7 + y * 13) & 3) === 0)) fresh.push(x, y, nf)
      }
    }
    if (focus) {
      const fx0 = Math.max(0, focus.x0)
      const fx1 = Math.min(W, focus.x1)
      for (let y = Math.max(0, focus.y0); y < Math.min(t.h, focus.y1); y++) {
        const a = y * W + fx0
        const z = y * W + fx1
        for (let k = a; k < z; k++) if (f[k] !== pf[k] || b[k] !== pb[k]) cell(k)
        pf.set(f.subarray(a, z), a)
        pb.set(b.subarray(a, z), a)
      }
    } else {
      const n = f.length
      if ((f.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0 && (n & 3) === 0) {
        // Int32 y no Uint32: los valores entran como enteros chicos y la comparación es varias veces más rápida
        const f32 = new Int32Array(f.buffer, f.byteOffset, n >> 2)
        const b32 = new Int32Array(b.buffer, b.byteOffset, n >> 2)
        const pf32 = new Int32Array(pf.buffer, pf.byteOffset, n >> 2)
        const pb32 = new Int32Array(pb.buffer, pb.byteOffset, n >> 2)
        const m = n >> 2
        for (let w = 0; w < m; w++) {
          if (f32[w] === pf32[w] && b32[w] === pb32[w]) continue
          const k = w << 2
          cell(k)
          cell(k + 1)
          cell(k + 2)
          cell(k + 3)
        }
      } else {
        for (let k = 0; k < n; k++) if (f[k] !== pf[k] || b[k] !== pb[k]) cell(k)
      }
      pf.set(f)
      pb.set(b)
    }
    const liq = lx1 >= 0 ? { x0: lx0, y0: ly0, x1: lx1 + 1, y1: ly1 + 1 } : null
    const solid = x1 >= 0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null
    if (!solid && !liq) return null
    if (liq && lava) this.updateLava(t, liq)
    return { solid, liq, lava }
  }

  // v4: repinta solo la capa del líquido en el rectángulo. Devuelve si encontró líquido.
  private paintLiquid(t: Terrain, r: Rect): boolean {
    const W = t.w
    const front = t.front
    const ld = this.liquid.data
    const fog = this.fog
    const depth = this.depths(t, r)
    let found = false
    for (let y = r.y0; y < r.y1; y++) {
      let i = y * W + r.x0
      for (let x = r.x0; x < r.x1; x++, i++) {
        const m = front[i]
        if (!LIQ[m]) {
          ld[i * 4 + 3] = 0
          continue
        }
        found = true
        const di = x - r.x0
        const d = y === r.y0 ? depth[di] : front[i - W] === m ? depth[di] + 1 : 0
        depth[di] = d
        liquidPixel(ld, i * 4, m, x, y, d, fog)
      }
    }
    return found
  }

  // Filas del mismo líquido por encima de la primera fila del rectángulo, por columna.
  private depths(t: Terrain, r: Rect): Int16Array {
    const W = t.w
    const front = t.front
    const depth = new Int16Array(r.x1 - r.x0)
    for (let x = r.x0; x < r.x1; x++) {
      const m = front[r.y0 * W + x]
      if (!LIQ[m]) continue
      let d = 0
      for (let y = r.y0 - 1; y >= 0 && front[y * W + x] === m; y--) d++
      depth[x - r.x0] = d
    }
    return depth
  }

  // Pinta el rectángulo en las tres capas. Devuelve si encontró líquido.
  private paint(t: Terrain, art: Art, pal: BiomePalette, r: Rect): boolean {
    const W = t.w
    const H = t.h
    const front = t.front
    const back = t.back
    const F = (x: number, y: number): number => (x >= 0 && y >= 0 && x < W && y < H ? front[y * W + x] : AIR)
    // v4: los líquidos cuentan como aire para el terreno (sin líquidos es lo mismo que F(x, y) !== AIR)
    const S = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false
      const m = front[y * W + x]
      return m !== AIR && LIQ[m] === 0
    }
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H
    const hole = (x: number, y: number): boolean => inside(x, y) && !S(x, y) && back[y * W + x] !== AIR

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
    const ld = this.liquid.data
    const set = (d: Uint8ClampedArray, x: number, y: number, c: number, a = 255): void => {
      const i = (y * W + x) * 4
      d[i] = (c >> 16) & 255
      d[i + 1] = (c >> 8) & 255
      d[i + 2] = c & 255
      d[i + 3] = a
    }

    // v4: lava cerca del rectángulo (cocido y sin pasto) y profundidad del líquido por columna
    const lavaHere = this.lavaIn(r.x0 - 48, r.y0 - 48, r.x1 + 48, r.y1 + 48)
    const near = (x: number, y: number, dx: number, up: number, down: number): boolean => lavaHere && this.lavaIn(x - dx, y - up, x + dx, y + down)
    const depth = this.depths(t, r)
    let found = false

    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = y * W + x
        const pi = i * 4
        bd[pi + 3] = 0
        fd[pi + 3] = 0
        ld[pi + 3] = 0
        const m = front[i]
        const lk = LIQ[m]
        if (lk) {
          // cuerpo del líquido: d = filas del mismo líquido por encima
          found = true
          const di = x - r.x0
          const d = y === r.y0 ? depth[di] : front[i - W] === m ? depth[di] + 1 : 0
          depth[di] = d
          liquidPixel(ld, pi, m, x, y, d, fog)
        }
        if (m === AIR || lk) {
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
            if (S(x, y - k)) {
              occ = 1 - k / 7
              break
            }
          }
          for (let k = 1; k <= 3; k++) {
            if (S(x - k, y) || S(x + k, y)) {
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
        const up = !S(x, y - 1)
        const down = !S(x, y + 1)
        const left = !S(x - 1, y)
        const right = !S(x + 1, y)
        if (WOODISH.has(m) && (up || down || left || right)) {
          c = OUT
        } else if (m === DIRT) {
          if (up) c = rnd(x, y, 3) > 0.5 ? rimA : rimB
          else if (!S(x, y - 2)) c = rimC
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
        // v4: terreno cocido junto a la lava (lava arriba o a los costados, hasta BAKE px)
        if (near(x, y, BAKE, BAKE, 0)) {
          for (let k = 1; k <= BAKE; k++) {
            if (F(x, y - k) === LAVA || F(x - k, y) === LAVA || F(x + k, y) === LAVA) {
              c = baked(c, k)
              break
            }
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
        if (m === AIR || LIQ[m]) continue
        if (front[(y - 1) * W + x] === AIR && (m === DIRT || m === STONE)) {
          // sin pasto junto a cráteres ni cerca de la lava (v4)
          let burnt = near(x, y, 40, 30, 30)
          for (const c of craters) {
            if (burnt) break
            if (Math.hypot(x - c.x, y - c.y) < c.r + 10) burnt = true
          }
          if (!burnt) {
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
    return found
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
