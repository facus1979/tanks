// v3: ayuda visual para elegir el destino del jetpack o del teletransporte. Un SVG encima del juego (no
// toca el renderer ni el contrato de RenderFrame): el círculo del alcance alrededor del tanque, la línea
// (teletransporte) o el arco del salto (jetpack) hasta el cursor y una mira en el destino.
// Las coordenadas son de mundo; toClient (lo arma main.ts con la cámara del renderer) las pasa a la ventana.
import type { Vec2 } from '../sim/types'

export interface TargetModel {
  item: 'jetpack' | 'teleport'
  from: Vec2
  to: Vec2
  range: number
}

const NS = 'http://www.w3.org/2000/svg'

export class TargetOverlay {
  private svg = document.createElementNS(NS, 'svg')
  private ring = document.createElementNS(NS, 'circle')
  private path = document.createElementNS(NS, 'path')
  private cross = document.createElementNS(NS, 'path')
  private dot = document.createElementNS(NS, 'circle')
  // punto de mundo → punto de la ventana (clientX/Y)
  toClient: ((p: Vec2) => Vec2) | null = null

  constructor() {
    Object.assign(this.svg.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '20',
      display: 'none',
    })
    for (const el of [this.ring, this.path]) {
      el.setAttribute('fill', 'none')
      el.setAttribute('stroke-dasharray', '6 5')
      el.setAttribute('stroke-width', '2')
    }
    this.ring.setAttribute('stroke', 'rgba(255,255,255,0.55)')
    this.path.setAttribute('stroke', 'rgba(255,230,120,0.9)')
    this.cross.setAttribute('fill', 'none')
    this.cross.setAttribute('stroke', '#ffe678')
    this.cross.setAttribute('stroke-width', '2')
    this.dot.setAttribute('fill', '#ffe678')
    this.svg.append(this.ring, this.path, this.cross, this.dot)
    document.getElementById('app')?.append(this.svg)
  }

  show(model: TargetModel | null): void {
    const map = this.toClient
    if (!model || !map) {
      this.svg.style.display = 'none'
      return
    }
    this.svg.style.display = 'block'
    const a = map(model.from)
    const b = map(model.to)
    // el radio en pixels de la ventana sale de mapear un punto a range de distancia
    const edge = map({ x: model.from.x + model.range, y: model.from.y })
    const r = Math.abs(edge.x - a.x)
    this.ring.setAttribute('cx', f(a.x))
    this.ring.setAttribute('cy', f(a.y))
    this.ring.setAttribute('r', f(r))
    if (model.item === 'jetpack') {
      // arco del salto: control por encima de los dos puntos
      const top = Math.min(a.y, b.y) - Math.max(24, Math.abs(b.x - a.x) * 0.35)
      this.path.setAttribute('d', `M${f(a.x)},${f(a.y)} Q${f((a.x + b.x) / 2)},${f(top)} ${f(b.x)},${f(b.y)}`)
    } else {
      this.path.setAttribute('d', `M${f(a.x)},${f(a.y)} L${f(b.x)},${f(b.y)}`)
    }
    const k = Math.max(7, r * 0.06)
    this.cross.setAttribute(
      'd',
      `M${f(b.x - k * 1.6)},${f(b.y)} L${f(b.x - k * 0.5)},${f(b.y)} M${f(b.x + k * 0.5)},${f(b.y)} L${f(b.x + k * 1.6)},${f(b.y)} ` +
        `M${f(b.x)},${f(b.y - k * 1.6)} L${f(b.x)},${f(b.y - k * 0.5)} M${f(b.x)},${f(b.y + k * 0.5)} L${f(b.x)},${f(b.y + k * 1.6)}`,
    )
    this.dot.setAttribute('cx', f(b.x))
    this.dot.setAttribute('cy', f(b.y))
    this.dot.setAttribute('r', '2.5')
  }
}

function f(n: number): string {
  return n.toFixed(1)
}
