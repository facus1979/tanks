// Piezas compartidas por las vistas: etiquetas y retratos dibujados en canvas con la fuente pixel,
// botones, íconos y entrada unificada (teclado + gamepad).
import { ITEM_ORDER, type CrewId, type ItemId, type ShopId } from '../sim/types'
import { uiAssets } from './assets'
import { OUT, css, drawOutlined, drawText, measure } from './pixelfont'

export type Nav = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'start'

interface Label {
  canvas: HTMLCanvasElement
  text: string
  color: number
  size: number // múltiplo de la escala base
  kind: 'plain' | 'title'
}

const labels: Label[] = []

// Escala de pixel de la UI: la del juego redondeada, con piso de 2.
export function uiScale(): number {
  const forced = (window as unknown as { __uiScale?: number }).__uiScale
  if (forced) return forced
  const base = Math.min(window.innerWidth / 800, window.innerHeight / 450)
  return Math.max(2, Math.round(base * 1.2))
}

export function label(text: string, color = 0xffffff, size = 1, kind: Label['kind'] = 'plain'): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'px-label'
  const entry = { canvas, text, color, size, kind }
  labels.push(entry)
  paintLabel(entry)
  return canvas
}

export function setLabel(canvas: HTMLCanvasElement, text: string, color?: number): void {
  const entry = labels.find((l) => l.canvas === canvas)
  if (!entry) return
  entry.text = text
  if (color != null) entry.color = color
  paintLabel(entry)
}

function paintLabel(entry: Label): void {
  const font = uiAssets().font
  const w = measure(font, entry.text)
  const title = entry.kind === 'title'
  const pad = title ? 2 : 1
  const cw = w + pad * 2 + 1
  const ch = font.h + pad * 2 + (title ? 2 : 1)
  const { canvas } = entry
  canvas.width = Math.max(1, cw)
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, cw, ch)
  if (title) paintTitle(ctx, entry.text, pad, entry.color)
  else drawText(ctx, font, entry.text, pad, pad, entry.color)
  const s = uiScale() * entry.size
  canvas.style.width = `${cw * s}px`
  canvas.style.height = `${ch * s}px`
}

// Cartel: contorno, extrusión roja y relleno en bandas de amarillo a naranja.
function paintTitle(ctx: CanvasRenderingContext2D, text: string, pad: number, color: number): void {
  const font = uiAssets().font
  drawText(ctx, font, text, pad, pad + 2, 0x6a1a10, null)
  drawOutlined(ctx, font, text, pad, pad, OUT)
  const w = measure(font, text)
  const mask = document.createElement('canvas')
  mask.width = w + 1
  mask.height = font.h
  const m = mask.getContext('2d')
  const tmp = document.createElement('canvas')
  tmp.width = w + 1
  tmp.height = font.h
  const t = tmp.getContext('2d')
  if (!t || !m) return
  drawText(m, font, text, 0, 0, 0xffffff, null)
  const bands = [0xfff2b0, color, color, 0xffa22e, 0xe0561c]
  for (let y = 0; y < font.h; y++) {
    t.fillStyle = css(bands[Math.min(bands.length - 1, Math.floor((y / font.h) * bands.length))])
    t.fillRect(0, y, w + 1, 1)
  }
  t.globalCompositeOperation = 'destination-in'
  t.drawImage(mask, 0, 0)
  ctx.drawImage(tmp, pad, pad)
}

interface PortraitBox {
  canvas: HTMLCanvasElement
  crew: CrewId
  color: number
  size: number
}
const portraits: PortraitBox[] = []

export function portrait(crew: CrewId, color: number, size = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'px-label'
  const box = { canvas, crew, color, size }
  portraits.push(box)
  paintPortrait(box)
  return canvas
}

export function setPortrait(canvas: HTMLCanvasElement, crew: CrewId, color: number): void {
  const box = portraits.find((p) => p.canvas === canvas)
  if (!box) return
  box.crew = crew
  box.color = color
  paintPortrait(box)
}

function paintPortrait(box: PortraitBox): void {
  const { canvas } = box
  canvas.width = 36
  canvas.height = 36
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = css(OUT)
  ctx.fillRect(0, 0, 36, 36)
  ctx.fillStyle = css(box.color)
  ctx.fillRect(1, 1, 34, 34)
  ctx.fillStyle = css(0x1c1614)
  ctx.fillRect(2, 2, 32, 32)
  const img = uiAssets().portraits[box.crew]
  if (img) ctx.drawImage(img, 2, 2, 32, 32)
  else {
    ctx.fillStyle = css(box.color)
    ctx.fillRect(11, 8, 14, 6)
    ctx.fillStyle = css(0xd8966c)
    ctx.fillRect(12, 14, 12, 10)
    ctx.fillStyle = css(0x4a5a2a)
    ctx.fillRect(8, 25, 20, 9)
  }
  const s = uiScale() * box.size
  canvas.style.width = `${36 * s}px`
  canvas.style.height = `${36 * s}px`
}

// Ícono de 12×12 de un arma o ítem de la tienda; sin asset, un cuadro con la inicial.
interface IconBox {
  canvas: HTMLCanvasElement
  id: ShopId
  size: number
}
const icons: IconBox[] = []
const WEAPON_STRIP = ['normal', 'heavy', 'dirt', 'cluster', 'napalm', 'digger', 'roller', 'nuke']

export function icon(id: ShopId, size = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'px-label'
  const box = { canvas, id, size }
  icons.push(box)
  paintIcon(box)
  return canvas
}

function paintIcon(box: IconBox): void {
  const { canvas, id } = box
  canvas.width = 12
  canvas.height = 12
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  const assets = uiAssets()
  const isItem = (ITEM_ORDER as string[]).includes(id)
  const strip = isItem ? assets.itemIcons : assets.weaponIcons
  const index = isItem ? ITEM_ORDER.indexOf(id as ItemId) : WEAPON_STRIP.indexOf(id)
  if (strip && index >= 0 && index < strip.frames) ctx.drawImage(strip.img, index * strip.w, 0, strip.w, strip.h, 0, 0, 12, 12)
  else {
    ctx.fillStyle = css(OUT)
    ctx.fillRect(0, 0, 12, 12)
    ctx.fillStyle = css(isItem ? 0x3d8cf0 : 0xb8b0a0)
    ctx.fillRect(1, 1, 10, 10)
    ctx.fillStyle = css(0x2a2220)
    ctx.fillRect(2, 2, 8, 8)
    drawText(ctx, assets.font, id[0].toUpperCase(), 4, 3, 0xffffff, null)
  }
  const s = uiScale() * box.size
  canvas.style.width = `${12 * s}px`
  canvas.style.height = `${12 * s}px`
}

// Recalcula la escala y repinta todo lo dibujado (al cambiar el tamaño de la ventana o cargar assets).
export function refreshLabels(): void {
  document.documentElement.style.setProperty('--px', `${uiScale()}px`)
  prune(labels)
  prune(portraits)
  prune(icons)
  for (const entry of labels) paintLabel(entry)
  for (const p of portraits) paintPortrait(p)
  for (const i of icons) paintIcon(i)
}

// Saca las entradas cuyo canvas ya no está en el documento.
function prune<T extends { canvas: HTMLCanvasElement }>(list: T[]): void {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].canvas.isConnected) list.splice(i, 1)
}

window.addEventListener('resize', refreshLabels)
document.documentElement.style.setProperty('--px', `${uiScale()}px`)

export function button(text: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `px-btn ${extra}`.trim()
  b.append(label(text))
  b.addEventListener('click', onClick)
  return b
}

export function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

// Pantalla completa propia dentro de #app (o del body si no está).
export function screenRoot(id: string, extra = ''): HTMLElement {
  const root = el('div', `screen ${extra}`.trim())
  root.id = id
  root.hidden = true
  ;(document.querySelector('#app') ?? document.body).append(root)
  return root
}

const KEY_NAV: Record<string, Nav> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'ok',
  Space: 'ok',
  Escape: 'back',
}

// Escucha teclado y gamepad mientras la vista está visible. `raw` recibe el evento original
// (para atajos propios); si devuelve true, el evento se considera atendido. Devuelve la función que lo suelta.
export function bindNav(handler: (nav: Nav) => void, raw?: (e: KeyboardEvent) => boolean): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // la vista se queda con todas las teclas: el juego no tiene que ver el espacio ni las flechas
    e.stopPropagation()
    if (raw?.(e)) {
      e.preventDefault()
      return
    }
    const nav = KEY_NAV[e.code]
    if (!nav) return
    e.preventDefault()
    if (!e.repeat || nav === 'up' || nav === 'down' || nav === 'left' || nav === 'right') handler(nav)
  }
  window.addEventListener('keydown', onKey, true)
  const stopPad = pollPad((b) => {
    const nav = PAD_NAV[b]
    if (nav) handler(nav)
  })
  return () => {
    window.removeEventListener('keydown', onKey, true)
    stopPad()
  }
}

// Índices del mapa estándar de gamepad.
const PAD_NAV: Record<number, Nav> = { 0: 'ok', 1: 'back', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right' }

// Llama a onButton en el flanco de subida de cada botón (más el stick izquierdo como cruz).
export function pollPad(onButton: (button: number) => void): () => void {
  let raf = 0
  let prev = new Set<number>()
  let first = true
  const tick = () => {
    const now = new Set<number>()
    try {
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue
        pad.buttons.forEach((b, i) => b.pressed && now.add(i))
        const [ax, ay] = pad.axes
        if (ay < -0.6) now.add(12)
        if (ay > 0.6) now.add(13)
        if (ax < -0.6) now.add(14)
        if (ax > 0.6) now.add(15)
      }
    } catch {
      // sin gamepad
    }
    if (!first) for (const b of now) if (!prev.has(b)) onButton(b)
    first = false
    prev = now
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}
