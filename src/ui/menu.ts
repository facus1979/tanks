// Menú y pantalla de resultado con estética Broforce. Todo el texto sale de la fuente pixel.
import { BIOMES, CREWS, TANK_COLORS, type Biome, type CrewId, type Difficulty, type MatchConfig } from '../sim/types'
import { uiAssets } from './assets'
import { OUT, css, drawOutlined, drawText, measure } from './pixelfont'

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
  const base = Math.min(window.innerWidth / 800, window.innerHeight / 450)
  return Math.max(2, Math.round(base * 1.2))
}

function label(text: string, color = 0xffffff, size = 1, kind: Label['kind'] = 'plain'): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'px-label'
  const entry = { canvas, text, color, size, kind }
  labels.push(entry)
  paintLabel(entry)
  return canvas
}

function setLabel(canvas: HTMLCanvasElement, text: string, color?: number): void {
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

export function refreshLabels(): void {
  document.documentElement.style.setProperty('--px', `${uiScale()}px`)
  prune(labels)
  prune(portraits)
  for (const entry of labels) paintLabel(entry)
  for (const p of portraits) paintPortrait(p)
}

// Saca las entradas cuyo canvas ya no está en el documento (retratos de resultados viejos).
function prune<T extends { canvas: HTMLCanvasElement }>(list: T[]): void {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].canvas.isConnected) list.splice(i, 1)
}

interface PortraitBox {
  canvas: HTMLCanvasElement
  crew: CrewId
  color: number
  size: number
}
const portraits: PortraitBox[] = []

function portrait(crew: CrewId, color: number, size = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'px-label'
  const box = { canvas, crew, color, size }
  portraits.push(box)
  paintPortrait(box)
  return canvas
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
  }
  const s = uiScale() * box.size
  canvas.style.width = `${36 * s}px`
  canvas.style.height = `${36 * s}px`
}

function button(text: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `px-btn ${extra}`.trim()
  b.append(label(text))
  b.addEventListener('click', onClick)
  return b
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

const BIOME_NAMES: Record<Biome, string> = { forest: 'BOSQUE', jungle: 'JUNGLA', industrial: 'INDUSTRIAL' }
const DIFFICULTIES: { id: Difficulty; name: string }[] = [
  { id: 'easy', name: 'FACIL' },
  { id: 'normal', name: 'NORMAL' },
  { id: 'hard', name: 'DIFICIL' },
]

export class Menu {
  private choice: { bots: number; difficulty: Difficulty; biome: Biome } = { bots: 2, difficulty: 'normal', biome: 'forest' }
  private playButton: HTMLButtonElement

  constructor(
    private root: HTMLElement,
    private onPlay: (config: MatchConfig) => void,
    private onClick: () => void,
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem('tanks.menu') ?? 'null')
      if (saved && typeof saved === 'object') {
        if ([1, 2, 3].includes(saved.bots)) this.choice.bots = saved.bots
        if (DIFFICULTIES.some((d) => d.id === saved.difficulty)) this.choice.difficulty = saved.difficulty
        if (BIOMES.includes(saved.biome)) this.choice.biome = saved.biome
      }
    } catch {
      // sin storage: quedan los valores por defecto
    }
    const frame = el('div', 'frame')
    const title = el('div', 'title')
    title.append(label('TANKS', 0xffd23a, 4, 'title'))
    const sub = el('div', 'subtitle')
    sub.append(label('ARTILLERIA POR TURNOS', 0xc4a574))
    const crews = el('div', 'crews')
    CREWS.forEach((crew, i) => crews.append(portrait(crew, TANK_COLORS[i] ?? 0xffffff)))

    const rows = el('div', 'rows')
    rows.append(
      this.row('RIVALES', [1, 2, 3].map((n) => ({ key: String(n), text: String(n) })), () => String(this.choice.bots), (k) => {
        this.choice.bots = Number(k)
      }),
      this.row('DIFICULTAD', DIFFICULTIES.map((d) => ({ key: d.id, text: d.name })), () => this.choice.difficulty, (k) => {
        this.choice.difficulty = k as Difficulty
      }),
      this.row('BIOMA', BIOMES.map((b) => ({ key: b, text: BIOME_NAMES[b] })), () => this.choice.biome, (k) => {
        this.choice.biome = k as Biome
      }),
    )
    this.playButton = button('JUGAR', () => this.play(), 'play')
    const hint = el('div', 'hint')
    for (const line of ['IZQ/DER ANGULO   ARRIBA/ABAJO POTENCIA', 'A/D MOVER   1-8 ARMA   ESPACIO DISPARA']) {
      const p = el('div', 'hint-line')
      p.append(label(line, 0x9a8e80))
      hint.append(p)
    }
    frame.append(title, sub, crews, rows, this.playButton, hint)
    root.replaceChildren(frame)
  }

  set enabled(on: boolean) {
    this.playButton.disabled = !on
  }

  show(): void {
    this.root.hidden = false
    this.playButton.focus({ preventScroll: true })
  }

  hide(): void {
    this.root.hidden = true
  }

  get visible(): boolean {
    return !this.root.hidden
  }

  play(): void {
    if (this.playButton.disabled) return
    this.onClick()
    try {
      localStorage.setItem('tanks.menu', JSON.stringify(this.choice))
    } catch {
      // ignorado
    }
    this.onPlay({ bots: this.choice.bots, difficulty: this.choice.difficulty, biome: this.choice.biome })
  }

  private row(
    name: string,
    options: { key: string; text: string }[],
    get: () => string,
    set: (key: string) => void,
  ): HTMLElement {
    const row = el('div', 'row')
    const head = el('div', 'row-name')
    head.append(label(name, 0xc4a574))
    const group = el('div', 'seg')
    const buttons = options.map((o) => {
      const b = button(o.text, () => {
        set(o.key)
        this.onClick()
        sync()
      })
      b.dataset.key = o.key
      return b
    })
    const sync = () => {
      for (const b of buttons) b.classList.toggle('on', b.dataset.key === get())
    }
    sync()
    group.append(...buttons)
    row.append(head, group)
    return row
  }
}

export interface ResultInfo {
  title: string
  winner: { crew: CrewId; color: number; name: string } | null
}

export class ResultScreen {
  private titleLabel: HTMLCanvasElement
  private who: HTMLElement
  private rematch: HTMLButtonElement

  constructor(
    private root: HTMLElement,
    onRematch: () => void,
    onMenu: () => void,
    onClick: () => void,
  ) {
    const frame = el('div', 'frame')
    const title = el('div', 'title')
    this.titleLabel = label('FIN', 0xffd23a, 3, 'title')
    title.append(this.titleLabel)
    this.who = el('div', 'crews')
    const actions = el('div', 'actions')
    this.rematch = button('REVANCHA', () => {
      onClick()
      onRematch()
    }, 'play')
    actions.append(
      this.rematch,
      button('MENU', () => {
        onClick()
        onMenu()
      }),
    )
    frame.append(title, this.who, actions)
    root.replaceChildren(frame)
  }

  show(info: ResultInfo): void {
    setLabel(this.titleLabel, info.title.toUpperCase())
    this.who.replaceChildren()
    if (info.winner) {
      const box = el('div', 'winner')
      box.append(portrait(info.winner.crew, info.winner.color, 1.5), label(info.winner.name.toUpperCase(), 0xffffff))
      this.who.append(box)
    }
    this.root.hidden = false
    this.rematch.focus({ preventScroll: true })
  }

  hide(): void {
    this.root.hidden = true
  }

  get visible(): boolean {
    return !this.root.hidden
  }
}
