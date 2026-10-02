// Paneo de la cámara con el mouse (v2): puntero contra el borde izquierdo / derecho de la pantalla
// (solo con puntero fino) y arrastre del mundo con el botón del medio, o con el izquierdo fuera del
// tanque y de la barra de armas (lo decide `blocked`, que arma main.ts con el HUD y el renderer).

// Margen del borde que panea, en pixels de la ventana (o el 1,5% del ancho del juego, el mayor).
const EDGE_PX = 10
// Pixels que hay que mover con el botón apretado para que cuente como arrastre y no como click.
const DRAG_SLOP = 4

export class MousePan {
  active = false
  // true: un click izquierdo en ese punto es de otra cosa (tanque, barra de armas, minimapa).
  blocked: (e: PointerEvent) => boolean = () => false
  private fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
  private x = 0
  private y = 0
  private inside = false
  private drag: { id: number; x0: number; last: number; on: boolean } | null = null
  private dx = 0

  constructor(private stage: HTMLElement) {
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return
      this.x = e.clientX
      this.y = e.clientY
      this.inside = true
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      if (!d.on && Math.abs(e.clientX - d.x0) >= DRAG_SLOP) d.on = true
      if (d.on) this.dx += e.clientX - d.last
      d.last = e.clientX
    })
    // el puntero salió de la ventana: no seguir paneando contra el borde
    document.documentElement.addEventListener('pointerleave', () => (this.inside = false))
    window.addEventListener('blur', () => {
      this.inside = false
      this.drag = null
    })
    stage.addEventListener('pointerdown', (e) => {
      if (!this.active || e.pointerType !== 'mouse') return
      if (e.button !== 1 && (e.button !== 0 || this.blocked(e))) return
      if (e.button === 1) e.preventDefault()
      this.drag = { id: e.pointerId, x0: e.clientX, last: e.clientX, on: e.button === 1 }
    })
    // sin el autoscroll del botón del medio
    stage.addEventListener('mousedown', (e) => {
      if (this.active && e.button === 1) e.preventDefault()
    })
    const end = (e: PointerEvent): void => {
      if (this.drag?.id === e.pointerId) this.drag = null
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  get dragging(): boolean {
    return !!this.drag?.on
  }

  // Arrastre desde la última llamada, en pixels de la ventana (positivo: el mouse fue a la derecha).
  pollDrag(): number {
    const dx = this.dx
    this.dx = 0
    return dx
  }

  // -1 / 1 con el puntero contra el borde izquierdo / derecho del juego; 0 si no.
  edge(): number {
    if (!this.active || !this.fine || !this.inside || this.drag) return 0
    const canvas = this.stage.querySelector('canvas')
    const r = (canvas ?? this.stage).getBoundingClientRect()
    if (r.width <= 0 || this.y < r.top || this.y > r.bottom) return 0
    const m = Math.max(EDGE_PX, r.width * 0.015)
    if (this.x <= r.left + m) return -1
    if (this.x >= r.right - m) return 1
    return 0
  }

  // Fuera de la partida o con un cartel encima: suelta el arrastre.
  cancel(): void {
    this.drag = null
    this.dx = 0
  }
}
