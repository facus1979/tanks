// Resolución de un disparo según el arma: racimo, napalm, excavadora, rodadora y el resto.
import { PATH_DT, fly, type FlightResult } from './ballistics'
import { blastFor, hurt, resolveBlast } from './physics'
import { columnGround, deform, isSolid } from './terrain'
import {
  AIR,
  MATERIALS,
  SUBSTEP,
  TANK_H,
  TANK_HALF_W,
  WEAPONS,
  physicsFor,
  type Flight,
  type GameEvent,
  type GameState,
  type Player,
  type Vec2,
  type WeaponId,
} from './types'

export const CLUSTER_SPREAD = 26 // px/s de separación horizontal entre bombitas
export const NAPALM_SPREAD = 40 // px que corre el fuego hacia cada lado
export const NAPALM_DPS = 6 // daño por segundo de fuego (WEAPONS.napalm.burn segundos)
export const NAPALM_CHAR = 12 // radio que quema material inflamable alrededor del fuego
export const DIG_LENGTH = 80
export const DIG_RADIUS = 6
export const ROLL_MAX_T = 6
const ROLL_R = 3 // radio de la bola

export interface ShotOutcome {
  flights: Flight[]
  events: GameEvent[]
}

function toFlight(f: FlightResult, startT: number): Flight {
  return { path: f.path, impact: f.impact, startT }
}

export function resolveShot(state: GameState, shooter: Player, weapon: WeaponId): ShotOutcome {
  const w = WEAPONS[weapon]
  const base = {
    terrain: state.terrain,
    players: state.players,
    props: state.props,
    ownerId: shooter.id,
    angle: shooter.angle,
    power: shooter.power,
    wind: state.wind,
  }
  if (w.split) return cluster(state, shooter, weapon, fly({ ...base, stopAtApex: true }))
  const flight = fly(base)
  const flights = [toFlight(flight, 0)]
  if (flight.impact.kind === 'out') return { flights, events: [] }
  const { x, y, tankId } = flight.impact
  if (w.rolls && flight.impact.kind === 'terrain') return roll(state, shooter, weapon, flight, flights)
  const blast = blastFor(weapon, x, y, flight.time, tankId)
  if (w.terrain === 'dig') return { flights, events: resolveBlast(state, blast, (ev) => tunnel(state, flight, ev)) }
  if (w.burn) return { flights, events: resolveBlast(state, blast, (ev) => napalm(state, x, y, flight.time, w.burn!, ev)) }
  return { flights, events: resolveBlast(state, blast) }
}

// ---------- racimo ----------

function cluster(state: GameState, shooter: Player, weapon: WeaponId, main: FlightResult): ShotOutcome {
  const w = WEAPONS[weapon]
  const flights = [toFlight(main, 0)]
  if (!main.apex) {
    if (main.impact.kind === 'out') return { flights, events: [] }
    const b = blastFor(weapon, main.impact.x, main.impact.y, main.time, main.impact.tankId)
    return { flights, events: resolveBlast(state, b) }
  }
  const n = w.split ?? 1
  const origin: Vec2 = { x: main.impact.x, y: main.impact.y }
  const bombs: FlightResult[] = []
  for (let i = 0; i < n; i++) {
    const k = i - (n - 1) / 2
    bombs.push(
      fly({
        terrain: state.terrain,
        players: state.players,
        props: state.props,
        ownerId: shooter.id,
        angle: 0,
        power: 0,
        wind: state.wind,
        origin,
        velocity: { x: main.vel.x + k * CLUSTER_SPREAD, y: -18 + Math.abs(k) * 6 },
      }),
    )
  }
  const order = bombs.map((_, i) => i).sort((a, b) => bombs[a].time - bombs[b].time || a - b)
  const events: GameEvent[] = []
  for (const i of order) {
    const f = bombs[i]
    flights.push(toFlight(f, main.time))
    if (f.impact.kind === 'out') continue
    const tankId = f.impact.tankId !== undefined && state.players[f.impact.tankId]?.alive ? f.impact.tankId : undefined
    events.push(...resolveBlast(state, blastFor(weapon, f.impact.x, f.impact.y, main.time + f.time, tankId)))
  }
  return { flights, events }
}

// ---------- excavadora ----------

function tunnel(state: GameState, flight: FlightResult, events: GameEvent[]): void {
  const len = Math.hypot(flight.vel.x, flight.vel.y) || 1
  const dx = flight.vel.x / len
  const dy = flight.vel.y / len
  const impact = events[0]
  if (impact.type !== 'impact') return
  for (let d = 0; d <= DIG_LENGTH; d += 2) {
    const debris = deform(state.terrain, flight.impact.x + dx * d, flight.impact.y + dy * d, DIG_RADIUS, 'dig')
    for (const k in debris) {
      const m = Number(k)
      impact.debris[m] = (impact.debris[m] ?? 0) + (debris[m] ?? 0)
    }
  }
}

// ---------- napalm ----------

function surfaceFrom(state: GameState, x: number, y: number): number {
  return columnGround(state.terrain, x, y)
}

function napalm(state: GameState, ix: number, iy: number, t0: number, seconds: number, events: GameEvent[]): void {
  const t = state.terrain
  const cx = Math.round(ix)
  const start = surfaceFrom(state, cx, Math.floor(iy) - 8)
  const burning: Vec2[] = [{ x: cx, y: start }]
  for (const dir of [-1, 1]) {
    let y = start
    let budget = NAPALM_SPREAD
    for (let x = cx + dir; budget > 0 && x >= 0 && x < t.w; x += dir) {
      if (isSolid(t, x, y - 6)) break // pared: el fuego no sube
      const g = surfaceFrom(state, x, y - 5)
      if (g >= t.h) break
      budget -= 1 + Math.max(0, y - g) // cuesta arriba se agota antes; cuesta abajo corre
      y = g
      burning.push({ x, y })
    }
  }
  burning.sort((a, b) => a.x - b.x)

  // quema lo inflamable alrededor del fuego; el back queda (el render lo dibuja chamuscado)
  const r = NAPALM_CHAR
  for (let i = 0; i < burning.length; i += 3) {
    const p = burning[i]
    for (let y = p.y - r; y <= p.y + r; y++) {
      if (y < 0 || y >= t.h) continue
      for (let x = p.x - r; x <= p.x + r; x++) {
        if (x < 0 || x >= t.w || (x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue
        const idx = y * t.w + x
        const m = t.front[idx]
        if (m !== AIR && MATERIALS[m]?.flammable) t.front[idx] = AIR
      }
    }
  }

  // eventos 'burn' por tramos de 10 px, con el fuego avanzando desde el impacto
  for (let i = 0; i < burning.length; i += 10) {
    const seg = burning.slice(i, i + 10)
    const mid = seg[Math.floor(seg.length / 2)]
    events.push({ type: 'burn', x: seg[0].x, y: mid.y, w: seg.length, t: t0 + Math.abs(mid.x - cx) / 90 })
  }

  const x0 = burning[0].x
  const x1 = burning[burning.length - 1].x
  for (const p of state.players) {
    if (!p.alive || p.x + TANK_HALF_W < x0 || p.x - TANK_HALF_W > x1) continue
    const near = burning.some((b) => Math.abs(b.x - p.x) <= TANK_HALF_W && b.y >= p.y - TANK_H - 4 && b.y <= p.y + 6)
    if (!near) continue
    const mark = events.length
    hurt(p, NAPALM_DPS * seconds, events)
    for (let i = mark; i < events.length; i++) {
      const e = events[i]
      if (e.type === 'damage' || e.type === 'death' || e.type === 'shield') e.t = t0 + 0.4
    }
  }
  for (const prop of state.props) {
    if (!prop.alive || prop.kind !== 'crate') continue
    if (prop.x + prop.w < x0 || prop.x > x1) continue
    prop.alive = false
    events.push({ type: 'prop', propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true, t: t0 + 0.3 })
  }
}

// ---------- rodadora ----------

function tankAt(state: GameState, x: number, y: number): Player | undefined {
  return state.players.find(
    (p) => p.alive && x >= p.x - TANK_HALF_W && x <= p.x + TANK_HALF_W && y >= p.y - TANK_H && y <= p.y,
  )
}

function roll(state: GameState, shooter: Player, weapon: WeaponId, flight: FlightResult, flights: Flight[]): ShotOutcome {
  const t = state.terrain
  const gravity = physicsFor(t.w).gravity
  let x = flight.impact.x
  let y = surfaceFrom(state, Math.round(x), Math.floor(flight.impact.y) - 6) - ROLL_R
  const slopeAt = (px: number) => surfaceFrom(state, Math.round(px) + 2, y - 6) - surfaceFrom(state, Math.round(px) - 2, y - 6)
  let vx = flight.vel.x * 0.35
  if (Math.abs(vx) < 20) vx = slopeAt(x) !== 0 ? Math.sign(slopeAt(x)) * 20 : Math.sign(flight.vel.x || 1) * 20
  let vy = 0
  let air = false
  let time = 0
  let still = 0
  let n = 0
  let hit: Player | undefined
  const path: Vec2[] = [{ x, y }]
  while (time < ROLL_MAX_T) {
    time += SUBSTEP
    n++
    if (!air) {
      const s = slopeAt(x) / 4 // >0: baja hacia la derecha
      vx += (gravity * 0.9 * s) / Math.sqrt(1 + s * s) * SUBSTEP
      const fr = 70 * SUBSTEP
      vx = Math.abs(vx) <= fr ? 0 : vx - Math.sign(vx) * fr
      const nx = x + vx * SUBSTEP
      const g = surfaceFrom(state, Math.round(nx), y - 6)
      if (isSolid(t, nx, y - 6) || g < y + ROLL_R - 5) break // pared
      x = nx
      if (g > y + ROLL_R + 2) air = true
      else y = g - ROLL_R
      still = Math.abs(vx) < 4 ? still + SUBSTEP : 0
      if (still > 0.25) break
    } else {
      vy += gravity * SUBSTEP
      x += vx * SUBSTEP
      y += vy * SUBSTEP
      if (isSolid(t, x, y + ROLL_R)) {
        y = surfaceFrom(state, Math.round(x), y - 6) - ROLL_R
        vy = 0
        air = false
      }
    }
    if (x < -20 || x > t.w + 20 || y > t.h) {
      path.push({ x, y })
      flights.push({ path, impact: { kind: 'out', x, y }, startT: flight.time })
      return { flights, events: [] }
    }
    hit = tankAt(state, x, y)
    if (hit && (hit.id !== shooter.id || time > 0.3)) break
    hit = undefined
    if (n % 4 === 0) path.push({ x, y })
  }
  path.push({ x, y })
  flights.push({
    path,
    impact: hit ? { kind: 'tank', x, y, tankId: hit.id } : { kind: 'terrain', x, y },
    startT: flight.time,
  })
  const endT = flight.time + (path.length - 1) * PATH_DT
  return { flights, events: resolveBlast(state, blastFor(weapon, x, y, endT, hit?.id)) }
}
