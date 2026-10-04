// v3 (render-armas): capa de pixels en GPU para los efectos de las armas e ítems nuevos.
// No usa los buffers de canvas de Fx (cada pixel de esos cuesta CPU y una subida de textura por frame, que es
// justo lo que frena al celular): cada rectángulo es un Sprite de un pool, teñido, y Pixi los dibuja en un
// solo lote. Cuando no hay nada vivo, no cuesta nada (los sprites quedan ocultos y no se recorren).
// También: texturas de brillo con trama de Bayer (para luces aditivas baratas) y un sistema chico de
// "motas" (partículas de colores propios: violeta del agujero negro, verde del ácido, celeste del teletransporte).
import { Container, Sprite, Texture } from 'pixi.js'
import type { Terrain } from '../../sim/types'
import { solidCell } from './liquids'
import { Rng, bayer } from './raster'

export class PixelLayer {
  readonly root = new Container()
  private pool: Sprite[] = []
  private n = 0
  private shown = 0

  // cap: tope de sprites por frame (lo que pase de ahí no se dibuja)
  constructor(
    private cap = 1200,
    private blend: 'normal' | 'add' = 'normal',
  ) {}

  begin(): void {
    this.n = 0
  }

  private next(tex: Texture): Sprite | null {
    if (this.n >= this.cap) return null
    let s = this.pool[this.n]
    if (!s) {
      s = new Sprite(tex)
      s.blendMode = this.blend
      this.pool.push(s)
      this.root.addChild(s)
    } else if (s.texture !== tex) s.texture = tex
    this.n++
    return s
  }

  // Rectángulo lleno en coordenadas de mundo (se redondea a pixels enteros).
  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
    if (alpha <= 0.01 || w <= 0 || h <= 0) return
    const s = this.next(Texture.WHITE)
    if (!s) return
    s.anchor.set(0)
    s.rotation = 0
    s.position.set(Math.round(x), Math.round(y))
    s.scale.set(Math.max(1, Math.round(w)) / Texture.WHITE.width, Math.max(1, Math.round(h)) / Texture.WHITE.height)
    s.tint = color
    s.alpha = Math.min(1, alpha)
    s.visible = true
  }

  px(x: number, y: number, color: number, alpha = 1): void {
    this.rect(x, y, 1, 1, color, alpha)
  }

  // Línea de pixels (Bresenham) de (x0, y0) a (x1, y1), con grosor t (cuadrado de t × t por paso).
  line(x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1, t = 1): void {
    x0 = Math.round(x0)
    y0 = Math.round(y0)
    x1 = Math.round(x1)
    y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const h = Math.floor(t / 2)
    // horizontal o vertical: un solo rectángulo
    if (dy === 0) return this.rect(Math.min(x0, x1), y0 - h, dx + 1, t, color, alpha)
    if (dx === 0) return this.rect(x0 - h, Math.min(y0, y1), t, dy + 1, color, alpha)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    let x = x0
    let y = y0
    for (let i = 0; i <= dx + dy && i < 2000; i++) {
      this.rect(x - h, y - h, t, t, color, alpha)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }

  // Sprite con textura (brillos, mina y misil pintados).
  sprite(tex: Texture, x: number, y: number, o: { tint?: number; alpha?: number; ax?: number; ay?: number; sx?: number; sy?: number; rot?: number } = {}): void {
    const a = o.alpha ?? 1
    if (a <= 0.01) return
    const s = this.next(tex)
    if (!s) return
    s.anchor.set(o.ax ?? 0.5, o.ay ?? 0.5)
    s.rotation = o.rot ?? 0
    s.position.set(Math.round(x), Math.round(y))
    s.scale.set(o.sx ?? 1, o.sy ?? 1)
    s.tint = o.tint ?? 0xffffff
    s.alpha = Math.min(1, a)
    s.visible = true
  }

  end(): void {
    for (let i = this.n; i < this.shown; i++) this.pool[i].visible = false
    this.shown = this.n
  }

  clear(): void {
    this.begin()
    this.end()
  }
}

// Brillo redondo blanco con caída cuadrática y trama de Bayer en el borde (se tiñe al usarlo, en capa 'add').
const GLOWS = new Map<number, Texture>()
export function glowTexture(R: number): Texture {
  R = Math.max(2, Math.round(R))
  let t = GLOWS.get(R)
  if (t) return t
  const size = R * 2 + 1
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - R, y - R) / R
      if (d >= 1) continue
      const k = (1 - d) * (1 - d)
      // trama: niveles de 1/4 para que se vea pixelado como las luces del buffer
      const q = Math.floor(k * 4 + bayer(x, y)) / 4
      if (q <= 0) continue
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = Math.round(q * 255)
    }
  ctx.putImageData(img, 0, 0)
  t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  GLOWS.set(R, t)
  return t
}

// ---------- motas: partículas de colores propios ----------

export interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  ay: number
  drag: number
  life: number
  age: number
  c0: number // color al nacer
  c1: number // color al morir (se cambia a la mitad de la vida)
  size: number // 1 o 2 px
  // atracción hacia un punto (agujero negro): espiral con velocidad angular que crece al acercarse
  sx?: number
  sy?: number
  spin?: number
  pull?: number
  tail?: boolean // deja un pixel de estela
}

export class Motes {
  list: Mote[] = []
  constructor(private max = 360) {}

  add(m: Partial<Mote> & Pick<Mote, 'x' | 'y' | 'life' | 'c0'>): void {
    if (this.list.length >= this.max) {
      // tope: reemplaza a la más gastada
      let worst = 0
      let wu = -1
      for (let i = 0; i < this.list.length; i++) {
        const u = this.list[i].age / this.list[i].life
        if (u > wu) {
          wu = u
          worst = i
        }
      }
      this.list.splice(worst, 1)
    }
    this.list.push({ vx: 0, vy: 0, ay: 0, drag: 0, age: 0, c1: m.c0, size: 1, ...m })
  }

  update(dt: number): void {
    if (dt <= 0) return
    for (const m of this.list) {
      m.age += dt
      if (m.sx !== undefined && m.sy !== undefined) {
        // espiral hacia (sx, sy): componente radial hacia adentro y tangencial que acelera al acercarse
        const dx = m.sx - m.x
        const dy = m.sy - m.y
        const d = Math.hypot(dx, dy) || 1
        const pull = (m.pull ?? 200) * (1 + 30 / (d + 6))
        const tang = (m.spin ?? 1) * pull * 0.9
        m.vx += ((dx / d) * pull - (dy / d) * tang) * dt
        m.vy += ((dy / d) * pull + (dx / d) * tang) * dt
        m.vx *= Math.exp(-3 * dt)
        m.vy *= Math.exp(-3 * dt)
        if (d < 3) m.age = m.life
      } else {
        m.vy += m.ay * dt
        if (m.drag > 0) {
          const k = Math.exp(-m.drag * dt)
          m.vx *= k
          m.vy *= k
        }
      }
      m.x += m.vx * dt
      m.y += m.vy * dt
    }
    this.list = this.list.filter((m) => m.age < m.life)
  }

  draw(g: PixelLayer): void {
    for (const m of this.list) {
      const u = m.age / m.life
      const c = u < 0.5 ? m.c0 : m.c1
      const a = u > 0.7 ? (1 - u) / 0.3 : 1
      if (m.tail) {
        const sp = Math.hypot(m.vx, m.vy) || 1
        g.px(m.x - (m.vx / sp) * 1.5, m.y - (m.vy / sp) * 1.5, m.c1, a * 0.6)
      }
      g.rect(m.x, m.y, m.size, m.size, c, a)
    }
  }

  clear(): void {
    this.list = []
  }
}

// ---------- terreno ----------

export function solidAt(t: Terrain, x: number, y: number): boolean {
  x = Math.round(x)
  y = Math.round(y)
  if (x < 0 || x >= t.w || y < 0 || y >= t.h) return false
  return solidCell(t.front[y * t.w + x])
}

export function materialAt(t: Terrain, x: number, y: number): number {
  x = Math.round(x)
  y = Math.round(y)
  if (x < 0 || x >= t.w || y < 0 || y >= t.h) return 0
  return t.front[y * t.w + x]
}

// Primera fila sólida con aire encima, buscando hacia abajo desde y0 hasta y1 en la columna x; -1 si no hay.
export function surfaceBelow(t: Terrain, x: number, y0: number, y1: number): number {
  x = Math.round(x)
  if (x < 0 || x >= t.w) return -1
  let prevAir = !solidAt(t, x, y0 - 1)
  for (let y = Math.max(0, Math.round(y0)); y <= Math.min(t.h - 1, Math.round(y1)); y++) {
    const s = solidAt(t, x, y)
    if (s && prevAir) return y
    prevAir = !s
  }
  return -1
}

// Textura de pixel art a partir de filas de caracteres y una paleta ('.' = transparente).
export function pixelArt(rows: string[], pal: Record<string, number>): Texture {
  const h = rows.length
  const w = Math.max(...rows.map((r) => r.length))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const col = pal[ch]
      if (col === undefined) return
      const i = (y * w + x) * 4
      img.data[i] = (col >> 16) & 255
      img.data[i + 1] = (col >> 8) & 255
      img.data[i + 2] = col & 255
      img.data[i + 3] = 255
    }),
  )
  ctx.putImageData(img, 0, 0)
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}

// RNG compartido de los efectos v3 (reproducible para las capturas de QA).
export const v3rng = new Rng(30031)
export const rr = (a: number, b: number): number => v3rng.range(a, b)
