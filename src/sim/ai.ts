import { fly, muzzle } from './ballistics'
import { applyCommand, cloneState } from './game'
import { blastDamage } from './physics'
import { Rng, hashSeed } from './rng'
import { NAPALM_DPS, NAPALM_SPREAD, resolveShot } from './weapons'
import {
  PLAYER_HP,
  REPAIR_HP,
  TANK_H,
  WEAPONS,
  WEAPON_ORDER,
  type Difficulty,
  type GameState,
  type ItemId,
  type Player,
  type WeaponId,
} from './types'

const ERROR: Record<Difficulty, { angle: number; power: number }> = {
  easy: { angle: 9, power: 12 },
  normal: { angle: 6, power: 7 },
  hard: { angle: 1, power: 1.5 },
}

// Cuánto "cuesta" gastar cada munición: la IA guarda lo especial para cuando rinde.
const COST: Record<WeaponId, number> = {
  normal: 0,
  heavy: 90,
  dirt: 1e9,
  cluster: 110,
  napalm: 60,
  digger: 400,
  roller: 60,
  nuke: 450,
}

// move: pixels a mover antes de apuntar (signo = dirección). Angle y power ya son para la
// posición nueva. La sesión manda |move| comandos 'move' y después apunta.
// items: ítems a usar antes de todo (un 'useItem' por cada uno, en orden).
export interface ShotPlan {
  angle: number
  power: number
  weapon: WeaponId
  move?: number
  items?: ItemId[]
}

// Umbrales de vida para reparar y para activar el escudo.
const ITEM_HP: Record<Difficulty, { repair: number; shield: number }> = {
  easy: { repair: 40, shield: 55 },
  normal: { repair: 60, shield: 80 },
  hard: { repair: PLAYER_HP - REPAIR_HP, shield: PLAYER_HP },
}

// Ítems que la IA usa este turno: reparación si está golpeada, escudo si conviene.
export function chooseItems(state: GameState, difficulty: Difficulty): ItemId[] {
  const actor = state.players[state.current]
  const th = ITEM_HP[difficulty]
  const items: ItemId[] = []
  if (actor.items.repair > 0 && actor.hp <= th.repair) items.push('repair')
  const rivals = state.players.filter((p) => p.alive && p.id !== actor.id).length
  // la difícil lo prende de entrada si hay más de un rival
  const threat = difficulty === 'hard' ? rivals >= 2 || actor.hp < PLAYER_HP : actor.hp <= th.shield
  if (actor.items.shield > 0 && actor.shield <= 0 && threat) items.push('shield')
  return items
}

interface Candidate {
  angle: number
  power: number
  weapon: WeaponId
  score: number
}

interface Search {
  best: Candidate
  blocked: number // fracción de tiros que chocan pegados al tanque
}

// La IA usa la misma física sobre copias del estado (sin modificarlo). random: si no se pasa,
// se deriva del estado, así la sim sigue siendo determinista.
export function chooseShot(state: GameState, difficulty: Difficulty, random?: () => number): ShotPlan {
  const actor = state.players[state.current]
  const rand = random ?? rngFor(state)
  const weapons = WEAPON_ORDER.filter((id) => actor.ammo[id] > 0 && WEAPONS[id].terrain !== 'build')
  const fallback = weapons[0] ?? WEAPON_ORDER.find((id) => actor.ammo[id] > 0) ?? 'normal'
  const targets = state.players.filter((p) => p.alive && p.id !== actor.id)
  const items = chooseItems(state, difficulty)
  const extra = items.length > 0 ? { items } : {}
  if (targets.length === 0 || weapons.length === 0) {
    return { angle: actor.angle, power: Math.max(30, actor.power), weapon: fallback, ...extra }
  }

  const here = search(state, weapons, true)
  let best = here.best
  let move = 0

  // a veces se mueve: siempre que el tiro esté bloqueado o no llegue, y de vez en cuando igual
  const wander = rand() < 0.15
  if (actor.fuel > 0 && (best.score < 1000 || wander)) {
    const steps = best.score < 1000 ? [-40, -20, 20, 40] : [-20, 20]
    for (const d of steps) {
      const moved = walk(state, d)
      if (!moved) continue
      const c = search(moved.state, weapons, false).best
      if (c.score > best.score + 60) {
        best = c
        move = moved.dx
      }
    }
  }

  // tapado y sin tiro: excavadora hacia el rival más cercano
  if (best.score < 1000 && move === 0 && here.blocked > 0.5 && actor.ammo.digger > 0) {
    const t = nearest(actor, targets)
    return { angle: t.x > actor.x ? 30 : 150, power: 45, weapon: 'digger', ...extra }
  }

  const err = ERROR[difficulty]
  const plan: ShotPlan = {
    angle: clamp(Math.round(best.angle + (rand() * 2 - 1) * err.angle), 0, 180),
    power: clamp(Math.round(best.power + (rand() * 2 - 1) * err.power), 10, 100),
    weapon: best.weapon,
  }
  if (move !== 0) plan.move = move
  if (items.length > 0) plan.items = items
  return plan
}

// Aplica 'move' hasta |dx| pixels. null si no pudo avanzar.
function walk(state: GameState, dx: number): { state: GameState; dx: number } | null {
  let s = state
  const id = s.players[s.current].id
  const dir = dx > 0 ? 1 : -1
  let n = 0
  for (; n < Math.abs(dx); n++) {
    const r = applyCommand(s, { type: 'move', playerId: id, dir })
    if (r.state === s || r.state.current !== s.current) break
    s = r.state
  }
  if (n < 4) return null
  return { state: s, dx: dir * n }
}

function search(state: GameState, weapons: WeaponId[], fine: boolean): Search {
  const actor = state.players[state.current]
  const targets = state.players.filter((p) => p.alive && p.id !== actor.id)
  const perWeapon = new Map<WeaponId, Candidate>()
  let best: Candidate = { angle: actor.angle, power: actor.power, weapon: weapons[0], score: -Infinity }
  let total = 0
  let blocked = 0
  const consider = (angle: number, power: number) => {
    const r = estimate(state, actor, targets, weapons, angle, power)
    total++
    if (r.blocked) blocked++
    for (const c of r.list) {
      const prev = perWeapon.get(c.weapon)
      if (!prev || c.score > prev.score) perWeapon.set(c.weapon, c)
      if (c.score > best.score) best = c
    }
  }
  const da = fine ? 6 : 12
  const dp = fine ? 4 : 8
  for (let angle = 6; angle <= 174; angle += da) for (let power = 24; power <= 100; power += dp) consider(angle, power)
  if (fine) {
    const a0 = best.angle
    const p0 = best.power
    for (let a = -4; a <= 4; a += 1) for (let p = -3; p <= 3; p += 1) consider(clamp(a0 + a, 0, 180), clamp(p0 + p, 10, 100))
  }
  // verificación con la simulación completa (racimo, rodadora y napalm no se estiman bien)
  const pool = [...perWeapon.values(), best]
  let verified: Candidate = { ...best, score: -Infinity }
  for (const c of pool) {
    const score = simulate(state, c)
    if (score > verified.score) verified = { ...c, score }
  }
  return { best: verified, blocked: total > 0 ? blocked / total : 0 }
}

function estimate(
  state: GameState,
  actor: Player,
  targets: Player[],
  weapons: WeaponId[],
  angle: number,
  power: number,
): { list: Candidate[]; blocked: boolean } {
  const flight = fly({
    terrain: state.terrain,
    players: state.players,
    props: state.props,
    ownerId: actor.id,
    angle,
    power,
    wind: state.wind,
  })
  if (flight.impact.kind === 'out') return { list: [{ angle, power, weapon: weapons[0], score: -1e6 }], blocked: false }
  const { x, y } = flight.impact
  const m = muzzle(actor.x, actor.y, angle)
  const blocked = Math.hypot(x - m.x, y - m.y) < 30
  let near = Infinity
  for (const t of targets) near = Math.min(near, Math.hypot(t.x - x, t.y - TANK_H / 2 - y))
  const list: Candidate[] = []
  for (const id of weapons) {
    const w = WEAPONS[id]
    const spread = w.split ? 2.4 : w.rolls ? 2 : 1
    const blast = { x, y, radius: w.radius * spread, damage: w.damage, terrain: w.terrain }
    let dmg = 0
    for (const t of targets) {
      let d = t.id === flight.impact.tankId ? w.damage : blastDamage(t, blast)
      if (w.burn && Math.abs(t.x - x) < NAPALM_SPREAD && Math.abs(t.y - y) < 30) d += NAPALM_DPS * w.burn
      dmg += Math.min(t.hp + t.shield, d)
    }
    const self = blastDamage(actor, blast)
    const score = dmg > 0 ? 1000 + dmg * 10 - self * 18 - COST[id] : -near - self * 18 - COST[id] * 0.01
    list.push({ angle, power, weapon: id, score })
  }
  return { list, blocked }
}

function simulate(state: GameState, c: Candidate): number {
  const s = cloneState(state)
  const actor = s.players[s.current]
  actor.angle = c.angle
  actor.power = c.power
  const before = s.players.map((p) => ({ hp: p.hp, alive: p.alive }))
  const { events } = resolveShot(s, actor, c.weapon)
  let dmg = 0
  let kills = 0
  let near = Infinity
  for (const p of s.players) {
    const b = before[p.id]
    if (p.id === actor.id || !b.alive) continue
    dmg += b.hp - p.hp
    if (!p.alive) kills++
    for (const e of events) if (e.type === 'impact') near = Math.min(near, Math.hypot(p.x - e.x, p.y - TANK_H / 2 - e.y))
  }
  const self = before[actor.id].hp - actor.hp
  if (!actor.alive) return -1e5
  if (!Number.isFinite(near)) return -1e6
  return dmg > 0 ? 1000 + dmg * 10 + kills * 250 - self * 18 - COST[c.weapon] : -near - self * 18 - COST[c.weapon] * 0.01
}

function nearest(actor: Player, targets: Player[]): Player {
  let best = targets[0]
  for (const t of targets) if (Math.abs(t.x - actor.x) < Math.abs(best.x - actor.x)) best = t
  return best
}

function rngFor(state: GameState): () => number {
  const r = new Rng(hashSeed(state.rng ^ Math.imul(state.turn, 0x9e3779b1) ^ state.current))
  return () => r.next()
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
