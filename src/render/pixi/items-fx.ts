// v3 (render-armas): efectos de los ítems nuevos.
// - Jetpack (evento jetpack): llamas y humo bajo el tanque a lo largo de path (un punto cada PATH_DT), polvo
//   al despegar y al aterrizar.
// - Teletransporte (evento teleport): columna de luz y motas que se juntan en el origen; destello, anillo y
//   motas que salen en el destino.
// - Ancla (Player.anchored): cadena desde la cola del tanque hasta un ancla medio enterrada en el piso.
// - Deflector (Player.deflector): burbuja celeste alrededor del tanque; con el evento deflect, destello,
//   anillo y la burbuja que estalla en pedazos.
import { PATH_DT } from '../../sim'
import type { Player, Vec2 } from '../../sim/types'
import { OUT } from './fallback'
import type { Fx } from './fx'
import type { Motes, PixelLayer } from './pixels'
import { glowTexture, pixelArt, rr } from './pixels'
import type { Texture } from 'pixi.js'

const TELE = 0x7af0ff
const TELE_HI = 0xe8fcff
const TELE_ALT = 0xd080ff
const SHIELD = 0x8ee8ff
const SHIELD_HI = 0xe8fcff
const METAL = 0x9a9a90
const METAL_DARK = 0x5c5c54

interface Jet {
  id: number
  path: Vec2[]
  t: number
  acc: number
  landed: boolean
}

interface Tele {
  from: Vec2
  to: Vec2
  age: number
  arrived: boolean
}

interface Ring {
  x: number
  y: number
  age: number
  life: number
  R: number
  color: number
}

const BUBBLE_R = 17

export class ItemsFx {
  private jets: Jet[] = []
  private teles: Tele[] = []
  private rings: Ring[] = []
  private wasAnchored = new Set<number>()
  private wasShielded = new Set<number>()
  private popIn = new Map<number, number>() // deflector recién puesto: segundos de la animación de entrada
  private time = 0
  private anchorTex: Texture | null = null
  // QA (?fxtest=anchor|deflector): fuerza el ancla o el deflector en todos los tanques vivos
  force: 'anchor' | 'deflector' | null = null

  constructor(
    private fx: Fx,
    private motes: Motes,
  ) {}

  reset(): void {
    this.jets = []
    this.teles = []
    this.rings = []
    this.wasAnchored.clear()
    this.wasShielded.clear()
    this.popIn.clear()
  }

  get busy(): boolean {
    return this.jets.length + this.teles.length + this.rings.length > 0
  }

  jetpack(id: number, path: Vec2[]): void {
    if (path.length < 2) return
    this.jets = this.jets.filter((j) => j.id !== id)
    this.jets.push({ id, path, t: 0, acc: 0, landed: false })
    const p = path[0]
    // despegue: polvo a los costados y un fogonazo bajo las toberas
    this.fx.dust(p.x, p.y, 12, 30)
    const k = this.fx.kit
    k.blob({ layer: 1, ox: p.x, oy: p.y - 2, r0: 3, r1: 8, grow: 0.04, hold: 0.06, life: 0.22, ramp: [0xfffbe2, 0xffe27a, 0xffb43e, 0xf77a28, 0xd24a1c], outline: 0x3a1208, heat0: 0, heatV: 3 })
    k.light(p.x, p.y - 4, 36, 0xffa040, 0.45, 0.3)
    this.fx.shake = Math.max(this.fx.shake, 3)
  }

  teleport(from: Vec2, to: Vec2): void {
    this.teles.push({ from, to, age: 0, arrived: false })
    // origen: las motas se juntan hacia el centro del tanque
    for (let i = 0; i < 30; i++) {
      const a = rr(0, Math.PI * 2)
      const d = rr(10, 26)
      this.motes.add({ x: from.x + Math.cos(a) * d, y: from.y - 10 + Math.sin(a) * d, sx: from.x, sy: from.y - 10, spin: 1, pull: 500, life: 0.5, c0: TELE_HI, c1: i % 3 === 0 ? TELE_ALT : TELE })
    }
    this.fx.kit.light(from.x, from.y - 10, 34, TELE, 0.5, 0.35)
    this.rings.push({ x: from.x, y: from.y - 10, age: 0, life: 0.25, R: 20, color: TELE })
  }

  private arrive(to: Vec2): void {
    const k = this.fx.kit
    k.blob({ layer: 4, ox: to.x, oy: to.y - 10, r0: 4, r1: 12, grow: 0.03, life: 0.1, ramp: [0xffffff, TELE_HI, TELE, 0x3aa8c8], outline: 0x1a5068, heat0: -0.3 })
    for (let i = 0; i < 36; i++) {
      const a = rr(0, Math.PI * 2)
      const sp = rr(60, 160)
      this.motes.add({ x: to.x, y: to.y - 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7, drag: 3.5, life: rr(0.4, 0.8), c0: TELE_HI, c1: i % 3 === 0 ? TELE_ALT : TELE, tail: true })
    }
    this.rings.push({ x: to.x, y: to.y - 10, age: 0, life: 0.35, R: 30, color: TELE })
    this.fx.dust(to.x, to.y, 8, 28)
    k.light(to.x, to.y - 10, 44, TELE, 0.55, 0.4)
    this.fx.flash = Math.max(this.fx.flash, 0.15)
    this.fx.flashColor = TELE_HI
    this.fx.shake = Math.max(this.fx.shake, 3)
  }

  // El deflector desvió un proyectil en (x, y): destello, anillo, chispas y la burbuja que estalla.
  deflect(x: number, y: number, tank: Player | undefined): void {
    const k = this.fx.kit
    k.blob({ layer: 4, ox: x, oy: y, r0: 3, r1: 9, grow: 0.03, life: 0.09, ramp: [0xffffff, SHIELD_HI, SHIELD, 0x3a9ac8], outline: 0x1a5068, heat0: -0.3 })
    for (let i = 0; i < 18; i++) {
      const a = rr(0, Math.PI * 2)
      const sp = rr(80, 200)
      k.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(0.15, 0.35))
    }
    this.rings.push({ x, y, age: 0, life: 0.3, R: 22, color: SHIELD_HI })
    if (tank) {
      // pedazos de la burbuja que salen despedidos
      const cx = tank.x
      const cy = tank.y - 10
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2
        this.motes.add({ x: cx + Math.cos(a) * BUBBLE_R, y: cy + Math.sin(a) * BUBBLE_R, vx: Math.cos(a) * rr(40, 90), vy: Math.sin(a) * rr(40, 90), ay: 120, drag: 2, life: rr(0.35, 0.7), c0: SHIELD_HI, c1: SHIELD, tail: true })
      }
      this.rings.push({ x: cx, y: cy, age: 0, life: 0.25, R: BUBBLE_R + 10, color: SHIELD })
    }
    k.light(x, y, 40, SHIELD, 0.55, 0.3)
    this.fx.shake = Math.max(this.fx.shake, 4)
    this.fx.flash = Math.max(this.fx.flash, 0.15)
    this.fx.flashColor = SHIELD_HI
  }

  // Posición del jet en su tiempo t (interpolada entre puntos del path).
  private jetAt(j: Jet): Vec2 {
    const f = j.t / PATH_DT
    const i = Math.min(j.path.length - 1, Math.floor(f))
    const a = j.path[i]
    const b = j.path[Math.min(j.path.length - 1, i + 1)]
    const u = Math.min(1, f - i)
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
  }

  update(players: Player[], dt: number): void {
    // ancla y deflector recién puestos (Player.anchored / Player.deflector pasan a true)
    for (const p of players) {
      const anch = (p.anchored || this.force === 'anchor') && p.alive
      if (anch && !this.wasAnchored.has(p.id)) {
        this.fx.dust(p.x, p.y, 6, 10)
        for (let i = 0; i < 6; i++) this.fx.kit.spark(p.x, p.y - 2, rr(-50, 50), -rr(30, 80), rr(0.1, 0.25))
      }
      if (anch) this.wasAnchored.add(p.id)
      else this.wasAnchored.delete(p.id)
      const sh = (p.deflector || this.force === 'deflector') && p.alive
      if (sh && !this.wasShielded.has(p.id)) {
        this.popIn.set(p.id, 0)
        this.fx.kit.light(p.x, p.y - 10, 34, SHIELD, 0.4, 0.3)
      }
      if (sh) this.wasShielded.add(p.id)
      else this.wasShielded.delete(p.id)
    }
    if (dt <= 0) return
    this.time += dt
    for (const [id, t] of this.popIn) {
      if (t + dt >= 0.3) this.popIn.delete(id)
      else this.popIn.set(id, t + dt)
    }
    const k = this.fx.kit
    for (const j of this.jets) {
      j.t += dt
      const end = (j.path.length - 1) * PATH_DT
      if (j.t >= end) {
        if (!j.landed) {
          j.landed = true
          const p = j.path[j.path.length - 1]
          this.fx.dust(p.x, p.y, 12, 30)
          this.fx.shake = Math.max(this.fx.shake, 3)
        }
        continue
      }
      const p = this.jetAt(j)
      // llamas que salen de las dos toberas hacia abajo y humo que queda atrás
      j.acc += dt * 60
      for (; j.acc >= 1; j.acc--) {
        for (const side of [-1, 1]) {
          const nx = p.x + side * 8
          const r1 = rr(1.6, 2.8)
          k.blob({ layer: 1, ox: nx, oy: p.y - 1, vx: rr(-10, 10), vy: rr(50, 90), r0: r1 * 0.6, r1, grow: 0.03, hold: 0.06, life: rr(0.14, 0.22), ramp: [0xfffbe2, 0xffe27a, 0xffb43e, 0xf77a28, 0xd24a1c], outline: 0x3a1208, heat0: rr(0, 0.3), heatV: 4 })
        }
        if (rr(0, 1) < 0.5) {
          const r = rr(1.6, 2.6)
          k.soft({ x0: p.x + rr(-8, 8), y0: p.y + 2, vx: rr(-10, 10) + this.fx.wind, vy: rr(6, 20), drag: 2, r0: r, r1: r * 2.4, life: rr(0.8, 1.2), inner: 0xe8e2d8, edge: 0xa49a8e, a0: 0.8, keep: 0.2 })
        }
      }
    }
    this.jets = this.jets.filter((j) => !j.landed)
    for (const t of this.teles) {
      t.age += dt
      if (!t.arrived && t.age >= 0.15) {
        t.arrived = true
        this.arrive(t.to)
      }
    }
    this.teles = this.teles.filter((t) => t.age < 0.6)
    for (const r of this.rings) r.age += dt
    this.rings = this.rings.filter((r) => r.age < r.life)
    k.cap()
  }

  private anchor(): Texture {
    this.anchorTex ??= pixelArt(
      ['..###..', '.#m.m#.', '..#m#..', '.##m##.', '..#m#..', '#.#m#.#', '#m#m#m#', '.#mmm#.', '..###..'],
      { '#': OUT, m: METAL },
    )
    return this.anchorTex
  }

  draw(over: PixelLayer, glow: PixelLayer, players: Player[]): void {
    for (const p of players) {
      if (!p.alive) continue
      if (p.anchored || this.force === 'anchor') {
        // cadena desde la cola del tanque hasta el ancla clavada en el piso
        const facing = p.angle > 90 ? -1 : 1
        const ax = Math.round(p.x - facing * 15)
        const top = p.y - 8
        const bottom = p.y + 3
        for (let y = top; y < bottom - 6; y += 2) {
          const odd = ((y - top) >> 1) % 2 === 1
          over.rect(ax - (odd ? 0 : 1), y, odd ? 1 : 3, 1, OUT)
          over.px(ax, y + 1, odd ? METAL : METAL_DARK)
        }
        over.sprite(this.anchor(), ax, bottom, { ax: 0.5, ay: 1 })
      }
      if (p.deflector || this.force === 'deflector') {
        // burbuja: borde tramado con un brillo que gira y un reflejo fijo arriba a la izquierda
        const cx = p.x
        const cy = p.y - 10
        const pop = this.popIn.get(p.id)
        const R = pop !== undefined ? BUBBLE_R * (0.4 + 0.6 * Math.min(1, pop / 0.3)) + Math.sin(pop * 30) * 1.5 : BUBBLE_R + Math.sin(this.time * 3 + p.id) * 0.5
        const n = Math.round(R * 6.3)
        const spin = this.time * 2.2 + p.id
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2
          const lit = Math.cos(a - spin)
          if (lit < -0.2 && i % 2 === 1) continue // del lado oscuro, trama
          const c = lit > 0.8 ? SHIELD_HI : SHIELD
          over.px(cx + Math.cos(a) * R, cy + Math.sin(a) * R * 0.92, c, lit > 0.3 ? 0.95 : 0.55)
        }
        over.px(cx - R * 0.5, cy - R * 0.6, SHIELD_HI, 0.9)
        over.px(cx - R * 0.6, cy - R * 0.45, SHIELD_HI, 0.7)
        over.px(cx - R * 0.4, cy - R * 0.7, SHIELD_HI, 0.7)
        glow.sprite(glowTexture(Math.round(R + 4)), cx, cy, { tint: 0x3aa8e8, alpha: 0.22 + 0.06 * Math.sin(this.time * 4 + p.id) })
      }
    }
    for (const j of this.jets) {
      if (j.landed) continue
      const p = this.jetAt(j)
      // llama continua bajo cada tobera (lo de Fx son las bocanadas que se desprenden)
      for (const side of [-1, 1]) {
        const nx = p.x + side * 8
        const L = 5 + Math.round(2 * Math.sin(this.time * 41 + side))
        for (let s = 0; s < L; s++) {
          const u = s / L
          const c = u < 0.3 ? 0xfffbe2 : u < 0.6 ? 0xffe27a : 0xf77a28
          over.rect(nx - (u < 0.5 ? 1 : 0), p.y + s, u < 0.5 ? 3 : 1, 1, c, 1 - u * 0.4)
        }
        glow.sprite(glowTexture(10), nx, p.y + 2, { tint: 0xffa040, alpha: 0.6 })
      }
    }
    for (const t of this.teles) {
      // columna de luz: se cierra en el origen y se abre y cierra en el destino
      const col = (pt: Vec2, u: number): void => {
        const w = Math.max(0, Math.round(10 * Math.sin(Math.PI * Math.min(1, u))))
        if (w <= 0) return
        over.rect(pt.x - w / 2, pt.y - 34, w, 36, TELE, 0.55)
        over.rect(pt.x - Math.max(1, w / 4), pt.y - 40, Math.max(2, w / 2), 42, TELE_HI, 0.9)
        glow.sprite(glowTexture(20), pt.x, pt.y - 14, { tint: TELE, alpha: 0.7 })
      }
      col(t.from, 0.5 + t.age / 0.3)
      if (t.age >= 0.12) col(t.to, (t.age - 0.12) / 0.4)
    }
    for (const r of this.rings) {
      const u = r.age / r.life
      const R = 3 + r.R * u
      const n = Math.round(R * 6.3)
      for (let i = 0; i < n; i += 1 + (u > 0.5 ? 1 : 0)) {
        const a = (i / n) * Math.PI * 2
        over.px(r.x + Math.cos(a) * R, r.y + Math.sin(a) * R * 0.8, r.color, 1 - u)
      }
    }
  }
}
