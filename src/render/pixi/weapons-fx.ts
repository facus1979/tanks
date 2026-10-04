// v3 (render-armas): efectos de las 8 armas nuevas.
// - Explosiones de los BlastStyle nuevos (spark, laser, quake, blackhole, acid, wall) con las partículas de
//   Fx (fxkit.ts) y, para lo que dura o tiene forma propia (rayo, remolino, grietas, arcos eléctricos), una
//   capa de pixels en GPU (pixels.ts).
// - Proyectiles en vuelo de las armas nuevas (misil teledirigido con llama y estela, rebotadora, mina,
//   frasco de ácido, orbe del agujero negro, obús del terremoto, bloque del muro).
// - Eventos beam, quake y pull; tanques corroídos por el ácido.
// Todo con topes: motas (Motes), sprites por frame (PixelLayer) y partículas de Fx (MAX_PARTICLES).
import type { BlastStyle, Player, Terrain, Vec2, WeaponId } from '../../sim/types'
import { AIR } from '../../sim/types'
import { DEBRIS_COLORS, OUT } from './fallback'
import type { Fx } from './fx'
import type { Motes, PixelLayer } from './pixels'
import { glowTexture, materialAt, rr, solidAt, surfaceBelow } from './pixels'
import { mix } from './raster'

// ---------- paletas ----------
const SPARK_RAMP = [0xffffff, 0xfffbe2, 0xfff1a8, 0xffd24a, 0xf7a028, 0x8a3a14]
const ACID_RAMP = [0xf6ffd0, 0xdcff6a, 0xa8e82c, 0x6cbc1e, 0x3c8418, 0x1e4a10]
const ACID_OUT = 0x0e2008
const TOXIC = [0xe4f0a0, 0xc4d878, 0x9cb456, 0x76883e, 0x4e5a2a]
const TOXIC_OUT = 0x2a3414
const ACID_DROPS = [0xc8f040, 0x8cd422, 0x5aa01a, 0xe8ff90]
const VOID_RAMP = [0xffffff, 0xeedcff, 0xc8a0ff, 0x9060e8, 0x5a30b0, 0x2a1460]
const VOID_OUT = 0x0a0418
const VIOLET = 0xb070ff
const VIOLET_HI = 0xe8d4ff
const DUST_RAMP = [0xc8b89a, 0xb09c7e, 0x9a8468, 0x7a6650, 0x5a4a3a]
const ELECTRIC = 0xe8f4ff
const ELECTRIC_EDGE = 0x7ab4ff
const LASER_DEFAULT = 0xff3a5a

// Armas cuyo proyectil dibuja este módulo (el renderer no le pasa esas a Fx.draw).
export const V3_SHOTS = new Set<WeaponId>(['guided', 'bouncer', 'laser', 'mine', 'quake', 'blackhole', 'acid', 'wall'])

export interface V3Ctx {
  fx: Fx
  motes: Motes
  terrain: () => Terrain | null
  addCrater: (x: number, y: number, r: number) => void
}

interface Arc {
  pts: number[]
  age: number
  life: number
}

interface Beam {
  x0: number
  y0: number
  x1: number
  y1: number
  color: number
  age: number
  life: number
  edges: number[] | null // celdas de terreno al rojo junto al rayo (x, y)
  burned: boolean
}

interface Glow {
  x: number
  y: number
  R: number
  color: number
  k: number
  age: number
  life: number
}

interface Quake {
  x: number
  y: number
  R: number
  age: number
  life: number
  cols: number[] // x, y del piso cada pocos px
  cracks: number[][] // pixels de cada grieta (x, y), en el orden en que se abre
  acc: number
}

interface Vortex {
  x: number
  y: number
  R: number
  age: number
  dur: number
  spin: number
  acc: number
  done: boolean
}

interface Rise {
  x0: number
  x1: number
  top: number
  base: number
  age: number
  life: number
  acc: number
  ghost: boolean // no se encontró la pared en el terreno (?fxtest): se dibuja una de mentira mientras sube
}

interface ShotTrack {
  x: number
  y: number
  ux: number
  uy: number
  acc: number
}

const VORTEX_END = 0.35 // implosión después de la duración

export class WeaponsFx {
  private arcs: Arc[] = []
  private beams: Beam[] = []
  private glows: Glow[] = []
  private quakes: Quake[] = []
  private vortices: Vortex[] = []
  private rises: Rise[] = []
  private corrode = new Map<number, number>() // id de tanque → segundos que le quedan corroyéndose
  private tracks: ShotTrack[] = []
  private time = 0
  private shakeHold = 0 // terremoto: piso del sacudón mientras dura
  private shakeLeft = 0
  // textura del misil pintada por el arte (props.missile), si está
  missileTex: import('pixi.js').Texture | null = null

  constructor(private c: V3Ctx) {}

  private get k() {
    return this.c.fx.kit
  }

  reset(): void {
    this.arcs = []
    this.beams = []
    this.glows = []
    this.quakes = []
    this.vortices = []
    this.rises = []
    this.corrode.clear()
    this.tracks = []
    this.shakeHold = 0
    this.shakeLeft = 0
  }

  get busy(): boolean {
    return this.arcs.length + this.beams.length + this.glows.length + this.quakes.length + this.vortices.length + this.rises.length + this.corrode.size > 0
  }

  private kick(shake: number, flash: number, stop = 0): void {
    const fx = this.c.fx
    fx.shake = Math.max(fx.shake, shake)
    fx.flash = Math.max(fx.flash, flash)
    fx.hitStop = Math.max(fx.hitStop, stop)
  }

  private debrisColor(debris: Partial<Record<number, number>>, fallback: number[]): number {
    let total = 0
    for (const v of Object.values(debris)) total += v ?? 0
    if (total > 0) {
      let pick = rr(0, total)
      for (const [m, v] of Object.entries(debris)) {
        pick -= v ?? 0
        if (pick <= 0) {
          const cols = DEBRIS_COLORS[Number(m)] ?? fallback
          return cols[Math.floor(rr(0, cols.length))]
        }
      }
    }
    return fallback[Math.floor(rr(0, fallback.length))]
  }

  // ---------- explosiones ----------

  // Devuelve true si el estilo es de v3 y ya lo dibujó (si no, el renderer usa Fx.explosion).
  blast(style: BlastStyle, x: number, y: number, radius: number, debris: Partial<Record<number, number>>, dirX: number, dirY: number, players: Player[]): boolean {
    switch (style) {
      case 'spark':
        this.spark(x, y, radius, debris)
        break
      case 'laser':
        this.laserHit(x, y, radius, dirX, dirY, debris)
        break
      case 'quake':
        this.quake(x, y, radius, true)
        break
      case 'blackhole':
        this.blackholePop(x, y, radius, debris)
        break
      case 'acid':
        this.acid(x, y, radius, debris, players)
        break
      case 'wall':
        this.wall(x, y, radius)
        break
      default:
        return false
    }
    this.k.cap()
    return true
  }

  // Rebotadora (cada rebote) y mina: estallido eléctrico chico, muchas chispas, arcos y un fogonazo.
  // La mina (radio grande) además hace la bola de fuego entera.
  private spark(x: number, y: number, radius: number, debris: Partial<Record<number, number>>): void {
    const k = this.k
    const s = Math.max(0.5, radius / 15)
    const big = radius >= 16
    k.blob({ layer: 4, ox: x, oy: y - 2, r0: 3 * s, r1: 7 * s, grow: 0.03, life: 0.08, ramp: SPARK_RAMP, outline: 0xffb43e, heat0: -0.3 })
    k.blob({ layer: 2, ox: x, oy: y - 3, r0: 3 * s, r1: 8 * s, grow: 0.05, hold: 0.06, life: 0.2, ramp: SPARK_RAMP, outline: 0x8a3a14, heat0: 0, heatV: 3.5 })
    if (big) {
      k.fireball(x, y, s, 0.9, debris, 1)
      this.kick(Math.min(10, 3 + radius * 0.3), 0.35, 0.05)
    } else {
      k.fireball(x, y, s * 0.8, 0.6, debris, 0.35, true)
      this.kick(Math.min(6, 2 + radius * 0.25), 0.18, 0.03)
    }
    const n = Math.round(18 + radius * 1.4)
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (rr(0, 1) - 0.5) * Math.PI * 1.7
      const sp = rr(90, 240) * Math.sqrt(s)
      k.spark(x, y - 2, Math.cos(a) * sp, Math.sin(a) * sp, rr(0.2, 0.5))
    }
    // pedacitos que saltan del suelo
    for (let i = 0; i < 6 + radius / 2; i++) {
      const a = -Math.PI * rr(0.1, 0.9)
      const sp = rr(60, 150)
      k.debris(x, y - 2, Math.cos(a) * sp, Math.sin(a) * sp, this.debrisColor(debris, DEBRIS_COLORS[1]), Math.floor(rr(0, 3)), rr(0.8, 1.4))
    }
    this.addArcs(x, y - 3, radius * 1.4, big ? 5 : 3, 0.14)
    k.light(x, y - 4, 26 + radius * 1.6, 0xfff0b0, 0.5, 0.25)
    this.glows.push({ x, y: y - 3, R: 10 + radius, color: 0x9ac8ff, k: 0.7, age: 0, life: 0.18 })
  }

  // Arcos eléctricos: líneas quebradas que salen del centro y duran un instante.
  private addArcs(x: number, y: number, len: number, n: number, life: number): void {
    for (let i = 0; i < n; i++) {
      const a = rr(0, Math.PI * 2)
      const pts = [x, y]
      let px = x
      let py = y
      const steps = 4 + Math.floor(rr(0, 3))
      for (let j = 0; j < steps; j++) {
        const d = (len / steps) * rr(0.7, 1.3)
        const b = a + rr(-0.8, 0.8)
        px += Math.cos(b) * d
        py += Math.sin(b) * d
        pts.push(px, py)
      }
      this.arcs.push({ pts, age: 0, life: life * rr(0.7, 1.2) })
    }
  }

  // Punta del láser: metal fundido, chispas hacia atrás y un humito.
  private laserHit(x: number, y: number, radius: number, dirX: number, dirY: number, debris: Partial<Record<number, number>>): void {
    const k = this.k
    k.blob({ layer: 4, ox: x, oy: y, r0: 3, r1: 6 + radius, grow: 0.02, life: 0.07, ramp: [0xffffff, 0xffffff, 0xfff1f4, 0xffc0d0], outline: 0xff7a9a, heat0: -0.3 })
    k.blob({ layer: 1, ox: x, oy: y, r0: 2, r1: 4 + radius * 0.6, grow: 0.04, hold: 0.12, life: 0.35, ramp: SPARK_RAMP, outline: 0x8a2814, heat0: 0.1, heatV: 2.4 })
    const back = Math.atan2(-dirY, -dirX)
    for (let i = 0; i < 26; i++) {
      const a = back + (rr(0, 1) - 0.5) * 2.4
      const sp = rr(70, 220)
      k.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 30, rr(0.2, 0.55))
    }
    for (let i = 0; i < 6; i++) {
      const a = back + (rr(0, 1) - 0.5) * 2
      k.debris(x, y, Math.cos(a) * rr(40, 110), Math.sin(a) * rr(40, 110) - 40, this.debrisColor(debris, [0xffb43e, 0xf77a28]), 0, rr(0.6, 1))
    }
    for (let i = 0; i < 4; i++) k.soft({ x0: x + rr(-3, 3), y0: y - 2, vx: rr(-8, 8), vy: -14 - rr(0, 10), drag: 1.5, r0: 1.2, r1: 3.5 + rr(0, 2), life: 1 + rr(0, 0.6), inner: 0xd8d0c8, edge: 0x948a80, a0: 0.7, keep: 0.2 })
    this.glows.push({ x, y, R: 14, color: 0xffa060, k: 0.9, age: 0, life: 0.9 })
    k.light(x, y, 30, 0xff9a70, 0.45, 0.3)
    this.kick(3, 0.1, 0.02)
  }

  // Rayo del láser (evento beam): núcleo blanco, halo del color del que tiró, chispas por donde corta y
  // quemaduras en el terreno a lo largo del camino.
  beam(x0: number, y0: number, x1: number, y1: number, color: number | null): void {
    const col = color ?? LASER_DEFAULT
    this.beams.push({ x0, y0, x1, y1, color: col, age: 0, life: 0.55, edges: null, burned: false })
    const k = this.k
    // fogonazo en la boca
    k.blob({ layer: 4, ox: x0, oy: y0, r0: 2, r1: 5, grow: 0.02, life: 0.08, ramp: [0xffffff, 0xffffff, mix(col, 0xffffff, 0.6)], outline: col, heat0: -0.3 })
    k.light(x0, y0, 26, col, 0.4, 0.2)
    // luz a lo largo del rayo (pocas, grandes: el buffer de luces cuesta por área)
    const len = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.min(4, Math.max(1, Math.round(len / 120)))
    for (let i = 1; i <= n; i++) {
      const u = i / (n + 1)
      k.light(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, 34, col, 0.28, 0.4)
    }
    this.kick(4, 0.22, 0.03)
    this.c.fx.flashColor = mix(col, 0xffffff, 0.75)
  }

  // Celdas sólidas pegadas al rayo (hasta 3 px a cada lado): se ponen al rojo y se enfrían.
  private beamEdges(b: Beam, t: Terrain): number[] {
    const out: number[] = []
    const dx = b.x1 - b.x0
    const dy = b.y1 - b.y0
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    for (let s = 0; s <= len && out.length < 400; s += 1) {
      const x = b.x0 + ux * s
      const y = b.y0 + uy * s
      for (const side of [-1, 1]) {
        for (let o = 1; o <= 4; o++) {
          const cx = Math.round(x - uy * o * side)
          const cy = Math.round(y + ux * o * side)
          if (solidAt(t, cx, cy)) {
            out.push(cx, cy)
            break
          }
        }
      }
    }
    return out
  }

  // Terremoto: sacudón fuerte y largo, polvo que sube del piso en toda la zona, grietas y piedritas.
  // Lo arranca el evento quake o el impacto con blast 'quake' (lo que llegue primero; el otro se suma).
  quake(x: number, y: number, R: number, fromImpact: boolean): void {
    const near = this.quakes.find((q) => q.age < 0.6 && Math.hypot(q.x - x, q.y - y) < 30)
    if (near) {
      near.R = Math.max(near.R, R)
      return
    }
    const t = this.c.terrain()
    const cols: number[] = []
    const cracks: number[][] = []
    if (t) {
      for (let cx = Math.round(x - R); cx <= x + R; cx += 5) {
        const sy = surfaceBelow(t, cx, y - R, y + R * 0.6)
        if (sy >= 0) cols.push(cx, sy)
      }
      // grietas: arrancan en el piso y bajan quebrándose; solo por terreno sólido
      const nc = Math.min(8, 3 + Math.round(R / 18))
      for (let i = 0; i < nc && cols.length; i++) {
        const j = Math.floor(rr(0, cols.length / 2)) * 2
        let px = cols[j]
        let py = cols[j + 1] + 1
        const pts: number[] = []
        const len = rr(16, 30) * Math.min(1.6, R / 60)
        let dir = rr(-0.6, 0.6)
        for (let s = 0; s < len; s++) {
          if (!solidAt(t, px, py)) break
          pts.push(px, py)
          // rama corta
          if (s > 3 && rr(0, 1) < 0.12) {
            const bx = px + (rr(0, 1) < 0.5 ? -1 : 1)
            if (solidAt(t, bx, py + 1)) pts.push(bx, py + 1)
          }
          dir += rr(-0.5, 0.5)
          dir = Math.max(-1.2, Math.min(1.2, dir))
          if (Math.abs(dir) > 0.6) px += Math.sign(dir)
          else py++
          if (rr(0, 1) < 0.5) py++
        }
        if (pts.length > 4) cracks.push(pts)
      }
    }
    this.quakes.push({ x, y, R, age: 0, life: 4.5, cols, cracks, acc: 0 })
    this.shakeHold = 11
    this.shakeLeft = 1.4
    this.kick(14, fromImpact ? 0.12 : 0.08, 0.04)
    // golpe inicial: piedritas que saltan en toda la zona
    const k = this.k
    for (let i = 0; i + 1 < cols.length && i < 80; i += 4) {
      const m = t ? materialAt(t, cols[i], cols[i + 1] + 1) : 1
      const pal = DEBRIS_COLORS[m] ?? DEBRIS_COLORS[1]
      for (let j = 0; j < 2; j++) k.debris(cols[i] + rr(-2, 2), cols[i + 1] - 1, rr(-40, 40), -rr(60, 160), pal[Math.floor(rr(0, pal.length))], Math.floor(rr(0, 4)), rr(0.8, 1.5))
    }
    // anillo de polvo apoyado en el piso desde el centro
    for (let i = 0; i + 1 < cols.length; i += 2) {
      const d = Math.abs(cols[i] - x) / Math.max(1, R)
      k.soft({ x0: cols[i], y0: cols[i + 1], vx: Math.sign(cols[i] - x) * rr(10, 30), vy: -rr(1, 3), drag: 2.2, r0: 2, r1: rr(5, 8) * (1.2 - d * 0.5), life: rr(1.2, 1.9), inner: 0xd2c6b0, edge: 0x9e907c, a0: 0.85, keep: 0.3, puff: 0.6 })
    }
    k.light(x, y, 40, 0xffd8a0, 0.2, 0.3)
  }

  // Agujero negro: el impacto hace un fogonazo violeta; el remolino lo arranca el evento pull (o, si no
  // llega, el propio impacto con los valores del arma).
  private blackholePop(x: number, y: number, radius: number, debris: Partial<Record<number, number>>): void {
    const k = this.k
    k.blob({ layer: 4, ox: x, oy: y, r0: 3, r1: 8 + radius * 0.4, grow: 0.03, life: 0.1, ramp: VOID_RAMP, outline: VOID_OUT, heat0: -0.2 })
    k.blob({ layer: 1, ox: x, oy: y, r0: 4, r1: 10 + radius * 0.5, grow: 0.05, hold: 0.05, life: 0.25, ramp: VOID_RAMP, outline: VOID_OUT, heat0: 0.1, heatV: 3 })
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI * rr(0.05, 0.95)
      k.debris(x, y - 2, Math.cos(a) * rr(50, 120), Math.sin(a) * rr(50, 120), this.debrisColor(debris, DEBRIS_COLORS[1]), Math.floor(rr(0, 4)), rr(0.6, 1.2))
    }
    k.light(x, y, 40, 0x9a60ff, 0.5, 0.3)
    this.kick(5, 0.1, 0.04)
    this.c.fx.flashColor = 0xe8d4ff
    this.vortex(x, y, 80, 1.2, true)
  }

  // Remolino del agujero negro durante `dur` segundos y después la implosión.
  vortex(x: number, y: number, R: number, dur: number, guess = false): void {
    const near = this.vortices.find((v) => !v.done && Math.hypot(v.x - x, v.y - y) < 24)
    if (near) {
      // el evento pull manda sobre el valor adivinado del impacto
      if (!guess) {
        near.R = R
        near.dur = Math.max(near.age + 0.2, dur)
      }
      return
    }
    this.vortices.push({ x, y, R, age: 0, dur, spin: rr(0, 1) < 0.5 ? -1 : 1, acc: 0, done: false })
  }

  private implode(v: Vortex): void {
    const k = this.k
    k.blob({ layer: 4, ox: v.x, oy: v.y, r0: 2, r1: 12, grow: 0.04, life: 0.12, ramp: VOID_RAMP, outline: VOID_OUT, heat0: -0.4 })
    k.blob({ layer: 2, ox: v.x, oy: v.y, r0: 6, r1: 16, grow: 0.06, hold: 0.04, life: 0.28, ramp: VOID_RAMP, outline: VOID_OUT, heat0: 0, heatV: 3 })
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2
      const sp = rr(80, 200)
      this.c.motes.add({ x: v.x, y: v.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3, life: rr(0.3, 0.6), c0: VIOLET_HI, c1: VIOLET, tail: true })
    }
    k.light(v.x, v.y, 54, 0xa070ff, 0.6, 0.35)
    this.kick(7, 0.35, 0.05)
    const fx = this.c.fx
    fx.flashColor = 0xe8d4ff
    fx.glowColor = 0x8040ff
    fx.glow = Math.max(fx.glow, 0.5)
  }

  // Ácido: salpicadura verde, gotas que corren, humo tóxico y tanques cercanos corroyéndose.
  private acid(x: number, y: number, radius: number, debris: Partial<Record<number, number>>, players: Player[]): void {
    const k = this.k
    const s = Math.max(0.6, radius / 15)
    k.blob({ layer: 4, ox: x, oy: y - 2, r0: 3, r1: 7 * s, grow: 0.03, life: 0.07, ramp: ACID_RAMP, outline: ACID_OUT, heat0: -0.3 })
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI * rr(0.05, 0.95)
      const d = rr(4, 16) * s
      const r1 = rr(3, 6) * s
      k.blob({ layer: 1, ox: x, oy: y - 3, dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8, vy: 10, ay: 60, r0: r1 * 0.4, r1, grow: 0.06, hold: rr(0.2, 0.35), life: rr(0.4, 0.6), ramp: ACID_RAMP, outline: ACID_OUT, heat0: rr(0, 0.25), heatV: 1.6, cool: 0.12 })
    }
    // columna de humo tóxico
    for (let i = 0; i < 7; i++) {
      const t = i / 6
      const r1 = (4 + rr(0, 4) + t * 3) * s
      k.blob({ layer: 0, ox: x, oy: y - 6, dx: rr(-10, 10) * s, dy: -(10 + t * 34) * s, vx: this.c.fx.wind * 1.2, vy: -(4 + rr(0, 5)) * s, ax: this.c.fx.wind * 0.6, r0: r1 * 0.4, r1, grow: 0.25 + t * 0.2, hold: 0.9 + rr(0, 0.5), life: 2.2 + rr(0, 0.8), delay: t * 0.05, heat0: 0.1 + rr(0, 0.3), heatV: 0.05, ramp: TOXIC, outline: TOXIC_OUT, fade: true })
    }
    // gotas de ácido (escombro verde que rebota) y algún pedazo de lo que corroyó
    for (let i = 0; i < 26; i++) {
      const a = -Math.PI * rr(0.05, 0.95)
      const sp = rr(60, 190) * Math.sqrt(s)
      k.debris(x, y - 3, Math.cos(a) * sp, Math.sin(a) * sp, ACID_DROPS[i % ACID_DROPS.length], Math.floor(rr(0, 2)), rr(0.8, 1.6))
    }
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI * rr(0.1, 0.9)
      k.debris(x, y - 3, Math.cos(a) * rr(50, 130), Math.sin(a) * rr(50, 130), this.debrisColor(debris, DEBRIS_COLORS[2]), Math.floor(rr(0, 4)), rr(1, 1.6))
    }
    // burbujas que revientan sobre la zona
    for (let i = 0; i < 24; i++) this.c.motes.add({ x: x + rr(-radius, radius), y: y - rr(0, 6), vy: -rr(10, 30), drag: 1, life: rr(0.4, 1.2), c0: 0xe8ff90, c1: 0x7ad01e, size: rr(0, 1) < 0.3 ? 2 : 1 })
    k.light(x, y - 4, 34 + radius, 0x9cf040, 0.45, 0.4)
    this.glows.push({ x, y: y - 2, R: 12 + radius, color: 0x7ad01e, k: 0.6, age: 0, life: 1.2 })
    this.kick(Math.min(7, 2 + radius * 0.2), 0.12, 0.03)
    this.c.fx.flashColor = 0xe8ffc0
    for (const p of players) if (p.alive && Math.hypot(p.x - x, p.y - 10 - y) < radius + 20) this.corrodeTank(p.id, 3)
  }

  corrodeTank(id: number, seconds: number): void {
    this.corrode.set(id, Math.max(this.corrode.get(id) ?? 0, seconds))
  }

  // Muro: la pared sube desde el piso. El terreno ya trae la pared; acá va el polvo en la base, terrones que
  // caen del filo que sube y un frente claro que la recorre de abajo hacia arriba.
  private wall(x: number, y: number, radius: number): void {
    const t = this.c.terrain()
    let x0 = Math.round(x) - 2
    let x1 = Math.round(x) + 2
    let top = Math.round(y - radius * 1.6)
    let base = Math.round(y)
    let ghost = true
    if (t) {
      // columnas cuyo piso quedó bastante más arriba que el de los costados
      const tops: number[] = []
      for (let cx = Math.round(x) - 14; cx <= x + 14; cx++) tops.push(surfaceBelow(t, cx, y - radius * 3, y + radius))
      const valid = tops.filter((v) => v >= 0)
      if (valid.length) {
        const ground = Math.max(...valid)
        const hi = Math.min(...valid)
        if (ground - hi > 8) {
          ghost = false
          let a = -1
          let b = -1
          tops.forEach((v, i) => {
            if (v >= 0 && v < ground - 6) {
              if (a < 0) a = i
              b = i
            }
          })
          x0 = Math.round(x) - 14 + a
          x1 = Math.round(x) - 14 + b
          top = hi
          base = ground
        }
      }
    }
    this.rises.push({ x0, x1, top, base, age: 0, life: 0.4, acc: 0, ghost })
    const k = this.k
    const cx = (x0 + x1) / 2
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? -1 : 1
      k.soft({ x0: cx + side * rr(2, 8), y0: base, vx: side * rr(20, 60), vy: -rr(1, 4), drag: 2.6, r0: 2.5, r1: rr(5, 8), life: rr(0.9, 1.5), inner: 0xd2c6b0, edge: 0x9e907c, a0: 0.85, keep: 0.3, puff: 0.6 })
    }
    for (let i = 0; i < 5; i++) {
      const r1 = rr(4, 7)
      k.blob({ layer: 0, ox: cx + rr(-8, 8), oy: base - 4, vy: -rr(8, 16), vx: this.c.fx.wind * 1.5, r0: 2, r1, grow: 0.5, hold: 0.6, life: 1.6, delay: i * 0.05, heat0: rr(0.2, 0.5), heatV: 0.05, ramp: DUST_RAMP, outline: 0x3c2e22, fade: true })
    }
    this.kick(6, 0.04, 0.03)
  }

  // ---------- proyectiles ----------

  // Dibuja los proyectiles de las armas nuevas y su estela propia. guided: el misil se está dirigiendo.
  shots(g: PixelLayer, glow: PixelLayer, proj: Vec2[], weapon: WeaponId | null, guided: { x: number; y: number; vx: number; vy: number; guide: number } | null, dt: number): void {
    let list = proj
    // durante el guiado el flujo puede mandar el misil solo en frame.guided
    if (guided && !proj.length) list = [{ x: guided.x, y: guided.y }]
    if (!weapon || !V3_SHOTS.has(weapon) || !list.length) {
      if (!list.length) this.tracks = []
      return
    }
    if (this.tracks.length !== list.length) this.tracks = list.map((p) => ({ x: p.x, y: p.y, ux: 1, uy: 0, acc: 0 }))
    const blink = Math.floor(this.time * 10) % 2 === 0
    list.forEach((p, i) => {
      const tr = this.tracks[i]
      const dx = p.x - tr.x
      const dy = p.y - tr.y
      const d = Math.hypot(dx, dy)
      if (d > 0.3 && d < 80) {
        tr.ux = dx / d
        tr.uy = dy / d
      }
      if (guided && weapon === 'guided') {
        const sp = Math.hypot(guided.vx, guided.vy)
        if (sp > 1) {
          tr.ux = guided.vx / sp
          tr.uy = guided.vy / sp
        }
      }
      if (dt > 0 && d < 80) tr.acc += d
      tr.x = p.x
      tr.y = p.y
      const x = Math.round(p.x)
      const y = Math.round(p.y)
      switch (weapon) {
        case 'guided':
          this.missile(g, glow, p.x, p.y, tr, guided !== null && guided.guide > 0, dt)
          break
        case 'bouncer':
          // bola con púas y luz azulada que titila; chispas mientras vuela
          g.rect(x - 2, y - 2, 5, 5, OUT)
          g.rect(x - 1, y - 3, 3, 7, OUT)
          g.rect(x - 3, y - 1, 7, 3, OUT)
          g.rect(x - 1, y - 1, 3, 3, 0x6a6a64)
          g.px(x - 1, y - 1, 0xb0b0a8)
          g.px(x, y, blink ? ELECTRIC : 0x7ab4ff)
          glow.sprite(glowTexture(7), x, y, { tint: 0x7ab4ff, alpha: blink ? 0.7 : 0.4 })
          while (tr.acc >= 9) {
            tr.acc -= 9
            this.k.spark(p.x, p.y, -tr.ux * 40 + rr(-30, 30), -tr.uy * 40 + rr(-30, 30), rr(0.1, 0.22))
          }
          break
        case 'mine':
          g.rect(x - 3, y - 2, 7, 4, OUT)
          g.rect(x - 2, y - 3, 5, 6, OUT)
          g.rect(x - 2, y - 1, 5, 2, 0x55554c)
          g.px(x - 2, y - 1, 0x8c8c80)
          g.px(x, y - 2, blink ? 0xff3a2a : 0x6a1a14)
          if (blink) glow.sprite(glowTexture(5), x, y - 2, { tint: 0xff3a2a, alpha: 0.6 })
          break
        case 'acid':
          // frasco de vidrio con ácido; gotea mientras vuela
          g.rect(x - 2, y - 3, 5, 6, OUT)
          g.rect(x - 1, y - 4, 3, 1, OUT)
          g.rect(x - 1, y - 2, 3, 4, 0x8cd422)
          g.px(x - 1, y - 2, 0xe8ff90)
          g.px(x, y - 4, 0xb0a890)
          glow.sprite(glowTexture(5), x, y, { tint: 0x9cf040, alpha: 0.35 })
          while (tr.acc >= 11) {
            tr.acc -= 11
            this.c.motes.add({ x: p.x + rr(-1, 1), y: p.y + 2, vx: rr(-6, 6), vy: 10, ay: 260, life: 0.5, c0: 0xc8f040, c1: 0x5aa01a, tail: true })
          }
          break
        case 'blackhole':
          // orbe negro con borde violeta y motas que se le pegan
          g.rect(x - 2, y - 3, 5, 7, VIOLET)
          g.rect(x - 3, y - 2, 7, 5, VIOLET)
          g.rect(x - 2, y - 2, 5, 5, 0x0a0418)
          g.px(x - 1, y - 2, 0x3a2070)
          glow.sprite(glowTexture(9), x, y, { tint: 0x8040ff, alpha: 0.55 + 0.15 * Math.sin(this.time * 20) })
          if (dt > 0 && rr(0, 1) < 0.6) {
            const a = rr(0, Math.PI * 2)
            this.c.motes.add({ x: p.x + Math.cos(a) * 12, y: p.y + Math.sin(a) * 12, sx: p.x + tr.ux * 6, sy: p.y + tr.uy * 6, spin: 1, pull: 400, life: 0.35, c0: VIOLET_HI, c1: VIOLET })
          }
          break
        case 'quake':
          // obús pesado con franjas amarillas y negras
          g.rect(x - 3, y - 3, 7, 7, OUT)
          g.rect(x - 2, y - 2, 5, 5, 0xe2c13d)
          g.rect(x - 2, y - 1, 5, 1, 0x2c2622)
          g.rect(x - 2, y + 1, 5, 1, 0x2c2622)
          g.px(x - 2, y - 2, 0xfff1a8)
          break
        case 'wall':
          // bloque de tierra con ladrillitos
          g.rect(x - 3, y - 3, 7, 7, OUT)
          g.rect(x - 2, y - 2, 5, 5, 0x8a6a48)
          g.rect(x - 2, y, 5, 1, 0x5a4230)
          g.px(x, y - 2, 0x5a4230)
          g.px(x - 1, y + 1, 0x5a4230)
          g.px(x - 2, y - 2, 0xb09878)
          break
        case 'laser':
          // si el flujo lo anima como proyectil: un pulso brillante corto
          g.line(p.x - tr.ux * 5, p.y - tr.uy * 5, p.x, p.y, LASER_DEFAULT, 1, 3)
          g.line(p.x - tr.ux * 4, p.y - tr.uy * 4, p.x, p.y, 0xffffff)
          glow.sprite(glowTexture(8), x, y, { tint: LASER_DEFAULT, alpha: 0.6 })
          break
      }
    })
  }

  // Misil teledirigido: cuerpo gris con punta roja y aletas, llama naranja; mientras se dirige la llama se
  // vuelve blanca y celeste, más larga, con un brillo que late y chispas. Estela de humo propia.
  private missile(g: PixelLayer, glow: PixelLayer, x: number, y: number, tr: ShotTrack, steering: boolean, dt: number): void {
    const ux = tr.ux
    const uy = tr.uy
    const px = -uy
    const py = ux
    const tailX = x - ux * 5
    const tailY = y - uy * 5
    // llama
    const flick = 0.75 + 0.25 * Math.sin(this.time * 47) + rr(-0.1, 0.1) * (dt > 0 ? 1 : 0)
    const L = (steering ? 9 : 5) * flick
    const cols = steering ? [0xffffff, 0xd8f4ff, 0x7ad4ff, 0x3a8aff] : [0xfffbe2, 0xffe27a, 0xffb43e, 0xf77a28]
    for (let s = 1; s <= L; s++) {
      const u = s / L
      const c = cols[Math.min(3, Math.floor(u * 4))]
      const w = u < 0.5 ? 3 : 1
      g.rect(tailX - ux * s - (w >> 1), tailY - uy * s - (w >> 1), w, w, c, 1 - u * 0.5)
    }
    glow.sprite(glowTexture(steering ? 11 : 8), tailX - ux * 2, tailY - uy * 2, { tint: steering ? 0x2a7aff : 0xff8a30, alpha: steering ? 0.4 + 0.2 * Math.sin(this.time * 18) : 0.35 })
    if (this.missileTex) {
      g.sprite(this.missileTex, x, y, { rot: Math.atan2(uy, ux) })
    } else {
      g.line(tailX, tailY, x + ux * 4, y + uy * 4, OUT, 1, 3)
      g.line(tailX + px * 3, tailY + py * 3, tailX - px * 3, tailY - py * 3, OUT, 1, 2)
      g.line(tailX + ux, tailY + uy, x + ux * 2, y + uy * 2, 0xb8b8b0)
      g.px(x + ux * 3, y + uy * 3, 0xd23a2a)
      g.px(x + ux * 4, y + uy * 4, 0xd23a2a)
      g.px(tailX + px * 2, tailY + py * 2, 0x6a6a64)
      g.px(tailX - px * 2, tailY - py * 2, 0x6a6a64)
    }
    if (dt <= 0) return
    // humo: bocanadas grises por distancia recorrida (más espesas que la estela común)
    while (tr.acc >= 6) {
      tr.acc -= 6
      const r = rr(1.4, 2.4)
      this.k.soft({ x0: tailX - ux * 3, y0: tailY - uy * 3, vx: rr(-4, 4), vy: -rr(2, 6), drag: 1.5, r0: r, r1: r * 2.2, life: rr(0.9, 1.4), inner: 0xe8e2d8, edge: 0xa49a8e, a0: 0.85, keep: 0.2 })
      if (steering) this.k.spark(tailX - ux * 4, tailY - uy * 4, -ux * 60 + rr(-30, 30), -uy * 60 + rr(-30, 30), rr(0.1, 0.25))
    }
  }

  // ---------- por frame ----------

  update(players: Player[], dt: number): void {
    if (dt <= 0) return
    this.time += dt
    const t = this.c.terrain()
    const k = this.k
    for (const a of this.arcs) a.age += dt
    this.arcs = this.arcs.filter((a) => a.age < a.life)
    for (const gl of this.glows) gl.age += dt
    this.glows = this.glows.filter((gl) => gl.age < gl.life)
    for (const b of this.beams) {
      b.age += dt
      if (!b.edges && b.age >= 0.06 && t) b.edges = this.beamEdges(b, t)
      if (!b.burned && b.age >= 0.06) {
        b.burned = true
        // quemaduras permanentes (cráteres de hollín) donde el rayo rozó o cortó terreno, a lo sumo 8
        const e = b.edges ?? []
        const step = Math.max(2, Math.floor(e.length / 2 / 8)) * 2
        for (let i = 0; i + 1 < e.length; i += step) this.c.addCrater(e[i], e[i + 1], 3)
        // chispas y humito por donde cortó
        for (let i = 0; i + 1 < e.length && i < 400; i += 24) {
          k.spark(e[i], e[i + 1], rr(-60, 60), -rr(30, 110), rr(0.15, 0.4))
          if (i % 72 === 0) k.soft({ x0: e[i], y0: e[i + 1] - 1, vx: rr(-5, 5), vy: -rr(10, 20), drag: 1.5, r0: 1, r1: rr(3, 5), life: rr(0.8, 1.3), inner: 0xd8d0c8, edge: 0x948a80, a0: 0.6, keep: 0.2 })
        }
      }
    }
    this.beams = this.beams.filter((b) => b.age < 3)
    // terremoto: sostiene el sacudón y levanta polvo
    if (this.shakeLeft > 0) {
      this.shakeLeft -= dt
      const u = Math.max(0, this.shakeLeft / 1.4)
      this.c.fx.shake = Math.max(this.c.fx.shake, 2 + this.shakeHold * u)
    }
    for (const q of this.quakes) {
      q.age += dt
      if (q.age < 1.2 && q.cols.length) {
        q.acc += dt * 90 * (1 - q.age / 1.2)
        for (; q.acc >= 1; q.acc--) {
          const j = Math.floor(rr(0, q.cols.length / 2)) * 2
          const r = rr(2, 4)
          k.soft({ x0: q.cols[j] + rr(-2, 2), y0: q.cols[j + 1] - 1, vx: this.c.fx.wind + rr(-6, 6), vy: -rr(24, 55), drag: 1.2, r0: r * 0.6, r1: r * 2.8, life: rr(0.9, 1.6), inner: 0xc8b89a, edge: 0x8a7a64, a0: 0.75, keep: 0.25 })
          if (rr(0, 1) < 0.3) {
            const m = t ? materialAt(t, q.cols[j], q.cols[j + 1] + 1) : 1
            const pal = DEBRIS_COLORS[m === AIR ? 1 : m] ?? DEBRIS_COLORS[1]
            k.debris(q.cols[j], q.cols[j + 1] - 1, rr(-25, 25), -rr(40, 110), pal[Math.floor(rr(0, pal.length))], Math.floor(rr(0, 3)), rr(0.6, 1.1))
          }
        }
      }
    }
    this.quakes = this.quakes.filter((q) => q.age < q.life)
    // agujero negro: motas y escombros del terreno que se van al centro
    for (const v of this.vortices) {
      v.age += dt
      if (!v.done && v.age < v.dur) {
        v.acc += dt * 70
        for (; v.acc >= 1; v.acc--) {
          const a = rr(0, Math.PI * 2)
          const d = v.R * rr(0.5, 1)
          const mx = v.x + Math.cos(a) * d
          const my = v.y + Math.sin(a) * d
          const m = t ? materialAt(t, mx, my) : AIR
          const rubble = m !== AIR && DEBRIS_COLORS[m]
          const c0 = rubble ? DEBRIS_COLORS[m][Math.floor(rr(0, DEBRIS_COLORS[m].length))] : rr(0, 1) < 0.5 ? VIOLET_HI : VIOLET
          this.c.motes.add({ x: mx, y: my, sx: v.x, sy: v.y, spin: v.spin, pull: 160 + v.R, life: 1.6, c0, c1: rubble ? c0 : VIOLET, size: rubble && rr(0, 1) < 0.5 ? 2 : 1, tail: !rubble })
        }
      }
      if (!v.done && v.age >= v.dur + VORTEX_END) {
        v.done = true
        this.implode(v)
      }
    }
    this.vortices = this.vortices.filter((v) => !v.done)
    for (const r of this.rises) {
      r.age += dt
      const u = Math.min(1, r.age / r.life)
      const fy = r.base - (r.base - r.top) * u
      r.acc += dt * 40
      for (; r.acc >= 1; r.acc--) {
        k.debris(rr(r.x0 - 1, r.x1 + 1), fy, rr(-50, 50), -rr(20, 70), DEBRIS_COLORS[1][Math.floor(rr(0, 3))], Math.floor(rr(0, 3)), rr(0.6, 1.1))
      }
    }
    this.rises = this.rises.filter((r) => r.age < r.life + 0.15)
    // tanques corroídos: burbujas verdes sobre el casco y algún humito
    for (const [id, left] of this.corrode) {
      const p = players.find((q) => q.id === id)
      const l = left - dt
      if (!p || !p.alive || l <= 0) {
        this.corrode.delete(id)
        continue
      }
      this.corrode.set(id, l)
      if (rr(0, 1) < dt * 18) this.c.motes.add({ x: p.x + rr(-12, 12), y: p.y - rr(4, 16), vy: -rr(8, 20), drag: 1, life: rr(0.3, 0.7), c0: 0xe8ff90, c1: 0x7ad01e, size: rr(0, 1) < 0.3 ? 2 : 1 })
      if (rr(0, 1) < dt * 3) k.soft({ x0: p.x + rr(-10, 10), y0: p.y - 14, vx: this.c.fx.wind + rr(-4, 4), vy: -rr(10, 18), drag: 1.2, r0: 1.5, r1: rr(3.5, 5), life: rr(1, 1.5), inner: 0xb4c488, edge: 0x6a7a48, a0: 0.6, keep: 0.2 })
    }
  }

  // under: entre el terreno y los tanques (grietas, bordes al rojo). over/glow: encima de todo.
  draw(under: PixelLayer, over: PixelLayer, glow: PixelLayer, players: Player[]): void {
    for (const q of this.quakes) {
      const u = q.age
      const grow = Math.min(1, u / 0.3)
      const a = u > q.life - 1 ? (q.life - u) / 1 : 1
      for (const pts of q.cracks) {
        const n = Math.floor((pts.length / 2) * grow) * 2
        for (let i = 0; i + 1 < n; i += 2) {
          under.rect(pts[i], pts[i + 1], i < n / 3 ? 2 : 1, 1, OUT, a)
          // borde levantado más claro a la derecha de la grieta
          if (i % 4 === 0) under.px(pts[i] + 2, pts[i + 1], 0x9a8468, a * 0.7)
        }
      }
    }
    for (const b of this.beams) {
      // bordes al rojo que se enfrían: blanco → naranja → rojo oscuro → nada
      if (b.edges && b.age < 2.6) {
        const u = b.age / 2.6
        const c = u < 0.15 ? 0xfff1c0 : u < 0.4 ? 0xffb43e : u < 0.7 ? 0xd24a1c : 0x6a1a10
        const a = u < 0.7 ? 1 : (1 - u) / 0.3
        for (let i = 0; i + 1 < b.edges.length; i += 2) under.px(b.edges[i], b.edges[i + 1], c, a)
      }
      if (b.age >= b.life) continue
      // rayo: halo ancho del color del que tiró, núcleo blanco que se afina y titila
      const u = b.age / b.life
      const w = u < 0.15 ? 7 : u < 0.6 ? 5 : 3
      const flick = Math.sin(b.age * 90) > 0 ? 1 : 0.8
      over.bar(b.x0, b.y0, b.x1, b.y1, w + 4, b.color, 0.35 * (1 - u) * flick)
      over.bar(b.x0, b.y0, b.x1, b.y1, w, mix(b.color, 0xffffff, 0.25), 0.9 * (1 - u * 0.6))
      over.bar(b.x0, b.y0, b.x1, b.y1, u < 0.6 ? 2 : 1, 0xffffff, 1 - u * 0.4)
      const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
      for (let s = 0; s <= len; s += 36) {
        const x = b.x0 + ((b.x1 - b.x0) * s) / (len || 1)
        const y = b.y0 + ((b.y1 - b.y0) * s) / (len || 1)
        glow.sprite(glowTexture(14), x, y, { tint: b.color, alpha: 0.6 * (1 - u) })
      }
      glow.sprite(glowTexture(18), b.x1, b.y1, { tint: 0xffffff, alpha: 0.7 * (1 - u) })
    }
    for (const a of this.arcs) {
      const al = 1 - a.age / a.life
      for (let i = 0; i + 3 < a.pts.length; i += 2) {
        over.line(a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3], ELECTRIC_EDGE, al * 0.8, 2)
        over.line(a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3], ELECTRIC, al)
      }
    }
    for (const gl of this.glows) glow.sprite(glowTexture(gl.R), gl.x, gl.y, { tint: gl.color, alpha: gl.k * (1 - gl.age / gl.life) })
    for (const v of this.vortices) this.drawVortex(over, glow, v)
    for (const r of this.rises) {
      // frente claro que sube por la pared y un filo de tierra suelta arriba
      const u = Math.min(1, r.age / r.life)
      const fy = r.base - (r.base - r.top) * u
      const a = r.age > r.life ? 1 - (r.age - r.life) / 0.15 : 1
      if (r.ghost) {
        over.rect(r.x0 - 1, fy, r.x1 - r.x0 + 3, r.base - fy, OUT, a)
        over.rect(r.x0, fy + 1, r.x1 - r.x0 + 1, r.base - fy - 1, 0x76604a, a)
      }
      over.rect(r.x0, fy, r.x1 - r.x0 + 1, 2, 0xd8c4a0, 0.9 * a)
      over.rect(r.x0 - 1, fy + 2, r.x1 - r.x0 + 3, 1, 0x8a6a48, 0.7 * a)
    }
    // tanques corroídos: gotas verdes que chorrean por el casco
    for (const [id, left] of this.corrode) {
      const p = players.find((q) => q.id === id)
      if (!p) continue
      const a = Math.min(1, left)
      for (let i = 0; i < 4; i++) {
        const dx = -10 + i * 6 + ((id * 3) % 4)
        const drip = Math.floor((this.time * 6 + i * 1.7) % 5)
        over.px(p.x + dx, p.y - 13 + drip, 0x9cf040, a)
        over.px(p.x + dx, p.y - 14 + drip, 0x5aa01a, a * 0.8)
      }
      glow.sprite(glowTexture(16), p.x, p.y - 9, { tint: 0x6cbc1e, alpha: 0.25 * a })
    }
  }

  private drawVortex(g: PixelLayer, glow: PixelLayer, v: Vortex): void {
    const t = v.age
    const grow = Math.min(1, t / 0.25)
    // al final se cierra (VORTEX_END) antes de implotar
    const close = t > v.dur ? Math.max(0, 1 - (t - v.dur) / VORTEX_END) : 1
    const k = grow * close
    const rc = Math.max(1, 8 * k + Math.sin(t * 9) * 0.6)
    const x = v.x
    const y = v.y
    glow.sprite(glowTexture(Math.round(10 + v.R * 0.45 * k)), x, y, { tint: 0x6a30ff, alpha: 0.55 * k })
    glow.sprite(glowTexture(12), x, y, { tint: 0xc8a0ff, alpha: 0.5 * k })
    // brazos de la espiral, girando
    const spin = v.spin * t * 5
    const reach = v.R * 0.75 * k
    for (let arm = 0; arm < 3; arm++) {
      for (let i = 0; i < 26; i++) {
        const u = i / 26
        const r = rc + 3 + u * reach
        const ang = spin + (arm * Math.PI * 2) / 3 + v.spin * u * 3.2
        g.rect(x + Math.cos(ang) * r, y + Math.sin(ang) * r * 0.85, u < 0.4 ? 2 : 1, 1, u < 0.3 ? VIOLET_HI : VIOLET, Math.min(1, (1 - u) * 1.1) * k)
      }
    }
    // anillo de acreción: pixels claros girando rápido, con dos tonos alternados
    const ring = rc + 2.5
    const n = Math.max(12, Math.round(ring * 6))
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + v.spin * t * 9
      const c = i % 3 === 0 ? 0xffffff : i % 3 === 1 ? VIOLET_HI : VIOLET
      g.px(x + Math.cos(ang) * ring, y + Math.sin(ang) * ring * 0.9, c, k)
    }
    // anillo de "lente" más afuera, tenue y tramado (distorsión barata)
    const lens = rc + 8 + Math.sin(t * 6) * 1.5
    const nl = Math.round(lens * 5)
    for (let i = 0; i < nl; i += 2) {
      const ang = (i / nl) * Math.PI * 2 - v.spin * t * 2
      g.px(x + Math.cos(ang) * lens, y + Math.sin(ang) * lens, 0xd8c8ff, 0.35 * k)
    }
    // núcleo negro con borde violeta oscuro
    const r = Math.round(rc)
    for (let oy = -r - 1; oy <= r + 1; oy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (r + 1) * (r + 1) - oy * oy)))
      g.rect(x - half, y + oy, half * 2 + 1, 1, 0x2a1460, k)
    }
    for (let oy = -r; oy <= r; oy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, r * r - oy * oy)))
      g.rect(x - half, y + oy, half * 2 + 1, 1, 0x05020a, k)
    }
  }
}
