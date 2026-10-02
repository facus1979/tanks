import { fly, muzzle, skylineOf } from './ballistics'
import { abyssAhead, applyCommand } from './game'
import { flowLiquids } from './flow'
import { blastDamage, inLava, submerged } from './physics'
import { columnTop, hasLiquid, takeDirty } from './terrain'
import { Rng, hashSeed } from './rng'
import { NAPALM_DPS, NAPALM_SPREAD, resolveShot } from './weapons'
import {
  LAVA,
  LAVA_DAMAGE,
  LAVA_RISE,
  PLAYER_HP,
  REPAIR_HP,
  TANK_H,
  TANK_HALF_W,
  WATER_BLAST_SCALE,
  WEAPONS,
  WEAPON_ORDER,
  WORLD_W,
  type Difficulty,
  type GameState,
  type ItemId,
  type Player,
  type Terrain,
  type WeaponId,
} from './types'

const ERROR: Record<Difficulty, { angle: number; power: number }> = {
  easy: { angle: 9, power: 12 },
  normal: { angle: 6, power: 7 },
  hard: { angle: 1, power: 1.5 },
}

// v2: escala del mapa (k = ancho / 800). Con mapas más anchos la misma potencia cubre más
// pixels, así que la búsqueda va más fina y el error en grados y potencia se achica para que
// el error en pixels quede parecido al de v1 (ERROR_SCALE_EXP: 1 = mismo error en pixels; v3: 1,15,
// un poco menos de error en pixels porque con montañas y abismos en el medio hay menos tiros rectos).
// Con k = 1 todo da igual que en v1.
const ERROR_SCALE_EXP = 1.15
function mapScale(state: GameState): number {
  return state.terrain.w / WORLD_W
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

// v2 muerte súbita. Con la lava subiendo la ronda se termina: la munición especial se gasta
// (el costo de cada arma se multiplica por esto) y la IA pesa el daño de lava que la espera.
const LAVA_COST_SCALE = 0.25
const SELF_WEIGHT = 18 // lo mismo que pesa un punto de autodaño en el puntaje

function costOf(state: GameState, id: WeaponId): number {
  return state.lava !== null ? COST[id] * LAVA_COST_SCALE : COST[id]
}

// Daño de lava (en puntos de puntaje) que recibiría un tanque con el piso en y antes de su próximo
// turno: la lava sube una vez al empezar cada turno, así que hasta volver a jugar sube tantas veces
// como tanques vivos hay. Sin muerte súbita, 0.
export function lavaRisk(state: GameState, y: number): number {
  if (state.lava === null) return 0
  const rises = state.players.filter((p) => p.alive).length
  let n = 0
  for (let k = 1; k <= rises; k++) if (y > state.lava - k * LAVA_RISE) n++
  return n * LAVA_DAMAGE * SELF_WEIGHT
}

// v4: quedarse con lava de la grilla en la caja quema LAVA_DAMAGE por turno hasta salir: se pesa
// como dos turnos.
export function poolRisk(state: GameState, p: { x: number; y: number }): number {
  return inLava(state.terrain, p) ? 2 * LAVA_DAMAGE * SELF_WEIGHT : 0
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
  push?: boolean // v3: la estimación cree que tira a un rival al abismo
}

// v3: cuántos tiros "al abismo" se verifican con la simulación completa por búsqueda.
const PUSH_POOL = 6

interface Search {
  best: Candidate
  blocked: number // fracción de tiros que chocan pegados al tanque
}

// La IA usa la misma física sobre copias del estado (sin modificarlo). random: si no se pasa,
// se deriva del estado, así la sim sigue siendo determinista.
export function chooseShot(state: GameState, difficulty: Difficulty, random?: () => number): ShotPlan {
  const actor = state.players[state.current]
  const rand = random ?? rngFor(state)
  flowBudget = AI_FLOW_BUDGET
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

  // a veces se mueve: siempre que el tiro esté bloqueado o no llegue, y de vez en cuando igual.
  // Con la lava cerca (muerte súbita) también, y cada posición se paga con la lava que la alcanzaría:
  // así sale de la lava o se aleja de ella (hacia arriba) si puede, y no se mete caminando.
  const wander = rand() < 0.15
  const risk = lavaRisk(state, actor.y) + poolRisk(state, actor)
  let total = best.score - risk
  if (actor.fuel > 0 && (best.score < 1000 || wander || risk > 0)) {
    const steps = risk > 0 ? [-60, -40, -20, 20, 40, 60] : best.score < 1000 ? [-40, -20, 20, 40] : [-20, 20]
    for (const d of steps) {
      const moved = walk(state, d)
      if (!moved) continue
      const c = search(moved.state, weapons, false).best
      const mp = moved.state.players[moved.state.current]
      const score = c.score - lavaRisk(state, mp.y) - poolRisk(moved.state, mp)
      if (score > total + 60) {
        best = c
        total = score
        move = moved.dx
      }
    }
  }

  // tapado y sin tiro: excavadora hacia el rival más cercano
  if (best.score < 1000 && move === 0 && here.blocked > 0.5 && actor.ammo.digger > 0) {
    const t = nearest(actor, targets)
    return { angle: t.x > actor.x ? 30 : 150, power: 45, weapon: 'digger', ...extra }
  }

  const k = mapScale(state)
  const errScale = k > 1 ? k ** ERROR_SCALE_EXP : 1
  const err = ERROR[difficulty]
  // en mapas grandes un punto de potencia son muchos pixels: el plan va con un decimal
  const q = k > 1 ? 10 : 1
  const round = (n: number) => Math.round(n * q) / q
  const plan: ShotPlan = {
    angle: clamp(round(best.angle + ((rand() * 2 - 1) * err.angle) / errScale), 0, 180),
    power: clamp(round(best.power + ((rand() * 2 - 1) * err.power) / errScale), 10, 100),
    weapon: best.weapon,
  }
  if (move !== 0) plan.move = move
  if (items.length > 0) plan.items = items
  return plan
}

// v3: la IA no se acerca a menos de esto (en pasos de 1 px) de quedar colgando sobre un abismo.
export const AI_ABYSS_MARGIN = 24

// Aplica 'move' hasta |dx| pixels. null si no pudo avanzar. Nunca camina hacia un abismo: frena
// AI_ABYSS_MARGIN px antes del primer paso que la dejaría sin piso.
function walk(state: GameState, dx: number): { state: GameState; dx: number } | null {
  let s = state
  const id = s.players[s.current].id
  const dir = dx > 0 ? 1 : -1
  let n = 0
  for (; n < Math.abs(dx); n++) {
    if (abyssAhead(s, dir, AI_ABYSS_MARGIN)) break
    const r = applyCommand(s, { type: 'move', playerId: id, dir })
    if (r.state === s || r.state.current !== s.current) break
    // v4: no se mete caminando en la lava (si ya estaba adentro, puede seguir para salir)
    if (inLava(r.state.terrain, r.state.players[r.state.current]) && !inLava(s.terrain, s.players[s.current])) break
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
  const sky = skylineOf(state.terrain, state.players, state.props)
  // v3: rivales que se sostienen sobre un abismo (ver ledgeOf): la estimación suma el tiro que les
  // rompe el piso, y la simulación completa confirma si de verdad caen.
  const ledges = ledgesOf(state.terrain, targets)
  let aim = { angle: 0, power: 0, d: Infinity } // el tiro que cae más al centro de uno de esos rivales
  // los mejores tiros (según la estimación) que tiran a alguien al abismo, todos a verificar: la
  // estimación no sabe de durezas y suele haber pocos que de verdad sirvan
  const pushes: Candidate[] = []
  const addPush = (c: Candidate) => {
    if (pushes.some((q) => q.angle === c.angle && q.power === c.power)) return
    pushes.push(c)
    pushes.sort((a, b) => b.score - a.score)
    if (pushes.length > PUSH_POOL) pushes.pop()
  }
  // v4: bordes de pozos de lava con un rival más abajo de ese lado: el tiro que cae más cerca de cada
  // uno se verifica con la simulación completa (que deja correr la lava)
  const lips = lavaLipsOf(state.terrain, targets)
  const lipAim = lips.map(() => ({ angle: 0, power: 0, d: Infinity }))
  const consider = (angle: number, power: number) => {
    const r = estimate(state, actor, targets, weapons, angle, power, sky, ledges)
    total++
    if (r.at) {
      for (const l of ledges) {
        const d = Math.abs(r.at.x - l.p.x) + Math.max(0, r.at.y - l.p.y)
        if (d < aim.d) aim = { angle, power, d }
      }
      for (let i = 0; i < lips.length; i++) {
        const d = Math.abs(r.at.x - lips[i].x) + Math.abs(r.at.y - lips[i].y)
        if (d < lipAim[i].d) lipAim[i] = { angle, power, d }
      }
    }
    if (r.blocked) blocked++
    for (const c of r.list) {
      const prev = perWeapon.get(c.weapon)
      if (!prev || c.score > prev.score) perWeapon.set(c.weapon, c)
      if (c.score > best.score) best = c
      if (c.push) addPush(c)
    }
  }
  const k = mapScale(state)
  const da = fine ? 6 : 12
  const dp = fine ? 4 : 8
  // en mapas anchos la potencia mínima de 24 ya tira lejos: se busca desde más abajo
  const p0 = k > 1 ? 12 : 24
  for (let angle = 6; angle <= 174; angle += da) for (let power = p0; power <= 100; power += dp) consider(angle, power)
  if (aim.d < 40) {
    // refina alrededor del tiro que cae más al centro del rival colgado: el que le rompe el piso
    // suele estar en una ventana chica que la grilla gruesa no ve
    for (let a = -3; a <= 3; a += 1) for (let p = -2; p <= 2; p += 0.5) consider(clamp(aim.angle + a, 0, 180), clamp(aim.power + p, 10, 100))
  }
  if (fine) {
    const a0 = best.angle
    const p0 = best.power
    for (let a = -4; a <= 4; a += 1) for (let p = -3; p <= 3; p += 1) consider(clamp(a0 + a, 0, 180), clamp(p0 + p, 10, 100))
  }
  if (k > 1) {
    // segundo refinamiento: un punto de potencia o un grado ya son decenas de pixels
    const a1 = best.angle
    const p1 = best.power
    for (let a = -1; a <= 1; a += 0.5) for (let p = -1; p <= 1; p += 0.25) if (a !== 0 || p !== 0) consider(clamp(a1 + a, 0, 180), clamp(p1 + p, 10, 100))
  }
  for (let i = 0; i < lips.length; i++) {
    const la = lipAim[i]
    if (la.d >= 40) continue
    for (let a = -2; a <= 2; a += 1) for (let p = -1.5; p <= 1.5; p += 0.5) consider(clamp(la.angle + a, 0, 180), clamp(la.power + p, 10, 100))
  }
  // verificación con la simulación completa (racimo, rodadora y napalm no se estiman bien)
  const pool = [...perWeapon.values(), best, ...pushes]
  const lipWeapon: WeaponId = weapons.includes('heavy') ? 'heavy' : weapons[0]
  for (const la of lipAim) if (la.d < 16) pool.push({ angle: la.angle, power: la.power, weapon: lipWeapon, score: 0 })
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
  skyline?: Int16Array,
  ledges: Ledge[] = [],
): { list: Candidate[]; blocked: boolean; at?: { x: number; y: number } } {
  const flight = fly({
    skyline,
    terrain: state.terrain,
    players: state.players,
    props: state.props,
    ownerId: actor.id,
    angle,
    power,
    wind: state.wind,
    lava: state.lava ?? undefined,
  })
  // fuera del mapa o derretido en la lava: no sirve
  if (flight.impact.kind === 'out' || flight.impact.kind === 'lava') return { list: [{ angle, power, weapon: weapons[0], score: -1e6 }], blocked: false }
  const { x, y } = flight.impact
  const m = muzzle(actor.x, actor.y, angle)
  const blocked = Math.hypot(x - m.x, y - m.y) < 30
  let near = Infinity
  for (const t of targets) near = Math.min(near, Math.hypot(t.x - x, t.y - TANK_H / 2 - y))
  const list: Candidate[] = []
  // v4: explosión sumergida, radio a la mitad
  const wet = submerged(state.terrain, x, y) ? WATER_BLAST_SCALE : 1
  for (const id of weapons) {
    const w = WEAPONS[id]
    const spread = w.split ? 2.4 : w.rolls ? 2 : 1
    const blast = { x, y, radius: w.radius * spread * wet, damage: w.damage, terrain: w.terrain }
    let dmg = 0
    for (const t of targets) {
      let d = t.id === flight.impact.tankId ? w.damage : blastDamage(t, blast)
      if (w.burn && Math.abs(t.x - x) < NAPALM_SPREAD && Math.abs(t.y - y) < 30) d += NAPALM_DPS * w.burn
      dmg += Math.min(t.hp + t.shield, d)
    }
    // v3: el tiro le rompe el piso a un rival parado sobre el abismo: cae y muere (vale como matarlo)
    let push = false
    if (w.terrain === 'destroy') {
      for (const l of ledges) {
        if (!dropsInto(l, x, y, w.radius)) continue
        dmg += l.p.hp + l.p.shield + 25
        push = true
      }
    }
    const self = blastDamage(actor, blast)
    const cost = costOf(state, id)
    const score = dmg > 0 ? 1000 + dmg * 10 - self * SELF_WEIGHT - cost : -near - self * SELF_WEIGHT - cost * 0.01
    list.push(push ? { angle, power, weapon: id, score, push } : { angle, power, weapon: id, score })
  }
  return { list, blocked, at: flight.impact }
}

// v3: un rival que se sostiene sobre un abismo. Por cada columna de su caja: si es de abismo y lo
// que tiene debajo es un puente o un saliente (sólido y después aire hasta el fondo), la fila de
// abajo de ese sólido (cut, la que hay que romper); si no (piso firme), anchored. Si quedan menos de
// MIN_SUPPORT columnas firmes, romper los puentes lo tira.
interface Ledge {
  p: Player
  cuts: { x: number; y: number }[]
  anchored: number
}
const MIN_SUPPORT = 3 // como en physics

function ledgesOf(t: Terrain, targets: Player[]): Ledge[] {
  const out: Ledge[] = []
  if (!t.pits) return out
  for (const p of targets) {
    const cx = Math.round(p.x)
    let any = false
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W && !any; ix++) if (ix >= 0 && ix < t.w && t.pits[ix]) any = true
    if (!any) continue
    const cuts: { x: number; y: number }[] = []
    let anchored = 0
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) {
      if (ix < 0 || ix >= t.w) continue
      let y = Math.max(0, p.y)
      if (y >= t.h || t.front[y * t.w + ix] === 0) continue // sin piso en esta columna
      while (y < t.h && t.front[y * t.w + ix] !== 0) y++
      let open = t.pits[ix] === 1
      for (let yy = y; open && yy < t.h; yy++) if (t.front[yy * t.w + ix] !== 0) open = false
      if (open) cuts.push({ x: ix, y: y - 1 })
      else anchored++
    }
    if (anchored < MIN_SUPPORT && cuts.length > 0) out.push({ p, cuts, anchored })
  }
  return out
}

// La explosión en (x, y) de radio r rompe tantos puentes que el tanque queda con menos de
// MIN_SUPPORT columnas de apoyo (estimación: sin dureza de materiales).
function dropsInto(l: Ledge, x: number, y: number, r: number): boolean {
  let left = l.anchored
  const r2 = r * r
  for (const c of l.cuts) if ((c.x - x) ** 2 + (c.y - y) ** 2 > r2) left++
  return left < MIN_SUPPORT
}

// Grilla de trabajo para simulate: se reusa entre llamadas para no generar basura (en los mapas
// grandes cada copia son megas y las pausas del GC se notaban en el turno de la IA). Nunca sale
// de simulate, así que reusarla no cambia ningún resultado.
let scratch: Terrain | null = null

function scratchCopy(t: Terrain): Terrain {
  if (!scratch || scratch.front.length !== t.front.length) {
    scratch = { w: t.w, h: t.h, front: new Uint8Array(t.front.length), back: new Uint8Array(t.back.length) }
  }
  scratch.w = t.w
  scratch.h = t.h
  scratch.front.set(t.front)
  scratch.back.set(t.back)
  // v3: los abismos no cambian nunca (deform no los toca): alcanza con compartirlos
  scratch.pits = t.pits
  return scratch
}

// Copia del estado como cloneState, pero con la grilla de trabajo.
function scratchState(state: GameState): GameState {
  return {
    ...state,
    terrain: scratchCopy(state.terrain),
    props: state.props.map((p) => ({ ...p })),
    players: state.players.map((p) => ({ ...p, ammo: { ...p.ammo }, items: { ...p.items } })),
    earnings: { ...state.earnings },
  }
}

function simulate(state: GameState, c: Candidate): number {
  const s = scratchState(state)
  const actor = s.players[s.current]
  actor.angle = c.angle
  actor.power = c.power
  const before = s.players.map((p) => ({ hp: p.hp, alive: p.alive }))
  const { events } = resolveShot(s, actor, c.weapon)
  // v4: si el tiro tocó cerca de lava, la deja correr (como fire) y el rival que quede en ella cuenta
  // como golpeado por lo que la lava le va a quemar. El agua no daña: no hace falta simularla.
  // Tope de flujos por turno (flowBudget): pasado ese, la estimación sigue sin flujo.
  const dirty = takeDirty(s.terrain)
  if (flowBudget > 0 && dirty && hasLiquid(s.terrain, LAVA, dirty.x0 - 2, dirty.y0 - 2, dirty.x1 + 3, dirty.y1 + 3)) {
    flowBudget--
    flowLiquids(s.terrain, { seed: dirty, record: false, maxIters: AI_FLOW_ITERS, extraIters: 0 })
  }
  let dmg = 0
  let kills = 0
  let near = Infinity
  for (const p of s.players) {
    const b = before[p.id]
    if (p.id === actor.id || !b.alive) continue
    dmg += b.hp - p.hp
    if (!p.alive) kills++
    else if (newlyInLava(state, s, p.id)) dmg += Math.min(p.hp + p.shield, AI_LAVA_HIT)
    for (const e of events) if (e.type === 'impact') near = Math.min(near, Math.hypot(p.x - e.x, p.y - TANK_H / 2 - e.y))
  }
  let self = before[actor.id].hp - actor.hp
  if (actor.alive && newlyInLava(state, s, actor.id)) self += AI_LAVA_HIT
  if (!actor.alive) return -1e5
  if (!Number.isFinite(near)) return -1e6
  const cost = costOf(state, c.weapon)
  return dmg > 0 ? 1000 + dmg * 10 + kills * 250 - self * SELF_WEIGHT - cost : -near - self * SELF_WEIGHT - cost * 0.01
}

// v4: bordes de los pozos de lava de la grilla. Por cada tramo de columnas cuya primera celda no
// vacía es lava, el borde de cada lado (la pared) con la y de la superficie. Se calcula una vez por
// grilla (mover no cambia la grilla: los estados de la búsqueda la comparten).
interface PoolEdge {
  x: number // columna de la pared
  y: number // superficie de la lava junto a esa pared
  side: -1 | 1 // -1: pared izquierda (la lava correría hacia la izquierda)
}
const edgeCache = new WeakMap<Terrain, PoolEdge[]>()

function poolEdges(t: Terrain): PoolEdge[] {
  const cached = edgeCache.get(t)
  if (cached) return cached
  const out: PoolEdge[] = []
  let start = -1
  let startY = 0
  let lastY = 0
  for (let x = 0; x <= t.w; x++) {
    const top = x < t.w ? columnTop(t, x) : t.h
    const lava = top < t.h && t.front[top * t.w + x] === LAVA
    if (lava) {
      if (start < 0) {
        start = x
        startY = top
      }
      lastY = top
    } else if (start >= 0) {
      if (start > 0) out.push({ x: start - 1, y: startY, side: -1 })
      if (x < t.w) out.push({ x, y: lastY, side: 1 })
      start = -1
    }
  }
  edgeCache.set(t, out)
  return out
}

// Puntos a romper: la pared de un pozo de lava, un poco por debajo de la superficie, con un rival
// del lado de afuera a menos de LIP_RANGE px y más abajo que la lava (hacia donde correría).
const LIP_RANGE = 320
function lavaLipsOf(t: Terrain, targets: Player[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const e of poolEdges(t)) {
    const toward = targets.some((p) => (p.x - e.x) * e.side > 0 && Math.abs(p.x - e.x) < LIP_RANGE && p.y > e.y + 6)
    if (toward) out.push({ x: e.x + e.side * 2, y: e.y + 4 })
  }
  return out
}

// v4: lo que la IA le cuenta a un tanque que el tiro deja en la lava (dos turnos de quemadura) y el
// tope de iteraciones del flujo que simula (sin animar).
const AI_LAVA_HIT = 2 * LAVA_DAMAGE
const AI_FLOW_ITERS = 200
// flujos simulados por turno de la IA (se recarga en chooseShot): acota el peor caso con lava cerca
const AI_FLOW_BUDGET = 8
let flowBudget = AI_FLOW_BUDGET

// v4: el tanque id no tenía lava en la caja antes del tiro y después sí.
function newlyInLava(before: GameState, after: GameState, id: number): boolean {
  const a = after.players[id]
  if (!inLava(after.terrain, a)) return false
  return !inLava(before.terrain, before.players[id])
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
