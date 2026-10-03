// Inclinación de reposo del tanque. El sim apoya el tanque como una caja derecha sobre el punto más alto
// del piso bajo sus orugas (Player.y); para dibujarlo y para sacar el tiro de la boca del cañón dibujado,
// el casco gira sobre el borde de apoyo más cercano al centro hasta que el otro lado toca el piso.
// La comparten el sim (muzzle) y el render (actors), así el proyectil sale siempre del cañón que se ve.
import { isSolid } from './terrain'
import { TANK_W, type Terrain } from './types'

// Hasta 75°, la pendiente más empinada que el tanque puede subir. TILT_REACH alcanza para que, con esa
// inclinación, el borde opuesto del casco (27 px más allá) encuentre el piso.
export const MAX_TILT = (75 * Math.PI) / 180
const TILT_REACH = Math.ceil((TANK_W - 1) * Math.tan(MAX_TILT)) + 2

export interface Tilt {
  angle: number // rad; positivo = gira en sentido horario en pantalla (y hacia abajo): baja el lado derecho
  x: number // x de mundo del punto de apoyo sobre el que gira (a la altura del piso del tanque)
}

// null si el apoyo abarca el centro del casco (queda derecho). x y floor como Player.x y Player.y.
export function tankTilt(t: Terrain, x: number, floor: number): Tilt | null {
  const x0 = Math.round(x) - TANK_W / 2
  const fy = Math.round(floor)
  const g: number[] = []
  for (let i = 0; i < TANK_W; i++) {
    let y = fy + TILT_REACH
    for (let yy = fy - 2; yy < fy + TILT_REACH; yy++) {
      if (isSolid(t, x0 + i, yy)) {
        y = Math.max(fy, yy)
        break
      }
    }
    g.push(y)
  }
  const first = g.indexOf(fy)
  const last = g.lastIndexOf(fy)
  if (first < 0) return null
  const mid = (TANK_W - 1) / 2
  if (first <= mid && last >= mid) return null
  let best = MAX_TILT
  if (last < mid) {
    for (let i = last + 1; i < TANK_W; i++) best = Math.min(best, Math.atan2(g[i] - fy, i - last))
    return best > 0.02 ? { angle: best, x: x0 + last + 1 } : null
  }
  for (let i = first - 1; i >= 0; i--) best = Math.min(best, Math.atan2(g[i] - fy, first - i))
  return best > 0.02 ? { angle: -best, x: x0 + first } : null
}
