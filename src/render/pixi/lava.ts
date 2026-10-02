// v2: lava de muerte súbita. Una banda que cubre todo el ancho del mundo desde la superficie (RenderFrame.lava)
// hasta el fondo, por delante del terreno y los tanques. Look del pozo de lava de scripts/lookdev/v2-bigmap.mjs
// (paintLiquids y su light naranja): superficie casi blanca-amarilla, degradé a naranja y rojo oscuro con trama
// Bayer, costras oscuras que flotan, burbujas y resplandor sobre lo que está cerca.
//
// Barata: solo se pinta por CPU una franja de STRIP_H filas alrededor de la superficie y del ancho visible
// (la parte animada: ondas, costras, burbujas, brillo), a 30 Hz y subida directo desde los bytes. Lo profundo
// es una textura repetida (TilingSprite) que fluye de costado sin costo, y el resplandor es otra textura
// repetida con suma aditiva.
//
// v4: las tablas (degradé, ruido, costras, olas) se exportan para la lava material (liquids.ts), que usa el
// mismo look.
import { BufferImageSource, Container, Sprite, Texture, TilingSprite } from 'pixi.js'
import type { Vec2 } from '../../sim/types'
import type { Fx } from './fx'
import { bayer, hash, mix, Raster, rgb, Rng } from './raster'

export const TOP = 10 // filas de la franja por encima de la superficie (burbujas, gotas, crestas de las olas)
export const DEPTH = 6 // filas de la franja por debajo (hasta donde llega la ola); más abajo sigue la textura profunda
export const NOISE_CAP = 30 // corrimiento máximo del ruido con la profundidad (de ahí para abajo solo ondula)
export const STRIP_H = TOP + DEPTH
const PAD = 16 // margen pintado a cada lado de la vista
const STRIP_W = 1700 // ancho visible con zoom 0,5 (1600) más el margen del sacudón y PAD
const PAINT_DT = 1 / 30
export const DEEP_W = 1024 // período horizontal del ruido (y de la textura profunda)
const DEEP_H = 128 // período vertical de la textura profunda
const GLOW_H = 72 // alto del resplandor sobre la superficie
const GLOW_K = 0.24 // intensidad del resplandor junto a la superficie (el light del lookdev usa 0,32 en un pozo)
export const GLOW_TINT = 0xff6a20
const FLOW = 3 // px/s que fluye lo profundo de costado
export const CRUST_V = 5 // px/s que derivan las costras (más el viento)
export const CRUST_CELL = 16

// Degradé de paintLiquids: 0 = superficie, 1 = rojo oscuro.
const STOPS: [number, number][] = [
  [0, 0xfff1a8],
  [0.12, 0xffb43e],
  [0.35, 0xf77a28],
  [0.7, 0xd24a1c],
  [1, 0x8a2814],
]
function gradient(t: number): number {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, a] = STOPS[i - 1]
      const [t1, b] = STOPS[i]
      return mix(a, b, (t - t0) / (t1 - t0))
    }
  }
  return STOPS[STOPS.length - 1][1]
}
// 9 niveles (el lookdev cuantiza a octavos con la trama).
export const LEVELS = Array.from({ length: 9 }, (_, i) => gradient(i / 8))
export const LR = new Uint8Array(LEVELS.map((c) => (c >> 16) & 255))
export const LG = new Uint8Array(LEVELS.map((c) => (c >> 8) & 255))
export const LB = new Uint8Array(LEVELS.map((c) => c & 255))
export const SURF = 0xfff1a8
export const SPARKLE = 0xffffff
export const CRUST = 0x3a1810
export const CRUST_TOP = 0x5a2a18
export const DEEP_DARK = 0x6a1e12
export const BUBBLE_EDGE = 0xffb43e

// Ruido de valor 1D periódico (DEEP_W) con celdas de 11 px como noise1(x, 11) del lookdev.
export const NOISE = (() => {
  const cells = Math.round(DEEP_W / 11)
  const n = new Float32Array(DEEP_W)
  const v = (i: number): number => hash(((i % cells) + cells) % cells, 0, 31) / 4294967296
  for (let x = 0; x < DEEP_W; x++) {
    const t = (x / DEEP_W) * cells
    const i = Math.floor(t)
    const f = t - i
    const u = f * f * (3 - 2 * f)
    n[x] = v(i) * (1 - u) + v(i + 1) * u
  }
  return n
})()

// Tablas para el loop de la franja: level() = floor(d · LV_D + NOISE8 + BAYER8), sin multiplicar por pixel.
export const LV_D = (0.8 / 46) * 8
export const NOISE8 = Float32Array.from(NOISE, (v) => v * 0.35 * 8)
export const BAYER8 = Float32Array.from({ length: 16 }, (_, i) => bayer(i & 3, i >> 2))
export const SPARK_T = 0.72 * 4294967296 // umbrales de hash() (sin dividir)
export const SUNK_T = 0.985 * 4294967296

// Nivel del degradé a profundidad d (px bajo la superficie) con el ruido n y la trama b.
export const level = (d: number, n: number, b: number): number => {
  const l = Math.floor(((d / 46) * 0.8 + n * 0.35) * 8 + b)
  return l < 1 ? 1 : l > 8 ? 8 : l
}

function canvasTexture(c: HTMLCanvasElement): Texture {
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  t.source.autoGenerateMipmaps = false
  return t
}

// Textura profunda: sigue el degradé desde la profundidad DEPTH (empalma con la franja) hasta el rojo oscuro;
// ya en el fondo, vetas más claras y más oscuras donde el ruido (que ondula en vertical con período DEEP_H,
// sin costura) es alto o bajo, y costras hundidas cerca de la superficie. Fila k = DEPTH + first + k px
// bajo la superficie: first 0 es el tramo de transición; first DEEP_H es el fondo, que se repite hacia abajo.
function deepTexture(first: number): Texture {
  const r = new Raster(DEEP_W, DEEP_H)
  const d = r.data
  for (let k = 0; k < DEEP_H; k++) {
    const kk = first + k
    const a = (2 * Math.PI * k) / DEEP_H
    const sway = Math.round(10 * Math.sin(a) + 5 * Math.sin(3 * a + 1))
    // el mismo corrimiento que la franja ((profundidad >> 1)) hasta NOISE_CAP; con sway(0) = 0 empalma arriba
    // y con el tope el fondo empalma con la transición (sway tiene período DEEP_H)
    const shift = Math.min((DEPTH + kk) >> 1, NOISE_CAP) + sway
    for (let x = 0; x < DEEP_W; x++) {
      const n = NOISE[(x + shift + DEEP_W) & (DEEP_W - 1)]
      const b = bayer(x, kk + DEPTH)
      const l = level(DEPTH + kk, n, b)
      let c = LEVELS[l]
      if (l === 8) {
        if (n > 0.7 && b < (n - 0.7) * 2) c = LEVELS[7]
        else if (n < 0.4 && b < (0.4 - n) * 2.5) c = DEEP_DARK
      }
      if (kk < 12 && hash(Math.floor(x / 5), (DEPTH + kk) >> 1, 44) > SUNK_T) c = CRUST
      const i = (k * DEEP_W + x) * 4
      d[i] = (c >> 16) & 255
      d[i + 1] = (c >> 8) & 255
      d[i + 2] = c & 255
      d[i + 3] = 255
    }
  }
  r.flush()
  const t = canvasTexture(r.canvas)
  t.source.addressMode = 'repeat'
  return t
}

// Resplandor: el light() del lookdev en una sola dimensión, (1 - u)² cuantizado a décimos con la trama,
// u = distancia a la superficie / GLOW_H. Fila de abajo = junto a la superficie. 4 px de ancho (la trama).
function glowTexture(): Texture {
  const r = new Raster(4, GLOW_H)
  const [tr, tg, tb] = rgb(GLOW_TINT)
  const d = r.data
  for (let y = 0; y < GLOW_H; y++) {
    const u = (GLOW_H - y) / GLOW_H
    for (let x = 0; x < 4; x++) {
      const f = Math.floor((1 - u) ** 2 * 10 + bayer(x, y)) / 10
      const i = (y * 4 + x) * 4
      d[i] = tr * f * GLOW_K
      d[i + 1] = tg * f * GLOW_K
      d[i + 2] = tb * f * GLOW_K
      d[i + 3] = 255
    }
  }
  r.flush()
  const t = canvasTexture(r.canvas)
  t.source.addressMode = 'repeat'
  return t
}

// Corrimiento por la ola según la fila de la franja y la ola de la columna (-3..3): completo en la superficie
// y por encima, y se apaga hasta DEPTH (donde empalma con la textura profunda). Índice ry · 7 + 3 + ola.
export const WAVE_SHIFT = (() => {
  const t = new Int8Array(STRIP_H * 7)
  for (let ry = 0; ry < STRIP_H; ry++) {
    const dd = ry - TOP
    const f = dd <= 0 ? 1 : Math.max(0, 1 - dd / DEPTH)
    for (let w = -3; w <= 3; w++) t[ry * 7 + 3 + w] = Math.round(w * f)
  }
  return t
})()

interface Bubble {
  x: number
  r: number
  age: number
  life: number
}

// Gotita de una burbuja que revienta: se dibuja en la franja (y relativa a la superficie) y no en el buffer
// de efectos, para que las burbujas de fondo no obliguen a subir ese buffer en cada frame.
interface Droplet {
  x: number
  y: number
  vx: number
  vy: number
}

// Onda que se abre desde x (proyectil derretido, burbuja, ola de la subida, tanque que se quema).
interface Ripple {
  x: number
  amp: number
  age: number
}

export class LavaView {
  readonly layer = new Container() // va encima de los tanques y debajo de luces y efectos
  readonly glowLayer = new Container() // aditiva, sobre terreno y tanques
  // la franja se sube directo desde los bytes (sin pasar por un canvas 2D): es lo que se actualiza en cada frame
  private strip = new Uint8Array(STRIP_W * STRIP_H * 4)
  private stripSrc = new BufferImageSource({ resource: this.strip, width: STRIP_W, height: STRIP_H, scaleMode: 'nearest', autoGenerateMipmaps: false })
  private stripSprite: Sprite
  private deep: TilingSprite // transición del degradé (DEEP_H filas, solo se repite a lo ancho)
  private bed: TilingSprite // fondo, se repite hacia abajo hasta el pie del mundo
  private glow: TilingSprite
  private rng = new Rng(4242)
  private time = 0
  private crustOff = 0
  private bubbles: Bubble[] = []
  private ripples: Ripple[] = []
  private droplets: Droplet[] = []
  private bubbleAcc = 0
  private sprayAcc = 0
  private surge = 0 // segundos de olas y salpicaduras tras un evento 'lava'
  private swell = 0 // amplitud extra de las olas
  private prevLava: number | null = null
  private prevShots: Vec2[] = []
  private wave = new Int8Array(STRIP_W) // corrimiento de la superficie por columna (-3..3)
  private crustCol = new Uint8Array(STRIP_W) // filas de costra flotante por columna
  private paintedXa = 0 // columnas del mundo pintadas en la franja y fila de su borde de arriba
  private paintedXb = 0
  private paintedTop = NaN
  private paintAge = 0
  level: number | null = null // superficie (y de mundo, entera) del último frame; null sin lava

  constructor() {
    this.stripSprite = new Sprite(new Texture({ source: this.stripSrc }))
    this.deep = new TilingSprite({ texture: deepTexture(0), width: 1, height: DEEP_H })
    this.bed = new TilingSprite({ texture: deepTexture(DEEP_H), width: 1, height: 1 })
    this.glow = new TilingSprite({ texture: glowTexture(), width: 1, height: GLOW_H })
    this.glow.blendMode = 'add'
    this.layer.addChild(this.bed, this.deep, this.stripSprite)
    this.glowLayer.addChild(this.glow)
    this.layer.visible = false
    this.glowLayer.visible = false
  }

  reset(): void {
    this.bubbles = []
    this.ripples = []
    this.droplets = []
    this.surge = 0
    this.swell = 0
    this.prevLava = null
    this.prevShots = []
    this.paintedTop = NaN
    this.level = null
    this.layer.visible = false
    this.glowLayer.visible = false
  }

  // Evento 'lava': la superficie sube. Olas a lo ancho de lo visible, salpicaduras y vapor.
  rise(fx: Fx, x0: number, x1: number, appeared: boolean): void {
    this.surge = appeared ? 1.6 : 1.2
    this.swell = 1
    const y = this.level
    if (y === null) return
    for (let x = x0 + this.rng.range(20, 80); x < x1; x += this.rng.range(70, 150)) {
      this.ripples.push({ x, amp: 1.6, age: 0 })
      fx.lavaSplash(x, y, 2 + Math.floor(this.rng.next() * 2), 80)
      fx.lavaSpray(x, y, 3, 80)
      fx.steam(x, y - 2, 2, 10)
    }
  }

  // Tanque quemado por la lava: chispas, llamitas y humo desde el tanque, y una onda donde toca la superficie.
  // Si el tanque quedó hundido, el efecto sale de la superficie, encima de él.
  burn(fx: Fx, x: number, y: number): void {
    const L = this.level
    fx.lavaBurn(x, L !== null ? Math.min(y, L + 4) : y)
    if (L !== null && y > L - 30) this.ripples.push({ x, amp: 1.5, age: 0 })
  }

  // Proyectiles derretidos: los que desaparecen de frame.projectiles cerca de la superficie sin un impacto
  // explosivo cerca (el sim no emite 'impact' cuando la lava se los traga).
  trackShots(fx: Fx, shots: Vec2[], impacts: Vec2[], worldW: number): void {
    const L = this.level
    if (L !== null) {
      for (const p of this.prevShots) {
        if (p.x < 0 || p.x > worldW || p.y < L - 26) continue
        if (shots.some((q) => Math.abs(q.x - p.x) < 40 && Math.abs(q.y - p.y) < 40)) continue
        if (impacts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 40)) continue
        this.melt(fx, p.x)
      }
    }
    this.prevShots = shots.map((p) => ({ x: p.x, y: p.y }))
  }

  private melt(fx: Fx, x: number): void {
    const y = this.level ?? 0
    fx.sizzle(x, y)
    this.ripples.push({ x, amp: 2.2, age: 0 })
  }

  // Avanza la animación (dt = 0 congelado) y pinta la parte visible. lava = superficie del frame;
  // x0..x1, y0..y1: rectángulo del mundo visible (con el sacudón).
  update(fx: Fx, lava: number | null, dt: number, wind: number, worldW: number, worldH: number, x0: number, x1: number, y0: number, y1: number): void {
    if (lava === null || !Number.isFinite(lava)) {
      if (this.level !== null) this.reset()
      return
    }
    const L = Math.round(lava)
    const prev = this.prevLava
    this.prevLava = lava
    this.level = L
    this.layer.visible = true
    this.glowLayer.visible = true

    const xa = Math.max(0, Math.floor(x0) - 2)
    const xb = Math.min(worldW, Math.ceil(x1) + 2, xa + STRIP_W)
    const deepTop = L + DEPTH
    const bottom = Math.max(worldH, Math.ceil(y1)) + 8

    if (dt > 0) this.step(fx, dt, wind, L, xa, xb, prev !== null && lava < prev - 0.01)

    // resplandor: sobre la superficie, del ancho visible, con un parpadeo leve
    this.glow.visible = L - GLOW_H < y1 && L > y0
    this.glow.position.set(xa, L - GLOW_H)
    this.glow.width = Math.max(1, xb - xa)
    this.glow.tilePosition.set(-xa, 0)
    this.glow.alpha = 0.9 + 0.06 * Math.sin(this.time * 2.3) + 0.04 * Math.sin(this.time * 7.1)

    // profundo: fluye de costado, anclado a la superficie (empalma con la franja)
    const flow = Math.floor(this.time * FLOW)
    this.deep.visible = deepTop < y1 && deepTop + DEEP_H > y0 && xb > xa
    this.deep.position.set(xa, deepTop)
    this.deep.width = Math.max(1, xb - xa)
    this.deep.tilePosition.set(-xa + flow, 0)
    const bedTop = deepTop + DEEP_H
    this.bed.visible = bedTop < y1 && bottom > bedTop && xb > xa
    this.bed.position.set(xa, bedTop)
    this.bed.width = Math.max(1, xb - xa)
    this.bed.height = Math.max(1, bottom - bedTop)
    this.bed.tilePosition.set(-xa + flow, 0)

    // franja animada
    const top = L - TOP
    const vis = top < y1 && deepTop > y0 && xb > xa
    this.stripSprite.visible = vis
    if (!vis) {
      this.paintedTop = NaN
      return
    }
    // A 30 Hz alcanza para ondas de 1-2 px y ahorra la mitad del CPU. Se pinta con PAD px de margen a los
    // costados, así un paneo chico no obliga a repintar; sí se repinta si la vista se sale de lo pintado o
    // si la superficie cambió de fila.
    this.paintAge += dt
    const out = xa < this.paintedXa || xb > this.paintedXb || top !== this.paintedTop
    if (out || this.paintAge >= PAINT_DT) {
      const pa = Math.max(0, xa - PAD)
      const pb = Math.min(worldW, xb + PAD, pa + STRIP_W)
      this.paint(pa, pb, flow)
      this.paintedXa = pa
      this.paintedXb = pb
      this.paintedTop = top
      this.paintAge = 0
    }
    this.stripSprite.position.set(this.paintedXa, top)
  }

  private step(fx: Fx, dt: number, wind: number, L: number, xa: number, xb: number, rising: boolean): void {
    this.time += dt
    this.crustOff += (CRUST_V + wind * 0.6) * dt
    this.surge = Math.max(0, this.surge - dt)
    this.swell = Math.max(0, this.swell - dt * 0.7)
    for (const r of this.ripples) r.age += dt
    this.ripples = this.ripples.filter((r) => r.age < 2.2)
    if (this.ripples.length > 24) this.ripples.splice(0, this.ripples.length - 24)
    const width = xb - xa
    if (width <= 0) return

    // burbujas: unas 3 por segundo cada 800 px visibles; crecen y revientan en 1-3 gotitas
    this.bubbleAcc += dt * 3 * (width / 800)
    while (this.bubbleAcc >= 1) {
      this.bubbleAcc -= 1
      if (this.bubbles.length < 20) this.bubbles.push({ x: Math.round(xa + this.rng.next() * width), r: 1.2 + this.rng.next() * 1.6, age: 0, life: 0.5 + this.rng.next() * 0.9 })
    }
    for (const b of this.bubbles) {
      b.age += dt
      if (b.age >= b.life) {
        const n = b.r > 2 ? 3 : 1
        for (let i = 0; i < n && this.droplets.length < 40; i++) {
          this.droplets.push({ x: b.x + (this.rng.next() - 0.5) * 2, y: -1, vx: (this.rng.next() - 0.5) * 30, vy: -30 - this.rng.next() * 35 })
        }
        if (b.r > 2) this.ripples.push({ x: b.x, amp: 0.8, age: 0 })
      }
    }
    this.bubbles = this.bubbles.filter((b) => b.age < b.life)
    for (const g of this.droplets) {
      g.vy += 300 * dt
      g.x += g.vx * dt
      g.y += g.vy * dt
    }
    this.droplets = this.droplets.filter((g) => g.y < 0 || g.vy < 0)

    // mientras sube (o justo después del evento): salpicaduras y vapor a lo ancho de lo visible
    if (rising || this.surge > 0) {
      this.sprayAcc += dt * 14 * (width / 800)
      while (this.sprayAcc >= 1) {
        this.sprayAcc -= 1
        const x = xa + this.rng.next() * width
        const k = this.rng.next()
        if (k < 0.35) fx.lavaSplash(x, L, 1, 60)
        else if (k < 0.7) fx.lavaSpray(x, L, 2, 60)
        else fx.steam(x, L - 2, 1, 8)
      }
    } else this.sprayAcc = 0
  }

  // Pinta la franja entera para las columnas xa..xb del mundo.
  private paint(xa: number, xb: number, flow: number): void {
    const d = this.strip
    d.fill(0)
    const W = STRIP_W
    const n = xb - xa
    const t = this.time
    const wave = this.wave
    const swell = this.swell
    // corrimiento de la superficie por columna: dos senos lentos (1-2 px), la ola de la subida y las ondas
    for (let i = 0; i < n; i++) {
      const x = xa + i
      let w = Math.sin(x * 0.11 + t * 2.4) * 0.8 + Math.sin(x * 0.043 - t * 1.7) * 0.7
      if (swell > 0) w += swell * 1.8 * Math.sin(x * 0.07 - t * 7)
      for (const r of this.ripples) {
        const dx = Math.abs(x - r.x)
        const front = r.age * 45
        if (dx > front + 6) continue
        w += r.amp * Math.exp(-r.age * 1.8 - dx / 70) * Math.sin((dx - front) * 0.45)
      }
      wave[i] = Math.max(-3, Math.min(3, Math.round(w)))
    }
    // por columna: costra flotante (filas bajo la superficie, 0 = no hay) en celdas que derivan con el viento
    const crustOff = Math.floor(this.crustOff)
    const crustCol = this.crustCol
    for (let i = 0; i < n; i++) {
      const cx = xa + i - crustOff
      const cell = Math.floor(cx / CRUST_CELL)
      const ch = hash(cell, 0, 77)
      let crust = 0
      if (ch / 4294967296 > 0.7) {
        const u = cx - cell * CRUST_CELL
        const a = 1 + ((ch >>> 8) & 3)
        const b = CRUST_CELL - 1 - ((ch >>> 12) & 3)
        if (u >= a && u < b) crust = u === a || u === b - 1 ? 1 : 2 + ((ch >>> 16) & 1)
      }
      crustCol[i] = crust
    }
    const sparkOff = Math.floor(t * 6)
    const lo = TOP - 3 // más arriba de la cresta máxima solo hay burbujas y gotas
    const hi = STRIP_H
    const cr = (CRUST >> 16) & 255
    const cg = (CRUST >> 8) & 255
    const cb = CRUST & 255
    // fila a fila (recorrido contiguo del buffer); la ola corre la profundidad según WAVE_SHIFT
    for (let ry = lo; ry < hi; ry++) {
      const dd = ry - TOP // profundidad sin ola
      const shiftRow = ry * 7 + 3
      const by = (dd & 3) * 4
      const sunken = dd > 4
      let o = ry * W * 4
      for (let i = 0; i < n; i++, o += 4) {
        const dep = dd - WAVE_SHIFT[shiftRow + wave[i]]
        if (dep < 0) continue
        const x = xa + i
        let c: number
        if (dep < crustCol[i]) c = dep === 0 ? CRUST_TOP : CRUST
        else if (dep === 0) c = hash(x - sparkOff, 0, 3) > SPARK_T ? SPARKLE : SURF
        else {
          const xf = x - flow
          // costras hundidas: astillas de 5 px que fluyen con lo profundo (siguen en deepTexture)
          if (sunken && hash(Math.floor(xf / 5), dd >> 1, 44) > SUNK_T) {
            d[o] = cr
            d[o + 1] = cg
            d[o + 2] = cb
            d[o + 3] = 255
            continue
          }
          let k = (dep * LV_D + NOISE8[(xf + (dep >> 1)) & (DEEP_W - 1)] + BAYER8[by + (xf & 3)]) | 0
          if (k < 1) k = 1
          else if (k > 8) k = 8
          d[o] = LR[k]
          d[o + 1] = LG[k]
          d[o + 2] = LB[k]
          d[o + 3] = 255
          continue
        }
        d[o] = (c >> 16) & 255
        d[o + 1] = (c >> 8) & 255
        d[o + 2] = c & 255
        d[o + 3] = 255
      }
    }
    // burbujas: domo que crece sobre la superficie (disc del lookdev: borde naranja, centro claro)
    for (const b of this.bubbles) {
      const i = b.x - xa
      if (i < 0 || i >= n) continue
      const r = b.r * Math.min(1, (b.age / b.life) * 1.3)
      if (r < 0.6) continue
      const cy = TOP + wave[i] - r * 0.6
      const R = Math.ceil(r)
      for (let yy = Math.floor(cy - R); yy <= Math.ceil(cy + R); yy++) {
        if (yy < 0 || yy >= STRIP_H) continue
        for (let xx = i - R; xx <= i + R; xx++) {
          if (xx < 0 || xx >= n) continue
          const dist = Math.hypot(xx - i, yy - cy)
          if (dist > r) continue
          const c = dist > r - 0.8 ? BUBBLE_EDGE : SURF
          const o = (yy * W + xx) * 4
          d[o] = (c >> 16) & 255
          d[o + 1] = (c >> 8) & 255
          d[o + 2] = c & 255
          d[o + 3] = 255
        }
      }
    }
    // gotitas: cabeza clara y un pixel de estela naranja
    for (const g of this.droplets) {
      const i = Math.round(g.x) - xa
      const ry = TOP + Math.round(g.y)
      if (i < 0 || i >= n) continue
      for (const [yy, c] of [
        [ry, 0xffe27a],
        [ry - Math.sign(g.vy || 1), 0xf77a28],
      ]) {
        if (yy < 0 || yy >= STRIP_H || yy - TOP >= wave[i]) continue
        const o = (yy * W + i) * 4
        d[o] = (c >> 16) & 255
        d[o + 1] = (c >> 8) & 255
        d[o + 2] = c & 255
        d[o + 3] = 255
      }
    }
    this.stripSrc.update()
  }
}
