// v3 misil teledirigido: vuelo balístico hasta el apogeo; desde ahí el que disparó lo dirige con 'steer'.
//
// Reglas (ver STEER_* y GUIDE_TIME en types.ts):
// - El guiado dura GUIDE_TICKS ticks de STEER_TICK s (1,5 s = 30 ticks). Cada tick lleva una corrección
//   d ∈ {-1, 0, 1}: durante ese tick la velocidad gira d · STEER_RATE rad/s (1 = horario en pantalla) sin
//   cambiar de módulo. La gravedad y el viento siguen actuando como en cualquier vuelo.
// - Temblor: además, cada tick gira wobbleAt(seed, tick) · STEER_WOBBLE rad/s. Es ruido suave (nudos cada
//   WOBBLE_KNOT ticks, interpolados) derivado de GuidedState.seed: determinista, pero nadie lo ve venir (la IA
//   planifica sin él). Por eso nunca es un tiro seguro.
// - Si choca durante el guiado, explota ahí. Si se acaba el guiado, cae libre (sin giro ni temblor).
// - Todo con subpasos enteros (SUBSTEP = 1/240: 12 por tick; GuidedState.t también va en esa grilla), así el
//   resultado no depende de en cuántas tandas lleguen los 'steer': [a] y después [b] da el mismo estado que [a, b].
import { fly, type FlightResult, type FlyOptions } from './ballistics'
import { hash2, hashSeed } from './rng'
import { GUIDE_TIME, STEER_RATE, STEER_TICK, STEER_WOBBLE, SUBSTEP, type GameState, type GuidedState, type Player } from './types'

export const GUIDE_TICKS = Math.round(GUIDE_TIME / STEER_TICK)
export const TICK_STEPS = Math.round(STEER_TICK / SUBSTEP) // 12
const WOBBLE_KNOT = 5 // ticks entre nudos del ruido del temblor (0,25 s)

// Seed del temblor: del estado al disparar (rng, turno, tirador). No consume el rng.
export function guidedSeed(state: GameState, shooter: Player): number {
  return hashSeed(state.rng ^ Math.imul(state.turn + 1, 0x2c1b3c6d) ^ Math.imul(shooter.id + 1, 0x297a2d39))
}

// Temblor del tick (en [-1, 1]): ruido de valores con interpolación suave entre nudos.
export function wobbleAt(seed: number, tick: number): number {
  const i = Math.floor(tick / WOBBLE_KNOT)
  const f = (tick - i * WOBBLE_KNOT) / WOBBLE_KNOT
  const u = f * f * (3 - 2 * f)
  const a = hash2(i, 7, seed | 0) * 2 - 1
  const b = hash2(i + 1, 7, seed | 0) * 2 - 1
  return a * (1 - u) + b * u
}

// Ticks de guiado que le quedan.
export function ticksLeft(g: GuidedState): number {
  return Math.max(0, Math.round(g.guide / STEER_TICK))
}

function baseOpts(state: GameState, g: GuidedState): FlyOptions {
  return {
    terrain: state.terrain,
    players: state.players,
    props: state.props,
    ownerId: g.ownerId,
    angle: 0,
    power: 0,
    wind: state.wind,
    origin: { x: g.x, y: g.y },
    velocity: { x: g.vx, y: g.vy },
    lava: state.lava ?? undefined,
  }
}

export interface SteerResult {
  flight: FlightResult // el tramo (time relativo al comienzo del tramo; startT = g.t)
  guided: GuidedState // el estado al final del tramo (si chocó, donde chocó)
  hit: boolean // chocó (o se fue del mapa, o se derritió) durante el tramo
}

// Avanza dirs.length ticks (a lo sumo los que quedan). wobble = false: el modelo sin temblor de la IA.
export function steerGuided(state: GameState, g: GuidedState, dirs: readonly number[], wobble = true): SteerResult {
  const n = Math.min(dirs.length, ticksLeft(g))
  const tick0 = GUIDE_TICKS - ticksLeft(g)
  const flight = fly({
    ...baseOpts(state, g),
    untilSteps: n * TICK_STEPS,
    turn: (step) => {
      const k = Math.floor(step / TICK_STEPS)
      const d = dirs[k] === 1 ? 1 : dirs[k] === -1 ? -1 : 0
      return d * STEER_RATE + (wobble ? wobbleAt(g.seed, tick0 + k) * STEER_WOBBLE : 0)
    },
  })
  const hit = !flight.paused
  const end = flight.path[flight.path.length - 1]
  const used = hit ? Math.min(n, Math.ceil(flight.time / STEER_TICK - 1e-9)) : n
  return {
    flight,
    hit,
    guided: {
      ...g,
      x: hit ? flight.impact.x : end.x,
      y: hit ? flight.impact.y : end.y,
      vx: flight.vel.x,
      vy: flight.vel.y,
      // t en la grilla de subpasos (enteros): partir una tanda en dos da exactamente el mismo estado
      t: (Math.round(g.t / SUBSTEP) + (hit ? Math.round(flight.time / SUBSTEP) : n * TICK_STEPS)) * SUBSTEP,
      guide: hit ? 0 : Math.max(0, (ticksLeft(g) - used) * STEER_TICK),
    },
  }
}

// Caída libre desde donde quedó el misil (se acabó el guiado).
// sky: línea de cielo (skylineOf) para acelerar las caídas que simula la IA; el resultado es el mismo.
export function fallGuided(state: GameState, g: GuidedState, sky?: Int16Array): FlightResult {
  return fly({ ...baseOpts(state, g), skyline: sky })
}

// Estado del guiado al llegar al apogeo.
export function startGuided(state: GameState, shooter: Player, apex: FlightResult, t: number): GuidedState {
  return {
    ownerId: shooter.id,
    x: apex.impact.x,
    y: apex.impact.y,
    vx: apex.vel.x,
    vy: apex.vel.y,
    t: Math.round(t / SUBSTEP) * SUBSTEP,
    guide: GUIDE_TICKS * STEER_TICK,
    seed: guidedSeed(state, shooter),
  }
}
