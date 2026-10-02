import { PATH_DT } from './ballistics'
import { generate } from './gen'
import { flowLiquids } from './flow'
import { engulfedInLava, hurt, inLava, kill, settleAfterFlow, settleTank, tankFloor } from './physics'
import { SLIDE_MAX, slopeAt, stepTank } from './slide'
import { resolveShot } from './weapons'
import { Rng, hashSeed, irange } from './rng'
import { aiShop, buyEntry, sellEntry, shopEntry } from './shop'
import { cloneTerrain, takeDirty } from './terrain'
import {
  BIOMES,
  CREWS,
  EARN,
  SLIDE_SLOPE,
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
  }
  setupRound(state)
  return state
}

// Mapa nuevo, tanques en sus posiciones, vida llena. Muta el estado.
function setupRound(state: GameState): void {
  const rng = new Rng(roundSeed(state.seed, state.round))
  const biome = biomeFor(state.biomeMode, state.seed, state.round)
  const gen = generate(biome, rng, state.players.length, state.width, state.height)
  state.biome = biome
  state.terrain = gen.terrain
  state.props = gen.props
  state.players.forEach((p, i) => {
    const x = gen.spawns[i]
    p.x = x
    p.y = tankFloor(gen.terrain, x, 0)
    p.hp = PLAYER_HP
    p.alive = true
    p.angle = x < state.width / 2 ? 55 : 125
    p.power = 60
    p.fuel = fuelFor(state.width)
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
  state.calm = 0
  state.lava = null
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
  else p.fuel += fuelFor(state.width)
  return { state: next, events: [{ type: 'item', playerId: p.id, item }] }
}

// F6: un paso de 1 px gastando combustible; sube escalones de hasta MAX_CLIMB, cae si el piso se va.
// Pulido v2: el paso usa las mismas reglas que el empuje (stepTank). Un paso que lo dejaría en una
// pendiente mayor que SLIDE_SLOPE cuesta arriba no se da (las orugas patinan: es como una pared); si la
// pendiente es cuesta abajo, después del paso se desliza (evento 'slide' con cause 'slope', sin t) y,
// si eso lo deja sin piso, cae. Los primeros MOVE_FREE_FALL px de una caída caminando no hacen daño.
export const MOVE_FREE_FALL = 12
function move(state: GameState, dir: -1 | 1): StepResult {
  const actor = state.players[state.current]
  if (actor.fuel <= 0 || (dir !== 1 && dir !== -1)) return { state, events: [] }
  const step = stepTank(state, actor, actor.x, actor.y, dir, tankFloor)
  if (!step) return { state, events: [] }
  if (!step.air && slopeAt(state, step.x, step.floor) * -dir > SLIDE_SLOPE) return { state, events: [] }
  // mover no toca el terreno ni la utilería: se comparten con el estado anterior
  const next = shallow(state)
  const p = next.players[next.current]
  const events: GameEvent[] = []
  p.x = step.x
  p.y = step.floor
  p.fuel -= 1
  // v3: si caminó (o se deslizó) hasta el abismo se cae (la sesión frena antes al que no lo hace a
  // propósito, ver abyssAhead; la IA nunca camina hacia un abismo). v4: al agua, sin daño ni paracaídas.
  settleTank(next, p, events, undefined, undefined, MOVE_FREE_FALL)
  // se mató cayendo: termina el turno como un tiro que dañó a un tanque
  if (!p.alive) return endTurn(next, events, [], true)
  return { state: next, events }
}

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
  const before = next.players.map((p) => ({ hp: p.hp + p.shield, alive: p.alive }))
  const { flights, events } = resolveShot(next, shooter, weapon)
  // v4: los líquidos corren y se asientan después de los impactos (y lo que eso derrumbe o queme)
  settleLiquids(next, events, flights)
  // v3: los que cayeron al abismo con este tiro. La vida que perdieron no es daño que se cobre;
  // si los tiró otro, igual cuenta como kill (y como daño para la calma de la muerte súbita).
  const abyss = new Set<number>()
  for (const e of events) if (e.type === 'death' && e.cause === 'abyss') abyss.add(e.playerId)
  // plata de la ronda: daño a otros, kills y autodaño
  let earned = 0
  let damaged = abyss.size > 0
  for (const p of next.players) {
    const b = before[p.id]
    if (!b.alive) continue
    const dmg = abyss.has(p.id) ? hitBeforeFall(events, p.id) : b.hp - (p.hp + p.shield)
    if (dmg > 0) damaged = true // el escudo cuenta: lo que absorbió también es daño
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

// La muerte súbita ya empezó: la lava sube en cada turno hasta el fin de la ronda.
export function suddenDeath(state: GameState): boolean {
  return state.calm >= SUDDEN_DEATH_CALM
}

// Cierra el turno que termina con este fire (o pase sin munición, o muerte por caída al moverse):
// 1. cuenta de calma: sin daño a ningún tanque suma 1, con daño vuelve a 0 (salvo muerte súbita ya
//    empezada, donde queda fija en SUDDEN_DEATH_CALM). Emite 'calm' si cambió lo que falta.
// 2. si la muerte súbita está activa y la ronda sigue (2+ vivos), empieza el turno siguiente: la lava
//    aparece en el fondo (la primera vez) o sube LAVA_RISE, y quema LAVA_DAMAGE a cada tanque vivo con
//    el piso por debajo de la superficie. Esos eventos van al final, LAVA_DELAY s después del último
//    impacto (o del fin del vuelo).
// 3. advance: fin de ronda si queda uno o ninguno (todos quemados → empate), si no pasa el turno.
// La lava no da ni quita plata: el daño no es de nadie y una muerte por lava no cuenta como kill.
function endTurn(state: GameState, events: GameEvent[], flights: Flight[], damaged: boolean): StepResult {
  const leftBefore = SUDDEN_DEATH_CALM - state.calm
  if (!suddenDeath(state)) state.calm = damaged ? 0 : state.calm + 1
  const left = Math.max(0, SUDDEN_DEATH_CALM - state.calm)
  if (left !== leftBefore) events.push({ type: 'calm', left })
  if (state.players.filter((p) => p.alive).length > 1) {
    const t = shotEnd(events, flights) + LAVA_DELAY
    if (suddenDeath(state)) riseLava(state, events)
    burnInLava(state, events, t)
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
    if (e.type === 'flow') end = Math.max(end, e.t + Math.max(0, e.patches.length - 1) * e.dt)
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
function burnInLava(state: GameState, events: GameEvent[], t: number): void {
  const band = suddenDeath(state) ? state.lava : null
  for (const p of state.players) {
    if (!p.alive) continue
    if (!((band !== null && p.y > band) || inLava(state.terrain, p))) continue
    const mark = events.length
    if ((band !== null && band <= p.y - TANK_H) || engulfedInLava(state.terrain, p)) kill(p, events, 'lava')
    else hurt(p, LAVA_DAMAGE, events)
    for (let i = mark; i < events.length; i++) {
      const e = events[i]
      if (e.type === 'damage') {
        e.t = t
        e.cause = 'lava'
      } else if (e.type === 'death' || e.type === 'shield') e.t = t
    }
  }
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
  state.players[state.current].fuel = fuelFor(state.width)
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
