// v3 (render-armas): carteles de recompensa (evento bonus) estilo arcade: "+250 BOTÍN", "+150 TIRO LARGO".
// En el mundo, sobre el punto del evento, en el color del jugador con la fuente pixel del juego (×2, contorno
// y sombra). Entra con un rebote, sube, queda un momento titilando y se desvanece. Varios seguidos se apilan.
import { Container, Sprite, Texture } from 'pixi.js'
import type { BonusKind, Player } from '../../sim/types'
import { glyph } from './actors'
import type { Font } from './assets'
import { OUT } from './fallback'
import type { Motes } from './pixels'
import { rr } from './pixels'
import { mix } from './raster'

export const BONUS_LABEL: Record<BonusKind, string> = {
  longshot: 'TIRO LARGO',
  double: 'DOBLE',
  abyss: 'ABISMO',
  lava: 'LAVA',
  collapse: 'DERRUMBE',
  firstblood: 'PRIMERA SANGRE',
  loot: 'BOTÍN',
  target: 'OBJETIVO',
}

const LIFE = 2.2
const POP = 0.18 // entrada con rebote
const RISE = 26
const FADE = 0.45
const SCALE = 2

interface Sign {
  s: Sprite
  x: number
  y: number
  age: number
}

// Acentos: la fuente no los tiene; se dibuja la letra base y una tilde de 2 px arriba.
const ACCENTS: Record<string, string> = { Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ñ: 'N' }

export class BonusSigns {
  readonly root = new Container()
  font: Font | null = null
  private list: Sign[] = []

  constructor(private motes: Motes) {}

  spawn(p: Player | undefined, kind: BonusKind, amount: number, x: number, y: number): void {
    const color = p?.color ?? 0xffe27a
    const text = `+${amount} ${BONUS_LABEL[kind] ?? kind.toUpperCase()}`
    // apila sobre los carteles recientes cercanos
    let yy = y - 18
    for (const o of this.list) if (o.age < 0.8 && Math.abs(o.x - x) < 70 && Math.abs(o.y - yy) < 14) yy = o.y - 16
    const s = new Sprite(signTexture(text, color, this.font))
    s.anchor.set(0.5, 1)
    this.root.addChild(s)
    this.list.push({ s, x, y: yy, age: 0 })
    // destellitos del color del jugador
    for (let i = 0; i < 16; i++) {
      const a = rr(0, Math.PI * 2)
      const sp = rr(30, 90)
      this.motes.add({ x, y: yy - 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 20, ay: 80, drag: 2.5, life: rr(0.4, 0.8), c0: 0xffffff, c1: color, tail: true })
    }
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const n = this.list[i]
      n.age += dt
      if (n.age >= LIFE) {
        n.s.texture.destroy(true)
        n.s.destroy()
        this.list.splice(i, 1)
        continue
      }
      const t = n.age
      // rebote de entrada: 0 → 1,35 → 1 (escala sobre la base ×2, en pasos enteros de medio pixel)
      const pop = t < POP ? 1.35 * Math.sin((t / POP) * (Math.PI / 2)) : t < POP * 2 ? 1.35 - 0.35 * ((t - POP) / POP) : 1
      const k = Math.max(0.5, Math.round(pop * SCALE * 2) / 2)
      n.s.scale.set(k)
      const rise = 1 - (1 - Math.min(1, t / 1.2)) ** 2
      n.s.position.set(Math.round(n.x), Math.round(n.y - RISE * rise))
      // titila un instante al llegar arriba y después se desvanece
      const blink = t > 1.1 && t < 1.4 && Math.floor(t * 20) % 2 === 0
      n.s.alpha = t > LIFE - FADE ? (LIFE - t) / FADE : blink ? 0.6 : 1
    }
  }

  clear(): void {
    for (const n of this.list) {
      n.s.texture.destroy(true)
      n.s.destroy()
    }
    this.list = []
  }
}

// Texto con contorno de 1 px, sombra abajo y un borde más claro arriba de cada letra (estilo arcade).
function signTexture(text: string, color: number, font: Font | null): Texture {
  const chars = [...text]
  const glyphs = chars.map((ch) => {
    const base = ACCENTS[ch]
    const g = glyph(base ?? ch, font)
    return { g, accent: base !== undefined, space: ch === ' ' }
  })
  const top = 3 // filas para las tildes
  const w = glyphs.reduce((a, q) => a + (q.space ? 3 : q.g.w) + 1, 0) + 2
  const h = top + 6 + 4
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return Texture.from(c)
  const img = ctx.createImageData(w, h)
  const put = (x: number, y: number, col: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 4
    img.data[i] = (col >> 16) & 255
    img.data[i + 1] = (col >> 8) & 255
    img.data[i + 2] = col & 255
    img.data[i + 3] = 255
  }
  const pts: [number, number][] = []
  let gx = 1
  for (const q of glyphs) {
    if (q.space) {
      gx += 4
      continue
    }
    for (const [x, y] of q.g.px) pts.push([gx + x, top + y])
    if (q.accent) {
      // tilde: dos pixels en diagonal sobre el centro de la letra
      const cx = gx + Math.floor(q.g.w / 2)
      pts.push([cx, top - 2], [cx + 1, top - 3])
    }
    gx += q.g.w + 1
  }
  for (const [x, y] of pts) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) put(x + dx, y + dy, OUT)
  const light = mix(color, 0xffffff, 0.55)
  const dark = mix(color, 0x000000, 0.25)
  for (const [x, y] of pts) put(x, y, y >= top + 4 ? dark : y <= top ? light : color)
  ctx.putImageData(img, 0, 0)
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}
