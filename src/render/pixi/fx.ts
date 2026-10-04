// Partículas y explosiones, dibujadas en pixels enteros (ver explosion()/cluster() del look-test).
// v2: las partículas viven en coordenadas de mundo y se dibujan en buffers del tamaño de la pantalla
// (fx y light), que el renderer ubica sobre la parte visible del mundo con Raster.setView.
// v4: el agua y la lava no frenan partículas (no son sólidas); lo que cae en ellas se apaga o se hunde, y el
// agua tiene sus propias partículas: gotas (salpicaduras, géiser, espuma) y burbujas.
import type { BlastStyle, Terrain } from '../../sim/types'
import { AIR, STONE, WATER, WEAPONS } from '../../sim/types'
import { DEBRIS_COLORS, OUT } from './fallback'
import type { FxKit } from './fxkit'
import { LIQ, solidCell } from './liquids'
import type { Texture } from 'pixi.js'
import { rasterTexture, uploadRect, type RasterSource } from './gpu'
import { LightLayer } from './lights'
import type { Quality } from './quality'
import { Raster, Rng, bayer, mix } from './raster'

const FIRE = [0xfffbe2, 0xffe27a, 0xffb43e, 0xf77a28, 0xd24a1c, 0x8a2814]
const SMOKE = [0xa89c90, 0x847869, 0x62564c, 0x463b34, 0x2e2622]
const DIRT_RAMP = [0xb09878, 0x947c5e, 0x76604a, 0x5a4634, 0x3c2e22]
const DUST = [0xc8b89a, 0xb09c7e, 0x9a8468, 0x7a6650, 0x5a4a3a]
const FLASH = [0xffffff, 0xffffff, 0xfffbe2, 0xffe27a]
const CORE = [0xffffff, 0xfffbe2, 0xfffbe2, 0xfff1c0, 0xffe27a, 0xffb43e]
const FIRE_OUT = 0x3a1208
const SMOKE_OUT = 0x18120e
// napalm: humo de petróleo, casi negro
const BLACK_SMOKE = [0x5a5048, 0x3e3630, 0x2c2522, 0x201a18, 0x141010]
const BLACK_OUT = 0x0a0808
const DIG_LEN = 80 // largo del túnel de la excavadora (DIG_LENGTH del sim)
const DIG_TIME = 0.45 // lo que tarda la mecha en recorrerlo
const BURN_TAIL = 1.2 // humo que sigue después de apagarse las llamas
// Tope de partículas vivas entre blobs, softs (sin la estela del proyectil), chispas y escombros.
// Una explosión normal anda por ~230; al pasarse se descartan las más gastadas (edad/vida más alta).
const MAX_PARTICLES = 300
// v3: con calidad 'low' (quality.ts) el tope baja, se emite la mitad de las bocanadas de humo y polvo, los
// escombros no dejan estela y se omiten las luces tenues.
const MAX_PARTICLES_LOW = 160
const LOW_MIN_LIGHT = 0.08
// Polvo de suelo: más claro que el humo (SMOKE[0]), sin contorno oscuro.
const PUFF_HI = 0xd2c6b0
const PUFF_MID = 0xb8aa94
const PUFF_EDGE = 0x9e907c

// Capas de dibujo: 0 humo, 1 fuego, 2 núcleo, 3 bocanadas (cada una con su contorno), 4 flash
type Layer = 0 | 1 | 2 | 3 | 4

interface Blob {
  layer: Layer
  ox: number
  oy: number
  dx: number
  dy: number
  vx: number
  vy: number
  ax: number
  ay: number
  r0: number
  r1: number
  grow: number
  hold: number
  life: number
  delay: number
  heat0: number
  heatV: number
  cool: number // segundos antes de empezar a enfriarse (heatV)
  ramp: number[]
  outline: number
  fade: boolean
  age: number
}

interface Soft {
  x0: number
  y0: number
  vx: number
  vy: number
  ax: number
  drag: number
  r0: number
  r1: number
  life: number
  age: number
  inner: number
  edge: number
  a0: number
  keep: number // fracción de la vida con alfa a0 antes de desvanecerse
  top: boolean // se dibuja encima del fuego y el humo (estela de los pedazos en llamas)
  trail: boolean
  puff: number // > 0: bocanada de polvo apoyada en el piso (y0 es el piso), achatada a este alto/ancho y con dither hacia afuera
}

interface Debris {
  x: number
  y: number
  vx: number
  vy: number
  color: number
  shape: number
  life: number
  age: number
  rest: boolean
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  age: number
}

// Pedazo en llamas: recorre la curva de look-test (t en 0..1) dejando estela y después cae.
interface Chunk {
  x: number
  y: number
  ox: number
  oy: number
  dx: number
  peak: number
  dur: number
  t: number
  vx: number
  vy: number
  life: number
  age: number
  pts: number[] // estela: x, y, instante de cada punto
  done: boolean // cabeza apagada: sólo queda la estela desvaneciéndose
}

const CHUNK_TRAIL = 0.24 // segundos que dura cada punto de la estela de los pedazos

interface Light {
  x: number
  y: number
  R: number
  tint: number
  k: number
  life: number
  age: number
}

interface Emitter {
  kind: 'wreck' | 'burn' | 'drill' | 'mouth'
  x: number
  y: number
  w: number
  life: number
  age: number
  accA: number
  accB: number
  id?: number
  end?: number // burn: edad en que se apagan las llamas (después queda humo)
  surf?: number[] // burn: y del piso por columna
  dx?: number // drill: dirección del túnel
  dy?: number
}

interface Drop {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  acc: number
}

// v4: gota de agua (salpicadura, géiser, espuma): cae con gravedad y se apaga al volver al agua.
interface WDrop {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  big: boolean
}

// v4: burbuja bajo el agua: sube bamboleándose hasta la superficie (top) y revienta.
interface Bubble {
  x: number
  y: number
  vy: number
  top: number
  age: number
  life: number
  r: number
  phase: number
}

// colores de las gotas y la espuma: la cabeza clara y el resto del azul del agua, para que se lean también
// contra la niebla clara del fondo
const W_DROP = 0xe8f4f0
const W_DROP_MID = 0x8ab8b8
const W_DROP_TAIL = 0x4a7a84
const W_FOAM = 0xe4f0ec
const W_FOAM_EDGE = 0x6e9ea4
const W_BUBBLE = 0xcfe4dc
const W_BUBBLE_IN = 0x5a8a92

// Onda expansiva: anillo que crece y levanta polvo donde cruza el piso.
interface Ring {
  x: number
  y: number
  R: number
  w: number
  life: number
  age: number
  delay: number
  acc: number
}

// Proyectil en vuelo como lo dibuja el renderer.
export interface ShotView {
  x: number
  y: number
  kind?: 'shell' | 'bomblet' | 'nuke' | 'roll'
  spin?: number // rodadora: ángulo de giro en radianes
}

interface Delayed {
  at: number
  run: () => void
}

const SHAPES: [number, number][][] = [
  [[0, 0]],
  [
    [0, 0],
    [1, 0],
  ],
  [
    [0, 0],
    [1, 0],
    [0, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
]

const easeOut = (u: number): number => 1 - (1 - u) * (1 - u)

export class Fx {
  readonly fx: Raster
  // v3: las luces son sprites aditivos en la GPU (lights.ts); fx.light.light(...) sigue igual que con el Raster.
  readonly light: LightLayer
  // v3: textura de GPU que se llena directo desde los bytes de fx (sin canvas ni putImageData), ver present().
  readonly fxTexture: Texture<RasterSource>
  quality: Quality = 'high'
  private softSkip = 0
  private shown = [0, 0, -1, -1] // caja de fx subida el frame anterior (hay que borrarla si hoy no se pinta)
  shake = 0
  flash = 0
  flashColor = 0xfff1c9
  glow = 0 // luz de color sobre toda la pantalla (nuke)
  glowColor = 0xff7a2a
  hitStop = 0
  wind = 0
  lavaY: number | null = null // v2: superficie de la lava de muerte súbita; lo que cae debajo se derrite
  fog = 0xf0dfc8 // color de la niebla del bioma: el humo se disuelve hacia él
  private rng = new Rng(20250928)
  private blobs: Blob[] = []
  private softs: Soft[] = []
  private debris: Debris[] = []
  private sparks: Spark[] = []
  private chunks: Chunk[] = []
  private lights: Light[] = []
  private emitters: Emitter[] = []
  private drops: Drop[] = []
  private delayed: Delayed[] = []
  private rings: Ring[] = []
  private wdrops: WDrop[] = []
  private wbubbles: Bubble[] = []
  private time = 0
  private occ: number[] = [] // x, y, r de fuego y humo del último draw
  private terrain: Terrain | null = null
  wreckPos: (id: number) => { x: number; y: number } | null = () => null

  // v3 (render-armas): gancho hacia las partículas para los efectos de las armas e ítems nuevos (ver fxkit.ts).
  readonly kit: FxKit = {
    blob: (b) => this.blob(b),
    soft: (s) => this.soft(s),
    spark: (x, y, vx, vy, life) => this.sparks.push({ x, y, vx, vy, life, age: 0 }),
    debris: (x, y, vx, vy, color, shape, life) => this.debris.push({ x, y, vx, vy, color, shape, life, age: 0, rest: false }),
    light: (x, y, R, tint, k, life) => this.lights.push({ x, y, R, tint, k, life, age: 0 }),
    fireball: (x, y, s, L, debris, amount, mini = false) => this.fire(x, y, s, L, debris, amount, mini),
    cap: () => this.capParticles(),
  }

  // w × h: tamaño de los buffers (la pantalla más un margen), no del mundo.
  constructor(w: number, h: number) {
    this.fx = new Raster(w, h, true)
    this.light = new LightLayer(w, h)
    this.fxTexture = rasterTexture(this.fx)
  }

  // Sube a la GPU lo que se dibujó en fx: la caja pintada en este frame unida a la del anterior (que quedó
  // borrada en los bytes). Devuelve si el sprite de efectos tiene que verse.
  present(): boolean {
    const fx = this.fx
    const p = this.shown
    const has = fx.bx1 >= fx.bx0
    if (has || p[2] >= p[0]) {
      const x0 = has ? Math.min(fx.bx0, p[2] >= p[0] ? p[0] : fx.bx0) : p[0]
      const y0 = has ? Math.min(fx.by0, p[2] >= p[0] ? p[1] : fx.by0) : p[1]
      const x1 = Math.max(fx.bx1, p[2])
      const y1 = Math.max(fx.by1, p[3])
      uploadRect(this.fxTexture, x0, y0, x1, y1)
    }
    if (has) this.shown = [fx.bx0, fx.by0, fx.bx1, fx.by1]
    else this.shown = [0, 0, -1, -1]
    return fx.dirty
  }

  // Ubica los dos buffers sobre el mundo (ver Raster.setView).
  setView(ox: number, oy: number, z: number): void {
    this.fx.setView(ox, oy, z)
    this.light.setView(ox, oy, z)
  }

  private get worldW(): number {
    return this.terrain?.w ?? this.fx.w
  }

  private get worldH(): number {
    return this.terrain?.h ?? this.fx.h
  }

  setTerrain(t: Terrain): void {
    this.terrain = t
  }

  reset(): void {
    this.blobs = []
    this.softs = []
    this.debris = []
    this.sparks = []
    this.chunks = []
    this.lights = []
    this.emitters = []
    this.drops = []
    this.delayed = []
    this.rings = []
    this.wdrops = []
    this.wbubbles = []
    this.shake = 0
    this.flash = 0
    this.glow = 0
    this.hitStop = 0
  }

  get busy(): boolean {
    return (
      this.blobs.length +
        this.softs.length +
        this.debris.length +
        this.sparks.length +
        this.chunks.length +
        this.lights.length +
        this.emitters.length +
        this.drops.length +
        this.rings.length +
        this.wdrops.length +
        this.wbubbles.length >
      0
    )
  }

  private solid(x: number, y: number): boolean {
    const t = this.terrain
    if (!t) return false
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || x >= t.w || y >= t.h) return false
    if (y < 0) return false
    return solidCell(t.front[y * t.w + x])
  }

  // v4: ¿hay agua o lava en el punto?
  private liquid(x: number, y: number): number {
    const t = this.terrain
    if (!t) return 0
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) return 0
    return LIQ[t.front[y * t.w + x]]
  }

  private r(): number {
    return this.rng.next()
  }

  // ---------- emisión ----------

  private blob(b: Partial<Blob> & Pick<Blob, 'layer' | 'ox' | 'oy' | 'r1' | 'life' | 'ramp' | 'outline'>): void {
    this.blobs.push({
      dx: 0,
      dy: 0,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      r0: b.r1,
      grow: 0.001,
      hold: b.life,
      delay: 0,
      heat0: 0,
      heatV: 0,
      cool: 0,
      fade: false,
      age: 0,
      ...b,
    })
  }

  private soft(s: Partial<Soft> & Pick<Soft, 'x0' | 'y0' | 'r0' | 'r1' | 'life' | 'inner' | 'edge' | 'a0'>): void {
    if (this.quality === 'low' && !s.trail && !s.top && this.softSkip++ % 2 === 1) return
    this.softs.push({ vx: 0, vy: 0, ax: 0, drag: 0, age: 0, keep: 0, top: false, trail: false, puff: 0, ...s })
  }

  // Estela del proyectil: puntos chicos que se apagan hacia la cola, como smokeTrail() del look-test.
  trailPoint(x: number, y: number): void {
    const L = 4
    this.soft({ x0: x, y0: y, r0: 1.4, r1: 2.2, life: L, inner: 0xfbf8f2, edge: 0xb0a494, a0: 1, trail: true, vy: -4 / L, ax: (2 * ((this.wind / 3) * 6)) / (L * L) })
  }

  muzzle(x: number, y: number, dirX: number, dirY: number): void {
    for (let i = 0; i < 5; i++) {
      const sp = 20 + this.r() * 30
      this.soft({
        x0: x,
        y0: y,
        vx: dirX * sp + (this.r() - 0.5) * 10,
        vy: dirY * sp - 6 - this.r() * 6,
        drag: 3,
        r0: 1.2,
        r1: 2.6 + this.r() * 1.2,
        life: 0.7 + this.r() * 0.4,
        inner: 0xf2ece2,
        edge: 0xb8ada0,
        a0: 0.9,
      })
    }
    this.blob({ layer: 4, ox: x, oy: y, r1: 3, life: 0.05, ramp: FLASH, outline: 0xffb43e, heat0: -0.4 })
    this.blob({ layer: 1, ox: x + dirX * 2, oy: y + dirY * 2, r1: 2.2, life: 0.1, grow: 0.02, hold: 0.04, ramp: FIRE, outline: FIRE_OUT, heat0: -0.1, heatV: 3 })
    this.lights.push({ x, y, R: 24, tint: 0xffb04a, k: 0.35, life: 0.12, age: 0 })
    this.shake = Math.max(this.shake, 1.5)
  }

  dust(x: number, y: number, n: number, spread = 14): void {
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const r = 1.5 + this.r() * 2.5
      this.soft({
        x0: x + (this.r() - 0.5) * spread,
        y0: y - this.r() * 2,
        vx: side * (10 + this.r() * 40),
        vy: -4 - this.r() * 8,
        drag: 4,
        r0: r * 0.6,
        r1: r * 1.5,
        life: 0.7 + this.r() * 0.5,
        inner: 0x9a8468,
        edge: 0x6e5c48,
        a0: 0.8,
      })
    }
  }

  // Polvo de las orugas: bocanadas bajas que salen hacia atrás y alguna piedrita del material pisado.
  treadDust(x: number, y: number, back: number): void {
    const t = this.terrain
    const m = t && x >= 0 && x < t.w && y >= 0 && y < t.h ? t.front[Math.round(y) * t.w + Math.round(x)] : 0
    const cols = DEBRIS_COLORS[m] ?? DEBRIS_COLORS[1]
    for (let i = 0; i < 2; i++) {
      const r = 1.2 + this.r() * 1.6
      this.soft({
        x0: x + back * this.r() * 3,
        y0: y - 1 - this.r() * 2,
        vx: back * (12 + this.r() * 22),
        vy: -6 - this.r() * 8,
        drag: 5,
        r0: r * 0.6,
        r1: r * 1.8,
        life: 0.45 + this.r() * 0.35,
        inner: 0xa8927a,
        edge: 0x6e5c48,
        a0: 0.85,
      })
    }
    if (m !== AIR && this.r() < 0.5) {
      this.debris.push({ x, y: y - 1, vx: back * (20 + this.r() * 30), vy: -30 - this.r() * 30, color: cols[Math.floor(this.r() * cols.length)], shape: 0, life: 0.6 + this.r() * 0.4, age: 0, rest: false })
    }
  }

  // Pulido v2: tanque que se desliza. Desde la oruga del lado de avance (x, y = piso) salen terrones del
  // material del piso que saltan hacia adelante y arriba, y una bocanada de polvo que se queda atrás.
  // dir: sentido del deslizamiento (+1 derecha); strong: empujado por una explosión (más violento).
  slideClods(x: number, y: number, dir: number, strong: boolean): void {
    const t = this.terrain
    let m = 0
    if (t) {
      const xi = Math.round(x)
      for (let yy = Math.round(y); yy < Math.round(y) + 4 && !m; yy++) {
        if (xi >= 0 && xi < t.w && yy >= 0 && yy < t.h) m = t.front[yy * t.w + xi]
      }
    }
    const cols = DEBRIS_COLORS[m] ?? DEBRIS_COLORS[1]
    const n = strong ? 2 : 1
    for (let i = 0; i < n; i++) {
      if (m === AIR && this.r() < 0.6) continue
      this.debris.push({
        x: x + dir * this.r() * 2,
        y: y - 1,
        vx: dir * (25 + this.r() * (strong ? 55 : 30)),
        vy: -(35 + this.r() * (strong ? 55 : 30)),
        color: cols[Math.floor(this.r() * cols.length)],
        shape: Math.floor(this.r() * 3), // terrones de 1 a 3 px
        life: 0.5 + this.r() * 0.4,
        age: 0,
        rest: false,
      })
    }
    const r = 1.4 + this.r() * 1.8
    this.soft({
      x0: x,
      y0: y - 1 - this.r() * 2,
      vx: dir * (8 + this.r() * 14),
      vy: -8 - this.r() * 10,
      drag: 4,
      r0: r * 0.6,
      r1: r * (strong ? 2.4 : 2),
      life: 0.5 + this.r() * 0.4,
      inner: 0xa8927a,
      edge: 0x6e5c48,
      a0: 0.85,
    })
  }

  splinters(x: number, y: number, colors: number[], n: number): void {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.1 + this.r() * 0.8)
      const sp = 50 + this.r() * 110
      this.debris.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: colors[i % colors.length], shape: Math.floor(this.r() * 4), life: 1.4 + this.r(), age: 0, rest: false })
    }
  }

  // ---------- lava de muerte súbita (v2) ----------

  // Gotas de lava: chispas que saltan de la superficie y se apagan al volver a caer en ella (lavaY).
  lavaSpray(x: number, y: number, n: number, up = 70): void {
    for (let i = 0; i < n; i++) {
      this.sparks.push({ x: x + (this.r() - 0.5) * 4, y: y - 1, vx: (this.r() - 0.5) * 50, vy: -up * (0.5 + this.r() * 0.7), life: 0.5 + this.r() * 0.5, age: 0 })
    }
  }

  // Salpicadura: goterones de lava (racimo de fuego chico con contorno) que saltan y vuelven a caer en la superficie.
  lavaSplash(x: number, y: number, n: number, up = 90): void {
    for (let i = 0; i < n; i++) {
      const vy = -up * (0.55 + this.r() * 0.6)
      const ay = 300
      const life = (-2 * vy) / ay
      const r1 = 1.1 + this.r() * 1.1
      this.blob({ layer: 1, ox: x + (this.r() - 0.5) * 6, oy: y, vx: (this.r() - 0.5) * 50, vy, ay, r0: r1, r1, grow: 0.001, hold: life * 0.8, life, heat0: -0.15 + this.r() * 0.2, heatV: 0.6, ramp: FIRE, outline: FIRE_OUT })
    }
  }

  // Vapor: bocanadas claras que suben y se abren con el viento.
  steam(x: number, y: number, n: number, spread = 6): void {
    for (let i = 0; i < n; i++) {
      const r = 1.5 + this.r() * 1.5
      this.soft({
        x0: x + (this.r() - 0.5) * spread,
        y0: y - this.r() * 2,
        vx: this.wind * 1.5 + (this.r() - 0.5) * 8,
        vy: -18 - this.r() * 14,
        drag: 1.2,
        r0: r * 0.6,
        r1: r * 2.8,
        life: 1 + this.r() * 0.8,
        inner: 0xf4efe8,
        edge: 0xb4aaa0,
        a0: 0.8,
        keep: 0.3,
      })
    }
  }

  // Proyectil derretido en la superficie: chisporroteo, vapor y un destello chico.
  sizzle(x: number, y: number): void {
    this.lavaSpray(x, y, 12, 110)
    this.lavaSplash(x, y, 4, 100)
    this.steam(x, y - 2, 6, 10)
    this.blob({ layer: 1, ox: x, oy: y - 2, r1: 2.6, life: 0.16, grow: 0.03, hold: 0.06, ramp: FIRE, outline: FIRE_OUT, heat0: -0.2, heatV: 4 })
    this.lights.push({ x, y: y - 3, R: 26, tint: 0xffa040, k: 0.4, life: 0.35, age: 0 })
  }

  // Tanque quemado por la lava (damage con cause 'lava'): chispas, llamitas y humo negro desde el tanque.
  lavaBurn(x: number, y: number): void {
    const cy = y - 8
    for (let i = 0; i < 12; i++) {
      this.sparks.push({ x: x + (this.r() - 0.5) * 22, y: cy + (this.r() - 0.5) * 8, vx: (this.r() - 0.5) * 80, vy: -50 - this.r() * 70, life: 0.4 + this.r() * 0.5, age: 0 })
    }
    for (let i = 0; i < 4; i++) {
      const r1 = 2 + this.r() * 2
      this.blob({ layer: 1, ox: x + (this.r() - 0.5) * 18, oy: cy + (this.r() - 0.5) * 4, vy: -26, vx: this.wind * 1.5, r0: r1 * 0.5, r1, grow: 0.05, hold: 0.15, life: 0.45, delay: i * 0.05, heat0: 0.1 + this.r() * 0.3, heatV: 1.2, ramp: FIRE, outline: FIRE_OUT })
    }
    for (let i = 0; i < 5; i++) {
      const r1 = 4 + this.r() * 3
      this.blob({ layer: 0, ox: x + (this.r() - 0.5) * 14, oy: cy - 4, vy: -18, vx: this.wind * 1.5, ax: this.wind * 0.5, r0: 2, r1, grow: 0.8, hold: 0.8, life: 1.8, delay: 0.05 + i * 0.12, heat0: 0.3 + this.r() * 0.3, heatV: 0.05, ramp: BLACK_SMOKE, outline: BLACK_OUT, fade: true })
    }
    this.steam(x, y - 2, 3, 20)
    this.lights.push({ x, y: cy, R: 30, tint: 0xff8a3a, k: 0.35, life: 0.5, age: 0 })
  }

  // ---------- agua y lava material (v4) ----------

  // Salpicadura: corona de gotas que saltan desde la superficie (y) y un poco de espuma.
  waterSplash(x: number, y: number, n: number, up = 100): void {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (this.r() - 0.5) * 1.9
      const sp = up * (0.45 + this.r() * 0.7)
      this.wdrops.push({ x: x + (this.r() - 0.5) * 6, y: y - 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 1.6, big: this.r() < 0.45 })
    }
    for (let i = 0; i < Math.min(4, 1 + (n >> 2)); i++) {
      const r = 1.4 + this.r() * 1.6
      this.soft({ x0: x + (this.r() - 0.5) * 10, y0: y - 1, vx: (this.r() - 0.5) * 30, vy: -8 - this.r() * 8, drag: 4, r0: r * 0.6, r1: r * 1.6, life: 0.35 + this.r() * 0.25, inner: W_FOAM, edge: W_FOAM_EDGE, a0: 0.85 })
    }
  }

  // Burbujas que suben desde (x, y) hasta la superficie top, repartidas en spread px.
  bubbles(x: number, y: number, n: number, top: number, spread = 10): void {
    for (let i = 0; i < n; i++) {
      this.wbubbles.push({
        x: x + (this.r() - 0.5) * spread * 2,
        y: y + (this.r() - 0.5) * spread,
        vy: -(26 + this.r() * 30),
        top,
        age: -this.r() * 0.5, // no salen todas juntas
        life: 4,
        r: this.r() < 0.3 ? 2 : this.r() < 0.6 ? 1.4 : 1,
        phase: this.r() * 6,
      })
    }
  }

  // Géiser chico: columna de agua que sale de la superficie (explosión sumergida cerca de ella). s ~ radio.
  geyser(x: number, y: number, s: number): void {
    const k = Math.max(0.5, Math.min(2.5, s / 12))
    const n = Math.round(12 + 10 * k)
    for (let i = 0; i < n; i++) {
      const sp = (90 + this.r() * 110) * Math.sqrt(k)
      this.wdrops.push({ x: x + (this.r() - 0.5) * 6 * k, y: y - 1 - this.r() * 3, vx: (this.r() - 0.5) * 36 * k, vy: -sp, age: 0, life: 2, big: this.r() < 0.5 })
    }
    for (let i = 0; i < 4; i++) {
      const r = (2 + this.r() * 2) * k
      this.soft({ x0: x + (this.r() - 0.5) * 6, y0: y - 2, vx: (this.r() - 0.5) * 20, vy: -30 - this.r() * 30 * k, drag: 2.5, r0: r * 0.5, r1: r * 1.4, life: 0.5 + this.r() * 0.4, inner: W_FOAM, edge: W_FOAM_EDGE, a0: 0.8 })
    }
    this.waterSplash(x, y, Math.round(8 * k), 70)
  }

  // Explosión bien sumergida: sin fuego ni humo; un fogonazo blanco azulado ahogado, luz y sacudón.
  // Las burbujas y el géiser los agrega LiquidView.impact.
  underwater(x: number, y: number, radius: number): void {
    const s = Math.max(0.5, radius / 15)
    this.blob({ layer: 4, ox: x, oy: y, r0: 2 * s, r1: 6 * s, grow: 0.03, life: 0.09, ramp: [0xffffff, 0xeef8f4, 0xcfe4dc, 0x8ab8b8], outline: 0x5a8a92, heat0: -0.2 })
    this.blob({ layer: 1, ox: x, oy: y, r0: 3 * s, r1: 9 * s, grow: 0.06, hold: 0.05, life: 0.22, ramp: [0xeef8f4, 0xcfe4dc, 0xb0d4d0, 0x8ab8b8, 0x5a8a92], outline: 0x2c5a66, heat0: 0, heatV: 3 })
    this.lights.push({ x, y, R: 30 + radius * 2, tint: 0xa8e0e0, k: 0.4, life: 0.3, age: 0 })
    this.shake = Math.max(this.shake, 2 + radius * 0.25)
    this.flash = Math.max(this.flash, Math.min(0.25, radius / 120))
  }

  // Espuma en el frente del agua que corre: una bocanada blanca y alguna gotita.
  foam(x: number, y: number): void {
    const r = 1.2 + this.r() * 1.2
    this.soft({ x0: x, y0: y - 1, vx: (this.r() - 0.5) * 16, vy: -6 - this.r() * 6, drag: 4, r0: r * 0.6, r1: r * 1.5, life: 0.3 + this.r() * 0.25, inner: W_FOAM, edge: W_FOAM_EDGE, a0: 0.8 })
    if (this.r() < 0.5) this.wdrops.push({ x, y: y - 1, vx: (this.r() - 0.5) * 50, vy: -30 - this.r() * 40, age: 0, life: 0.8, big: false })
  }

  // Agua y lava hicieron piedra (n celdas): vapor que sale silbando, alguna chispa y una luz chica.
  hiss(x: number, y: number, n: number): void {
    const puffs = Math.min(14, 3 + Math.round(n / 3))
    const spread = Math.min(30, 6 + Math.sqrt(n) * 3)
    this.steam(x, y - 1, puffs, spread)
    for (let i = 0; i < Math.min(6, 1 + (n >> 3)); i++) {
      const r = 2 + this.r() * 2
      this.soft({ x0: x + (this.r() - 0.5) * spread, y0: y - 2, vx: this.wind * 2 + (this.r() - 0.5) * 30, vy: -40 - this.r() * 30, drag: 1.6, r0: r * 0.6, r1: r * 3, life: 1.4 + this.r() * 0.8, inner: 0xf8f4ee, edge: 0xc0b8ae, a0: 0.75, keep: 0.25 })
    }
    this.lavaSpray(x, y, Math.min(8, 2 + (n >> 2)), 60)
    this.lights.push({ x, y: y - 2, R: 22, tint: 0xffa040, k: 0.25, life: 0.3, age: 0 })
  }

  // Tanque apoyado en la lava material: una chispa (y a veces una bocanada de humo negro).
  ember(x: number, y: number, smoke: boolean): void {
    this.sparks.push({ x, y, vx: (this.r() - 0.5) * 40, vy: -40 - this.r() * 50, life: 0.35 + this.r() * 0.4, age: 0 })
    if (smoke) {
      const r1 = 3 + this.r() * 2
      this.blob({ layer: 0, ox: x, oy: y - 4, vy: -16, vx: this.wind * 1.5, ax: this.wind * 0.5, r0: 1.5, r1, grow: 0.6, hold: 0.6, life: 1.4, heat0: 0.3 + this.r() * 0.3, heatV: 0.05, ramp: BLACK_SMOKE, outline: BLACK_OUT, fade: true })
    }
  }

  // ---------- derrumbe (v2.4) ----------

  // Colores del polvo según el material que cae: la tierra en marrón claro, la piedra en gris.
  private collapseDustCols(mat: number): [number, number] {
    return mat === STONE ? [0xa49e92, 0x6a665e] : [0xa8927a, 0x6e5c48]
  }

  // Polvo que se desprende de un borde de lo que cae (x, y = celda del borde). down: borde de abajo (frente
  // de la caída, el polvo sale hacia los costados); si no, borde de arriba (queda flotando detrás).
  collapseDust(x: number, y: number, mat: number, down: boolean): void {
    const [inner, edge] = this.collapseDustCols(mat)
    const r = 1.2 + this.r() * 1.8
    const side = this.r() < 0.5 ? -1 : 1
    this.soft({
      x0: x + (this.r() - 0.5) * 3,
      y0: y,
      vx: side * (down ? 14 + this.r() * 22 : 3 + this.r() * 8) + this.wind,
      vy: down ? -4 - this.r() * 8 : -3 - this.r() * 5,
      drag: 3,
      r0: r * 0.6,
      r1: r * (down ? 2 : 1.6),
      life: 0.6 + this.r() * 0.5,
      inner,
      edge,
      a0: 0.75,
    })
  }

  // Piedrita o terrón suelto que se cae del bloque y rebota en el piso (la física de los escombros).
  collapsePebble(x: number, y: number, mat: number, vx: number, vy: number): void {
    const cols = DEBRIS_COLORS[mat] ?? DEBRIS_COLORS[1]
    this.debris.push({ x, y, vx, vy, color: cols[Math.floor(this.r() * cols.length)], shape: Math.floor(this.r() * (mat === STONE ? 4 : 3)), life: 1 + this.r() * 0.8, age: 0, rest: false })
  }

  // Nube de polvo al asentarse el derrumbe: bocanadas apoyadas en el piso a lo ancho de lo que cayó
  // (x0..x1, y = fila de abajo de lo que llegó), más grande cuantas más celdas se movieron, terrones que
  // rebotan y, si fue grande, polvo que sube y un sacudón chico.
  settleCloud(x0: number, x1: number, y: number, cells: number, mat: number): void {
    const [inner, edge] = this.collapseDustCols(mat)
    const k = Math.min(2.2, 0.7 + Math.sqrt(cells) / 30)
    const n = Math.max(3, Math.min(20, Math.round(3 + Math.sqrt(cells) * 0.5)))
    const cx = (x0 + x1) / 2
    const half = Math.max(4, (x1 - x0) / 2)
    const puffHi = mat === STONE ? 0xb8b6ae : PUFF_MID
    const puffEdge = mat === STONE ? 0x908c84 : PUFF_EDGE
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const x = cx + side * this.r() * (half + 6)
      // la bocanada se apoya en lo que haya debajo (el montón recién asentado o el piso de al lado)
      const gy = this.groundY(x, y - 24)
      const fy = gy >= 0 && gy < y + 12 ? gy : y
      const rr = (2.5 + this.r() * 3) * k
      this.soft({
        x0: x,
        y0: fy,
        vx: side * (16 + this.r() * 34) * Math.sqrt(k),
        vy: -(1 + this.r() * 3),
        drag: 2.6,
        r0: rr * 0.8,
        r1: rr * 1.8,
        life: 0.9 + this.r() * 0.7 + k * 0.3,
        inner: puffHi,
        edge: puffEdge,
        a0: 0.85,
        keep: 0.3,
        puff: 0.55 + this.r() * 0.15,
      })
    }
    // polvo suelto que se levanta un poco más
    for (let i = 0; i < Math.round(n * 0.6); i++) {
      const r = (1.5 + this.r() * 2) * k
      this.soft({ x0: cx + (this.r() - 0.5) * 2 * half, y0: y - 2 - this.r() * 4, vx: (this.r() - 0.5) * 30 + this.wind, vy: -8 - this.r() * 14, drag: 2, r0: r * 0.6, r1: r * 2, life: 1 + this.r() * 0.8, inner, edge, a0: 0.7, keep: 0.2 })
    }
    // derrumbe grande: algunas nubecitas con contorno que suben despacio, repartidas a lo ancho
    if (cells >= 400) {
      const nb = Math.min(6, Math.round(cells / 400))
      for (let i = 0; i < nb; i++) {
        const r1 = 3 + this.r() * 2.5
        const bx = cx + ((i + 0.5) / nb - 0.5) * 2 * half + (this.r() - 0.5) * 8
        this.blob({ layer: 0, ox: bx, oy: y - 4, vy: -7 - this.r() * 5, vx: this.wind * 1.5, ax: this.wind * 0.5, r0: 1.5, r1, grow: 0.6, hold: 0.6, life: 1.5 + this.r() * 0.5, delay: 0.05 + i * 0.04, heat0: 0.35 + this.r() * 0.3, heatV: 0.05, ramp: DUST, outline: 0x3c2e22, fade: true })
      }
    }
    const pebbles = Math.min(18, 3 + Math.round(cells / 50))
    for (let i = 0; i < pebbles; i++) {
      const side = i % 2 === 0 ? -1 : 1
      this.collapsePebble(cx + side * this.r() * half, y - 2, mat, side * (20 + this.r() * 60), -(40 + this.r() * 80))
    }
    if (cells >= 300) this.shake = Math.max(this.shake, Math.min(4.5, 1.5 + cells / 500))
    this.capParticles()
  }

  // Tanque aplastado por un derrumbe (damage con cause 'collapse'): polvo del material sobre el casco y chispas
  // del metal golpeado.
  crushed(x: number, y: number, mat: number): void {
    const [inner, edge] = this.collapseDustCols(mat)
    const cy = y - 10
    for (let i = 0; i < 10; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const r = 2 + this.r() * 2.5
      this.soft({ x0: x + side * this.r() * 14, y0: cy + (this.r() - 0.5) * 8, vx: side * (14 + this.r() * 34), vy: -6 - this.r() * 14, drag: 3, r0: r * 0.6, r1: r * 2, life: 0.8 + this.r() * 0.6, inner, edge, a0: 0.85, keep: 0.2 })
    }
    for (let i = 0; i < 10; i++) {
      this.sparks.push({ x: x + (this.r() - 0.5) * 22, y: cy + (this.r() - 0.5) * 6, vx: (this.r() - 0.5) * 120, vy: -40 - this.r() * 70, life: 0.25 + this.r() * 0.35, age: 0 })
    }
    // terrones que saltan del casco y otros que siguen cayendo encima
    for (let i = 0; i < 6; i++) this.collapsePebble(x + (this.r() - 0.5) * 20, cy - 4, mat, (this.r() - 0.5) * 80, -(30 + this.r() * 60))
    for (let i = 0; i < 4; i++) this.collapsePebble(x + (this.r() - 0.5) * 24, cy - 14 - this.r() * 10, mat, (this.r() - 0.5) * 20, 20 + this.r() * 30)
    this.lights.push({ x, y: cy, R: 20, tint: 0xffd080, k: 0.25, life: 0.12, age: 0 })
    this.shake = Math.max(this.shake, 3)
    this.capParticles()
  }

  // ---------- abismo (v3) ----------

  // Tanque que llegó al fondo del abismo: destello lejano, chico y anaranjado, que titila dos veces.
  abyssFlash(x: number, y: number): void {
    this.lights.push({ x, y, R: 44, tint: 0xff7a2a, k: 0.32, life: 0.7, age: 0 })
    this.blob({ layer: 1, ox: x, oy: y, r1: 2.6, life: 0.22, grow: 0.03, hold: 0.06, ramp: FIRE, outline: FIRE_OUT, heat0: 0, heatV: 3 })
    this.later(0.18, () => {
      this.lights.push({ x: x + (this.r() - 0.5) * 8, y: y - 2, R: 30, tint: 0xff9a40, k: 0.22, life: 0.45, age: 0 })
      this.blob({ layer: 1, ox: x + (this.r() - 0.5) * 6, oy: y - 2, r1: 1.8, life: 0.16, grow: 0.03, hold: 0.04, ramp: FIRE, outline: FIRE_OUT, heat0: 0.1, heatV: 3 })
    })
  }

  // Columna de humo que sube desde el fondo del abismo durante unos segundos.
  abyssSmoke(x: number, y: number, seconds: number): void {
    const n = Math.round(seconds / 0.16)
    for (let i = 0; i < n; i++) {
      this.later(i * 0.16, () => {
        const r1 = 4 + this.r() * 3
        this.blob({ layer: 0, ox: x + (this.r() - 0.5) * 10, oy: y, vy: -40 - this.r() * 12, vx: this.wind * 1.5, ax: this.wind * 0.6, r0: 2, r1, grow: 0.8, hold: 1.8, life: 3.4, heat0: 0.25 + this.r() * 0.3, heatV: 0.04, ramp: SMOKE, outline: SMOKE_OUT, fade: true })
      })
    }
  }

  // ¿El punto quedó debajo de la superficie de la lava? (lo que cae ahí se derrite y desaparece)
  private sunk(y: number): boolean {
    return this.lavaY !== null && y > this.lavaY + 1
  }

  wreck(id: number): void {
    if (this.emitters.some((e) => e.kind === 'wreck' && e.id === id)) return
    this.emitters.push({ kind: 'wreck', id, x: 0, y: 0, w: 0, life: Infinity, age: 0, accA: 0, accB: 0 })
  }

  clearWrecks(): void {
    this.emitters = this.emitters.filter((e) => e.kind !== 'wreck')
  }

  // Franja de napalm. Mientras siguen llegando eventos, el fuego vecino no se apaga.
  burn(x: number, y: number, w: number, seconds = WEAPONS.napalm.burn ?? 3): void {
    const flames = seconds + 0.4 + this.r() * 0.3
    for (const e of this.emitters) {
      if (e.kind !== 'burn' || e.end === undefined || e.age >= e.end) continue
      if (e.x > x + w + 60 || e.x + e.w < x - 60) continue
      e.end = Math.max(e.end, e.age + 1.2)
      e.life = e.end + BURN_TAIL
    }
    this.emitters.push({ kind: 'burn', x, y, w: Math.max(2, w), life: flames + BURN_TAIL, end: flames, age: 0, accA: 0, accB: 0, surf: this.surface(x, y, Math.max(2, w)) })
  }

  private surface(x: number, y: number, w: number): number[] {
    const out: number[] = []
    for (let i = 0; i < w; i++) {
      let fy = y - 14
      while (fy < y + 24 && !this.solid(x + i, fy + 1)) fy++
      out.push(fy)
    }
    return out
  }

  // dirX/dirY: dirección del proyectil al llegar (la excavadora cava hacia ahí).
  explosion(style: BlastStyle, x: number, y: number, radius: number, debris: Partial<Record<number, number>>, dirX = 0, dirY = 1): void {
    const s = Math.max(0.5, radius / 15)
    switch (style) {
      case 'bigfire':
        this.fire(x, y, s, 1.5, debris, 1.6)
        for (let i = 0; i < 3; i++) {
          const ox = (this.r() < 0.5 ? -1 : 1) * (10 + this.r() * 16) * s
          const oy = -(this.r() * 14) * s
          this.later(0.08 + i * 0.07 + this.r() * 0.05, () => this.fire(x + ox, y + oy, s * 0.45, 0.9, {}, 0.3, true))
        }
        this.kick(Math.min(12, 3 + radius * 0.3), 0.5, 0.07)
        break
      case 'dirt':
        this.dirt(x, y, s, debris, 1)
        this.kick(Math.min(5, 1.5 + radius * 0.12), 0.06, 0.03)
        break
      case 'dig':
        this.dig(x, y, dirX, dirY, debris)
        this.kick(3, 0.08, 0.02)
        break
      case 'napalm':
        this.fire(x, y, s * 0.85, 1.1, debris, 0.5, false, BLACK_SMOKE, BLACK_OUT)
        this.gel(x, y - 4, s)
        this.kick(Math.min(8, 2 + radius * 0.25), 0.35, 0.05)
        break
      case 'nuke':
        this.nuke(x, y, s, debris)
        this.kick(18, 1.6, 0.18)
        break
      default:
        this.fire(x, y, s, 1, debris, 1)
        this.kick(Math.min(9, 2 + radius * 0.3), 0.3, 0.035)
    }
    this.capParticles()
  }

  private kick(shake: number, flash: number, stop: number): void {
    this.shake = Math.max(this.shake, shake)
    this.flash = Math.max(this.flash, flash)
    this.hitStop = Math.max(this.hitStop, stop)
  }

  private later(dt: number, run: () => void): void {
    this.delayed.push({ at: this.time + dt, run })
  }

  private pickDebrisColor(debris: Partial<Record<number, number>>, fallback: number[]): () => number {
    const entries = Object.entries(debris)
      .map(([k, v]) => [Number(k), v ?? 0] as const)
      .filter(([, v]) => v > 0)
    const total = entries.reduce((a, [, v]) => a + v, 0)
    return () => {
      if (total <= 0) return fallback[Math.floor(this.r() * fallback.length)]
      let pick = this.r() * total
      for (const [m, v] of entries) {
        pick -= v
        if (pick <= 0) {
          const cols = DEBRIS_COLORS[m] ?? fallback
          return cols[Math.floor(this.r() * cols.length)]
        }
      }
      return fallback[0]
    }
  }

  private throwDebris(x: number, y: number, s: number, debris: Partial<Record<number, number>>, factor: number): void {
    const total = Object.values(debris).reduce<number>((a, v) => a + (v ?? 0), 0)
    const n = Math.round(Math.max(14, Math.min(70, total / 6)) * factor)
    const color = this.pickDebrisColor(debris, DEBRIS_COLORS[1])
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.05 + this.r() * 0.9)
      const sp = (80 + this.r() * 170) * Math.sqrt(s)
      this.debris.push({
        x: x + Math.cos(a) * 3,
        y: y - 4,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        color: color(),
        shape: Math.floor(this.r() * 4),
        life: 1.6 + this.r() * 1.8,
        age: 0,
        rest: false,
      })
    }
  }

  private fire(x: number, y: number, s: number, L: number, debris: Partial<Record<number, number>>, amount: number, mini = false, smokeRamp = SMOKE, smokeOut = SMOKE_OUT): void {
    const cx = x
    const cy = y - 8 * s
    const r = () => this.r()
    const wsign = this.wind === 0 ? 1 : Math.sign(this.wind)

    // columna de humo (se dibuja al revés: las de arriba primero)
    if (!mini || r() < 0.7) {
      const n = mini ? 5 : 16
      const smoke: Blob[] = []
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        const fx = cx + (r() - 0.5) * 34 * s * (0.5 + t) + t * 12 * s * wsign
        const fy = cy - 22 * s - t * 50 * s + (r() - 0.5) * 8 * s
        const r1 = (8 + r() * 6 + t * 5) * s
        const grow = (0.12 + t * 0.16) * L
        const hold = grow + (0.7 + r() * 0.6) * L
        smoke.push({
          layer: 0,
          ox: cx,
          oy: cy - 6 * s,
          dx: fx - cx,
          dy: fy - cy + 6 * s,
          vx: this.wind * 1.2,
          vy: -(5 + r() * 6) * s,
          ax: this.wind * 0.8,
          ay: 0,
          r0: r1 * 0.5,
          r1,
          grow,
          hold,
          life: hold + (0.8 + r() * 0.6) * L,
          delay: t * 0.04,
          heat0: 0.15 + r() * 0.3,
          heatV: 0.04,
          cool: 0,
          ramp: smokeRamp,
          outline: smokeOut,
          fade: true,
          age: 0,
        })
      }
      this.blobs.push(...smoke.reverse())
    }

    // bola de fuego en racimo
    const fire: Blob[] = []
    const nf = mini ? 6 : 16
    for (let i = 0; i < nf; i++) {
      const a = r() * Math.PI * 2
      const d = Math.sqrt(r()) * (mini ? 24 : 28) * s
      const r1 = (mini ? 5 + r() * 8 : 6 + r() * 9) * s
      const hold = (0.55 + r() * 0.15) * L
      fire.push({
        layer: 1,
        ox: cx,
        oy: cy - 6 * s,
        dx: Math.cos(a) * d * 1.1,
        dy: Math.sin(a) * d * 0.8 - 6 * s,
        vx: 0,
        vy: -14 * s,
        ax: this.wind * 0.5,
        ay: 0,
        r0: r1 * 0.4,
        r1,
        grow: 0.07 * L,
        hold,
        life: hold + (0.2 + r() * 0.12) * L,
        delay: 0,
        heat0: 0.05 + d / (60 * s),
        heatV: 0.75 / L,
        cool: 0.55 * L,
        ramp: FIRE,
        outline: FIRE_OUT,
        fade: false,
        age: 0,
      })
    }
    fire.push({ ...fire[0], dx: 0, dy: -2 * s, r1: (mini ? 12 : 14) * s, r0: 6 * s, heat0: -0.2, hold: 0.65 * L, life: 0.85 * L })
    fire.sort((a, b) => b.heat0 - a.heat0)
    this.blobs.push(...fire)

    // núcleo blanco y flash de 2-3 frames
    const core: [number, number, number, number][] = [
      [-3, -12, 9, -0.45],
      [6, -6, 7, -0.4],
      [-8, -2, 6, -0.3],
      [1, -7, 6, -0.5],
    ]
    for (const [ox, oy, rr, h] of core) {
      this.blob({ layer: 2, ox: cx + ox * s, oy: cy + oy * s, r0: rr * s * 0.5, r1: rr * s, grow: 0.04, hold: 0.7 * L, life: 0.95 * L, heat0: h, heatV: 0.9 / L, cool: 0.6 * L, ramp: CORE, outline: 0xffb43e, vy: -6 * s })
    }
    if (!mini) {
      this.blob({ layer: 4, ox: cx, oy: cy - 6 * s, r0: 12 * s, r1: 18 * s, grow: 0.02, life: 0.034, ramp: FLASH, outline: 0xfff1a8, heat0: -0.6 })
    }

    // bocanadas calientes
    const np = mini ? 3 : 9
    for (let i = 0; i < np; i++) {
      const a = -Math.PI * (0.15 + r() * 0.7)
      const d = (26 + r() * 14) * s
      const rr = (2.5 + r() * 3) * s
      this.blob({
        layer: 3,
        ox: cx,
        oy: cy - 8 * s,
        dx: Math.cos(a) * d,
        dy: Math.sin(a) * d * 0.9,
        vy: -8,
        r0: rr * 0.4,
        r1: rr,
        grow: 0.12 * L,
        hold: 0.55 * L,
        life: 0.8 * L,
        heat0: 0.1 + r() * 0.25,
        heatV: 1.0 / L,
        cool: 0.5 * L,
        ramp: FIRE,
        outline: FIRE_OUT,
      })
    }

    if (mini) {
      this.lights.push({ x: cx, y: cy, R: 40 * s, tint: 0xff8a3a, k: 0.35, life: 0.3, age: 0 })
      return
    }

    // polvo de suelo: bocanadas claras de 3 tamaños que se abren a los costados al ras del piso
    // (grandes cerca del centro y lentas, chicas más lejos y rápidas)
    const tiers: [number, number, number, number][] = [
      // radio, variación, cantidad, velocidad lateral
      [2.2, 1.2, 8, 150],
      [4.2, 1.4, 6, 110],
      [7, 1.8, 4, 70],
    ]
    let k = 0
    for (let ti = 0; ti < tiers.length; ti++) {
      const [rb, rv, n, v] = tiers[ti]
      for (let i = 0; i < n; i++, k++) {
        const side = k % 2 === 0 ? -1 : 1
        const rr = (rb + r() * rv) * s
        this.soft({
          x0: cx + side * (4 + r() * 10) * s,
          y0: y,
          vx: side * (v * (0.6 + r() * 0.6)) * Math.sqrt(s),
          vy: -(1 + r() * 3) * (ti + 1),
          drag: 2.6,
          r0: rr * 0.9,
          r1: rr * 1.8,
          life: (0.9 + r() * 0.5 + ti * 0.4) * L,
          inner: PUFF_MID,
          edge: PUFF_EDGE,
          a0: 0.9,
          keep: 0.3,
          puff: 0.55 + r() * 0.15,
        })
      }
    }

    this.throwDebris(x, y, s, debris, amount)

    // pedazos en llamas con estela fina: 2 a un lado y 1 al otro (look-test)
    const sc = Math.min(s, 1.3)
    const side = r() < 0.5 ? -1 : 1
    const lone = Math.floor(r() * 3)
    for (let i = 0; i < 3; i++) {
      const far = i === lone
      const dx = (far ? -side : side) * (far ? 30 + r() * 15 : 40 + r() * 60) * sc
      const peak = (far ? 95 + r() * 20 : 40 + r() * 55) * sc
      const dur = 0.28 + r() * 0.06
      this.chunks.push({ x: cx, y: cy - 12 * s, ox: cx, oy: cy - 12 * s, dx, peak, dur, t: 0.1, vx: 0, vy: 0, life: dur + 0.5, age: 0, pts: [], done: false })
    }

    // chispas
    const ns = Math.round(40 * amount)
    for (let i = 0; i < ns; i++) {
      const a = -Math.PI * r()
      const sp = (120 + r() * 260) * Math.sqrt(s)
      this.sparks.push({ x: cx, y: cy - 8 * s, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25 + r() * 0.4, age: 0 })
    }

    this.lights.push({ x: cx, y: y - 14 * s, R: 66 * s, tint: 0xff8a3a, k: 0.55, life: 0.75 * L, age: 0 })
    this.lights.push({ x: cx, y: cy, R: 80 * s, tint: 0xfff0c0, k: 0.45, life: 0.08, age: 0 })
  }

  private dirt(x: number, y: number, s: number, debris: Partial<Record<number, number>>, amount: number): void {
    const cx = x
    const cy = y - 6 * s
    const r = () => this.r()
    const clods: Blob[] = []
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI * (0.1 + r() * 0.8)
      const d = Math.sqrt(r()) * 22 * s
      const r1 = (4 + r() * 6) * s
      clods.push({
        layer: 1,
        ox: cx,
        oy: cy,
        dx: Math.cos(a) * d * 1.2,
        dy: Math.sin(a) * d,
        vx: 0,
        vy: 6,
        ax: 0,
        ay: 30,
        r0: r1 * 0.4,
        r1,
        grow: 0.12,
        hold: 0.3 + r() * 0.2,
        life: 0.7 + r() * 0.3,
        delay: 0,
        heat0: 0.1 + d / (70 * s),
        heatV: 0.3,
        cool: 0,
        ramp: DIRT_RAMP,
        outline: 0x140c08,
        fade: false,
        age: 0,
      })
    }
    clods.sort((a, b) => b.heat0 - a.heat0)
    this.blobs.push(...clods)
    for (let i = 0; i < 8; i++) {
      const t = i / 7
      const r1 = (5 + r() * 5 + t * 3) * s
      this.blob({
        layer: 0,
        ox: cx,
        oy: cy,
        dx: (r() - 0.5) * 40 * s,
        dy: -(8 + t * 26) * s,
        vx: this.wind * 1.5,
        vy: -4 * s,
        ax: this.wind,
        r0: r1 * 0.4,
        r1,
        grow: 0.35 + t * 0.3,
        hold: 0.9 + r() * 0.4,
        life: 1.8 + r() * 0.6,
        delay: 0.02 + t * 0.04,
        heat0: 0.1 + r() * 0.3,
        heatV: 0.05,
        ramp: DUST,
        outline: 0x3c2e22,
        fade: true,
      })
    }
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const rr = (3 + r() * 4) * s
      this.soft({ x0: cx, y0: y - r() * 3, vx: side * (20 + r() * 30) * s * 4, vy: -r() * 8, drag: 4, r0: rr * 0.5, r1: rr * 1.4, life: 1.2 + r() * 0.6, inner: 0xa89070, edge: 0x7a6650, a0: 0.85 })
    }
    const d = Object.keys(debris).length ? debris : { 1: 60 }
    this.throwDebris(x, y, s, d, amount)
  }

  // Gotas de gel encendido: vuelan, dejan humo negro y al caer prenden un fueguito.
  private gel(x: number, y: number, s: number): void {
    const n = Math.round(8 + 4 * s)
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.12 + this.r() * 0.76)
      const sp = (70 + this.r() * 90) * Math.sqrt(s)
      this.drops.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 2, acc: 0 })
    }
  }

  private flame(x: number, y: number, w: number, end: number): void {
    this.emitters.push({ kind: 'burn', x, y, w, life: end + BURN_TAIL * 0.6, end, age: 0, accA: 0, accB: 0, surf: this.surface(x, y, w) })
  }

  private burnK(e: Emitter): number {
    const end = e.end ?? e.life
    if (e.age < 0.15) return e.age / 0.15
    return Math.max(0, Math.min(1, end - e.age))
  }

  // Excavadora: chispas y polvo en la boca, la mecha recorre el túnel escupiendo chispas y sale polvo por la boca.
  private dig(x: number, y: number, dirX: number, dirY: number, debris: Partial<Record<number, number>>): void {
    const d = Math.hypot(dirX, dirY) || 1
    const dx = dirX / d
    const dy = dirY / d
    this.dirt(x, y, 0.5, debris, 0.45)
    const back = Math.atan2(-dy, -dx)
    for (let i = 0; i < 28; i++) {
      const a = back + (this.r() - 0.5) * 2.4
      const sp = 90 + this.r() * 170
      this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.25 + this.r() * 0.35, age: 0 })
    }
    this.blob({ layer: 4, ox: x, oy: y, r0: 4, r1: 6, grow: 0.02, life: 0.05, ramp: FLASH, outline: 0xffb43e, heat0: -0.5 })
    this.lights.push({ x, y, R: 36, tint: 0xffb04a, k: 0.45, life: 0.25, age: 0 })
    this.emitters.push({ kind: 'drill', x, y, w: 0, dx, dy, life: DIG_TIME, age: 0, accA: 0, accB: 0 })
    this.emitters.push({ kind: 'mouth', x, y, w: 0, life: 2.2, age: 0, accA: 0, accB: 0 })
    const ex = x + dx * DIG_LEN
    const ey = y + dy * DIG_LEN
    this.later(DIG_TIME, () => {
      for (let i = 0; i < 16; i++) {
        const a = this.r() * Math.PI * 2
        const sp = 40 + this.r() * 110
        this.sparks.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.2 + this.r() * 0.3, age: 0 })
      }
      for (let i = 0; i < 6; i++) {
        const r1 = 3 + this.r() * 3
        this.soft({ x0: ex + (this.r() - 0.5) * 8, y0: ey + (this.r() - 0.5) * 8, vx: (this.r() - 0.5) * 20, vy: -6, drag: 3, r0: r1 * 0.5, r1, life: 1.4 + this.r() * 0.6, inner: 0xa89070, edge: 0x6e5c48, a0: 0.6 })
      }
      this.lights.push({ x: ex, y: ey, R: 28, tint: 0xffb04a, k: 0.4, life: 0.2, age: 0 })
      this.shake = Math.max(this.shake, 2.5)
    })
  }

  private updateDrill(e: Emitter): void {
    const dx = e.dx ?? 0
    const dy = e.dy ?? 1
    const back = Math.atan2(-dy, -dx)
    while (e.accA >= 0.016) {
      e.accA -= 0.016
      const u = Math.min(1, e.age / DIG_TIME)
      const hx = e.x + dx * DIG_LEN * u
      const hy = e.y + dy * DIG_LEN * u
      for (let i = 0; i < 3; i++) {
        const a = back + (this.r() - 0.5) * 2.6
        const sp = 60 + this.r() * 120
        this.sparks.push({ x: hx, y: hy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.15 + this.r() * 0.25, age: 0 })
      }
      this.blob({ layer: 1, ox: hx + (this.r() - 0.5) * 3, oy: hy + (this.r() - 0.5) * 3, r0: 1.5, r1: 2 + this.r() * 1.5, grow: 0.02, hold: 0.04, life: 0.12, heat0: -0.1, heatV: 3, ramp: FIRE, outline: FIRE_OUT })
      const r1 = 2.5 + this.r() * 2.5
      this.soft({ x0: hx + (this.r() - 0.5) * 6, y0: hy + (this.r() - 0.5) * 6, vx: -dx * 10, vy: -dy * 10 - 3, drag: 2, r0: r1 * 0.5, r1, life: 1.1 + this.r() * 0.7, keep: 0.3, inner: 0x9a8468, edge: 0x6e5c48, a0: 0.55 })
      if (this.r() < 0.35) {
        const cols = DEBRIS_COLORS[1]
        const a = back + (this.r() - 0.5) * 1.6
        const sp = 60 + this.r() * 80
        this.debris.push({ x: hx, y: hy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: cols[Math.floor(this.r() * cols.length)], shape: Math.floor(this.r() * 2), life: 0.8 + this.r() * 0.6, age: 0, rest: false })
      }
      this.lights.push({ x: hx, y: hy, R: 22, tint: 0xffb04a, k: 0.35, life: 0.05, age: 0 })
    }
    this.shake = Math.max(this.shake, 1.4)
  }

  private updateMouth(e: Emitter): void {
    const k = 1 - e.age / e.life
    const iv = 0.07 + (1 - k) * 0.12
    while (e.accA >= iv) {
      e.accA -= iv
      const r1 = (3 + this.r() * 3) * (0.6 + 0.4 * k)
      this.blob({ layer: 0, ox: e.x + (this.r() - 0.5) * 8, oy: e.y - 2, vx: this.wind * 1.5 + (this.r() - 0.5) * 8, vy: -(10 + this.r() * 10), ax: this.wind * 0.6, r0: r1 * 0.5, r1, grow: 0.5, hold: 0.6, life: 1.5 + this.r() * 0.5, heat0: 0.15 + this.r() * 0.3, heatV: 0.05, ramp: DUST, outline: 0x3c2e22, fade: true })
    }
  }

  private updateBurn(e: Emitter, dt: number): void {
    if (Math.floor(e.age / 0.3) !== Math.floor((e.age - dt) / 0.3)) e.surf = this.surface(e.x, e.y, e.w)
    const surf = e.surf ?? [e.y]
    const k = this.burnK(e)
    const end = e.end ?? e.life
    while (e.accA >= 0.035) {
      e.accA -= 0.035
      if (k <= 0) continue
      const n = Math.max(1, Math.round((e.w / 5) * (0.4 + 0.6 * k)))
      for (let j = 0; j < n; j++) {
        const i = Math.floor(this.r() * surf.length)
        const fx = e.x + i
        const fy = surf[i]
        const r1 = (1.8 + this.r() * 2.4) * (0.45 + 0.55 * k)
        // lengua: sube rápido, se achica y se enfría a rojo
        this.blob({ layer: 1, ox: fx, oy: fy - 1, vx: this.wind * 2 + (this.r() - 0.5) * 10, vy: -(34 + this.r() * 44) * (0.5 + 0.5 * k), r0: r1 * 0.8, r1, grow: 0.04, hold: 0.1 + this.r() * 0.14, life: 0.34 + this.r() * 0.3, heat0: 0.02 + this.r() * 0.25, heatV: 1.5, ramp: FIRE, outline: FIRE_OUT })
        if (this.r() < 0.45) this.blob({ layer: 2, ox: fx + (this.r() - 0.5) * 3, oy: fy - 1, r0: 1, r1: (1.4 + this.r() * 1.4) * k, grow: 0.03, hold: 0.06, life: 0.16, heat0: -0.3, heatV: 2, ramp: CORE, outline: 0xffb43e })
        if (this.r() < 0.12) this.sparks.push({ x: fx, y: fy - 4, vx: (this.r() - 0.5) * 30 + this.wind * 3, vy: -(70 + this.r() * 70), life: 0.4 + this.r() * 0.4, age: 0 })
      }
    }
    const tail = e.age > end
    const iv = tail ? 0.24 : 0.1
    while (e.accB >= iv) {
      e.accB -= iv
      const i = Math.floor(this.r() * surf.length)
      const r1 = tail ? 3 + this.r() * 2 : (4.5 + this.r() * 3.5) * (0.6 + 0.4 * k)
      this.blob({ layer: 0, ox: e.x + i, oy: surf[i] - 8, vx: this.wind * 1.5, vy: -(16 + this.r() * 8), ax: this.wind * 0.6, r0: 2, r1, grow: 0.7, hold: 0.9, life: 2.1 + this.r() * 0.6, heat0: tail ? 0.2 : 0.1 + this.r() * 0.25, heatV: 0.05, ramp: tail ? SMOKE : BLACK_SMOKE, outline: tail ? SMOKE_OUT : BLACK_OUT, fade: true })
    }
  }

  // Nuke: flash total, onda en anillo, bola de fuego que sube y se vuelve hongo de humo, luz naranja en toda la pantalla.
  private nuke(x: number, y: number, s: number, debris: Partial<Record<number, number>>): void {
    const r = () => this.r()
    const wind = this.wind
    const top = Math.max(36, y - 175)
    const rise = top - y
    this.flashColor = 0xffffff
    this.glow = 1
    this.glowColor = 0xff7a2a

    this.fire(x, y, s * 0.7, 2.2, debris, 2.6)
    this.rings.push({ x, y: y - 6, R: 360, w: 5, life: 0.75, age: 0, delay: 0, acc: 0 })
    this.rings.push({ x, y: y - 6, R: 220, w: 3, life: 0.6, age: 0, delay: 0.14, acc: 0 })

    // tallo: columna que sube desde el cráter; fuego adentro, humo por fuera
    for (let i = 0; i < 16; i++) {
      const t = i / 15
      const r1 = 9 + t * 5 + r() * 4
      const grow = 0.5 + t * 1.6
      this.blob({ layer: 0, ox: x + (r() - 0.5) * 6, oy: y - 6, dx: (r() - 0.5) * 8, dy: rise * t * 0.92, vx: wind * 1.2, ax: wind * 0.4, r0: 5, r1, grow, hold: grow + 2.4, life: grow + 4.2 + r(), heat0: 0.2 + r() * 0.2, heatV: 0.03, ramp: SMOKE, outline: SMOKE_OUT, fade: true })
      if (i % 2 === 0) this.blob({ layer: 1, ox: x, oy: y - 6, dx: (r() - 0.5) * 4, dy: rise * t * 0.85, vx: wind, r0: 3, r1: r1 * 0.55, grow, hold: grow + 0.6, life: grow + 1.3, heat0: -0.1 + t * 0.2, heatV: 0.35, cool: grow, ramp: FIRE, outline: FIRE_OUT })
    }

    // sombrero: anillo aplastado; primero fuego, después humo que queda
    const cap: Blob[] = []
    const smokeCap: Blob[] = []
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + r() * 0.2
      const ring = i < 14
      const rx = ring ? 46 + r() * 10 : r() * 30
      const ry = ring ? 15 + r() * 5 : r() * 12
      const dx = Math.cos(a) * rx
      const dy = rise + Math.sin(a) * ry - (ring ? 0 : 8)
      const r1 = (ring ? 13 : 16) + r() * 8
      cap.push({ layer: 1, ox: x, oy: y - 10, dx, dy, vx: wind, vy: -3, ax: 0, ay: 0, r0: 6, r1, grow: 2.1, hold: 2.3 + r() * 0.4, life: 3.3 + r() * 0.4, delay: 0.05, heat0: 0.05 + (ring ? 0.2 : 0) + r() * 0.15, heatV: 0.2, cool: 0.8, ramp: FIRE, outline: FIRE_OUT, fade: false, age: 0 })
      smokeCap.push({ layer: 0, ox: x, oy: y - 10, dx: dx * 1.15, dy: dy - 6, vx: wind * 1.5, vy: -3, ax: wind * 0.5, ay: 0, r0: 4, r1: r1 * 1.25, grow: 2.3, hold: 4.2, life: 6.2 + r(), delay: 0.1, heat0: 0.1 + r() * 0.3, heatV: 0.04, cool: 0, ramp: SMOKE, outline: SMOKE_OUT, fade: true, age: 0 })
    }
    cap.sort((p, q) => q.heat0 - p.heat0)
    this.blobs.push(...smokeCap, ...cap)
    for (let i = 0; i < 5; i++) {
      this.blob({ layer: 2, ox: x + (r() - 0.5) * 30, oy: y - 12, dy: rise + (r() - 0.5) * 10, r0: 5, r1: 9 + r() * 4, grow: 2.0, hold: 1.2, life: 1.8, heat0: -0.4, heatV: 0.5, cool: 0.6, ramp: CORE, outline: 0xffb43e, delay: 0.05 })
    }

    // falda de polvo al ras del piso, rápida hacia los dos lados
    for (let i = 0; i < 26; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const rr = 5 + r() * 7
      this.soft({ x0: x + side * r() * 20, y0: y - r() * 6, vx: side * (160 + r() * 260), vy: -4 - r() * 16, drag: 1.8, r0: rr * 0.5, r1: rr * 1.8, life: 2.2 + r() * 1.2, keep: 0.3, inner: 0xa89070, edge: 0x6e5c48, a0: 0.85 })
    }

    // explosiones secundarias alrededor
    for (let i = 0; i < 6; i++) {
      const ox = (r() - 0.5) * 120
      const oy = -r() * 50
      const k = 0.55 + r() * 0.3
      this.later(0.12 + i * 0.09 + r() * 0.06, () => {
        this.fire(x + ox, y + oy, k, 0.9, {}, 0.3, true)
        this.shake = Math.max(this.shake, 5)
      })
    }
    for (let i = 0; i < 90; i++) {
      const a = -Math.PI * r()
      const sp = 200 + r() * 420
      this.sparks.push({ x, y: y - 20, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + r() * 0.7, age: 0 })
    }
    this.lights.push({ x, y: y - 40, R: 300, tint: 0xff9a4a, k: 0.8, life: 3.2, age: 0 })
    this.lights.push({ x, y: y - 30, R: 420, tint: 0xfff0c0, k: 0.7, life: 0.25, age: 0 })
    this.later(0.6, () => this.lights.push({ x, y: top, R: 140, tint: 0xff8a3a, k: 0.5, life: 2.4, age: 0 }))
  }

  private groundY(x: number, from: number): number {
    const t = this.terrain
    x = Math.round(x)
    if (!t || x < 0 || x >= t.w) return -1
    for (let y = Math.max(0, Math.floor(from)); y < t.h; y++) if (solidCell(t.front[y * t.w + x])) return y
    return -1
  }

  private updateRing(g: Ring, dt: number): void {
    if (g.delay > 0) {
      g.delay -= dt
      return
    }
    g.age += dt
    g.acc += dt
    const rad = g.R * easeOut(Math.min(1, g.age / g.life))
    const t = this.terrain
    while (g.acc >= 0.03) {
      g.acc -= 0.03
      if (rad < 20 || !t) continue
      for (const side of [-1, 1]) {
        const gx = Math.round(g.x + side * rad)
        const gy = this.groundY(gx, g.y - rad * 0.5)
        if (gy < 0 || Math.abs(gy - g.y) > rad) continue
        const rr = 3 + this.r() * 4
        this.soft({ x0: gx, y0: gy - 2, vx: side * (40 + this.r() * 60), vy: -12 - this.r() * 20, drag: 2.5, r0: rr * 0.5, r1: rr * 1.6, life: 1.2 + this.r() * 0.6, keep: 0.3, inner: 0xa89070, edge: 0x6e5c48, a0: 0.8 })
        if (this.r() < 0.6) {
          const cols = DEBRIS_COLORS[t.front[gy * t.w + gx]] ?? DEBRIS_COLORS[1]
          this.debris.push({ x: gx, y: gy - 1, vx: side * (30 + this.r() * 60), vy: -60 - this.r() * 80, color: cols[Math.floor(this.r() * cols.length)], shape: Math.floor(this.r() * 3), life: 1 + this.r(), age: 0, rest: false })
        }
      }
    }
  }

  private drawRing(g: Ring): void {
    if (g.delay > 0) return
    const u = Math.min(1, g.age / g.life)
    const rad = g.R * easeOut(u)
    const w = Math.max(1, g.w * (1 - u * 0.6))
    const dither = 1 - u
    const fx = this.fx
    // recortado a la parte del mundo que cubre el buffer
    const x0 = Math.max(Math.ceil(fx.left), Math.floor(g.x - rad - w))
    const x1 = Math.min(Math.floor(fx.right) - 1, Math.ceil(g.x + rad + w))
    const y0 = Math.max(Math.ceil(fx.top), Math.floor(g.y - rad - w))
    const y1 = Math.min(Math.floor(fx.bottom) - 1, Math.ceil(g.y + rad + w))
    const outer = (rad + w) * (rad + w)
    const inner = Math.max(0, rad - w) ** 2
    const edge = Math.max(0, rad + w - 1.5) ** 2
    const a = 0.55 + 0.4 * dither
    const body = u < 0.25 ? 0xffffff : 0xfff1c0
    // v3: cada fila recorre solo las dos cuerdas del anillo (antes, el cuadrado entero: con el de la nuke eran
    // ~370 mil pixels por frame); el criterio por pixel es el mismo.
    const ring = (y: number, xa: number, xb: number, dy2: number): void => {
      for (let x = Math.max(x0, xa); x <= Math.min(x1, xb); x++) {
        const d2 = (x - g.x) * (x - g.x) + dy2
        if (d2 > outer || d2 < inner) continue
        if (bayer(x, y) > dither) continue
        fx.put(x, y, d2 > edge ? 0xffb43e : body, a)
      }
    }
    for (let y = y0; y <= y1; y++) {
      const dy2 = (y - g.y) * (y - g.y)
      if (dy2 > outer) continue
      const xo = Math.sqrt(outer - dy2) + 1
      const xi = dy2 < inner ? Math.sqrt(inner - dy2) - 1 : -1
      if (xi <= 2) ring(y, Math.floor(g.x - xo), Math.ceil(g.x + xo), dy2)
      else {
        ring(y, Math.floor(g.x - xo), Math.ceil(g.x - xi), dy2)
        ring(y, Math.floor(g.x + xi), Math.ceil(g.x + xo), dy2)
      }
    }
  }

  // ---------- simulación ----------

  update(dt: number, wind: number): void {
    this.wind = wind
    if (dt <= 0) return
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt)
      return
    }
    this.time += dt
    for (let i = 0; i < this.delayed.length; i++) {
      const d = this.delayed[i]
      if (d.at <= this.time) {
        this.delayed.splice(i--, 1)
        d.run()
      }
    }
    for (const b of this.blobs) {
      if (b.delay > 0) b.delay -= dt
      else b.age += dt
    }
    this.blobs = this.blobs.filter((b) => b.age < b.life)
    for (const g of this.rings) this.updateRing(g, dt)
    this.rings = this.rings.filter((g) => g.age < g.life)
    for (const s of this.softs) s.age += dt
    this.softs = this.softs.filter((s) => s.age < s.life && !(s.trail && this.sunk(s.y0)))
    this.capParticles()
    for (const l of this.lights) l.age += dt
    this.lights = this.lights.filter((l) => l.age < l.life)

    for (const p of this.debris) {
      p.age += dt
      if (p.rest) {
        if (!this.solid(p.x, p.y + 1)) p.rest = false
        else continue
      }
      p.vy += 320 * dt
      const nx = p.x + p.vx * dt
      const ny = p.y + p.vy * dt
      if (this.solid(nx, ny)) {
        if (this.solid(p.x, ny)) {
          p.vy *= -0.35
          p.vx *= 0.6
          if (Math.abs(p.vy) < 25) {
            p.vy = 0
            p.rest = true
            while (this.solid(p.x, p.y) && p.y > 0) p.y--
          }
        } else {
          p.vx *= -0.4
        }
      } else {
        p.x = nx
        p.y = ny
      }
    }
    const W = this.worldW
    const H = this.worldH
    // v4: lo que cae en agua o lava se hunde (desaparece)
    this.debris = this.debris.filter((p) => p.age < p.life && p.x > -10 && p.x < W + 10 && p.y < H + 10 && !this.sunk(p.y) && !this.liquid(p.x, p.y))

    for (const p of this.sparks) {
      p.age += dt
      p.vx *= 1 - 2 * dt
      p.vy = p.vy * (1 - 2 * dt) + 120 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
    this.sparks = this.sparks.filter((p) => p.age < p.life && !(p.vy > 0 && (this.sunk(p.y) || this.liquid(p.x, p.y))))

    const chunkAt = (c: Chunk, t: number): [number, number] => [c.ox + c.dx * t, c.oy - Math.sin(t * Math.PI * 0.8) * c.peak + t * t * 22]
    for (const c of this.chunks) {
      c.age += dt
      if (c.done) continue
      if (c.t < 1) {
        // arranca rápido y frena hacia el final de la curva
        const u = Math.min(1, c.age / c.dur)
        const t1 = 0.1 + 0.9 * (1 - (1 - u) * (1 - u))
        for (let t = c.t + 0.02; t <= t1; t += 0.02) {
          const [x, y] = chunkAt(c, t)
          // el primer tramo queda debajo del fuego: no se registra
          if (t > 0.25) c.pts.push(x, y, this.time)
          c.t = t
        }
        if (u >= 1) c.t = 1
        const [x, y] = chunkAt(c, Math.min(1, t1))
        const [px, py] = chunkAt(c, Math.max(0.1, t1 - 0.02))
        c.vx = ((x - px) / 0.02) * (0.9 / c.dur) * 0.5
        c.vy = ((y - py) / 0.02) * (0.9 / c.dur) * 0.5
        c.x = x
        c.y = y
      } else {
        c.vy += 220 * dt
        c.x += c.vx * dt
        c.y += c.vy * dt
      }
      if (this.solid(c.x, c.y) || c.age >= c.life || this.sunk(c.y)) c.done = true
    }
    for (const c of this.chunks) {
      let k = 0
      while (k < c.pts.length && this.time - c.pts[k + 2] >= CHUNK_TRAIL) k += 3
      if (k > 0) c.pts.splice(0, k)
    }
    this.chunks = this.chunks.filter((c) => !c.done || c.pts.length > 0)

    for (const e of this.emitters) {
      e.age += dt
      e.accA += dt
      e.accB += dt
      if (e.kind === 'wreck') {
        const pos = e.id !== undefined ? this.wreckPos(e.id) : null
        if (!pos) {
          e.age = e.life
          continue
        }
        e.x = pos.x
        e.y = pos.y
        if (this.sunk(e.y - 10)) continue // restos tapados por la lava: no echan fuego ni humo
        if (this.liquid(e.x, e.y - 10) === 1) {
          // v4: restos bajo el agua: no se queman, largan burbujas
          while (e.accA >= 0.35) {
            e.accA -= 0.35
            const t = this.terrain
            let top = Math.round(e.y - 10)
            while (t && top > 0 && t.front[(top - 1) * t.w + Math.round(e.x)] === WATER) top--
            this.bubbles(e.x, e.y - 8, 1, top, 8)
          }
          e.accB = 0
          continue
        }
        while (e.accA >= 0.07) {
          e.accA -= 0.07
          const r1 = 2 + this.r() * 2.5
          this.blob({ layer: 1, ox: e.x + (this.r() - 0.5) * 12, oy: e.y - 12 + (this.r() - 0.5) * 3, vy: -22, vx: this.wind * 1.5, r0: r1 * 0.6, r1, grow: 0.05, hold: 0.12, life: 0.42, heat0: 0.1 + this.r() * 0.3, heatV: 1.2, ramp: FIRE, outline: FIRE_OUT })
        }
        while (e.accB >= 0.16) {
          e.accB -= 0.16
          const r1 = 5 + this.r() * 3
          this.blob({ layer: 0, ox: e.x + (this.r() - 0.5) * 8, oy: e.y - 16, vy: -16, vx: this.wind * 1.5, ax: this.wind * 0.5, r0: 2, r1, grow: 0.8, hold: 1, life: 2.2, heat0: 0.2 + this.r() * 0.3, heatV: 0.05, ramp: SMOKE, outline: SMOKE_OUT, fade: true })
        }
      } else if (e.kind === 'burn') this.updateBurn(e, dt)
      else if (e.kind === 'drill') this.updateDrill(e)
      else this.updateMouth(e)
    }
    this.emitters = this.emitters.filter((e) => e.age < e.life)

    for (const g of this.drops) {
      g.age += dt
      g.acc += dt
      g.vy += 260 * dt
      g.x += g.vx * dt
      g.y += g.vy * dt
      while (g.acc >= 0.015) {
        g.acc -= 0.015
        this.soft({ x0: g.x, y0: g.y, vy: -6, r0: 1, r1: 2.4 + this.r() * 1.2, life: 0.55, inner: 0x3e3630, edge: 0x201a18, a0: 0.7 })
      }
      if (this.solid(g.x, g.y)) {
        while (this.solid(g.x, g.y) && g.y > 0) g.y--
        this.flame(Math.round(g.x) - 2, Math.round(g.y), 5, 0.8 + this.r() * 1.2)
        g.age = g.life
      } else if (this.liquid(g.x, g.y)) {
        // v4: napalm que cae al agua se apaga con vapor; en la lava se funde
        if (this.liquid(g.x, g.y) === 1) this.steam(g.x, g.y - 1, 2, 4)
        g.age = g.life
      }
    }
    this.drops = this.drops.filter((g) => g.age < g.life && g.x > -10 && g.x < W + 10 && g.y < H + 10 && !this.sunk(g.y))

    // v4: gotas de agua y burbujas
    for (const g of this.wdrops) {
      g.age += dt
      g.vy += 300 * dt
      g.vx *= 1 - 0.6 * dt
      g.x += g.vx * dt
      g.y += g.vy * dt
      if (g.vy > 0 && (this.liquid(g.x, g.y) || this.solid(g.x, g.y))) g.age = g.life
    }
    this.wdrops = this.wdrops.filter((g) => g.age < g.life && g.y < H + 10)
    if (this.wdrops.length > 160) this.wdrops.splice(0, this.wdrops.length - 160)
    for (const b of this.wbubbles) {
      b.age += dt
      if (b.age < 0) continue
      b.y += b.vy * dt
      b.x += Math.sin(b.age * 9 + b.phase) * 10 * dt
      if (b.y <= b.top + 0.5 || this.liquid(b.x, b.y) !== 1) {
        // revienta en la superficie: una gotita y a veces un anillo de espuma
        if (b.r > 1.2 && this.wdrops.length < 160) this.wdrops.push({ x: b.x, y: b.top - 1, vx: (this.r() - 0.5) * 20, vy: -25 - this.r() * 25, age: 0, life: 0.6, big: false })
        b.age = b.life
      }
    }
    this.wbubbles = this.wbubbles.filter((b) => b.age < b.life)
    if (this.wbubbles.length > 120) this.wbubbles.splice(0, this.wbubbles.length - 120)
  }

  decay(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 22)
    this.flash = Math.max(0, this.flash - dt * 3.2)
    this.glow = Math.max(0, this.glow - dt * 0.38)
    if (this.flash === 0) this.flashColor = 0xfff1c9
  }

  // ---------- dibujo ----------

  // ¿Algún pixel de fuego o humo del último draw cae dentro del rectángulo (con margen)?
  blocks(x: number, y: number, w: number, h: number, margin = 1): boolean {
    const o = this.occ
    const x0 = x - margin
    const y0 = y - margin
    const x1 = x + w + margin
    const y1 = y + h + margin
    for (let i = 0; i < o.length; i += 3) {
      const cx = o[i]
      const cy = o[i + 1]
      const r = o[i + 2] + 0.5
      const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0
      const dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0
      if (dx * dx + dy * dy < r * r) return true
    }
    return false
  }

  private blobState(b: Blob): { x: number; y: number; r: number; heat: number; dither: number; fog: number } | null {
    if (b.delay > 0) return null
    const t = b.age
    const e = easeOut(Math.min(1, t / b.grow))
    const x = b.ox + b.dx * e + b.vx * t + 0.5 * b.ax * t * t
    const y = b.oy + b.dy * e + b.vy * t + 0.5 * b.ay * t * t
    let r = b.r0 + (b.r1 - b.r0) * e
    let dither = 1
    if (b.fade) {
      r *= 1 + 0.25 * Math.max(0, t - b.grow) / b.life
      if (t > b.hold) dither = 1 - (t - b.hold) / (b.life - b.hold)
    } else if (t > b.hold) {
      r *= Math.max(0, 1 - (t - b.hold) / (b.life - b.hold))
    }
    if (r < 0.6 || dither <= 0) return null
    const heat = b.heat0 + b.heatV * Math.max(0, t - b.cool) - (1 - dither) * 0.3
    // primero el color se funde a la niebla y recién al final se dithera (sin trama visible)
    const f = 1 - dither
    return { x, y, r, heat, dither: f < 0.6 ? 1 : 1 - (f - 0.6) / 0.4, fog: Math.min(1, f * 1.4) }
  }

  // el contorno llega al color de la niebla y desaparece antes que el relleno
  private outlineDisc(st: { x: number; y: number; r: number; dither: number; fog: number }, color: number): void {
    if (st.fog >= 0.7) return
    this.fx.rampDisc(st.x, st.y, st.r + 1, null, color, 0, st.dither, this.fog, st.fog / 0.7)
  }

  // Tope global: si hay más de MAX_PARTICLES, descarta primero las que gastaron más de su vida.
  private capParticles(): void {
    let n = this.blobs.length + this.debris.length + this.sparks.length
    for (const s of this.softs) if (!s.trail) n++
    const over = n - (this.quality === 'low' ? MAX_PARTICLES_LOW : MAX_PARTICLES)
    if (over <= 0) return
    const us: number[] = []
    for (const b of this.blobs) us.push(b.delay > 0 ? 0 : b.age / b.life)
    for (const s of this.softs) if (!s.trail) us.push(s.age / s.life)
    for (const p of this.debris) us.push(p.age / p.life)
    for (const p of this.sparks) us.push(p.age / p.life)
    us.sort((a, b) => b - a)
    const cut = us[over - 1]
    let tie = 0 // cuántas con u === cut hay que sacar todavía
    for (let i = 0; i < over; i++) if (us[i] === cut) tie++
    const keep = (u: number): boolean => {
      if (u < cut) return true
      if (u > cut) return false
      if (tie > 0) {
        tie--
        return false
      }
      return true
    }
    this.blobs = this.blobs.filter((b) => keep(b.delay > 0 ? 0 : b.age / b.life))
    this.softs = this.softs.filter((s) => s.trail || keep(s.age / s.life))
    this.debris = this.debris.filter((p) => keep(p.age / p.life))
    this.sparks = this.sparks.filter((p) => keep(p.age / p.life))
  }

  // Bocanada de polvo: elipse apoyada en el piso gy, más clara arriba y con dither que se abre hacia el borde.
  private drawPuff(cx: number, gy: number, r: number, squash: number, a: number, dens: number): void {
    const fx = this.fx
    const ry = Math.max(1, r * squash)
    const cy = gy - ry * 0.6
    const hi = mix(PUFF_HI, this.fog, 0.1)
    const mid = mix(PUFF_MID, this.fog, 0.1)
    const edge = mix(PUFF_EDGE, this.fog, 0.1)
    const x0 = Math.floor(cx - r)
    const x1 = Math.ceil(cx + r)
    const y0 = Math.floor(cy - ry)
    const y1 = Math.min(Math.ceil(cy + ry), Math.round(gy) + 1)
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / r
        const q = Math.sqrt(nx * nx + ny * ny)
        if (q > 1) continue
        // denso adentro, trama cada vez más abierta hacia afuera
        const d = (q < 0.4 ? 1 : 1 - ((q - 0.4) / 0.6) * 0.85) * dens
        if (bayer(x, y) > d) continue
        const c = q > 0.72 ? edge : ny < -0.25 && nx < 0.35 ? hi : mid
        fx.put(x, y, c, a * (q > 0.72 ? 0.75 : 1))
      }
    }
  }

  private fillCluster(x: number, y: number, r: number, heat: number, ramp: number[], dither: number, fog = 0): void {
    this.fx.rampDisc(x, y, r, ramp, 0, heat, dither, this.fog, fog)
  }

  private drawSofts(top: boolean): void {
    const fx = this.fx
    for (const s of this.softs) {
      if (s.top !== top) continue
      const u = s.age / s.life
      let x: number
      let y: number
      if (s.drag > 0) {
        const k = (1 - Math.exp(-s.drag * s.age)) / s.drag
        x = s.x0 + s.vx * k
        y = s.y0 + s.vy * k
      } else {
        x = s.x0 + s.vx * s.age + 0.5 * s.ax * s.age * s.age
        y = s.y0 + s.vy * s.age
      }
      const r = s.r0 + (s.r1 - s.r0) * (s.puff > 0 ? easeOut(Math.min(1, u * 1.6)) : u)
      const edge = s.edge
      const inner = s.inner
      if (s.trail) {
        // alfa baja con la edad: la cabeza opaca, la cola casi transparente
        const a = u < 0.85 ? s.a0 - (s.a0 - 0.3) * (u / 0.85) : 0.3 * (1 - (u - 0.85) / 0.15)
        fx.disc(Math.round(x), Math.round(y), r, (d) => (d > 1.05 ? edge : inner), a)
        continue
      }
      const a = u < s.keep ? s.a0 : (s.a0 * (1 - u)) / (1 - s.keep)
      if (s.puff > 0) {
        // al desvanecerse primero se abre la trama y después baja el alfa
        const dens = Math.min(1, 0.35 + (a / s.a0) * 0.9)
        this.drawPuff(x, y, r, s.puff, Math.min(1, a * 1.1), dens)
        if (a > 0.3) this.occ.push(x, y - r * s.puff * 0.6, r * s.puff)
        continue
      }
      fx.disc(x, y, r, (d) => (d > r - 1 ? edge : inner), a)
      if (a > 0.15) this.occ.push(x, y, r)
    }
  }

  // Estela de 1 px: cada tramo se apaga con la edad de su punto más viejo.
  private drawChunkTrail(c: Chunk): void {
    const p = c.pts
    for (let i = 3; i < p.length; i += 3) {
      const a = 1 - (this.time - p[i - 1]) / CHUNK_TRAIL
      if (a <= 0) continue
      const x0 = p[i - 3]
      const y0 = p[i - 2]
      const dx = p[i] - x0
      const dy = p[i + 1] - y0
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
      for (let k = 0; k < n; k++) this.fx.put(x0 + (dx * k) / n, y0 + (dy * k) / n, 0xf7f2ea, a)
    }
  }

  // Estelas de pedazos visibles y sus puntos (contador de QA).
  get trails(): string {
    const live = this.chunks.filter((c) => c.pts.length > 3)
    return `${live.length}/${this.chunks.length} (${live.reduce((a, c) => a + c.pts.length / 3, 0)} pts)`
  }

  // Partículas activas sin la estela del proyectil (contador de QA en ?fxtest).
  get count(): number {
    let n = this.blobs.length + this.softs.filter((q) => !q.trail).length + this.debris.length + this.sparks.length + this.drops.length + this.rings.length + this.wdrops.length + this.wbubbles.length
    for (const c of this.chunks) n += 1 + c.pts.length / 3
    return n
  }

  // Rodadora apoyada: polvo y alguna chispa bajo la bola.
  rollDust(x: number, y: number, dir: number): void {
    const r1 = 1.4 + this.r() * 1.6
    this.soft({ x0: x - dir * 2, y0: y + 2, vx: -dir * (10 + this.r() * 18), vy: -5 - this.r() * 8, drag: 4, r0: r1 * 0.6, r1: r1 * 1.8, life: 0.5 + this.r() * 0.4, inner: 0xa8927a, edge: 0x6e5c48, a0: 0.8 })
    if (this.r() < 0.3) this.sparks.push({ x: x - dir * 2, y: y + 3, vx: -dir * (40 + this.r() * 60), vy: -20 - this.r() * 40, life: 0.15 + this.r() * 0.2, age: 0 })
  }

  // Racimo: estallido chico en el apogeo, donde se abre en bombitas.
  pop(x: number, y: number): void {
    this.blob({ layer: 4, ox: x, oy: y, r0: 3, r1: 6, grow: 0.02, life: 0.06, ramp: FLASH, outline: 0xffb43e, heat0: -0.5 })
    this.blob({ layer: 1, ox: x, oy: y, r0: 2, r1: 5, grow: 0.04, hold: 0.08, life: 0.22, heat0: 0, heatV: 2.5, ramp: FIRE, outline: FIRE_OUT })
    for (let i = 0; i < 5; i++) {
      const r1 = 2.5 + this.r() * 2
      this.soft({ x0: x, y0: y, vx: (this.r() - 0.5) * 50, vy: (this.r() - 0.5) * 30, drag: 3, r0: 1.5, r1, life: 0.9 + this.r() * 0.4, inner: 0xf2ece2, edge: 0xb8ada0, a0: 0.85 })
    }
    for (let i = 0; i < 12; i++) {
      const a = this.r() * Math.PI * 2
      const sp = 60 + this.r() * 90
      this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.2 + this.r() * 0.2, age: 0 })
    }
    this.lights.push({ x, y, R: 30, tint: 0xffb04a, k: 0.4, life: 0.15, age: 0 })
    this.shake = Math.max(this.shake, 2)
  }

  private drawShot(p: ShotView): void {
    const fx = this.fx
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    const blink = Math.floor(this.time * 10) % 2 === 0
    switch (p.kind) {
      case 'bomblet':
        for (let oy = -2; oy <= 2; oy++)
          for (let ox = -2; ox <= 2; ox++) {
            if (Math.abs(ox) + Math.abs(oy) > 3) continue
            const inner = Math.abs(ox) < 2 && Math.abs(oy) < 2 && Math.abs(ox) + Math.abs(oy) < 2
            fx.put(x + ox, y + oy, inner ? (oy < 0 ? 0x4a4a44 : 0x2c2c28) : OUT)
          }
        fx.put(x, y - 2, blink ? 0xffe27a : 0xf77a28)
        return
      case 'nuke':
        for (let oy = -3; oy <= 3; oy++)
          for (let ox = -4; ox <= 4; ox++) {
            const d = (ox * ox) / 20 + (oy * oy) / 12
            if (d > 1) continue
            const edge = (ox * ox) / 11 + (oy * oy) / 5 > 1
            const band = ox === 0 || ox === 1
            fx.put(x + ox, y + oy, edge ? OUT : band ? 0x1c1614 : oy < 0 ? 0xf2d45a : 0xc89a2a)
          }
        fx.put(x - 2, y - 1, 0xfff6c8)
        fx.put(x, y, blink ? 0xff3a2a : 0x6a1a14)
        return
      case 'roll': {
        const R = 3.5
        fx.rampDisc(x, y, R + 1, null, OUT)
        fx.rampDisc(x, y, R, null, 0x5c5c54)
        const a = p.spin ?? 0
        const cx = Math.cos(a)
        const sy = Math.sin(a)
        for (let k = -3; k <= 3; k++) fx.put(x + Math.round(cx * k), y + Math.round(sy * k), 0x2c2c28)
        fx.put(x + Math.round(-sy * 2), y + Math.round(cx * 2), 0x8c8c80)
        fx.put(x - 1, y - 2, 0xb8b8a8)
        fx.put(x - 2, y - 1, 0xb8b8a8)
        fx.put(x, y, 0xd24a1c)
        return
      }
      default:
        // obús: 3×3 de metal con contorno oscuro y brillo arriba a la izquierda
        for (let oy = -2; oy <= 2; oy++)
          for (let ox = -2; ox <= 2; ox++) {
            if (Math.abs(ox) === 2 && Math.abs(oy) === 2) continue
            const inner = Math.abs(ox) < 2 && Math.abs(oy) < 2
            fx.put(x + ox, y + oy, inner ? (ox + oy < 0 ? 0x8c8c80 : 0x55554c) : OUT)
          }
        fx.put(x - 1, y - 1, 0xfff1a8)
    }
  }

  draw(projectiles: ShotView[]): void {
    const fx = this.fx
    fx.clear()
    const occ: number[] = []
    this.occ = occ

    this.drawSofts(false)

    for (const d of this.debris) {
      const shape = SHAPES[d.shape]
      const x = Math.round(d.x)
      const y = Math.round(d.y)
      const sp = Math.hypot(d.vx, d.vy)
      if (!d.rest && sp > 40 && this.quality === 'high') {
        const ux = d.vx / sp
        const uy = d.vy / sp
        for (let k = 2; k < 6; k++) fx.put(x - ux * k * 1.6, y - uy * k * 1.6, 0x3a302a, 0.45 - k * 0.06)
      }
      if (shape.length > 2)
        for (const [ox, oy] of shape)
          for (const [ex, ey] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ])
            fx.put(x + ox + ex, y + oy + ey, OUT)
      for (const [ox, oy] of shape) fx.put(x + ox, y + oy, d.color)
      if (shape.length > 2) fx.put(x, y, mix(d.color, 0xffffff, 0.25))
    }

    const states = this.blobs.map((b) => [b, this.blobState(b)] as const)
    for (const [, st] of states) if (st) occ.push(st.x, st.y, st.r + 1)
    for (const c of this.chunks) if (!c.done) occ.push(c.x, c.y, 2.6)
    for (const layer of [0, 1, 2] as Layer[]) {
      for (const [b, st] of states) if (st && b.layer === layer) this.outlineDisc(st, b.outline)
      for (const [b, st] of states) if (st && b.layer === layer) this.fillCluster(st.x, st.y, st.r, st.heat, b.ramp, st.dither, st.fog)
    }
    for (const [b, st] of states) {
      if (!st || b.layer !== 3) continue
      this.outlineDisc(st, b.outline)
      this.fillCluster(st.x, st.y, st.r, st.heat, b.ramp, st.dither, st.fog)
    }

    this.drawSofts(true)
    for (const c of this.chunks) this.drawChunkTrail(c)
    for (const c of this.chunks) {
      if (c.done) continue
      fx.rampDisc(c.x, c.y, 2.6, null, FIRE_OUT)
      this.fillCluster(c.x, c.y, 1.6, 0.05, FIRE, 1)
    }
    for (const g of this.drops) {
      fx.rampDisc(g.x, g.y, 2.4, null, FIRE_OUT)
      this.fillCluster(g.x, g.y, 1.5, 0.1, FIRE, 1)
    }

    for (const p of this.sparks) {
      const sp = Math.hypot(p.vx, p.vy) || 1
      const ux = p.vx / sp
      const uy = p.vy / sp
      const fade = 1 - p.age / p.life
      fx.put(p.x, p.y, 0xfffbe2)
      fx.put(p.x - ux, p.y - uy, 0xffc64a)
      fx.put(p.x - ux * 2, p.y - uy * 2, 0xf77a28, 0.7 * fade)
    }

    // v4: burbujas (anillo claro con el centro del color del agua) y gotas (cabeza clara y estela)
    for (const b of this.wbubbles) {
      if (b.age < 0) continue
      if (b.r >= 1.4) {
        const x = Math.round(b.x)
        const y = Math.round(b.y)
        fx.put(x - 1, y, W_BUBBLE, 0.85)
        fx.put(x + 1, y, W_BUBBLE, 0.85)
        fx.put(x, y - 1, W_BUBBLE, 0.95)
        fx.put(x, y + 1, W_BUBBLE, 0.7)
        if (b.r >= 2) fx.put(x, y, W_BUBBLE_IN, 0.6)
        else fx.put(x, y, W_BUBBLE, 0.4)
      } else fx.put(b.x, b.y, W_BUBBLE, 0.9)
    }
    for (const g of this.wdrops) {
      const sp = Math.hypot(g.vx, g.vy) || 1
      const ux = g.vx / sp
      const uy = g.vy / sp
      const fade = g.age > g.life - 0.3 ? (g.life - g.age) / 0.3 : 1
      fx.put(g.x - ux * 2, g.y - uy * 2, W_DROP_TAIL, 0.6 * fade)
      fx.put(g.x - ux, g.y - uy, W_DROP_MID, 0.9 * fade)
      if (g.big) {
        fx.put(g.x + 1, g.y, W_DROP_MID, fade)
        fx.put(g.x, g.y + 1, W_DROP_TAIL, fade)
        fx.put(g.x + 1, g.y + 1, W_DROP_TAIL, fade)
      }
      fx.put(g.x, g.y, W_DROP, fade)
    }

    for (const g of this.rings) this.drawRing(g)

    for (const p of projectiles) this.drawShot(p)

    for (const [b, st] of states) if (st && b.layer === 4) {
      fx.rampDisc(st.x, st.y, st.r + 1, null, b.outline)
      this.fillCluster(st.x, st.y, st.r, st.heat, b.ramp, 1)
    }

    const light = this.light
    light.clear()
    const minK = this.quality === 'low' ? LOW_MIN_LIGHT : 0
    for (const l of this.lights) {
      const k = l.k * Math.pow(1 - l.age / l.life, 1.5)
      if (k > minK) light.light(l.x, l.y, l.R, l.tint, k)
    }
    for (const e of this.emitters) {
      if (e.kind === 'wreck') {
        if (!this.sunk(e.y - 10)) light.light(e.x, e.y - 12, 22 + Math.sin(this.time * 17 + e.x) * 2, 0xff8a3a, 0.28)
      } else if (e.kind === 'burn') {
        const k = this.burnK(e)
        if (k > 0) light.light(e.x + e.w / 2, e.y - 6, Math.max(22, e.w * 1.6), 0xff8a3a, 0.3 * k * (0.85 + 0.15 * Math.sin(this.time * 13 + e.x)))
      }
    }
    light.finish()
  }
}
