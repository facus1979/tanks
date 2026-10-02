// v3: abismos (Terrain.pits). Dos piezas:
// - PitMap: lee las columnas de abismo y arma, por columna, el peso del abismo (1 adentro, bajando a 0 en un
//   margen afuera para que el borde no quede cortado a cuchillo), el labio desde donde arranca la oscuridad y
//   dónde empieza la pared de fondo que se pinta aunque el generador no haya puesto back. El pintor del
//   terreno la usa al pintar cada trozo (es estático: solo se recalcula si cambian las columnas de abismo).
// - AbyssFalls: tanques, tripulantes y utilería que se pierden en el abismo. Caen, se oscurecen con la
//   profundidad y desaparecen; un tanque deja un destello lejano y una columna de humo que sube del fondo.
import { Container, Sprite } from 'pixi.js'
import type { Texture } from 'pixi.js'
import type { Terrain } from '../../sim/types'
import { AIR } from '../../sim/types'
import type { Fx } from './fx'
import { bayer, mix, rnd } from './raster'

export const ABYSS_BLACK = 0x050407
const FEATHER = 18 // px fuera del abismo en los que la oscuridad se desvanece sobre las paredes vecinas
const GRAVITY = 260

// Ruido de valor suave (bilineal sobre una grilla de sx × sy), 0..1.
export function vnoise(x: number, y: number, sx: number, sy: number, seed: number): number {
  const gx = x / sx
  const gy = y / sy
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = rnd(x0, y0, seed)
  const b = rnd(x0 + 1, y0, seed)
  const c = rnd(x0, y0 + 1, seed)
  const d = rnd(x0 + 1, y0 + 1, seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

export class PitMap {
  private key: Uint8Array | null = null
  weight: Float32Array | null = null // 0 = columna normal
  rim: Int16Array | null = null // y desde donde se mide la profundidad
  top: Int16Array | null = null // en columnas de abismo: primera fila de la pared de fondo pintada
  inPit: Uint8Array | null = null

  get active(): boolean {
    return this.weight !== null
  }

  reset(): void {
    this.key = null
    this.weight = null
    this.rim = null
    this.top = null
    this.inPit = null
  }

  // Devuelve true si cambiaron las columnas de abismo (hay que repintar todo).
  sync(t: Terrain): boolean {
    const P = t.pits
    const any = !!P && P.length === t.w && P.some((v) => v !== 0)
    if (!any) {
      if (!this.key) return false
      this.reset()
      return true
    }
    const k = this.key
    if (k && k.length === P.length) {
      let same = true
      for (let i = 0; i < k.length; i++) {
        if ((k[i] !== 0) !== (P[i] !== 0)) {
          same = false
          break
        }
      }
      if (same) return false
    }
    this.key = P.slice()
    this.build(t, P)
    return true
  }

  private build(t: Terrain, P: Uint8Array): void {
    const W = t.w
    const H = t.h
    const surf = (x: number): number => {
      for (let y = 0; y < H; y++) if (t.front[y * W + x] !== AIR) return y
      return H
    }
    const weight = new Float32Array(W)
    const rim = new Int16Array(W).fill(H)
    const top = new Int16Array(W).fill(H)
    const inPit = new Uint8Array(W)
    for (let a = 0; a < W; ) {
      if (!P[a]) {
        a++
        continue
      }
      let b = a
      while (b < W && P[b]) b++
      // labio: el más bajo de los dos bordes (la boca del abismo); si uno no existe, el otro
      const l = a > 0 ? surf(a - 1) : H
      const r = b < W ? surf(b) : H
      let lip = l >= H ? r : r >= H ? l : Math.max(l, r)
      if (lip >= H) lip = H - 90
      lip = Math.min(lip, H - 40)
      for (let x = Math.max(0, a - FEATHER); x < Math.min(W, b + FEATHER); x++) {
        const dist = x < a ? a - x : x >= b ? x - b + 1 : 0
        const w = dist === 0 ? 1 : 1 - dist / (FEATHER + 1)
        if (w > weight[x]) {
          weight[x] = w
          rim[x] = lip
        }
      }
      for (let x = a; x < b; x++) {
        inPit[x] = 1
        // borde de arriba irregular de la pared de fondo: dos octavas de ruido
        const n = (vnoise(x, 0, 11, 1, 71) - 0.5) * 12 + (vnoise(x, 0, 3, 1, 72) - 0.5) * 4
        top[x] = Math.round(lip - 4 + n)
      }
      a = b
    }
    this.weight = weight
    this.rim = rim
    this.top = top
    this.inPit = inPit
  }

  // Oscuridad continua 0..1 en (x, y): 0 arriba del labio, 1 en el fondo del abismo.
  dark(x: number, y: number, h: number): number {
    const w = this.weight
    if (!w) return 0
    const xi = Math.round(x)
    if (xi < 0 || xi >= w.length || w[xi] === 0) return 0
    const r = this.rim![xi]
    const d = (y - r) / (h - r)
    const k = Math.max(0, Math.min(1, (d - 0.06) / 0.7))
    return k * w[xi]
  }

  // Columna de abismo sin nada sólido desde y hasta el fondo: lo que esté ahí se pierde.
  lost(t: Terrain, x: number, y: number): boolean {
    const P = t.pits
    const xi = Math.round(x)
    if (!P || xi < 0 || xi >= t.w || !P[xi]) return false
    for (let yy = Math.max(0, Math.round(y)); yy < t.h; yy++) if (t.front[yy * t.w + xi] !== AIR) return false
    return true
  }

  // Sombra del abismo para un pixel del terreno ya coloreado. front: el frente recibe menos niebla.
  shade(c: number, x: number, y: number, h: number, fog: number, front: boolean): number {
    const w = this.weight![x]
    if (w === 0) return c
    const r = this.rim![x]
    const d = (y - r) / (h - r)
    if (d <= -0.15) return c
    // niebla del bioma: sube desde la boca, más espesa un poco más abajo, y se pierde en la oscuridad
    const f = d < 0.12 ? (d + 0.15) / 0.27 : Math.max(0, 1 - (d - 0.12) / 0.38)
    if (f > 0) {
      const q = Math.floor(f * w * 6 + bayer(x + 2, y + 1)) / 6
      if (q > 0) c = mix(c, fog, q * (front ? 0.18 : 0.3))
    }
    // oscuridad: degradé con trama Bayer en 8 pasos hasta negro
    const k = Math.max(0, Math.min(1, (d - 0.06) / 0.7)) * w
    const s = Math.min(1, Math.floor(k * 8 + bayer(x, y)) / 8)
    return s > 0 ? mix(c, ABYSS_BLACK, s) : c
  }
}

export interface Part {
  tex: Texture
  x: number // esquina (o pivote) relativa al centro del objeto
  y: number
  flip?: boolean
  pivot?: { x: number; y: number }
}

interface Faller {
  node: Container
  sprites: Sprite[]
  x: number
  y: number
  vx: number
  vy: number
  vr: number
  big: boolean
}

interface Later {
  at: number
  run: () => void
}

export class AbyssFalls {
  readonly layer = new Container()
  private items: Faller[] = []
  private later: Later[] = []
  private time = 0

  constructor(
    private fx: Fx,
    private pits: () => PitMap | null,
  ) {}

  reset(): void {
    for (const f of this.items) f.node.destroy({ children: true })
    this.items = []
    this.later = []
  }

  // Suelta un objeto armado con sprites (posiciones relativas al centro). big: tanque (destello y humo al fondo).
  // flip: espejado horizontal de todo el objeto (tanque mirando a la izquierda).
  drop(parts: Part[], x: number, y: number, vx: number, vr: number, big: boolean, flip = false): void {
    const node = new Container()
    if (flip) node.scale.x = -1
    const sprites: Sprite[] = []
    for (const p of parts) {
      const s = new Sprite(p.tex)
      if (p.pivot) s.pivot.set(p.pivot.x, p.pivot.y)
      s.position.set(p.x, p.y)
      if (p.flip) s.scale.x = -1
      node.addChild(s)
      sprites.push(s)
    }
    node.position.set(Math.round(x), Math.round(y))
    this.layer.addChild(node)
    this.items.push({ node, sprites, x, y, vx, vy: -20, vr, big })
  }

  update(t: Terrain, dt: number): void {
    if (dt <= 0) return
    this.time += dt
    for (let i = 0; i < this.later.length; i++) {
      if (this.later[i].at <= this.time) {
        const l = this.later.splice(i--, 1)[0]
        l.run()
      }
    }
    if (!this.items.length) return
    const H = t.h
    const live: Faller[] = []
    for (const f of this.items) {
      f.vy += GRAVITY * dt
      f.vx *= 1 - 0.8 * dt
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.node.rotation += f.vr * dt
      f.node.position.set(Math.round(f.x), Math.round(f.y))
      // se tiñe con la oscuridad del abismo y se desvanece en los últimos pixels
      const k = this.pits()?.dark(f.x, f.y, H) ?? 0
      const tint = mix(0xffffff, 0x000000, Math.min(1, k * 1.15))
      const a = Math.max(0, Math.min(1, (H + 6 - f.y) / 30))
      for (const s of f.sprites) s.tint = tint
      f.node.alpha = a
      if (a <= 0 || f.y > H + 20) {
        if (f.big) this.bottom(f.x, H)
        f.node.destroy({ children: true })
      } else live.push(f)
    }
    this.items = live
  }

  // Llegó al fondo: un destello lejano y, un rato después, una columna de humo que sube.
  private bottom(x: number, H: number): void {
    const at = this.time
    this.later.push({ at: at + 0.25, run: () => this.fx.abyssFlash(x, H - 10) })
    this.later.push({ at: at + 1.1, run: () => this.fx.abyssSmoke(x, H - 6, 3.2) })
  }
}
