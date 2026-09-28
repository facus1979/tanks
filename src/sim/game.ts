import { generate } from './gen'
import { tankFloor } from './physics'
import { resolveShot } from './weapons'
import { Rng, hashSeed, irange } from './rng'
import { aiShop, buyEntry, sellEntry, shopEntry } from './shop'
import { cloneTerrain, isSolid } from './terrain'
import {
  BIOMES,
  CREWS,
  EARN,
  FALL_DAMAGE,
  FUEL_PER_TURN,
  ITEM_ORDER,
  MAX_CLIMB,
  PLAYER_HP,
  REPAIR_HP,
  SHIELD_HP,
  START_MONEY,
  TANK_COLORS,
  TANK_H,
  TANK_HALF_W,
  WEAPONS,
  WEAPON_ORDER,
  WORLD_H,
  WORLD_W,
  type Biome,
  type Command,
  type CrewId,
  type GameEvent,
  type GameState,
  type ItemId,
  type MatchConfig,
  type Player,
  type StepResult,
  type WeaponId,
} from './types'

// Nombre por defecto de cada tripulante.
export const CREW_NAMES: Record<CrewId, string> = { bandana: 'Brodozer', sarge: 'Sarge', rookie: 'Rookie', desert: 'Desert' }

function initialAmmo(): Record<WeaponId, number> {
  const ammo = {} as Record<WeaponId, number>
  for (const id of Object.keys(WEAPONS) as WeaponId[]) ammo[id] = WEAPON_ORDER.includes(id) ? WEAPONS[id].ammo : 0
  return ammo
}

function emptyItems(): Record<ItemId, number> {
  const items = {} as Record<ItemId, number>
  for (const id of ITEM_ORDER) items[id] = 0
  return items
}

// Seed del mapa de cada ronda. La ronda 1 usa la seed tal cual (mismos mapas que antes de F10).
export function roundSeed(seed: number, round: number): number {
  return round <= 1 ? hashSeed(seed) : hashSeed(seed ^ Math.imul(round, 0x9e3779b1))
}

export function biomeFor(mode: Biome | 'random' | 'rotate', seed: number, round: number): Biome {
  if (mode === 'rotate') return BIOMES[(round - 1) % BIOMES.length]
  if (mode === 'random') return BIOMES[hashSeed(seed ^ Math.imul(round, 0x27d4eb2f)) % BIOMES.length]
  return BIOMES.includes(mode) ? mode : BIOMES[0]
}

export function createMatch(config: MatchConfig): GameState {
  const seed = (config.seed ?? 1) >>> 0 || 1
  const slots = (config.slots ?? []).slice(0, 4)
  while (slots.length < 2) slots.push({ kind: 'ai' })
  const rounds = Math.max(1, Math.floor(config.rounds || 1))
  const biomeMode = config.biome ?? BIOMES[0]
  const players: Player[] = slots.map((slot, i) => {
    const crew = slot.crew && CREWS.includes(slot.crew) ? slot.crew : CREWS[i % CREWS.length]
    return {
      id: i,
      name: slot.name?.trim() || CREW_NAMES[crew],
      kind: slot.kind === 'human' ? 'human' : 'ai',
      color: TANK_COLORS[i % TANK_COLORS.length],
      crew,
      x: 0,
      y: 0,
      hp: PLAYER_HP,
      angle: 90,
      power: 60,
      fuel: FUEL_PER_TURN,
      weapon: 'normal',
      ammo: initialAmmo(),
      alive: true,
      money: START_MONEY,
      items: emptyItems(),
      shield: 0,
      tracer: false,
      roundsWon: 0,
      kills: 0,
      ready: false,
    }
  })
  const state: GameState = {
    seed,
    rng: 0,
    width: WORLD_W,
    height: WORLD_H,
    biome: BIOMES[0],
    terrain: undefined as never,
    props: [],
    wind: 0,
    players,
    current: 0,
    phase: 'aiming',
    winnerId: null,
    roundWinnerId: null,
    turn: 1,
    round: 1,
    rounds,
    difficulty: config.difficulty ?? 'normal',
    biomeMode,
    earnings: {},
  }
  setupRound(state)
  return state
}

// Mapa nuevo, tanques en sus posiciones, vida llena. Muta el estado.
function setupRound(state: GameState): void {
  const rng = new Rng(roundSeed(state.seed, state.round))
  const biome = biomeFor(state.biomeMode, state.seed, state.round)
  const gen = generate(biome, rng, state.players.length)
  state.biome = biome
  state.terrain = gen.terrain
  state.props = gen.props
  state.players.forEach((p, i) => {
    const x = gen.spawns[i]
    p.x = x
    p.y = tankFloor(gen.terrain, x, 0)
    p.hp = PLAYER_HP
    p.alive = true
    p.angle = x < WORLD_W / 2 ? 55 : 125
    p.power = 60
    p.fuel = FUEL_PER_TURN
    p.shield = 0
    p.tracer = false
    p.ready = false
    p.ammo.normal = WEAPONS.normal.ammo
    if (p.ammo[p.weapon] <= 0) p.weapon = 'normal'
  })
  const wind = irange(rng.state, -10, 10)
  state.wind = wind.value
  state.rng = wind.state
  state.current = (state.round - 1) % state.players.length
  state.phase = 'aiming'
  state.roundWinnerId = null
  state.turn = 1
  state.earnings = Object.fromEntries(state.players.map((p) => [p.id, 0]))
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    terrain: cloneTerrain(state.terrain),
    props: state.props.map((p) => ({ ...p })),
    players: clonePlayers(state.players),
    earnings: { ...state.earnings },
  }
}

function clonePlayers(players: Player[]): Player[] {
  return players.map((p) => ({ ...p, ammo: { ...p.ammo }, items: { ...p.items } }))
}

// Copia sin tocar terreno ni utilería (tienda, ítems, movimiento).
function shallow(state: GameState): GameState {
  return { ...state, players: clonePlayers(state.players), earnings: { ...state.earnings } }
}

export function applyCommand(state: GameState, command: Command): StepResult {
  switch (command.type) {
    case 'nextRound':
      return state.phase === 'roundover' ? nextRound(state) : { state, events: [] }
    case 'buy':
    case 'sell':
    case 'ready':
      return state.phase === 'shop' ? shop(state, command) : { state, events: [] }
  }
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
    case 'useItem':
      return useItem(state, command.item)
  }
}

// Ítems activos: no gastan el turno.
function useItem(state: GameState, item: ItemId): StepResult {
  const actor = state.players[state.current]
  if (!(actor.items[item] > 0)) return { state, events: [] }
  const ok =
    item === 'shield' ? actor.shield <= 0 : item === 'repair' ? actor.hp < PLAYER_HP : item === 'tracer' ? !actor.tracer : item === 'fuel'
  if (!ok) return { state, events: [] }
  const next = shallow(state)
  const p = next.players[next.current]
  p.items[item] -= 1
  if (item === 'shield') p.shield = SHIELD_HP
  else if (item === 'repair') p.hp = Math.min(PLAYER_HP, p.hp + REPAIR_HP)
  else if (item === 'tracer') p.tracer = true
  else p.fuel += FUEL_PER_TURN
  return { state: next, events: [{ type: 'item', playerId: p.id, item }] }
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
  const next = shallow(state)
  const p = next.players[next.current]
  const events: GameEvent[] = []
  p.x = nx
  p.fuel -= 1
  if (floor > p.y + MAX_CLIMB) {
    const drop = floor - p.y
    const amount = Math.min(p.hp, Math.round(Math.max(0, drop - 12) * FALL_DAMAGE))
    const chute = amount > 0 && p.items.parachute > 0
    events.push(chute ? { type: 'fall', playerId: p.id, from: p.y, to: floor, parachute: true } : { type: 'fall', playerId: p.id, from: p.y, to: floor })
    p.y = floor
    if (chute) p.items.parachute -= 1
    else if (amount > 0) {
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
  shooter.tracer = false
  const weapon = shooter.weapon
  const before = next.players.map((p) => ({ hp: p.hp + p.shield, alive: p.alive }))
  const { flights, events } = resolveShot(next, shooter, weapon)
  // plata de la ronda: daño a otros, kills y autodaño
  let earned = 0
  for (const p of next.players) {
    const b = before[p.id]
    if (!b.alive) continue
    const dmg = b.hp - (p.hp + p.shield)
    if (p.id === shooter.id) earned += dmg * EARN.selfDamage
    else {
      earned += dmg * EARN.perDamage
      if (!p.alive) {
        earned += EARN.kill
        shooter.kills += 1
      }
    }
  }
  next.earnings[shooter.id] = (next.earnings[shooter.id] ?? 0) + earned
  if (shooter.ammo[weapon] <= 0) {
    const fallback = WEAPON_ORDER.find((id) => shooter.ammo[id] > 0)
    if (fallback) shooter.weapon = fallback
  }
  return { ...advance(next, events), flights }
}

function advance(state: GameState, events: GameEvent[]): StepResult {
  const alive = state.players.filter((p) => p.alive)
  if (alive.length <= 1) return endRound(state, events, alive[0]?.id ?? null)
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

// Reparte la plata de la ronda. earnings trae lo acumulado por los tiros; nunca queda plata negativa.
function endRound(state: GameState, events: GameEvent[], winnerId: number | null): StepResult {
  state.phase = 'roundover'
  state.roundWinnerId = winnerId
  const earnings: Record<number, number> = {}
  for (const p of state.players) {
    let e = state.earnings[p.id] ?? 0
    if (p.alive) e += EARN.survive
    if (p.id === winnerId) {
      e += EARN.roundWin
      p.roundsWon += 1
    }
    const money = Math.max(0, p.money + Math.round(e))
    earnings[p.id] = money - p.money
    p.money = money
  }
  state.earnings = earnings
  events.push({ type: 'roundover', winnerId, earnings: { ...earnings }, last: state.round >= state.rounds })
  return { state, events }
}

function nextRound(state: GameState): StepResult {
  const next = shallow(state)
  const events: GameEvent[] = []
  if (next.round >= next.rounds) {
    next.phase = 'gameover'
    next.winnerId = matchWinner(next.players)
    events.push({ type: 'gameover', winnerId: next.winnerId })
    return { state: next, events }
  }
  next.phase = 'shop'
  for (const p of next.players) {
    p.ready = p.kind === 'ai'
    if (p.kind === 'ai') aiShop(p, next.difficulty, next.seed, next.round)
  }
  events.push({ type: 'shop' })
  return startIfReady(next, events)
}

function shop(state: GameState, command: Extract<Command, { type: 'buy' | 'sell' | 'ready' }>): StepResult {
  const idx = state.players.findIndex((p) => p.id === command.playerId)
  if (idx < 0 || state.players[idx].ready) return { state, events: [] }
  const next = shallow(state)
  const p = next.players[idx]
  if (command.type === 'ready') {
    p.ready = true
    return startIfReady(next, [])
  }
  const entry = shopEntry(command.id)
  if (!entry) return { state, events: [] }
  const ok = command.type === 'buy' ? buyEntry(p, entry) : sellEntry(p, entry)
  return ok ? { state: next, events: [] } : { state, events: [] }
}

function startIfReady(state: GameState, events: GameEvent[]): StepResult {
  if (!state.players.every((p) => p.ready)) return { state, events }
  state.round += 1
  setupRound(state)
  events.push({ type: 'round', round: state.round, biome: state.biome })
  events.push({ type: 'turn', playerId: state.players[state.current].id })
  events.push({ type: 'wind', value: state.wind })
  return { state, events }
}

// Más rondas ganadas; desempata kills y después plata. Empate total: null.
function matchWinner(players: Player[]): number | null {
  const key = (p: Player) => [p.roundsWon, p.kills, p.money]
  const sorted = [...players].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]
    return 0
  })
  const [a, b] = sorted
  if (b && a.roundsWon === b.roundsWon && a.kills === b.kills && a.money === b.money) return null
  return a.id
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
