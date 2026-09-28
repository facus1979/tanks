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
  fly,
  isSolid,
  groundAt,
  muzzle,
  WEAPONS,
  WEAPON_ORDER,
  type Biome,
  type Difficulty,
  type GameEvent,
  type GameState,
  type ShotPlan,
  type StepResult,
  type WeaponId,
} from '../src/sim'
import { propSupported, resolveBlast, blastFor } from '../src/sim/physics'
import { padBounds } from '../src/sim/gen'
import { columnGround, createTerrain, deform, fillRect } from '../src/sim/terrain'

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
    const a = createMatch({ bots: 3, difficulty: 'normal', biome, seed })
    const b = createMatch({ bots: 3, difficulty: 'normal', biome, seed })
    check(hashState(a) === hashState(b), `createMatch no determinista ${biome}/${seed}`)
    const pa = playTurns(a, 5)
    const pb = playTurns(b, 5)
    check(hashState(pa.state) === hashState(pb.state), `partida no determinista ${biome}/${seed}`)
    check(JSON.stringify(pa.events) === JSON.stringify(pb.events), `eventos no deterministas ${biome}/${seed}`)
    check(hashState(a) === hashState(createMatch({ bots: 3, difficulty: 'normal', biome, seed })), `applyCommand mutó el estado ${biome}/${seed}`)
  }
}
{
  const a = createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 3 })
  const b = createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 4 })
  check(hashState(a) !== hashState(b), 'seeds distintas dan el mismo mapa')
}

// ---------- 2. generación válida ----------
const STRUCTURE = new Set([BRICK, WOOD, SLAT, BEAM, POST, METAL])
const signature: Record<Biome, number[]> = { forest: [STONE, BRICK, SLAT], jungle: [STONE, SLAT], industrial: [BRICK, METAL] }
for (const biome of BIOMES) {
  let mirrored = 0
  for (let seed = 1; seed <= 20; seed++) {
    for (const bots of [1, 2, 3]) {
      const s = createMatch({ bots, difficulty: 'normal', biome, seed })
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
let worstMs = 0
for (const biome of BIOMES) {
  for (const seed of [2, 5, 9, 14]) {
    let s = createMatch({ bots: 3, difficulty: 'hard', biome, seed })
    for (let turn = 0; turn < 4 && s.phase === 'aiming'; turn++) {
      const r = aiTurn(s, 'hard')
      worstMs = Math.max(worstMs, r.ms)
      check(r.ms < 250, `la IA tardó ${r.ms.toFixed(0)} ms ${biome}/${seed}`)
      check(!!r.flights && r.flights.length >= 1 && r.flights[0].path.length > 2, `tiro sin trayectoria ${biome}/${seed}`)
      const impacts = r.events.filter((e) => e.type === 'impact')
      check(impacts.length >= 1, `el tiro de la IA (${r.plan.weapon}) no explotó ${biome}/${seed} turno ${turn}`)
      s = r.state
    }
  }
}

// El proyectil sale de la boca del cañón y puede pasar por arriba del mapa.
{
  const s = createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 1 })
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
  const s = cloneState(createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 4 }))
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
  const s = cloneState(createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 4 }))
  const p = s.players[1]
  const events = resolveBlast(s, blastFor('dirt', p.x, p.y - TANK_H - 4, 1))
  const dmg = events.filter((e) => e.type === 'damage' && e.playerId === p.id)
  check(dmg.length >= 1, 'la tierra encima del tanque debería aplastarlo')
}

// ---------- 7. barril en cadena ----------
{
  const s = cloneState(createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 4 }))
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
  let s = createMatch({ bots: 3, difficulty: 'easy', biome, seed: 99 })
  const r = playTurns(s, 80)
  s = r.state
  check(s.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.hp >= 0), `estado inválido tras partida ${biome}`)
  console.log(`${biome}: ${s.phase} en turno ${s.turn}, hp ${s.players.map((p) => p.hp).join('/')}`)
}

// mover no rompe
{
  let s = createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 1 })
  const p = s.players[0]
  for (let i = 0; i < 80; i++) s = applyCommand(s, { type: 'move', playerId: p.id, dir: 1 }).state
  check(s.players[0].fuel >= 0 && s.players[0].x > p.x, 'move avanza y gasta combustible')
}

// ---------- 9. arsenal (F7) ----------
function flat(): GameState {
  const s = cloneState(createMatch({ bots: 1, difficulty: 'normal', biome: 'forest', seed: 4 }))
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
  let s = createMatch({ bots, difficulty: 'normal', biome, seed })
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
  return { shots, turns: s.turn, winner: s.winnerId, weapons }
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

console.log(`IA peor caso: ${worstMs.toFixed(0)} ms`)
console.log(`${checks - failures}/${checks} chequeos OK`)
if (failures > 0) {
  console.error(`${failures} fallas`)
  process.exit(1)
}
