import { isSolid } from './terrain'
import {
  BARREL_LEN,
  GRAVITY,
  MAX_FLIGHT,
  PIVOT_X,
  PIVOT_Y,
  POWER_SCALE,
  SUBSTEP,
  TANK_H,
  TANK_HALF_W,
  WIND_ACCEL,
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
}

function inTank(p: Player, x: number, y: number): boolean {
  return x >= p.x - TANK_HALF_W && x <= p.x + TANK_HALF_W && y >= p.y - TANK_H && y <= p.y
}

export function fly(opts: FlyOptions): FlightResult {
  const { terrain, players, ownerId } = opts
  const owner = players.find((p) => p.id === ownerId)
  const origin = opts.origin ?? (owner ? muzzle(owner.x, owner.y, opts.angle) : { x: 0, y: 0 })
  const rad = (opts.angle * Math.PI) / 180
  const speed = opts.power * POWER_SCALE
  let x = origin.x
  let y = origin.y
  let vx = opts.velocity ? opts.velocity.x : Math.cos(rad) * speed
  let vy = opts.velocity ? opts.velocity.y : -Math.sin(rad) * speed
  const ax = opts.wind * WIND_ACCEL
  const path: Vec2[] = [{ x, y }]
  const tanks = opts.ignoreTanks ? [] : players.filter((p) => p.alive)
  const solidProps = (opts.props ?? []).filter((p) => p.alive && (p.kind === 'barrel' || p.kind === 'crate'))
  // el propio tanque solo cuenta cuando el proyectil ya salió de su caja
  let armed = !owner || !inTank(owner, x, y)
  let elapsed = 0
  let n = 0

  // el primer tramo, del pivote a la boca, también puede chocar (cañón metido en una pared)
  if (isSolid(terrain, x, y)) {
    return { path, impact: { kind: 'terrain', x, y }, time: 0, vel: { x: vx, y: vy } }
  }

  while (elapsed < MAX_FLIGHT) {
    const px = x
    const py = y
    vx += ax * SUBSTEP
    const rising = vy < 0
    vy += GRAVITY * SUBSTEP
    x += vx * SUBSTEP
    y += vy * SUBSTEP
    elapsed += SUBSTEP
    n++

    const dist = Math.hypot(x - px, y - py)
    const steps = Math.max(1, Math.ceil(dist))
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      const sx = px + (x - px) * f
      const sy = py + (y - py) * f
      const t = elapsed - SUBSTEP * (1 - f)
      if (owner && !armed && !inTank(owner, sx, sy)) armed = true
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
    if (x < -OUT_MARGIN || x > terrain.w + OUT_MARGIN) {
      path.push({ x, y })
      return { path, impact: { kind: 'out', x, y }, time: elapsed, vel: { x: vx, y: vy } }
    }
  }
  path.push({ x, y })
  return { path, impact: { kind: 'out', x, y }, time: elapsed, vel: { x: vx, y: vy } }
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
