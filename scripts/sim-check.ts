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
  WOOD,
  WORLD_H,
  WORLD_W,
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
  type Biome,
  type Command,
  type Difficulty,
  type GameEvent,
  type GameState,
  type ItemId,
  type ShopId,
  type MatchConfig,
  type SlotConfig,
  type ShotPlan,
  type StepResult,
  type WeaponId,
} from '../src/sim'
import { propSupported, resolveBlast, blastFor } from '../src/sim/physics'
import { padBounds } from '../src/sim/gen'
import { columnGround, createTerrain, deform, fillRect } from '../src/sim/terrain'

function mk(bots: number, difficulty: Difficulty, biome: MatchConfig['biome'], seed: number, rounds = 1, humans = 0): MatchConfig {
  const slots: SlotConfig[] = []
  for (let i = 0; i <= bots; i++) slots.push({ kind: i < humans ? 'human' : 'ai' })
  return { slots, rounds, difficulty, biome, seed }
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
    const r = applyCommand(state, { type: 'useItem', playerId: p.id, item })
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

// ---------- 1. determinismo ----------
for (const biome of BIOMES) {
  for (const seed of [1, 7, 12345]) {
    const a = createMatch(mk(3, 'normal', biome, seed))
    const b = createMatch(mk(3, 'normal', biome, seed))
    check(hashState(a) === hashState(b), `createMatch no determinista ${biome}/${seed}`)
    const pa = playTurns(a, 5)
    const pb = playTurns(b, 5)
    check(hashState(pa.state) === hashState(pb.state), `partida no determinista ${biome}/${seed}`)
    check(JSON.stringify(pa.events) === JSON.stringify(pb.events), `eventos no deterministas ${biome}/${seed}`)
    check(hashState(a) === hashState(createMatch(mk(3, 'normal', biome, seed))), `applyCommand mutó el estado ${biome}/${seed}`)
  }
}
{
  const a = createMatch(mk(1, 'normal', 'forest', 3))
  const b = createMatch(mk(1, 'normal', 'forest', 4))
  check(hashState(a) !== hashState(b), 'seeds distintas dan el mismo mapa')
}

// ---------- 2. generación válida ----------
const STRUCTURE = new Set([BRICK, WOOD, SLAT, BEAM, POST, METAL])
const signature: Record<Biome, number[]> = { forest: [STONE, BRICK, SLAT], jungle: [STONE, SLAT], industrial: [BRICK, METAL] }
for (const biome of BIOMES) {
  let mirrored = 0
  for (let seed = 1; seed <= 20; seed++) {
    for (const bots of [1, 2, 3]) {
      const s = createMatch(mk(bots, 'normal', biome, seed))
      const tag = `${biome}/seed ${seed}/bots ${bots}`
      const t = s.terrain
      check(t.w === WORLD_W && t.h === WORLD_H && t.front.length === WORLD_W * WORLD_H, `grilla mal dimensionada ${tag}`)
      check(s.players.length === bots + 1, `cantidad de jugadores ${tag}`)
      let bed = true
      for (let x = 0; x < WORLD_W; x++) if (t.front[(WORLD_H - 1) * WORLD_W + x] !== BEDROCK) bed = false
      check(bed, `falta BEDROCK abajo ${tag}`)
      for (const m of signature[biome]) check(count(s, m) > 200, `bioma sin material ${m} ${tag}`)
      if (bots === 3 && s.players[0].x > WORLD_W / 2) mirrored++
      for (const p of s.players) {
        check(p.x >= 20 && p.x <= WORLD_W - 20, `tanque fuera del mapa ${tag} p${p.id}`)
        let support = 0
        for (let x = p.x - TANK_HALF_W; x < p.x + TANK_HALF_W; x++) if (isSolid(t, x, p.y)) support++
        check(support >= 24, `tanque ${p.id} mal apoyado (${support}/28) ${tag}`)
        check(groundAt(t, p.x, TANK_HALF_W, p.y - TANK_H - 2) === p.y, `piso del tanque ${p.id} no coincide ${tag}`)
        // la caja del tanque, libre del todo; alrededor, sin materiales de estructura
        let inside = 0
        for (let y = p.y - TANK_H - 4; y < p.y; y++) {
          for (let x = p.x - TANK_HALF_W - 4; x < p.x + TANK_HALF_W + 4; x++) {
            const i = y * WORLD_W + x
            const body = y >= p.y - TANK_H && x >= p.x - TANK_HALF_W && x < p.x + TANK_HALF_W
            if (body ? t.front[i] !== AIR || t.back[i] !== AIR : STRUCTURE.has(t.front[i]) || STRUCTURE.has(t.back[i])) inside++
          }
        }
        check(inside === 0, `tanque ${p.id} dentro de una estructura (${inside} px) ${tag}`)
        // el pad empalma con el terreno: sin paredes verticales en los bordes
        const [px0, px1] = padBounds(p.x)
        let worst = 0
        const from = p.y - TANK_H - 4
        const soil = (x: number) => {
          const g = columnGround(t, x, from)
          return STRUCTURE.has(t.front[g * WORLD_W + x]) ? -1 : g
        }
        for (let x = Math.max(0, px0 - 8); x < Math.min(WORLD_W - 1, px1 + 8); x++) {
          const a = soil(x)
          const b = soil(x + 1)
          if (a >= 0 && b >= 0) worst = Math.max(worst, Math.abs(a - b))
        }
        check(worst <= MAX_CLIMB, `pad del tanque ${p.id} con escalón de ${worst} px ${tag}`)
        check(p.crew !== undefined && p.color !== undefined, `tanque ${p.id} sin crew/color ${tag}`)
        for (const q of s.players) if (q.id > p.id) check(Math.abs(q.x - p.x) >= 70, `tanques ${p.id} y ${q.id} muy cerca ${tag}`)
      }
      const kinds = new Set(s.props.map((p) => p.kind))
      for (const k of ['barrel', 'ladder', 'flag', 'windsock'] as const) check(kinds.has(k), `falta utilería ${k} ${tag}`)
      if (biome !== 'industrial') check(kinds.has('lamp') && kinds.has('crate'), `falta foco o caja ${tag}`)
      for (const p of s.props) {
        check(p.x >= 0 && p.x + p.w <= WORLD_W && p.y >= 0 && p.y + p.h <= WORLD_H, `prop ${p.id} fuera del mapa ${tag}`)
        check(propSupported(s, p), `prop ${p.id} (${p.kind}) sin apoyo ${tag}`)
        if (p.kind === 'barrel' || p.kind === 'crate') {
          let solid = 0
          for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) if (isSolid(t, x, y)) solid++
          check(solid === 0, `prop ${p.id} (${p.kind}) metido en el terreno ${tag}`)
        }
      }
    }
  }
  check(mirrored > 2 && mirrored < 18, `el espejado no varía (${mirrored}/20) ${biome}`)
}

// ---------- 3. IA ----------
// El tiempo depende de la máquina y de la carga: en CI (runners lentos) solo se controla que no se cuelgue.
const AI_BUDGET_MS = process.env.CI ? 2000 : 250
let worstMs = 0
for (const biome of BIOMES) {
  for (const seed of [2, 5, 9, 14]) {
    let s = createMatch(mk(3, 'hard', biome, seed))
    for (let turn = 0; turn < 4 && s.phase === 'aiming'; turn++) {
      const r = aiTurn(s, 'hard')
      worstMs = Math.max(worstMs, r.ms)
      check(r.ms < AI_BUDGET_MS, `la IA tardó ${r.ms.toFixed(0)} ms ${biome}/${seed}`)
      check(!!r.flights && r.flights.length >= 1 && r.flights[0].path.length > 2, `tiro sin trayectoria ${biome}/${seed}`)
      const impacts = r.events.filter((e) => e.type === 'impact')
      check(impacts.length >= 1, `el tiro de la IA (${r.plan.weapon}) no explotó ${biome}/${seed} turno ${turn}`)
      s = r.state
    }
  }
}

// El proyectil sale de la boca del cañón y puede pasar por arriba del mapa.
{
  const s = createMatch(mk(1, 'normal', 'forest', 1))
  const p = s.players[0]
  const m = muzzle(p.x, p.y, 60)
  const f = fly({ terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle: 88, power: 100, wind: 0 })
  check(Math.abs(f.path[0].x - muzzle(p.x, p.y, 88).x) < 1e-6, 'el vuelo no sale de la boca del cañón')
  check(m.y < p.y - TANK_H, 'la boca a 60° debería quedar arriba del casco')
  check(Math.min(...f.path.map((q) => q.y)) < 0, 'sin techo: el tiro a potencia 100 debería salir por arriba')
  check(f.impact.kind !== 'out', 'el tiro vertical debería volver a caer')
}

// ---------- 4. deformación con dureza ----------
{
  const t = createTerrain()
  fillRect(t, 100, 100, 199, 199, DIRT, 'both')
  fillRect(t, 150, 100, 199, 199, STONE, 'both')
  fillRect(t, 140, 150, 160, 152, BEDROCK)
  const debris = deform(t, 150, 150, 20, 'destroy')
  const at = (x: number, y: number) => t.front[y * t.w + x]
  check(at(133, 140) === AIR, 'tierra a 17 px debería romperse (radio 20)')
  check(at(167, 140) === STONE, 'piedra a 17 px no debería romperse (dureza 0.7 → 14 px)')
  check(at(160, 143) === AIR, 'piedra a 12 px debería romperse')
  check(at(150, 151) === BEDROCK, 'BEDROCK no se rompe')
  check(t.back[140 * t.w + 133] === DIRT, 'el back queda después de romper')
  check((debris[DIRT] ?? 0) > 100 && (debris[STONE] ?? 0) > 100 && !debris[BEDROCK], 'debris por material')
  const t2 = createTerrain()
  deform(t2, 50, 50, 10, 'build')
  check(t2.front[50 * t2.w + 50] === DIRT && t2.back[50 * t2.w + 50] === DIRT, 'build agrega DIRT en front y back')
}

// ---------- 5. caída ----------
{
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4)))
  const p = s.players[0]
  const y0 = p.y
  fillRect(s.terrain, p.x - 20, y0, p.x + 20, y0 + 29, AIR)
  const events = resolveBlast(s, blastFor('normal', 5, 5, 1))
  const fall = events.find((e) => e.type === 'fall' && e.playerId === p.id)
  check(!!fall && p.y >= y0 + 30, `el tanque debería caer 30 px (y ${y0} → ${p.y})`)
  check(events.some((e) => e.type === 'damage' && e.playerId === p.id), 'la caída debería hacer daño')
}

// ---------- 6. aplastamiento ----------
{
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4)))
  const p = s.players[1]
  const events = resolveBlast(s, blastFor('dirt', p.x, p.y - TANK_H - 4, 1))
  const dmg = events.filter((e) => e.type === 'damage' && e.playerId === p.id)
  check(dmg.length >= 1, 'la tierra encima del tanque debería aplastarlo')
}

// ---------- 7. barril en cadena ----------
{
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4)))
  const t = s.terrain
  fillRect(t, 300, 150, 380, 200, AIR, 'both')
  fillRect(t, 300, 200, 380, 205, STONE)
  s.props = [
    { id: 0, kind: 'barrel', x: 310, y: 188, w: 10, h: 12, alive: true },
    { id: 1, kind: 'barrel', x: 330, y: 188, w: 10, h: 12, alive: true },
    { id: 2, kind: 'barrel', x: 350, y: 188, w: 10, h: 12, alive: true },
    { id: 3, kind: 'crate', x: 366, y: 176, w: 12, h: 12, alive: true },
  ]
  // la caja flota: tiene que caer
  const events = resolveBlast(s, blastFor('normal', 305, 194, 0.5))
  const impacts = events.filter((e): e is Extract<GameEvent, { type: 'impact' }> => e.type === 'impact')
  check(impacts.length === 4, `cadena de 3 barriles: ${impacts.length} impactos (esperaba 4)`)
  check(impacts.every((e, i) => i === 0 || e.t > impacts[i - 1].t), 'los impactos en cadena tienen t creciente')
  check(s.props.slice(0, 3).every((p) => !p.alive), 'los barriles explotaron')
  const crate = s.props[3]
  check(!crate.alive || crate.y > 176, 'la caja sin apoyo cae o se rompe')
}

// ---------- 8. partidas completas ----------
for (const biome of BIOMES) {
  let s = createMatch(mk(3, 'easy', biome, 99))
  const r = playTurns(s, 80)
  s = r.state
  check(s.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.hp >= 0), `estado inválido tras partida ${biome}`)
  console.log(`${biome}: ${s.phase} en turno ${s.turn}, hp ${s.players.map((p) => p.hp).join('/')}`)
}

// mover no rompe
{
  let s = createMatch(mk(1, 'normal', 'forest', 1))
  const p = s.players[0]
  for (let i = 0; i < 80; i++) s = applyCommand(s, { type: 'move', playerId: p.id, dir: 1 }).state
  check(s.players[0].fuel >= 0 && s.players[0].x > p.x, 'move avanza y gasta combustible')
}

// ---------- 9. arsenal (F7) ----------
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
check(WEAPON_ORDER.length === 8, 'WEAPON_ORDER tiene las 8 armas')
{
  const r = shoot(flat(), 'cluster', 60, 70)
  const n = WEAPONS.cluster.split ?? 0
  check(r.flights!.length === n + 1, `racimo: ${r.flights!.length} vuelos (esperaba ${n + 1})`)
  check(r.flights!.slice(1).every((f) => (f.startT ?? 0) > 0.3), 'racimo: las bombitas arrancan en el apogeo')
  check(impactsOf(r).length === n, `racimo: ${impactsOf(r).length} impactos`)
  const xs = impactsOf(r).map((e) => e.x)
  check(Math.max(...xs) - Math.min(...xs) > 30, 'racimo: las bombitas se abren')
}
{
  const s = flat()
  fillRect(s.terrain, 380, 260, 420, 299, WOOD, 'both')
  const wood0 = count(s, WOOD)
  // cae sobre la casilla de madera
  let hit: StepResult | null = null
  for (let power = 40; power <= 100 && !hit; power++) {
    const r = shoot(s, 'napalm', 45, power)
    const e = impactsOf(r)[0]
    if (e && e.x >= 385 && e.x <= 415) hit = r
  }
  check(!!hit, 'napalm: no encontré tiro sobre la madera')
  if (hit) {
    check(hit.events.some((e) => e.type === 'burn'), 'napalm: eventos burn')
    check(count(hit.state, WOOD) < wood0 - 300, `napalm: quema la madera (${wood0} → ${count(hit.state, WOOD)})`)
  }
  const s2 = flat()
  const r2 = shoot(s2, 'napalm', 90, 1)
  check(r2.events.some((e) => e.type === 'damage' && e.playerId === 0), 'napalm: el fuego daña al tanque que está adentro')
}
{
  const s = flat()
  const r = shoot(s, 'digger', 45, 60)
  const e = impactsOf(r)[0]
  check(!!e && e.blast === 'dig', 'excavadora: impacto dig')
  if (e) {
    const path = r.flights![0].path
    const a = path[path.length - 3]
    const b = path[path.length - 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    let tunnel = 0
    for (let d = 20; d <= 60; d += 10) if (!isSolid(r.state.terrain, e.x + (d * (b.x - a.x)) / len, e.y + (d * (b.y - a.y)) / len)) tunnel++
    check(tunnel >= 3, `excavadora: cava el túnel en la dirección del vuelo (${tunnel}/5)`)
  }
}
{
  const s = flat()
  // rampa que baja hacia el rival
  for (let x = 300; x < 560; x++) fillRect(s.terrain, x, 200 + Math.floor((x - 300) / 2.6), x, 299, DIRT, 'both')
  const r = shoot(s, 'roller', 60, 52)
  check(r.flights!.length === 2, 'rodadora: vuelo + rodada')
  const e = impactsOf(r)[0]
  const land = r.flights![0].impact
  check(!!e && e.x > land.x + 20, `rodadora: rueda cuesta abajo (${land.x.toFixed(0)} → ${e?.x.toFixed(0)})`)
}
{
  const s = flat()
  s.players[1].x = 420
  const r = shoot(s, 'nuke', 90, 1)
  check(impactsOf(r)[0]?.radius === WEAPONS.nuke.radius && WEAPONS.nuke.radius >= 50, 'nuke: radio enorme')
}
// moverse: escalón alto frena, caída hace daño, combustible se repone
{
  const s = flat()
  fillRect(s.terrain, 216, 290, 240, 299, DIRT)
  let a = s
  for (let i = 0; i < 10; i++) a = applyCommand(a, { type: 'move', playerId: 0, dir: 1 }).state
  check(a.players[0].x === 201 || a.players[0].x === 202, `move: un escalón de 10 px frena (x ${a.players[0].x})`)
  const b = flat()
  fillRect(b.terrain, 150, 250, 214, 299, DIRT)
  fillRect(b.terrain, 186, 300, 260, 360, AIR)
  b.players[0].y = 250
  let c = b
  const ev: GameEvent[] = []
  for (let i = 0; i < 40; i++) {
    const r = applyCommand(c, { type: 'move', playerId: 0, dir: 1 })
    ev.push(...r.events)
    c = r.state
  }
  check(ev.some((e) => e.type === 'fall') && ev.some((e) => e.type === 'damage'), 'move: cae de la cornisa con daño')
  check(c.players[0].fuel < 60, 'move: gasta combustible')
  const d = shoot(c, 'normal', 90, 1).state
  check(d.players[d.current].fuel === 60, 'move: el combustible se repone en el turno')
}

// ---------- 10. balance (F9): IA contra IA ----------
function match(bots: number, seed: number): { shots: number; turns: number; winner: number | null; weapons: Record<string, number> } {
  const biome = BIOMES[seed % BIOMES.length]
  let s = createMatch(mk(bots, 'normal', biome, seed))
  let shots = 0
  const weapons: Record<string, number> = {}
  while (s.phase === 'aiming' && shots < 120) {
    const r = aiTurn(s, 'normal')
    if (r.flights) {
      shots++
      weapons[r.plan.weapon] = (weapons[r.plan.weapon] ?? 0) + 1
    }
    s = r.state
  }
  return { shots, turns: s.turn, winner: s.roundWinnerId, weapons }
}
{
  const t0 = performance.now()
  for (const bots of [1, 3]) {
    const res = []
    for (let seed = 1; seed <= 20; seed++) res.push(match(bots, 100 + seed))
    const shots = res.map((r) => r.shots)
    const avg = shots.reduce((a, b) => a + b, 0) / shots.length
    const used: Record<string, number> = {}
    for (const r of res) for (const k in r.weapons) used[k] = (used[k] ?? 0) + r.weapons[k]
    console.log(
      `balance ${bots + 1} tanques: ${avg.toFixed(1)} tiros/partida (min ${Math.min(...shots)}, max ${Math.max(...shots)}), empates ${res.filter((r) => r.winner === null).length}, armas ${JSON.stringify(used)}`,
    )
    check(shots.every((n) => n < 120), `partida de ${bots + 1} sin terminar`)
    if (bots === 1) check(avg >= 8 && avg <= 15, `balance 2 tanques fuera de 8-15 tiros (${avg.toFixed(1)})`)
  }
  console.log(`balance: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

// ---------- 11. rondas, tienda e ítems (F10) ----------
interface MatchRun {
  state: GameState
  events: GameEvent[]
  shots: number
  perRound: number[] // tiros de cada ronda
  bought: ShopId[][][] // por visita a la tienda y por jugador, lo que compraron las IA
  used: Record<string, number>
  roundWinners: (number | null)[]
  moneyIn: number[][] // plata de cada jugador al arrancar cada ronda
}
function playMatch(config: MatchConfig, maxShots = 150): MatchRun {
  let s = createMatch(config)
  const events: GameEvent[] = []
  const bought: ShopId[][][] = []
  const used: Record<string, number> = {}
  const roundWinners: (number | null)[] = []
  const moneyIn: number[][] = [s.players.map((p) => p.money)]
  let shots = 0
  let roundShots = 0
  const perRound: number[] = []
  while (s.phase !== 'gameover') {
    if (s.phase === 'aiming') {
      if (roundShots >= maxShots) break
      const r = aiTurn(s, config.difficulty)
      if (r.flights) {
        shots++
        roundShots++
        used[r.plan.weapon] = (used[r.plan.weapon] ?? 0) + 1
      }
      for (const e of r.events) if (e.type === 'item') used[e.item] = (used[e.item] ?? 0) + 1
      events.push(...r.events)
      s = r.state
    } else if (s.phase === 'roundover') {
      roundWinners.push(s.roundWinnerId)
      perRound.push(roundShots)
      const before = s.players.map((p) => ({ ...p.ammo, ...p.items }) as Record<string, number>)
      const r = applyCommand(s, { type: 'nextRound' })
      events.push(...r.events)
      s = r.state
      if (s.phase === 'gameover') break
      bought.push(
        s.players.map((p, i) => {
          const list: ShopId[] = []
          for (const e of SHOP) {
            const diff = owned(p, e.id) - (before[i][e.id] ?? 0)
            for (let k = 0; k < diff; k += e.qty) list.push(e.id)
          }
          return list
        }),
      )
      // humanos de prueba: listos sin comprar
      for (const p of s.players) if (s.phase === 'shop' && !p.ready) s = applyCommand(s, { type: 'ready', playerId: p.id }).state
      moneyIn.push(s.players.map((p) => p.money))
      roundShots = 0
    } else break
  }
  return { state: s, events, shots, perRound, bought, used, roundWinners, moneyIn }
}

{
  // configuración: nombres por tripulante, crew por índice, plata inicial
  const s = createMatch({ slots: [{ kind: 'human', name: 'Facu' }, { kind: 'ai' }, { kind: 'ai', crew: 'desert' }], rounds: 3, difficulty: 'hard', biome: 'jungle', seed: 5 })
  check(s.players.length === 3 && s.players[0].name === 'Facu' && s.players[0].kind === 'human', 'slots: nombre y tipo')
  check(s.players[1].crew === CREWS[1] && s.players[1].name === CREW_NAMES[CREWS[1]], 'slots: crew por índice y nombre del tripulante')
  check(s.players[2].crew === 'desert' && s.players[2].name === CREW_NAMES.desert, 'slots: crew elegido')
  check(
    s.players.every((p) => p.money === START_MONEY && ITEM_ORDER.every((i) => p.items[i] === 0) && p.shield === 0 && !p.tracer && !p.ready),
    'jugador inicial: plata, ítems, escudo',
  )
  check(s.round === 1 && s.rounds === 3 && s.difficulty === 'hard' && s.biome === 'jungle' && s.phase === 'aiming', 'estado inicial de rondas')
  check(createMatch({ slots: [{ kind: 'ai' }], rounds: 1, difficulty: 'normal' }).players.length === 2, 'slots: mínimo 2')
  const five = createMatch({ slots: Array(5).fill({ kind: 'ai' }), rounds: 1, difficulty: 'normal' })
  check(five.players.length === 4, 'slots: máximo 4')
}
{
  // determinismo con rondas, y partidas IA contra IA de 3 y 5 rondas
  const cfg = mk(2, 'normal', 'rotate', 21, 3)
  const a = playMatch(cfg)
  const b = playMatch(cfg)
  check(hashState(a.state) === hashState(b.state) && JSON.stringify(a.events) === JSON.stringify(b.events), 'partida de 3 rondas no determinista')
  for (const [rounds, seed] of [
    [3, 31],
    [5, 32],
  ]) {
    const r = playMatch(mk(3, 'normal', 'random', seed, rounds))
    const s = r.state
    check(s.phase === 'gameover' && s.round === rounds, `partida de ${rounds} rondas no terminó (fase ${s.phase}, ronda ${s.round})`)
    check(r.events.filter((e) => e.type === 'roundover').length === rounds, `${rounds} eventos roundover`)
    check(
      r.events.filter((e) => e.type === 'round').length === rounds - 1 && r.events.filter((e) => e.type === 'shop').length === rounds - 1,
      `eventos round/shop en ${rounds} rondas`,
    )
    const last = r.events.filter((e): e is Extract<GameEvent, { type: 'roundover' }> => e.type === 'roundover').map((e) => e.last)
    check(last.every((l, i) => l === (i === rounds - 1)), 'roundover.last solo en la última')
    const won = s.players.reduce((a, p) => a + p.roundsWon, 0)
    check(won === r.roundWinners.filter((w) => w !== null).length, 'roundsWon suma los ganadores de ronda')
    if (s.winnerId !== null) check(s.players.every((p) => p.roundsWon <= s.players[s.winnerId!].roundsWon), 'el campeón tiene más rondas ganadas')
    check(s.players.every((p) => p.money >= 0), 'plata negativa')
    console.log(
      `${rounds} rondas: ganador ${s.winnerId}, rondas ${s.players.map((p) => p.roundsWon).join('/')}, kills ${s.players.map((p) => p.kills).join('/')}, plata ${s.players.map((p) => p.money).join('/')}`,
    )
  }
}
{
  // rotate y random
  const biomes = [1, 2, 3, 4].map((r) => biomeFor('rotate', 9, r))
  check(biomes.join() === 'forest,jungle,industrial,forest', `rotate: ${biomes.join()}`)
  check(biomeFor('random', 9, 2) === biomeFor('random', 9, 2), 'random determinista')
  check(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((r) => biomeFor('random', 9, r))).size > 1, 'random varía por ronda')
  check(biomeFor('industrial', 9, 3) === 'industrial', 'bioma fijo')
  const r = playMatch(mk(1, 'normal', 'rotate', 44, 3))
  const rounds = r.events.filter((e): e is Extract<GameEvent, { type: 'round' }> => e.type === 'round').map((e) => e.biome)
  check(rounds.join() === 'jungle,industrial', `rotate en partida: ${rounds.join()}`)
}
// fin de ronda con un humano (lo juega la IA): termina en roundover
function toRoundover(): GameState {
  let s = cloneState(createMatch(mk(1, 'normal', 'forest', 8, 3, 1)))
  s.players[1].hp = 5
  for (let i = 0; i < 200 && s.phase === 'aiming'; i++) s = aiTurn(s, 'hard').state
  return s
}
{
  let s = toRoundover()
  check(s.phase === 'roundover', 'la ronda termina con un solo tanque vivo')
  const w = s.roundWinnerId
  check(w !== null && s.players[w].roundsWon === 1, 'roundWinnerId y roundsWon')
  if (w !== null) check(s.earnings[w] >= EARN.survive + EARN.roundWin - 100, `el ganador cobra sobrevivir + ganar (${s.earnings[w]})`)
  check(applyCommand(s, { type: 'fire', playerId: s.players[s.current].id }).state === s, 'en roundover no se dispara')
  const r = applyCommand(s, { type: 'nextRound' })
  s = r.state
  check(s.phase === 'shop' && r.events.some((e) => e.type === 'shop'), 'nextRound → shop')
  check(s.players[1].ready && !s.players[0].ready, 'la IA queda lista; el humano no')
  const heavy = SHOP.find((e) => e.id === 'heavy')!
  const poor = cloneState(s)
  poor.players[0].money = heavy.price - 1
  check(applyCommand(poor, { type: 'buy', playerId: 0, id: 'heavy' }).state === poor, 'no se compra sin plata')
  const rich = cloneState(s)
  rich.players[0].money = 5000
  const ammo0 = rich.players[0].ammo.heavy
  const bought = applyCommand(rich, { type: 'buy', playerId: 0, id: 'heavy' }).state
  check(bought.players[0].ammo.heavy === ammo0 + heavy.qty && bought.players[0].money === 5000 - heavy.price, 'compra: suma qty y cobra')
  check(rich.players[0].money === 5000, 'buy no muta el estado anterior')
  const full = cloneState(rich)
  full.players[0].ammo.heavy = heavy.max - heavy.qty + 1
  check(applyCommand(full, { type: 'buy', playerId: 0, id: 'heavy' }).state === full, 'compra: respeta max')
  const sold = applyCommand(bought, { type: 'sell', playerId: 0, id: 'heavy' }).state
  check(sold.players[0].money === 5000 - heavy.price + Math.floor(heavy.price / 2) && sold.players[0].ammo.heavy === ammo0, 'venta al 50%')
  check(applyCommand(rich, { type: 'sell', playerId: 0, id: 'shield' }).state === rich, 'no se vende lo que no hay')
  const withShield = applyCommand(bought, { type: 'buy', playerId: 0, id: 'shield' }).state
  check(withShield.players[0].items.shield === 1, 'compra de ítem')
  check(applyCommand(s, { type: 'buy', playerId: 1, id: 'heavy' }).state === s, 'la IA lista no compra más')
  // listo → ronda nueva
  const ready = applyCommand(withShield, { type: 'ready', playerId: 0 })
  const n = ready.state
  check(n.phase === 'aiming' && n.round === 2 && ready.events.some((e) => e.type === 'round'), 'ready → ronda 2')
  check(n.players.every((p) => p.alive && p.hp === 100 && p.shield === 0 && !p.tracer && p.ammo.normal === 99), 'ronda nueva: vida llena, sin escudo')
  check(n.players[0].items.shield === 1 && n.players[0].ammo.heavy === withShield.players[0].ammo.heavy, 'ronda nueva: conserva ítems y munición')
  check(hashState({ ...n, players: [] }) !== hashState({ ...s, players: [] }), 'ronda nueva: mapa nuevo')
  check(Object.values(n.earnings).every((e) => e === 0), 'ronda nueva: earnings en 0')
}
{
  // ítems en el turno
  let s = flat()
  const p = s.players[0]
  p.items = { shield: 1, parachute: 0, fuel: 1, repair: 1, tracer: 1 }
  p.hp = 50
  const use = (item: ItemId) => {
    const r = applyCommand(s, { type: 'useItem', playerId: 0, item })
    check(r.events.some((e) => e.type === 'item' && e.item === item) && r.state.current === 0, `useItem ${item}: evento y no gasta el turno`)
    s = r.state
  }
  use('shield')
  check(s.players[0].shield === SHIELD_HP && s.players[0].items.shield === 0, 'escudo activo')
  check(applyCommand(s, { type: 'useItem', playerId: 0, item: 'shield' }).state === s, 'sin escudo en inventario no se activa')
  use('repair')
  check(s.players[0].hp === 50 + REPAIR_HP, 'reparación')
  use('fuel')
  check(s.players[0].fuel === FUEL_PER_TURN * 2, 'combustible extra')
  use('tracer')
  check(s.players[0].tracer, 'trazador activo')
  check(applyCommand(s, { type: 'useItem', playerId: 1, item: 'shield' }).state === s, 'useItem fuera de turno')
  const fired = shoot(s, 'normal', 60, 50).state
  check(!fired.players[0].tracer, 'el trazador se apaga al disparar')
  // el escudo absorbe primero
  const t = flat()
  t.players[1].shield = SHIELD_HP
  t.players[1].x = 222
  const r = shoot(t, 'heavy', 90, 1)
  const sh = r.events.find((e): e is Extract<GameEvent, { type: 'shield' }> => e.type === 'shield' && e.playerId === 1)
  check(!!sh && sh.absorbed > 0 && typeof sh.t === 'number', 'el escudo absorbe y trae t')
  const lost = r.events.filter((e): e is Extract<GameEvent, { type: 'damage' }> => e.type === 'damage' && e.playerId === 1).reduce((a, e) => a + e.amount, 0)
  if (sh) check(r.state.players[1].hp === 100 - lost && r.state.players[1].shield === sh.left && (sh.left === 0 || lost === 0), 'hp y escudo tras el golpe')
}
{
  // paracaídas
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4)))
  const p = s.players[0]
  p.items.parachute = 1
  const y0 = p.y
  fillRect(s.terrain, p.x - 20, y0, p.x + 20, y0 + 29, AIR)
  const events = resolveBlast(s, blastFor('normal', 5, 5, 1))
  const fall = events.find((e): e is Extract<GameEvent, { type: 'fall' }> => e.type === 'fall' && e.playerId === p.id)
  check(!!fall && fall.parachute === true, 'paracaídas: evento fall con parachute')
  check(!events.some((e) => e.type === 'damage' && e.playerId === p.id) && p.items.parachute === 0 && p.hp === 100, 'paracaídas: sin daño y se consume')
}
{
  // campeón: desempate por kills y plata; empate total null
  const last = cloneState(toRoundover())
  last.round = last.rounds
  const champion = (a: number[], k: number[], m: number[]) => {
    const s = cloneState(last)
    s.players.forEach((p, i) => {
      p.roundsWon = a[i]
      p.kills = k[i]
      p.money = m[i]
    })
    const r = applyCommand(s, { type: 'nextRound' })
    return r.state.phase === 'gameover' && r.events.some((e) => e.type === 'gameover') ? r.state.winnerId : -1
  }
  check(champion([2, 1], [0, 5], [0, 0]) === 0, 'campeón por rondas')
  check(champion([1, 1], [1, 2], [900, 0]) === 1, 'desempate por kills')
  check(champion([1, 1], [2, 2], [100, 300]) === 1, 'desempate por plata')
  check(champion([1, 1], [2, 2], [300, 300]) === null, 'empate total')
}

// ---------- 12. balance de la tienda (npm run sim-check -- --balance) ----------
{
  const full = process.argv.includes('--balance')
  const games = full ? 30 : 4
  const t0 = performance.now()
  let visits = 0
  let buyers = 0
  let stuck = 0
  const buys: Record<string, number> = {}
  const used: Record<string, number> = {}
  let richestWins = 0
  let contested = 0
  let repeat = 0
  let repeatChances = 0
  let shots = 0
  let rounds = 0
  let draws = 0
  const byRound = [0, 0, 0]
  const spent: number[] = []
  const final: number[] = []
  const earned: number[] = []
  for (let g = 0; g < games; g++) {
    const bots = 2 + (g % 2)
    const r = playMatch(mk(bots, 'normal', 'random', 500 + g, 3))
    if (r.state.phase !== 'gameover') stuck++
    shots += r.shots
    rounds += r.roundWinners.length
    r.perRound.forEach((n, i) => (byRound[i] += n / games))
    draws += r.roundWinners.filter((w) => w === null).length
    for (const k in r.used) used[k] = (used[k] ?? 0) + r.used[k]
    for (const visit of r.bought) {
      for (const list of visit) {
        visits++
        if (list.length > 0) buyers++
        let cost = 0
        for (const id of list) {
          buys[id] = (buys[id] ?? 0) + 1
          cost += SHOP.find((e) => e.id === id)!.price
        }
        spent.push(cost)
      }
    }
    for (const e of r.events) if (e.type === 'roundover') earned.push(...Object.values(e.earnings))
    // ¿gana la ronda el que entró con más plata? ¿se repite el ganador?
    r.roundWinners.forEach((w, i) => {
      if (i === 0 || w === null) return
      const m = r.moneyIn[i]
      contested++
      if (m[w] === Math.max(...m)) richestWins++
      const prev = r.roundWinners[i - 1]
      if (prev !== null) {
        repeatChances++
        if (prev === w) repeat++
      }
    })
    final.push(...r.state.players.map((p) => p.money))
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
  console.log(`tienda: ${games} partidas de 3 rondas (3-4 IA normal), ${(shots / rounds).toFixed(1)} tiros/ronda (${byRound.map((n) => n.toFixed(1)).join(" / ")}), empates ${draws}/${rounds}, trabadas ${stuck}`)
  console.log(`tienda: compran ${buyers}/${visits} visitas, gasto medio ${avg(spent).toFixed(0)}, ganancia media por ronda ${avg(earned).toFixed(0)}, plata final media ${avg(final).toFixed(0)}`)
  console.log(`tienda: compras ${JSON.stringify(buys)}`)
  console.log(`tienda: uso ${JSON.stringify(used)}`)
  console.log(`tienda: repite ganador ${repeat}/${repeatChances}, gana el que entró más rico ${richestWins}/${contested}`)
  console.log(`tienda: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  check(stuck === 0, `${stuck} partidas de 3 rondas sin terminar`)
  check(buyers >= visits * 0.8, `las IA casi siempre compran (${buyers}/${visits})`)
}

{
  // réplicas: B aplica el log de A paso a paso; C arranca de un snapshot a mitad de partida
  let hashMs = 0
  for (const seed of [11, 12]) {
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
        if (diverged === 1) console.error(`  divergencia en paso ${steps}: ${cmd.type}`)
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
        for (const item of plan.items ?? []) send({ type: 'useItem', playerId: p.id, item })
        for (let i = 0; i < Math.abs(plan.move ?? 0); i++) send({ type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 })
        if (a.current !== p.id || a.phase !== 'aiming') continue
        send({ type: 'selectWeapon', playerId: p.id, weapon: plan.weapon })
        send({ type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power })
        send({ type: 'fire', playerId: p.id })
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
    check(a.phase === 'gameover', `réplicas: partida de 3 rondas terminó (seed ${seed})`)
    check(diverged === 0, `réplicas: ${diverged} pasos con hash distinto (seed ${seed})`)
    check(c !== null && netHash(c) === netHash(a) && netHash(b) === netHash(a), `réplicas: estado final igual (seed ${seed})`)
    check(c !== null && JSON.stringify(c.players) === JSON.stringify(a.players), 'réplica C: jugadores idénticos al final')
    check(kindChanges >= 1, 'setKind se probó en medio de la partida')
    bytes = encodeState(a)
    check(netHash(decodeState(bytes)) === netHash(a), 'decode(encode(final)) conserva el hash')
    console.log(`réplicas: seed ${seed}, ${steps} comandos, ${(bytes.length / 1024).toFixed(0)} KB por snapshot`)
  }
  const s = createMatch(mk(2, 'normal', 'forest', 3, 1, 1))
  const h = netHash(s)
  check(h === netHash(cloneState(s)), 'hashState: un clon tiene el mismo hash')
  const moved = cloneState(s)
  moved.terrain.front[1234] ^= 1
  check(netHash(moved) !== h, 'hashState: cambia si cambia la grilla')
  const w = cloneState(s)
  w.players[1].hp -= 1
  check(netHash(w) !== h, 'hashState: cambia si cambia un jugador')
  const r = cloneState(s)
  r.rng ^= 1
  check(netHash(r) !== h, 'hashState: cambia si cambia el rng')
  const ord = cloneState(s)
  ord.players[0] = Object.fromEntries(Object.entries(ord.players[0]).reverse()) as typeof ord.players[0]
  check(netHash(ord) === h, 'hashState: no depende del orden de claves')
  // setKind: solo cambia el tipo, en cualquier fase; ids inválidos no hacen nada
  const k = applyCommand(s, { type: 'setKind', playerId: 0, kind: 'ai' }).state
  check(k.players[0].kind === 'ai' && k.players[1].kind === s.players[1].kind, 'setKind: cambia solo el tipo')
  const k2 = applyCommand(k, { type: 'setKind', playerId: 0, kind: 'human' }).state
  check(netHash(k2) === h, 'setKind ida y vuelta: mismo hash')
  check(applyCommand(s, { type: 'setKind', playerId: 9, kind: 'ai' }).state === s, 'setKind: jugador inexistente no hace nada')
  check(netHash(s) === h, 'setKind no muta el estado anterior')
  const t1 = performance.now()
  for (let i = 0; i < 20; i++) netHash(s)
  const per = (performance.now() - t1) / 20
  console.log(`hashState: ${per.toFixed(2)} ms por llamada (${hashMs.toFixed(0)} ms en las réplicas)`)
  check(per < 5, `hashState rápido (${per.toFixed(2)} ms)`)
}

console.log(`IA peor caso: ${worstMs.toFixed(0)} ms`)
console.log(`${checks - failures}/${checks} chequeos OK`)
if (failures > 0) {
  console.error(`${failures} fallas`)
  process.exit(1)
}
