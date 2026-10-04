// Pruebas de la simulación. npm run sim-check
import {
  AIR,
  BEAM,
  BEDROCK,
  BIOMES,
  BRICK,
  DIRT,
  MAX_CLIMB,
  METAL,
  POST,
  SLAT,
  STONE,
  TANK_H,
  TANK_HALF_W,
  TANK_W,
  WOOD,
  WATER,
  LAVA,
  WATER_BLAST_SCALE,
  WORLD_H,
  WORLD_W,
  LAVA_DAMAGE,
  LAVA_RISE,
  SUDDEN_DEATH_CALM,
  MAP_SIZES,
  MAP_SIZE_ORDER,
  MAX_PLAYERS,
  MAX_PLAYERS_BY_SIZE,
  TANK_COLORS,
  physicsFor,
  applyCommand,
  chooseShot,
  cloneState,
  createMatch,
  decodeState,
  encodeState,
  hashState as netHash,
  fly,
  isSolid,
  groundAt,
  muzzle,
  WEAPONS,
  WEAPON_ORDER,
  CREWS,
  CREW_NAMES,
  EARN,
  FUEL_PER_TURN,
  ITEM_ORDER,
  REPAIR_HP,
  SHIELD_HP,
  SHOP,
  START_MONEY,
  biomeFor,
  owned,
  roundSeed,
  abyssAhead,
  materialAt,
  ABYSS_DROP,
  tankFloor,
  KNOCKBACK_MAX,
  SLIDE_SLOPE,
  PARACHUTE_MIN_DAMAGE,
  PATH_DT,
  fuelFor,
  JETPACK_RANGE,
  STEER_RATE,
  STEER_TICK,
  type Biome,
  type Command,
  type Difficulty,
  type GameEvent,
  type GameState,
  type ItemId,
  type MapSize,
  type ShopId,
  type MatchConfig,
  type SlotConfig,
  type ShotPlan,
  type StepResult,
  type WeaponId,
} from '../src/sim'
import { tankTilt } from '../src/sim/tilt'
import { propSupported, resolveBlast, blastFor, collapseAfterShot } from '../src/sim/physics'
import { aiStats, lavaRisk } from '../src/sim/ai'
import { noisySteer, planSteer } from '../src/sim/ai-arsenal'
import { LAVA_DELAY } from '../src/sim/game'
import { skylineOf } from '../src/sim/ballistics'
import { resolveShot } from '../src/sim/weapons'
import { collapseStats } from '../src/sim/collapse'
import { generate, humanSafe, padBounds, SPAWN_PIT_GAP, SPAWN_GAP_CROWD, spawnStats, CORNICE_CRUST, CORNICE_LEN, CORNICE_SPAWN_FLAT, CORNICE_SPILL, type Generated } from '../src/sim/gen'
import { Rng } from '../src/sim/rng'
import { cloneTerrain, columnGround, createTerrain, deform, fillRect, hasLiquid } from '../src/sim/terrain'
import { applyPatch, flowLiquids, liquidVolume } from '../src/sim/flow'
import { flowStats } from '../src/sim/game'
import { inLava, inWater } from '../src/sim/physics'
import { slopeAt } from '../src/sim/slide'

function mk(bots: number, difficulty: Difficulty, biome: MatchConfig['biome'], seed: number, rounds = 1, humans = 0, size?: MapSize): MatchConfig {
  const slots: SlotConfig[] = []
  for (let i = 0; i <= bots; i++) slots.push({ kind: i < humans ? 'human' : 'ai' })
  const cfg: MatchConfig = { slots, rounds, difficulty, biome, seed }
  if (size) cfg.size = size
  return cfg
}

let failures = 0
let checks = 0
function check(cond: boolean, msg: string): void {
  checks++
  if (!cond) {
    failures++
    console.error('FALLA: ' + msg)
  }
}

function hashState(s: GameState): string {
  let h = 0x811c9dc5
  const mix = (b: number) => {
    h ^= b & 0xff
    h = Math.imul(h, 0x01000193)
  }
  for (const b of s.terrain.front) mix(b)
  for (const b of s.terrain.back) mix(b)
  const rest = JSON.stringify({ ...s, terrain: null })
  for (let i = 0; i < rest.length; i++) mix(rest.charCodeAt(i))
  return (h >>> 0).toString(16)
}

function count(s: GameState, m: number): number {
  let n = 0
  for (const b of s.terrain.front) if (b === m) n++
  return n
}

// Un turno de IA completo: moverse (si el plan lo pide), elegir arma, apuntar y disparar.
function aiTurn(state: GameState, difficulty: Difficulty): StepResult & { ms: number; plan: ShotPlan } {
  const p = state.players[state.current]
  const t0 = performance.now()
  const plan = chooseShot(state, difficulty)
  const ms = performance.now() - t0
  const pre: GameEvent[] = []
  for (const item of plan.items ?? []) {
    // v3: jetpack y teletransporte con su destino
    const target = item === 'jetpack' || item === 'teleport' ? plan.itemTarget : undefined
    const r = applyCommand(state, { type: 'useItem', playerId: p.id, item, target })
    pre.push(...r.events)
    state = r.state
  }
  for (let i = 0; i < Math.abs(plan.move ?? 0); i++) {
    const r = applyCommand(state, { type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 })
    pre.push(...r.events)
    state = r.state
  }
  if (state.current !== p.id || state.phase !== 'aiming') return { state, events: pre, ms, plan }
  state = applyCommand(state, { type: 'selectWeapon', playerId: p.id, weapon: plan.weapon }).state
  state = applyCommand(state, { type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power }).state
  const r = applyCommand(state, { type: 'fire', playerId: p.id })
  // v3: teledirigido: las correcciones del plan (en tandas de 2 ticks, como la red), ceros si se acaban
  if (r.state.phase === 'guiding') {
    const ev = [...pre, ...r.events]
    const flights = [...(r.flights ?? [])]
    let st = r.state
    const steer = plan.steer ?? []
    for (let i = 0; i < 60 && st.phase === 'guiding'; i += 2) {
      const dirs = [steer[i] ?? 0, steer[i + 1] ?? 0]
      const rr = applyCommand(st, { type: 'steer', playerId: p.id, dirs })
      ev.push(...rr.events)
      flights.push(...(rr.flights ?? []))
      st = rr.state
    }
    return { state: st, events: ev, flights, ms, plan }
  }
  return { ...r, events: [...pre, ...r.events], ms, plan }
}

function playTurns(s: GameState, turns: number, difficulty: Difficulty = 'normal'): { state: GameState; events: GameEvent[] } {
  let state = s
  const events: GameEvent[] = []
  for (let i = 0; i < turns && state.phase === 'aiming'; i++) {
    const r = aiTurn(state, difficulty)
    state = r.state
    events.push(...r.events)
  }
  return { state, events }
}

let worstMs = 0
function flat(): GameState {
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4)))
  s.terrain.front.fill(AIR)
  s.terrain.back.fill(AIR)
  fillRect(s.terrain, 0, 300, WORLD_W - 1, WORLD_H - 1, DIRT, 'both')
  s.props = []
  s.players[0].x = 200
  s.players[1].x = 600
  for (const p of s.players) p.y = 300
  for (const p of s.players) for (const id of WEAPON_ORDER) p.ammo[id] = WEAPONS[id].ammo
  s.current = 0
  return s
}
function shoot(s: GameState, weapon: WeaponId, angle: number, power: number): StepResult {
  s = applyCommand(s, { type: 'selectWeapon', playerId: s.players[s.current].id, weapon }).state
  s = applyCommand(s, { type: 'aim', playerId: s.players[s.current].id, angle, power }).state
  return applyCommand(s, { type: 'fire', playerId: s.players[s.current].id })
}
const impactsOf = (r: StepResult) => r.events.filter((e): e is Extract<GameEvent, { type: 'impact' }> => e.type === 'impact')
const PIT0 = 700
const PIT1 = 779
function pitMap(): GameState {
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4, 1, 0, 'medium')))
  const t = s.terrain
  t.front.fill(AIR)
  t.back.fill(AIR)
  fillRect(t, 0, 300, t.w - 1, t.h - 1, DIRT, 'both')
  fillRect(t, 0, t.h - 3, t.w - 1, t.h - 1, BEDROCK, 'both')
  t.pits = new Uint8Array(t.w)
  fillRect(t, PIT0, 308, PIT1, t.h - 1, AIR)
  for (let x = PIT0; x <= PIT1; x++) t.pits[x] = 1
  s.props = []
  s.players[0].x = 400
  s.players[1].x = 740
  for (const p of s.players) p.y = 300
  for (const p of s.players) for (const id of WEAPON_ORDER) p.ammo[id] = WEAPONS[id].ammo
  s.current = 0
  return s
}
type FallEv = Extract<GameEvent, { type: 'fall' }>
type DeathEv = Extract<GameEvent, { type: 'death' }>
const countT = (t: { front: Uint8Array }, m: number) => {
  let n = 0
  for (const b of t.front) if (b === m) n++
  return n
}
const sameGrid = (a: { front: Uint8Array; back: Uint8Array }, b: { front: Uint8Array; back: Uint8Array }) =>
  a.front.length === b.front.length && a.front.every((v, i) => v === b.front[i]) && a.back.every((v, i) => v === b.back[i])
// Mapa de prueba v4 (Mediano, 1600×450): llano de tierra en y 300 hasta x 724 y otro más bajo en y 380
// desde x 725. Pileta [600, 700) de `depth` px de hondo desde y 300 con el líquido m (back de tierra) y
// pared de tierra [700, 724]. Jugador 0 en x 300 (arriba), jugador 1 en x 1200 (abajo).
function poolMap(m: number, depth = 40): GameState {
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4, 1, 0, 'medium')))
  const t = s.terrain
  t.front.fill(AIR)
  t.back.fill(AIR)
  t.pits = new Uint8Array(t.w)
  fillRect(t, 0, 300, 724, t.h - 1, DIRT, 'both')
  fillRect(t, 725, 380, t.w - 1, t.h - 1, DIRT, 'both')
  fillRect(t, 0, t.h - 3, t.w - 1, t.h - 1, BEDROCK, 'both')
  fillRect(t, 600, 300, 699, 300 + depth - 1, m)
  s.props = []
  s.players[0].x = 300
  s.players[0].y = 300
  s.players[1].x = 1200
  s.players[1].y = 380
  for (const p of s.players) for (const id of WEAPON_ORDER) p.ammo[id] = WEAPONS[id].ammo
  s.current = 0
  s.wind = 0
  return s
}
type CollapseEv = Extract<GameEvent, { type: 'collapse' }>
const collapsesOf = (ev: GameEvent[]) => ev.filter((e): e is CollapseEv => e.type === 'collapse')
// El tiro (ángulo y potencia, sin viento) cuyo impacto cae más cerca de (x, y). Grilla gruesa y después fina.
function aimAt(s: GameState, x: number, y: number, lo = 5, hi = 175): { angle: number; power: number; d: number } {
  const p = s.players[s.current]
  let best = { angle: 90, power: 50, d: Infinity }
  const at = (angle: number, power: number) => {
    const f = fly({ terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle, power, wind: 0, lava: s.lava ?? undefined })
    const d = Math.hypot(f.impact.x - x, f.impact.y - y)
    if (d < best.d) best = { angle, power, d }
  }
  for (let a = lo; a <= hi; a += 2) for (let pw = 10; pw <= 100; pw += 2) at(a, pw)
  const b0 = best
  for (let a = b0.angle - 2; a <= b0.angle + 2; a += 0.25) for (let pw = b0.power - 2; pw <= b0.power + 2; pw += 0.25) at(a, pw)
  return best
}
const countIn = (t: { w: number; front: Uint8Array }, m: number, x0: number, y0: number, x1: number, y1: number) => {
  let n = 0
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (t.front[y * t.w + x] === m) n++
  return n
}
// ---------- 20. v3 sim-armas: armas nuevas, teledirigido, ítems, minas y ácido ----------
type HazardEv = Extract<GameEvent, { type: 'hazard' }>
type SlideEv = Extract<GameEvent, { type: 'slide' }>
const hazardsOf = (ev: GameEvent[]) => ev.filter((e): e is HazardEv => e.type === 'hazard')
// flat() con munición de todo y los ítems nuevos
function armed(): GameState {
  const s = flat()
  for (const p of s.players) {
    for (const id of WEAPON_ORDER) p.ammo[id] = Math.max(p.ammo[id], 5)
    for (const id of ITEM_ORDER) p.items[id] = 3
  }
  s.wind = 0 // aimAt apunta sin viento
  return s
}
// pasa el turno del que tiene el turno con un tiro inofensivo (para volver a P0 o hacer correr los turnos)
function pass(s: GameState): StepResult {
  const id = s.players[s.current].id
  const x = s.players[s.current].x
  // tiro al costado de afuera del mapa
  return shoot(s, 'normal', x < s.width / 2 ? 175 : 5, 100)
}
// tiro que cae cerca de (x, y) con el arma (vuelo normal), desde P0
function shootAt(s: GameState, weapon: WeaponId, x: number, y: number, lo = 5, hi = 175): StepResult & { d: number } {
  const a = aimAt(s, x, y, lo, hi)
  return { ...shoot(s, weapon, a.angle, a.power), d: a.d }
}
check(WEAPON_ORDER.length === 16 && new Set(WEAPON_ORDER).size === 16, 'v3: WEAPON_ORDER tiene las 16 armas')
for (const id of WEAPON_ORDER) if (id !== 'normal') check(SHOP.some((e) => e.id === id && e.kind === 'weapon'), `v3 tienda: falta ${id}`)
for (const id of ITEM_ORDER) check(SHOP.some((e) => e.id === id && e.kind === 'item'), `v3 tienda: falta el ítem ${id}`)
{
  // rebotadora: una explosión 'spark' por rebote y una final 'fire'; cada tramo arranca después del anterior
  const bounceMap = () => {
    const b = armed()
    b.players[1].x = 760
    return b
  }
  const s = bounceMap()
  const r = shoot(s, 'bouncer', 60, 45)
  const imps = impactsOf(r)
  const n = WEAPONS.bouncer.bounces ?? 0
  check(imps.length >= 2 && imps.length <= n + 1, `rebotadora: ${imps.length} explosiones (esperaba 2..${n + 1})`)
  check(imps.slice(0, -1).every((e) => e.blast === 'spark') && imps[imps.length - 1]?.blast === 'fire', 'rebotadora: rebotes spark y final fire')
  const st = r.flights!.map((f) => f.startT ?? 0)
  check(r.flights!.length === imps.length && st.every((t, i) => i === 0 || t > st[i - 1]), 'rebotadora: un tramo por rebote, en orden')
  check(imps.every((e, i) => i === 0 || e.t > imps[i - 1].t), 'rebotadora: explosiones en orden')
  check(netHash(shoot(bounceMap(), 'bouncer', 60, 45).state) === netHash(r.state), 'rebotadora: determinista')
}
{
  // láser: recto, sin gravedad; atraviesa una pared fina de tierra; frena en piedra
  const s = armed()
  s.players[1].x = 420
  fillRect(s.terrain, 300, 240, 309, 299, DIRT, 'both')
  // ángulo hacia el centro de P1
  const m = muzzle(200, 300, 0)
  const a = (Math.atan2(-(290 - m.y), 420 - m.x) * 180) / Math.PI
  const r = shoot(s, 'laser', a, 50)
  const beam = r.events.find((e): e is Extract<GameEvent, { type: 'beam' }> => e.type === 'beam')
  check(!!beam && beam.t === 0, 'láser: evento beam')
  check(r.events.some((e) => e.type === 'damage' && e.playerId === 1 && e.amount === WEAPONS.laser.damage), `láser: pega directo a través de la pared de tierra (${JSON.stringify(r.events.filter((e) => e.type === 'damage'))})`)
  check(countIn(r.state.terrain, DIRT, 300, 240, 309, 299) < countIn(s.terrain, DIRT, 300, 240, 309, 299) - 20, 'láser: abre un agujero en la tierra')
  const s2 = armed()
  s2.players[1].x = 420
  fillRect(s2.terrain, 300, 240, 309, 299, STONE, 'both')
  const r2 = shoot(s2, 'laser', a, 50)
  check(!r2.events.some((e) => e.type === 'damage' && e.playerId === 1), 'láser: la piedra lo frena')
  const i2 = impactsOf(r2)[0]
  check(!!i2 && i2.x >= 298 && i2.x <= 302, `láser: impacto en la piedra (${i2?.x.toFixed(1)})`)
  // tierra gruesa (más de LASER_SOFT): también lo frena
  const s3 = armed()
  s3.players[1].x = 420
  fillRect(s3.terrain, 300, 240, 369, 299, DIRT, 'both')
  check(!shoot(s3, 'laser', a, 50).events.some((e) => e.type === 'damage' && e.playerId === 1), 'láser: no perfora una montaña')
  // sin gravedad: tirado a 0° sigue a la altura de la boca
  const s4 = armed()
  s4.players[1].x = 700
  const r4 = shoot(s4, 'laser', 0, 50)
  const b4 = r4.events.find((e): e is Extract<GameEvent, { type: 'beam' }> => e.type === 'beam')
  check(!!b4 && Math.abs(b4.y1 - b4.y0) < 0.01 && b4.x1 - b4.x0 > 300, 'láser: recto y largo')
}
{
  // mina: queda clavada; un tanque que se mueve a su radio la dispara; al vencer explota
  const s = armed()
  s.players[1].x = 480
  const r = shootAt(s, 'mine', 440, 300)
  const placed = hazardsOf(r.events).filter((e) => e.action === 'place')
  check(placed.length === 1 && r.state.hazards.length === 1 && r.state.hazards[0].kind === 'mine', `mina: queda en el mapa (d ${r.d.toFixed(1)})`)
  check(!r.events.some((e) => e.type === 'damage'), 'mina: plantarla no hace daño')
  const mine = r.state.hazards[0]
  check(!!mine && Math.abs(mine.y - 300) <= 2, `mina: sobre el piso (y ${mine?.y})`)
  // P1 camina hacia la mina
  let c = r.state
  const ev: GameEvent[] = []
  for (let i = 0; i < 30 && c.current === 1 && c.hazards.length > 0; i++) {
    const rr = applyCommand(c, { type: 'move', playerId: 1, dir: -1 })
    ev.push(...rr.events)
    c = rr.state
  }
  check(hazardsOf(ev).some((e) => e.action === 'trigger') && c.hazards.length === 0, 'mina: la pisa al moverse y explota')
  check(ev.some((e) => e.type === 'damage' && e.playerId === 1), 'mina: daña al que la pisa')
  check(c.earnings[0] > 0, `mina: la plata es del dueño (${c.earnings[0]})`)
  // una mina pegada a un tanque que lo empujan: explota
  const s2 = armed()
  s2.players[1].x = 480
  s2.hazards = [{ id: 0, kind: 'mine', ownerId: 1, x: 460, y: 300, radius: 14, turns: 9 }]
  const r2 = shootAt(s2, 'normal', 500, 300, 5, 90)
  check(hazardsOf(r2.events).some((e) => e.action === 'trigger'), `mina: el empujón la dispara (${r2.state.players[1].x})`)
  // vence: con turns 1 explota al cambiar el turno
  const s3 = armed()
  s3.hazards = [{ id: 3, kind: 'mine', ownerId: 1, x: 400, y: 300, radius: 14, turns: 1 }]
  const r3 = pass(s3)
  check(hazardsOf(r3.events).some((e) => e.action === 'trigger' && e.hazard.id === 3) && r3.state.hazards.length === 0, 'mina: explota al vencer')
  // un tanque que estaba adentro cuando cayó no la dispara hasta moverse
  const s4 = armed()
  s4.players[1].x = 480
  const r4 = shootAt(s4, 'mine', 480, 280)
  check(r4.state.hazards.length === 1 && !hazardsOf(r4.events).some((e) => e.action === 'trigger'), 'mina: pegarle a un tanque la planta a sus pies')
}
{
  // ácido: rompe piedra y metal; deja un charco que daña al empezar el turno del que está adentro
  const s = armed()
  s.players[1].x = 600
  fillRect(s.terrain, 380, 280, 420, 299, METAL, 'both')
  const metal0 = count(s, METAL)
  const r = shootAt(s, 'acid', 400, 280)
  check(count(r.state, METAL) < metal0 - 300, `ácido: rompe el metal (${metal0} → ${count(r.state, METAL)})`)
  const n = shootAt(s, 'normal', 400, 280)
  check(count(n.state, METAL) > count(r.state, METAL) + 200, 'ácido: rompe más que la normal')
  check(r.state.hazards.some((h) => h.kind === 'acid'), 'ácido: deja un charco')
  // charco bajo P1: al empezar su turno pierde ACID_DAMAGE
  const s2 = armed()
  s2.hazards = [{ id: 0, kind: 'acid', ownerId: 0, x: 600, y: 300, radius: 18, turns: 4 }]
  const r2 = pass(s2)
  check(r2.events.some((e) => e.type === 'damage' && e.playerId === 1 && e.amount === 10) && hazardsOf(r2.events).some((e) => e.action === 'trigger'), 'ácido: daña al que empieza el turno adentro')
  check(r2.state.earnings[0] > 0, 'ácido: el daño es plata del dueño')
  let c = r2.state
  for (let i = 0; i < 6; i++) c = pass(c).state
  check(c.hazards.length === 0, 'ácido: se seca')
  // bajo el agua no deja charco
  const sw = poolMap(WATER)
  sw.players[0].x = 500
  for (const p of sw.players) p.ammo.acid = 2
  const aw = aimAt(sw, 650, 330, 20, 85)
  const rw = shoot(sw, 'acid', aw.angle, aw.power)
  check(rw.state.hazards.length === 0, 'ácido: en el agua se diluye')
}
{
  // terremoto: derrumba una ladera, sacude tanques (slide 'quake') y emite 'quake' + 'collapse'
  const s = armed()
  s.players[1].x = 520
  // loma empinada al lado de P1
  for (let x = 420; x < 500; x++) fillRect(s.terrain, x, 300 - Math.min(80, (x - 420) * 2), x, 299, DIRT, 'both')
  const before = s.terrain.front.slice()
  const r = shootAt(s, 'quake', 470, 260, 5, 90)
  check(r.events.some((e) => e.type === 'quake'), 'terremoto: evento quake')
  check(collapsesOf(r.events).length >= 1, 'terremoto: derrumbe animado')
  let moved = 0
  for (let i = 0; i < before.length; i++) if (before[i] !== r.state.terrain.front[i]) moved++
  check(moved > 200, `terremoto: mueve el terreno (${moved} celdas)`)
  check(r.events.some((e) => e.type === 'slide' && e.cause === 'quake'), 'terremoto: sacude tanques')
  check(netHash(shootAt(s, 'quake', 470, 260, 5, 90).state) === netHash(r.state), 'terremoto: determinista')
}
{
  // agujero negro: atrae al rival hacia el centro; con un abismo al lado, lo tira
  const s = armed()
  s.players[1].x = 560
  const r = shootAt(s, 'blackhole', 500, 300, 5, 90)
  const sl = r.events.find((e): e is SlideEv => e.type === 'slide' && e.cause === 'pull' && e.playerId === 1)
  check(r.events.some((e) => e.type === 'pull'), 'agujero negro: evento pull')
  check(!!sl && r.state.players[1].x < 560, `agujero negro: atrae al rival (${r.state.players[1].x})`)
  check(r.state.players[1].x >= impactsOf(r)[0].x - 1, 'agujero negro: no lo pasa del centro')
  const p = pitMap()
  for (const q of p.players) q.ammo.blackhole = 2
  p.players[1].x = 800
  const rp = shootAt(p, 'blackhole', PIT1 + 4, 300, 5, 90)
  check(rp.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss'), `agujero negro: lo arrastra al abismo (x ${rp.state.players[1].x}, d ${rp.d.toFixed(1)})`)
  // anclado no se mueve
  const pa = pitMap()
  for (const q of pa.players) q.ammo.blackhole = 2
  pa.players[1].x = 800
  pa.players[1].anchored = true
  const ra = shootAt(pa, 'blackhole', PIT1 + 4, 300, 5, 90)
  check(ra.state.players[1].alive && ra.state.players[1].x === 800, 'ancla: el agujero negro no lo mueve')
}
{
  // muro: pared fina y alta de tierra donde cae; frena un tiro bajo
  const s = armed()
  const r = shootAt(s, 'wall', 400, 300, 5, 90)
  const t = r.state.terrain
  let tall = 0
  for (let y = 300 - 2 * WEAPONS.wall.radius; y < 300; y++) if (isSolid(t, Math.round(impactsOf(r)[0].x), y)) tall++
  check(tall >= 2 * WEAPONS.wall.radius - 6, `muro: alto (${tall})`)
  check(!isSolid(t, Math.round(impactsOf(r)[0].x) + 12, 280), 'muro: fino')
  check(!r.events.some((e) => e.type === 'damage'), 'muro: no hace daño')
  // P1 le tira plano a P0 y el muro lo frena
  let c = r.state
  const hit = shoot(c, 'normal', 175, 70)
  c = hit.state
  check(!hit.events.some((e) => e.type === 'damage' && e.playerId === 0), 'muro: frena un tiro bajo')
}
{
  // deflector: el impacto directo se desvía hacia arriba y se gasta
  const s = armed()
  s.players[1].x = 480
  s.players[1].deflector = true
  const a = aimAt(s, 480, 290, 20, 80)
  const r = shoot(s, 'heavy', a.angle, a.power)
  check(r.events.some((e) => e.type === 'deflect' && e.playerId === 1), 'deflector: evento deflect')
  check(!r.state.players[1].deflector, 'deflector: se gasta')
  const dmg = r.events.filter((e) => e.type === 'damage' && e.playerId === 1).reduce((n, e) => n + (e.type === 'damage' ? e.amount : 0), 0)
  check(dmg < WEAPONS.heavy.damage, `deflector: no recibe el impacto directo (${dmg})`)
  check(r.flights!.length >= 2, 'deflector: el proyectil sigue en otro tramo')
  // láser reflejado
  const s2 = armed()
  s2.players[1].x = 420
  s2.players[1].deflector = true
  const m = muzzle(200, 300, 0)
  const la = (Math.atan2(-(290 - m.y), 420 - m.x) * 180) / Math.PI
  const r2 = shoot(s2, 'laser', la, 50)
  check(r2.events.filter((e) => e.type === 'beam').length === 2 && !r2.events.some((e) => e.type === 'damage' && e.playerId === 1), 'deflector: refleja el láser')
}
{
  // ancla: sin empuje hasta su próximo turno; anclado no camina
  const s = armed()
  s.players[1].x = 480
  s.current = 1
  const an = applyCommand(s, { type: 'useItem', playerId: 1, item: 'anchor' })
  check(an.state.players[1].anchored && an.state.current === 1 && an.events.some((e) => e.type === 'item'), 'ancla: se activa sin gastar el turno')
  check(applyCommand(an.state, { type: 'move', playerId: 1, dir: 1 }).state === an.state, 'ancla: anclado no camina')
  const t1 = pass(an.state).state
  check(t1.current === 0 && t1.players[1].anchored, 'ancla: dura hasta su turno')
  const a = aimAt(t1, 480, 290, 20, 80)
  const r = shoot(t1, 'heavy', a.angle, a.power)
  check(!r.events.some((e) => e.type === 'slide' && e.playerId === 1) && r.state.players[1].x === 480, 'ancla: el impacto no lo empuja')
  check(r.state.current === 1 && !r.state.players[1].anchored, 'ancla: se suelta al empezar su turno')
}
{
  // jetpack: salta a un destino dentro del rango (arco), sin gastar el turno; fuera de rango o adentro del
  // terreno no hace nada; sin piso, cae
  const s = armed()
  fillRect(s.terrain, 120, 240, 160, 299, DIRT, 'both') // meseta a la izquierda
  const r = applyCommand(s, { type: 'useItem', playerId: 0, item: 'jetpack', target: { x: 140, y: 240 } })
  const jp = r.events.find((e): e is Extract<GameEvent, { type: 'jetpack' }> => e.type === 'jetpack')
  check(!!jp && r.state.players[0].x === 140 && r.state.players[0].y === 240 && r.state.current === 0, `jetpack: salta a la meseta (${r.state.players[0].x}, ${r.state.players[0].y})`)
  check(!!jp && Math.min(...jp.path.map((p) => p.y)) < 240 - 20, 'jetpack: en arco')
  check(r.state.players[0].items.jetpack === 2, 'jetpack: se gasta')
  check(applyCommand(s, { type: 'useItem', playerId: 0, item: 'jetpack', target: { x: 200 + JETPACK_RANGE + 30, y: 300 } }).state === s, 'jetpack: fuera de rango no')
  check(applyCommand(s, { type: 'useItem', playerId: 0, item: 'jetpack', target: { x: 140, y: 280 } }).state.players[0].y === 240, 'jetpack: un destino dentro del terreno se apoya arriba')
  check(applyCommand(s, { type: 'useItem', playerId: 0, item: 'jetpack', target: { x: 260, y: 360 } }).state === s, 'jetpack: adentro del terreno no')
  const air = applyCommand(s, { type: 'useItem', playerId: 0, item: 'jetpack', target: { x: 260, y: 220 } })
  check(air.state.players[0].y === 300 && air.events.some((e) => e.type === 'fall'), 'jetpack: sin piso, cae')
  // teletransporte: lejos, evento teleport; al lado de una mina, la dispara
  const tp = applyCommand(s, { type: 'useItem', playerId: 0, item: 'teleport', target: { x: 520, y: 300 } })
  check(tp.events.some((e) => e.type === 'teleport') && tp.state.players[0].x === 520 && tp.state.current === 0, 'teleport: aparece en el destino')
  check(applyCommand(s, { type: 'useItem', playerId: 0, item: 'teleport', target: { x: 600, y: 300 } }).state === s, 'teleport: no se mete en otro tanque')
  const sm = armed()
  sm.hazards = [{ id: 0, kind: 'mine', ownerId: 1, x: 400, y: 300, radius: 14, turns: 9 }]
  const tm = applyCommand(sm, { type: 'useItem', playerId: 0, item: 'teleport', target: { x: 410, y: 300 } })
  check(hazardsOf(tm.events).some((e) => e.action === 'trigger') && tm.events.some((e) => e.type === 'damage' && e.playerId === 0), 'teleport: cae al lado de una mina y explota')
  const anc = applyCommand(applyCommand(s, { type: 'useItem', playerId: 0, item: 'anchor' }).state, { type: 'useItem', playerId: 0, item: 'jetpack', target: { x: 140, y: 240 } })
  check(anc.state.players[0].x === 200, 'jetpack: anclado no salta')
}
// teledirigido
function guidedShot(s: GameState, angle = 60, power = 62): StepResult {
  return shoot(s, 'guided', angle, power)
}
{
  const s = armed()
  const r = guidedShot(s)
  check(r.state.phase === 'guiding' && !!r.state.guided && r.events.some((e) => e.type === 'guide'), 'teledirigido: al apogeo queda en guiding')
  check(r.state.guided!.guide > 1.4 && r.flights!.length === 1, 'teledirigido: vuelo hasta el apogeo')
  check(applyCommand(r.state, { type: 'aim', playerId: 0, angle: 10, power: 10 }).state === r.state, 'teledirigido: en guiding no se apunta')
  check(applyCommand(r.state, { type: 'steer', playerId: 1, dirs: [1] }).state === r.state, 'teledirigido: solo el dueño dirige')
  // determinismo por tandas: de a 1, de a 2 y todo junto dan lo mismo
  const dirs: (-1 | 0 | 1)[] = []
  for (let i = 0; i < 30; i++) dirs.push(i < 10 ? 1 : i < 18 ? 0 : -1)
  const runIn = (chunk: number) => {
    let c = r.state
    const ev: GameEvent[] = []
    let i = 0
    let n = 0
    while (c.phase === 'guiding' && n++ < 100) {
      const rr = applyCommand(c, { type: 'steer', playerId: 0, dirs: dirs.slice(i, i + chunk).length ? dirs.slice(i, i + chunk) : [0] })
      ev.push(...rr.events)
      c = rr.state
      i += chunk
    }
    return { c, ev }
  }
  const a1 = runIn(1)
  const a2 = runIn(2)
  const a30 = runIn(30)
  check(a1.c.phase === 'aiming' && a1.c.current === 1 && a1.c.guided === null, 'teledirigido: termina el turno')
  check(netHash(a1.c) === netHash(a2.c) && netHash(a1.c) === netHash(a30.c), 'teledirigido: mismo resultado en tandas de 1, 2 y 30')
  check(a1.ev.some((e) => e.type === 'impact') && a1.ev.some((e) => e.type === 'turn'), 'teledirigido: explota y pasa el turno')
  const imp = a1.ev.find((e): e is Extract<GameEvent, { type: 'impact' }> => e.type === 'impact')
  check(!!imp && imp.t > r.state.guided!.t, 'teledirigido: tiempos desde el disparo')
  // réplica: snapshot en guiding
  const mid = applyCommand(r.state, { type: 'steer', playerId: 0, dirs: dirs.slice(0, 5) }).state
  const copy = decodeState(encodeState(mid))
  check(netHash(copy) === netHash(mid) && copy.phase === 'guiding', 'teledirigido: el snapshot en guiding es idéntico')
  const end1 = applyCommand(mid, { type: 'steer', playerId: 0, dirs: dirs.slice(5) }).state
  const end2 = applyCommand(copy, { type: 'steer', playerId: 0, dirs: dirs.slice(5) }).state
  check(netHash(end1) === netHash(end2), 'teledirigido: la réplica desde el snapshot termina igual')
  // giro limitado: con todo a un lado la dirección cambia a lo sumo STEER_RATE · tiempo (+ temblor y gravedad)
  const g0 = r.state.guided!
  const turnOf = (d: -1 | 0 | 1, n: number) => {
    const c = applyCommand(r.state, { type: 'steer', playerId: 0, dirs: new Array(n).fill(d) }).state
    return c.guided ? Math.atan2(c.guided.vy, c.guided.vx) : NaN
  }
  const h0 = turnOf(0, 6)
  const hR = turnOf(1, 6)
  const hL = turnOf(-1, 6)
  const lim = STEER_RATE * 6 * STEER_TICK
  check(Math.abs(hR - h0 - lim) < 0.08 && Math.abs(h0 - hL - lim) < 0.08, `teledirigido: giro limitado (${(hR - h0).toFixed(3)} / ${(h0 - hL).toFixed(3)}, esperaba ${lim.toFixed(3)})`)
  check(g0.seed !== 0, 'teledirigido: temblor con seed')
  // el temblor existe: sin correcciones, dos seeds distintas caen en lugares distintos
  const ws = r.state
  const alt = { ...ws, guided: { ...ws.guided!, seed: ws.guided!.seed ^ 0x5bd1e995 } }
  const ia = impactsOf(applyCommand(ws, { type: 'steer', playerId: 0, dirs: new Array(30).fill(0) }))[0]
  const ib = impactsOf(applyCommand(alt, { type: 'steer', playerId: 0, dirs: new Array(30).fill(0) }))[0]
  check(!!ia && !!ib && Math.abs(ia.x - ib.x) > 2, `teledirigido: el temblor cambia el impacto (${ia?.x.toFixed(1)} / ${ib?.x.toFixed(1)})`)
  // chocar en el ascenso: explota como un tiro normal sin guiado
  const sw = armed()
  fillRect(sw.terrain, 230, 200, 240, 299, STONE, 'both')
  const rw = guidedShot(sw, 30, 60)
  check(rw.state.phase === 'aiming' && impactsOf(rw).length === 1, 'teledirigido: si choca antes del apogeo, explota')
}
{
  // precisión: ni la IA difícil ni un guiado "perfecto" (corrige cada tick viendo dónde está, sin saber el
  // temblor que viene) pegan siempre. Blanco a 300-460 px, tiro inicial con el error de la normal.
  let aiHit = 0
  let perfect = 0
  let none = 0
  const N = 24
  for (let k = 0; k < N; k++) {
    const s = armed()
    s.wind = (k % 7) - 3
    s.players[1].x = 500 + (k % 5) * 40
    // tiro base que pega, con error de ±7° / ±8
    const a = aimAt(s, s.players[1].x, 290, 20, 85)
    const rng = new Rng(1000 + k)
    const angle = a.angle + (rng.next() * 2 - 1) * 7
    const power = a.power + (rng.next() * 2 - 1) * 8
    const r = guidedShot(s, angle, power)
    if (r.state.phase !== 'guiding') continue
    const hitP1 = (ev: GameEvent[]) => ev.some((e) => e.type === 'damage' && e.playerId === 1 && e.amount >= WEAPONS.guided.damage * 0.95)
    // sin guiar
    if (hitP1(applyCommand(r.state, { type: 'steer', playerId: 0, dirs: new Array(30).fill(0) }).events)) none++
    // IA difícil: plan de una (sin temblor) con su error de dirección
    const g = r.state.guided!
    const plan = noisySteer(planSteer(r.state, g, r.state.players[1]), 'hard', () => rng.next())
    if (hitP1(applyCommand(r.state, { type: 'steer', playerId: 0, dirs: plan }).events)) aiHit++
    // perfecto: replanifica cada tick con la posición real
    let c = r.state
    const ev: GameEvent[] = []
    for (let i = 0; i < 40 && c.phase === 'guiding'; i++) {
      const d = planSteer(c, c.guided!, c.players[1])[0] ?? 0
      const rr = applyCommand(c, { type: 'steer', playerId: 0, dirs: [d] })
      ev.push(...rr.events)
      c = rr.state
    }
    if (hitP1(ev)) perfect++
  }
  console.log(`v3 teledirigido: impactos directos sin guiar ${none}/${N}, IA difícil ${aiHit}/${N}, guiado perfecto ${perfect}/${N}`)
  check(perfect < N && aiHit < N, 'teledirigido: nunca es un tiro seguro')
  check(aiHit > none && perfect >= aiHit, 'teledirigido: guiar sirve (más impactos que sin guiar)')
}
{
  // IA: usa el teledirigido con correcciones, el láser a quemarropa, el ácido contra un búnker, la mina y el
  // muro sin tiro, el ancla al borde y el jetpack para salir de la lava
  const only = (s: GameState, id: WeaponId) => {
    for (const w of WEAPON_ORDER) s.players[0].ammo[w] = 0
    s.players[0].ammo.normal = 99
    s.players[0].ammo[id] = 3
    s.players[0].weapon = 'normal'
  }
  const sg = armed()
  only(sg, 'guided')
  sg.players[1].x = 700
  const pg = chooseShot(sg, 'hard')
  check(pg.weapon === 'guided' && (pg.steer?.length ?? 0) === 30, `IA: usa el teledirigido lejos con plan (${pg.weapon}, ${pg.steer?.length})`)
  const sl = armed()
  only(sl, 'laser')
  sl.players[1].x = 300
  fillRect(sl.terrain, 240, 247, 247, 299, DIRT, 'both') // pared fina de tierra
  fillRect(sl.terrain, 236, 240, 380, 246, BEDROCK, 'both') // techo: ningún globo llega
  const pl = chooseShot(sl, 'hard')
  check(pl.weapon === 'laser', `IA: láser a través de una pared fina (${pl.weapon})`)
  const sa = armed()
  only(sa, 'acid')
  sa.players[1].x = 600
  // búnker de metal sobre P1
  fillRect(sa.terrain, 576, 262, 624, 268, METAL, 'both')
  fillRect(sa.terrain, 576, 262, 580, 299, METAL, 'both')
  fillRect(sa.terrain, 620, 262, 624, 299, METAL, 'both')
  const pa = chooseShot(sa, 'hard')
  check(pa.weapon === 'acid', `IA: ácido contra el búnker (${pa.weapon})`)
  const sx = pitMap()
  sx.players[0].items.anchor = 1
  fillRect(sx.terrain, PIT0, 290, PIT1, 307, AIR) // la boca abierta a la altura del tanque
  sx.players[0].x = PIT0 - 20
  const px = chooseShot(sx, 'normal')
  check((px.items ?? []).includes('anchor') || (px.move ?? 0) !== 0, `IA: ancla al borde del abismo (${JSON.stringify(px.items)}, move ${px.move})`)
}
{
  // IA con todo el arsenal: partidas de 3 rondas (normal y difícil) con todo comprable; cuántas veces usa cada
  // arma e ítem, que nunca se trabe en 'guiding' y peor tiempo
  const used: Record<string, number> = {}
  let worst = 0
  let stuck = 0
  let games = 0
  let baseMs = 0
  let fullMs = 0
  for (const [difficulty, size, n] of [['normal', 'small', 3], ['hard', 'small', 2], ['normal', 'medium', 4], ['hard', 'large', 4]] as [Difficulty, MapSize, number][]) {
    for (let seed = 1; seed <= 3; seed++) {
      let s = createMatch(mk(n - 1, difficulty, 'forest', 700 + seed, 1, 0, size))
      for (const p of s.players) {
        for (const id of WEAPON_ORDER) if (id !== 'normal') p.ammo[id] = 2
        for (const id of ITEM_ORDER) p.items[id] = 1
      }
      games++
      for (let turn = 0; turn < 60 && s.phase === 'aiming'; turn++) {
        // el mismo turno con el kit de siempre (para comparar tiempos sin depender de la carga de la máquina)
        if (turn % 3 === 0) {
          const k = { ...s, players: s.players.map((p) => ({ ...p, ammo: { ...p.ammo }, items: { ...p.items } })) }
          const me = k.players[k.current]
          for (const id of WEAPON_ORDER) me.ammo[id] = Math.min(me.ammo[id], WEAPONS[id].ammo)
          for (const id of ITEM_ORDER) me.items[id] = 0
          const t0 = performance.now()
          chooseShot(k, difficulty)
          baseMs += performance.now() - t0
          const t1 = performance.now()
          chooseShot(s, difficulty)
          fullMs += performance.now() - t1
        }
        const r = aiTurn(s, difficulty)
        worst = Math.max(worst, r.ms)
        worstMs = Math.max(worstMs, r.ms)
        used[r.plan.weapon] = (used[r.plan.weapon] ?? 0) + 1
        for (const it of r.plan.items ?? []) used[it] = (used[it] ?? 0) + 1
        if (r.state.phase === 'guiding') stuck++
        s = r.state
      }
    }
  }
  console.log(`v3 IA con arsenal (${games} partidas): ${Object.entries(used).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}; peor ${worst.toFixed(0)} ms; tiempo medio con el arsenal / con el kit de siempre: ${(fullMs / Math.max(1, baseMs)).toFixed(2)}`)
  check(stuck === 0, 'IA: nunca se queda en guiding')
  const newOnes = ['guided', 'bouncer', 'laser', 'acid', 'quake', 'blackhole', 'mine', 'wall'].filter((id) => (used[id] ?? 0) > 0)
  check(newOnes.length >= 5, `IA: usa las armas nuevas (${newOnes.join(', ')})`)
  check(fullMs < 3 * baseMs, `IA: el arsenal cuesta ${(fullMs / Math.max(1, baseMs)).toFixed(2)} veces el turno de siempre (tope 3)`)
}
console.log(`IA peor caso: ${worstMs.toFixed(0)} ms`)
console.log(`${checks - failures}/${checks} chequeos OK`)
if (failures > 0) {
  console.error(`${failures} fallas`)
  process.exit(1)
}
