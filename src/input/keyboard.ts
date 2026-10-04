// Teclado por código físico (KeyA, Digit1, Space...), así no depende del layout.
// v3: Tab (recorre las armas) tampoco mueve el foco del navegador mientras se juega.
const BLOCKED = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'Tab'])

export class Keyboard {
  capture = false
  private held = new Set<string>()
  private pressed = new Set<string>()

  constructor() {
    window.addEventListener('keydown', (e) => {
      const code = e.code || e.key
      if (this.capture && BLOCKED.has(code)) e.preventDefault()
      if (!this.held.has(code)) this.pressed.add(code)
      this.held.add(code)
    })
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code || e.key)
    })
    window.addEventListener('blur', () => {
      this.held.clear()
      this.pressed.clear()
    })
  }

  isDown(code: string): boolean {
    return this.held.has(code)
  }

  consumePressed(): Set<string> {
    const pressed = this.pressed
    this.pressed = new Set()
    return pressed
  }
}

// Índice 0-9 del arma elegida con 1-9 y 0 (v3: 9 y 0 son la novena y la décima del orden de WEAPON_ORDER), o -1.
export function weaponSlot(pressed: Set<string>): number {
  for (let i = 0; i < 10; i++) {
    const d = (i + 1) % 10
    if (pressed.has(`Digit${d}`) || pressed.has(`Numpad${d}`)) return i
  }
  return -1
}
