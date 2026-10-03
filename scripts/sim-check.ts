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
import { propSupported, resolveBlast, blastFor } from '../src/sim/physics'
import { aiStats, lavaRisk } from '../src/sim/ai'
import { LAVA_DELAY } from '../src/sim/game'
import { skylineOf } from '../src/sim/ballistics'
import { generate, padBounds, SPAWN_PIT_GAP, SPAWN_GAP_CROWD, spawnStats, CORNICE_CRUST, CORNICE_LEN, CORNICE_SPAWN_FLAT, CORNICE_SPILL, type Generated } from '../src/sim/gen'
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

// ---------- 2b. v3: tramos, abismos y cuencas (Mediano y Grande) ----------
let tramoMaps = 0
const tramoKinds: Record<string, number> = {}
const tramoSeqs = new Set<string>()
let abyssCount = 0
let basinCount = 0
// Por qué un spawn en x no sirve (null si sirve): abismo a menos de SPAWN_PIT_GAP de la caja del
// tanque o adentro de una cuenca (con 20 px de margen).
// v2.3: createMatch reparte los lugares de generate entre los jugadores en un orden sorteado: mismos
// lugares, en cualquier orden.
function sameSpawns(g: Generated, s: GameState): boolean {
  const a = g.spawns.slice().sort((p, q) => p - q)
  const b = s.players.map((p) => p.x).sort((p, q) => p - q)
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// v2.3: la distancia se mide hasta la boca (g.mouth); sobre una cornisa (columnas de abismo con costra)
// puede nacer, pero con costra bajo todo el pad y piso parejo (no se vuelca ni resbala solo).
function spawnProblem(g: Generated, x: number): string | null {
  const t = g.terrain
  const open = g.mouth ?? t.pits
  for (let i = Math.max(0, x - TANK_HALF_W - SPAWN_PIT_GAP); i <= Math.min(t.w - 1, x + TANK_HALF_W + SPAWN_PIT_GAP); i++) if (open?.[i]) return 'abismo cerca'
  const [px0, px1] = padBounds(x)
  let lo = Infinity
  let hi = -Infinity
  let pit = false
  for (let i = px0; i <= px1; i++) {
    if (t.pits?.[i]) pit = true
    lo = Math.min(lo, columnGround(t, i))
    hi = Math.max(hi, columnGround(t, i))
  }
  if (pit && (hi >= t.h || hi - lo > CORNICE_SPAWN_FLAT + 1)) return 'cornisa que no lo sostiene'
  for (const q of g.basins ?? []) if (x + TANK_HALF_W + 20 > q.x0 && x - TANK_HALF_W - 20 < q.x1) return 'en una cuenca'
  return null
}
function tramoChecks(g: Generated, biome: Biome, size: MapSize, seed: number): void {
  const t = g.terrain
  const W = t.w
  const H = t.h
  const tag = `${size}/${biome}/seed ${seed}`
  const segs = g.segments ?? []
  tramoMaps++
  tramoSeqs.add(segs.map((q) => q.kind).join(','))
  for (const q of segs) tramoKinds[`${biome}:${q.kind}`] = (tramoKinds[`${biome}:${q.kind}`] ?? 0) + 1
  // los tramos cubren el mapa sin huecos ni solapes, con anchos variados
  const sorted = segs.slice().sort((a, b) => a.x0 - b.x0)
  check(sorted.length >= 4 && sorted[0].x0 === 0 && sorted[sorted.length - 1].x1 === W && sorted.every((q, i) => i === 0 || q.x0 === sorted[i - 1].x1), `tramos que no cubren el mapa ${tag}`)
  check(new Set(segs.map((q) => q.x1 - q.x0)).size > 2, `tramos todos del mismo ancho ${tag}`)
  // a lo sumo una meseta con búnker y torre cada 800 px, y al menos una
  const full = segs.filter((q) => q.bunker && q.tower).map((q) => (q.x0 + q.x1) / 2)
  check(full.length >= 1 && full.every((c, i) => full.every((d, j) => i === j || Math.abs(c - d) >= WORLD_W)), `mesetas con búnker y torre (${full.join(',')}) ${tag}`)
  const top = (x: number) => {
    const y = columnGround(t, x)
    return { y, m: y < H ? t.front[y * W + x] : AIR }
  }
  const pitNear = (x: number, d: number) => {
    for (let i = Math.max(0, x - d); i <= Math.min(W - 1, x + d); i++) if (t.pits?.[i]) return true
    return false
  }
  // empalmes sin escalones: en la unión de dos tramos (x0 - 2 .. x0 + 1) la superficie no salta más
  // de 12 px; y en todo el mapa tampoco, entre dos columnas vecinas con tierra arriba (fuera de
  // estructuras, losas y ruinas, y de las paredes del abismo)
  for (const q of sorted.slice(1)) {
    let jump = 0
    for (let x = q.x0 - 2; x < q.x0 + 1; x++) {
      const a = top(x)
      const b = top(x + 1)
      if (a.m === DIRT && b.m === DIRT) jump = Math.max(jump, Math.abs(a.y - b.y))
    }
    check(jump <= 12, `empalme de tramos en x=${q.x0} con salto de ${jump} px ${tag}`)
  }
  let worst = 0
  let worstX = -1
  for (let x = 0; x + 1 < W; x++) {
    if (pitNear(x, 18)) continue // las paredes del abismo serpentean hasta 16 px del fondo
    const a = top(x)
    const b = top(x + 1)
    if (a.m !== DIRT || b.m !== DIRT) continue
    const j = Math.abs(a.y - b.y)
    if (j > worst) {
      worst = j
      worstX = x
    }
  }
  check(worst <= 12, `escalón de ${worst} px en x=${worstX} ${tag}`)
  // abismos: pits coherente con la grilla (sin roca madre, aire hasta abajo), uno por tramo de abismo
  const runs: [number, number][] = []
  for (let x = 0; x < W; x++) {
    if (!t.pits?.[x]) continue
    if (runs.length > 0 && runs[runs.length - 1][1] === x - 1) runs[runs.length - 1][1] = x
    else runs.push([x, x])
  }
  const abysses = segs.filter((q) => q.kind === 'abyss')
  abyssCount += runs.length
  check(runs.length === abysses.length, `abismos: ${runs.length} tiras de pits para ${abysses.length} tramos ${tag}`)
  // v2.3: abajo el abismo es más ancho que la boca (los labios están socavados) y el socavón de una
  // cornisa larga puede meterse hasta CORNICE_SPILL px bajo el tramo vecino
  for (const [a, b] of runs) {
    let mouth = 0
    for (let x = a; x <= b; x++) if (g.mouth?.[x]) mouth++
    check(mouth >= 44 && mouth <= 150, `boca del abismo de ${mouth} px ${tag}`)
    check(b - a + 1 <= 150 + 2 * (CORNICE_LEN[1] + 8), `abismo de ${b - a + 1} px ${tag}`)
    check(abysses.some((q) => a >= q.x0 - CORNICE_SPILL && b < q.x1 + CORNICE_SPILL), `abismo fuera de su tramo ${tag}`)
    check(a > 40 && b < W - 40, `abismo contra el borde ${tag}`)
  }
  let bad = 0
  for (let x = 0; x < W; x++) {
    const open = t.front[(H - 1) * W + x] === AIR
    if (!!t.pits?.[x] !== open) bad++
    if (t.pits?.[x]) {
      for (let y = 0; y < H; y++) if (t.front[y * W + x] === BEDROCK) bad++
      for (let y = H - 12; y < H; y++) if (t.front[y * W + x] !== AIR) bad++
      if (columnGround(t, x, H - 12) !== H || materialAt(t, x, H + 5) !== AIR || isSolid(t, x, H + 5)) bad++
    } else if (!isSolid(t, x, H + 5) || materialAt(t, x, H + 5) !== BEDROCK) bad++
  }
  check(bad === 0, `abismo: pits incoherente con la grilla o con isSolid/materialAt (${bad}) ${tag}`)
  // la pared de fondo se ve en el abismo: back de tierra en la parte honda
  for (const [a, b] of runs) check(t.back[(H - 30) * W + ((a + b) >> 1)] !== AIR, `abismo sin pared de fondo ${tag}`)
  // cuencas: una por tramo de lago o pozo de lava, secas y con el nivel a la altura del borde más bajo
  const holes = segs.filter((q) => q.kind === 'lake' || q.kind === 'lavapit')
  const basins = g.basins ?? []
  basinCount += basins.length
  check(basins.length === holes.length, `cuencas: ${basins.length} registradas para ${holes.length} tramos ${tag}`)
  for (const q of basins) {
    const seg = holes.find((h) => q.x0 >= h.x0 && q.x1 <= h.x1)
    check(!!seg && (seg.kind === 'lake') === (q.kind === 'water'), `cuenca ${q.kind} fuera de su tramo ${tag}`)
    check(q.x1 - q.x0 >= 60 && q.x1 - q.x0 <= 210, `cuenca de ${q.x1 - q.x0} px ${tag}`)
    let deepest = 0
    let dry = true
    for (let x = q.x0; x < q.x1; x++) {
      const y = columnGround(t, x)
      deepest = Math.max(deepest, y - q.level)
      if (y <= q.level) dry = false
    }
    check(dry && deepest >= 20 && deepest <= 70, `cuenca ${q.kind}: hondo ${deepest} px ${tag}`)
    check(columnGround(t, q.x0 - 1) <= q.level && columnGround(t, q.x1) <= q.level, `cuenca ${q.kind}: el nivel pasa los bordes ${tag}`)
  }
  for (const x of g.spawns) check(spawnProblem(g, x) === null, `spawn en x=${x}: ${spawnProblem(g, x)} ${tag}`)
  // la utilería que se apoya (barriles y cajas) no queda flotando sobre un abismo
  for (const p of g.props) if (p.kind === 'barrel' || p.kind === 'crate') check(!pitNear(p.x + (p.w >> 1), p.w >> 1) || p.y + p.h < H - 12, `utilería sobre un abismo ${tag}`)
}

// ---------- 2c. v4: cuencas llenas (Mediano y Grande) ----------
let liquidMaps = 0
const liquidCells = { water: 0, lava: 0 }
function liquidChecks(g: Generated, tag: string): void {
  const t = g.terrain
  const W = t.w
  liquidMaps++
  const vol = liquidVolume(t)
  liquidCells.water += vol.water
  liquidCells.lava += vol.lava
  // cada cuenca llena con su líquido hasta level (y nada por encima); ningún líquido fuera de las cuencas
  let inBasins = 0
  for (const q of g.basins ?? []) {
    const m = q.kind === 'lava' ? LAVA : WATER
    const other = q.kind === 'lava' ? WATER : LAVA
    let n = 0
    let wrong = 0
    let above = 0
    let holes = 0
    for (let x = q.x0; x < q.x1; x++) {
      for (let y = 0; y < t.h; y++) {
        const v = t.front[y * W + x]
        if (v === m) {
          n++
          if (y < q.level) above++
        } else if (v === other) wrong++
      }
      // la columna está llena desde level hasta el lecho (sin aire en el medio)
      const bed = columnGround(t, x, q.level)
      for (let y = q.level; y < bed; y++) if (t.front[y * W + x] === AIR) holes++
    }
    inBasins += n
    check(n > 0 && wrong === 0 && above === 0, `cuenca ${q.kind} mal llena (${n} celdas, ${wrong} del otro, ${above} sobre el nivel) ${tag}`)
    check(holes === 0, `cuenca ${q.kind} con ${holes} huecos de aire ${tag}`)
  }
  check(inBasins === vol.water + vol.lava, `líquido fuera de las cuencas (${vol.water + vol.lava - inBasins}) ${tag}`)
  // asentado: el flujo no mueve nada (nada flotando ni con un costado abierto)
  const c = cloneTerrain(t)
  const r = flowLiquids(c, { seed: null, record: false })
  check(!r.changed, `líquido sin asentar en el mapa generado (${r.moves} movimientos) ${tag}`)
  // utilería fuera de los líquidos
  for (const p of g.props) {
    const w = p.kind === 'flag' || p.kind === 'windsock' ? 2 : p.w
    check(!hasLiquid(t, WATER, p.x, p.y, p.x + w, p.y + p.h) && !hasLiquid(t, LAVA, p.x, p.y, p.x + w, p.y + p.h), `utilería ${p.kind} dentro de un líquido ${tag}`)
  }
}

// Cada tanque bien parado al empezar: dentro del mapa, apoyado, sin estructura en la caja, con el pad
// empalmado al terreno y lejos de los demás (v5: también se usa con 6 y 8 tanques).
function tankChecks(s: GameState, tag: string): void {
  const t = s.terrain
  const W = s.width
  for (const p of s.players) {
    check(p.x >= 20 && p.x <= W - 20, `tanque fuera del mapa ${tag} p${p.id}`)
    let support = 0
    for (let x = p.x - TANK_HALF_W; x < p.x + TANK_HALF_W; x++) if (isSolid(t, x, p.y)) support++
    check(support >= 24, `tanque ${p.id} mal apoyado (${support}/28) ${tag}`)
    check(groundAt(t, p.x, TANK_HALF_W, p.y - TANK_H - 2) === p.y, `piso del tanque ${p.id} no coincide ${tag}`)
    // la caja del tanque, libre del todo; alrededor, sin materiales de estructura
    let inside = 0
    for (let y = p.y - TANK_H - 4; y < p.y; y++) {
      for (let x = p.x - TANK_HALF_W - 4; x < p.x + TANK_HALF_W + 4; x++) {
        const i = y * W + x
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
      return STRUCTURE.has(t.front[g * W + x]) ? -1 : g
    }
    for (let x = Math.max(0, px0 - 8); x < Math.min(W - 1, px1 + 8); x++) {
      const a = soil(x)
      const b = soil(x + 1)
      if (a >= 0 && b >= 0) worst = Math.max(worst, Math.abs(a - b))
    }
    check(worst <= MAX_CLIMB, `pad del tanque ${p.id} con escalón de ${worst} px ${tag}`)
    check(p.crew !== undefined && p.color !== undefined, `tanque ${p.id} sin crew/color ${tag}`)
    for (const q of s.players) if (q.id > p.id) check(Math.abs(q.x - p.x) >= 70, `tanques ${p.id} y ${q.id} muy cerca ${tag}`)
  }
}

// ---------- 2. generación válida ----------
const STRUCTURE = new Set([BRICK, WOOD, SLAT, BEAM, POST, METAL])
const signature: Record<Biome, number[]> = { forest: [STONE, BRICK, SLAT], jungle: [STONE, SLAT], industrial: [BRICK, METAL] }
// Chico con 20 seeds (los mapas de v1); Mediano y Grande con 10.
const GEN_SEEDS: Record<MapSize, number> = { small: 20, medium: 10, large: 10 }
for (const size of MAP_SIZE_ORDER) for (const biome of BIOMES) {
  let mirrored = 0
  const seeds = GEN_SEEDS[size]
  for (let seed = 1; seed <= seeds; seed++) {
    for (const bots of [1, 2, 3]) {
      const s = createMatch(mk(bots, 'normal', biome, seed, 1, 0, size))
      const tag = `${size}/${biome}/seed ${seed}/bots ${bots}`
      const t = s.terrain
      const W = s.width
      const H = s.height
      check(W === MAP_SIZES[size].w && H === MAP_SIZES[size].h && s.size === size, `tamaño del estado ${tag}`)
      check(t.w === W && t.h === H && t.front.length === W * H && t.back.length === W * H, `grilla mal dimensionada ${tag}`)
      check(s.players.length === bots + 1, `cantidad de jugadores ${tag}`)
      // v3: roca madre abajo salvo en las columnas de abismo
      let bed = true
      for (let x = 0; x < W; x++) if (!t.pits?.[x] && t.front[(H - 1) * W + x] !== BEDROCK) bed = false
      check(bed, `falta BEDROCK abajo ${tag}`)
      check(size === 'small' ? t.pits === undefined : t.pits?.length === W, `Terrain.pits ${size === 'small' ? 'en Chico' : 'falta'} ${tag}`)
      for (const m of signature[biome]) check(count(s, m) > 200, `bioma sin material ${m} ${tag}`)
      if (bots === 3 && s.players[0].x > W / 2) mirrored++
      // v3: los tramos (empalmes, abismos, cuencas y spawns: ver tramoChecks)
      if (size !== 'small' && bots === 3) {
        const g = generate(biome, new Rng(roundSeed(seed, 1)), s.players.length, W, H)
        check(g.terrain.front.every((m, i) => m === t.front[i]) && sameSpawns(g, s), `generate no coincide con createMatch ${tag}`)
        tramoChecks(g, biome, size, seed)
        liquidChecks(g, `${size}/${biome}/seed ${seed}`)
      }
      // v4: Chico sin líquidos; ningún tanque nace con líquido en la caja
      if (size === 'small') check(count(s, WATER) + count(s, LAVA) === 0, `líquido en Chico ${tag}`)
      for (const p of s.players) check(!hasLiquid(t, WATER, p.x - TANK_HALF_W, p.y - TANK_H, p.x + TANK_HALF_W, p.y + 1) && !hasLiquid(t, LAVA, p.x - TANK_HALF_W, p.y - TANK_H, p.x + TANK_HALF_W, p.y + 1), `tanque nace en un líquido ${tag} p${p.id}`)
      // spawns repartidos: ninguno a menos de un sexto del espacio parejo de otro
      if (size !== 'small') {
        const xs = s.players.map((p) => p.x).sort((a, b) => a - b)
        const span = W / xs.length
        check(xs[0] < span && xs[xs.length - 1] > W - span, `spawns sin cubrir el ancho (${xs.join(',')}) ${tag}`)
        for (let i = 1; i < xs.length; i++) check(xs[i] - xs[i - 1] >= span * 0.3, `spawns amontonados (${xs.join(',')}) ${tag}`)
      }
      tankChecks(s, tag)
      const kinds = new Set(s.props.map((p) => p.kind))
      for (const k of ['barrel', 'ladder', 'flag', 'windsock'] as const) check(kinds.has(k), `falta utilería ${k} ${tag}`)
      if (biome !== 'industrial') check(kinds.has('lamp') && kinds.has('crate'), `falta foco o caja ${tag}`)
      for (const p of s.props) {
        check(p.x >= 0 && p.x + p.w <= W && p.y >= 0 && p.y + p.h <= H, `prop ${p.id} fuera del mapa ${tag}`)
        check(propSupported(s, p), `prop ${p.id} (${p.kind}) sin apoyo ${tag}`)
        if (p.kind === 'barrel' || p.kind === 'crate') {
          let solid = 0
          for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) if (isSolid(t, x, y)) solid++
          check(solid === 0, `prop ${p.id} (${p.kind}) metido en el terreno ${tag}`)
        }
      }
    }
  }
  check(mirrored > seeds * 0.1 && mirrored < seeds * 0.9, `el espejado no varía (${mirrored}/${seeds}) ${size}/${biome}`)
}
// con 8 jugadores (V5) el generador no se rompe: spawns distintos, separados y apoyados
for (const size of MAP_SIZE_ORDER) {
  if (size === 'small') continue
  for (const biome of BIOMES) {
    for (const seed of [1, 2, 3]) {
      const g = generate(biome, new Rng(seed * 7919), 8, MAP_SIZES[size].w, MAP_SIZES[size].h)
      const xs = g.spawns.slice().sort((a, b) => a - b)
      check(xs.length === 8 && xs.every((x) => x >= 20 && x <= g.terrain.w - 20), `8 spawns dentro del mapa ${size}/${biome}/${seed}`)
      for (let i = 1; i < xs.length; i++) check(xs[i] - xs[i - 1] >= 60, `8 spawns: muy cerca (${xs.join(',')}) ${size}/${biome}/${seed}`)
      for (const x of xs) check(spawnProblem(g, x) === null, `8 spawns: ${spawnProblem(g, x)} en x=${x} ${size}/${biome}/${seed}`)
    }
  }
}

// ---------- 2d. v5: hasta 8 jugadores (6 en Mediano, 8 en Grande) ----------
{
  // tope por tamaño en createMatch, colores y tripulantes distintos
  check(MAX_PLAYERS === 8 && TANK_COLORS.length === 8 && CREWS.length === 8 && new Set(TANK_COLORS).size === 8, 'v5: 8 colores y 8 tripulantes')
  for (const size of MAP_SIZE_ORDER) {
    const s = createMatch({ slots: Array.from({ length: 8 }, () => ({ kind: 'ai' as const })), rounds: 1, difficulty: 'normal', seed: 3, size })
    check(s.players.length === MAX_PLAYERS_BY_SIZE[size], `v5: ${size} recorta a ${MAX_PLAYERS_BY_SIZE[size]} jugadores (${s.players.length})`)
    check(new Set(s.players.map((p) => p.color)).size === s.players.length && new Set(s.players.map((p) => p.crew)).size === s.players.length, `v5: colores y tripulantes repetidos en ${size}`)
  }
  // Chico no cambia: los mapas de 1 a 4 jugadores, byte a byte iguales a los de v1-v4 (hash de grillas,
  // utilería y spawns de 30 seeds × 3 biomas × 1-4 jugadores, tomado antes de v5)
  let all = 0x811c9dc5
  for (const biome of BIOMES) {
    for (let seed = 1; seed <= 30; seed++) {
      for (let c = 1; c <= 4; c++) {
        const g = generate(biome, new Rng(roundSeed(seed, 1)), c)
        let h = 0x811c9dc5
        const mix = (b: number) => {
          h ^= b & 0xff
          h = Math.imul(h, 0x01000193)
        }
        for (const b of g.terrain.front) mix(b)
        for (const b of g.terrain.back) mix(b)
        const rest = JSON.stringify({ props: g.props, spawns: g.spawns })
        for (let i = 0; i < rest.length; i++) mix(rest.charCodeAt(i))
        all = Math.imul(all ^ (h >>> 0), 0x01000193) >>> 0
      }
    }
  }
  check(all.toString(16) === '1a082a97', `v5: los mapas de Chico cambiaron (hash ${all.toString(16)}, esperaba 1a082a97)`)

  // spawns con 6 en Mediano y 8 en Grande: válidos, repartidos a lo ancho y a SPAWN_GAP_CROWD o más
  // (más que el alcance de cualquier arma al arrancar: ningún tiro llega a dos tanques a la vez)
  const reach = Math.max(...WEAPON_ORDER.map((id) => WEAPONS[id].radius)) + 2 * TANK_HALF_W
  check(SPAWN_GAP_CROWD > reach, `v5: SPAWN_GAP_CROWD (${SPAWN_GAP_CROWD}) mayor que el alcance de una explosión entre dos tanques (${reach})`)
  let minGap = Infinity
  let maps = 0
  spawnStats.levels.fill(0)
  for (const [size, n] of [['medium', 6], ['large', 8], ['large', 6]] as [MapSize, number][]) {
    for (const biome of BIOMES) {
      for (let seed = 1; seed <= 8; seed++) {
        const s = createMatch({ slots: Array.from({ length: n }, () => ({ kind: 'ai' as const })), rounds: 1, difficulty: 'normal', biome, seed, size })
        const tag = `${size}/${biome}/seed ${seed}/${n} jugadores`
        maps++
        check(s.players.length === n, `v5: cantidad de jugadores ${tag}`)
        tankChecks(s, tag)
        const g = generate(biome, new Rng(roundSeed(seed, 1)), n, s.width, s.height)
        check(sameSpawns(g, s), `v5: generate no coincide con createMatch ${tag}`)
        for (const x of g.spawns) check(spawnProblem(g, x) === null, `v5: spawn en x=${x}: ${spawnProblem(g, x)} ${tag}`)
        for (const p of s.players) check(!hasLiquid(s.terrain, WATER, p.x - TANK_HALF_W, p.y - TANK_H, p.x + TANK_HALF_W, p.y + 1) && !hasLiquid(s.terrain, LAVA, p.x - TANK_HALF_W, p.y - TANK_H, p.x + TANK_HALF_W, p.y + 1), `v5: tanque nace en un líquido ${tag} p${p.id}`)
        const xs = s.players.map((p) => p.x).sort((a, b) => a - b)
        const span = s.width / n
        check(xs[0] < span && xs[n - 1] > s.width - span, `v5: spawns sin cubrir el ancho (${xs.join(',')}) ${tag}`)
        for (let i = 1; i < n; i++) {
          minGap = Math.min(minGap, xs[i] - xs[i - 1])
          check(xs[i] - xs[i - 1] >= SPAWN_GAP_CROWD, `v5: spawns a menos de ${SPAWN_GAP_CROWD} px (${xs.join(',')}) ${tag}`)
        }
        // repartidos: ningún hueco entre vecinos mayor que 2,5 veces el espacio parejo (en 300 mapas la
        // mediana del hueco más grande es 1,4 y el peor 2,34: un lago y un abismo seguidos sin lugar)
        for (let i = 1; i < n; i++) check(xs[i] - xs[i - 1] <= span * 2.5, `v5: hueco grande entre spawns (${xs.join(',')}) ${tag}`)
      }
    }
  }
  // spawnStats: niveles 4+ = sin lugar a la separación buscada o sin el chequeo de piso (cima, estructura)
  const loose = spawnStats.levels.slice(4).reduce((a, b) => a + b, 0)
  console.log(`v5 spawns: ${maps} mapas de 6-8 jugadores, separación mínima ${minGap} px, niveles de búsqueda ${spawnStats.levels.join('/')}`)
  check(loose === 0, `v5: ${loose} spawns sin lugar bueno (cima, estructura o pegados)`)
}

// ---------- 3. IA ----------
// El tiempo depende de la máquina y de la carga: en CI (runners lentos) solo se controla que no se cuelgue.
const AI_BUDGET_MS = process.env.CI ? 2000 : 250
let worstMs = 0
const worstBySize: Record<string, number> = {}
for (const size of MAP_SIZE_ORDER) {
  for (const biome of BIOMES) {
    for (const seed of [2, 5, 9, 14]) {
      let s = createMatch(mk(3, 'hard', biome, seed, 1, 0, size))
      for (let turn = 0; turn < 4 && s.phase === 'aiming'; turn++) {
        const r = aiTurn(s, 'hard')
        const tag = `${size}/${biome}/${seed}`
        worstMs = Math.max(worstMs, r.ms)
        worstBySize[size] = Math.max(worstBySize[size] ?? 0, r.ms)
        check(r.ms < AI_BUDGET_MS, `la IA tardó ${r.ms.toFixed(0)} ms ${tag}`)
        check(!!r.flights && r.flights.length >= 1 && r.flights[0].path.length > 2, `tiro sin trayectoria ${tag}`)
        const impacts = r.events.filter((e) => e.type === 'impact')
        check(impacts.length >= 1, `el tiro de la IA (${r.plan.weapon}) no explotó ${tag} turno ${turn}`)
        s = r.state
      }
    }
  }
}
console.log(`IA peor caso por tamaño: ${MAP_SIZE_ORDER.map((z) => `${z} ${(worstBySize[z] ?? 0).toFixed(0)} ms`).join(', ')}`)

// Alcance (v2): en un llano de cada tamaño, potencia 100 a 45° sin viento llega a la otra punta.
for (const size of MAP_SIZE_ORDER) {
  const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4, 1, 0, size)))
  const W = s.width
  s.terrain.front.fill(AIR)
  s.terrain.back.fill(AIR)
  fillRect(s.terrain, 0, 400, W - 1, s.height - 1, DIRT, 'both')
  s.props = []
  const p = s.players[0]
  p.x = 30
  p.y = 400
  s.players[1].x = W - 30
  s.players[1].y = 400
  const f = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: p.id, angle: 45, power: 100, wind: 0, ignoreTanks: true })
  const reach = f.impact.x - f.path[0].x
  console.log(`alcance ${size}: potencia 100 a 45° recorre ${reach.toFixed(0)} px de ${W} en ${f.time.toFixed(2)} s`)
  check(f.impact.kind !== 'out' || f.impact.x > W - 60, `alcance ${size}: el tiro no volvió a caer`)
  check(reach > W * 0.88 && reach < W * 1.12, `alcance ${size}: ${reach.toFixed(0)} px (esperaba ~${W})`)
  // la skyline de la IA no cambia el resultado del vuelo
  const sky = skylineOf(s.terrain, s.players, s.props)
  for (const angle of [30, 45, 60, 80, 120]) {
    for (const power of [35, 70, 100]) {
      const a = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: p.id, angle, power, wind: 4 })
      const b = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: p.id, angle, power, wind: 4, skyline: sky })
      check(JSON.stringify(a) === JSON.stringify(b), `skyline cambia el vuelo ${size} ${angle}/${power}`)
    }
  }
  check(physicsFor(W).gravity > 0, 'physicsFor')
}

// Inclinación de reposo: sobre una pendiente fuerte el casco se alinea con ella (hasta MAX_TILT) y el tiro
// sale de la boca del cañón inclinado.
{
  const s = createMatch(mk(1, 'normal', 'forest', 1))
  const t = s.terrain
  for (const deg of [30, 55, 75]) {
    t.front.fill(AIR)
    const k = Math.tan((deg * Math.PI) / 180)
    // pendiente que sube hacia la derecha alrededor de x = 400
    for (let x = 0; x < t.w; x++) {
      const top = Math.max(60, Math.min(t.h - 10, Math.round(300 - (x - 400) * k)))
      for (let y = top; y < t.h; y++) t.front[y * t.w + x] = DIRT
    }
    const p = s.players[0]
    p.x = 400
    p.y = tankFloor(t, 400, 0)
    const tl = tankTilt(t, p.x, p.y)
    const want = Math.min(deg, 75) * Math.PI / 180
    check(tl !== null && Math.abs(Math.abs(tl.angle) - want) < 0.12, `inclinación sobre ${deg}°: ${tl ? ((Math.abs(tl.angle) * 180) / Math.PI).toFixed(1) : 'null'}°`)
    const f = fly({ terrain: t, players: s.players, props: s.props, ownerId: p.id, angle: 135, power: 60, wind: 0 })
    const m = muzzle(p.x, p.y, 135, tl)
    check(Math.hypot(f.path[0].x - m.x, f.path[0].y - m.y) < 1e-6, `sobre ${deg}° el vuelo sale de la boca inclinada`)
  }
  // en llano queda derecho
  t.front.fill(AIR)
  for (let x = 0; x < t.w; x++) for (let y = 300; y < t.h; y++) t.front[y * t.w + x] = DIRT
  check(tankTilt(t, 400, 300) === null, 'en llano el tanque queda derecho')
}

// El proyectil sale de la boca del cañón y puede pasar por arriba del mapa.
{
  const s = createMatch(mk(1, 'normal', 'forest', 1))
  const p = s.players[0]
  const m = muzzle(p.x, p.y, 60)
  const f = fly({ terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle: 88, power: 100, wind: 0 })
  check(Math.abs(f.path[0].x - muzzle(p.x, p.y, 88, tankTilt(s.terrain, p.x, p.y)).x) < 1e-6, 'el vuelo no sale de la boca del cañón')
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
for (const size of MAP_SIZE_ORDER) {
  for (const biome of BIOMES) {
    let s = createMatch(mk(3, 'easy', biome, 99, 1, 0, size))
    const r = playTurns(s, 80)
    s = r.state
    check(s.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.hp >= 0 && p.x >= 0 && p.x <= s.width), `estado inválido tras partida ${size}/${biome}`)
    console.log(`${size}/${biome}: ${s.phase} en turno ${s.turn}, hp ${s.players.map((p) => p.hp).join('/')}`)
  }
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
  fillRect(s.terrain, 216, 286, 240, 299, DIRT)
  let a = s
  for (let i = 0; i < 10; i++) a = applyCommand(a, { type: 'move', playerId: 0, dir: 1 }).state
  check(a.players[0].x === 201 || a.players[0].x === 202, `move: un escalón de 14 px frena (x ${a.players[0].x})`)
  // v2.2: uno de 10 px (MAX_CLIMB) se sube
  const s10 = flat()
  fillRect(s10.terrain, 216, 300 - MAX_CLIMB, 240, 299, DIRT)
  let a10 = s10
  for (let i = 0; i < 10; i++) a10 = applyCommand(a10, { type: 'move', playerId: 0, dir: 1 }).state
  check(a10.players[0].y === 300 - MAX_CLIMB, `move: sube un escalón de ${MAX_CLIMB} px (y ${a10.players[0].y})`)
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
interface MatchStats {
  shots: number
  turns: number
  winner: number | null
  weapons: Record<string, number>
  sudden: boolean // v2: arrancó la muerte súbita
  byLava: boolean // v2: la ronda terminó con una muerte por lava
  lavaMs: number // v2: peor tiempo de la IA con la lava activa
  abyss: number // v3: muertes por abismo
  walked: number // v3: muertes por abismo de una IA que caminó hasta ahí (tiene que ser 0)
  rank: number // v5: posición del ganador contando desde la izquierda al empezar (-1 sin ganador)
  opener: boolean // v5: ganó el que abrió la ronda
}
// v4: eventos de líquidos en las partidas del balance (quemaduras de lava sin muerte súbita = pileta)
const liquidEvents = { splash: 0, water: 0, lava: 0, steam: 0 }
function match(bots: number, seed: number, size: MapSize = 'small'): MatchStats {
  const biome = BIOMES[seed % BIOMES.length]
  let s = createMatch(mk(bots, 'normal', biome, seed, 1, 0, size))
  const order = s.players.map((p) => p.id).sort((a, b) => s.players[a].x - s.players[b].x)
  const opener = s.current
  let shots = 0
  let byLava = false
  let lavaMs = 0
  let abyss = 0
  let walked = 0
  const weapons: Record<string, number> = {}
  while (s.phase === 'aiming' && shots < 120) {
    const lava = s.lava !== null
    const r = aiTurn(s, 'normal')
    for (const e of r.events) {
      if (e.type !== 'death' || e.cause !== 'abyss') continue
      abyss++
      if (!r.flights) walked++
    }
    if (lava) lavaMs = Math.max(lavaMs, r.ms)
    for (const f of r.flights ?? []) liquidEvents.splash += f.splashes?.length ?? 0
    for (const e of r.events) {
      if (e.type === 'fall' && e.water) liquidEvents.water++
      else if (e.type === 'damage' && e.cause === 'lava' && s.lava === null && !r.events.some((q) => q.type === 'lava')) liquidEvents.lava++
      else if (e.type === 'steam') liquidEvents.steam++
    }
    if (r.flights) {
      shots++
      weapons[r.plan.weapon] = (weapons[r.plan.weapon] ?? 0) + 1
    }
    if (r.state.phase !== 'aiming') byLava = lavaKill(r.events)
    s = r.state
  }
  const w = s.roundWinnerId
  return { shots, turns: s.turn, winner: w, weapons, sudden: s.lava !== null, byLava, lavaMs, abyss, walked, rank: w === null ? -1 : order.indexOf(w), opener: w === opener }
}
// Chico con 20 partidas (el balance de v1); Mediano y Grande con 10 (con --balance, 20).
{
  const full = process.argv.includes('--balance')
  for (const size of MAP_SIZE_ORDER) {
    const t0 = performance.now()
    const games = size === 'small' || full ? 20 : 10
    // v4: costo del flujo en estas partidas (cada fire corre el flujo sobre todo el mapa)
    flowStats.fires = flowStats.flows = flowStats.ms = flowStats.worst = 0
    liquidEvents.splash = liquidEvents.water = liquidEvents.lava = liquidEvents.steam = 0
    for (const bots of [1, 3]) {
      const res = []
      for (let seed = 1; seed <= games; seed++) res.push(match(bots, 100 + seed, size))
      const shots = res.map((r) => r.shots)
      const avg = shots.reduce((a, b) => a + b, 0) / shots.length
      const used: Record<string, number> = {}
      for (const r of res) for (const k in r.weapons) used[k] = (used[k] ?? 0) + r.weapons[k]
      const sudden = res.filter((r) => r.sudden).length
      const byLava = res.filter((r) => r.byLava).length
      const lavaMs = Math.max(...res.map((r) => r.lavaMs))
      console.log(
        `balance ${size} ${bots + 1} tanques: ${avg.toFixed(1)} tiros/partida (min ${Math.min(...shots)}, max ${Math.max(...shots)}, ${games} partidas), empates ${res.filter((r) => r.winner === null).length}, armas ${JSON.stringify(used)}`,
      )
      console.log(`  muerte súbita en ${sudden}/${games} rondas, terminan por la lava ${byLava}/${games}, IA con lava peor caso ${lavaMs.toFixed(0)} ms`)
      const abyss = res.reduce((a, r) => a + r.abyss, 0)
      const walked = res.reduce((a, r) => a + r.walked, 0)
      console.log(`  muertes por abismo: ${abyss} (${walked} de una IA caminando)`)
      check(walked === 0, `la IA caminó al abismo ${walked} veces (${size})`)
      check(shots.every((n) => n < 120), `partida de ${bots + 1} sin terminar (${size})`)
      check(lavaMs < AI_BUDGET_MS, `la IA con lava tardó ${lavaMs.toFixed(0)} ms (${size})`)
      // v2: con la muerte súbita ningún tamaño se estira (objetivo ~15 con 2 tanques y ~25 con 4)
      if (bots === 1) check(avg >= 8 && avg <= (size === 'small' ? 15 : 16), `balance ${size} 2 tanques fuera de rango (${avg.toFixed(1)})`)
      else check(avg <= 27, `balance ${size} 4 tanques: ${avg.toFixed(1)} tiros/partida (tope 27)`)
    }
    const flowAvg = flowStats.ms / Math.max(1, flowStats.fires)
    console.log(
      `  flujo ${size}: ${flowStats.fires} fires, ${flowStats.flows} movieron líquido, ${flowAvg.toFixed(2)} ms medio, peor ${flowStats.worst.toFixed(1)} ms; salpicaduras ${liquidEvents.splash}, caídas al agua ${liquidEvents.water}, quemaduras de lava ${liquidEvents.lava}, vapores ${liquidEvents.steam}`,
    )
    check(flowAvg < 20, `flujo ${size}: ${flowAvg.toFixed(2)} ms medio por fire (objetivo < 20)`)
    console.log(`balance ${size}: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  }
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
  check(sold.players[0].money === 5000 && sold.players[0].ammo.heavy === ammo0, 'venta al 100% (v2.2)')
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

// ---------- 13. muerte súbita (v2): calma, lava que sube, daño, proyectiles derretidos ----------
type DamageEv = Extract<GameEvent, { type: 'damage' }>
const lavaEvents = (r: StepResult) => r.events.filter((e): e is Extract<GameEvent, { type: 'lava' }> => e.type === 'lava')
const calmEvents = (r: StepResult) => r.events.filter((e): e is Extract<GameEvent, { type: 'calm' }> => e.type === 'calm')
// Tiro que se va del mapa por la izquierda: no daña a nadie ni toca el terreno.
const miss = (s: GameState) => shoot(s, 'normal', s.players[s.current].x < s.width / 2 ? 178 : 2, 100)
// Murió alguien quemado por la lava en estos eventos.
function lavaKill(events: GameEvent[]): boolean {
  return events.some((d) => d.type === 'death' && events.some((e) => e.type === 'damage' && e.cause === 'lava' && e.playerId === d.playerId))
}
{
  // la calma sube con cada tiro sin daño y se resetea con daño
  let s = flat()
  check(s.calm === 0 && s.lava === null, 'muerte súbita: estado inicial calm 0, lava null')
  let r = miss(s)
  check(r.state.calm === 1 && calmEvents(r).length === 1 && calmEvents(r)[0].left === SUDDEN_DEATH_CALM - 1, `calma: un tiro sin daño suma 1 (calm ${r.state.calm})`)
  check(r.flights![0].impact.kind === 'out' && r.state.players.every((p) => p.hp === 100), 'calma: el tiro de prueba sale del mapa sin daño')
  s = miss(r.state).state
  check(s.calm === 2, 'calma: dos tiros sin daño')
  // v2.2: solo vale el daño a otro: el tiro vertical cae entre el que tira y el tanque 1, pegado
  const near = (st: GameState) => {
    st.players[1].x = st.players[0].x + 24
    st.players[1].y = st.players[0].y
    return st
  }
  const self = shoot(cloneState(s), 'normal', 90, 1)
  check(self.state.calm === 3, `calma: el autodaño no la reinicia (calm ${self.state.calm})`)
  r = shoot(near(cloneState(s)), 'normal', 90, 1)
  check(r.events.some((e) => e.type === 'damage' && e.playerId === 1), 'calma: el tiro vertical daña al de al lado')
  check(r.state.calm === 0 && calmEvents(r).some((e) => e.left === SUDDEN_DEATH_CALM), `calma: el daño la vuelve a 0 (calm ${r.state.calm})`)
  // el escudo cuenta como daño
  const sh = near(cloneState(s))
  sh.players[1].shield = 100
  const rs = shoot(sh, 'normal', 90, 1)
  check(rs.events.some((e) => e.type === 'shield' && e.playerId === 1) && !rs.events.some((e) => e.type === 'damage' && e.playerId === 1) && rs.state.calm === 0, 'calma: lo que absorbe el escudo del otro cuenta como daño')
  // un tiro sin cambio en la cuenta no emite 'calm'
  const z = near(cloneState(flat()))
  const rz = shoot(z, 'normal', 90, 1)
  check(rz.state.calm === 0 && calmEvents(rz).length === 0, 'calma: si no cambia lo que falta, no hay evento calm')

  // SUDDEN_DEATH_CALM tiros sin daño: aparece la lava en el fondo y sube LAVA_RISE por turno
  s = flat()
  for (let i = 0; i < SUDDEN_DEATH_CALM - 1; i++) {
    r = miss(s)
    check(lavaEvents(r).length === 0 && r.state.lava === null, `muerte súbita: no empieza antes de tiempo (tiro ${i + 1})`)
    s = r.state
  }
  r = miss(s)
  const first = lavaEvents(r)
  check(r.state.calm === SUDDEN_DEATH_CALM && calmEvents(r).some((e) => e.left === 0), 'muerte súbita: calm llega al tope y avisa left 0')
  check(first.length === 1 && first[0].from === null && first[0].to === s.height - LAVA_RISE && first[0].warn === 0, `muerte súbita: la lava aparece en el fondo (${JSON.stringify(first[0])})`)
  check(r.state.lava === s.height - LAVA_RISE, 'muerte súbita: state.lava = superficie')
  const turnAt = r.events.findIndex((e) => e.type === 'turn')
  const lavaAt = r.events.findIndex((e) => e.type === 'lava')
  check(lavaAt >= 0 && turnAt > lavaAt, 'muerte súbita: la lava va antes del cambio de turno')
  s = r.state
  // ya empezada: el daño no la frena y sube en todos los turnos
  r = shoot(s, 'normal', 90, 1)
  check(r.events.some((e) => e.type === 'damage') && r.state.calm === SUDDEN_DEATH_CALM, 'muerte súbita: el daño ya no resetea la calma')
  check(lavaEvents(r).length === 1 && r.state.lava === s.lava! - LAVA_RISE && lavaEvents(r)[0].from === s.lava, 'muerte súbita: sube LAVA_RISE en cada turno')
  check(calmEvents(r).length === 0, 'muerte súbita: sin eventos calm después de empezar')
  s = r.state
  r = miss(s)
  check(r.state.lava === s.lava! - LAVA_RISE, 'muerte súbita: sube también con tiros sin daño')
}
{
  // daño de lava al empezar el turno: con t posterior al último impacto y cause 'lava'
  const s = flat()
  s.calm = SUDDEN_DEATH_CALM
  s.lava = 440
  s.players[1].y = 440 // por debajo de la superficie después de subir
  s.players[1].shield = 0
  const r = shoot(s, 'normal', 60, 30) // cae lejos de los dos
  const imp = impactsOf(r)
  check(imp.length >= 1 && r.state.players[0].hp === 100, 'lava: el tiro de prueba explota sin dañar')
  const burn = r.events.filter((e): e is DamageEv => e.type === 'damage' && e.cause === 'lava')
  check(burn.length === 1 && burn[0].playerId === 1 && burn[0].amount === LAVA_DAMAGE && r.state.players[1].hp === 100 - LAVA_DAMAGE, `lava: quema LAVA_DAMAGE al que está adentro (${JSON.stringify(burn)})`)
  const lastImpact = Math.max(...imp.map((e) => e.t))
  check(!!burn[0] && burn[0].t! >= lastImpact + LAVA_DELAY - 1e-9, `lava: el daño va después del último impacto (${burn[0]?.t} vs ${lastImpact})`)
  const iLava = r.events.findIndex((e) => e.type === 'lava')
  const iBurn = r.events.findIndex((e) => e.type === 'damage' && e.cause === 'lava')
  const iImpact = r.events.findIndex((e) => e.type === 'impact')
  check(iImpact < iLava && iLava < iBurn, 'lava: orden impacto → lava → daño')
  check(r.state.earnings[0] === 0 && r.state.earnings[1] === 0, 'lava: el daño de lava no da ni quita plata')
  // escudo: la lava pasa por el escudo como cualquier daño
  const s2 = cloneState(s)
  s2.players[1].shield = SHIELD_HP
  const r2 = miss(s2)
  const shield = r2.events.find((e): e is Extract<GameEvent, { type: 'shield' }> => e.type === 'shield' && e.playerId === 1)
  check(!!shield && shield.absorbed === LAVA_DAMAGE && typeof shield.t === 'number' && r2.state.players[1].hp === 100, 'lava: el escudo absorbe la quemadura')
  // mata, termina la ronda y no cuenta como kill; todos quemados = empate
  const s3 = cloneState(s)
  s3.players[1].hp = 10
  const r3 = miss(s3)
  check(r3.state.phase === 'roundover' && r3.state.roundWinnerId === 0 && lavaKill(r3.events), 'lava: mata y termina la ronda')
  check(r3.state.players[0].kills === 0, 'lava: la muerte por lava no es kill de nadie')
  const s4 = cloneState(s)
  s4.lava = 305 // los dos en el suelo (300) quedan abajo al subir
  for (const p of s4.players) {
    p.y = 300
    p.hp = 15
  }
  const r4 = miss(s4)
  check(r4.state.phase === 'roundover' && r4.state.roundWinnerId === null && r4.state.players.every((p) => !p.alive), 'lava: todos quemados → empate')
  // v5: la lava no mata al último en pie: gana el que aguantó más (más vida a la misma altura, o menos hundido)
  const v6 = cloneState(s4)
  v6.players[0].hp = 18
  const w6 = miss(v6)
  check(w6.state.phase === 'roundover' && w6.state.roundWinnerId === 0 && w6.state.players[0].alive && w6.state.players[0].hp === 18 && !w6.state.players[1].alive, 'v5 lava: a la misma altura gana el que tenía más vida')
  const v7 = cloneState(s4)
  v7.players[0].y = 320
  v7.players[1].y = 310
  const w7 = miss(v7)
  check(w7.state.phase === 'roundover' && w7.state.roundWinnerId === 1 && w7.state.players[1].alive && !w7.state.players[0].alive, 'v5 lava: gana el menos hundido')
  const v8 = cloneState(s4)
  v8.players[0].hp = 60
  const w8 = miss(v8)
  check(w8.state.phase === 'roundover' && w8.state.roundWinnerId === 0 && w8.state.players[0].hp === 60 - LAVA_DAMAGE, 'v5 lava: si la quemadura no lo mata, el último se quema igual')
  // el tanque que está arriba de la superficie no se quema
  const s5 = cloneState(s)
  s5.players[1].y = 300
  check(!miss(s5).events.some((e) => e.type === 'damage'), 'lava: arriba de la superficie no quema')
  // cubierto entero (la superficie queda por encima de la caja): muere en el acto, aunque tenga vida y escudo
  const s6 = cloneState(s)
  s6.lava = 430 // sube a 412; la caja del tanque 1 va de 420 a 440
  s6.players[1].hp = 100
  s6.players[1].shield = SHIELD_HP
  const r6 = miss(s6)
  const death6 = r6.events.find((e): e is Extract<GameEvent, { type: 'death' }> => e.type === 'death' && e.playerId === 1)
  check(!r6.state.players[1].alive && death6?.cause === 'lava' && !r6.events.some((e) => e.type === 'shield' && e.playerId === 1), 'lava: cubierto entero muere en el acto, sin escudo que lo salve')
  check(r6.state.phase === 'roundover' && r6.state.roundWinnerId === 0 && r6.state.players[0].kills === 0, 'lava: la muerte por quedar cubierto termina la ronda y no es kill')
}
{
  // proyectil derretido: lava por encima del suelo (300); los tanques asoman (boca a ~270)
  const melt = (weapon: WeaponId, angle: number, power: number) => {
    const s = flat()
    s.calm = SUDDEN_DEATH_CALM
    s.lava = 292
    for (const p of s.players) p.hp = 100
    const front = s.terrain.front.slice()
    const back = s.terrain.back.slice()
    const r = shoot(s, weapon, angle, power)
    const last = r.flights![r.flights!.length - 1]
    check(r.flights!.some((f) => f.impact.kind === 'lava'), `derretido ${weapon}: impacto 'lava'`)
    check(impactsOf(r).length === 0 && !r.events.some((e) => e.type === 'burn'), `derretido ${weapon}: no explota`)
    const t = r.state.terrain
    check(t.front.every((m, i) => m === front[i]) && t.back.every((m, i) => m === back[i]), `derretido ${weapon}: no deforma`)
    check(!r.events.some((e) => e.type === 'damage' && e.cause !== 'lava'), `derretido ${weapon}: no daña`)
    check(last.impact.y >= s.lava - 1, `derretido ${weapon}: termina en la superficie (${last.impact.y.toFixed(1)})`)
  }
  melt('normal', 135, 30)
  melt('heavy', 120, 40)
  melt('napalm', 135, 30)
  melt('digger', 135, 30)
  melt('nuke', 135, 30)
  melt('cluster', 135, 45)
  melt('roller', 135, 30)
  // rodadora que cae rodando a un pozo con lava
  let rolled = false
  for (let power = 20; power <= 60 && !rolled; power += 2) {
    const s = flat()
    fillRect(s.terrain, 330, 300, 380, 420, AIR, 'both')
    s.calm = SUDDEN_DEATH_CALM
    s.lava = 360
    const r = shoot(s, 'roller', 45, power)
    if (r.flights!.length === 2 && r.flights![0].impact.kind === 'terrain' && r.flights![1].impact.kind === 'lava') {
      rolled = true
      check(impactsOf(r).length === 0, 'rodadora: la que rueda a la lava no explota')
    }
  }
  check(rolled, 'rodadora: hay un tiro que rueda hasta el pozo de lava')
  // vuelo con y sin skyline: misma respuesta también con lava
  const s = createMatch(mk(1, 'normal', 'forest', 3, 1, 0, 'medium'))
  const sky = skylineOf(s.terrain, s.players, s.props)
  const p = s.players[0]
  let same = 0
  let melted = 0
  for (let angle = 20; angle <= 160; angle += 20) {
    for (let power = 30; power <= 100; power += 10) {
      const base = { terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle, power, wind: s.wind, lava: 340 }
      const a = fly(base)
      const b = fly({ ...base, skyline: sky })
      if (JSON.stringify(a) === JSON.stringify(b)) same++
      if (a.impact.kind === 'lava') melted++
    }
  }
  check(same === 64 && melted > 0, `lava + skyline: vuelos iguales (${same}/64, ${melted} derretidos)`)
}
{
  // mover hacia la lava: se puede entrar y quema al empezar el turno siguiente
  const s = flat()
  fillRect(s.terrain, 230, 300, 300, 330, AIR, 'both') // pozo pegado al tanque 0 (x 200)
  s.calm = SUDDEN_DEATH_CALM
  s.lava = 340
  let m = s
  for (let i = 0; i < 60; i++) m = applyCommand(m, { type: 'move', playerId: 0, dir: 1 }).state
  check(m.players[0].y > s.players[0].y, `move: el tanque cae al pozo (y ${m.players[0].y})`)
  const r = miss(m)
  check(m.players[0].y > r.state.lava! && r.events.some((e) => e.type === 'damage' && e.cause === 'lava' && e.playerId === 0), 'move: el que se metió en la lava se quema')
}
{
  // IA: sale de la lava hacia arriba (rampa a la izquierda), no se mete y no tira a la lava
  const s = flat()
  s.terrain.front.fill(AIR)
  s.terrain.back.fill(AIR)
  for (let x = 0; x < WORLD_W; x++) {
    const top = x < 400 ? 300 - Math.floor((400 - x) / 5) : 300
    fillRect(s.terrain, x, top, x, WORLD_H - 1, DIRT, 'both')
  }
  s.players[0].x = 420
  s.players[0].y = 300
  s.players[1].x = 720
  s.players[1].y = 300
  s.calm = SUDDEN_DEATH_CALM
  s.lava = 310 // todavía no lo toca, pero al subir sí
  check(lavaRisk(s, 300) > lavaRisk(s, 288) && lavaRisk(s, 200) === 0, 'IA: lavaRisk pesa solo lo que la lava alcanza')
  const plan = chooseShot(s, 'normal')
  check((plan.move ?? 0) < 0, `IA: se aleja de la lava subiendo la rampa (move ${plan.move})`)
  // sin lava, el mismo lugar no la hace moverse por la lava
  const calm = cloneState(s)
  calm.lava = null
  calm.calm = 0
  check(lavaRisk(calm, 300) === 0, 'IA: sin muerte súbita no hay riesgo de lava')
  // con la lava alta casi todo se derrite: la IA (difícil) igual busca los tiros que pegan en lo que asoma
  const t = flat()
  t.calm = SUDDEN_DEATH_CALM
  t.lava = 295
  let lavaShots = 0
  for (let i = 0; i < 4; i++) {
    const r = aiTurn(t, 'hard')
    if (r.flights?.every((f) => f.impact.kind === 'lava')) lavaShots++
    t.wind = (t.wind + 3) % 10
  }
  check(lavaShots <= 1, `IA: no elige tiros que se derriten (${lavaShots}/4 derretidos)`)
}
{
  // toda ronda termina: nadie se daña (sin munición, pasan) y la lava los quema a todos en un tope de turnos
  for (const size of MAP_SIZE_ORDER) {
    for (const bots of [1, 3]) {
      const run = () => {
        let s = cloneState(createMatch(mk(bots, 'normal', 'forest', 21, 1, 0, size)))
        for (const p of s.players) for (const id of WEAPON_ORDER) p.ammo[id] = 0
        const events: GameEvent[] = []
        let turns = 0
        while (s.phase === 'aiming' && turns < 200) {
          const r = applyCommand(s, { type: 'fire', playerId: s.players[s.current].id })
          events.push(...r.events)
          s = r.state
          turns++
        }
        return { s, events, turns }
      }
      const a = run()
      const highest = Math.min(...createMatch(mk(bots, 'normal', 'forest', 21, 1, 0, size)).players.map((p) => p.y))
      // turnos hasta que la lava pase al tanque más alto, más los que tarda en quemarlo entero (+1 de margen)
      const bound = SUDDEN_DEATH_CALM + Math.ceil((a.s.height - highest) / LAVA_RISE) + Math.ceil(100 / LAVA_DAMAGE) + 1
      check(a.s.phase === 'roundover' && a.turns <= bound, `ronda pacífica ${size} ${bots + 1}: termina por la lava en ${a.turns} turnos (tope ${bound})`)
      check(lavaKill(a.events), `ronda pacífica ${size} ${bots + 1}: muertes por lava`)
      const b = run()
      check(hashState(a.s) === hashState(b.s) && JSON.stringify(a.events) === JSON.stringify(b.events), `ronda pacífica ${size} ${bots + 1}: determinista`)
      const back = decodeState(encodeState(a.s))
      check(back.lava === a.s.lava && back.calm === a.s.calm && netHash(back) === netHash(a.s), `ronda pacífica ${size}: snapshot conserva lava y calma`)
      if (bots === 3) console.log(`ronda pacífica ${size} ${bots + 1}: ${a.turns} turnos, lava en y ${a.s.lava}`)
    }
  }
}

// ---------- 14. v3: reglas del abismo, red y determinismo con pits ----------
{
  console.log(`tramos: ${tramoMaps} mapas, ${tramoSeqs.size} secuencias distintas, ${abyssCount} abismos, ${basinCount} cuencas`)
  console.log(`tramos por bioma: ${JSON.stringify(tramoKinds)}`)
  check(tramoSeqs.size >= tramoMaps * 0.8, `tramos: mapas repetidos (${tramoSeqs.size}/${tramoMaps} secuencias distintas)`)
  for (const biome of BIOMES) {
    const k = (kind: string) => tramoKinds[`${biome}:${kind}`] ?? 0
    // sabor: bosque con montañas y lagos, jungla con abismos y ruinas, industrial con lava y pozos de mina
    if (biome === 'forest') check(k('mountain') > 0 && k('lake') > 0 && k('lavapit') === 0, `sabor del bosque ${JSON.stringify(tramoKinds)}`)
    if (biome === 'jungle') check(k('abyss') > 0 && k('hills') > 0 && k('lake') > 0 && k('lavapit') === 0, `sabor de la jungla`)
    if (biome === 'industrial') check(k('lavapit') > 0 && k('abyss') > 0, `sabor industrial`)
  }
}
// Mapa de prueba con un abismo: llano de tierra en y 300 (Mediano, 1600 px), abismo en [700, 779]
// con un puente de tierra de 8 px en y 300..307; jugador 0 en x 400, jugador 1 sobre el puente.
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
{
  // terreno: debajo del mapa en un abismo no hay nada; en el resto, roca madre
  const s = pitMap()
  const t = s.terrain
  check(!isSolid(t, 740, t.h + 2) && materialAt(t, 740, t.h + 2) === AIR && isSolid(t, 400, t.h + 2) && materialAt(t, 400, t.h + 2) === BEDROCK, 'abismo: isSolid/materialAt debajo del mapa')
  check(columnGround(t, 740, 320) === t.h && groundAt(t, 740, TANK_HALF_W, 320) === t.h, 'abismo: columnGround/groundAt sin piso = h')
  const c = cloneTerrain(t)
  check(!!c.pits && c.pits !== t.pits && c.pits.every((v, i) => v === t.pits![i]), 'cloneTerrain copia pits')
  const before = t.pits!.slice()
  deform(t, 740, 300, 40, 'destroy')
  deform(t, 740, 300, 40, 'build')
  check(t.pits!.every((v, i) => v === before[i]), 'deform no toca pits')
  // red: pits viaja en el snapshot y entra en el hash
  const s2 = pitMap()
  const back = decodeState(encodeState(s2))
  check(!!back.terrain.pits && back.terrain.pits.length === s2.width && back.terrain.pits.every((v, i) => v === s2.terrain.pits![i]), 'snapshot: pits viaja')
  check(netHash(back) === netHash(s2), 'snapshot con pits: mismo hash')
  const s3 = cloneState(s2)
  s3.terrain.pits![10] = 1
  check(netHash(s3) !== netHash(s2), 'hashState: cambia si cambia pits')
  const small = createMatch(mk(1, 'normal', 'forest', 4))
  check(decodeState(encodeState(small)).terrain.pits === undefined && netHash(decodeState(encodeState(small))) === netHash(small), 'snapshot Chico sin pits')
  const real = createMatch(mk(3, 'normal', 'jungle', 7, 1, 0, 'large'))
  const rb = decodeState(encodeState(real))
  check(netHash(rb) === netHash(real) && !!rb.terrain.pits, 'snapshot de un mapa Grande con pits')
}
{
  // caída al abismo: se va el puente bajo el tanque → fall con to > h y death 'abyss', sin daño;
  // el paracaídas no lo salva y no se gasta
  const s = pitMap()
  const p = s.players[1]
  p.items.parachute = 1
  fillRect(s.terrain, PIT0, 300, PIT1, 307, AIR)
  const events = resolveBlast(s, blastFor('normal', 5, 5, 1))
  const fall = events.find((e): e is FallEv => e.type === 'fall' && e.playerId === 1)
  const death = events.find((e): e is DeathEv => e.type === 'death' && e.playerId === 1)
  check(!!fall && fall.to === s.height + ABYSS_DROP && fall.to > s.height && !fall.parachute, `abismo: evento fall hasta abajo del mapa (${JSON.stringify(fall)})`)
  check(!!death && death.cause === 'abyss', 'abismo: death con cause abyss')
  check(!events.some((e) => e.type === 'damage' && e.playerId === 1) && !p.alive && p.hp === 0, 'abismo: sin daño de caída; muerto con vida 0')
  check(p.items.parachute === 1, 'abismo: el paracaídas no se consume')
  check(events.indexOf(fall!) < events.indexOf(death!), 'abismo: fall antes que death')
  // un tanque muerto que ya cayó no vuelve a caer ni a morir
  const again = resolveBlast(s, blastFor('normal', 5, 5, 1))
  check(!again.some((e) => (e.type === 'fall' || e.type === 'death') && e.playerId === 1), 'abismo: el que cayó no genera más eventos')
  // Pulido v2: un tanque con la mayor parte afuera del borde (4 columnas de apoyo) ya no se sostiene:
  // la pendiente lo desliza hacia el abismo y cae; con 20 columnas de apoyo se queda
  const h = pitMap()
  fillRect(h.terrain, PIT0, 300, PIT1, 307, AIR)
  h.players[1].x = PIT0 - TANK_HALF_W + 4
  const ev = resolveBlast(h, blastFor('normal', 5, 5, 1))
  const sl = ev.findIndex((e) => e.type === 'slide' && e.playerId === 1 && e.cause === 'slope')
  const dt = ev.findIndex((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss')
  check(!h.players[1].alive && sl >= 0 && dt > sl, `abismo: colgando del borde se desliza y cae (${JSON.stringify(ev.map((e) => e.type))})`)
  const h2 = pitMap()
  fillRect(h2.terrain, PIT0, 300, PIT1, 307, AIR)
  h2.players[1].x = PIT0 - TANK_HALF_W - 6
  const ev2 = resolveBlast(h2, blastFor('normal', 5, 5, 1))
  check(h2.players[1].alive && !ev2.some((e) => e.type === 'death' || e.type === 'slide'), 'abismo: apoyado en el borde con 20 columnas no se mueve')
}
{
  // un tiro de otro que lo tira al abismo: cuenta como kill, sin plata por daño (solo por lo que pegó antes)
  let found: StepResult | null = null
  for (let power = 30; power <= 100 && !found; power += 0.5) {
    const s = pitMap()
    const r = shoot(s, 'nuke', 45, power)
    if (r.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss')) found = r
  }
  check(!!found, 'abismo: hay un tiro que tira al rival al abismo')
  if (found) {
    const s = found.state
    const hit = found.events.filter((e): e is DamageEv => e.type === 'damage' && e.playerId === 1).reduce((a, e) => a + e.amount, 0)
    check(s.players[0].kills === 1, `abismo: el que lo tiró suma kill (${s.players[0].kills})`)
    check(s.phase === 'roundover' && s.roundWinnerId === 0, 'abismo: la ronda termina con el ganador')
    const expect = EARN.kill + hit * EARN.perDamage + EARN.survive + EARN.roundWin
    check(s.earnings[0] === expect, `abismo: plata del que lo tiró ${s.earnings[0]} (esperaba ${expect})`)
    check(s.earnings[1] === 0, `abismo: el que cayó no cobra (${s.earnings[1]})`)
  }
  // el que se tira solo (su tiro le saca el piso) no suma kill ni pierde plata por autodaño
  let self: StepResult | null = null
  for (let power = 1; power <= 40 && !self; power += 1) {
    const s = pitMap()
    s.current = 1
    const r = shoot(s, 'nuke', 90, power)
    if (r.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss')) self = r
  }
  check(!!self, 'abismo: hay un tiro que tira al propio tanque')
  if (self) check(self.state.players[1].kills === 0 && self.state.players[0].kills === 0, 'abismo: tirarse solo no es kill')
}
{
  // proyectil que cae por un abismo: 'out', sin explosión; la utilería que cae ahí se destruye
  const s = pitMap()
  fillRect(s.terrain, PIT0, 300, PIT1, 307, AIR)
  s.players[1].x = 1200
  const f = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: 0, angle: 0, power: 0, wind: 0, origin: { x: 740, y: 200 }, velocity: { x: 0, y: 20 } })
  check(f.impact.kind === 'out' && f.impact.y > s.height && f.time < 3, `abismo: el proyectil sale por abajo (${f.impact.kind} y ${f.impact.y.toFixed(0)} en ${f.time.toFixed(2)} s)`)
  const sky = skylineOf(s.terrain, s.players, [])
  const f2 = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: 0, angle: 0, power: 0, wind: 0, origin: { x: 740, y: 200 }, velocity: { x: 0, y: 20 }, skyline: sky })
  check(JSON.stringify(f) === JSON.stringify(f2), 'abismo: skyline no cambia el vuelo')
  const r = shoot(s, 'normal', 90, 0)
  check(!!r.flights && r.flights[0].impact.kind !== 'out', 'abismo: el resto del mapa sigue con fondo')
  const p = pitMap()
  p.props = [
    { id: 0, kind: 'barrel', x: 735, y: 288, w: 10, h: 12, alive: true },
    { id: 1, kind: 'crate', x: 750, y: 288, w: 12, h: 12, alive: true },
  ]
  p.players[1].x = 1200
  fillRect(p.terrain, PIT0, 300, PIT1, 307, AIR)
  const ev = resolveBlast(p, blastFor('normal', 5, 5, 1))
  check(p.props.every((q) => !q.alive) && ev.filter((e) => e.type === 'prop' && e.destroyed).length === 2, 'abismo: la utilería que cae se destruye')
  // rodadora que cae al abismo: 'out', sin explosión
  let rolled = false
  for (let power = 10; power <= 70 && !rolled; power += 1) {
    const q = pitMap()
    fillRect(q.terrain, PIT0, 300, PIT1, 307, AIR)
    q.players[1].x = 1400
    for (let x = 500; x < PIT0; x++) fillRect(q.terrain, x, 300 - Math.floor((PIT0 - x) / 4), x, 299, DIRT, 'both')
    const rr = shoot(q, 'roller', 60, power)
    if (rr.flights!.length === 2 && rr.flights![0].impact.kind === 'terrain' && rr.flights![1].impact.kind === 'out') {
      rolled = true
      check(impactsOf(rr).length === 0, 'abismo: la rodadora que cae no explota')
    }
  }
  check(rolled, 'abismo: hay una rodadora que rueda al abismo')
}
{
  // moverse: abyssAhead avisa antes del paso que cae; el que sigue a propósito cae y termina el turno
  const s = pitMap()
  fillRect(s.terrain, PIT0, 300, PIT1, 307, AIR)
  s.players[1].x = 1200
  s.players[0].x = PIT0 - 30
  s.players[0].fuel = 200
  let m = s
  let warned = -1
  const ev: GameEvent[] = []
  for (let i = 0; i < 80 && m.current === 0; i++) {
    if (warned < 0 && abyssAhead(m, 1)) warned = m.players[0].x
    const r = applyCommand(m, { type: 'move', playerId: 0, dir: 1 })
    ev.push(...r.events)
    m = r.state
  }
  const death = ev.find((e): e is DeathEv => e.type === 'death' && e.playerId === 0)
  check(warned > 0 && !!death && death.cause === 'abyss', `move: abyssAhead avisa (x ${warned}) y el que sigue cae al abismo`)
  check(ev.some((e) => e.type === 'fall' && e.playerId === 0 && e.to > s.height) && !ev.some((e) => e.type === 'damage'), 'move: caída al abismo sin daño')
  check(m.phase === 'roundover' && m.roundWinnerId === 1 && m.players[1].kills === 0, 'move: el que se tiró pierde la ronda sin kill de nadie')
  check(!abyssAhead(pitMap(), 1) && abyssAhead(s, 1, 50), 'abyssAhead: lejos no avisa, con margen sí')
  // la IA nunca camina hacia un abismo: con el rival del otro lado y tiros bloqueados, igual no se mete
  const a = pitMap()
  fillRect(a.terrain, PIT0, 300, PIT1, 307, AIR)
  a.players[0].x = PIT0 - 40
  a.players[1].x = PIT1 + 60
  fillRect(a.terrain, PIT0 - 90, 230, PIT0 - 70, 299, STONE) // pared detrás: que quiera ir para adelante
  let falls = 0
  for (let i = 0; i < 6; i++) {
    a.wind = (i * 7) % 21 - 10
    const plan = chooseShot(a, 'easy')
    let q = a
    for (let k = 0; k < Math.abs(plan.move ?? 0); k++) q = applyCommand(q, { type: 'move', playerId: 0, dir: (plan.move ?? 0) > 0 ? 1 : -1 }).state
    if (!q.players[0].alive) falls++
  }
  check(falls === 0, `IA: no camina al abismo (${falls}/6)`)
  // la IA considera tirar al rival al abismo: parado en un puente de 4 px, con 100 de vida y solo
  // normal y pesada (no lo mata a balazos), el tiro que sirve es el que rompe el puente
  let pushed = 0
  for (let i = 0; i < 6; i++) {
    const q = pitMap()
    fillRect(q.terrain, PIT0, 304, PIT1, 307, AIR)
    q.wind = (i * 5) % 13 - 6
    for (const id of WEAPON_ORDER) q.players[0].ammo[id] = id === 'normal' ? 99 : id === 'heavy' ? 2 : 0
    q.players[1].hp = 100
    // sin el error de puntería (random fijo en 0,5): lo que se mide es si elige ese tiro
    const plan = chooseShot(q, 'hard', () => 0.5)
    const r = shoot(q, plan.weapon, plan.angle, plan.power)
    if (r.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss')) pushed++
  }
  console.log(`IA: elige tirar al rival al abismo ${pushed}/6`)
  check(pushed >= 3, `IA: no aprovecha el abismo (${pushed}/6)`)
}
{
  // la IA apunta por encima de una montaña alta (cima en y 115) con el rival del otro lado
  let hits = 0
  for (let i = 0; i < 6; i++) {
    const s = cloneState(createMatch(mk(1, 'normal', 'forest', 4, 1, 0, 'medium')))
    const t = s.terrain
    t.front.fill(AIR)
    t.back.fill(AIR)
    t.pits = new Uint8Array(t.w)
    for (let x = 0; x < t.w; x++) fillRect(t, x, Math.round(360 - 245 * Math.exp(-(((x - 800) / 110) ** 2))), x, t.h - 1, DIRT, 'both')
    fillRect(t, 0, t.h - 3, t.w - 1, t.h - 1, BEDROCK, 'both')
    s.props = []
    s.players[0].x = 520
    s.players[1].x = 1080
    for (const p of s.players) p.y = columnGround(t, p.x)
    s.current = 0
    s.wind = (i * 7) % 21 - 10
    const r = aiTurn(s, 'hard')
    if (r.events.some((e) => e.type === 'damage' && e.playerId === 1)) hits++
  }
  console.log(`IA: por encima de la montaña pega ${hits}/6`)
  check(hits >= 4, `IA: no pasa la montaña alta (${hits}/6)`)
}
{
  // determinismo y réplicas en mapas con abismos: el log de una partida Grande aplicado en otra réplica
  for (const size of ['medium', 'large'] as MapSize[]) {
    const config: MatchConfig = { slots: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }], rounds: 1, difficulty: 'normal', biome: 'jungle', seed: 17, size }
    let a = createMatch(config)
    let b = decodeState(encodeState(a))
    let steps = 0
    let diverged = 0
    let guard = 0
    while (a.phase === 'aiming' && guard++ < 60) {
      const p = a.players[a.current]
      const plan = chooseShot(a, 'normal')
      const cmds: Command[] = []
      for (const item of plan.items ?? []) cmds.push({ type: 'useItem', playerId: p.id, item })
      for (let i = 0; i < Math.abs(plan.move ?? 0); i++) cmds.push({ type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 })
      cmds.push({ type: 'selectWeapon', playerId: p.id, weapon: plan.weapon }, { type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power }, { type: 'fire', playerId: p.id })
      for (const cmd of cmds) {
        a = applyCommand(a, cmd).state
        b = applyCommand(b, cmd).state
        steps++
        if (netHash(a) !== netHash(b)) diverged++
      }
      if (steps > 40 && steps < 60) b = decodeState(encodeState(b)) // snapshot a mitad de partida
    }
    check(diverged === 0 && netHash(a) === netHash(b), `réplicas ${size} con pits: ${diverged} pasos distintos`)
    const x = createMatch(config)
    check(netHash(x) === netHash(createMatch(config)), `createMatch ${size} determinista con pits`)
  }
}

// ---------- 15. v4: agua y lava ----------
{
  console.log(`líquidos: ${liquidMaps} mapas con tramos, ${liquidCells.water} celdas de agua y ${liquidCells.lava} de lava en total`)
  check(liquidCells.water > 0 && liquidCells.lava > 0, 'líquidos: los mapas generados no traen agua y lava')
}
type FlowEv = Extract<GameEvent, { type: 'flow' }>
type SteamEv = Extract<GameEvent, { type: 'steam' }>
type BurnEv = Extract<GameEvent, { type: 'burn' }>
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
{
  // la grilla: los líquidos no son sólidos; el piso es el lecho; materialAt los ve
  const s = poolMap(WATER)
  const t = s.terrain
  check(!isSolid(t, 650, 320) && materialAt(t, 650, 320) === WATER && columnGround(t, 650) === 340 && groundAt(t, 650, TANK_HALF_W) === 340, 'agua: no sólida, piso en el lecho')
  const l = poolMap(LAVA)
  check(!isSolid(l.terrain, 650, 320) && materialAt(l.terrain, 650, 320) === LAVA && columnGround(l.terrain, 650) === 340, 'lava: no sólida, piso en el lecho')
  // un tanque en la pileta se apoya en el fondo (no flota)
  check(tankFloor(t, 650, 0) === 340, 'agua: el tanque se apoya en el lecho')
  // las explosiones y la excavadora no rompen líquidos
  const w0 = countT(t, WATER)
  deform(t, 650, 320, 30, 'destroy')
  deform(t, 650, 330, 20, 'dig')
  check(countT(t, WATER) === w0, 'deform: destroy y dig no rompen agua')
  const l0 = countT(l.terrain, LAVA)
  deform(l.terrain, 650, 320, 30, 'destroy')
  check(countT(l.terrain, LAVA) === l0, 'deform: no rompe lava')
  // Tierra sobre lava: piedra (la lava baja, no aparece tierra donde había lava)
  const lb = poolMap(LAVA)
  const st0 = countT(lb.terrain, STONE)
  deform(lb.terrain, 650, 310, 12, 'build')
  check(countT(lb.terrain, LAVA) < l0 && countT(lb.terrain, STONE) > st0, 'Tierra sobre lava: piedra')
  // Tierra sobre agua: el agua desplazada sube y el flujo la reparte (el volumen se conserva)
  const wb = poolMap(WATER)
  deform(wb.terrain, 650, 320, 12, 'build')
  check(countT(wb.terrain, WATER) === w0, `Tierra sobre agua: el agua se desplaza (${countT(wb.terrain, WATER)}/${w0})`)
  flowLiquids(wb.terrain, { seed: null, record: false })
  check(countT(wb.terrain, WATER) === w0, 'Tierra sobre agua: el flujo conserva el agua desplazada')
}
// rompe la pared de la pileta: el jugador 0 parado arriba de la pared se tira una pesada encima
function breakWall(m: number): { before: GameState; r: StepResult } {
  const s = poolMap(m)
  s.players[0].x = 712
  s.players[0].hp = 100
  return { before: s, r: shoot(s, 'heavy', 90, 8) }
}
{
  const { before, r } = breakWall(WATER)
  const flows = r.events.filter((e): e is FlowEv => e.type === 'flow')
  check(flows.length === 1, `flujo: un solo evento flow (${flows.length})`)
  const f = flows[0]
  if (f) {
    const impactT = Math.max(...r.events.filter((e) => e.type === 'impact').map((e) => (e as { t: number }).t))
    check(Number.isFinite(f.t) && Number.isFinite(f.dt) && f.dt > 0 && f.t > impactT, `flujo: t ${f.t} después de los impactos (${impactT}), dt ${f.dt}`)
    check(f.patches.length >= 3, `flujo: ${f.patches.length} parches`)
    const t = r.state.terrain
    check(
      f.patches.every((p) => p.x >= 0 && p.y >= 0 && p.w > 0 && p.h > 0 && p.x + p.w <= t.w && p.y + p.h <= t.h && p.front.length === p.w * p.h && p.back.length === p.w * p.h),
      'flujo: parches dentro de la grilla',
    )
    // parche 0 = antes del flujo; aplicar los demás sobre eso deja exactamente la grilla final
    const g0 = cloneTerrain(t)
    applyPatch(g0, f.patches[0])
    check(!sameGrid(g0, t), 'flujo: el parche 0 es el estado previo al flujo')
    for (const p of f.patches.slice(1)) applyPatch(g0, p)
    check(sameGrid(g0, t), 'flujo: los parches reproducen la grilla final')
    // el back no cambia con el flujo
    check(f.patches.every((p) => p.back.every((v, i) => v === t.back[(p.y + Math.floor(i / p.w)) * t.w + p.x + (i % p.w)])), 'flujo: back igual en los parches')
  }
  // conservación (sin abismo), corrió hacia el llano de abajo y quedó asentado
  check(countT(r.state.terrain, WATER) === countT(before.terrain, WATER), `flujo: el agua se conserva (${countT(before.terrain, WATER)} → ${countT(r.state.terrain, WATER)})`)
  let below = 0
  for (let x = 726; x < 1000; x++) for (let y = 300; y < 380; y++) if (r.state.terrain.front[y * r.state.terrain.w + x] === WATER) below++
  check(below > 0, 'flujo: el agua corre por la pared rota')
  const again = flowLiquids(cloneTerrain(r.state.terrain), { seed: null, record: false })
  check(!again.changed, `flujo: se asienta (${again.moves} movimientos más)`)
  // determinista: el mismo tiro da la misma grilla y los mismos parches
  const r2 = breakWall(WATER).r
  const f2 = r2.events.find((e): e is FlowEv => e.type === 'flow')
  check(netHash(r2.state) === netHash(r.state) && !!f && !!f2 && f2.patches.length === f.patches.length && f2.patches.every((p, i) => p.x === f.patches[i].x && p.w === f.patches[i].w && p.front.every((v, k) => v === f.patches[i].front[k])), 'flujo determinista')
  // los eventos se pueden clonar (los Uint8Array viajan en structuredClone; la red manda comandos y
  // cada réplica recalcula, ver réplicas)
  const cl = structuredClone(r.events)
  const fc = cl.find((e): e is FlowEv => e.type === 'flow')
  check(!!fc && fc.patches[0].front instanceof Uint8Array && fc.patches[0].front.length === f!.patches[0].front.length, 'flujo: structuredClone de los eventos')
  // réplica desde un snapshot con líquidos: mismo resultado
  const b = decodeState(encodeState(before))
  check(netHash(b) === netHash(before), 'snapshot con líquidos: mismo hash')
  check(netHash(shoot(b, 'heavy', 90, 8).state) === netHash(r.state), 'réplica con líquidos: mismo hash después del flujo')
  // un tiro que no toca líquidos no emite flow
  const dry = shoot(poolMap(WATER), 'normal', 150, 100)
  check(!dry.events.some((e) => e.type === 'flow'), 'flujo: sin cambios no hay evento')
  // el turno siguiente arranca después del flujo: la lava de muerte súbita (si hubiera) va después
}
{
  // abismo: lo que cae por un abismo se pierde y el volumen baja (nunca sube)
  const s = poolMap(WATER)
  const t = s.terrain
  fillRect(t, 725, 300, 820, t.h - 1, AIR)
  for (let x = 725; x <= 820; x++) t.pits![x] = 1
  const w0 = countT(t, WATER)
  deform(t, 715, 310, 20, 'destroy')
  const rep = flowLiquids(t, { seed: null, record: true })
  check(rep.lost.water > 0 && countT(t, WATER) === w0 - rep.lost.water && countT(t, WATER) < w0, `abismo: el agua que cae se pierde (${w0} → ${countT(t, WATER)}, perdida ${rep.lost.water})`)
}
{
  // agua + lava → piedra y vapor; el volumen de los dos baja
  const s = poolMap(LAVA)
  const t = s.terrain
  fillRect(t, 725, 300, 790, 379, DIRT, 'both')
  fillRect(t, 704, 300, 780, 339, WATER) // pileta de agua pegada, pared de 4 px [700, 703]
  const w0 = countT(t, WATER)
  const l0 = countT(t, LAVA)
  const st0 = countT(t, STONE)
  const tr = cloneTerrain(t)
  deform(tr, 702, 312, 8, 'destroy')
  const rep = flowLiquids(tr, { seed: null, record: true })
  const n = rep.steam.reduce((a, q) => a + q.n, 0)
  check(rep.steam.length > 0 && n > 0 && countT(tr, STONE) - st0 >= n, `agua + lava: piedra (${n} celdas, ${rep.steam.length} vapores)`)
  check(countT(tr, WATER) < w0 && countT(tr, LAVA) < l0 && countT(tr, WATER) <= w0 && countT(tr, LAVA) <= l0, 'agua + lava: los dos volúmenes bajan')
  // por fire: evento steam con t dentro del flujo
  const f = poolMap(LAVA)
  fillRect(f.terrain, 725, 300, 790, 379, DIRT, 'both')
  fillRect(f.terrain, 704, 300, 780, 339, WATER)
  f.players[0].x = 702
  const r = shoot(f, 'heavy', 90, 8)
  const flow = r.events.find((e): e is FlowEv => e.type === 'flow')
  const steams = r.events.filter((e): e is SteamEv => e.type === 'steam')
  check(!!flow && steams.length > 0 && steams.every((e) => e.n > 0 && e.t !== undefined && e.t >= flow.t && e.t <= flow.t + (flow.patches.length - 1) * flow.dt + 1e-9), `vapor por fire dentro del flujo (${steams.length})`)
}
{
  // la lava quema lo inflamable que toca (madera pegada a la pileta) y corre por donde se quemó
  const s = poolMap(LAVA)
  const t = s.terrain
  fillRect(t, 700, 300, 709, 339, WOOD, 'front')
  const wood0 = countT(t, WOOD)
  const tr = cloneTerrain(t)
  const rep = flowLiquids(tr, { seed: null, record: true })
  check(rep.burns.length > 0 && countT(tr, WOOD) < wood0, `lava: quema la madera (${wood0} → ${countT(tr, WOOD)})`)
  // por fire: burn con t dentro del flujo
  const r = shoot(s, 'normal', 150, 100)
  const flow = r.events.find((e): e is FlowEv => e.type === 'flow')
  const burns = r.events.filter((e): e is BurnEv => e.type === 'burn')
  check(!!flow && burns.length > 0 && burns.every((e) => e.t !== undefined && e.t >= flow.t && e.t <= flow.t + (flow.patches.length - 1) * flow.dt + 1e-9), 'lava: burn por fire dentro del flujo')
}
{
  // tanques: caer al agua no hace daño (fall.water) ni gasta el paracaídas; en seco sí hace daño
  const s = poolMap(WATER)
  const p = s.players[1]
  p.x = 650
  p.y = 240
  p.items.parachute = 1
  const ev = resolveBlast(s, blastFor('normal', 5, 5, 1))
  const fall = ev.find((e): e is FallEv => e.type === 'fall' && e.playerId === 1)
  check(!!fall && fall.water === true && fall.to === 340 && !ev.some((e) => e.type === 'damage' && e.playerId === 1) && p.items.parachute === 1, `agua: caída sin daño (${JSON.stringify(fall)})`)
  check(inWater(s.terrain, p.x, p.y), 'agua: el tanque quedó en el agua')
  const d = poolMap(WATER)
  d.players[1].x = 400
  d.players[1].y = 200
  const ev2 = resolveBlast(d, blastFor('normal', 5, 5, 1))
  check(ev2.some((e) => e.type === 'damage' && e.playerId === 1) && !ev2.some((e) => e.type === 'fall' && e.water), 'seco: la misma caída hace daño')
  // caminando: se tira de la pared a la pileta, sin daño
  let m = poolMap(WATER)
  m.players[0].x = 712
  const hp0 = m.players[0].hp
  let fellWater = false
  for (let i = 0; i < 40 && m.players[0].y === 300; i++) {
    const r = applyCommand(m, { type: 'move', playerId: 0, dir: -1 })
    if (r.events.some((e) => e.type === 'fall' && e.water)) fellWater = true
    m = r.state
  }
  check(fellWater && m.players[0].hp === hp0 && m.players[0].y > 300, `agua: se tira caminando sin daño (y ${m.players[0].y}, hp ${m.players[0].hp})`)
  // lava: tanque con lava en la caja recibe LAVA_DAMAGE al empezar cada turno (cause lava), una vez
  const l = poolMap(LAVA)
  l.players[1].x = 650
  l.players[1].y = 340
  check(inLava(l.terrain, l.players[1]), 'lava: inLava con el tanque en la pileta')
  // en el fondo de la pileta la lava lo tapa entero: muere en el acto
  const r = shoot(l, 'normal', 150, 100)
  check(!r.state.players[1].alive && r.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'lava'), 'lava: tapado entero en la pileta muere en el acto')
  // hundido a medias (la superficie le llega a las orugas): LAVA_DAMAGE por turno
  const half = poolMap(LAVA)
  let top = half.terrain.h
  for (let y = 0; y < half.terrain.h; y++) if (half.terrain.front[y * half.terrain.w + 650] === LAVA) { top = y; break }
  half.players[1].x = 650
  half.players[1].y = top + 6
  const rh = shoot(half, 'normal', 150, 100)
  const dmg = rh.events.filter((e) => e.type === 'damage' && e.playerId === 1)
  check(dmg.length === 1 && (dmg[0] as { cause?: string }).cause === 'lava' && (dmg[0] as { amount: number }).amount === LAVA_DAMAGE, `lava: daño por turno (${JSON.stringify(dmg)})`)
  // con la muerte súbita también encima, una sola vez
  const both = poolMap(LAVA)
  both.players[1].x = 650
  both.players[1].y = 340
  both.calm = SUDDEN_DEATH_CALM
  both.lava = 330
  const rb = shoot(both, 'normal', 150, 100)
  check(rb.events.filter((e) => e.type === 'damage' && e.playerId === 1).length === 1, 'lava: banda y pileta queman una sola vez')
  // un tanque al lado (sin lava en la caja) no se quema
  const dryT = poolMap(LAVA)
  dryT.players[1].x = 560
  dryT.players[1].y = 300
  check(!shoot(dryT, 'normal', 150, 100).events.some((e) => e.type === 'damage' && e.playerId === 1), 'lava: al lado de la pileta no quema')
}
{
  // proyectiles: el agua frena (WATER_DRAG por segundo) y registra la salpicadura; la lava derrite
  const s = poolMap(WATER, 120)
  const air = poolMap(AIR, 120)
  const base = { players: s.players, ownerId: 99, angle: 0, power: 0, wind: 0, ignoreTanks: true, origin: { x: 650, y: 250 }, velocity: { x: 0, y: 200 } }
  const fw = fly({ ...base, terrain: s.terrain })
  const fa = fly({ ...base, terrain: air.terrain })
  check(fw.impact.kind === 'terrain' && fa.impact.kind === 'terrain' && fw.time > fa.time * 1.15 && Math.abs(fw.vel.y) < Math.abs(fa.vel.y), `agua: frena el proyectil (${fw.time.toFixed(2)} s contra ${fa.time.toFixed(2)} s)`)
  check(fw.splashes?.length === 1 && Math.abs(fw.splashes[0].y - 300) < 2 && fw.splashes[0].t > 0 && fw.splashes[0].t < fw.time && !fa.splashes, `agua: salpicadura al entrar (${JSON.stringify(fw.splashes)})`)
  const l = poolMap(LAVA)
  const fl = fly({ ...base, terrain: l.terrain })
  check(fl.impact.kind === 'lava' && Math.abs(fl.impact.y - 300) < 2, `lava: derrite el proyectil (${fl.impact.kind} en y ${fl.impact.y.toFixed(1)})`)
  // por fire: el tiro que cae en la lava no explota
  const lf = poolMap(LAVA)
  lf.players[0].x = 650
  lf.players[0].y = 340
  const rl = shoot(lf, 'heavy', 90, 30)
  check(rl.flights![0].impact.kind === 'lava' && !rl.events.some((e) => e.type === 'impact'), 'lava: el proyectil se derrite sin explotar')
  // explosión sumergida: radio × WATER_BLAST_SCALE para el terreno y el daño
  const u = poolMap(WATER, 100)
  u.players[1].x = 650
  u.players[1].y = 400
  const ev = resolveBlast(u, blastFor('heavy', 650, 360, 1))
  const imp = ev.find((e) => e.type === 'impact') as { radius: number } | undefined
  check(!!imp && Math.abs(imp.radius - WEAPONS.heavy.radius * WATER_BLAST_SCALE) < 1e-9, `explosión sumergida: radio ${imp?.radius}`)
  check(!ev.some((e) => e.type === 'damage' && e.playerId === 1), 'explosión sumergida: el daño también llega a menos')
  // napalm en el agua no quema; en seco sí
  const n = poolMap(WATER, 100)
  n.players[0].x = 650
  n.players[0].y = 400
  const rn = shoot(n, 'napalm', 90, 8)
  check(rn.events.some((e) => e.type === 'impact') && !rn.events.some((e) => e.type === 'burn'), 'napalm sobre agua no quema')
  const nd = poolMap(WATER)
  nd.players[0].x = 400
  check(shoot(nd, 'napalm', 90, 8).events.some((e) => e.type === 'burn'), 'napalm en seco quema')
  // racimo: las bombitas también frenan y salpican
  const c = poolMap(WATER, 100)
  c.players[0].x = 560
  const rc = shoot(c, 'cluster', 80, 30)
  check(rc.flights!.length > 1, 'racimo con agua: se parte')
  // rodadora: la que termina en la pileta de lava se derrite
  let melted = 0
  let wrong = 0
  for (let pw = 6; pw <= 40; pw += 2) {
    const q = poolMap(LAVA)
    q.players[0].x = 520
    const rr = shoot(q, 'roller', 40, pw)
    const last = rr.flights![rr.flights!.length - 1]
    if (last.impact.x >= 600 && last.impact.x < 700 && last.impact.y > 296) {
      if (last.impact.kind === 'lava') melted++
      else wrong++
    }
  }
  check(melted > 0 && wrong === 0, `rodadora: se derrite en la lava (${melted}, mal ${wrong})`)
  let splashed = 0
  for (let pw = 6; pw <= 40; pw += 2) {
    const q = poolMap(WATER)
    q.players[0].x = 520
    const rr = shoot(q, 'roller', 40, pw)
    if (rr.flights!.some((f) => (f.splashes?.length ?? 0) > 0)) splashed++
  }
  check(splashed > 0, `rodadora: salpica al entrar al agua (${splashed})`)
}
{
  // IA: no camina a la lava. El rival está del otro lado de la pileta (lejos) y la IA tiene combustible.
  let into = 0
  for (let i = 0; i < 6; i++) {
    const s = poolMap(LAVA)
    s.players[0].x = 580
    s.players[1].x = 1300
    s.wind = (i * 7) % 21 - 10
    const r = aiTurn(s, 'easy')
    if (inLava(r.state.terrain, r.state.players[0])) into++
  }
  check(into === 0, `IA: se mete en la lava (${into}/6)`)
  // IA metida en la lava: sale (se mueve) si puede
  let out = 0
  for (let i = 0; i < 4; i++) {
    // charco de lava de bordes suaves (10 px de hondo en el centro, 1 px cada 4 de pendiente)
    const s = poolMap(AIR, 1)
    fillRect(s.terrain, 600, 300, 699, 300, DIRT)
    for (let x = 590; x <= 670; x++) {
      const d = Math.round(10 * (1 - Math.abs(x - 630) / 40))
      if (d > 0) fillRect(s.terrain, x, 300, x, 299 + d, LAVA)
    }
    s.players[0].x = 630
    s.players[0].y = 310
    s.wind = i * 3 - 5
    const plan = chooseShot(s, 'normal')
    let q = s
    for (let k = 0; k < Math.abs(plan.move ?? 0); k++) q = applyCommand(q, { type: 'move', playerId: 0, dir: (plan.move ?? 0) > 0 ? 1 : -1 }).state
    if (!inLava(q.terrain, q.players[0])) out++
  }
  console.log(`IA: sale de la lava ${out}/4`)
  check(out >= 2, `IA: no sale de la lava (${out}/4)`)
  // IA: rompe el borde de un pozo de lava para que corra hacia el rival (no obligatorio: se reporta).
  // Pozo de lava en lo alto (pared derecha fina) y el rival abajo, al pie de la pared; solo normal y
  // pesada y el rival con 100 de vida.
  let flooded = 0
  for (let i = 0; i < 6; i++) {
    const s = poolMap(LAVA)
    fillRect(s.terrain, 706, 300, 724, 339, AIR, 'front')
    s.players[0].x = 300
    s.players[1].x = 760
    s.players[1].y = 380
    s.players[1].hp = 100
    s.wind = (i * 5) % 13 - 6
    for (const id of WEAPON_ORDER) s.players[0].ammo[id] = id === 'normal' ? 99 : id === 'heavy' ? 2 : 0
    const plan = chooseShot(s, 'hard', () => 0.5)
    const r = shoot(s, plan.weapon, plan.angle, plan.power)
    if (inLava(r.state.terrain, r.state.players[1])) flooded++
  }
  console.log(`IA: rompe el pozo de lava hacia el rival ${flooded}/6`)
}
{
  // rendimiento del flujo: romper la pared de cada cuenca de 10 mapas Grande (peor caso realista)
  const times: number[] = []
  for (let seed = 1; seed <= 10; seed++) {
    const biome = BIOMES[seed % BIOMES.length]
    const g = generate(biome, new Rng(roundSeed(seed, 1)), 4, MAP_SIZES.large.w, MAP_SIZES.large.h)
    for (const q of g.basins ?? []) {
      for (const side of [-1, 1]) {
        const t = cloneTerrain(g.terrain)
        const v0 = liquidVolume(t)
        deform(t, side < 0 ? q.x0 - 2 : q.x1 + 1, q.level + 8, 26, 'destroy')
        const t0 = performance.now()
        const rep = flowLiquids(t, { seed: null, record: true })
        times.push(performance.now() - t0)
        const v1 = liquidVolume(t)
        check(v1.water + rep.lost.water <= v0.water && v1.lava + rep.lost.lava <= v0.lava, `flujo: el volumen crece al romper una cuenca (seed ${seed})`)
        const back = cloneTerrain(t)
        applyPatch(back, rep.patches[0] ?? { x: 0, y: 0, w: 0, h: 0, front: new Uint8Array(0), back: new Uint8Array(0) })
        for (const p of rep.patches.slice(1)) applyPatch(back, p)
        check(sameGrid(back, t), `flujo: parches que no reproducen la grilla (seed ${seed})`)
      }
    }
  }
  const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length)
  console.log(`flujo al romper cuencas en Grande: ${times.length} roturas, ${avg.toFixed(1)} ms medio, peor ${Math.max(...times).toFixed(1)} ms`)
  check(avg < 40, `flujo: romper una cuenca tarda ${avg.toFixed(1)} ms de media`)
}
{
  // réplicas en mapas con líquidos (bosque Mediano con lagos, industrial Grande con lava)
  for (const [size, biome] of [['medium', 'forest'], ['large', 'industrial']] as [MapSize, Biome][]) {
    // la primera seed cuyo mapa trae líquidos
    let config: MatchConfig = { slots: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }], rounds: 1, difficulty: 'normal', biome, seed: 23, size }
    for (let seed = 23; seed < 60; seed++) {
      config = { ...config, seed }
      const probe = createMatch(config)
      if (countT(probe.terrain, WATER) + countT(probe.terrain, LAVA) > 0) break
    }
    let a = createMatch(config)
    let b = decodeState(encodeState(a))
    check(countT(a.terrain, WATER) + countT(a.terrain, LAVA) > 0, `réplicas ${size}/${biome}: el mapa trae líquidos`)
    let diverged = 0
    let guard = 0
    let steps = 0
    while (a.phase === 'aiming' && guard++ < 40) {
      const p = a.players[a.current]
      const plan = chooseShot(a, 'normal')
      const cmds: Command[] = []
      for (let i = 0; i < Math.abs(plan.move ?? 0); i++) cmds.push({ type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 })
      cmds.push({ type: 'selectWeapon', playerId: p.id, weapon: plan.weapon }, { type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power }, { type: 'fire', playerId: p.id })
      for (const cmd of cmds) {
        a = applyCommand(a, cmd).state
        b = applyCommand(b, cmd).state
        steps++
        if (netHash(a) !== netHash(b)) diverged++
      }
      if (guard === 6) b = decodeState(encodeState(b))
    }
    check(diverged === 0 && netHash(a) === netHash(b), `réplicas ${size}/${biome} con líquidos: ${diverged} pasos distintos`)
  }
}
// ---------- 16. Pulido v2: empuje, deslizamiento, paracaídas, combustible y cruzar líquidos ----------
type SlideEv = Extract<GameEvent, { type: 'slide' }>
const slidesOf = (ev: GameEvent[], id?: number, cause?: 'blast' | 'slope') =>
  ev.filter((e): e is SlideEv => e.type === 'slide' && (id === undefined || e.playerId === id) && (cause === undefined || e.cause === cause))
// llano de Chico (flat) con el jugador 1 en x 600; explosión de prueba en (x, y)
// (por defecto a 270, arriba del tanque, para no volarle el piso: sin piso no hay empuje, cae)
function pushAt(weapon: WeaponId, x: number, y = 270, prep?: (s: GameState) => void, damage?: number): { s: GameState; ev: GameEvent[]; x0: number } {
  const s = flat()
  prep?.(s)
  const x0 = s.players[1].x
  const b = blastFor(weapon, x, y, 1)
  if (damage !== undefined) b.damage = damage
  const ev = resolveBlast(s, b)
  return { s, ev, x0 }
}
{
  // dirección: se aleja del centro; path con el piso cada PATH_DT, t del impacto, sin gastar combustible
  const r = pushAt('normal', 590, 299)
  const sl = slidesOf(r.ev, 1, 'blast')
  const p = r.s.players[1]
  check(sl.length === 1 && p.x > r.x0, `empuje: se aleja hacia la derecha (${r.x0} → ${p.x})`)
  if (sl[0]) {
    const path = sl[0].path
    check(sl[0].t === 1, `empuje: t del impacto (${sl[0].t})`)
    check(path[0].x === r.x0 && path[path.length - 1].x === p.x && path.every((q, i) => i === 0 || q.x > path[i - 1].x), 'empuje: path monótono desde la posición inicial')
    check(path.every((q) => q.y === 300), 'empuje: el path va por el piso')
    check(r.ev.findIndex((e) => e.type === 'impact') < r.ev.indexOf(sl[0]) && r.ev.findIndex((e) => e.type === 'damage' && e.playerId === 1) < r.ev.indexOf(sl[0]), 'empuje: después del impacto y del daño')
  }
  check(p.fuel === fuelFor(WORLD_W), 'empuje: no gasta combustible')
  const l = pushAt('normal', 610, 299)
  check(l.s.players[1].x < l.x0, `empuje: desde la derecha va a la izquierda (${l.x0} → ${l.s.players[1].x})`)
  // magnitud: más cerca y más fuerte empuja más; nunca más de KNOCKBACK_MAX
  const near = pushAt('normal', 590, 275).s.players[1].x - 600
  const far = pushAt('normal', 590, 270).s.players[1].x - 600
  const heavy = pushAt('heavy', 590, 270).s.players[1].x - 600
  const huge = pushAt('heavy', 590, 270, (s) => (s.players[1].shield = 500), 200).s.players[1].x - 600
  console.log(`empuje: normal a 5 px ${near}, a 10 px ${far}, pesada a 10 px ${heavy}, golpe de 200 ${huge} (tope ${KNOCKBACK_MAX})`)
  check(near > far && far > 0 && heavy > far, `empuje: más cerca y más fuerte empuja más (${near}, ${far}, ${heavy})`)
  check(huge === KNOCKBACK_MAX && heavy <= KNOCKBACK_MAX, `empuje: tope KNOCKBACK_MAX (${huge})`)
  check(pushAt('normal', 540, 299).s.players[1].x === 600, 'empuje: fuera del radio no empuja')
  // la Tierra no empuja
  check(slidesOf(pushAt('dirt', 590, 270).ev, 1, 'blast').length === 0, 'empuje: la Tierra no empuja')
  // sin piso (la explosión se lo voló) no hay empuje: cae al cráter
  const under = pushAt('heavy', 595, 299)
  check(slidesOf(under.ev, 1, 'blast').length === 0 && under.s.players[1].y > 300, 'empuje: sin piso no empuja, cae')
  // pared: se frena contra ella
  const w = pushAt('heavy', 590, 270, (s) => fillRect(s.terrain, 624, 240, 640, 299, STONE, 'both'))
  check(w.s.players[1].x + TANK_HALF_W <= 624 && w.s.players[1].x > 600, `empuje: frena contra la pared (x ${w.s.players[1].x})`)
  // otro tanque: se frena contra él (y no lo atraviesa)
  const o = pushAt('heavy', 590, 270, (s) => {
    s.players[0].x = 640
  })
  check(o.s.players[1].x <= 640 - 2 * TANK_HALF_W && o.s.players[1].x > 600, `empuje: frena contra otro tanque (x ${o.s.players[1].x})`)
  // escalones: sube los de MAX_CLIMB, frena en uno más alto
  const st = pushAt('heavy', 590, 270, (s) => fillRect(s.terrain, 616, 300 - MAX_CLIMB, 700, 299, DIRT, 'both'))
  check(st.s.players[1].y === 300 - MAX_CLIMB && st.s.players[1].x > 610, `empuje: sube un escalón de ${MAX_CLIMB} px (x ${st.s.players[1].x}, y ${st.s.players[1].y})`)
  const hi = pushAt('heavy', 590, 270, (s) => fillRect(s.terrain, 616, 286, 700, 299, DIRT, 'both'))
  check(hi.s.players[1].y === 300 && hi.s.players[1].x + TANK_HALF_W <= 616, `empuje: frena en un escalón de 14 px (x ${hi.s.players[1].x})`)
  // barril en cadena: también empuja (con el t de esa explosión)
  const b = pushAt('normal', 565, 299, (s) => {
    s.props = [{ id: 0, kind: 'barrel', x: 570, y: 288, w: 10, h: 12, alive: true }]
  })
  const bi = b.ev.filter((e): e is Extract<GameEvent, { type: 'impact' }> => e.type === 'impact' && e.source === 'barrel')
  const bs = slidesOf(b.ev, 1, 'blast')
  check(bi.length === 1 && bs.length === 1 && bs[0].t === bi[0].t && b.s.players[1].x > 600, `empuje: el barril en cadena empuja (${JSON.stringify(bs.map((e) => e.t))})`)
  // racimo, rodadora y nuke empujan con un tiro real (fire)
  for (const weapon of ['cluster', 'nuke', 'roller'] as WeaponId[]) {
    let pushed = false
    for (let power = 40; power <= 90 && !pushed; power += 0.5) {
      const r2 = shoot(flat(), weapon, 60, power)
      pushed = slidesOf(r2.events, 1, 'blast').length > 0
    }
    check(pushed, `empuje: ${weapon} empuja con un tiro`)
  }
}
{
  // empuje al abismo: parado a 6 px del borde, una explosión del otro lado lo tira (slide → fall → death)
  const s = pitMap()
  fillRect(s.terrain, PIT0, 300, PIT1, 307, AIR)
  s.players[1].x = PIT0 - TANK_HALF_W - 6
  s.players[1].items.parachute = 1
  const ev = resolveBlast(s, blastFor('heavy', s.players[1].x - 18, 299, 2))
  const sl = slidesOf(ev, 1, 'blast')
  const fall = ev.find((e): e is FallEv => e.type === 'fall' && e.playerId === 1)
  const death = ev.find((e): e is DeathEv => e.type === 'death' && e.playerId === 1)
  check(sl.length === 1 && !!fall && !!death && death.cause === 'abyss', `empuje: lo tira al abismo (${JSON.stringify(ev.map((e) => e.type))})`)
  if (sl[0] && fall && death) {
    const end = sl[0].t! + (sl[0].path.length - 1) * PATH_DT
    check(ev.indexOf(sl[0]) < ev.indexOf(fall) && ev.indexOf(fall) < ev.indexOf(death), 'empuje al abismo: slide → fall → death')
    check(fall.t !== undefined && fall.t >= end - 1e-9 && fall.to > s.height, `empuje al abismo: la caída va al terminar el empuje (${fall.t} ≥ ${end})`)
    check(s.players[1].items.parachute === 1, 'empuje al abismo: el paracaídas no se gasta')
  }
  // con un tiro de otro: cuenta como kill
  const k = pitMap()
  fillRect(k.terrain, PIT0, 300, PIT1, 307, AIR)
  k.players[1].x = PIT0 - TANK_HALF_W - 6
  let killed = false
  for (let a = 30; a <= 70 && !killed; a += 2) {
    for (let pw = 30; pw <= 100 && !killed; pw += 1) {
      const f = fly({ terrain: k.terrain, players: k.players, props: [], ownerId: 0, angle: a, power: pw, wind: k.wind })
      if (f.impact.kind !== 'terrain' || Math.abs(f.impact.x - (k.players[1].x - 20)) > 3) continue
      const r = shoot(k, 'heavy', a, pw)
      if (r.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss')) {
        killed = true
        check(r.state.players[0].kills === 1 && r.state.phase === 'roundover', 'empuje al abismo con un tiro: kill del tirador')
      }
    }
  }
  check(killed, 'empuje al abismo: encontré el tiro que lo tira')
  // al agua: sin daño de caída
  const wsm = poolMap(WATER)
  const q = wsm.players[0]
  q.x = 600
  q.items.parachute = 1
  const wev = resolveBlast(wsm, blastFor('heavy', q.x - 18, 270, 1))
  const wf = wev.find((e): e is FallEv => e.type === 'fall' && e.playerId === 0)
  check(slidesOf(wev, 0, 'blast').length === 1 && !!wf && wf.water === true && q.items.parachute === 1, `empuje: cae al agua sin daño (${JSON.stringify(wf)})`)
  check(wev.filter((e) => e.type === 'damage' && e.playerId === 0).length === 1, 'empuje al agua: solo el daño de la explosión')
}
{
  // deslizamiento: los spawns de todos los tamaños son planos y caminar por las rampas de los pads no resbala
  let pads = 0
  let rampSlides = 0
  let rampSteps = 0
  for (const size of MAP_SIZE_ORDER) for (const biome of BIOMES) for (const seed of [1, 2, 3, 4]) {
    const s = createMatch(mk(3, 'normal', biome, seed, 1, 0, size))
    for (const p of s.players) if (Math.abs(slopeAt(s, p.x, p.y)) > SLIDE_SLOPE) pads++
    // una explosión lejos de todos asienta a los tanques: nadie se mueve
    const c = cloneState(s)
    const ev = resolveBlast(c, blastFor('normal', 5, 5, 1))
    check(slidesOf(ev).length === 0 && c.players.every((p, i) => p.x === s.players[i].x && p.y === s.players[i].y), `deslizamiento: un mapa recién generado no resbala ${size}/${biome}/${seed}`)
    // cada tanque camina hasta 30 px a cada lado de su pad (las rampas son 1:1 como máximo)
    for (const p of s.players) {
      for (const dir of [-1, 1] as const) {
        let m = cloneState(s)
        m.current = p.id
        for (let i = 0; i < 30; i++) {
          if (abyssAhead(m, dir)) break
          const r = applyCommand(m, { type: 'move', playerId: p.id, dir })
          if (r.state === m || r.state.current !== p.id) break
          rampSteps++
          // v2.3: al borde de un abismo el tanque se puede volcar (vuelco al abismo): eso no es la rampa
          rampSlides += slidesOf(r.events).filter((e) => !r.state.terrain.pits?.some((v, x) => v === 1 && Math.abs(x - e.path[0].x) <= TANK_W)).length
          m = r.state
        }
      }
    }
  }
  console.log(`deslizamiento: ${rampSteps} pasos alrededor de los pads, ${rampSlides} deslizamientos`)
  check(pads === 0, `deslizamiento: ${pads} spawns en pendiente`)
  check(rampSlides === 0, `deslizamiento: ${rampSlides} deslizamientos en las rampas de los pads`)
  // pendientes construidas a mano: 1:1 y 2:1 (las de cerros y rampas) no resbalan; 3:1 sí
  const ramp = (run: number) => {
    const s = flat()
    for (let x = 500; x < 700; x++) fillRect(s.terrain, x, Math.max(200, 300 - Math.floor((x - 500) / run)), x, 299, DIRT, 'both')
    return s
  }
  const r1 = ramp(1)
  r1.players[1].x = 560
  r1.players[1].y = tankFloor(r1.terrain, 560, 0)
  check(Math.abs(slopeAt(r1, 560, r1.players[1].y)) <= SLIDE_SLOPE && slidesOf(resolveBlast(r1, blastFor('normal', 5, 5, 1))).length === 0, `deslizamiento: una rampa 1:1 no resbala (${slopeAt(r1, 560, r1.players[1].y).toFixed(2)})`)
  const h2 = ramp(0.5)
  h2.players[1].x = 540
  h2.players[1].y = tankFloor(h2.terrain, 540, 0)
  check(slidesOf(resolveBlast(h2, blastFor('normal', 5, 5, 1))).length === 0, `deslizamiento: una pendiente 2:1 no resbala (${slopeAt(h2, 540, h2.players[1].y).toFixed(2)})`)
  // v2.2: hasta ~75° (3,75) no resbala; para medir más hace falta una rampa más alta que el tanque
  const tall = (run: number) => {
    const s = flat()
    for (let x = 500; x < 700; x++) fillRect(s.terrain, x, Math.max(150, 300 - Math.floor((x - 500) / run)), x, 299, DIRT, 'both')
    return s
  }
  const r3 = ramp(1 / 3)
  r3.players[1].x = 520
  r3.players[1].y = tankFloor(r3.terrain, 520, 0)
  check(slidesOf(resolveBlast(r3, blastFor('normal', 5, 5, 1))).length === 0, `deslizamiento: una pendiente 3:1 no resbala (v2.2)`)
  const r2 = tall(1 / 6)
  r2.players[1].x = 514 // el borde izquierdo al pie de la rampa, el derecho sobre la meseta
  r2.players[1].y = tankFloor(r2.terrain, 514, 0)
  const y0 = r2.players[1].y
  const ev2 = resolveBlast(r2, blastFor('normal', 5, 5, 1))
  check(slidesOf(ev2, 1, 'slope').length === 1 && r2.players[1].x < 514 && r2.players[1].y > y0, `deslizamiento: una pendiente 6:1 resbala cuesta abajo (x ${r2.players[1].x}, y ${y0} → ${r2.players[1].y})`)
  // borde de cráter: un cráter hondo al costado del tanque lo hace resbalar adentro y queda estable
  const c = flat()
  for (const y of [300, 330, 360, 390]) deform(c.terrain, 628, y, 26, 'destroy')
  const cy0 = c.players[1].y
  const cev = resolveBlast(c, blastFor('normal', 5, 5, 1))
  const cs = slidesOf(cev, 1, 'slope')
  const cp = c.players[1]
  check(cs.length >= 1 && cp.x > 600 && cp.y > cy0, `deslizamiento: resbala al cráter (x ${cp.x}, y ${cp.y}, ${JSON.stringify(cev.map((e) => e.type))})`)
  check(Math.abs(slopeAt(c, cp.x, cp.y)) <= SLIDE_SLOPE, `deslizamiento: termina estable (pendiente ${slopeAt(c, cp.x, cp.y).toFixed(2)})`)
  if (cs[0]) check(cs[0].t !== undefined && cs[0].path.every((q, i) => i === 0 || q.x >= cs[0].path[i - 1].x), 'deslizamiento: con t y cuesta abajo')
  // move: caminar cuesta abajo por una pendiente 3:1 desliza; cuesta arriba no puede subir
  const d = tall(1 / 6)
  d.players[0].x = 560
  d.players[0].y = tankFloor(d.terrain, 560, 0)
  let down = d
  const dev: GameEvent[] = []
  const ok = d.players[0].y === 150 && Math.abs(slopeAt(d, 560, d.players[0].y)) <= SLIDE_SLOPE
  for (let i = 0; i < 60; i++) {
    const r = applyCommand(down, { type: 'move', playerId: 0, dir: -1 })
    dev.push(...r.events)
    down = r.state
  }
  check(ok && slidesOf(dev, 0, 'slope').length >= 1 && down.players[0].y > 240 && down.players[0].x < 520, `move: bajar una pendiente 6:1 desliza hasta donde apoya estable (x ${down.players[0].x}, y ${down.players[0].y})`)
  const fuelUsed = d.players[0].fuel - down.players[0].fuel
  check(560 - down.players[0].x > fuelUsed + 10, `move: el deslizamiento no gasta combustible (${fuelUsed} para ${560 - down.players[0].x} px)`)
  let up = down
  for (let i = 0; i < 40; i++) up = applyCommand(up, { type: 'move', playerId: 0, dir: 1 }).state
  check(up.players[0].y >= down.players[0].y - 6, `move: no sube una pendiente 6:1 (y ${down.players[0].y} → ${up.players[0].y})`)
  // v2.2: una 3:1 (~72°) sí se sube, gastando más combustible que en llano
  const u3 = ramp(1 / 3)
  u3.players[0].x = 470
  u3.players[0].y = 300
  u3.players[0].fuel = 300 // subir gasta más: que no se quede sin combustible a mitad de la rampa
  let c3 = u3
  for (let i = 0; i < 60; i++) c3 = applyCommand(c3, { type: 'move', playerId: 0, dir: 1 }).state
  const used3 = u3.players[0].fuel - c3.players[0].fuel
  check(c3.players[0].y <= 220 && used3 > c3.players[0].x - 470, `move: sube una pendiente 3:1 gastando más (y ${c3.players[0].y}, ${used3.toFixed(0)} de combustible para ${c3.players[0].x - 470} px)`)
  const u1 = ramp(1)
  u1.players[0].x = 470
  u1.players[0].y = 300
  let climb = u1
  for (let i = 0; i < 50; i++) climb = applyCommand(climb, { type: 'move', playerId: 0, dir: 1 }).state
  check(climb.players[0].y < 280, `move: sube una rampa 1:1 (y ${climb.players[0].y})`)
}
{
  // paracaídas: solo se abre si la caída haría al menos PARACHUTE_MIN_DAMAGE
  const fallBy = (drop: number) => {
    const s = flat()
    const p = s.players[1]
    p.items.parachute = 1
    fillRect(s.terrain, p.x - 20, 300, p.x + 20, 300 + drop - 1, AIR)
    const ev = resolveBlast(s, blastFor('normal', 5, 5, 1))
    const fall = ev.find((e): e is FallEv => e.type === 'fall' && e.playerId === 1)
    const dmg = ev.filter((e): e is Extract<GameEvent, { type: 'damage' }> => e.type === 'damage' && e.playerId === 1).reduce((a, e) => a + e.amount, 0)
    return { fall, dmg, left: p.items.parachute }
  }
  const small = fallBy(15)
  check(!!small.fall && !small.fall.parachute && small.dmg === Math.round(15 * 0.45) && small.left === 1, `paracaídas: caída chica (${small.dmg}) sin abrirlo`)
  const big = fallBy(40)
  check(!!big.fall && big.fall.parachute === true && big.dmg === 0 && big.left === 0, `paracaídas: caída grande lo abre (${JSON.stringify(big)})`)
  const edge = fallBy(Math.ceil(PARACHUTE_MIN_DAMAGE / 0.45))
  check(edge.fall?.parachute === true && edge.left === 0, 'paracaídas: en el umbral se abre')
  // al caminar (los primeros 12 px no hacen daño): bajar 30 px hace 8 y no lo abre
  const m = flat()
  fillRect(m.terrain, 150, 270, 214, 299, DIRT)
  m.players[0].y = 270
  m.players[0].items.parachute = 1
  let c = m
  const ev: GameEvent[] = []
  for (let i = 0; i < 40; i++) {
    const r = applyCommand(c, { type: 'move', playerId: 0, dir: 1 })
    ev.push(...r.events)
    c = r.state
  }
  const md = ev.filter((e): e is Extract<GameEvent, { type: 'damage' }> => e.type === 'damage').reduce((a, e) => a + e.amount, 0)
  check(ev.some((e) => e.type === 'fall') && c.players[0].items.parachute === 1 && md === Math.round(18 * 0.45), `paracaídas: bajar 30 px caminando (daño ${md}) no lo abre`)
}
{
  // combustible por ancho
  for (const size of MAP_SIZE_ORDER) {
    const w = MAP_SIZES[size].w
    const s = createMatch(mk(1, 'normal', 'forest', 5, 1, 1, size))
    check(s.players.every((p) => p.fuel === fuelFor(w)), `combustible ${size}: arranca con fuelFor (${s.players[0].fuel})`)
    const t = applyCommand(s, { type: 'fire', playerId: s.players[s.current].id }).state
    check(t.players[t.current].fuel === fuelFor(w), `combustible ${size}: el turno repone fuelFor`)
    const a = cloneState(s)
    a.players[a.current].items.fuel = 1
    const before = a.players[a.current].fuel
    const r = applyCommand(a, { type: 'useItem', playerId: a.players[a.current].id, item: 'fuel' }).state
    check(r.players[r.current].fuel === before + fuelFor(w), `combustible ${size}: el ítem suma fuelFor`)
  }
  check(fuelFor(800) === 60 && fuelFor(800) === FUEL_PER_TURN, 'combustible: Chico queda en 60')
  console.log(`combustible: ${MAP_SIZE_ORDER.map((z) => `${z} ${fuelFor(MAP_SIZES[z].w)}`).join(', ')}`)
}
{
  // Tierra sobre la lava de la grilla: no se derrite, construye en el contacto; lo que cae sobre lava es piedra
  const s = poolMap(LAVA)
  s.players[0].x = 560
  const lava0 = countT(s.terrain, LAVA)
  const stone0 = countT(s.terrain, STONE)
  let r: StepResult | null = null
  for (let pw = 20; pw <= 60 && !r; pw += 0.5) {
    const f = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: 0, angle: 60, power: pw, wind: 0 })
    if (f.impact.kind === 'lava' && f.impact.x > 630 && f.impact.x < 670) r = shoot(s, 'dirt', 60, pw)
  }
  check(!!r, 'Tierra sobre lava: encontré el tiro')
  if (r) {
    const imp = impactsOf(r)[0]
    check(r.flights![0].impact.kind === 'terrain' && !!imp && imp.weapon === 'dirt' && Math.abs(imp.y - 300) <= 2, `Tierra sobre lava: impacto en la superficie (${JSON.stringify(r.flights![0].impact)})`)
    const t = r.state.terrain
    check(countT(t, LAVA) < lava0 && countT(t, STONE) > stone0 + 100, `Tierra sobre lava: piedra (${countT(t, STONE) - stone0} celdas)`)
    let below = 0
    for (let x = imp.x - 8; x <= imp.x + 8; x++) if (t.front[302 * t.w + Math.round(x)] === STONE) below++
    let above = 0
    for (let x = imp.x - 5; x <= imp.x + 5; x++) if (t.front[294 * t.w + Math.round(x)] === DIRT) above++
    check(below >= 15 && above >= 9, `Tierra sobre lava: piedra abajo de la superficie y tierra arriba (${below}, ${above})`)
    // el flujo posterior respeta la piedra: sigue ahí después de otro fire
    const after = shoot(r.state, 'normal', 178, 100).state
    check(after.terrain.front[302 * t.w + Math.round(imp.x)] === STONE, 'Tierra sobre lava: el flujo respeta la piedra')
  }
  // banda de muerte súbita: tampoco se derrite; lo que construye debajo de la superficie es piedra
  const b = flat()
  b.lava = 290
  b.players[0].y = 300
  let rb: StepResult | null = null
  for (let pw = 30; pw <= 80 && !rb; pw += 1) {
    const f = fly({ terrain: b.terrain, players: b.players, props: [], ownerId: 0, angle: 60, power: pw, wind: 0, lava: 290 })
    if (f.impact.kind === 'lava' && f.impact.x > 330 && f.impact.x < 500) rb = shoot(b, 'dirt', 60, pw)
  }
  check(!!rb && rb.flights![0].impact.kind === 'terrain' && impactsOf(rb).length === 1, 'Tierra en la banda de lava: construye en vez de derretirse')
  if (rb) {
    const imp = impactsOf(rb)[0]
    const t = rb.state.terrain
    check(t.front[295 * t.w + Math.round(imp.x)] === STONE && t.front[285 * t.w + Math.round(imp.x)] === DIRT, 'Tierra en la banda: piedra debajo de la superficie, tierra arriba')
  }
  // las otras armas se siguen derritiendo en la lava
  const n = poolMap(LAVA)
  n.players[0].x = 560
  for (let pw = 20; pw <= 60; pw += 0.5) {
    const f = fly({ terrain: n.terrain, players: n.players, props: [], ownerId: 0, angle: 60, power: pw, wind: 0 })
    if (f.impact.kind === 'lava' && f.impact.x > 630 && f.impact.x < 670) {
      const r2 = shoot(n, 'normal', 60, pw)
      check(r2.flights![0].impact.kind === 'lava' && impactsOf(r2).length === 0, 'lava: la normal se sigue derritiendo')
      break
    }
  }
}
{
  // napalm sobre agua: piedra flotante en la superficie, con steam, que se puede cruzar
  const s = poolMap(WATER)
  s.players[0].x = 560
  const water0 = countT(s.terrain, WATER)
  let r: StepResult | null = null
  for (let pw = 20; pw <= 60 && !r; pw += 0.5) {
    const f = fly({ terrain: s.terrain, players: s.players, props: [], ownerId: 0, angle: 60, power: pw, wind: 0 })
    const sp = f.splashes?.[0]
    if (sp && sp.x > 640 && sp.x < 660) r = shoot(s, 'napalm', 60, pw)
  }
  check(!!r, 'napalm sobre agua: encontré el tiro')
  if (r) {
    const t = r.state.terrain
    const steam = r.events.filter((e): e is SteamEv => e.type === 'steam')
    check(steam.length >= 3 && steam.every((e) => e.t !== undefined && e.n > 0), `napalm sobre agua: eventos steam (${steam.length})`)
    let crust = 0
    for (let x = 600; x < 700; x++) {
      let n = 0
      for (let y = 300; y < 306; y++) if (t.front[y * t.w + x] === STONE) n++
      if (n >= 3 && n <= 4 && t.front[306 * t.w + x] === WATER) crust++
    }
    check(crust >= 60, `napalm sobre agua: capa de piedra de 3-4 px sobre el agua (${crust} columnas)`)
    check(countT(t, WATER) < water0 && countT(t, WATER) > water0 * 0.8, 'napalm sobre agua: el agua de abajo queda')
    // un tanque la cruza por arriba: se apoya en la piedra, sin caer al agua
    const c = cloneState(r.state)
    c.current = 0
    const cx = Math.round(steam[Math.floor(steam.length / 2)].x)
    c.players[0].x = cx
    c.players[0].y = tankFloor(c.terrain, cx, 0)
    c.players[0].fuel = 60
    check(c.players[0].y === 300, `napalm sobre agua: el tanque se apoya en la piedra (y ${c.players[0].y})`)
    let m = c
    const ev: GameEvent[] = []
    for (let i = 0; i < 20; i++) {
      const rr = applyCommand(m, { type: 'move', playerId: 0, dir: 1 })
      ev.push(...rr.events)
      m = rr.state
    }
    check(m.players[0].x > cx + 10 && !ev.some((e) => e.type === 'fall'), 'napalm sobre agua: se puede andar por arriba')
    // el flujo posterior respeta la piedra
    const after = shoot(r.state, 'normal', 178, 100).state
    check(countT(after.terrain, STONE) === countT(t, STONE), 'napalm sobre agua: el flujo respeta la piedra')
  }
  // napalm en tierra firme sigue quemando como antes (sin steam)
  const d = flat()
  const rd = shoot(d, 'napalm', 90, 1)
  check(rd.events.some((e) => e.type === 'burn') && !rd.events.some((e) => e.type === 'steam'), 'napalm en tierra: burn sin steam')
}
{
  // determinismo del empuje y el deslizamiento
  const a = pushAt('heavy', 585)
  const b = pushAt('heavy', 585)
  check(JSON.stringify(a.ev) === JSON.stringify(b.ev) && hashState(a.s) === hashState(b.s), 'empuje: determinista')
  // la IA usa el empuje: rival a 6 px del abismo con 100 de vida, solo normal y pesada → lo tira
  let pushed = 0
  for (let i = 0; i < 6; i++) {
    const q = pitMap()
    fillRect(q.terrain, PIT0, 300, PIT1, 307, AIR)
    q.players[1].x = PIT0 - TANK_HALF_W - 6
    q.wind = (i * 5) % 13 - 6
    for (const id of WEAPON_ORDER) q.players[0].ammo[id] = id === 'normal' ? 99 : id === 'heavy' ? 2 : 0
    const plan = chooseShot(q, 'hard', () => 0.5)
    const r = shoot(q, plan.weapon, plan.angle, plan.power)
    if (r.events.some((e) => e.type === 'death' && e.playerId === 1 && e.cause === 'abyss')) pushed++
  }
  console.log(`IA: empuja al rival al abismo ${pushed}/6`)
  check(pushed >= 3, `IA: no usa el empuje (${pushed}/6)`)
}
// ---------- 17. v5: hasta 8 jugadores (IA, reglas, réplicas y balance) ----------
// Mapa llano de prueba en Grande con 8 tanques en las x dadas (y = 300), toda la munición.
function crowdMap(xs: number[], hp: number[] = []): GameState {
  const s = cloneState(createMatch({ slots: xs.map(() => ({ kind: 'ai' as const })), rounds: 1, difficulty: 'hard', biome: 'forest', seed: 4, size: 'large' }))
  const t = s.terrain
  t.front.fill(AIR)
  t.back.fill(AIR)
  t.pits = new Uint8Array(t.w)
  fillRect(t, 0, 300, t.w - 1, t.h - 1, DIRT, 'both')
  fillRect(t, 0, t.h - 3, t.w - 1, t.h - 1, BEDROCK, 'both')
  s.props = []
  s.players.forEach((p, i) => {
    p.x = xs[i]
    p.y = 300
    p.hp = hp[i] ?? 100
    for (const id of WEAPON_ORDER) p.ammo[id] = WEAPONS[id].ammo
  })
  s.current = 0
  s.wind = 0
  return s
}
// A quién le pega el plan de la IA (sin error): el rival que más vida pierde, o -1.
function targetOf(s: GameState, ammo?: Partial<Record<WeaponId, number>>): number {
  if (ammo) for (const id of WEAPON_ORDER) s.players[s.current].ammo[id] = ammo[id] ?? 0
  const plan = chooseShot(s, 'hard', () => 0.5)
  let q = s
  for (let i = 0; i < Math.abs(plan.move ?? 0); i++) q = applyCommand(q, { type: 'move', playerId: q.players[q.current].id, dir: (plan.move ?? 0) > 0 ? 1 : -1 }).state
  const r = shoot(q, plan.weapon, plan.angle, plan.power)
  let best = -1
  let lost = 0
  for (const p of r.state.players) {
    if (p.id === s.players[s.current].id) continue
    const d = s.players[p.id].hp - p.hp
    if (d > lost) {
      lost = d
      best = p.id
    }
  }
  return best
}
{
  // IA con 8: elige blancos con sentido (solo normal, sin error de puntería; tres vientos)
  let weak = 0
  let near = 0
  let strong = 0
  for (const wind of [-6, 0, 6]) {
    // el más débil (se lo mata de un tiro) antes que uno entero más cerca
    const a = crowdMap([300, 520, 760, 1100, 1400, 1700, 2000, 2300], [100, 100, 15])
    a.wind = wind
    if (targetOf(a, { normal: 99 }) === 2) weak++
    // todos enteros: el más cercano
    const b = crowdMap([300, 520, 900, 1150, 1400, 1700, 2000, 2300])
    b.wind = wind
    if (targetOf(b, { normal: 99 }) === 1) near++
    // a la misma distancia, el entero (la amenaza a la que más turnos le quedan) antes que uno a medio morir
    const c = crowdMap([1200, 950, 1450, 300, 550, 1800, 2050, 2300], [100, 100, 50])
    c.wind = wind
    if (targetOf(c, { normal: 99 }) === 1) strong++
  }
  console.log(`v5 IA con 8: al más débil ${weak}/3, al más cercano ${near}/3, al entero antes que al tocado ${strong}/3`)
  check(weak >= 2, `v5: la IA no remata al más débil (${weak}/3)`)
  check(near >= 2, `v5: la IA no elige al más cercano (${near}/3)`)
  check(strong >= 2, `v5: la IA no elige al rival entero (${strong}/3)`)
}
{
  // IA simétrica: sin error, en el mapa espejado hace el tiro espejado (antes, los empates se los
  // quedaba el ángulo más bajo y la punta izquierda ganaba 2 de cada 3 rondas)
  const mirror = (s0: GameState): GameState => {
    const s = cloneState(s0)
    const t = s.terrain
    for (const g of [t.front, t.back]) for (let y = 0; y < t.h; y++) g.subarray(y * t.w, (y + 1) * t.w).reverse()
    if (t.pits) t.pits = t.pits.slice().reverse()
    for (const p of s.players) {
      p.x = t.w - p.x
      p.angle = 180 - p.angle
    }
    for (const p of s.props) p.x = t.w - p.x - (p.kind === 'flag' || p.kind === 'windsock' ? 2 : p.w)
    s.wind = -s.wind
    return s
  }
  let same = 0
  let total = 0
  for (const size of ['small', 'large'] as MapSize[]) {
    for (let seed = 1; seed <= 6; seed++) {
      const s = createMatch(mk(3, 'normal', BIOMES[seed % 3], seed, 1, 0, size))
      const a = chooseShot(s, 'normal', () => 0.5)
      const b = chooseShot(mirror(s), 'normal', () => 0.5)
      total++
      if (a.weapon === b.weapon && Math.abs(a.angle - (180 - b.angle)) <= 0.6 && Math.abs(a.power - b.power) <= 0.6) same++
    }
  }
  console.log(`v5 IA simétrica: ${same}/${total} tiros espejados`)
  check(same >= total * 0.8, `v5: la IA no es simétrica (${same}/${total} tiros espejados)`)
}
{
  // v2.2: el daño a otro reinicia la calma siempre, también con la muerte súbita activa (sin tope)
  const s = flat()
  s.calm = SUDDEN_DEATH_CALM
  s.lava = 440
  s.turn = 60
  s.players[1].x = s.players[0].x + 24
  s.players[1].y = s.players[0].y
  const hit = shoot(s, 'normal', 90, 1)
  check(hit.events.some((e) => e.type === 'damage') && hit.state.calm === 0 && !hit.events.some((e) => e.type === 'lava') && hit.state.lava === 440, `v2.2: con daño a otro la lava se frena y la calma vuelve a 0 (calm ${hit.state.calm}, lava ${hit.state.lava})`)
  check(calmEvents(hit).some((e) => e.left === SUDDEN_DEATH_CALM), 'v2.2: evento calm con la cuenta de nuevo completa')
}
{
  // réplicas y determinismo con 8 tanques en Grande: el log aplicado en otra réplica, con snapshot a mitad
  const config: MatchConfig = { slots: [{ kind: 'human' }, ...Array.from({ length: 7 }, () => ({ kind: 'ai' as const }))], rounds: 2, difficulty: 'normal', biome: 'rotate', seed: 23, size: 'large' }
  check(netHash(createMatch(config)) === netHash(createMatch(config)), 'v5: createMatch con 8 determinista')
  let a = createMatch(config)
  let b = decodeState(encodeState(a))
  let steps = 0
  let diverged = 0
  let snap = false
  let opener = -1
  let guard = 0
  const send = (cmd: Command) => {
    a = applyCommand(a, cmd).state
    b = applyCommand(b, cmd).state
    steps++
    if (netHash(a) !== netHash(b)) diverged++
  }
  while (a.phase !== 'gameover' && guard++ < 400) {
    if (a.phase === 'aiming') {
      if (a.round === 2 && opener < 0) opener = a.current
      const p = a.players[a.current]
      const plan = chooseShot(a, 'normal')
      for (const item of plan.items ?? []) send({ type: 'useItem', playerId: p.id, item })
      for (let i = 0; i < Math.abs(plan.move ?? 0); i++) send({ type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 })
      if (a.current !== p.id || a.phase !== 'aiming') continue
      send({ type: 'selectWeapon', playerId: p.id, weapon: plan.weapon })
      send({ type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power })
      send({ type: 'fire', playerId: p.id })
      if (!snap && steps > 60) {
        snap = true
        b = decodeState(encodeState(b))
      }
    } else if (a.phase === 'roundover') send({ type: 'nextRound' })
    else if (a.phase === 'shop') for (const p of a.players) if (a.phase === 'shop' && !p.ready) send({ type: 'ready', playerId: p.id })
  }
  check(a.phase === 'gameover' && a.round === 2 && a.players.length === 8, `v5: partida de 8 en Grande sin terminar (${a.phase}, ronda ${a.round})`)
  check(diverged === 0 && netHash(a) === netHash(b), `v5: réplicas con 8: ${diverged} pasos distintos`)
  // v2.3: el primer turno de cada ronda se sortea con la seed (ver 18); acá alcanza con que la ronda 2 arranque
  check(opener >= 0 && opener < 8, `v5: la ronda 2 no arrancó (${opener})`)
  console.log(`v5 réplicas con 8: ${steps} comandos, ${(encodeState(a).length / 1024).toFixed(0)} KB por snapshot`)
}
{
  // tiempo de la IA con 6 en Mediano y 8 en Grande (la difícil, que busca más)
  const worst: Record<string, number> = {}
  for (const [size, n] of [['medium', 6], ['large', 8]] as [MapSize, number][]) {
    const key = `${size} ${n}`
    for (const biome of BIOMES) {
      for (const seed of [2, 5, 9, 14]) {
        let s = createMatch({ slots: Array.from({ length: n }, () => ({ kind: 'ai' as const })), rounds: 1, difficulty: 'hard', biome, seed, size })
        for (let turn = 0; turn < 4 && s.phase === 'aiming'; turn++) {
          const r = aiTurn(s, 'hard')
          const tag = `${key}/${biome}/${seed}`
          worst[key] = Math.max(worst[key] ?? 0, r.ms)
          worstMs = Math.max(worstMs, r.ms)
          check(r.ms < AI_BUDGET_MS, `v5: la IA tardó ${r.ms.toFixed(0)} ms ${tag}`)
          check(r.events.some((e) => e.type === 'impact'), `v5: el tiro de la IA no explotó ${tag} turno ${turn}`)
          s = r.state
        }
      }
    }
  }
  console.log(`v5 IA peor caso: ${Object.entries(worst).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ')}`)
}
{
  // balance con 6 IA en Mediano y 8 en Grande (10 partidas; con --balance, 20). v2.3: Mediano con 6 juega
  // POS_GAMES partidas para medir el reparto de victorias por posición: ninguna gana más del 30%
  const POS_GAMES = 60
  for (const [size, n] of [['medium', 6], ['large', 8]] as [MapSize, number][]) {
    const games = size === 'medium' ? POS_GAMES : process.argv.includes('--balance') ? 20 : 10
    const t0 = performance.now()
    const res: MatchStats[] = []
    for (let seed = 1; seed <= games; seed++) res.push(match(n - 1, 100 + seed, size))
    const shots = res.map((r) => r.shots)
    const avg = shots.reduce((a, b) => a + b, 0) / games
    const turns = res.reduce((a, r) => a + r.turns, 0) / games
    const ranks = new Array(n).fill(0)
    for (const r of res) if (r.rank >= 0) ranks[r.rank]++
    const edges = ranks[0] + ranks[n - 1]
    const opener = res.filter((r) => r.opener).length
    const sudden = res.filter((r) => r.sudden).length
    const byLava = res.filter((r) => r.byLava).length
    const draws = res.filter((r) => r.winner === null).length
    const lavaMs = Math.max(...res.map((r) => r.lavaMs))
    console.log(
      `balance ${size} ${n} tanques: ${avg.toFixed(1)} tiros/partida (min ${Math.min(...shots)}, max ${Math.max(...shots)}, ${games} partidas), ${turns.toFixed(1)} turnos, empates ${draws}, muerte súbita en ${sudden}/${games} (terminan por la lava ${byLava})`,
    )
    console.log(`  ganador por posición desde la izquierda ${ranks.join('/')} (puntas ${edges}), gana el que abre ${opener}/${games}; IA con lava peor caso ${lavaMs.toFixed(0)} ms; ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    check(res.every((r) => r.walked === 0), `v5: la IA caminó al abismo (${size} ${n})`)
    check(shots.every((x) => x < 120), `v5: partida de ${n} sin terminar (${size})`)
    check(lavaMs < AI_BUDGET_MS, `v5: la IA con lava tardó ${lavaMs.toFixed(0)} ms (${size} ${n})`)
    // objetivo: ~40 tiros con 8 (el tope de calma corta las rondas largas)
    // v2.2: sin tope de calma (cada daño a otro frena la lava) las partidas de 6 y 8 se alargan
    // máximo de 8 tanques: 70 (con la inclinación del casco una de 20 partidas llegó a 67; la media es lo que importa)
    check(avg <= (n === 8 ? 50 : 44) && Math.max(...shots) <= (n === 8 ? 70 : 60), `v5: balance ${size} ${n} tanques: ${avg.toFixed(1)} tiros/partida, máximo ${Math.max(...shots)}`)
    // v2.3: con el sorteo de lugares y de primer turno, ninguna posición gana más del 30% (6 en Mediano)
    check(Math.max(...ranks) <= games * (n === 6 ? 0.3 : 0.6), `v5: una posición gana demasiado (${ranks.join('/')}) ${size} ${n}`)
  }
}
// ---------- 18. v2.3: abismo que mata, sorteo de lugares y de turno, puentes de Tierra ----------
{
  // cornisas, labios y puentes generados (Mediano y Grande, 30 seeds × 3 biomas)
  let abysses = 0
  let withCornice = 0
  let cornices = 0
  let bridges = 0
  let bad = 0
  let cols = 0
  let badSize = 0
  for (const size of ['medium', 'large'] as MapSize[]) {
    for (const biome of BIOMES) {
      for (let seed = 1; seed <= 30; seed++) {
        const g = generate(biome, new Rng(roundSeed(seed, 1)), 4, MAP_SIZES[size].w, MAP_SIZES[size].h)
        const t = g.terrain
        const segs = (g.segments ?? []).filter((q) => q.kind === 'abyss')
        abysses += segs.length
        for (const q of segs) if ((g.ledges ?? []).some((l) => l.kind === 'cornice' && l.x1 > q.x0 - CORNICE_SPILL && l.x0 < q.x1 + CORNICE_SPILL)) withCornice++
        for (const l of g.ledges ?? []) {
          if (l.kind === 'cornice') {
            cornices++
            if (l.thick < CORNICE_CRUST[0] || l.thick > CORNICE_CRUST[1] || l.x1 - l.x0 < 16 || l.x1 - l.x0 > CORNICE_LEN[1] + 16) badSize++
          } else bridges++
          // la mitad del medio: columnas de abismo con piso arriba (la costra o el puente, fino; la viga del
          // castillete de encima no cuenta) y debajo, por lo menos 40 px de aire (el socavón o el pozo: el
          // que la rompe cae al vacío; más abajo la pared serpentea y puede asomar)
          // (de la cornisa, la mitad de la punta: hacia la raíz el techo del socavón baja en arco)
          const w = l.x1 - l.x0
          const tipRight = l.kind === 'cornice' && !!g.mouth?.[l.x1]
          const xa = l.kind === 'bridge' ? l.x0 + (w >> 2) : tipRight ? l.x0 + (w >> 1) : l.x0 + 2
          const xb = l.kind === 'bridge' ? l.x1 - (w >> 2) : tipRight ? l.x1 - 2 : l.x1 - (w >> 1)
          // desde un poco arriba de la superficie de los costados (la viga del castillete queda más arriba)
          const y0 = Math.min(columnGround(t, l.x0 - 30), columnGround(t, l.x1 + 30)) - 12
          for (let x = xa; x < xb; x++) {
            let top = y0
            // la costra de la cornisa es tierra (encima puede haber una losa de piedra de la jungla)
            while (top < t.h && !(l.kind === 'cornice' ? t.front[top * t.w + x] === DIRT : isSolid(t, x, top))) top++
            let y = top
            while (y < t.h && isSolid(t, x, y)) y++
            const thick = y - top
            const under = Math.min(t.h, columnGround(t, x, y)) - y
            cols++
            if (!t.pits?.[x] || top >= t.h || thick > l.thick + 14 || under < 40) bad++
          }
        }
      }
    }
  }
  console.log(`v2.3 abismos: ${abysses} abismos, ${withCornice} con cornisa, ${cornices} cornisas, ${bridges} puentes; ${bad} de ${cols} columnas fuera de forma`)
  // la pared serpentea ±8 px por fila: unas pocas columnas de la punta salen algo más gruesas o con pared abajo
  check(bad <= cols * 0.05, `v2.3: ${bad} de ${cols} columnas de cornisa o puente mal formadas`)
  check(badSize === 0, `v2.3: ${badSize} cornisas con medidas fuera de rango`)
  check(withCornice >= abysses * 0.7 && bridges > 0, `v2.3: pocas cornisas (${withCornice}/${abysses}) o ningún puente (${bridges})`)
}
// Mapa llano de Mediano con un abismo [CM0, CM1] abierto desde la superficie y una cornisa de 8 px de
// costra a su izquierda ([CC0, CM0), con el vacío debajo). Tanque 0 lejos, tanque 1 en x1.
const CM0 = 700
const CM1 = 779
const CC0 = 650
function corniceMap(x1: number): GameState {
  const s = pitMap()
  const t = s.terrain
  fillRect(t, CC0, 308, CM0 - 1, t.h - 1, AIR, 'front')
  fillRect(t, CM0, 300, CM1, 307, AIR, 'front')
  for (let x = CC0; x <= CM1; x++) t.pits![x] = 1
  s.players[1].x = x1
  s.players[1].y = 300
  return s
}
const abyssDeath = (ev: GameEvent[], id: number) => ev.some((e) => e.type === 'death' && e.playerId === id && e.cause === 'abyss')
{
  // vuelco: con el centro sobre el vacío y apoyado de un solo lado, cae (antes hacía equilibrio sobre 3 columnas)
  const tip = corniceMap(CM0 + 6)
  const ev = resolveBlast(tip, blastFor('normal', 100, 299, 0))
  check(abyssDeath(ev, 1) && ev.some((e) => e.type === 'slide' && e.playerId === 1 && e.cause === 'slope'), 'v2.3: con el centro sobre el vacío se vuelca al abismo')
  // fuera de un abismo no cambia: el mismo borde sobre un pozo con fondo no lo vuelca
  const pit = flat()
  fillRect(pit.terrain, 600, 300, 700, 340, AIR)
  pit.players[1].x = 594
  const ev2 = resolveBlast(pit, blastFor('normal', 100, 299, 0))
  check(pit.players[1].x === 594 && !ev2.some((e) => e.type === 'slide'), 'v2.3: sin abismo, el borde de un pozo no vuelca')
  // sobre la cornisa entera se sostiene; un tiro que rompe la costra debajo lo tira al vacío
  const on = corniceMap(CC0 + 24)
  const ev3 = resolveBlast(on, blastFor('normal', 100, 299, 0))
  check(on.players[1].alive && on.players[1].x === CC0 + 24 && on.players[1].y === 300, 'v2.3: la cornisa sostiene al tanque')
  const broke = corniceMap(CC0 + 24)
  const ev4 = resolveBlast(broke, blastFor('normal', CC0 + 24, 304, 0))
  check(abyssDeath(ev4, 1), 'v2.3: romper la costra bajo el tanque lo tira al abismo')
  void ev3
}
{
  // el impacto directo empuja en el sentido en que venía el proyectil: de frente, al abismo de atrás
  const x1 = CM0 - TANK_HALF_W - 10
  const from = corniceMap(x1)
  const ev = resolveBlast(from, blastFor('normal', x1 - 6, 286, 0, 1, 80))
  check(abyssDeath(ev, 1), 'v2.3: un impacto directo desde el otro lado lo empuja al abismo')
  const back = corniceMap(x1)
  const ev2 = resolveBlast(back, blastFor('normal', x1 + 6, 286, 0, 1, -80))
  check(!abyssDeath(ev2, 1) && back.players[1].x < x1, `v2.3: el impacto que viene del abismo lo aleja (${x1} → ${back.players[1].x})`)
  // casi vertical: como antes, desde el punto del impacto
  const drop = corniceMap(x1)
  resolveBlast(drop, blastFor('normal', x1 + 6, 286, 0, 1, 1))
  check(drop.players[1].x < x1, 'v2.3: un impacto directo casi vertical empuja desde el punto del impacto')
  // la IA lo aprovecha: con el rival al borde, le tira de frente (sin error, tres vientos)
  let pushed = 0
  for (const wind of [-5, 0, 5]) {
    const s = corniceMap(x1)
    s.wind = wind
    const plan = chooseShot(s, 'hard', () => 0.5)
    if (abyssDeath(shoot(s, plan.weapon, plan.angle, plan.power).events, 1)) pushed++
  }
  console.log(`v2.3 IA: tira al rival de la cornisa al abismo ${pushed}/3`)
  check(pushed >= 2, `v2.3: la IA no aprovecha la cornisa (${pushed}/3)`)
  // en los mapas generados: un tanque que nace al borde (a SPAWN_PIT_GAP + 2 px de una boca abierta, sin puente),
  // con un impacto directo desde el otro lado (normal: empuja KNOCKBACK_MAX), cae
  let tries = 0
  let falls = 0
  for (const size of ['medium', 'large'] as MapSize[]) {
    for (let seed = 1; seed <= 120; seed++) {
      const s = createMatch(mk(3, 'normal', BIOMES[seed % 3], seed, 1, 0, size))
      const g = generate(BIOMES[seed % 3], new Rng(roundSeed(seed, 1)), 4, s.width, s.height)
      for (const p of s.players) {
        let side = 0
        const open = (x: number) => !!g.mouth?.[x] && columnGround(s.terrain, x, p.y - 2 * TANK_H) >= s.height
        for (let d = 0; d <= SPAWN_PIT_GAP + 2 && !side; d++) {
          if (open(p.x + TANK_HALF_W + d)) side = 1
          else if (open(p.x - TANK_HALF_W - 1 - d)) side = -1
        }
        if (!side) continue
        const c = cloneState(s)
        tries++
        if (abyssDeath(resolveBlast(c, blastFor('normal', p.x - side * 6, p.y - 14, 0, p.id, side * 80)), p.id)) falls++
      }
    }
  }
  console.log(`v2.3 empuje: tanques al borde de un abismo al nacer ${tries}, caen con un impacto directo ${falls}`)
  check(tries >= 10 && falls >= tries * 0.7, `v2.3: el empuje no tira al abismo (${falls}/${tries})`)
}
{
  // sorteo de lugares y de primer turno: determinista, pero repartido (Chico no cambia de terreno: ver 2d)
  const opens = new Array(6).fill(0)
  const p0rank = new Array(6).fill(0)
  let same = 0
  for (let seed = 1; seed <= 60; seed++) {
    const cfg = mk(5, 'normal', BIOMES[seed % 3], seed, 2, 0, 'medium')
    const a = createMatch(cfg)
    const b = createMatch(cfg)
    if (a.current === b.current && a.players.every((p, i) => p.x === b.players[i].x)) same++
    opens[a.current]++
    p0rank[a.players.map((p) => p.x).sort((x, y) => x - y).indexOf(a.players[0].x)]++
  }
  console.log(`v2.3 sorteo: abre ${opens.join('/')}, lugar del jugador 0 desde la izquierda ${p0rank.join('/')}`)
  check(same === 60, 'v2.3: el sorteo de lugares y de turno no es determinista')
  check(opens.every((n) => n >= 3) && p0rank.every((n) => n >= 3), `v2.3: el sorteo no se reparte (abre ${opens.join('/')}, jugador 0 ${p0rank.join('/')})`)
  // cada ronda sortea de nuevo: la ronda 2 no la abre siempre el mismo
  const second = new Set<number>()
  for (let seed = 1; seed <= 12; seed++) {
    // todas IA: la tienda se cierra sola y arranca la ronda 2
    const s = cloneState(createMatch(mk(3, 'normal', 'forest', seed, 2, 0, 'small')))
    s.phase = 'roundover'
    const r = applyCommand(s, { type: 'nextRound' }).state
    if (r.round === 2 && r.phase === 'aiming') second.add(r.current)
  }
  check(second.size >= 3, `v2.3: la ronda 2 la abre siempre el mismo (${[...second].join(',')})`)
}
{
  // puente de Tierra: la IA sin tiro y con un pozo de lava entre ella y el rival (que está bajo un techo de
  // roca madre) tira Tierra a la lava; turno a turno lo cruza
  const scene = (difficulty: Difficulty): GameState => {
    const s = cloneState(createMatch({ slots: [{ kind: 'ai' }, { kind: 'ai' }], rounds: 1, difficulty, biome: 'industrial', seed: 3, size: 'medium' }))
    const t = s.terrain
    t.front.fill(AIR)
    t.back.fill(AIR)
    t.pits = new Uint8Array(t.w)
    fillRect(t, 0, 300, t.w - 1, t.h - 1, DIRT, 'both')
    fillRect(t, 0, t.h - 3, t.w - 1, t.h - 1, BEDROCK, 'both')
    fillRect(t, 500, 300, 700, 340, AIR)
    fillRect(t, 498, 340, 702, 344, STONE)
    fillRect(t, 500, 300, 700, 339, LAVA)
    fillRect(t, 1040, 250, 1160, 256, BEDROCK)
    fillRect(t, 1040, 256, 1046, 299, BEDROCK)
    fillRect(t, 1154, 256, 1160, 299, BEDROCK)
    s.props = []
    s.players[0].x = 300
    s.players[1].x = 1100
    for (const p of s.players) p.y = 300
    for (const id of WEAPON_ORDER) s.players[0].ammo[id] = 0
    s.players[0].ammo.normal = 99
    s.players[0].ammo.dirt = 9
    s.current = 0
    s.wind = 0
    return s
  }
  const stone = (s: GameState) => {
    let n = 0
    for (let x = 500; x <= 700; x++) for (let y = 260; y < 340; y++) if (s.terrain.front[y * s.terrain.w + x] === STONE) n++
    return n
  }
  for (const difficulty of ['normal', 'hard'] as Difficulty[]) {
    let s = scene(difficulty)
    const before = aiStats.bridges
    let dirtShots = 0
    let turns = 0
    for (; turns < 12 && s.players[0].x < 700; turns++) {
      s = cloneState(s)
      s.current = 0
      s.phase = 'aiming'
      s.players[0].fuel = fuelFor(s.width)
      const r = aiTurn(s, difficulty)
      if (r.plan.weapon === 'dirt') dirtShots++
      s = r.state
    }
    console.log(`v2.3 puente (${difficulty}): ${dirtShots} tiros de Tierra, ${aiStats.bridges - before} tramos, piedra ${stone(s)} px, cruza en ${turns} turnos (x ${s.players[0].x})`)
    check(dirtShots >= 2 && stone(s) > 300, `v2.3: la IA no tiende el puente de Tierra (${difficulty})`)
    check(s.players[0].x > 700 && s.players[0].alive && s.players[0].hp === 100, `v2.3: la IA no cruza la lava por el puente (${difficulty}, x ${s.players[0].x}, vida ${s.players[0].hp})`)
  }
}
{
  // balance en mapas con abismo (Mediano y Grande, 4 y 6 tanques, 15 partidas de cada uno): al menos 1 de
  // cada 20 muertes es por abismo; y cuántas veces la IA tendió un puente de Tierra
  const t0 = performance.now()
  let deaths = 0
  let abyss = 0
  let games = 0
  let shots = 0
  const bridges0 = aiStats.bridges
  const crossings0 = aiStats.crossings
  for (const size of ['medium', 'large'] as MapSize[]) {
    for (const n of [4, 6]) {
      let found = 0
      for (let seed = 1; found < 15 && seed < 1000; seed++) {
        const biome = BIOMES[seed % 3]
        if (!(generate(biome, new Rng(roundSeed(seed, 1)), n, MAP_SIZES[size].w, MAP_SIZES[size].h).segments ?? []).some((q) => q.kind === 'abyss')) continue
        found++
        games++
        let s = createMatch(mk(n - 1, 'normal', biome, seed, 1, 0, size))
        for (let k = 0; s.phase === 'aiming' && k < 150; k++) {
          const r = aiTurn(s, 'normal')
          if (r.flights) shots++
          for (const e of r.events) {
            if (e.type !== 'death') continue
            deaths++
            if (e.cause === 'abyss') abyss++
          }
          s = r.state
        }
      }
    }
  }
  console.log(
    `v2.3 balance con abismo: ${games} partidas, ${(shots / games).toFixed(1)} tiros/partida, ${deaths} muertes, ${abyss} por abismo (${((100 * abyss) / deaths).toFixed(1)}%), puentes de Tierra ${aiStats.bridges - bridges0} (cruces ${aiStats.crossings - crossings0}); ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  )
  check(abyss * 20 >= deaths, `v2.3: pocas muertes por abismo (${abyss}/${deaths})`)
}
console.log(`IA peor caso: ${worstMs.toFixed(0)} ms`)
console.log(`${checks - failures}/${checks} chequeos OK`)
if (failures > 0) {
  console.error(`${failures} fallas`)
  process.exit(1)
}
