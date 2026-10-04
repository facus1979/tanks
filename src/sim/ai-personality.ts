// v3 personalidades de la IA. Una capa de decisión sobre chooseShot (ai.ts): no busca tiros por su cuenta,
// ajusta a quién le tira (prioridades), cuánto le cuesta gastar cada munición, cuánto y cómo se mueve, qué
// valor le da a cosas que no son daño (botín, objetivos, empujar al peligro) y, la cavadora, cuándo se cubre
// o cava en vez de tirar. El error de puntería es el de la dificultad, igual para todas.
//
// - agresiva: le tira al más débil o al más cercano, gasta las armas fuertes desde el principio y se mueve
//   seguido para acercarse.
// - francotiradora: prefiere los rivales lejos (y los tiros largos), casi no se mueve y guarda la munición
//   especial para cuando rinde mucho.
// - cavadora: se cubre con Tierra o Muro (una loma o una pared entre ella y el rival más cercano) cuando no
//   tiene un buen tiro o está golpeada, y cava con la Excavadora hacia el rival cuando no le llega.
// - oportunista: busca combos (empujar al abismo o a la lava, barriles, botín, objetivos pagos) y le tira
//   al que va ganando.
// Sin personalidad (un humano que juega con la IA, por ejemplo) todo queda neutro: como antes de v3.
import { fly } from './ballistics'
import { columnGround } from './terrain'
import { hashSeed } from './rng'
import {
  BONUS,
  PERSONALITIES,
  PLAYER_HP,
  TANK_H,
  TANK_HALF_W,
  type GameEvent,
  type GameState,
  type Personality,
  type Player,
  type WeaponId,
} from './types'

// Personalidad de la IA del casillero i: la pedida o, si falta, sorteada con la seed de la partida.
export const PERSONALITY_SALT = 0x5e7a11
export function personalityFor(seed: number, i: number, given?: Personality): Personality {
  if (given && PERSONALITIES.includes(given)) return given
  return PERSONALITIES[hashSeed(seed ^ PERSONALITY_SALT ^ Math.imul(i + 1, 0x9e3779b1)) % PERSONALITIES.length]
}

export interface Traits {
  cost: number // multiplica el costo de la munición especial (COST de ai.ts)
  costOf?: Partial<Record<WeaponId, number>> // por arma, encima de cost
  wander: number // probabilidad de probar moverse aunque tenga tiro
  steps: number[] // desplazamientos que prueba cuando se mueve sin necesidad
  moveCost: number // puntos de puntaje por px de movimiento
  hazard: number // multiplica el valor de empujar a un rival hacia un abismo o la lava
  props: number // puntos de puntaje por cada $ de botín u objetivo que rompe el tiro
  far: number // puntos por px de distancia al rival dañado (tiros largos)
}

const NEUTRAL: Traits = { cost: 1, wander: 0.15, steps: [-20, 20], moveCost: 0, hazard: 1, props: 0.5, far: 0 }

export const TRAITS: Record<Personality, Traits> = {
  aggressive: { cost: 0.35, wander: 0.35, steps: [-40, -20, 20, 40], moveCost: 0, hazard: 1, props: 0.3, far: -0.15 },
  sniper: { cost: 1.7, costOf: { normal: 1 }, wander: 0.03, steps: [-20, 20], moveCost: 3, hazard: 1, props: 0.5, far: 0.25 },
  digger: { cost: 0.9, costOf: { digger: 0.4 }, wander: 0.1, steps: [-20, 20], moveCost: 0.5, hazard: 1, props: 0.5, far: 0 },
  opportunist: { cost: 0.8, wander: 0.15, steps: [-30, -15, 15, 30], moveCost: 0, hazard: 2.2, props: 2.5, far: 0 },
}

export function traitsOf(p: Player | undefined): Traits {
  return p?.kind !== 'human' && p?.personality ? TRAITS[p.personality] : NEUTRAL
}

// Prioridad de un rival (w: la de ai.ts, ~1-2). Solo cambia el orden entre rivales (con uno solo vale 1).
export function personalPriority(actor: Player, t: Player, targets: Player[], w: number, width: number): number {
  switch (actor.kind !== 'human' ? actor.personality : undefined) {
    case 'aggressive': {
      // el más débil y el más cercano
      const weak = 1 - Math.min(PLAYER_HP, t.hp + t.shield) / PLAYER_HP
      const near = Math.max(0, 1 - Math.abs(t.x - actor.x) / (width * 0.5))
      return w + 0.45 * weak + 0.3 * near
    }
    case 'sniper':
      // los de lejos
      return w + (0.4 * Math.abs(t.x - actor.x)) / width
    case 'opportunist': {
      // el que va ganando: más rondas, después más kills, después más vida
      const key = (p: Player) => p.roundsWon * 1000 + p.kills * 10 + (p.hp + p.shield) / 100
      const top = Math.max(...targets.map(key))
      return key(t) === top ? w + 0.35 : w
    }
    default:
      return w
  }
}

export function personalCost(actor: Player | undefined, id: WeaponId, base: number): number {
  if (base <= 0 || base >= 1e8) return base
  const tr = traitsOf(actor)
  return base * tr.cost * (tr.costOf?.[id] ?? 1)
}

// Puntos extra de un tiro simulado: botín y objetivos rotos (cualquier IA los valora un poco; la
// oportunista, mucho) y la distancia a los rivales dañados (francotiradora: tiros largos; agresiva: cortos).
export function personalScore(actor: Player, before: { hp: number; alive: boolean; x: number }[], after: Player[], events: GameEvent[]): number {
  const tr = traitsOf(actor)
  let score = 0
  const seen = new Set<number>()
  for (const e of events) {
    if (e.type !== 'prop' || !e.destroyed || (e.kind !== 'loot' && e.kind !== 'target') || seen.has(e.propId)) continue
    seen.add(e.propId)
    score += BONUS[e.kind] * tr.props
  }
  if (tr.far !== 0) {
    for (const p of after) {
      const b = before[p.id]
      if (p.id === actor.id || !b?.alive || p.hp >= b.hp) continue
      score += tr.far * Math.abs(b.x - before[actor.id].x)
    }
  }
  return score
}

// Puntos donde conviene que caiga un tiro aunque no dañe a nadie: el botín y los objetivos pagos (la búsqueda
// los agrega a lo que verifica con la simulación completa).
export function propAims(state: GameState): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const p of state.props) if (p.alive && (p.kind === 'loot' || p.kind === 'target')) out.push({ x: p.x + p.w / 2, y: p.y + p.h / 2 })
  return out
}

// ---------- cavadora ----------

// Distancia del montículo o muro de cobertura hacia el rival más cercano, y cuánto más alto que la
// torreta tiene que estar el terreno de adelante para contar como cubierta.
const COVER_D = 42
const COVER_SPAN = 26
const COVER_H = 14
// La cavadora se cubre si su mejor tiro no llega a esto (puntaje de ai.ts: 1000 + 10 por punto de daño) o
// si tiene la vida por debajo de COVER_HP; cava hacia el rival si no tiene ningún tiro con daño.
const COVER_SCORE = 1250
const COVER_HP = 60
const COVER_CHANCE = 0.6

export interface PersonalPlan {
  angle: number
  power: number
  weapon: WeaponId
}

// La cavadora: ¿ya tiene una loma o pared entre ella y el rival (del lado del rival, más alta que su torreta)?
export function covered(state: GameState, actor: Player, dir: -1 | 1): boolean {
  const t = state.terrain
  for (let d = TANK_HALF_W + 4; d <= TANK_HALF_W + 4 + COVER_SPAN + COVER_D; d += 2) {
    const g = columnGround(t, Math.round(actor.x + dir * d))
    if (g < actor.y - TANK_H - COVER_H + 10) return true
  }
  return false
}

// Plan propio de la cavadora, o null para seguir con el de ai.ts. best: el puntaje del mejor tiro.
export function diggerPlan(state: GameState, actor: Player, targets: Player[], bestScore: number, rand: () => number): PersonalPlan | null {
  if (actor.personality !== 'digger' || actor.kind === 'human' || targets.length === 0) return null
  let near = targets[0]
  for (const t of targets) if (Math.abs(t.x - actor.x) < Math.abs(near.x - actor.x)) near = t
  const dir: -1 | 1 = near.x > actor.x ? 1 : -1
  // sin tiro que dañe: cava hacia el rival, en diagonal hacia abajo (el túnel lo acerca por debajo)
  if (bestScore < 1000 && actor.ammo.digger > 0 && rand() < 0.7) return { angle: dir > 0 ? 18 : 162, power: 38, weapon: 'digger' }
  const weak = bestScore < COVER_SCORE || actor.hp + actor.shield <= COVER_HP
  if (!weak || rand() >= COVER_CHANCE || covered(state, actor, dir)) return null
  const weapon: WeaponId | null = actor.ammo.wall > 0 ? 'wall' : actor.ammo.dirt > 0 ? 'dirt' : null
  if (!weapon) return null
  // el tiro que cae más cerca de COVER_D px adelante, sobre el piso
  const tx = actor.x + dir * (TANK_HALF_W + COVER_D)
  const ty = columnGround(state.terrain, Math.round(tx))
  let bestShot: PersonalPlan | null = null
  let bestD = 14
  for (let a = 20; a <= 80; a += 4) {
    const angle = dir > 0 ? a : 180 - a
    for (let power = 14; power <= 60; power += 2) {
      const f = fly({ terrain: state.terrain, players: state.players, props: state.props, ownerId: actor.id, angle, power, wind: state.wind, lava: state.lava ?? undefined, lavaSolid: true })
      if (f.impact.kind === 'out') continue
      const d = Math.abs(f.impact.x - tx) + Math.abs(f.impact.y - ty) * 0.5
      if (d < bestD) {
        bestD = d
        bestShot = { angle, power, weapon }
      }
    }
  }
  return bestShot
}
