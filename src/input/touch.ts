// Controles táctiles (tablet y celular). Solo aparecen en pantallas táctiles (pointer: coarse) o con ?touch=1.
// Botones en pantalla que se mantienen apretados (mover, ángulo, potencia) o se tocan (fuego, arma, ítem, pausa),
// y apuntado arrastrando sobre el campo de batalla: la dirección del arrastre es el ángulo y el largo la potencia.
import type { PadAction, PadState } from './gamepad'

// Largo del arrastre (en pixels lógicos de 800×450) que equivale a potencia 100.
const DRAG_FULL = 160

export interface TouchAim {
  angle: number
  power: number
}

type Hold = 'left' | 'right' | 'angUp' | 'angDown' | 'powUp' | 'powDown'

export function isTouchDevice(): boolean {
  if (new URLSearchParams(location.search).has('touch')) return true
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export class TouchControls {
  readonly enabled = isTouchDevice()
  private root = document.createElement('div')
  private guide = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  private line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  private held = new Set<Hold>()
  private pressed = new Set<PadAction>()
  private drag: { id: number; x0: number; y0: number; aim: TouchAim | null } | null = null
  private active = false

  constructor(private stage: HTMLElement) {
    if (!this.enabled) return
    document.documentElement.classList.add('touch')
    this.root.id = 'touch'
    this.root.hidden = true
    const left = div('touch-col left')
    left.append(
      row(this.hold('powUp', 'POT +'), this.hold('powDown', 'POT −')),
      row(this.hold('left', '◀'), this.hold('right', '▶')),
    )
    const right = div('touch-col right')
    right.append(
      row(this.hold('angUp', 'ÁNG ↺'), this.hold('angDown', 'ÁNG ↻')),
      row(this.tap('item', 'ÍTEM'), this.tap('nextWeapon', 'ARMA ▶')),
      row(this.tap('fire', 'FUEGO', 'fire')),
    )
    const top = div('touch-top')
    top.append(this.tap('pause', 'II'), fullscreenButton())
    this.guide.classList.add('touch-guide')
    this.line.setAttribute('stroke-dasharray', '4 4')
    this.guide.append(this.line)
    this.root.append(left, right, top, this.guide)
    document.getElementById('app')?.append(this.root)
    this.bindDrag()
  }

  // Visible solo durante la partida, sin carteles encima.
  setActive(on: boolean): void {
    if (!this.enabled || on === this.active) return
    this.active = on
    this.root.hidden = !on
    document.documentElement.classList.toggle('touch-playing', on)
    if (!on) {
      this.held.clear()
      this.pressed.clear()
      this.endDrag()
    }
  }

  // Mismo formato que el gamepad, así main.ts lo suma sin casos especiales.
  poll(): PadState {
    const state: PadState = { angle: 0, power: 0, move: 0, pressed: this.pressed }
    this.pressed = new Set()
    if (this.held.has('angUp')) state.angle += 1
    if (this.held.has('angDown')) state.angle -= 1
    if (this.held.has('powUp')) state.power += 1
    if (this.held.has('powDown')) state.power -= 1
    const l = this.held.has('left')
    const r = this.held.has('right')
    if (l !== r) state.move = l ? -1 : 1
    return state
  }

  // Ángulo y potencia absolutos mientras se arrastra, o null.
  dragAim(): TouchAim | null {
    return this.drag?.aim ?? null
  }

  private hold(kind: Hold, text: string): HTMLButtonElement {
    const b = btn(text)
    const off = (): void => {
      this.held.delete(kind)
      b.classList.remove('on')
    }
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      b.setPointerCapture(e.pointerId)
      this.held.add(kind)
      b.classList.add('on')
    })
    b.addEventListener('pointerup', off)
    b.addEventListener('pointercancel', off)
    b.addEventListener('lostpointercapture', off)
    return b
  }

  private tap(action: PadAction, text: string, cls = ''): HTMLButtonElement {
    const b = btn(text, cls)
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.pressed.add(action)
      b.classList.add('on')
      window.setTimeout(() => b.classList.remove('on'), 120)
    })
    return b
  }

  private bindDrag(): void {
    const target = this.stage
    target.addEventListener('pointerdown', (e) => {
      if (!this.active || this.drag || e.pointerType === 'mouse') return
      target.setPointerCapture(e.pointerId)
      this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, aim: null }
    })
    target.addEventListener('pointermove', (e) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      const rect = target.getBoundingClientRect()
      const scale = rect.width / 800 || 1
      const dx = (e.clientX - d.x0) / scale
      const dy = (e.clientY - d.y0) / scale
      const len = Math.hypot(dx, dy)
      if (len < 6) return
      let angle = (Math.atan2(-dy, dx) * 180) / Math.PI
      if (angle < 0) angle = dx >= 0 ? 0 : 180 // por debajo de la horizontal: queda plano
      d.aim = { angle, power: Math.min(100, (len / DRAG_FULL) * 100) }
      this.drawGuide(d.x0, d.y0, e.clientX, e.clientY)
    })
    const end = (e: PointerEvent): void => {
      if (this.drag?.id === e.pointerId) this.endDrag()
    }
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  private endDrag(): void {
    this.drag = null
    this.guide.style.display = 'none'
  }

  private drawGuide(x0: number, y0: number, x1: number, y1: number): void {
    this.guide.style.display = 'block'
    this.line.setAttribute('x1', String(x0))
    this.line.setAttribute('y1', String(y0))
    this.line.setAttribute('x2', String(x1))
    this.line.setAttribute('y2', String(y1))
  }
}

// Pantalla completa y horizontal. Lo usan también las pantallas fuera de la partida.
export function fullscreenButton(): HTMLButtonElement {
  const b = btn('⛶', 'fs')
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    void toggleFullscreen()
  })
  return b
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    await orientation.lock?.('landscape').catch(() => {})
  } catch {
    // iOS Safari no tiene pantalla completa para páginas: se juega igual
  }
}

export function vibrate(pattern: number | number[]): void {
  if (!isTouchDevice()) return
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // sin vibración
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function row(...children: HTMLElement[]): HTMLDivElement {
  const r = div('touch-row')
  r.append(...children)
  return r
}

function btn(text: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `touch-btn ${cls}`.trim()
  b.textContent = text
  return b
}
