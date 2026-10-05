// Controles táctiles (tablet y celular). Solo aparecen en pantallas táctiles (pointer: coarse) o con ?touch=1.
// Botones en pantalla que se mantienen apretados (ángulo, potencia) o se tocan (fuego, ítem, pausa),
// y apuntado arrastrando sobre el campo de batalla: la dirección del arrastre es el ángulo y el largo la potencia.
// v2: con dos dedos se arrastra el mundo (paneo de la cámara) y el botón ◎ recentra en tu tanque.
// v2 ajuste fino: en los botones de ángulo y potencia, un toque corto mueve un paso fino (FINE_STEP) y
// mantener mueve continuo: arranca a 1/5 de velocidad y a los RAMP segundos pasa a velocidad plena.
// HUD C (pulido v2): mover (◀ ▶) y elegir arma ya se tocan en el tablero de abajo del HUD, así que esos
// botones no se crean; quedan potencia, ángulo, ítem, fuego, pausa, recentrar y pantalla completa,
// ubicados por place() arriba del tablero y a la izquierda de los rivales (arriba a la derecha).
// v3 teledirigido: mientras se guía (setSteer), dos botones grandes ◀ ▶ a los costados dirigen el misil;
// también se puede arrastrar el dedo a la izquierda o a la derecha sobre el campo (desde donde se apoyó).
import { VIEW_H, VIEW_W, type Viewport } from '../render/types'
import type { Vec2 } from '../sim/types'
import type { PadAction, PadState } from './gamepad'

// Largo del arrastre (en pixels de mundo) que equivale a potencia 100.
const DRAG_FULL = 160
// Toque más corto que esto = un paso fino; más largo = continuo (segundos).
const TAP_TIME = 0.25
const FINE_STEP = 0.2 // grados o puntos de potencia por toque corto
const RAMP = 0.6 // segundos de continuo lento antes de ir a velocidad plena
const SLOW = 0.2
// Separación entre los botones y el tablero, y ancho reservado arriba a la derecha para los rivales del
// HUD (px lógicos de la pantalla de 800×450).
const BAR_GAP = 6
const RIVALS_W = 110 // v2.3: las placas de rivales de la derecha ocupan ~107 px lógicos
// v3: pixels de la ventana que hay que arrastrar para dirigir el teledirigido
const STEER_DRAG = 14

export interface TouchAim {
  angle: number
  power: number
}

type Hold = 'angUp' | 'angDown' | 'powUp' | 'powDown'

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
  private heldAt = new Map<Hold, number>() // cuándo se apoyó cada botón (performance.now, ms)
  private steps = { angle: 0, power: 0 } // pasos finos de toques cortos sin levantar todavía
  private pressed = new Set<PadAction>()
  private drag: { id: number; x0: number; y0: number; aim: TouchAim | null } | null = null
  private active = false
  // dedos apoyados en el campo; con dos o más, se panea hasta levantarlos todos
  private fingers = new Map<number, { x: number; y: number }>()
  private twoFinger = false
  private panDx = 0
  private recenterBtn: HTMLButtonElement | null = null
  private cols: HTMLDivElement[] = []
  private topBar: HTMLDivElement | null = null
  // v3 teledirigido: botones ◀ ▶ (lado apretado) y arrastre horizontal mientras se guía
  private steerOn = false
  private steerRoot = document.createElement('div')
  private steerHeld = new Set<-1 | 1>()
  private steerDrag: { id: number; x0: number; dir: -1 | 0 | 1 } | null = null
  // Punto de la ventana → mundo (renderer.screenToWorld). Sin él, mundo = pantalla lógica de 800 px.
  toWorld: ((clientX: number, clientY: number) => Vec2) | null = null
  // true: ese toque es de otro control (el minimapa) y no apunta.
  ignore: (e: PointerEvent) => boolean = () => false

  constructor(private stage: HTMLElement) {
    if (!this.enabled) return
    document.documentElement.classList.add('touch')
    this.root.id = 'touch'
    this.root.hidden = true
    const left = div('touch-col left')
    left.append(row(this.hold('powUp', 'POT +'), this.hold('powDown', 'POT −')))
    const right = div('touch-col right')
    right.append(
      row(this.hold('angUp', 'ÁNG ↺'), this.hold('angDown', 'ÁNG ↻')),
      row(this.tap('item', 'ÍTEM')),
      row(this.tap('fire', 'FUEGO', 'fire')),
    )
    this.cols = [left, right]
    const top = div('touch-top')
    this.topBar = top
    this.recenterBtn = this.tap('recenter', '◎')
    this.recenterBtn.style.display = 'none'
    top.append(this.tap('pause', 'II'), this.recenterBtn, fullscreenButton())
    this.guide.classList.add('touch-guide')
    this.line.setAttribute('stroke-dasharray', '4 4')
    this.guide.append(this.line)
    this.steerRoot.className = 'touch-steer'
    this.steerRoot.hidden = true
    this.steerRoot.append(this.steerButton(-1), this.steerButton(1))
    this.root.append(left, right, top, this.guide, this.steerRoot)
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
      this.heldAt.clear()
      this.steps = { angle: 0, power: 0 }
      this.pressed.clear()
      this.endDrag()
      this.fingers.clear()
      this.twoFinger = false
      this.panDx = 0
      this.steerHeld.clear()
      this.steerDrag = null
    }
  }

  // v3: modo guiado del teledirigido (solo cuando lo dirige este dispositivo). Oculta los botones de
  // apuntar y muestra ◀ ▶ grandes a los costados.
  setSteer(on: boolean): void {
    if (!this.enabled || on === this.steerOn) return
    this.steerOn = on
    this.steerRoot.hidden = !on
    for (const col of this.cols) col.style.visibility = on ? 'hidden' : ''
    if (!on) {
      this.steerHeld.clear()
      this.steerDrag = null
    }
    if (on) this.endDrag()
  }

  private steerButton(side: -1 | 1): HTMLButtonElement {
    const b = btn(side < 0 ? '◀' : '▶', 'steer')
    // en línea: los estilos de style.css son de vistas; botones grandes y translúcidos pegados a cada costado
    Object.assign(b.style, {
      position: 'fixed',
      top: '22%',
      height: '46%',
      width: 'max(64px, 16vw)',
      [side < 0 ? 'left' : 'right']: side < 0 ? 'max(6px, env(safe-area-inset-left))' : 'max(6px, env(safe-area-inset-right))',
      fontSize: 'max(28px, 6vw)',
      opacity: '0.55',
      zIndex: '30',
    })
    const off = (): void => {
      this.steerHeld.delete(side)
      b.classList.remove('on')
    }
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      b.setPointerCapture(e.pointerId)
      this.steerHeld.add(side)
      b.classList.add('on')
    })
    b.addEventListener('pointerup', off)
    b.addEventListener('pointercancel', off)
    b.addEventListener('lostpointercapture', off)
    return b
  }

  // Botón de recentrar: solo en mapas que no entran en pantalla.
  setRecenter(visible: boolean): void {
    if (this.recenterBtn) this.recenterBtn.style.display = visible ? '' : 'none'
  }

  // HUD C: ubica los botones según dónde quedó la pantalla del juego (vp, en pixels de la ventana): las
  // columnas apoyadas justo arriba del tablero (bar = filas lógicas que tapa; 0 = sin tablero, centradas
  // como antes) y los botones de arriba a la izquierda del cuadro de rivales.
  place(vp: Viewport, bar: number): void {
    if (!this.enabled || vp.w <= 0) return
    const k = vp.scale || vp.w / VIEW_W
    for (const col of this.cols) {
      if (bar > 0) {
        const barTop = vp.y + (VIEW_H - bar) * k
        col.style.top = 'auto'
        col.style.bottom = `${Math.max(8, Math.round(window.innerHeight - barTop + BAR_GAP * k))}px`
        col.style.transform = 'none'
      } else {
        col.style.top = col.style.bottom = col.style.transform = ''
      }
    }
    const top = this.topBar
    if (top) {
      const gameRight = window.innerWidth - (vp.x + vp.w)
      top.style.right = `max(10px, ${Math.round(gameRight + RIVALS_W * k)}px, env(safe-area-inset-right))`
      top.style.top = `max(8px, ${Math.round(vp.y + 3 * k)}px, env(safe-area-inset-top))`
    }
  }

  // Paneo con dos dedos desde la última llamada, en pixels de la ventana (positivo: los dedos fueron a la derecha).
  pollPan(): number {
    const dx = this.panDx
    this.panDx = 0
    return dx
  }

  // Mismo formato que el gamepad, así main.ts lo suma sin casos especiales.
  poll(): PadState {
    const state: PadState = {
      angle: 0,
      power: 0,
      move: 0,
      steer: 0,
      pan: 0,
      fine: false,
      stepAngle: this.steps.angle,
      stepPower: this.steps.power,
      pressed: this.pressed,
    }
    this.pressed = new Set()
    this.steps = { angle: 0, power: 0 }
    state.angle += this.speed('angUp') - this.speed('angDown')
    state.power += this.speed('powUp') - this.speed('powDown')
    // mover lo hacen ◀ ▶ del tablero del HUD (main.ts), no un botón táctil propio
    if (this.steerOn) {
      let side = 0
      for (const s of this.steerHeld) side += s
      if (side === 0 && this.steerDrag) side = this.steerDrag.dir
      state.steer = Math.max(-1, Math.min(1, side))
    }
    return state
  }

  // Velocidad continua de un botón de ángulo o potencia: 0 durante el toque corto, después lenta y plena.
  private speed(kind: Hold): number {
    const at = this.heldAt.get(kind)
    if (!this.held.has(kind) || at == null) return 0
    const held = (performance.now() - at) / 1000
    if (held < TAP_TIME) return 0
    return held < TAP_TIME + RAMP ? SLOW : 1
  }

  // Ángulo y potencia absolutos mientras se arrastra, o null.
  dragAim(): TouchAim | null {
    return this.drag?.aim ?? null
  }

  private hold(kind: Hold, text: string): HTMLButtonElement {
    const b = btn(text)
    const off = (): void => {
      // pointerup y lostpointercapture llegan los dos: solo el primero cuenta
      if (this.held.has(kind)) {
        const at = this.heldAt.get(kind) ?? 0
        if ((performance.now() - at) / 1000 < TAP_TIME) this.tapStep(kind)
      }
      this.held.delete(kind)
      this.heldAt.delete(kind)
      b.classList.remove('on')
    }
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      b.setPointerCapture(e.pointerId)
      this.held.add(kind)
      this.heldAt.set(kind, performance.now())
      b.classList.add('on')
    })
    b.addEventListener('pointerup', off)
    b.addEventListener('pointercancel', off)
    b.addEventListener('lostpointercapture', off)
    return b
  }

  // Toque corto en ángulo o potencia: un paso fino.
  private tapStep(kind: Hold): void {
    if (kind === 'angUp') this.steps.angle += FINE_STEP
    else if (kind === 'angDown') this.steps.angle -= FINE_STEP
    else if (kind === 'powUp') this.steps.power += FINE_STEP
    else if (kind === 'powDown') this.steps.power -= FINE_STEP
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
      if (!this.active || e.pointerType === 'mouse' || this.ignore(e)) return
      target.setPointerCapture(e.pointerId)
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.fingers.size >= 2) {
        // segundo dedo: deja de apuntar y arrastra el mundo
        this.twoFinger = true
        this.endDrag()
        return
      }
      if (this.drag || this.twoFinger) return
      if (this.steerOn) {
        // guiando: el dedo dirige el misil, no apunta
        if (!this.steerDrag) this.steerDrag = { id: e.pointerId, x0: e.clientX, dir: 0 }
        return
      }
      this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, aim: null }
    })
    target.addEventListener('pointermove', (e) => {
      const f = this.fingers.get(e.pointerId)
      if (f && this.twoFinger) {
        // el paneo sigue al punto medio de los dedos: cada dedo aporta su parte
        this.panDx += (e.clientX - f.x) / this.fingers.size
        f.x = e.clientX
        f.y = e.clientY
        return
      }
      if (f) {
        f.x = e.clientX
        f.y = e.clientY
      }
      const sd = this.steerDrag
      if (sd && sd.id === e.pointerId) {
        const dx = e.clientX - sd.x0
        sd.dir = dx <= -STEER_DRAG ? -1 : dx >= STEER_DRAG ? 1 : 0
        return
      }
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      let dx: number
      let dy: number
      if (this.toWorld) {
        // en mundo: con la cámara del último frame, los dos puntos se mapean igual
        const a = this.toWorld(d.x0, d.y0)
        const b = this.toWorld(e.clientX, e.clientY)
        dx = b.x - a.x
        dy = b.y - a.y
      } else {
        const scale = target.getBoundingClientRect().width / 800 || 1
        dx = (e.clientX - d.x0) / scale
        dy = (e.clientY - d.y0) / scale
      }
      const len = Math.hypot(dx, dy)
      if (len < 6) return
      let angle = (Math.atan2(-dy, dx) * 180) / Math.PI
      if (angle < 0) angle = dx >= 0 ? 0 : 180 // por debajo de la horizontal: queda plano
      d.aim = { angle, power: Math.min(100, (len / DRAG_FULL) * 100) }
      this.drawGuide(d.x0, d.y0, e.clientX, e.clientY)
    })
    const end = (e: PointerEvent): void => {
      this.fingers.delete(e.pointerId)
      if (this.fingers.size === 0) this.twoFinger = false
      if (this.drag?.id === e.pointerId) this.endDrag()
      if (this.steerDrag?.id === e.pointerId) this.steerDrag = null
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
