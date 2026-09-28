import { generate } from './gen'
import { tankFloor } from './physics'
import { resolveShot } from './weapons'
import { Rng, hashSeed, irange } from './rng'
import { cloneTerrain, isSolid } from './terrain'
import {
  BIOMES,
  CREWS,
  FALL_DAMAGE,
  FUEL_PER_TURN,
  MAX_CLIMB,
  PLAYER_HP,
  TANK_COLORS,
  TANK_H,
  TANK_HALF_W,
  WEAPONS,
  WEAPON_ORDER,
  WORLD_H,
  WORLD_W,
  type Command,
  type GameEvent,
  type GameState,
  type MatchConfig,
  type Player,
  type StepResult,
  type WeaponId,
} from './types'

const NAMES = ['Brodozer', 'Sarge', 'Rookie', 'Desert']

function initialAmmo(): Record<WeaponId, number> {
  const ammo = {} as Record<WeaponId, number>
  for (const id of Object.keys(WEAPONS) as WeaponId[]) ammo[id] = WEAPON_ORDER.includes(id) ? WEAPONS[id].ammo : 0
  return ammo
}

export function createMatch(config: MatchConfig): GameState {
  const seed = (config.seed ?? 1) >>> 0 || 1
  const rng = new Rng(hashSeed(seed))
  const biome = config.biome ?? BIOMES[0]
  const bots = Math.max(0, Math.min(3, config.bots | 0))
  const gen = generate(biome, rng, 1 + bots)
  const players: Player[] = gen.spawns.map((x, i) => ({
    id: i,
    name: NAMES[i] ?? `P${i + 1}`,
    kind: i === 0 ? 'human' : 'ai',
    color: TANK_COLORS[i % TANK_COLORS.length],
    crew: CREWS[i % CREWS.length],
    x,
    y: tankFloor(gen.terrain, x, 0),
    hp: PLAYER_HP,
    angle: x < WORLD_W / 2 ? 55 : 125,
    power: 60,
    fuel: FUEL_PER_TURN,
    weapon: 'normal',
    ammo: initialAmmo(),
    alive: true,
  }))
  const wind = irange(rng.state, -10, 10)
  return {
    seed,
    rng: wind.state,
    width: WORLD_W,
    height: WORLD_H,
    biome,
    terrain: gen.terrain,
    props: gen.props,
    wind: wind.value,
    players,
    current: 0,
    phase: 'aiming',
    winnerId: null,
    turn: 1,
  }
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    terrain: cloneTerrain(state.terrain),
    props: state.props.map((p) => ({ ...p })),
    players: state.players.map((p) => ({ ...p, ammo: { ...p.ammo } })),
  }
}

export function applyCommand(state: GameState, command: Command): StepResult {
  if (state.phase !== 'aiming') return { state, events: [] }
  const actor = state.players[state.current]
  if (!actor || actor.id !== command.playerId || !actor.alive) return { state, events: [] }

  switch (command.type) {
    case 'aim': {
      const next = cloneState(state)
      const p = next.players[next.current]
      p.angle = clamp(Number.isFinite(command.angle) ? command.angle : p.angle, 0, 180)
      p.power = clamp(Number.isFinite(command.power) ? command.power : p.power, 0, 100)
      return { state: next, events: [] }
    }
    case 'selectWeapon': {
      if (!(command.weapon in WEAPONS) || actor.ammo[command.weapon] <= 0) return { state, events: [] }
      const next = cloneState(state)
      next.players[next.current].weapon = command.weapon
      return { state: next, events: [] }
    }
    case 'move':
      return move(state, command.dir)
    case 'fire':
      return fire(state, actor)
  }
}

// F6 básico: un paso de 1 px, sube hasta MAX_CLIMB, cae si el piso se va.
function move(state: GameState, dir: -1 | 1): StepResult {
  const actor = state.players[state.current]
  if (actor.fuel <= 0 || (dir !== 1 && dir !== -1)) return { state, events: [] }
  const nx = actor.x + dir
  if (nx < TANK_HALF_W || nx > WORLD_W - TANK_HALF_W) return { state, events: [] }
  const t = state.terrain
  const edge = dir > 0 ? nx + TANK_HALF_W - 1 : nx - TANK_HALF_W
  for (let y = actor.y - TANK_H; y < actor.y - MAX_CLIMB; y++) if (isSolid(t, edge, y)) return { state, events: [] }
  const floor = tankFloor(t, nx, actor.y - MAX_CLIMB)
  // al subir, el techo tiene que dejar lugar
  for (let y = floor - TANK_H; y < actor.y - TANK_H; y++) {
    for (let x = nx - TANK_HALF_W; x < nx + TANK_HALF_W; x++) if (isSolid(t, x, y)) return { state, events: [] }
  }
  // no se mete dentro de otro tanque
  for (const q of state.players) {
    if (q.id === actor.id || !q.alive) continue
    if (Math.abs(q.x - nx) < TANK_HALF_W * 2 && Math.abs(q.x - nx) < Math.abs(q.x - actor.x) && Math.abs(q.y - floor) < TANK_H) {
      return { state, events: [] }
    }
  }
  // mover no toca el terreno ni la utilería: se comparten con el estado anterior
  const next: GameState = { ...state, players: state.players.map((q) => ({ ...q, ammo: { ...q.ammo } })) }
  const p = next.players[next.current]
  const events: GameEvent[] = []
  p.x = nx
  p.fuel -= 1
  if (floor > p.y + MAX_CLIMB) {
    events.push({ type: 'fall', playerId: p.id, from: p.y, to: floor })
    const drop = floor - p.y
    p.y = floor
    const amount = Math.min(p.hp, Math.round(Math.max(0, drop - 12) * FALL_DAMAGE))
    if (amount > 0) {
      p.hp -= amount
      events.push({ type: 'damage', playerId: p.id, amount, hp: p.hp })
      if (p.hp <= 0) {
        p.alive = false
        events.push({ type: 'death', playerId: p.id })
        return advance(next, events)
      }
    }
  } else p.y = floor
  return { state: next, events }
}

function fire(state: GameState, actor: Player): StepResult {
  if (actor.ammo[actor.weapon] <= 0) {
    if (!hasAmmo(actor)) return advance(cloneState(state), [{ type: 'empty', playerId: actor.id }])
    return { state, events: [{ type: 'empty', playerId: actor.id }] }
  }
  const next = cloneState(state)
  const shooter = next.players[next.current]
  shooter.ammo[shooter.weapon] -= 1
  const weapon = shooter.weapon
  const { flights, events } = resolveShot(next, shooter, weapon)
  if (shooter.ammo[weapon] <= 0) {
    const fallback = WEAPON_ORDER.find((id) => shooter.ammo[id] > 0)
    if (fallback) shooter.weapon = fallback
  }
  return { ...advance(next, events), flights }
}

function advance(state: GameState, events: GameEvent[]): StepResult {
  const alive = state.players.filter((p) => p.alive)
  if (alive.length <= 1) {
    state.phase = 'gameover'
    state.winnerId = alive[0]?.id ?? null
    events.push({ type: 'gameover', winnerId: state.winnerId })
    return { state, events }
  }
  for (let i = 1; i <= state.players.length; i++) {
    const idx = (state.current + i) % state.players.length
    if (state.players[idx].alive) {
      state.current = idx
      break
    }
  }
  const wind = irange(state.rng, -10, 10)
  state.wind = wind.value
  state.rng = wind.state
  state.turn += 1
  state.players[state.current].fuel = FUEL_PER_TURN
  events.push({ type: 'turn', playerId: state.players[state.current].id })
  events.push({ type: 'wind', value: state.wind })
  return { state, events }
}

function hasAmmo(player: Player): boolean {
  return WEAPON_ORDER.some((id) => player.ammo[id] > 0)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function currentPlayer(state: GameState): Player {
  return state.players[state.current]
}
