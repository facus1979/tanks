// v4: agua y lava como materiales de la grilla (WATER y LAVA en front; no colisionan). Look del lago y el pozo
// de lava de scripts/lookdev/v2-bigmap.mjs (paintLiquids y su light naranja).
//
// Dos partes, para que sea barato:
// - El CUERPO del líquido se pinta en los trozos de terreno (TerrainPainter, capa `liquid`, por encima de los
//   tanques): estático, solo se repinta el trozo que cambió (también mientras corre un flujo). El agua es
//   translúcida (se ve la pared de fondo, el fondo del mapa, la utilería y los tanques sumergidos, teñidos);
//   la lava es opaca y usa las mismas tablas que la banda de muerte súbita (lava.ts).
// - La SUPERFICIE animada (LiquidView): una tira de pocas filas por cada celda de superficie visible (agua:
//   ondulación de 1 px, brillo que corre y destellos; lava: olas, costras, chispitas, burbujas y gotitas como la
//   banda), pintada a 30 Hz en buffers chicos que se suben directo desde los bytes. Más el resplandor de la lava
//   (un sprite aditivo por pozo, solo se rehace cuando cambia la grilla) y los efectos de entrada al agua.
import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js'
import { AIR, LAVA, MATERIALS, WATER } from '../../sim/types'
import type { Player, Terrain, Vec2 } from '../../sim/types'
import type { Fx } from './fx'
import {
  BAYER8,
  BUBBLE_EDGE,
  CRUST,
  CRUST_CELL,
  CRUST_TOP,
  CRUST_V,
  DEEP_DARK,
  DEPTH,
  GLOW_TINT,
  LB,
  LEVELS,
  LG,
  LR,
  LV_D,
  NOISE,
  NOISE8,
  NOISE_CAP,
  SPARK_T,
  SPARKLE,
  SUNK_T,
  SURF,
  TOP,
  WAVE_SHIFT,
  level,
} from './lava'
import { bayer, hash, mix, Raster, Rng } from './raster'

// ---------- materiales ----------

// Tabla por material: 0 = no es líquido, 1 = agua, 2 = lava (MaterialDef.liquid).
export const LIQ = new Uint8Array(256)
for (const m of MATERIALS) if (m.liquid) LIQ[m.id] = m.id === LAVA ? 2 : 1
// Lo que colisiona y se dibuja como terreno: ni aire ni líquido.
export const solidCell = (m: number): boolean => m !== AIR && LIQ[m] === 0

// ---------- cuerpo estático (lo usa TerrainPainter) ----------

export const W_SURF = 0xcfe4dc // superficie del agua
export const W_LIGHT = 0x8ab8b8 // fila de abajo de la superficie
export const W_DASH = 0xb0d4d0 // destellos bajo la superficie
const W_TOP = 0x5a8a92 // cuerpo junto a la superficie
const W_DEEP = 0x1c3a48 // cuerpo profundo
export const W_ALPHA = 0.78
export const W_LIGHT_ALPHA = 0.9
const W_SKY = 0.16 // reflejo del cielo (color de la niebla) junto a la superficie
const W_SKY_D = 9 // filas hasta donde llega el reflejo
const W_LEVELS = Array.from({ length: 7 }, (_, i) => mix(W_TOP, W_DEEP, i / 6))

// Color del cuerpo del agua (fila d ≥ 2 bajo la superficie): degradé por profundidad cuantizado a sextos con
// la trama de Bayer (paintLiquids) y, cerca de la superficie, un poco del cielo reflejado.
export function waterBody(x: number, y: number, d: number, fog: number): number {
  const k = Math.min(6, Math.floor((d / 50) * 6 + bayer(x, y)))
  const c = W_LEVELS[k]
  return d < W_SKY_D ? mix(c, fog, W_SKY * (1 - d / W_SKY_D)) : c
}

// Color de la lava a dep filas bajo la superficie, el mismo que la banda de muerte súbita quieta (la franja de
// lava.ts con flow 0 hasta DEPTH y deepTexture sin el vaivén más abajo): empalma con la tira animada.
export function lavaBody(x: number, dep: number): number {
  if (dep <= 0) return SURF
  if (dep < DEPTH) {
    if (dep > 4 && hash(Math.floor(x / 5), dep >> 1, 44) > SUNK_T) return CRUST
    let k = (dep * LV_D + NOISE8[(x + (dep >> 1)) & 1023] + BAYER8[(dep & 3) * 4 + (x & 3)]) | 0
    if (k < 1) k = 1
    else if (k > 8) k = 8
    return LEVELS[k]
  }
  const n = NOISE[(x + Math.min(dep >> 1, NOISE_CAP)) & 1023]
  const b = bayer(x, dep)
  const l = level(dep, n, b)
  let c = LEVELS[l]
  if (l === 8) {
    if (n > 0.7 && b < (n - 0.7) * 2) c = LEVELS[7]
    else if (n < 0.4 && b < (0.4 - n) * 2.5) c = DEEP_DARK
  }
  if (dep < DEPTH + 12 && hash(Math.floor(x / 5), dep >> 1, 44) > SUNK_T) c = CRUST
  return c
}

// Terreno cocido junto a la lava (tierra cocida del lookdev): más oscuro y rojizo hasta 10 px.
export function baked(c: number, k: number): number {
  const f = 1 - k / 11
  return mix(mix(c, 0x1a0806, 0.5 * f), 0xff5a1a, 0.18 * f)
}

// ---------- superficie animada ----------

const PAD = 16 // columnas pintadas de más a cada lado de la vista (un paneo chico no obliga a repintar)
const PAINT_DT = 1 / 30 // la tira animada se repinta a 30 Hz (como la banda)
const W_UP = 2 // filas que puede subir la ondulación del agua
const W_DOWN = 6 // filas del agua que pinta la tira (superficie, fila clara y destellos)
const BAND_GAP_Y = 16 // superficies a menos de esto en y van en el mismo buffer
const BAND_GAP_X = 48
const GLOW_K = 0.3 // intensidad del resplandor de un pozo (el light del lookdev usa 0,32)
const MAX_RIPPLES = 24

interface Ripple {
  x: number
  y: number
  amp: number
  age: number
}

interface Bubble {
  x: number
  y: number
  r: number
  age: number
  life: number
}

interface Droplet {
  x: number
  y: number
  base: number // superficie: la gotita se apaga al volver a ella
  vx: number
  vy: number
}

interface Band {
  x0: number
  x1: number // inclusivo
  y0: number
  y1: number
  cells: number[]
}

// Buffer RGBA reutilizable con su sprite; el frame de la textura se ajusta al tamaño de cada pintada.
class Strip {
  data: Uint8Array
  src: BufferImageSource
  tex: Texture
  sprite: Sprite
  cw: number
  ch: number

  constructor(w: number, h: number) {
    this.cw = Math.max(64, Math.ceil(w / 64) * 64)
    this.ch = Math.max(16, Math.ceil(h / 16) * 16)
    this.data = new Uint8Array(this.cw * this.ch * 4)
    this.src = new BufferImageSource({ resource: this.data, width: this.cw, height: this.ch, scaleMode: 'nearest', autoGenerateMipmaps: false })
    this.tex = new Texture({ source: this.src })
    this.sprite = new Sprite(this.tex)
  }

  fits(w: number, h: number): boolean {
    return w <= this.cw && h <= this.ch
  }

  destroy(): void {
    this.sprite.destroy()
    this.tex.destroy(true)
  }
}

interface Glow {
  sprite: Sprite
  phase: number
}

export class LiquidView {
  readonly layer = new Container() // superficie animada: encima del cuerpo (trozos `liquid`)
  readonly glowLayer = new Container() // resplandor aditivo de la lava material
  private strips: Strip[] = []
  private glows: Glow[] = []
  private glowTex = new Map<string, Texture>()
  private glowVersion = -1
  private rng = new Rng(9090)
  private time = 0
  private crustOff = 0
  private paintAge = 1
  private painted = { xa: 0, xb: 0, ya: 0, yb: 0, version: -1 }
  private ripples: Ripple[] = []
  private bubbles: Bubble[] = []
  private droplets: Droplet[] = []
  private bubbleAcc = 0
  private spawnT = 0
  private cells: number[] = [] // celdas de superficie visibles (índice de la grilla), ordenadas por fila
  private lavaCells: number[] = []
  private prevShots: Vec2[] = []
  private burnAcc = new Map<number, number>()
  private terrain: Terrain | null = null

  reset(): void {
    this.ripples = []
    this.bubbles = []
    this.droplets = []
    this.prevShots = []
    this.burnAcc.clear()
    this.painted.version = -1
    this.glowVersion = -1
    for (const s of this.strips) s.sprite.visible = false
    for (const g of this.glows) g.sprite.destroy()
    this.glows = []
  }

  setTerrain(t: Terrain): void {
    this.terrain = t
  }

  // Sin líquidos en el mapa: no se dibuja nada (Chico).
  idle(): void {
    if (this.glows.length === 0 && !this.strips.some((s) => s.sprite.visible)) return
    this.reset()
  }

  // ---------- consultas a la grilla ----------

  private at(x: number, y: number): number {
    const t = this.terrain
    if (!t) return AIR
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) return AIR
    return t.front[y * t.w + x]
  }

  // Primera fila de agua (o del líquido kind) hacia arriba desde (x, y): la superficie. -1 si no hay.
  surfaceAbove(x: number, y: number, kind = WATER, reach = 240): number {
    const t = this.terrain
    if (!t) return -1
    const xi = Math.round(x)
    let yi = Math.round(y)
    if (xi < 0 || xi >= t.w || yi < 0 || yi >= t.h || t.front[yi * t.w + xi] !== kind) return -1
    const stop = Math.max(0, yi - reach)
    while (yi > stop && t.front[(yi - 1) * t.w + xi] === kind) yi--
    return yi
  }

  // Superficie del agua sobre una explosión: el centro puede caer en el fondo (sólido), así que se mira
  // hasta 5 px más arriba. -1 si no está bajo el agua.
  submerged(x: number, y: number): number {
    for (let dy = 0; dy <= 5; dy++) {
      const sy = this.surfaceAbove(x, y - dy)
      if (sy >= 0) return sy
    }
    return -1
  }

  // Superficie de lava cerca de (x, y) (celdas de lava en un cuadrado de r px): y de la superficie, o -1.
  private lavaNear(x: number, y: number, r: number): number {
    const t = this.terrain
    if (!t) return -1
    const xi = Math.round(x)
    const yi = Math.round(y)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = xi + dx
        const yy = yi + dy
        if (xx < 0 || yy < 0 || xx >= t.w || yy >= t.h) continue
        if (t.front[yy * t.w + xx] === LAVA) return this.surfaceAbove(xx, yy, LAVA)
      }
    }
    return -1
  }

  ripple(x: number, y: number, amp: number): void {
    this.ripples.push({ x, y, amp, age: 0 })
    if (this.ripples.length > MAX_RIPPLES) this.ripples.splice(0, this.ripples.length - MAX_RIPPLES)
  }

  // ---------- efectos que dispara el renderer ----------

  // Explosión: si el centro quedó bajo el agua, burbujas que suben y, cerca de la superficie, un géiser.
  impact(fx: Fx, x: number, y: number, radius: number): void {
    const sy = this.submerged(x, y)
    if (sy < 0) return
    const depth = y - sy
    fx.bubbles(x, y, Math.min(26, 6 + Math.round(radius * 0.8)), sy, Math.max(6, radius))
    if (depth < radius * 2 + 10) {
      const k = Math.max(0.4, 1 - depth / (radius * 2 + 10))
      fx.geyser(x, sy, radius * k)
      this.ripple(x, sy, 2.4)
    } else this.ripple(x, sy, 1)
  }

  // Tanque que cayó al agua: salpicadura grande y ondas donde corta la superficie.
  tankSplash(fx: Fx, x: number, floor: number): void {
    let sy = -1
    for (let dx = -10; dx <= 10 && sy < 0; dx += 5) sy = this.surfaceAbove(x + dx, floor - 1)
    if (sy < 0) sy = this.surfaceAbove(x, floor + 2)
    if (sy < 0) return
    fx.waterSplash(x - 9, sy, 9, 120)
    fx.waterSplash(x + 9, sy, 9, 120)
    fx.waterSplash(x, sy, 6, 80)
    this.ripple(x - 14, sy, 2.4)
    this.ripple(x + 14, sy, 2.4)
  }

  // Tanque quemado por la lava material (damage cause 'lava' sin la banda): chispas, llamitas y humo, y una onda.
  burn(fx: Fx, x: number, y: number): void {
    fx.lavaBurn(x, y)
    const sy = this.lavaNear(x, y - 2, 6)
    if (sy >= 0) this.ripple(x, sy, 1.6)
  }

  // Agua y lava hicieron piedra (evento 'steam'): vapor que sale silbando, chispas y una luz chica.
  steam(fx: Fx, x: number, y: number, n: number): void {
    fx.hiss(x, y, n)
    this.ripple(x, y, 1.2)
  }

  // Proyectiles: entrada al agua (salpicadura y ondas) y derretidos en la lava material (chisporroteo).
  // bandLevel: superficie de la lava de muerte súbita (esa la resuelve LavaView), o null.
  trackShots(fx: Fx, shots: Vec2[], impacts: Vec2[], bandLevel: number | null): void {
    const prev = this.prevShots
    if (this.terrain) {
      if (prev.length === shots.length) {
        for (let i = 0; i < shots.length; i++) this.entry(fx, prev[i], shots[i])
      }
      for (const p of prev) {
        if (shots.some((q) => Math.abs(q.x - p.x) < 40 && Math.abs(q.y - p.y) < 40)) continue
        if (impacts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 40)) continue
        if (bandLevel !== null && p.y >= bandLevel - 26) continue
        const sy = this.lavaNear(p.x, p.y, 5)
        if (sy < 0) continue
        fx.sizzle(p.x, sy)
        this.ripple(p.x, sy, 2.2)
      }
    }
    this.prevShots = shots.map((p) => ({ x: p.x, y: p.y }))
  }

  // ¿El tramo a → b entra al agua? Salpicadura en la superficie, en la columna donde la cruza.
  private entry(fx: Fx, a: Vec2, b: Vec2): void {
    if (this.at(a.x, a.y) === WATER || this.at(b.x, b.y) !== WATER) return
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    if (d > 80) return
    const n = Math.max(1, Math.ceil(d))
    for (let k = 1; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n
      const y = a.y + ((b.y - a.y) * k) / n
      if (this.at(x, y) !== WATER) continue
      const sy = this.surfaceAbove(x, y)
      if (sy < 0) return
      fx.waterSplash(x, sy, 10, 110)
      fx.waterSplash(x, sy, 4, 50)
      this.ripple(x, sy, 2.2)
      return
    }
  }

  // Tanques apoyados en la lava material: chispitas y humo mientras la tocan.
  tanks(fx: Fx, players: Player[], dt: number): void {
    if (dt <= 0 || !this.terrain) return
    for (const p of players) {
      if (!p.alive) {
        this.burnAcc.delete(p.id)
        continue
      }
      let touch = false
      for (let dx = -12; dx <= 12 && !touch; dx += 4) {
        for (const dy of [0, -3, -8]) if (this.at(p.x + dx, p.y + dy) === LAVA) touch = true
      }
      if (!touch) {
        this.burnAcc.delete(p.id)
        continue
      }
      let acc = (this.burnAcc.get(p.id) ?? 0) + dt
      for (; acc >= 0.12; acc -= 0.12) fx.ember(p.x + (this.rng.next() - 0.5) * 22, p.y - 2 - this.rng.next() * 6, this.rng.next() < 0.3)
      this.burnAcc.set(p.id, acc)
    }
  }

  // Frente del flujo: celdas que se volvieron líquido en este cambio de grilla (x, y, tipo). Espuma en el
  // agua que cae o avanza, chispas en la lava.
  flowFront(fx: Fx, fresh: number[], x0: number, x1: number, y0: number, y1: number): void {
    let n = 0
    for (let i = 0; i < fresh.length && n < 8; i += 3) {
      const x = fresh[i]
      const y = fresh[i + 1]
      if (x < x0 || x > x1 || y < y0 || y > y1) continue
      if (this.rng.next() > 0.35) continue
      n++
      if (fresh[i + 2] === LAVA) fx.lavaSpray(x, y, 1, 40)
      else fx.foam(x, y)
    }
  }

  // ---------- animación y pintado ----------

  // surfaces(i): celdas de superficie (índices de la grilla, por fila) del trozo i, o null si no tiene líquido;
  // version: sube cada vez que cambian (TerrainPainter.surfStamp).
  // x0..x1, y0..y1: rectángulo visible del mundo (con sacudón). dt = 0 congelado.
  update(
    t: Terrain,
    version: number,
    chunkW: number,
    surfaces: (i: number) => Int32Array | null,
    lavaSurfaces: () => Int32Array[],
    dt: number,
    wind: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
  ): void {
    this.terrain = t
    if (dt > 0) this.step(dt, wind)
    if (version !== this.glowVersion) this.buildGlows(t, lavaSurfaces(), version)
    for (const g of this.glows) g.sprite.alpha = 0.88 + 0.07 * Math.sin(this.time * 2.3 + g.phase) + 0.05 * Math.sin(this.time * 7.1 + g.phase * 2)

    const xa = Math.max(0, Math.floor(x0) - 2)
    const xb = Math.min(t.w, Math.ceil(x1) + 2)
    const P = this.painted
    this.paintAge += dt
    const out = xa < P.xa || xb > P.xb || y0 < P.ya || y1 > P.yb || version !== P.version
    if (!out && this.paintAge < PAINT_DT) return
    this.paintAge = 0
    const pa = Math.max(0, xa - PAD)
    const pb = Math.min(t.w, xb + PAD)
    const ya = Math.floor(y0) - 12
    const yb = Math.ceil(y1) + 12
    P.xa = pa
    P.xb = pb
    P.ya = ya + 12
    P.yb = yb - 12
    P.version = version

    // superficies visibles
    const cells = this.cells
    cells.length = 0
    const lava = this.lavaCells
    lava.length = 0
    const W = t.w
    for (let i = Math.floor(pa / chunkW); i * chunkW < pb; i++) {
      const s = surfaces(i)
      if (!s) continue
      for (let k = 0; k < s.length; k++) {
        const idx = s[k]
        const y = (idx / W) | 0
        if (y < ya || y > yb) continue
        const x = idx - y * W
        if (x < pa || x >= pb) continue
        cells.push(idx)
        if (t.front[idx] === LAVA) lava.push(idx)
      }
    }
    if (cells.length > 1) cells.sort((a, b) => a - b)
    this.spawnBubbles(this.time - this.spawnT)
    this.spawnT = this.time
    this.paint(t, this.bands(cells, W))
  }

  private step(dt: number, wind: number): void {
    this.time += dt
    this.crustOff += (CRUST_V + wind * 0.6) * dt
    for (const r of this.ripples) r.age += dt
    this.ripples = this.ripples.filter((r) => r.age < 2.2)
    for (const b of this.bubbles) {
      b.age += dt
      if (b.age < b.life) continue
      const n = b.r > 2 ? 3 : 1
      for (let i = 0; i < n && this.droplets.length < 40; i++) {
        this.droplets.push({ x: b.x + (this.rng.next() - 0.5) * 2, y: b.y - 1, base: b.y, vx: (this.rng.next() - 0.5) * 30, vy: -30 - this.rng.next() * 35 })
      }
      if (b.r > 2) this.ripple(b.x, b.y, 0.8)
    }
    this.bubbles = this.bubbles.filter((b) => b.age < b.life)
    for (const g of this.droplets) {
      g.vy += 300 * dt
      g.x += g.vx * dt
      g.y += g.vy * dt
    }
    this.droplets = this.droplets.filter((g) => g.y < g.base || g.vy < 0)
  }

  // Burbujas de la lava: unas 3 por segundo cada 800 columnas de superficie visible (como la banda).
  private spawnBubbles(dt: number): void {
    const lava = this.lavaCells
    const t = this.terrain
    if (!t || lava.length === 0 || dt <= 0) return
    this.bubbleAcc += dt * 3 * (lava.length / 800)
    while (this.bubbleAcc >= 1) {
      this.bubbleAcc -= 1
      if (this.bubbles.length >= 20) continue
      const idx = lava[Math.floor(this.rng.next() * lava.length)]
      const y = (idx / t.w) | 0
      this.bubbles.push({ x: idx - y * t.w, y, r: 1.2 + this.rng.next() * 1.6, age: 0, life: 0.5 + this.rng.next() * 0.9 })
    }
  }

  // Agrupa las celdas de superficie (ordenadas por fila) en rectángulos cercanos: un buffer por grupo.
  private bands(cells: number[], W: number): Band[] {
    const out: Band[] = []
    for (const idx of cells) {
      const y = (idx / W) | 0
      const x = idx - y * W
      let b: Band | undefined
      for (const q of out) {
        if (y <= q.y1 + BAND_GAP_Y && x >= q.x0 - BAND_GAP_X && x <= q.x1 + BAND_GAP_X) {
          b = q
          break
        }
      }
      if (!b) {
        out.push({ x0: x, x1: x, y0: y, y1: y, cells: [idx] })
        continue
      }
      if (x < b.x0) b.x0 = x
      if (x > b.x1) b.x1 = x
      if (y > b.y1) b.y1 = y
      b.cells.push(idx)
    }
    return out
  }

  private paint(t: Terrain, bands: Band[]): void {
    const W = t.w
    while (this.strips.length < bands.length) {
      const s = new Strip(256, 32)
      this.strips.push(s)
      this.layer.addChild(s.sprite)
    }
    for (let k = 0; k < this.strips.length; k++) {
      const b = bands[k]
      let s = this.strips[k]
      if (!b) {
        s.sprite.visible = false
        continue
      }
      // la tira cubre TOP filas por encima de la superficie más alta (burbujas, gotas, crestas) y DEPTH por
      // debajo de la más baja; 3 columnas de margen a cada lado para las gotitas
      const ox = b.x0 - 3
      const oy = b.y0 - TOP
      const w = b.x1 - b.x0 + 7
      const h = b.y1 - b.y0 + TOP + Math.max(DEPTH, W_DOWN)
      if (!s.fits(w, h)) {
        const n = new Strip(w, h)
        this.layer.addChildAt(n.sprite, this.layer.getChildIndex(s.sprite))
        s.destroy()
        this.strips[k] = n
        s = n
      }
      const d = s.data
      d.fill(0, 0, s.cw * h * 4)
      const ctx: PaintCtx = { d, stride: s.cw, ox, oy, h, W }
      for (const idx of b.cells) {
        const y = (idx / W) | 0
        const x = idx - y * W
        if (t.front[idx] === LAVA) this.lavaColumn(t, ctx, x, y)
        else this.waterColumn(t, ctx, x, y)
      }
      this.lavaExtras(ctx, b)
      s.src.update()
      s.tex.frame.width = w
      s.tex.frame.height = h
      s.tex.update()
      s.sprite.position.set(ox, oy)
      s.sprite.visible = true
    }
  }

  // Ondas: suma de las ondas cercanas (entradas al agua, burbujas que revientan, tanques) en la columna x de
  // una superficie en la fila y. Como las de la banda: se abren a 45 px/s y se apagan.
  private rippleAt(x: number, y: number): number {
    let w = 0
    for (const r of this.ripples) {
      if (Math.abs(r.y - y) > 12) continue
      const dx = Math.abs(x - r.x)
      const front = r.age * 45
      if (dx > front + 6) continue
      w += r.amp * Math.exp(-r.age * 1.8 - dx / 70) * Math.sin((dx - front) * 0.45)
    }
    return w
  }

  // Agua: la superficie ondula hacia arriba 0-2 px (la ola lenta y las ondas), el brillo de la superficie corre
  // con el tiempo y los destellos de abajo se deslizan y titilan. El cuerpo ya está en el trozo.
  private waterColumn(t: Terrain, c: PaintCtx, x: number, y: number): void {
    const time = this.time
    const W = c.W
    const base = Math.sin(x * 0.21 + y * 0.3 + time * 2.2) * 0.5 + Math.sin(x * 0.067 - time * 1.4) * 0.5
    const r = this.rippleAt(x, y)
    let up = (base > 0.62 ? 1 : 0) + Math.max(0, r)
    up = Math.min(W_UP, Math.round(up))
    // la cresta solo sube sobre aire (no se mete en una pared)
    while (up > 0 && (y - up < 0 || t.front[(y - up) * W + x] !== AIR)) up--
    const px = x - c.ox
    if (up > 0) {
      for (let k = 1; k <= up; k++) put(c, px, y - k - c.oy, k === up ? W_SURF : W_LIGHT, 255)
      put(c, px, y - c.oy, W_LIGHT, 255)
    } else if (r < -0.6) {
      // valle de una onda: la superficie se ve un poco más oscura
      put(c, px, y - c.oy, W_LIGHT, 255)
    }
    // brillo que corre por la superficie (rayitas de 2-3 px que avanzan con el tiempo)
    const sx = x + Math.floor(time * 7)
    if (hash(sx >> 2, y, 9) / 4294967296 > 0.86 && (sx & 3) !== 3) put(c, px, y - up - c.oy, 0xffffff, 255)
    // destellos bajo la superficie: rayitas de 4 px que se deslizan (una fila para cada lado) y titilan
    for (let dd = 2; dd < W_DOWN; dd++) {
      const yy = y + dd
      if (yy >= t.h || t.front[yy * W + x] !== WATER) break
      const drift = Math.floor(time * 3) * ((yy & 1) === 0 ? 1 : -1)
      const cell = (x + drift) >> 2
      const hv = hash(cell, yy, 12) / 4294967296
      if (hv <= 0.93) continue
      if (Math.sin(time * 3 + hv * 40) < -0.3) continue
      put(c, px, yy - c.oy, W_DASH, 204)
    }
  }

  // Lava: la franja de la banda (lava.ts) para esta columna, con la superficie que solo sube (abajo ya está el
  // cuerpo opaco del trozo), costras que derivan con el viento y chispitas. Sin flujo de costado, para empalmar.
  private lavaColumn(t: Terrain, c: PaintCtx, x: number, y: number): void {
    const time = this.time
    const W = c.W
    let w = Math.sin(x * 0.11 + time * 2.4) * 0.8 + Math.sin(x * 0.043 - time * 1.7) * 0.7 + this.rippleAt(x, y)
    w = -Math.max(0, Math.min(3, Math.round(w)))
    // costra flotante (filas bajo la superficie) en celdas que derivan
    const cx = x - Math.floor(this.crustOff)
    const cell = Math.floor(cx / CRUST_CELL)
    const ch = hash(cell, 0, 77)
    let crust = 0
    if (ch / 4294967296 > 0.7) {
      const u = cx - cell * CRUST_CELL
      const a = 1 + ((ch >>> 8) & 3)
      const b = CRUST_CELL - 1 - ((ch >>> 12) & 3)
      if (u >= a && u < b) crust = u === a || u === b - 1 ? 1 : 2 + ((ch >>> 16) & 1)
    }
    const sparkOff = Math.floor(time * 6)
    const px = x - c.ox
    for (let dd = -3; dd < DEPTH; dd++) {
      const yy = y + dd
      if (yy < 0 || yy >= t.h) continue
      const m = t.front[yy * W + x]
      if (dd < 0 ? m !== AIR : m !== LAVA) continue
      const dep = dd - WAVE_SHIFT[(dd + TOP) * 7 + 3 + w]
      if (dep < 0) continue
      let col: number
      if (dep < crust) col = dep === 0 ? CRUST_TOP : CRUST
      else if (dep === 0) col = hash(x - sparkOff, 0, 3) > SPARK_T ? SPARKLE : SURF
      else if (dd > 4 && hash(Math.floor(x / 5), dd >> 1, 44) > SUNK_T) col = CRUST
      else {
        let k = (dep * LV_D + NOISE8[(x + (dep >> 1)) & 1023] + BAYER8[((dd & 3) << 2) + (x & 3)]) | 0
        if (k < 1) k = 1
        else if (k > 8) k = 8
        const o = ((yy - c.oy) * c.stride + px) * 4
        c.d[o] = LR[k]
        c.d[o + 1] = LG[k]
        c.d[o + 2] = LB[k]
        c.d[o + 3] = 255
        continue
      }
      put(c, px, yy - c.oy, col, 255)
    }
  }

  // Burbujas (domos que crecen y revientan) y gotitas de la lava que caen dentro de este buffer.
  private lavaExtras(c: PaintCtx, b: Band): void {
    const t = this.terrain
    if (!t) return
    for (const q of this.bubbles) {
      if (q.x < b.x0 || q.x > b.x1 || q.y < b.y0 || q.y > b.y1) continue
      const r = q.r * Math.min(1, (q.age / q.life) * 1.3)
      if (r < 0.6) continue
      const cy = q.y - c.oy - r * 0.6
      const R = Math.ceil(r)
      const i = q.x - c.ox
      for (let yy = Math.floor(cy - R); yy <= Math.ceil(cy + R); yy++) {
        if (yy < 0 || yy >= c.h) continue
        for (let xx = i - R; xx <= i + R; xx++) {
          if (xx < 0 || xx >= c.stride) continue
          const dist = Math.hypot(xx - i, yy - cy)
          if (dist > r) continue
          const wx = xx + c.ox
          const wy = yy + c.oy
          if (wx < 0 || wy < 0 || wx >= t.w || wy >= t.h || solidCell(t.front[wy * t.w + wx])) continue
          put(c, xx, yy, dist > r - 0.8 ? BUBBLE_EDGE : SURF, 255)
        }
      }
    }
    for (const g of this.droplets) {
      const gx = Math.round(g.x)
      if (gx < b.x0 - 3 || gx > b.x1 + 3 || g.base < b.y0 || g.base > b.y1) continue
      const gy = Math.round(g.y)
      put(c, gx - c.ox, gy - c.oy, 0xffe27a, 255)
      put(c, gx - c.ox, gy - Math.sign(g.vy || 1) - c.oy, 0xf77a28, 255)
    }
  }

  // Resplandor de cada pozo de lava: un light() del lookdev centrado en la superficie, como sprite aditivo.
  // Se rehace solo cuando cambia la grilla; la textura depende del radio y de dónde cae el centro respecto de la
  // trama de Bayer (se cachea).
  private buildGlows(t: Terrain, lava: Int32Array[], version: number): void {
    this.glowVersion = version
    const W = t.w
    const pts: number[] = []
    for (const s of lava) for (let k = 0; k < s.length; k++) pts.push(s[k])
    const xs = pts.map((idx) => idx % W)
    const order = pts.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
    const segs: { x0: number; x1: number; y: number }[] = []
    for (const i of order) {
      const x = xs[i]
      const y = (pts[i] / W) | 0
      const last = segs[segs.length - 1]
      if (last && x - last.x1 <= 8 && Math.abs(y - last.y) <= 30) {
        last.x1 = x
        last.y = Math.min(last.y, y)
      } else segs.push({ x0: x, x1: x, y })
    }
    const want = segs.filter((s) => s.x1 - s.x0 >= 2)
    while (this.glows.length > want.length) this.glows.pop()?.sprite.destroy()
    while (this.glows.length < want.length) {
      const sp = new Sprite()
      sp.blendMode = 'add'
      this.glowLayer.addChild(sp)
      this.glows.push({ sprite: sp, phase: this.rng.next() * 6 })
    }
    want.forEach((s, i) => {
      const R = Math.max(40, Math.min(136, Math.round(((s.x1 - s.x0) * 0.8 + 24) / 8) * 8))
      const cx = Math.round((s.x0 + s.x1) / 2)
      const cy = s.y + 3
      const bx = Math.floor((cx - R) / 4) * 4
      const by = Math.floor((cy - R) / 4) * 4
      const key = `${R}:${cx - bx}:${cy - by}`
      let tex = this.glowTex.get(key)
      if (!tex) {
        if (this.glowTex.size > 48) {
          for (const tx of this.glowTex.values()) if (!this.glows.some((g) => g.sprite.texture === tx)) tx.destroy(true)
          this.glowTex.clear()
        }
        const r = new Raster(2 * R + 8, 2 * R + 8)
        r.light(cx - bx, cy - by, R, GLOW_TINT, GLOW_K)
        r.flush()
        tex = Texture.from(r.canvas)
        tex.source.scaleMode = 'nearest'
        tex.source.autoGenerateMipmaps = false
        this.glowTex.set(key, tex)
      }
      const g = this.glows[i]
      g.sprite.texture = tex
      g.sprite.position.set(bx, by)
    })
  }
}

interface PaintCtx {
  d: Uint8Array
  stride: number
  ox: number
  oy: number
  h: number
  W: number
}

function put(c: PaintCtx, x: number, y: number, col: number, a: number): void {
  if (x < 0 || y < 0 || x >= c.stride || y >= c.h) return
  const o = (y * c.stride + x) * 4
  c.d[o] = (col >> 16) & 255
  c.d[o + 1] = (col >> 8) & 255
  c.d[o + 2] = col & 255
  c.d[o + 3] = a
}
