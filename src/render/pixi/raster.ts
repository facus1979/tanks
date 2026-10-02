// Utilidades de color y un buffer RGBA para dibujar pixel perfecto (mismas reglas que look-test.mjs).

export const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
const c8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
export const pack = (r: number, g: number, b: number): number => (c8(r) << 16) | (c8(g) << 8) | c8(b)

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  return pack(ar + (((b >> 16) & 255) - ar) * t, ag + (((b >> 8) & 255) - ag) * t, ab + ((b & 255) - ab) * t)
}

export const mul = (c: number, k: number): number => pack(((c >> 16) & 255) * k, ((c >> 8) & 255) * k, (c & 255) * k)

export function hash(x: number, y: number, s = 0): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return (n ^ (n >>> 16)) >>> 0
}
export const rnd = (x: number, y: number, s = 0): number => hash(x, y, s) / 4294967296

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
export const bayer = (x: number, y: number): number => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16
const BAYER_F = BAYER.map((b) => (b + 0.5) / 16)

// (1 - dist/R)² × 10 indexado por dist², cacheado por radio (light()).
const FALLOFF = new Map<number, Float32Array>()
function falloff(R: number): Float32Array {
  let t = FALLOFF.get(R)
  if (!t) {
    const R2 = R * R
    t = new Float32Array(R2)
    for (let d2 = 0; d2 < R2; d2++) t[d2] = (1 - Math.sqrt(d2) / R) ** 2 * 10
    if (FALLOFF.size > 256) FALLOFF.clear()
    FALLOFF.set(R, t)
  }
  return t
}

// RNG propio del renderer: reproducible para que las capturas de QA sean estables.
export class Rng {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }
}

// Buffer RGBA con alfa directo. Se sube a un canvas y de ahí a una textura.
// v2: el buffer es una ventana sobre el mundo (setView): los métodos de dibujo reciben coordenadas de mundo
// y las pasan a pixels del buffer con X = (x - ox) · z. Con z = 1 y ox, oy múltiplos de 4 el resultado es el
// mismo pixel a pixel que dibujar en un buffer del tamaño del mundo (incluida la trama de Bayer).
export class Raster {
  readonly data: Uint8ClampedArray
  readonly image: ImageData
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  dirty = false
  ox = 0 // punto del mundo en el pixel (0, 0) del buffer
  oy = 0
  z = 1 // pixels de buffer por pixel de mundo

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = w
    this.canvas.height = h
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) throw new Error('Sin canvas 2D')
    this.ctx = ctx
    this.image = ctx.createImageData(w, h)
    this.data = this.image.data
  }

  clear(): void {
    this.data.fill(0)
    this.dirty = false
  }

  setView(ox: number, oy: number, z: number): void {
    this.ox = ox
    this.oy = oy
    this.z = z
  }

  // Rectángulo del mundo que cubre el buffer.
  get left(): number {
    return this.ox
  }
  get top(): number {
    return this.oy
  }
  get right(): number {
    return this.ox + this.w / this.z
  }
  get bottom(): number {
    return this.oy + this.h / this.z
  }

  flush(x = 0, y = 0, w = this.w, h = this.h): void {
    this.ctx.putImageData(this.image, 0, 0, x, y, w, h)
  }

  put(x: number, y: number, c: number, a = 1): void {
    x = Math.round((x - this.ox) * this.z)
    y = Math.round((y - this.oy) * this.z)
    this.putB(x, y, c, a)
  }

  // put() en pixels del buffer.
  private putB(x: number, y: number, c: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return
    this.dirty = true
    const d = this.data
    const i = (y * this.w + x) * 4
    const r = (c >> 16) & 255
    const g = (c >> 8) & 255
    const b = c & 255
    if (a >= 1) {
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      d[i + 3] = 255
      return
    }
    const da = d[i + 3] / 255
    const oa = a + da * (1 - a)
    const k = (da * (1 - a)) / oa
    d[i] = r * (a / oa) + d[i] * k
    d[i + 1] = g * (a / oa) + d[i + 1] * k
    d[i + 2] = b * (a / oa) + d[i + 2] * k
    d[i + 3] = oa * 255
  }

  // Disco en pixels enteros: el mismo criterio que disc() del look-test. colorAt recibe la distancia en pixels de mundo.
  disc(cx: number, cy: number, r: number, colorAt: (d: number) => number, a = 1, dither = 1): void {
    if (r <= 0) return
    const z = this.z
    cx = (cx - this.ox) * z
    cy = (cy - this.oy) * z
    r *= z
    const iz = 1 / z
    const y0 = Math.max(0, Math.floor(cy - r - 1))
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r + 1))
    const x0 = Math.max(0, Math.floor(cx - r - 1))
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r + 1))
    const r2 = r * r
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        const d2 = dx * dx + dy * dy
        if (d2 > r2) continue
        if (dither < 1 && bayer(x, y) > dither) continue
        this.putB(x, y, colorAt(Math.sqrt(d2) * iz), a)
      }
    }
  }

  // Disco opaco de un color o con la rampa de cluster() del look-test. Loop directo: es lo más caro de los efectos.
  // tintK > 0 mezcla cada pixel hacia tint (humo que se disuelve en la niebla).
  rampDisc(cx: number, cy: number, r: number, ramp: number[] | null, color: number, heat = 0, dither = 1, tint = 0, tintK = 0): void {
    if (r <= 0) return
    cx = (cx - this.ox) * this.z
    cy = (cy - this.oy) * this.z
    r *= this.z
    const W = this.w
    const y0 = Math.max(0, Math.floor(cy - r - 1))
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r + 1))
    const x0 = Math.max(0, Math.floor(cx - r - 1))
    const x1 = Math.min(W - 1, Math.ceil(cx + r + 1))
    if (x0 > x1 || y0 > y1) return
    const r2 = r * r
    const d = this.data
    const n = ramp ? ramp.length : 0
    const hx = cx - r * 0.35
    const hy = cy - r * 0.4
    const inv = 1 / (r * 1.45)
    let cr = (color >> 16) & 255
    let cg = (color >> 8) & 255
    let cb = color & 255
    const tr = (tint >> 16) & 255
    const tg = (tint >> 8) & 255
    const tb = tint & 255
    this.dirty = true
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy
      const dy2 = dy * dy
      const by = (y & 3) * 4
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        if (dx * dx + dy2 > r2) continue
        const b = (BAYER[by + (x & 3)] + 0.5) / 16
        if (dither < 1 && b > dither) continue
        if (ramp) {
          const lx = x - hx
          const ly = y - hy
          let t = Math.sqrt(lx * lx + ly * ly) * inv
          if (t > 1) t = 1
          let i = Math.floor((t * 0.62 + heat + (b - 0.5) * 0.22) * n)
          if (i < 0) i = 0
          else if (i >= n) i = n - 1
          const c = ramp[i]
          cr = (c >> 16) & 255
          cg = (c >> 8) & 255
          cb = c & 255
        }
        const k = (y * W + x) * 4
        if (tintK > 0) {
          d[k] = cr + (tr - cr) * tintK
          d[k + 1] = cg + (tg - cg) * tintK
          d[k + 2] = cb + (tb - cb) * tintK
        } else {
          d[k] = cr
          d[k + 1] = cg
          d[k + 2] = cb
        }
        d[k + 3] = 255
      }
    }
  }

  // Luz: suma el tinte con caída cuadrática cuantizada (light() del look-test).
  // Loop directo con la caída tabulada por distancia² (sin sqrt ni pow por pixel) y cada fila recortada
  // a su cuerda del círculo: era lo más caro del frame con varias luces grandes (explosiones, fuego).
  light(cx: number, cy: number, R: number, tint: number, k: number): void {
    if (k <= 0 || R <= 0) return
    cx = Math.round((cx - this.ox) * this.z)
    cy = Math.round((cy - this.oy) * this.z)
    R = Math.round(R * this.z)
    if (R <= 0) return
    const fall = falloff(R)
    const tr = ((tint >> 16) & 255) * k
    const tg = ((tint >> 8) & 255) * k
    const tb = (tint & 255) * k
    const d = this.data
    const W = this.w
    const R2 = R * R
    const yA = Math.max(0, cy - R)
    const yB = Math.min(this.h, cy + R)
    for (let y = yA; y < yB; y++) {
      const dy2 = (y - cy) * (y - cy)
      if (dy2 >= R2) continue
      const half = Math.ceil(Math.sqrt(R2 - dy2))
      const xA = Math.max(0, cx - half)
      const xB = Math.min(W, cx + half, cx + R)
      const by = (y & 3) * 4
      let i = (y * W + xA) * 4
      for (let x = xA; x < xB; x++, i += 4) {
        const dx = x - cx
        const d2 = dx * dx + dy2
        if (d2 >= R2) continue
        const f = Math.floor(fall[d2] + BAYER_F[by + (x & 3)]) / 10
        if (f <= 0) continue
        d[i] += tr * f
        d[i + 1] += tg * f
        d[i + 2] += tb * f
        d[i + 3] = 255
        this.dirty = true
      }
    }
  }
}

// Grilla de caracteres → canvas. '.' (o cualquier letra sin color) es transparente.
export function gridCanvas(rows: string[], pal: Record<string, number>): HTMLCanvasElement {
  const w = Math.max(...rows.map((r) => r.length))
  const c = document.createElement('canvas')
  c.width = w
  c.height = rows.length
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const img = ctx.createImageData(w, rows.length)
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]]
      if (col === undefined) continue
      const i = (y * w + x) * 4
      img.data[i] = (col >> 16) & 255
      img.data[i + 1] = (col >> 8) & 255
      img.data[i + 2] = col & 255
      img.data[i + 3] = 255
    }
  })
  ctx.putImageData(img, 0, 0)
  return c
}
