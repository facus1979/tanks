import { PATH_DT } from './ballistics'
import { generate } from './gen'
import { flowLiquids } from './flow'
import { COLLAPSE_DELAY, collapseAfterShot, engulfedInLava, hurt, inLava, kill, settleAfterFlow, settleTank, tankFloor } from './physics'
import { SLIDE_MAX, slopeAt, stepTank } from './slide'
import { afterSteer, land, resolveShot, toFlight } from './weapons'
import { steerGuided, ticksLeft } from './guided'
import { MINE_DELAY, mineReactions, settleHazards, tickHazards } from './hazards'
import { Rng, hashSeed, irange } from './rng'
import { aiShop, buyEntry, sellEntry, shopEntry } from './shop'
import { cloneTerrain, isSolid, takeDirty } from './terrain'
import {
  BIOMES,
  CREWS,
  EARN,
  SLIDE_SLOPE,
  MAX_CLIMB,
  JETPACK_RANGE,
  TELEPORT_RANGE,
  TANK_HALF_W,
  fuelFor,
  ITEM_ORDER,
  LAVA_DAMAGE,
  LAVA_RISE,
  PLAYER_HP,
  REPAIR_HP,
  SHIELD_HP,
  START_MONEY,
  SUDDEN_DEATH_CALM,
  TANK_COLORS,
  TANK_H,
  TANK_W,
  WEAPONS,
  WEAPON_ORDER,
  MAP_SIZES,
  MAX_PLAYERS_BY_SIZE,
  type Biome,
  type MapSize,
  type Command,
  type CrewId,
  type Flight,
  type GameEvent,
  type GameState,
  type ItemId,
  type MatchConfig,
  type Player,
  type StepResult,
  type Vec2,
  type WeaponId,
} from './types'

// Nombre por defecto de cada tripulante.
export const CREW_NAMES: Record<CrewId, string> = {
  bandana: 'Brodozer',
  sarge: 'Sarge',
  rookie: 'Rookie',
  desert: 'Desert',
  commando: 'Comando',
  goggles: 'Tanquista',
  pilot: 'Piloto',
  colonel: 'Coronel',
}

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
  const sizeKey: MapSize = config.size && MAP_SIZES[config.size] ? config.size : 'small'
  const slots = (config.slots ?? []).slice(0, MAX_PLAYERS_BY_SIZE[sizeKey])
  while (slots.length < 2) slots.push({ kind: 'ai' })
  const rounds = Math.max(1, Math.floor(config.rounds || 1))
  const biomeMode = config.biome ?? BIOMES[0]
  const size: MapSize = config.size && MAP_SIZES[config.size] ? config.size : 'small'
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
      fuel: fuelFor(MAP_SIZES[size].w),
      weapon: 'normal',
      ammo: initialAmmo(),
      alive: true,
      money: START_MONEY,
      items: emptyItems(),
      shield: 0,
      tracer: false,
      anchored: false,
      deflector: false,
      roundsWon: 0,
      kills: 0,
      ready: false,
    }
  })
  const state: GameState = {
    seed,
    rng: 0,
    size,
    width: MAP_SIZES[size].w,
    height: MAP_SIZES[size].h,
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
    calm: 0,
    lava: null,
    hazards: [],
    guided: null,
    bonusFirstBlood: false,
    windLeft: 0,
  }
  setupRound(state)
  return state
}

// v2.3: sal del sorteo de lugares y primer turno (ver setupRound).
export const ORDER_SALT = 0x2545f491

// Mapa nuevo, tanques en sus posiciones, vida llena. Muta el estado.
function setupRound(state: GameState): void {
  const rng = new Rng(roundSeed(state.seed, state.round))
  const biome = biomeFor(state.biomeMode, state.seed, state.round)
  // v2.4: tantos lugares seguros como humanos (ver humanSafe en gen.ts)
  const humans = state.players.filter((p) => p.kind === 'human').length
  const gen = generate(biome, rng, state.players.length, state.width, state.height, humans)
  state.biome = biome
  state.terrain = gen.terrain
  state.props = gen.props
  // v2.3: quién nace dónde y quién abre la ronda se sortean con la seed de la ronda (rng aparte: el mapa
  // y el viento no cambian). Antes el jugador 0 nacía siempre en una punta y abría la ronda 1 (con 6 en
  // Mediano a una ronda ganaba ~40%); la ronda r la abría el jugador (r - 1) % jugadores.
  const draw = new Rng(hashSeed(roundSeed(state.seed, state.round) ^ ORDER_SALT))
  const seat = state.players.map((_, i) => i)
  for (let i = seat.length - 1; i > 0; i--) {
    const j = draw.int(0, i)
    const tmp = seat[i]
    seat[i] = seat[j]
    seat[j] = tmp
  }
  // el que abre la ronda sale del mismo sorteo (antes de los cambios de lugar de abajo: no lo cambian)
  const opener = draw.int(0, state.players.length - 1)
  // v2.4: un humano al que le tocó un lugar al borde de un abismo (cornisa o a menos de HUMAN_PIT_GAP px)
  // lo cambia con una IA de lugar seguro, elegida con el mismo sorteo. Si no le tocó (o en Chico, sin
  // abismos), no se sortea nada más y todo queda como en v2.3. generate garantiza que hay lugares seguros
  // para todos los humanos.
  const safe = gen.safe
  if (safe) {
    state.players.forEach((p, i) => {
      if (p.kind !== 'human' || safe[seat[i]]) return
      const pool = state.players.filter((q, j) => q.kind !== 'human' && safe[seat[j]]).map((q) => state.players.indexOf(q))
      if (pool.length === 0) return
      const j = pool[draw.int(0, pool.length - 1)]
      const tmp = seat[i]
      seat[i] = seat[j]
      seat[j] = tmp
    })
  }
  state.players.forEach((p, i) => {
    const x = gen.spawns[seat[i]]
    p.x = x
    p.y = tankFloor(gen.terrain, x, 0)
    p.hp = PLAYER_HP
    p.alive = true
    p.angle = x < state.width / 2 ? 55 : 125
    p.power = 60
    p.fuel = fuelFor(state.width)
    p.shield = 0
    p.tracer = false
    p.anchored = false // v3: el ancla y el deflector no pasan a la ronda siguiente (como el escudo)
    p.deflector = false
    p.ready = false
    p.ammo.normal = WEAPONS.normal.ammo
    if (p.ammo[p.weapon] <= 0) p.weapon = 'normal'
  })
  const wind = irange(rng.state, -10, 10)
  state.wind = wind.value
  state.rng = wind.state
  state.windLeft = state.players.length
  state.current = opener
  state.phase = 'aiming'
  state.roundWinnerId = null
  state.turn = 1
  state.calm = 0
  state.lava = null
  state.hazards = []
  state.guided = null
  state.bonusFirstBlood = false
  state.earnings = Object.fromEntries(state.players.map((p) => [p.id, 0]))
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    terrain: cloneTerrain(state.terrain),
    props: state.props.map((p) => ({ ...p })),
    players: clonePlayers(state.players),
    earnings: { ...state.earnings },
    hazards: state.hazards.map((h) => ({ ...h })), // v3
    guided: state.guided ? { ...state.guided } : null,
  }
}

function clonePlayers(players: Player[]): Player[] {
  return players.map((p) => ({ ...p, ammo: { ...p.ammo }, items: { ...p.items } }))
}

// Copia sin tocar terreno ni utilería (tienda, ítems, movimiento).
function shallow(state: GameState): GameState {
  return {
    ...state,
    players: clonePlayers(state.players),
    earnings: { ...state.earnings },
    hazards: state.hazards.map((h) => ({ ...h })),
    guided: state.guided ? { ...state.guided } : null,
  }
}

export function applyCommand(state: GameState, command: Command): StepResult {
  switch (command.type) {
    case 'nextRound':
      return state.phase === 'roundover' ? nextRound(state) : { state, events: [] }
    case 'steer':
      return steer(state, command.playerId, command.dirs)
    case 'setKind': {
      const i = state.players.findIndex((p) => p.id === command.playerId)
      if (i < 0 || (command.kind !== 'human' && command.kind !== 'ai') || state.players[i].kind === command.kind) return { state, events: [] }
      const next = shallow(state)
      const p = next.players[i]
      p.kind = command.kind
      // en la tienda, una IA que entra compra y queda lista para no trabar la ronda
      if (next.phase === 'shop' && p.kind === 'ai' && !p.ready) {
        aiShop(p, next.difficulty, next.seed, next.round)
        p.ready = true
        return startIfReady(next, [])
      }
      return { state: next, events: [] }
    }
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
      return useItem(state, command.item, command.target)
  }
}

// Ítems activos: no gastan el turno.
// v3: jetpack y teleport necesitan target (ver jump); ancla y deflector se prenden hasta que se usan o hasta su
// próximo turno (ancla). Anclado no puede moverse, saltar ni teletransportarse.
function useItem(state: GameState, item: ItemId, target?: Vec2): StepResult {
  const actor = state.players[state.current]
  if (!(actor.items[item] > 0)) return { state, events: [] }
  if (item === 'jetpack' || item === 'teleport') return jump(state, item, target)
  const ok =
    item === 'shield'
      ? actor.shield <= 0
      : item === 'repair'
        ? actor.hp < PLAYER_HP
        : item === 'tracer'
          ? !actor.tracer
          : item === 'anchor'
            ? !actor.anchored
            : item === 'deflector'
              ? !actor.deflector
              : item === 'fuel'
  if (!ok) return { state, events: [] }
  const next = shallow(state)
  const p = next.players[next.current]
  p.items[item] -= 1
  if (item === 'shield') p.shield = SHIELD_HP
  else if (item === 'repair') p.hp = Math.min(PLAYER_HP, p.hp + REPAIR_HP)
  else if (item === 'tracer') p.tracer = true
  else if (item === 'anchor') p.anchored = true
  else if (item === 'deflector') p.deflector = true
  else p.fuel += fuelFor(state.width)
  return { state: next, events: [{ type: 'item', playerId: p.id, item }] }
}

// v3 jetpack y teletransporte. target: el punto del piso donde apoyar el tanque (como Player.x / Player.y).
// - Rango: a lo sumo JETPACK_RANGE (TELEPORT_RANGE) px en línea recta desde el piso del tanque al target.
// - Destino (landingFor): x = target.x (dentro del mapa); un target metido en el terreno (hasta JUMP_SNAP px)
//   sube a la superficie; si hay piso entre MAX_CLIMB px arriba y abajo de
//   target.y, se apoya ahí; si no, queda en el aire en target.y y cae (daño de caída, paracaídas, abismo, agua).
//   Si la caja del tanque en el destino choca con terreno u otro tanque, el comando no hace nada.
// - Jetpack: vuela en arco (JET_LIFT px por encima del más alto de los dos extremos) a JET_SPEED px/s; si el
//   arco choca con terreno, se frena en el último punto libre y cae desde ahí. Evento 'jetpack' con el camino
//   (piso del tanque cada PATH_DT). Teletransporte: evento 'teleport' (from / to); no mira lo que hay en medio.
// - Una mina cerca del destino explota (t: fin del salto). No gastan el turno ni combustible.
export const JET_LIFT = 36
export const JUMP_SNAP = 2 * TANK_H
export const JET_SPEED = 170
export function landingFor(state: GameState, id: number, target: Vec2): Vec2 | null {
  const t = state.terrain
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || target.y >= t.h || target.y < TANK_H) return null
  const x = Math.round(Math.min(state.width - TANK_HALF_W, Math.max(TANK_HALF_W, target.x)))
  // destino metido en el terreno (hasta JUMP_SNAP px): se apoya en la superficie de arriba
  let ty = Math.round(target.y)
  for (let k = 0; k < JUMP_SNAP && isSolid(t, x, ty - 1); k++) ty--
  const f = tankFloor(t, x, ty - MAX_CLIMB)
  const y = f <= ty + MAX_CLIMB ? f : ty
  if (!boxFree(state, id, x, y)) return null
  return { x, y }
}

// La caja del tanque con el piso en (x, y) no se mete en terreno ni en otro tanque vivo.
function boxFree(state: GameState, id: number, x: number, y: number): boolean {
  const t = state.terrain
  for (let yy = y - TANK_H; yy < y; yy += 2) for (let xx = x - TANK_HALF_W; xx < x + TANK_HALF_W; xx += 2) if (isSolid(t, xx, yy)) return false
  for (let xx = x - TANK_HALF_W; xx < x + TANK_HALF_W; xx++) if (isSolid(t, xx, y - 1)) return false
  return !state.players.some((q) => q.id !== id && q.alive && Math.abs(q.x - x) < TANK_W && Math.abs(q.y - y) < TANK_H)
}

function jump(state: GameState, item: 'jetpack' | 'teleport', target?: Vec2): StepResult {
  const actor = state.players[state.current]
  if (!target || actor.anchored) return { state, events: [] }
  const range = item === 'jetpack' ? JETPACK_RANGE : TELEPORT_RANGE
  if (Math.hypot(target.x - actor.x, target.y - actor.y) > range + 0.5) return { state, events: [] }
  const to = landingFor(state, actor.id, target)
  if (!to || (to.x === actor.x && to.y === actor.y)) return { state, events: [] }
  const next = cloneState(state)
  const p = next.players[next.current]
  const from = { x: p.x, y: p.y }
  const events: GameEvent[] = [{ type: 'item', playerId: p.id, item }]
  p.items[item] -= 1
  let tEnd = 0
  if (item === 'teleport') {
    p.x = to.x
    p.y = to.y
    events.push({ type: 'teleport', playerId: p.id, from, to })
  } else {
    const apex = Math.min(from.y, to.y) - JET_LIFT
    const cx = (from.x + to.x) / 2
    const cy = 2 * apex - (from.y + to.y) / 2 // control de la Bézier cuadrática: el arco pasa por apex
    const len = Math.hypot(to.x - from.x, to.y - from.y) + 2 * Math.abs(apex - Math.min(from.y, to.y))
    const n = Math.max(2, Math.ceil(len / (JET_SPEED * PATH_DT)))
    const path: Vec2[] = [from]
    for (let k = 1; k <= n; k++) {
      const s = k / n
      const x = Math.round((1 - s) * (1 - s) * from.x + 2 * (1 - s) * s * cx + s * s * to.x)
      const y = Math.round((1 - s) * (1 - s) * from.y + 2 * (1 - s) * s * cy + s * s * to.y)
      // se golpea contra algo: se frena en el último punto libre (y cae)
      if (k < n && !boxFree(next, p.id, x, y)) break
      path.push({ x, y })
    }
    const last = path[path.length - 1]
    p.x = last.x
    p.y = last.y
    events.push({ type: 'jetpack', playerId: p.id, path })
    tEnd = (path.length - 1) * PATH_DT
  }
  settleTank(next, p, events)
  afterMoved(next, events, [{ id: p.id, x: from.x, y: from.y }], tEnd)
  if (!p.alive) return endTurn(next, events, [], false)
  return { state: next, events }
}

// v3: después de algo que movió tanques fuera de un tiro (move, jetpack, teletransporte): las minas que eso
// dispara, con su derrumbe y su flujo. moved: dónde estaba cada tanque que se movió.
function afterMoved(state: GameState, events: GameEvent[], moved: { id: number; x: number; y: number }[], t: number): void {
  if (!state.hazards.some((h) => h.kind === 'mine')) return
  const from = events.length
  const rep = mineReactions(state, events, from, (q) => moved.some((m) => m.id === q.id && (m.x !== q.x || m.y !== q.y)), t)
  if (rep.blasts === 0) return
  collapseAfterShot(state, events, shotEnd(events, []) + COLLAPSE_DELAY, true)
  settleLiquids(state, events, [])
  settleHazards(state, events, shotEnd(events, []))
}

// F6: un paso de 1 px gastando combustible; sube escalones de hasta MAX_CLIMB, cae si el piso se va.
// Pulido v2: el paso usa las mismas reglas que el empuje (stepTank). Un paso que lo dejaría en una
// pendiente mayor que SLIDE_SLOPE cuesta arriba no se da (las orugas patinan: es como una pared); si la
// pendiente es cuesta abajo, después del paso se desliza (evento 'slide' con cause 'slope', sin t) y,
// si eso lo deja sin piso, cae. Los primeros MOVE_FREE_FALL px de una caída caminando no hacen daño.
// v3: anclado no se mueve. Pisar el radio de una mina la hace explotar (eventos con t 0).
export const MOVE_FREE_FALL = 12
export const CLIMB_FUEL = 0.6
function move(state: GameState, dir: -1 | 1): StepResult {
  const actor = state.players[state.current]
  if (actor.fuel <= 0 || (dir !== 1 && dir !== -1) || actor.anchored) return { state, events: [] }
  const step = stepTank(state, actor, actor.x, actor.y, dir, tankFloor)
  if (!step) return { state, events: [] }
  if (!step.air && slopeAt(state, step.x, step.floor) * -dir > SLIDE_SLOPE) return { state, events: [] }
  // mover no toca el terreno ni la utilería: se comparten con el estado anterior (salvo que pise una mina)
  const mine = state.hazards.some((h) => h.kind === 'mine' && Math.abs(h.x - step.x) < TANK_HALF_W + h.radius + SLIDE_MAX_MINE)
  const next = mine ? cloneState(state) : shallow(state)
  const p = next.players[next.current]
  const events: GameEvent[] = []
  // v2.2: subir gasta más: 1 por paso más CLIMB_FUEL por unidad de pendiente cuesta arriba (a 75°, ~3,2)
  const uphill = step.air ? 0 : Math.max(0, slopeAt(state, step.x, step.floor) * -dir, (actor.y - step.floor) / 2)
  p.x = step.x
  p.y = step.floor
  p.fuel = Math.max(0, p.fuel - (1 + CLIMB_FUEL * uphill))
  // v3: si caminó (o se deslizó) hasta el abismo se cae (la sesión frena antes al que no lo hace a
  // propósito, ver abyssAhead; la IA nunca camina hacia un abismo). v4: al agua, sin daño ni paracaídas.
  settleTank(next, p, events, undefined, undefined, MOVE_FREE_FALL)
  if (mine) afterMoved(next, events, [{ id: actor.id, x: actor.x, y: actor.y }], 0)
  // se mató cayendo: termina el turno como un tiro que dañó a un tanque
  if (!p.alive) return endTurn(next, events, [], false)
  return { state: next, events }
}
// margen para el atajo de move: un paso más un deslizamiento corto
const SLIDE_MAX_MINE = 40

function fire(state: GameState, actor: Player): StepResult {
  if (actor.ammo[actor.weapon] <= 0) {
    if (!hasAmmo(actor)) return endTurn(cloneState(state), [{ type: 'empty', playerId: actor.id }], [], false)
    return { state, events: [{ type: 'empty', playerId: actor.id }] }
  }
  const next = cloneState(state)
  const shooter = next.players[next.current]
  shooter.ammo[shooter.weapon] -= 1
  shooter.tracer = false
  const weapon = shooter.weapon
  const before = lifeOf(next)
  const out = resolveShot(next, shooter, weapon, { pause: true })
  if (out.guided) {
    // v3: el teledirigido llegó al apogeo: se guía con 'steer' (phase 'guiding') hasta que choca o se acaba
    next.guided = out.guided
    next.phase = 'guiding'
    out.events.push({ type: 'guide', guided: { ...out.guided } })
    return { state: next, events: out.events, flights: out.flights }
  }
  return finishShot(next, shooter, weapon, before, out.flights, out.events)
}

// v3: correcciones del teledirigido. Solo el dueño y solo en 'guiding'; cada valor de dirs es un tick (lo que no
// es 1 ni -1 cuenta como 0; lo que pasa de los ticks que quedan se ignora). Mientras siga el guiado devuelve el
// tramo en flights (startT = segundos desde el disparo) sin eventos. Cuando choca o se acaba el guiado, el sim
// resuelve el resto (caída libre) y el turno sigue exactamente como un fire: explosión, daño, derrumbe, flujo,
// muerte súbita, 'turn'. Todos los t son desde el disparo.
function steer(state: GameState, playerId: number, raw: unknown): StepResult {
  const g = state.guided
  const actor = state.players[state.current]
  if (state.phase !== 'guiding' || !g || playerId !== g.ownerId || actor?.id !== g.ownerId || !Array.isArray(raw)) return { state, events: [] }
  const dirs = raw.slice(0, ticksLeft(g)).map((d) => (d === 1 ? 1 : d === -1 ? -1 : 0))
  if (dirs.length === 0) return { state, events: [] }
  const r = steerGuided(state, g, dirs)
  if (!r.hit && r.guided.guide > 0) {
    const next = shallow(state)
    next.guided = r.guided
    return { state: next, events: [], flights: [toFlight(r.flight, g.t)] }
  }
  const next = cloneState(state)
  next.guided = null
  next.phase = 'aiming'
  const shooter = next.players[next.current]
  const before = lifeOf(next)
  const flights: Flight[] = []
  const events: GameEvent[] = []
  const f = afterSteer(next, g, r, flights, events)
  const out = land(next, shooter, 'guided', f, flights, events)
  return finishShot(next, shooter, 'guided', before, out.flights, out.events)
}

function lifeOf(state: GameState): { hp: number; alive: boolean; x: number; y: number }[] {
  return state.players.map((p) => ({ hp: p.hp + p.shield, alive: p.alive, x: p.x, y: p.y }))
}

// Lo que sigue a los impactos de un tiro (fire, o el final del teledirigido): minas que se disparan, derrumbe,
// líquidos, peligros que se asientan, plata y fin del turno.
function finishShot(
  next: GameState,
  shooter: Player,
  weapon: WeaponId,
  before: { hp: number; alive: boolean; x: number; y: number }[],
  flights: Flight[],
  events: GameEvent[],
): StepResult {
  // v3: minas que dispara el tiro (tanques que se movieron, explosiones que las alcanzan); las que plantó este
  // mismo tiro no
  const placed = new Set<number>()
  for (const e of events) if (e.type === 'hazard' && e.action === 'place') placed.add(e.hazard.id)
  const mines = next.hazards.some((h) => h.kind === 'mine' && !placed.has(h.id))
    ? mineReactions(next, events, 0, (q) => q.x !== before[q.id].x || q.y !== before[q.id].y, shotEnd(events, flights) + MINE_DELAY, placed)
    : null
  // v2.4: los terrones sueltos caen (antes que los líquidos: lo que cae al agua la desplaza y el flujo la reparte)
  collapseAfterShot(next, events, shotEnd(events, flights) + COLLAPSE_DELAY, true)
  // v4: los líquidos corren y se asientan después de los impactos (y lo que eso derrumbe o queme)
  settleLiquids(next, events, flights)
  settleHazards(next, events, shotEnd(events, flights))
  // v3: los que cayeron al abismo con este tiro. La vida que perdieron no es daño que se cobre;
  // si los tiró otro, igual cuenta como kill (y como daño para la calma de la muerte súbita).
  const abyss = new Set<number>()
  for (const e of events) if (e.type === 'death' && e.cause === 'abyss') abyss.add(e.playerId)
  // plata de la ronda: daño a otros, kills y autodaño (v3: lo que hicieron las minas ya se lo cobró su dueño)
  let earned = 0
  // v2.2: solo el daño a OTRO tanque (o tirarlo al abismo) reinicia la calma; el autodaño no
  let damaged = [...abyss].some((id) => id !== shooter.id) || (mines?.toOthers ?? 0) > 0
  for (const p of next.players) {
    const b = before[p.id]
    if (!b.alive) continue
    const dmg = (abyss.has(p.id) ? hitBeforeFall(events, p.id) : b.hp - (p.hp + p.shield)) - (mines?.dealt.get(p.id) ?? 0)
    if (dmg > 0 && p.id !== shooter.id) damaged = true // el escudo cuenta: lo que absorbió también es daño
    if (p.id === shooter.id) earned += dmg * EARN.selfDamage
    else {
      earned += dmg * EARN.perDamage
      if (!p.alive && !mines?.killed.has(p.id)) {
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
  return { ...endTurn(next, events, flights, damaged), flights }
}

// ---------- líquidos (v4) ----------

// Segundos entre el último impacto (o quema) del tiro y el primer parche del flujo, y entre parches.
export const FLOW_DELAY = 0.15
export const FLOW_DT = 1 / 30

// Medición del costo del flujo (para sim-check; no afecta la simulación): fires, cuántos movieron
// algún líquido, ms totales y peor caso.
export const flowStats = { fires: 0, flows: 0, ms: 0, worst: 0 }

// Corre el flujo después de un fire. Siembra desde todo el mapa (no solo lo que tocó el tiro): así lo
// que haya quedado sin asentar en un flujo anterior cortado por el tope sigue cayendo. Emite un solo
// 'flow' (t después de todo lo del tiro, un parche cada FLOW_DT), un 'steam' por cuadro con reacción
// agua + lava y un 'burn' por cuadro en que la lava quemó algo; después asienta utilería y tanques
// (lo que la lava quemó puede dejarlos sin apoyo) con t = fin del flujo. Sin cambios, no emite nada.
function settleLiquids(state: GameState, events: GameEvent[], flights: Flight[]): void {
  takeDirty(state.terrain)
  const t0 = performance.now()
  const report = flowLiquids(state.terrain, { seed: null, record: true })
  const ms = performance.now() - t0
  flowStats.fires++
  flowStats.ms += ms
  flowStats.worst = Math.max(flowStats.worst, ms)
  if (!report.changed) return
  flowStats.flows++
  const t = shotEnd(events, flights) + FLOW_DELAY
  events.push({ type: 'flow', t, dt: FLOW_DT, patches: report.patches })
  for (const s of report.steam) events.push({ type: 'steam', x: Math.round(s.x), y: Math.round(s.y), n: s.n, t: t + s.frame * FLOW_DT })
  for (const b of report.burns) events.push({ type: 'burn', x: b.x, y: b.y, w: b.w, t: t + b.frame * FLOW_DT })
  settleAfterFlow(state, events, t + (report.patches.length - 1) * FLOW_DT)
}

// v3: daño (escudo incluido) que recibió un tanque en estos eventos antes de caer al abismo.
function hitBeforeFall(events: GameEvent[], id: number): number {
  let n = 0
  for (const e of events) {
    if (e.type === 'damage' && e.playerId === id) n += e.amount
    else if (e.type === 'shield' && e.playerId === id) n += e.absorbed
  }
  return n
}

// v3: si el tanque del turno avanza `steps` pasos de 1 px hacia dir (sin mirar el combustible), ¿alguno
// lo tira al abismo? La sesión lo usa para frenar al que camina hacia el borde manteniendo la tecla
// (tiene que soltar y volver a apretar para tirarse); la IA, para no acercarse nunca.
// Pulido v2: simula los pasos con move (escalones, paredes y deslizamientos incluidos): un paso que lo
// deja en una pendiente que lo hace resbalar al abismo también cuenta. Una pared corta la búsqueda.
export function abyssAhead(state: GameState, dir: -1 | 1, steps = 1): boolean {
  const p = state.players[state.current]
  const t = state.terrain
  if (!p || !t.pits) return false
  // atajo: sin columnas de abismo al alcance (pasos + un tanque + el deslizamiento más largo), no hay peligro
  const reach = steps + TANK_W + SLIDE_MAX
  const x0 = Math.max(0, Math.floor(p.x - (dir < 0 ? reach : TANK_W)))
  const x1 = Math.min(t.w - 1, Math.ceil(p.x + (dir > 0 ? reach : TANK_W)))
  let near = false
  for (let x = x0; x <= x1 && !near; x++) if (t.pits[x]) near = true
  if (!near) return false
  let s = shallow(state)
  s.players[s.current].fuel = Infinity
  for (let k = 1; k <= steps; k++) {
    const r = move(s, dir)
    if (r.state === s) return false
    if (r.events.some((e) => e.type === 'death' && e.playerId === p.id && e.cause === 'abyss')) return true
    s = r.state
  }
  return false
}

// ---------- muerte súbita (v2) ----------

// Segundos entre el último impacto del tiro y la subida de la lava (el playback la muestra después).
export const LAVA_DELAY = 0.4

// La muerte súbita está activa: la lava sube en cada turno, hasta que un tanque le pegue a otro (v2.2).
export function suddenDeath(state: GameState): boolean {
  return state.calm >= SUDDEN_DEATH_CALM
}

// Cierra el turno que termina con este fire (o pase sin munición, o muerte por caída al moverse):
// 1. cuenta de calma: sin daño a otro tanque suma 1; con daño a otro vuelve a 0, también con la muerte
//    súbita activa (v2.2): la lava se frena donde está y hacen falta SUDDEN_DEATH_CALM tiros sin daño
//    para que vuelva a subir. Emite 'calm' si cambió lo que falta.
// 2. si la muerte súbita está activa y la ronda sigue (2+ vivos), empieza el turno siguiente: la lava
//    aparece en el fondo (la primera vez) o sube LAVA_RISE, y quema LAVA_DAMAGE a cada tanque vivo con
//    el piso por debajo de la superficie. Esos eventos van al final, LAVA_DELAY s después del último
//    impacto (o del fin del vuelo).
// 3. advance: fin de ronda si queda uno o ninguno (todos quemados → empate), si no pasa el turno.
// La lava no da ni quita plata: el daño no es de nadie y una muerte por lava no cuenta como kill.
function endTurn(state: GameState, events: GameEvent[], flights: Flight[], damaged: boolean): StepResult {
  const leftBefore = Math.max(0, SUDDEN_DEATH_CALM - state.calm)
  state.calm = damaged ? 0 : Math.min(SUDDEN_DEATH_CALM, state.calm + 1)
  const left = Math.max(0, SUDDEN_DEATH_CALM - state.calm)
  if (left !== leftBefore) events.push({ type: 'calm', left })
  if (state.players.filter((p) => p.alive).length > 1) {
    const t = shotEnd(events, flights) + LAVA_DELAY
    if (suddenDeath(state)) riseLava(state, events)
    burnInLava(state, events, t)
    // v3: peligros (ácido al que empieza, minas vencidas)
    if (state.hazards.length > 0 && tickHazards(state, events, t, nextAlive(state)) > 0) {
      mineReactions(state, events, 0, () => false, t + MINE_DELAY)
      collapseAfterShot(state, events, shotEnd(events, flights) + COLLAPSE_DELAY, true)
      settleLiquids(state, events, flights)
      settleHazards(state, events, shotEnd(events, flights))
    }
  }
  return advance(state, events)
}

// Momento en que termina lo que se ve del tiro: el último evento con t o el final del último vuelo.
function shotEnd(events: GameEvent[], flights: Flight[]): number {
  let end = 0
  for (const f of flights) end = Math.max(end, (f.startT ?? 0) + Math.max(0, f.path.length - 1) * PATH_DT)
  for (const e of events) {
    if ('t' in e && typeof e.t === 'number') end = Math.max(end, e.t)
    // v4: el flujo dura un parche cada dt
    if (e.type === 'flow' || e.type === 'collapse') end = Math.max(end, e.t + Math.max(0, e.patches.length - 1) * e.dt) // v2.4: y el derrumbe
  }
  return end
}

function riseLava(state: GameState, events: GameEvent[]): void {
  const from = state.lava
  const to = Math.max(0, (from ?? state.height) - LAVA_RISE)
  state.lava = to
  events.push({ type: 'lava', from, to, warn: 0 })
}

// Al empezar el turno, LAVA_DAMAGE a cada tanque vivo con el piso por debajo de la banda de muerte
// súbita (si empezó) o (v4) con lava de la grilla bajo o dentro de su caja. Si las dos aplican, una vez.
// Si la lava lo cubre entero (la superficie de la banda queda por encima de la caja del tanque, o hay
// lava de la grilla en su fila de arriba), muere en el acto, con escudo o sin él.
// v5: la lava quema de a uno, del más hundido (piso más abajo) al menos hundido y, a la misma altura, del
// que tiene menos vida (con escudo) al que tiene más. Si iba a matar al último tanque en pie, ese turno no
// lo toca: gana la ronda el que aguantó más. Solo es empate si el último está igual de hundido y con la
// misma vida que uno que acaba de morir (no hay forma de decir quién aguantó más). Con 6 u 8 tanques los
// últimos suelen terminar en la misma meseta y la lava se los llevaba juntos: 1 de cada 4 rondas de 8
// terminaba en empate.
function burnInLava(state: GameState, events: GameEvent[], t: number): void {
  // v2.2: la banda queda aunque la muerte súbita se haya frenado
  const band = state.lava
  const victims = state.players.filter((p) => p.alive && ((band !== null && p.y > band) || inLava(state.terrain, p)))
  victims.sort((a, b) => b.y - a.y || a.hp + a.shield - (b.hp + b.shield) || a.id - b.id)
  let fallen: { y: number; life: number } | null = null // el último que mató esta quemadura (vida previa)
  for (const p of victims) {
    const life = p.hp + p.shield
    const engulfed = (band !== null && band <= p.y - TANK_H) || engulfedInLava(state.terrain, p)
    const dies = engulfed || life <= LAVA_DAMAGE
    const last = state.players.every((q) => q === p || !q.alive)
    if (dies && last && !(fallen && fallen.y === p.y && fallen.life === life)) continue
    const mark = events.length
    if (engulfed) kill(p, events, 'lava')
    else hurt(p, LAVA_DAMAGE, events)
    if (!p.alive) fallen = { y: p.y, life }
    for (let i = mark; i < events.length; i++) {
      const e = events[i]
      if (e.type === 'damage') {
        e.t = t
        e.cause = 'lava'
      } else if (e.type === 'death' || e.type === 'shield') e.t = t
    }
  }
}

// v3: el próximo tanque vivo en el orden de turnos (el que va a empezar), como lo elige advance.
function nextAlive(state: GameState): Player | undefined {
  for (let i = 1; i <= state.players.length; i++) {
    const p = state.players[(state.current + i) % state.players.length]
    if (p.alive) return p
  }
  return undefined
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
  // v2.2: el viento cambia por vuelta, cuando todos los vivos dispararon una vez
  state.windLeft -= 1
  const windChanged = state.windLeft <= 0
  if (windChanged) {
    const wind = irange(state.rng, -10, 10)
    state.wind = wind.value
    state.rng = wind.state
    state.windLeft = alive.length
  }
  state.turn += 1
  state.players[state.current].fuel = fuelFor(state.width)
  state.players[state.current].anchored = false // v3: el ancla dura hasta su próximo turno
  events.push({ type: 'turn', playerId: state.players[state.current].id })
  if (windChanged) events.push({ type: 'wind', value: state.wind })
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
