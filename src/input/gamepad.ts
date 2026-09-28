// Gamepad en partida (mapa estándar). Las vistas (menú, tienda, tabla, cartel) leen el pad por su cuenta.
// Stick izquierdo o cruceta: ángulo (horizontal) y potencia (vertical). Gatillos o bumpers: mover.
// A dispara, X/Y arma anterior/siguiente, B usa un ítem, Start pausa.
export type PadAction = 'fire' | 'prevWeapon' | 'nextWeapon' | 'item' | 'pause'

const DEAD = 0.25
const BUTTON_ACTION: Record<number, PadAction> = { 0: 'fire', 2: 'prevWeapon', 3: 'nextWeapon', 1: 'item', 9: 'pause' }

export interface PadState {
  angle: number // -1..1: positivo sube el ángulo (a la izquierda)
  power: number // -1..1: positivo sube la potencia
  move: -1 | 0 | 1
  pressed: Set<PadAction>
}

export class Gamepad {
  private prev = new Set<number>()
  private hold = true

  // Ignora lo que ya está apretado hasta que se suelte (al cerrar un cartel con A, por ejemplo).
  suppress(): void {
    this.hold = true
  }

  poll(): PadState {
    const state: PadState = { angle: 0, power: 0, move: 0, pressed: new Set() }
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
      state.angle += (Math.abs(ax) > DEAD ? -ax : 0) + b(14) - b(15)
      state.power += (Math.abs(ay) > DEAD ? -ay : 0) + b(12) - b(13)
      const left = Math.max(b(4), b(6))
      const right = Math.max(b(5), b(7))
      if (left > 0.4 && right <= 0.4) state.move = -1
      else if (right > 0.4 && left <= 0.4) state.move = 1
    }
    state.angle = Math.max(-1, Math.min(1, state.angle))
    state.power = Math.max(-1, Math.min(1, state.power))
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
