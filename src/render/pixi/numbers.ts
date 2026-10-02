// Números de daño flotantes ("-18") sobre el tanque golpeado, en el mundo. Pixel art ×2 con contorno,
// suben y se desvanecen. Amarillo para el daño común, rojo para golpes fuertes, naranja para la lava y
// celeste para lo que absorbe el escudo.
import { Container, Sprite, Texture } from 'pixi.js'
import { glyph } from './actors'
import type { Font } from './assets'
import { OUT } from './fallback'

const LIFE = 1.15 // segundos en pantalla
const RISE = 22 // px de mundo que sube
const FADE = 0.35 // segundos finales de desvanecido
const SCALE = 2

export const DMG_COLOR = 0xffe27a
export const DMG_BIG = 0xff5a3a
export const DMG_LAVA = 0xffa040
export const DMG_SHIELD = 0x8ec8ff

interface Num {
  s: Sprite
  x: number
  y: number
  age: number
}

export class DamageNumbers {
  readonly root = new Container()
  font: Font | null = null
  private list: Num[] = []
  // varios números seguidos sobre el mismo tanque se apilan en vez de pisarse
  private lastAt = new Map<number, { t: number; n: number }>()
  private time = 0

  spawn(key: number, x: number, y: number, text: string, color: number): void {
    const prev = this.lastAt.get(key)
    const stack = prev && this.time - prev.t < 0.5 ? prev.n + 1 : 0
    this.lastAt.set(key, { t: this.time, n: stack })
    const s = new Sprite(numberTexture(text, color, this.font))
    s.scale.set(SCALE)
    s.anchor.set(0.5, 1)
    this.root.addChild(s)
    this.list.push({ s, x, y: y - stack * 12, age: 0 })
  }

  update(dt: number): void {
    this.time += dt
    for (let i = this.list.length - 1; i >= 0; i--) {
      const n = this.list[i]
      n.age += dt
      if (n.age >= LIFE) {
        n.s.texture.destroy(true)
        n.s.destroy()
        this.list.splice(i, 1)
        continue
      }
      // sube rápido al principio y frena
      const k = 1 - (1 - n.age / LIFE) ** 2
      n.s.position.set(Math.round(n.x), Math.round(n.y - RISE * k))
      n.s.alpha = n.age > LIFE - FADE ? (LIFE - n.age) / FADE : 1
    }
  }

  clear(): void {
    for (const n of this.list) {
      n.s.texture.destroy(true)
      n.s.destroy()
    }
    this.list = []
    this.lastAt.clear()
  }
}

function numberTexture(text: string, color: number, font: Font | null): Texture {
  const glyphs = [...text].map((ch) => glyph(ch, font))
  const w = glyphs.reduce((a, g) => a + g.w + 1, 0) + 1
  const h = 8
  const c = document.createElement('canvas')
  c.width = w + 1
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return Texture.from(c)
  const img = ctx.createImageData(c.width, c.height)
  const put = (x: number, y: number, col: number): void => {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return
    const i = (y * c.width + x) * 4
    img.data[i] = (col >> 16) & 255
    img.data[i + 1] = (col >> 8) & 255
    img.data[i + 2] = col & 255
    img.data[i + 3] = 255
  }
  const pts: [number, number][] = []
  let gx = 1
  for (const g of glyphs) {
    for (const [x, y] of g.px) pts.push([gx + x, 1 + y])
    gx += g.w + 1
  }
  // contorno de 1 px alrededor (8 vecinos) y sombra abajo
  for (const [x, y] of pts) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) put(x + dx, y + dy, OUT)
  for (const [x, y] of pts) put(x, y, color)
  ctx.putImageData(img, 0, 0)
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}
