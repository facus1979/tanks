// Pantalla de título: fondo del bosque con parallax, logo con entrada rebotando y brillo, "APRETÁ CUALQUIER TECLA".
import { WORLD_H, WORLD_W } from '../sim/types'
import { uiAssets } from './assets'
import { OUT, css, drawOutlined, drawText, measure } from './pixelfont'
import { pollPad, screenRoot } from './kit'
import type { TitleView } from './types'

const DROP_MS = 1100
const LOGO_SCALE = 2
const GUARD_MS = 250

export function createTitleView(root?: HTMLElement): TitleView {
  return new TitleScreen(root ?? screenRoot('title-view'))
}

class TitleScreen implements TitleView {
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private t0 = 0
  private onStart: (() => void) | null = null
  private stopPad: (() => void) | null = null
  private fallbackLogo: HTMLCanvasElement | null = null

  constructor(private root: HTMLElement) {
    this.root.classList.add('solid')
    this.canvas.width = WORLD_W
    this.canvas.height = WORLD_H
    this.canvas.className = 'title-canvas'
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Sin canvas 2D para el título')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false
    this.root.style.padding = '0'
    this.root.style.overflow = 'hidden'
    this.root.replaceChildren(this.canvas)
    this.root.addEventListener('pointerdown', () => this.go())
  }

  show(onStart: () => void): void {
    this.onStart = onStart
    this.root.hidden = false
    this.t0 = performance.now()
    this.fit()
    window.addEventListener('resize', this.fit)
    window.addEventListener('keydown', this.onKey, true)
    this.stopPad?.()
    this.stopPad = pollPad(() => this.go())
    cancelAnimationFrame(this.raf)
    const loop = () => {
      this.draw((performance.now() - this.t0) / 1000)
      this.raf = requestAnimationFrame(loop)
    }
    loop()
  }

  hide(): void {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.fit)
    window.removeEventListener('keydown', this.onKey, true)
    this.stopPad?.()
    this.stopPad = null
    this.onStart = null
    this.root.hidden = true
  }

  private go(): void {
    if (performance.now() - this.t0 < GUARD_MS) return
    const cb = this.onStart
    if (cb) cb()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'KeyM'].includes(e.code)) return
    e.stopPropagation()
    e.preventDefault()
    if (!e.repeat) this.go()
  }

  // El canvas de 800×450 cubre la ventana con escala uniforme.
  private fit = (): void => {
    const s = Math.max(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H)
    const w = WORLD_W * s
    const h = WORLD_H * s
    const st = this.canvas.style
    st.position = 'absolute'
    st.width = `${w}px`
    st.height = `${h}px`
    st.left = `${(window.innerWidth - w) / 2}px`
    st.top = `${(window.innerHeight - h) / 2}px`
  }

  private draw(t: number): void {
    const ctx = this.ctx
    const assets = uiAssets()
    const layers = assets.forest
    if (layers.length === 0) {
      const g = ctx.createLinearGradient(0, 0, 0, WORLD_H)
      g.addColorStop(0, '#3a5a4a')
      g.addColorStop(1, '#141c18')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, WORLD_W, WORLD_H)
    }
    layers.forEach((img, i) => {
      const depth = i / Math.max(1, layers.length - 1)
      const sway = Math.sin(t * 0.35 + i) * 6 * depth + Math.sin(t * 0.11) * 10 * depth
      const bob = Math.sin(t * 0.5 + i * 0.7) * 1.5 * depth
      const grow = 1.06
      const w = WORLD_W * grow
      const h = WORLD_H * grow
      ctx.drawImage(img, Math.round((WORLD_W - w) / 2 + sway), Math.round((WORLD_H - h) / 2 + bob), Math.round(w), Math.round(h))
    })
    // oscurece abajo y en los bordes
    const shade = ctx.createLinearGradient(0, WORLD_H * 0.45, 0, WORLD_H)
    shade.addColorStop(0, '#0e0a0900')
    shade.addColorStop(1, '#0e0a09cc')
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, WORLD_W, WORLD_H)
    const vig = ctx.createRadialGradient(WORLD_W / 2, WORLD_H / 2, WORLD_H * 0.45, WORLD_W / 2, WORLD_H / 2, WORLD_W * 0.7)
    vig.addColorStop(0, '#0000')
    vig.addColorStop(1, '#000000a0')
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, WORLD_W, WORLD_H)

    this.drawLogo(ctx, t)
    this.drawPrompt(ctx, t)
  }

  private logoSource(): HTMLCanvasElement | HTMLImageElement {
    const img = uiAssets().logo
    if (img) return img
    if (!this.fallbackLogo) {
      const font = uiAssets().font
      const text = 'TANKS'
      const w = measure(font, text) + 6
      const h = font.h + 8
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      if (g) {
        drawText(g, font, text, 3, 5, 0x6a1a10, null)
        drawOutlined(g, font, text, 3, 3, OUT)
        // relleno en bandas
        const m = document.createElement('canvas')
        m.width = w
        m.height = h
        const mg = m.getContext('2d')
        if (mg) {
          drawText(mg, font, text, 3, 3, 0xffffff, null)
          mg.globalCompositeOperation = 'source-in'
          const bands = [0xfff2b0, 0xffd23a, 0xffd23a, 0xffa22e, 0xe0561c]
          for (let y = 0; y < font.h; y++) {
            mg.fillStyle = css(bands[Math.min(4, Math.floor((y / font.h) * 5))])
            mg.fillRect(0, 3 + y, w, 1)
          }
          g.drawImage(m, 0, 0)
        }
      }
      this.fallbackLogo = c
    }
    return this.fallbackLogo
  }

  private drawLogo(ctx: CanvasRenderingContext2D, t: number): void {
    const src = this.logoSource()
    const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width
    const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height
    const scale = src instanceof HTMLImageElement ? Math.max(1, Math.min(LOGO_SCALE, Math.floor((WORLD_W - 40) / sw))) : 5
    const w = sw * scale
    const h = sh * scale
    const x = Math.round((WORLD_W - w) / 2)
    const rest = 70
    const p = Math.min(1, t / (DROP_MS / 1000))
    const y = Math.round(-h + (rest + h) * bounce(p) + (p >= 1 ? Math.sin(t * 1.6) * 2 : 0))
    // sombra
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.fillStyle = '#000'
    ctx.fillRect(x + 10, y + h - 4, w - 20, 6)
    ctx.restore()
    ctx.drawImage(src, x, y, w, h)
    // brillo: banda diagonal que pasa cada 3 s, recortada con la silueta del logo
    const cycle = (t - 1.4) % 3
    if (t > 1.4 && cycle < 0.7) {
      const k = cycle / 0.7
      const glint = document.createElement('canvas')
      glint.width = w
      glint.height = h
      const g = glint.getContext('2d')
      if (g) {
        const bx = -h + (w + h * 2) * k
        g.fillStyle = '#ffffffb0'
        g.beginPath()
        g.moveTo(bx, h)
        g.lineTo(bx + 26, h)
        g.lineTo(bx + 26 + h * 0.6, 0)
        g.lineTo(bx + h * 0.6, 0)
        g.closePath()
        g.fill()
        g.globalCompositeOperation = 'destination-in'
        g.imageSmoothingEnabled = false
        g.drawImage(src, 0, 0, w, h)
        ctx.drawImage(glint, x, y)
      }
    }
  }

  private drawPrompt(ctx: CanvasRenderingContext2D, t: number): void {
    if (t < 1.3) return
    const font = uiAssets().font
    const text = 'APRETA CUALQUIER TECLA'
    const scale = 2
    const w = measure(font, text)
    const c = document.createElement('canvas')
    c.width = w + 2
    c.height = font.h + 2
    const g = c.getContext('2d')
    if (!g) return
    drawText(g, font, text, 1, 1, 0xffffff)
    const alpha = 0.55 + 0.45 * Math.sin(t * 4)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.drawImage(c, Math.round((WORLD_W - c.width * scale) / 2), WORLD_H - 70, c.width * scale, c.height * scale)
    ctx.restore()
    const sub = 'ARTILLERIA POR TURNOS'
    const sw = measure(font, sub)
    drawText(ctx, font, sub, Math.round((WORLD_W - sw) / 2), WORLD_H - 34, 0xc4a574)
  }
}

// Caída con rebotes (easeOutBounce).
function bounce(p: number): number {
  const n = 7.5625
  const d = 2.75
  if (p < 1 / d) return n * p * p
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375
  return n * (p -= 2.625 / d) * p + 0.984375
}
