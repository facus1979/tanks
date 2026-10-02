import { columnGround, isSolid } from './terrain'
import {
  BARREL_LEN,
  MAX_FLIGHT,
  PIVOT_X,
  PIVOT_Y,
  SUBSTEP,
  TANK_H,
  TANK_HALF_W,
  physicsFor,
  type Flight,
  type Impact,
  type Player,
  type Prop,
  type Terrain,
  type Vec2,
} from './types'

const PATH_EVERY = 4
export const PATH_DT = SUBSTEP * PATH_EVERY
const OUT_MARGIN = 40

// Boca del cañón dibujado. ground es el piso del tanque (y hacia abajo).
export function muzzle(x: number, ground: number, angleDeg: number): Vec2 {
  const rad = (angleDeg * Math.PI) / 180
  const facing = angleDeg > 90 ? -1 : 1
  return {
    x: x + facing * PIVOT_X + Math.cos(rad) * BARREL_LEN,
    y: ground - PIVOT_Y - Math.sin(rad) * BARREL_LEN,
  }
}

export interface FlightResult extends Flight {
  time: number // segundos hasta el impacto
  vel: Vec2 // velocidad al terminar (impacto o apogeo)
  apex?: boolean // terminó en el apogeo (stopAtApex)
}

export interface FlyOptions {
  terrain: Terrain
  players: Player[]
  props?: Prop[]
  ownerId: number
  angle: number
  power: number
  wind: number
  ignoreTanks?: boolean
  origin?: Vec2
  velocity?: Vec2 // reemplaza ángulo y potencia (bombitas del racimo)
  stopAtApex?: boolean
  // Optimización para la IA (muchos vuelos sobre el mismo estado): por columna, la primera fila
  // donde algo puede frenar al proyectil (terreno, tanque o utilería). Ver skylineOf. El resultado
  // es idéntico con o sin esto; solo saltea los tramos de vuelo que van por arriba de todo.
  skyline?: Int16Array
  // v2 muerte súbita: y de la superficie de la lava (GameState.lava). El proyectil que llega a
  // y >= lava se derrite: termina con impacto 'lava' y no explota. Sin esto, no hay lava.
  lava?: number
}

// Por columna, la fila más alta con terreno, un tanque vivo o utilería sólida. Sirve mientras
// el estado no cambie (la IA la calcula una vez por búsqueda).
export function skylineOf(terrain: Terrain, players: Player[], props: Prop[] = []): Int16Array {
  const sky = new Int16Array(terrain.w)
  for (let x = 0; x < terrain.w; x++) sky[x] = columnGround(terrain, x)
  const lower = (x0: number, x1: number, top: number) => {
    for (let x = Math.max(0, x0); x <= Math.min(terrain.w - 1, x1); x++) if (top < sky[x]) sky[x] = top
  }
  for (const p of players) if (p.alive) lower(Math.floor(p.x - TANK_HALF_W), Math.floor(p.x + TANK_HALF_W), Math.floor(p.y - TANK_H))
  for (const p of props) if (p.alive && (p.kind === 'barrel' || p.kind === 'crate')) lower(Math.floor(p.x), Math.ceil(p.x + p.w), Math.floor(p.y))
  return sky
}

function inTank(p: Player, x: number, y: number): boolean {
  return x >= p.x - TANK_HALF_W && x <= p.x + TANK_HALF_W && y >= p.y - TANK_H && y <= p.y
}

export function fly(opts: FlyOptions): FlightResult {
  const { terrain, players, ownerId } = opts
  const owner = players.find((p) => p.id === ownerId)
  const origin = opts.origin ?? (owner ? muzzle(owner.x, owner.y, opts.angle) : { x: 0, y: 0 })
  const rad = (opts.angle * Math.PI) / 180
  // v2: gravedad, escala de potencia y viento dependen del ancho del mapa (con 800, los de v1)
  const phys = physicsFor(terrain.w)
  const speed = opts.power * phys.powerScale
  let x = origin.x
  let y = origin.y
  let vx = opts.velocity ? opts.velocity.x : Math.cos(rad) * speed
  let vy = opts.velocity ? opts.velocity.y : -Math.sin(rad) * speed
  const ax = opts.wind * phys.windAccel
  const gravity = phys.gravity
  const path: Vec2[] = [{ x, y }]
  const tanks = opts.ignoreTanks ? [] : players.filter((p) => p.alive)
  const solidProps = (opts.props ?? []).filter((p) => p.alive && (p.kind === 'barrel' || p.kind === 'crate'))
  // el propio tanque solo cuenta cuando el proyectil ya salió de su caja
  let armed = !owner || !inTank(owner, x, y)
  let elapsed = 0
  let n = 0
  const sky = opts.skyline?.length === terrain.w ? opts.skyline : undefined
  const lava = opts.lava ?? Infinity

  // el primer tramo, del pivote a la boca, también puede chocar (cañón metido en una pared)
  if (isSolid(terrain, x, y)) {
    return { path, impact: { kind: 'terrain', x, y }, time: 0, vel: { x: vx, y: vy } }
  }
  // tanque hundido en la lava hasta la boca: el proyectil se derrite al salir
  if (y >= lava) {
    return { path, impact: { kind: 'lava', x, y }, time: 0, vel: { x: vx, y: vy } }
  }

  while (elapsed < MAX_FLIGHT) {
    const px = x
    const py = y
    vx += ax * SUBSTEP
    const rising = vy < 0
    vy += gravity * SUBSTEP
    x += vx * SUBSTEP
    y += vy * SUBSTEP
    elapsed += SUBSTEP
    n++

    // el atajo del skyline no sabe de la lava: solo vale si el tramo entero va por arriba de ella
    if (sky && y < lava && clearAbove(sky, terrain, px, py, x, y)) {
      // todo el tramo va por arriba de lo que puede chocar (y afuera del propio tanque)
      if (owner) armed = true
    } else for (let i = 1, steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py))); i <= steps; i++) {
      const f = i / steps
      const sx = px + (x - px) * f
      const sy = py + (y - py) * f
      const t = elapsed - SUBSTEP * (1 - f)
      if (owner && !armed && !inTank(owner, sx, sy)) armed = true
      if (sy >= lava) {
        // tocó la superficie de la lava antes que cualquier otra cosa: se derrite
        path.push({ x: sx, y: sy })
        return { path, impact: { kind: 'lava', x: sx, y: sy }, time: t, vel: { x: vx, y: vy } }
      }
      const hit = hitAt(terrain, tanks, solidProps, ownerId, armed, sx, sy)
      if (hit) {
        path.push({ x: sx, y: sy })
        return { path, impact: hit, time: t, vel: { x: vx, y: vy } }
      }
    }
    if (opts.stopAtApex && rising && vy >= 0) {
      path.push({ x, y })
      return { path, impact: { kind: 'out', x, y }, time: elapsed, vel: { x: vx, y: vy }, apex: true }
    }
    if (n % PATH_EVERY === 0) path.push({ x, y })
    // v3: por un abismo el proyectil cae por debajo del mapa (en el resto, debajo es roca madre)
    if (x < -OUT_MARGIN || x > terrain.w + OUT_MARGIN || (y > terrain.h + OUT_MARGIN && x >= 0 && x < terrain.w)) {
      path.push({ x, y })
      return { path, impact: { kind: 'out', x, y }, time: elapsed, vel: { x: vx, y: vy } }
    }
  }
  path.push({ x, y })
  return { path, impact: { kind: 'out', x, y }, time: elapsed, vel: { x: vx, y: vy } }
}

// El segmento (ax, ay)-(bx, by) pasa entero por arriba de la línea de cielo.
function clearAbove(sky: Int16Array, terrain: Terrain, ax: number, ay: number, bx: number, by: number): boolean {
  const ymax = Math.max(ay, by)
  if (ymax >= terrain.h) return false
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)))
  const x1 = Math.min(terrain.w - 1, Math.floor(Math.max(ax, bx)))
  for (let x = x0; x <= x1; x++) if (ymax >= sky[x]) return false
  return true
}

function hitAt(
  terrain: Terrain,
  tanks: Player[],
  props: Prop[],
  ownerId: number,
  armed: boolean,
  x: number,
  y: number,
): Impact | null {
  for (const p of tanks) {
    if (p.id === ownerId && !armed) continue
    if (inTank(p, x, y)) return { kind: 'tank', x, y, tankId: p.id }
  }
  for (const p of props) {
    if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return { kind: 'prop', x, y, propId: p.id }
  }
  if (isSolid(terrain, x, y)) return { kind: 'terrain', x, y }
  return null
}
