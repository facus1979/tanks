// Gamepad en partida (mapa estándar). Las vistas (menú, tienda, tabla, cartel) leen el pad por su cuenta.
// Stick izquierdo o cruceta: ángulo (horizontal) y potencia (vertical). Gatillos o bumpers: mover.
// A dispara, X/Y arma anterior/siguiente, B usa un ítem, Start pausa.
// v2: stick derecho panea la cámara (izquierda / derecha); apretarlo (R3) la recentra en tu tanque.
// v2 ajuste fino: el stick izquierdo modula la velocidad por cuánto se inclina (curva cuadrática pasada la
// zona muerta: a media inclinación va a 1/4); mantener L3 (apretar el stick izquierdo) o Select/Back pasa
// ángulo y potencia a 1/5 de velocidad, como Shift en el teclado.
export type PadAction = 'fire' | 'prevWeapon' | 'nextWeapon' | 'item' | 'pause' | 'recenter'

const DEAD = 0.25
const BUTTON_ACTION: Record<number, PadAction> = { 0: 'fire', 2: 'prevWeapon', 3: 'nextWeapon', 1: 'item', 9: 'pause', 11: 'recenter' }

export interface PadState {
  angle: number // -1..1: positivo sube el ángulo (a la izquierda)
  power: number // -1..1: positivo sube la potencia
  move: -1 | 0 | 1
  pan: number // -1..1: paneo de la cámara (positivo a la derecha)
  fine: boolean // ajuste fino mantenido: angle y power van a 1/5 de velocidad
  // pasos sueltos (ya en grados / puntos de potencia, sin escalar): toque corto de los botones táctiles
  stepAngle: number
  stepPower: number
  pressed: Set<PadAction>
}

// Fuera de la zona muerta, 0..1 con curva cuadrática: más precisión cerca del centro.
function stick(v: number): number {
  const a = Math.abs(v)
  if (a <= DEAD) return 0
  const m = Math.min(1, (a - DEAD) / (1 - DEAD))
  return Math.sign(v) * m * m
}

export class Gamepad {
  private prev = new Set<number>()
  private hold = true

  // Ignora lo que ya está apretado hasta que se suelte (al cerrar un cartel con A, por ejemplo).
  suppress(): void {
    this.hold = true
  }

  poll(): PadState {
    const state: PadState = { angle: 0, power: 0, move: 0, pan: 0, fine: false, stepAngle: 0, stepPower: 0, pressed: new Set() }
    const now = new Set<number>()
    let pads: (globalThis.Gamepad | null)[] = []
    try {
      pads = navigator.getGamepads?.() ?? []
    } catch {
      pads = []
    }
    for (const pad of pads) {
      if (!pad) continue
      const b = (i: number) => pad.buttons[i]?.value ?? 0
      pad.buttons.forEach((btn, i) => btn.pressed && now.add(i))
      const ax = pad.axes[0] ?? 0
      const ay = pad.axes[1] ?? 0
      state.angle += -stick(ax) + b(14) - b(15)
      state.power += -stick(ay) + b(12) - b(13)
      if (b(10) > 0.5 || b(8) > 0.5) state.fine = true
      const rx = pad.axes[2] ?? 0
      if (Math.abs(rx) > DEAD) state.pan += (rx - Math.sign(rx) * DEAD) / (1 - DEAD)
      const left = Math.max(b(4), b(6))
      const right = Math.max(b(5), b(7))
      if (left > 0.4 && right <= 0.4) state.move = -1
      else if (right > 0.4 && left <= 0.4) state.move = 1
    }
    state.angle = Math.max(-1, Math.min(1, state.angle))
    state.power = Math.max(-1, Math.min(1, state.power))
    state.pan = Math.max(-1, Math.min(1, state.pan))
    if (this.hold) {
      // espera a que se suelten los botones de acción
      if (![...now].some((i) => i in BUTTON_ACTION)) this.hold = false
    } else {
      for (const i of now) if (!this.prev.has(i) && BUTTON_ACTION[i]) state.pressed.add(BUTTON_ACTION[i])
    }
    this.prev = now
    return state
  }
}
