// v3: IA de las armas e ítems nuevos (sim-armas). Funciones sin estado que usa ai.ts: plan de correcciones del
// teledirigido, tiros que caen en un punto (mina, muro), apuntado del láser y lugares para el jetpack y el
// teletransporte. Nada acá cambia el estado real.
import { fly, muzzle, skylineOf } from './ballistics'
import { fallGuided, startGuided, steerGuided, ticksLeft } from './guided'
import { tankDistance } from './physics'
import { SOLID } from './terrain'
import { tankTilt } from './tilt'
import { TANK_H, type Difficulty, type GameState, type GuidedState, type Player, type Vec2 } from './types'

export type SteerDir = -1 | 0 | 1

// ---------- teledirigido ----------

// Plan de correcciones (control predictivo, sin temblor: la IA no lo conoce). En cada tick prueba girar a un lado,
// al otro o nada durante STEER_HOLD ticks y después caer libre, y se queda con lo que deja el impacto más cerca
// del blanco (0 si pega en su caja). Devuelve un valor por tick que queda (GUIDE_TICKS desde el apogeo).
// sky: línea de cielo del estado (acelera las caídas simuladas).
export const STEER_HOLD = 4
export function planSteer(state: GameState, g: GuidedState, target: Player, sky?: Int16Array): SteerDir[] {
  const dirs: SteerDir[] = []
  let cur = g
  const ticks = ticksLeft(cur)
  const miss = (r: ReturnType<typeof steerGuided>): number => {
    const imp = r.hit ? r.flight.impact : fallGuided(state, r.guided, sky).impact
    if (imp.kind === 'tank' && imp.tankId === target.id) return 0
    if (imp.kind === 'out' || imp.kind === 'lava') return 1e6
    return 1 + tankDistance(target, imp.x, imp.y)
  }
  for (let k = 0; k < ticks; k++) {
    const hold = Math.min(STEER_HOLD, ticks - k)
    let best: SteerDir = 0
    let bestMiss = Infinity
    for (const d of [0, -1, 1] as SteerDir[]) {
      const m = miss(steerGuided(state, cur, new Array(hold).fill(d), false))
      if (m < bestMiss - 0.5) {
        bestMiss = m
        best = d
      }
    }
    // ya va derecho al blanco sin tocar nada: el resto en 0
    if (best === 0 && bestMiss === 0) break
    dirs.push(best)
    const r = steerGuided(state, cur, [best], false)
    if (r.hit) break
    cur = r.guided
  }
  while (dirs.length < ticks) dirs.push(0)
  return dirs
}

// Error de la IA al dirigir: cada tick, con esta probabilidad, toca otra cosa (al azar).
export const STEER_ERROR: Record<Difficulty, number> = { easy: 0.35, normal: 0.18, hard: 0.06 }
export function noisySteer(dirs: SteerDir[], difficulty: Difficulty, rand: () => number): SteerDir[] {
  const p = STEER_ERROR[difficulty]
  return dirs.map((d) => (rand() < p ? ((Math.floor(rand() * 3) - 1) as SteerDir) : d))
}

// El estado del teledirigido en el apogeo con el ángulo y la potencia del tirador (null si choca antes). Vuelo
// puro (sin deflector): no toca el estado.
export function apexOf(state: GameState, shooter: Player): GuidedState | null {
  const up = fly({ terrain: state.terrain, players: state.players, props: state.props, ownerId: shooter.id, angle: shooter.angle, power: shooter.power, wind: state.wind, lava: state.lava ?? undefined, stopAtApex: true })
  return up.apex ? startGuided(state, shooter, up, up.time) : null
}

// El rival al que va el teledirigido: el más cerca de donde caería sin guiar.
export function guidedTarget(state: GameState, g: GuidedState, targets: Player[], sky?: Int16Array): Player {
  const imp = fallGuided(state, g, sky).impact
  let best = targets[0]
  let bd = Infinity
  for (const t of targets) {
    const d = Math.abs(t.x - imp.x) + Math.abs(t.y - TANK_H / 2 - imp.y) * 0.5
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return best
}

// ---------- tiros que caen en un punto ----------

// El tiro (vuelo balístico normal) que cae más cerca de (x, y): grilla gruesa y refinamiento. d = distancia.
export function aimLanding(state: GameState, actor: Player, x: number, y: number): { angle: number; power: number; d: number } {
  const sky = skylineOf(state.terrain, state.players, state.props)
  let best = { angle: 90, power: 50, d: Infinity }
  const tryShot = (angle: number, power: number) => {
    const f = fly({ skyline: sky, terrain: state.terrain, players: state.players, props: state.props, ownerId: actor.id, angle, power, wind: state.wind, lava: state.lava ?? undefined })
    if (f.impact.kind === 'out' || f.impact.kind === 'lava') return
    const d = Math.hypot(f.impact.x - x, (f.impact.y - y) * 0.5)
    if (d < best.d) best = { angle, power, d }
  }
  const k = state.terrain.w / 800
  const right = x > actor.x
  const a0 = right ? 4 : 94
  for (let a = a0; a <= a0 + 82; a += 6) for (let p = k > 1 ? 8 : 14; p <= 100; p += 5) tryShot(a, p)
  for (let pass = 0; pass < 2 && best.d < 80; pass++) {
    const { angle: a1, power: p1 } = best
    const sa = pass === 0 ? 2 : 0.5
    const sp = pass === 0 ? 1.5 : 0.4
    for (let a = -2; a <= 2; a++) for (let p = -2; p <= 2; p++) tryShot(Math.max(0, Math.min(180, a1 + a * sa)), Math.max(5, Math.min(100, p1 + p * sp)))
  }
  return best
}

// ---------- láser ----------

// Ángulos del láser hacia un rival (el centro de su caja), con la boca del cañón del ángulo resultante.
export function laserAngles(state: GameState, actor: Player, t: Player): number[] {
  let a = t.x > actor.x ? 0 : 180
  for (let k = 0; k < 3; k++) {
    const m = muzzle(actor.x, actor.y, a, tankTilt(state.terrain, actor.x, actor.y))
    a = (Math.atan2(-(t.y - TANK_H / 2 - m.y), t.x - m.x) * 180) / Math.PI
    if (a < 0) a += 360
    if (a > 180) a = a > 270 ? 0 : 180
  }
  return [a, a - 1.5, a + 1.5].map((v) => Math.max(0, Math.min(180, Math.round(v * 10) / 10)))
}

// ---------- jetpack y teletransporte ----------

// Destinos a probar: el piso a esas distancias horizontales (dentro del rango), de cerca a lejos.
export function jumpSpots(state: GameState, actor: Player, offsets: number[], range: number): Vec2[] {
  const out: Vec2[] = []
  const t = state.terrain
  for (const dx of offsets) {
    const x = Math.round(actor.x + dx)
    if (x < 20 || x > t.w - 20) continue
    // la superficie más cercana en altura dentro del rango: de arriba hacia abajo, la primera con lugar
    for (let y = Math.max(TANK_H + 1, Math.round(actor.y - range)); y < t.h; y += 4) {
      let solid = false
      for (let ix = x - 10; ix <= x + 10 && !solid; ix += 4) solid = SOLID[t.front[y * t.w + ix]] === 1
      if (!solid) continue
      if (Math.hypot(dx, y - actor.y) <= range) out.push({ x, y })
      break
    }
  }
  return out
}
