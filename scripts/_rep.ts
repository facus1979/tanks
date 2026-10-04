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

// v3: las correcciones del teledirigido de un plan, en tandas de 2 ticks (como las manda la red); vacío si no es
// teledirigido. Las tandas que sobran después de que el misil cayó no hacen nada.
function steerChunks(plan: ShotPlan): (-1 | 0 | 1)[][] {
  if (plan.weapon !== 'guided') return []
  const out: (-1 | 0 | 1)[][] = []
  for (let i = 0; i < 30; i += 2) out.push([plan.steer?.[i] ?? 0, plan.steer?.[i + 1] ?? 0])
  return out
}
function targetOf2(plan: ShotPlan, item: ItemId) {
  return item === 'jetpack' || item === 'teleport' ? plan.itemTarget : undefined
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


{
  let hashMs = 0
  for (const seed of [11]) {
    const config: MatchConfig = { slots: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }], rounds: 3, difficulty: 'normal', biome: 'rotate', seed }
    let a = createMatch(config)
    let bytes = encodeState(a)
    let b = decodeState(bytes)
    check(netHash(a) === netHash(b), `réplica inicial: hash igual (seed ${seed})`)
    check(b.terrain.front !== a.terrain.front && b.players !== a.players, 'decodeState no comparte memoria con el original')
    let c: GameState | null = null
    let steps = 0
    let diverged = 0
    let kindChanges = 0
    const send = (cmd: Command): void => {
      a = applyCommand(a, cmd).state
      b = applyCommand(b, cmd).state
      if (c) c = applyCommand(c, cmd).state
      steps++
      const h0 = performance.now()
      const ha = netHash(a)
      hashMs += performance.now() - h0
      if (ha !== netHash(b) || (c && ha !== netHash(c))) {
        diverged++
        if (diverged === 1) {
          console.error(`  divergencia en paso ${steps}: ${JSON.stringify(cmd)} b ${netHash(b) === ha} c ${c ? netHash(c) === ha : '-'}`)
          const other = netHash(b) !== ha ? b : c!
          const ja = { ...a, terrain: null }, jo = { ...other, terrain: null }
          for (const k of Object.keys(ja)) if (JSON.stringify((ja as any)[k]) !== JSON.stringify((jo as any)[k])) console.error('   campo', k, JSON.stringify((ja as any)[k]).slice(0, 300), '|||', JSON.stringify((jo as any)[k]).slice(0, 300))
          console.error('   terreno igual', a.terrain.front.every((v, i) => v === other.terrain.front[i]))
          process.exit(1)
        }
      }
      if (steps === 60 && !c) {
        c = decodeState(encodeState(a))
        check(netHash(c) === netHash(a), 'snapshot a mitad de partida: hash igual')
      }
      // setKind en medio de la partida: humano -> IA -> humano
      if (steps === 30 || steps === 90 || steps === 150) {
        kindChanges++
        send({ type: 'setKind', playerId: 0, kind: a.players[0].kind === 'human' ? 'ai' : 'human' })
      }
    }
    let guard = 0
    while (a.phase !== 'gameover' && guard++ < 2000) {
      if (a.phase === 'aiming') {
        const p = a.players[a.current]
        const plan = chooseShot(a, config.difficulty)
        for (const item of plan.items ?? []) send({ type: 'useItem', playerId: p.id, item, target: targetOf2(plan, item) })
        for (let i = 0; i < Math.abs(plan.move ?? 0); i++) send({ type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 })
        if (a.current !== p.id || a.phase !== 'aiming') continue
        send({ type: 'selectWeapon', playerId: p.id, weapon: plan.weapon })
        send({ type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power })
        send({ type: 'fire', playerId: p.id })
      for (const dirs of steerChunks(plan)) send({ type: 'steer', playerId: p.id, dirs })
        for (const dirs of steerChunks(plan)) send({ type: 'steer', playerId: p.id, dirs })
      } else if (a.phase === 'roundover') send({ type: 'nextRound' })
      else if (a.phase === 'shop') {
        for (const p of a.players) {
          if (a.phase !== 'shop' || p.ready) continue
          // en la segunda tienda el humano se desconecta: pasa a IA y compra solo
          if (a.round === 2 && p.id === 0 && p.kind === 'human') send({ type: 'setKind', playerId: 0, kind: 'ai' })
          else {
            if (p.kind === 'human') send({ type: 'buy', playerId: p.id, id: 'heavy' })
            send({ type: 'ready', playerId: p.id })
          }
        }
      }
    }
  }
}
