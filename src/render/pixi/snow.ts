// v3 bioma nieve (render). Tres partes:
//  1. Pintado de SNOW e ICE en el terreno (lo llama TerrainPainter.paint): borde blanco brillante y sombras
//     azuladas en la nieve; hielo translúcido con vetas, burbujas y grietas; cráteres que derriten la nieve y
//     dejan la tierra a la vista; y, en el bioma nieve, capa de nieve sobre todo lo que mira al cielo, cornisas
//     que asoman en los bordes y carámbanos colgando de techos y salientes (el equivalente del pasto y las raíces).
//  2. Motes: partículas baratas en GPU (ParticleContainer con una textura de 8×8) para el aliento, el polvo de
//     nieve, las astillas de hielo, los brillos y el botín (loot.ts). El CPU solo mueve números.
//  3. SnowView: nevada con parallax en tres planos (solo lo visible: los copos viven en coordenadas de pantalla
//     y se repiten), niebla fría en los valles, reflejos que corren por el hielo, destellos en la nieve,
//     aliento de los tripulantes y el tanque patinando en el hielo (slide cause 'ice').
import { Container, Particle, ParticleContainer, Rectangle, Sprite, Texture } from 'pixi.js'
import type { Biome, GameEvent, Player, Terrain } from '../../sim/types'
import { AIR, ICE, SNOW, TANK_H, TANK_W } from '../../sim/types'
import { VIEW_H, VIEW_W } from '../types'
import { vnoise } from './abyss'
import { LIQ } from './liquids'
import { bayer, hash, mix, mul, rnd } from './raster'

// 1 = nieve, 2 = hielo (por material)
export const COLD = new Uint8Array(256)
COLD[SNOW] = 1
COLD[ICE] = 2

// ---------- 1. pintado del terreno ----------

const SNOW_TOP = 0xffffff // borde de arriba
const SNOW_BODY = 0xd6e2ee // cuerpo (sin textura)
const SNOW_SHADE = 0xb2c4da // sombra azulada (vetas de viento, motas)
const SNOW_SIDE = 0x9fb4cc
const SNOW_UNDER = 0x8196b4 // cara de abajo (techo de una cueva en nieve)
const ICE_BODY_A = 0x8cc4e2
const ICE_BODY_B = 0xb4e0f4
const ICE_TOP = 0xf4fcff
const ICE_UNDER = 0x6c9ec2
const ICE_CRACK = 0x5d8fb3
const ICE_ALPHA = 205 // el cuerpo del hielo deja ver el fondo (y el agua de abajo se ve sin borde de superficie)
const EARTH = [0x3e3026, 0x54423a, 0x2e241e] // tierra que asoma en un cráter en la nieve
const SLUSH = 0x98a6b4 // nieve derretida alrededor de un fuego
const MELT = 14 // px alrededor del cráter con nieve derretida

// Alfa del último pixel de coldPixel (sin reservar memoria por pixel).
export let coldAlpha = 255

// Pixel de nieve o hielo del frente. c: color de la textura (si el manifiesto la trae) o el plano de respaldo;
// tex: hay textura. up/down/left/right: aire (o líquido) de ese lado. S: ¿es sólido? (para la profundidad).
export function coldPixel(m: number, c: number, tex: boolean, x: number, y: number, up: boolean, down: boolean, left: boolean, right: boolean, S: (x: number, y: number) => boolean): number {
  coldAlpha = 255
  if (m === SNOW) {
    if (!tex) {
      c = mix(SNOW_BODY, 0xe4ecf4, vnoise(x, y, 9, 5, 141))
      const r = rnd(x, y, 142)
      if (r > 0.93) c = mix(c, SNOW_SHADE, 0.7)
      else if (r < 0.025) c = 0xf8fbff
    }
    // vetas que deja el viento: bandas azuladas suaves, más anchas que altas
    if (vnoise(x, y, 16, 5, 143) > 0.66 && bayer(x, y) < 0.6) c = mix(c, SNOW_SHADE, 0.45)
    if (up) return rnd(x, y, 144) > 0.86 ? 0xeef5ff : SNOW_TOP
    // profundidad bajo la superficie (0 = fila de arriba): degradé de blanco a cuerpo
    let d = 1
    while (d < 6 && S(x, y - d - 1)) d++
    if (d === 1) c = mix(c, 0xf6faff, 0.8)
    else if (d < 6) c = mix(c, 0xeef4fb, (6 - d) / 9)
    if (down) return S(x, y + 2) || !S(x, y - 1) ? mix(c, SNOW_SIDE, 0.6) : SNOW_UNDER
    if (!S(x, y + 2)) return mix(c, SNOW_UNDER, 0.45)
    if (left || right) return mix(c, SNOW_SIDE, 0.4)
    return c
  }
  // hielo
  if (!tex) c = mix(ICE_BODY_A, ICE_BODY_B, vnoise(x, y, 12, 6, 151))
  // vetas diagonales quietas (reflejos internos), burbujas y grietas
  const band = (x + y + ((rnd(0, y >> 2, 152) * 7) | 0)) % 37
  if (band < 2) c = mix(c, 0xeaf8ff, band === 0 ? 0.6 : 0.35)
  if (rnd(x, y, 153) > 0.986) c = 0xeefaff
  else if (rnd(x - 1, y, 153) > 0.986 || rnd(x, y - 1, 153) > 0.986) c = mix(c, 0x6a9cbc, 0.55)
  const n = vnoise(x, y, 11, 8, 154)
  if (Math.abs(n - 0.5) < 0.016) c = ICE_CRACK
  else if (Math.abs(vnoise(x, y - 1, 11, 8, 154) - 0.5) < 0.016) c = mix(c, 0xd8f2ff, 0.6)
  if (up) return ICE_TOP
  if (!S(x, y - 2)) {
    coldAlpha = 235
    return mix(c, 0xd6f0fc, 0.6)
  }
  if (down) {
    coldAlpha = 240
    return ICE_UNDER
  }
  coldAlpha = ICE_ALPHA
  if (left || right) {
    coldAlpha = 230
    return mul(c, 0.86)
  }
  return c
}

export interface ColdCrater {
  x: number
  y: number
  r: number
}

// Cráter de fuego sobre nieve o hielo: en el borde asoma la tierra y alrededor la nieve queda derretida
// (gris mojado, con la trama de Bayer); el hielo se oscurece como agua de deshielo.
export function coldCraters(c: number, m: number, x: number, y: number, craters: ColdCrater[]): number {
  for (const cr of craters) {
    const d = Math.hypot(x - cr.x, y - cr.y)
    if (m === SNOW) {
      if (d < cr.r + 4) {
        const k = 1 - (d - cr.r) / 4
        c = k > bayer(x, y) * 0.9 ? EARTH[hash(x, y, 155) % 3] : mix(c, SLUSH, 0.6)
      } else if (d < cr.r + MELT) {
        const k = 1 - (d - cr.r - 4) / (MELT - 4)
        if (k > bayer(x, y) * 0.8) c = mix(c, SLUSH, 0.3 + 0.3 * k)
      }
    } else if (d < cr.r + 10) {
      const k = 1 - (d - cr.r) / 10
      if (k > bayer(x, y) * 0.8) c = mix(c, 0x4f7f9f, 0.3 + 0.35 * k)
    }
  }
  return c
}

// Solo bioma nieve: capa blanca sobre lo que mira al cielo, cornisas que asoman de los bordes y carámbanos
// colgando de techos y salientes. Las fuentes pueden estar hasta 8 px fuera del rectángulo (put recorta).
export function frost(t: Terrain, r: { x0: number; y0: number; x1: number; y1: number }, put: (x: number, y: number, c: number) => void, craters: ColdCrater[]): void {
  const W = t.w
  const H = t.h
  const f = t.front
  const solid = (k: number): boolean => f[k] !== AIR && LIQ[f[k]] === 0
  const melted = (x: number, y: number): boolean => {
    for (const c of craters) if (Math.hypot(x - c.x, y - c.y) < c.r + MELT) return true
    return false
  }
  for (let x = Math.max(1, r.x0 - 2); x < Math.min(W - 1, r.x1 + 2); x++) {
    for (let y = Math.max(1, r.y0 - 8); y < Math.min(H - 1, r.y1 + 1); y++) {
      const k = y * W + x
      const m = f[k]
      if (m === AIR || LIQ[m]) continue
      const top = f[k - W] === AIR
      if (top) {
        if (craters.length && melted(x, y)) continue
        // capa de nieve sobre la tierra, la piedra, los techos (la nieve propia ya tiene su borde)
        if (!COLD[m]) {
          put(x, y, rnd(x, y, 161) > 0.85 ? 0xe8f0fa : 0xf6faff)
          if (solid(k + W) && rnd(x, y, 162) > 0.35) put(x, y + 1, 0xd4e0ec)
        }
        // cornisa: en un borde la nieve asoma uno o dos px y se dobla hacia abajo
        if (m !== ICE) {
          for (const side of [-1, 1]) {
            const s = k + side
            if (f[s] !== AIR || f[s + W] !== AIR) continue
            put(x + side, y, 0xeef5fc)
            if (rnd(x, y, 163 + side) > 0.45) put(x + side, y + 1, 0xc2d2e6)
            if (rnd(x, y, 165 + side) > 0.7 && f[s + side] === AIR) put(x + 2 * side, y, 0xdde8f4)
          }
        }
      }
      // carámbanos: de la cara de abajo de cualquier sólido (más seguido en hielo y nieve)
      if (y + 1 < H && f[k + W] === AIR) {
        const p = m === ICE ? 0.7 : m === SNOW ? 0.8 : 0.9
        if (rnd(x, y, 166) <= p || (craters.length && melted(x, y))) continue
        const len = 2 + Math.floor(rnd(x, y, 167) * (m === ICE ? 8 : 5))
        for (let i = 1; i <= len; i++) {
          const yy = y + i
          if (yy >= H || f[yy * W + x] !== AIR) break
          put(x, yy, i === len ? 0x86bad8 : i === 1 ? 0xe6f4ff : i < len / 2 ? 0xc4e2f4 : 0xa6d0ea)
          // los largos son más anchos arriba
          if (len >= 6 && i <= len / 3 && f[yy * W + x + 1] === AIR) put(x + 1, yy, 0x94c2de)
        }
      }
    }
  }
}

// ---------- 2. motes ----------

// Atlas de 8×8: (0,0) pixel blanco; (1,0) destello en cruz 3×3; (4,0) moneda 3×3; (0,4) billete 4×3.
let atlas: { px: Texture; star: Texture; coin: Texture; bill: Texture } | null = null
function motesAtlas(): { px: Texture; star: Texture; coin: Texture; bill: Texture } {
  if (atlas) return atlas
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  const ctx = c.getContext('2d')!
  const put = (x: number, y: number, v: number): void => {
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(x, y, 1, 1)
  }
  put(0, 0, 255)
  // destello: cruz con el centro blanco
  put(2, 0, 200)
  put(1, 1, 200)
  put(2, 1, 255)
  put(3, 1, 200)
  put(2, 2, 200)
  // moneda: centro claro, borde más oscuro (el tinte la vuelve dorada)
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) put(4 + x, y, x === 1 && y === 1 ? 255 : (x + y) % 2 === 0 ? 150 : 210)
  put(4, 0, 0)
  ctx.clearRect(4, 0, 1, 1)
  ctx.clearRect(6, 0, 1, 1)
  ctx.clearRect(4, 2, 1, 1)
  ctx.clearRect(6, 2, 1, 1)
  // billete 4×3: borde claro y una marca en el medio
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) put(x, 4 + y, y === 1 && (x === 1 || x === 2) ? 150 : 235)
  const base = Texture.from(c)
  base.source.scaleMode = 'nearest'
  const sub = (x: number, y: number, w: number, h: number): Texture => new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) })
  atlas = { px: sub(0, 0, 1, 1), star: sub(1, 0, 3, 3), coin: sub(4, 0, 3, 3), bill: sub(0, 4, 4, 3) }
  return atlas
}

export type MoteKind = 'px' | 'star' | 'coin' | 'bill'

interface Mote {
  p: Particle
  kind: MoteKind
  x: number
  y: number
  vx: number
  vy: number
  ay: number
  drag: number
  life: number
  age: number
  a0: number
  size: number
  rest: boolean // apoyado en el piso
}

export interface MoteSpec {
  kind?: MoteKind
  x: number
  y: number
  vx?: number
  vy?: number
  ay?: number // gravedad (px/s²)
  drag?: number
  life: number
  color: number
  alpha?: number
  size?: number // lado en pixels (solo 'px')
}

const MOTES_MAX = 600

// Partículas en coordenadas de mundo (o de pantalla, según dónde se agregue el contenedor).
export class Motes {
  readonly layer: ParticleContainer
  private list: Mote[] = []
  private free: Particle[] = []
  solid: ((x: number, y: number) => boolean) | null = null // monedas que rebotan en el piso

  constructor() {
    const a = motesAtlas()
    this.layer = new ParticleContainer({
      texture: a.px,
      roundPixels: true,
      dynamicProperties: { position: true, color: true, vertex: true, rotation: false, uvs: true },
    })
  }

  get count(): number {
    return this.list.length
  }

  spawn(s: MoteSpec): void {
    if (this.list.length >= MOTES_MAX) return
    const a = motesAtlas()
    const kind = s.kind ?? 'px'
    const p = this.free.pop() ?? new Particle({ texture: a.px })
    p.texture = a[kind]
    p.tint = s.color
    p.alpha = s.alpha ?? 1
    const size = s.size ?? 1
    p.scaleX = kind === 'px' ? size : 1
    p.scaleY = kind === 'px' ? size : 1
    p.anchorX = 0.5
    p.anchorY = 0.5
    this.list.push({ p, kind, x: s.x, y: s.y, vx: s.vx ?? 0, vy: s.vy ?? 0, ay: s.ay ?? 0, drag: s.drag ?? 0, life: s.life, age: 0, a0: s.alpha ?? 1, size, rest: false })
  }

  clear(): void {
    for (const m of this.list) this.free.push(m.p)
    this.list.length = 0
    this.sync()
  }

  // dt 0 (congelado): no se mueve nada pero se dibuja igual.
  update(dt: number, time: number): void {
    const out = this.list
    let n = 0
    for (let i = 0; i < out.length; i++) {
      const m = out[i]
      m.age += dt
      if (m.age >= m.life) {
        this.free.push(m.p)
        continue
      }
      if (dt > 0 && !m.rest) {
        const k = m.drag > 0 ? Math.exp(-m.drag * dt) : 1
        m.vx *= k
        m.vy = m.vy * k + m.ay * dt
        let sway = 0
        if (m.kind === 'bill') sway = Math.sin(m.age * 7 + m.a0 * 13) * 22
        const nx = m.x + (m.vx + sway) * dt
        const ny = m.y + m.vy * dt
        if (this.solid && m.ay > 0 && m.vy > 0 && this.solid(nx, ny)) {
          // rebote corto y queda apoyada
          if (m.kind === 'coin' && m.vy > 60) {
            m.vy = -m.vy * 0.35
            m.vx *= 0.6
          } else {
            m.vy = 0
            m.vx = 0
            m.rest = true
          }
        } else {
          m.x = nx
          m.y = ny
        }
      }
      const p = m.p
      p.x = Math.round(m.x)
      p.y = Math.round(m.y)
      const left = m.life - m.age
      let a = m.a0 * Math.min(1, left / Math.min(0.35, m.life * 0.5))
      if (m.kind === 'star') a *= 0.55 + 0.45 * Math.abs(Math.sin(m.age * 18))
      p.alpha = a
      if (m.kind === 'coin') p.scaleX = Math.abs(Math.cos(m.age * 11 + m.a0)) > 0.45 ? 1 : 0.34 // gira
      else if (m.kind === 'bill') p.scaleY = Math.floor(time * 8 + m.a0 * 5) % 3 === 0 ? 0.67 : 1 // aletea
      out[n++] = m
    }
    out.length = n
    this.sync()
  }

  private sync(): void {
    const kids = this.layer.particleChildren
    kids.length = this.list.length
    for (let i = 0; i < this.list.length; i++) kids[i] = this.list[i].p
    this.layer.update()
  }
}

// Brillos de un solo frame (reflejos del hielo, destellos de la nieve): un pozo de partículas que se rehace en
// cada frame con lo que toca.
class Glints {
  readonly layer: ParticleContainer
  private pool: Particle[] = []
  private n = 0

  constructor() {
    const a = motesAtlas()
    this.layer = new ParticleContainer({ texture: a.px, roundPixels: true, dynamicProperties: { position: true, color: true, vertex: false, rotation: false, uvs: false } })
  }

  begin(): void {
    this.n = 0
  }

  add(x: number, y: number, color: number, alpha: number): void {
    if (this.n >= 400) return
    let p = this.pool[this.n]
    if (!p) {
      p = new Particle({ texture: motesAtlas().px })
      this.pool.push(p)
    }
    p.x = x
    p.y = y
    p.tint = color
    p.alpha = alpha
    this.n++
  }

  end(): void {
    const kids = this.layer.particleChildren
    if (kids.length !== this.n || this.n > 0) {
      kids.length = this.n
      for (let i = 0; i < this.n; i++) kids[i] = this.pool[i]
      this.layer.update()
    }
  }
}

// ---------- 3. ambiente ----------

// Nevada: tres planos (lejos, medio, cerca) con su parallax, velocidad y tamaño. Los copos viven en un campo de
// pantalla un poco más grande que la vista y se repiten; la cámara los corre según su plano.
const FIELD_W = VIEW_W + 24
const FIELD_H = VIEW_H + 24
const FLAKE_PLANES = [
  { n: 70, par: 0.35, vy: 11, size: 1, color: 0xd8e4f0, alpha: 0.55 },
  { n: 64, par: 0.75, vy: 20, size: 1, color: 0xffffff, alpha: 0.8 },
  { n: 16, par: 1.25, vy: 34, size: 2, color: 0xffffff, alpha: 0.85 },
]
const BREATH_EVERY = 2.6 // s entre bocanadas de un tripulante
const MIST_H = 56
const MIST_TILE = 256
const GLINT_PERIOD = 120 // px entre reflejos que corren por el hielo
const GLINT_SPEED = 34 // px/s
const SCAN_EVERY = 0.4 // s mínimos entre escaneos de la grilla mientras cambia
const ICE_SPIN = 70 // px/s que giran las orugas sin tracción al patinar en el hielo

interface Flake {
  u: number
  v: number
  ph: number
  p: Particle
}

export class SnowView {
  readonly behind = new Container() // pantalla, entre el fondo y el mundo: copos lejanos
  readonly ahead = new Container() // pantalla, encima del mundo: copos del medio y cercanos
  readonly mist = new Container() // mundo, detrás del terreno: niebla fría en los valles
  readonly surface = new Container() // mundo, encima del frente del terreno: brillos y partículas
  readonly motes = new Motes()
  private glints = new Glints()
  private planes: { layer: ParticleContainer; flakes: Flake[]; def: (typeof FLAKE_PLANES)[number] }[] = []
  private mistTex: Texture | null = null
  private mistTiles: Sprite[] = []
  private on = false
  private time = 0
  // superficie: celdas de hielo y de nieve con aire arriba (índices de la grilla), del último escaneo
  private iceTop = new Int32Array(0)
  private snowTop = new Int32Array(0)
  private scanAge = Infinity
  private scanDirty = true
  private scanW = 0
  private breath = new Map<number, number>()
  private iceSlide = new Map<number, { left: number; dir: number }>()
  private terrain: Terrain | null = null

  constructor() {
    const a = motesAtlas()
    FLAKE_PLANES.forEach((def, i) => {
      const layer = new ParticleContainer({ texture: a.px, roundPixels: true, dynamicProperties: { position: true, color: false, vertex: false, rotation: false, uvs: false } })
      const flakes: Flake[] = []
      for (let k = 0; k < def.n; k++) {
        const p = new Particle({ texture: a.px, tint: def.color, alpha: def.alpha * (0.7 + 0.3 * rnd(k, i, 171)), scaleX: def.size, scaleY: def.size })
        flakes.push({ u: rnd(k, i, 172) * FIELD_W, v: rnd(k, i, 173) * FIELD_H, ph: rnd(k, i, 174) * 6.28, p })
        layer.addParticle(p)
      }
      ;(i === 0 ? this.behind : this.ahead).addChild(layer)
      this.planes.push({ layer, flakes, def })
    })
    this.surface.addChild(this.glints.layer, this.motes.layer)
    this.behind.visible = false
    this.ahead.visible = false
    this.mist.visible = false
    this.motes.solid = (x, y) => {
      const t = this.terrain
      if (!t) return false
      const xi = Math.round(x)
      const yi = Math.round(y)
      if (xi < 0 || yi < 0 || xi >= t.w || yi >= t.h) return false
      const m = t.front[yi * t.w + xi]
      return m !== AIR && LIQ[m] === 0
    }
  }

  get active(): boolean {
    return this.on
  }

  setBiome(b: Biome): void {
    this.on = b === 'snow'
    this.behind.visible = this.on
    this.ahead.visible = this.on
    this.mist.visible = this.on
    this.scanDirty = true
  }

  reset(): void {
    this.motes.clear()
    this.breath.clear()
    this.iceSlide.clear()
    this.iceTop = new Int32Array(0)
    this.snowTop = new Int32Array(0)
    this.scanDirty = true
    this.scanAge = Infinity
  }

  // ¿Qué hay bajo el punto (x = centro, y = piso)? 1 nieve, 2 hielo, 0 otra cosa. Mira 3 filas.
  ground(t: Terrain, x: number, y: number): number {
    const xi = Math.round(x)
    if (xi < 0 || xi >= t.w) return 0
    for (let yy = Math.max(0, Math.round(y) - 1); yy < Math.min(t.h, Math.round(y) + 3); yy++) {
      const m = t.front[yy * t.w + xi]
      if (m !== AIR && LIQ[m] === 0) return COLD[m]
    }
    return 0
  }

  // Cada frame. camX/camY/z: cámara con sacudón (origen del mundo en pantalla); x0..x1, y0..y1: vista en mundo.
  update(t: Terrain, players: Player[], changed: boolean, dt: number, wind: number, camX: number, camY: number, z: number, x0: number, x1: number, y0: number, y1: number, crewIn: { x: number; y: number }): void {
    this.terrain = t
    this.time += dt
    if (changed) this.scanDirty = true
    this.scanAge += dt
    if (this.scanDirty && (this.scanAge >= SCAN_EVERY || this.scanW !== t.w)) this.scan(t)
    for (const [id, s] of this.iceSlide) {
      s.left -= dt
      if (s.left <= 0) this.iceSlide.delete(id)
    }
    if (this.on) {
      this.flakes(dt, wind, camX, camY)
      this.placeMist(t, x0, x1, wind)
      if (dt > 0) this.breathe(players, dt, wind, crewIn)
    }
    this.surfaceGlints(t, x0, x1, y0, y1)
    this.motes.update(dt, this.time)
  }

  // Busca las celdas de superficie de nieve y de hielo. Una pasada de bytes por la grilla, como mucho cada
  // SCAN_EVERY segundos mientras la grilla cambia (flujos, derrumbes); sin nieve ni hielo queda vacío.
  private scan(t: Terrain): void {
    this.scanDirty = false
    this.scanAge = 0
    this.scanW = t.w
    const f = t.front
    const W = t.w
    const ice: number[] = []
    const snow: number[] = []
    for (let k = W; k < f.length; k++) {
      const m = f[k]
      if (m !== ICE && m !== SNOW) continue
      if (f[k - W] !== AIR) continue
      if (m === ICE) ice.push(k)
      else if (((k * 7) & 3) === 0) snow.push(k) // una de cada cuatro alcanza para los destellos
    }
    this.iceTop = Int32Array.from(ice)
    this.snowTop = Int32Array.from(snow)
  }

  private flakes(dt: number, wind: number, camX: number, camY: number): void {
    for (const pl of this.planes) {
      const d = pl.def
      for (const fl of pl.flakes) {
        if (dt > 0) {
          fl.ph += dt * 1.7
          fl.u += (wind * 2.2 * d.par + Math.sin(fl.ph) * 6) * dt
          fl.v += d.vy * dt
        }
        let x = (fl.u + camX * d.par) % FIELD_W
        if (x < 0) x += FIELD_W
        let y = (fl.v + camY * d.par) % FIELD_H
        if (y < 0) y += FIELD_H
        fl.p.x = Math.round(x) - 12
        fl.p.y = Math.round(y) - 12
      }
    }
  }

  // Niebla fría: una banda tramada que se apoya cerca del pie del mundo y deriva con el viento.
  private placeMist(t: Terrain, x0: number, x1: number, wind: number): void {
    if (!this.mistTex) this.mistTex = mistTexture()
    const off = (this.time * (3 + wind * 0.8)) % MIST_TILE
    const first = Math.floor((x0 - off) / MIST_TILE)
    const need = Math.ceil((x1 - x0) / MIST_TILE) + 2
    while (this.mistTiles.length < need) {
      const s = new Sprite(this.mistTex)
      this.mistTiles.push(s)
      this.mist.addChild(s)
    }
    this.mistTiles.forEach((s, i) => {
      s.visible = i < need
      s.x = Math.round((first + i) * MIST_TILE + off)
      s.y = t.h - 150
    })
  }

  // Aliento del tripulante: una bocanada blanca chica que sale hacia adelante y se deshace.
  private breathe(players: Player[], dt: number, wind: number, crewIn: { x: number; y: number }): void {
    for (const p of players) {
      if (!p.alive) continue
      const t = (this.breath.get(p.id) ?? (p.id * 0.7) % BREATH_EVERY) + dt
      if (t < BREATH_EVERY) {
        this.breath.set(p.id, t)
        continue
      }
      this.breath.set(p.id, 0)
      const facing = p.angle > 90 ? -1 : 1
      const mx = p.x + facing * (crewIn.x + 10 - TANK_W / 2)
      const my = p.y - TANK_H + crewIn.y + 8
      for (let i = 0; i < 3; i++) {
        this.motes.spawn({ x: mx + facing * i, y: my - (i === 2 ? 1 : 0), vx: facing * (7 + i * 3) + wind * 0.8, vy: -3 - i, drag: 1.2, life: 0.9 + i * 0.25, color: 0xf4f8ff, alpha: 0.55 - i * 0.1, size: i === 1 ? 2 : 1 })
      }
    }
  }

  // Reflejos que corren por la superficie del hielo (y en diagonal hacia adentro) y destellos sueltos en la nieve.
  private surfaceGlints(t: Terrain, x0: number, x1: number, y0: number, y1: number): void {
    const g = this.glints
    g.begin()
    const W = t.w
    const f = t.front
    const ice = this.iceTop
    const tt = this.time
    for (let i = 0; i < ice.length; i++) {
      const k = ice[i]
      const y = (k / W) | 0
      const x = k - y * W
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue
      let ph = (x + (y >> 1) - tt * GLINT_SPEED) % GLINT_PERIOD
      if (ph < 0) ph += GLINT_PERIOD
      if (ph >= 4) continue
      g.add(x, y, 0xffffff, ph < 2 ? 0.95 : 0.5)
      for (let d = 1; d <= 4; d++) {
        if (f[k + d * W + d] !== ICE) break
        g.add(x + d, y + d, 0xf0fbff, (ph < 2 ? 0.55 : 0.3) * (1 - d / 5))
      }
    }
    const snow = this.snowTop
    const step = Math.floor(tt * 3)
    for (let i = 0; i < snow.length; i++) {
      const k = snow[i]
      if ((hash(k, step, 175) & 1023) > 5) continue
      const y = (k / W) | 0
      const x = k - y * W
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue
      g.add(x, y - 1, 0xffffff, 0.9)
    }
    g.end()
  }

  // ---------- eventos y ganchos ----------

  onEvent(ev: GameEvent, t: Terrain): void {
    if (ev.type === 'slide' && ev.cause === 'ice' && ev.path.length >= 2) {
      const dir = Math.sign(ev.path[ev.path.length - 1].x - ev.path[0].x) || 1
      this.iceSlide.set(ev.playerId, { left: ev.path.length * (1 / 30) + 0.2, dir })
    } else if (ev.type === 'impact') {
      const sn = ev.debris[SNOW] ?? 0
      const ic = ev.debris[ICE] ?? 0
      if (sn + ic > 0) this.powder(ev.x, ev.y, ev.radius, sn, ic)
    }
    void t
  }

  // Segundos que le quedan a un patinazo en el hielo (para la oruga sin tracción); 0 = no patina.
  slipping(id: number): number {
    return this.iceSlide.get(id)?.left ?? 0
  }

  // Extra de giro de la oruga (px/s en el sentido del mundo) mientras patina en el hielo.
  slip(id: number): number {
    const s = this.iceSlide.get(id)
    return s ? s.dir * ICE_SPIN * Math.min(1, s.left / 0.4) : 0
  }

  // Partículas de las orugas sobre nieve o hielo. Devuelve true si el piso es frío (el renderer no tira polvo
  // de tierra). moved: px que avanzó el tanque este frame; sliding: se está deslizando.
  tread(t: Terrain, p: Player, moved: number, sliding: boolean, dt: number): boolean {
    if (dt <= 0 || moved === 0) return false
    const g = this.ground(t, p.x, p.y)
    if (!g) return false
    const dir = Math.sign(moved)
    const back = p.x - dir * (TANK_W / 2 - 2)
    const front = p.x + dir * (TANK_W / 2 - 1)
    const r = (s: number): number => rnd(Math.round(p.x * 7), Math.round(this.time * 60), s)
    if (g === 2 && (sliding || this.iceSlide.has(p.id))) {
      // patinando en el hielo: chispas de hielo bajas desde el canto de las orugas y una raya de escarcha
      for (let i = 0; i < 2; i++) {
        this.motes.spawn({ x: front, y: p.y - 1, vx: dir * (30 + r(181 + i) * 50), vy: -(10 + r(183 + i) * 30), ay: 220, life: 0.25 + r(185) * 0.2, color: i ? 0xffffff : 0xbfe8ff })
      }
      if (r(186) < 0.6) this.motes.spawn({ kind: 'star', x: front - dir * 3, y: p.y - 1, life: 0.18, color: 0xeaf8ff })
      this.motes.spawn({ x: back, y: p.y - 1, life: 0.5, color: 0xe6f6ff, alpha: 0.7 })
    } else if (g === 2) {
      if (r(187) < 0.3) this.motes.spawn({ x: back, y: p.y - 1, vx: -dir * 12, vy: -8, ay: 120, life: 0.3, color: 0xd8f0ff })
    } else {
      // nieve: bocanadas blancas bajas hacia atrás y algún terrón
      for (let i = 0; i < (sliding ? 2 : 1); i++) {
        this.motes.spawn({ x: back, y: p.y - 1 - r(188 + i) * 2, vx: -dir * (14 + r(190 + i) * 24), vy: -(8 + r(192 + i) * 14), drag: 3, ay: 30, life: 0.45 + r(194) * 0.3, color: 0xf2f6fc, alpha: 0.8, size: r(195) < 0.4 ? 2 : 1 })
      }
      if (r(196) < 0.4) this.motes.spawn({ x: back, y: p.y - 2, vx: -dir * (20 + r(197) * 30), vy: -(30 + r(198) * 30), ay: 260, life: 0.6, color: 0xdce6f0, size: 2 })
    }
    return true
  }

  // Caída o aterrizaje sobre nieve: nube de polvo blanco en vez de tierra. Devuelve true si el piso es frío.
  landing(t: Terrain, x: number, y: number, n = 10): boolean {
    const g = this.ground(t, x, y)
    if (!g) return false
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1
      const r1 = rnd(Math.round(x), i, 201)
      this.motes.spawn({ x: x + (r1 - 0.5) * TANK_W, y: y - 1 - rnd(i, Math.round(y), 202) * 3, vx: side * (12 + r1 * 40), vy: -(10 + rnd(i, 3, 203) * 20), drag: 3, ay: 25, life: 0.7 + r1 * 0.5, color: g === 2 ? 0xe2f4ff : 0xf6f9fd, alpha: 0.85, size: i % 3 === 0 ? 2 : 1 })
    }
    return true
  }

  // Explosión que rompió nieve o hielo: polvo de nieve que queda flotando y, en el hielo, astillas que brillan.
  private powder(x: number, y: number, radius: number, sn: number, ic: number): void {
    const n = Math.min(40, Math.round((sn + ic) / 12) + 8)
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * rnd(i, Math.round(x), 211)
      const sp = 20 + rnd(i, Math.round(y), 212) * (40 + radius * 2)
      const isIce = ic > 0 && i % 3 === 0
      this.motes.spawn({
        kind: isIce && i % 2 === 0 ? 'star' : 'px',
        x: x + Math.cos(a) * radius * 0.5,
        y: y + Math.sin(a) * radius * 0.4,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 10,
        drag: isIce ? 0.8 : 2.4,
        ay: isIce ? 200 : 18,
        life: isIce ? 0.6 + rnd(i, 1, 213) * 0.4 : 1.2 + rnd(i, 2, 214) * 1.2,
        color: isIce ? 0xd8f4ff : 0xf4f8fd,
        alpha: isIce ? 1 : 0.75,
        size: !isIce && i % 4 === 0 ? 2 : 1,
      })
    }
  }
}

// Banda de niebla de MIST_TILE × MIST_H, periódica a lo ancho: más densa abajo, con bordes de trama.
function mistTexture(): Texture {
  const c = document.createElement('canvas')
  c.width = MIST_TILE
  c.height = MIST_H
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(MIST_TILE, MIST_H)
  for (let y = 0; y < MIST_H; y++) {
    for (let x = 0; x < MIST_TILE; x++) {
      // ruido periódico: el ruido de valor sobre una grilla que divide al ancho del tile
      const n = vnoiseWrap(x, y, 32, 14, 221)
      const v = (y / MIST_H) * 0.9 + (n - 0.5) * 0.6
      if (v < 0.35 + bayer(x, y) * 0.5) continue
      const i = (y * MIST_TILE + x) * 4
      img.data[i] = 0xe6
      img.data[i + 1] = 0xee
      img.data[i + 2] = 0xf8
      img.data[i + 3] = Math.round(255 * (0.16 + 0.12 * Math.min(1, v)))
    }
  }
  ctx.putImageData(img, 0, 0)
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}

function vnoiseWrap(x: number, y: number, sx: number, sy: number, seed: number): number {
  const cells = MIST_TILE / sx
  const gx = x / sx
  const gy = y / sy
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const w = (k: number): number => ((k % cells) + cells) % cells
  const a = rnd(w(x0), y0, seed)
  const b = rnd(w(x0 + 1), y0, seed)
  const c = rnd(w(x0), y0 + 1, seed)
  const d = rnd(w(x0 + 1), y0 + 1, seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
