import { fly, muzzle, skylineOf } from './ballistics'
import { tankTilt } from './tilt'
import { applyCommand } from './game'
import { flowLiquids } from './flow'
import { blastDamage, inLava, submerged } from './physics'
import { columnTop, hasLiquid, takeDirty } from './terrain'
import { Rng, hashSeed } from './rng'
import { SLIDE_MAX } from './slide'
import { NAPALM_DPS, NAPALM_SPREAD, resolveShot } from './weapons'
import {
  KNOCKBACK_MAX,
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

// v5: la normal pasa de ±6° / ±7 a ±7° / ±8. Con el desempate simétrico (flatTie) los tanques que tiran
// hacia la izquierda dejaron de tirar globos verticales y las partidas se acortaban (Chico 2 tanques 9,9 →
// 8,4 tiros); con este error vuelven al ritmo de antes.
const ERROR: Record<Difficulty, { angle: number; power: number }> = {
  easy: { angle: 9, power: 12 },
  normal: { angle: 7, power: 8 },
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

// v5: desempate simétrico. Muchos tiros dan exactamente el mismo puntaje (un impacto directo hace el
// daño entero del arma, con cualquier ángulo que pegue) y la búsqueda se quedaba con el primero que
// encontraba: el de menor ángulo. Hacia la derecha eso es el tiro más plano; hacia la izquierda, el
// globo más vertical (más expuesto al viento y al error). Resultado: el tanque de la punta izquierda
// ganaba 2 de cada 3 rondas en todos los tamaños. Con este desempate gana el tiro más plano hacia los
// dos lados (no cambia ningún puntaje de verdad: a lo sumo 0,0001 puntos; solo separa empates exactos).
const TIE_EPS = 1e-6
function flatTie(angle: number): number {
  return -Math.min(angle, 180 - angle) * TIE_EPS
}

// v5: prioridad de cada rival (con 6 u 8 tanques importa a quién se le tira). Multiplica el daño que se
// le hace en el puntaje. Con un solo rival vale 1 (2 tanques: como antes).
// - cercanía: el rival más cerca es el tiro más seguro (el error de puntería crece con la distancia) y
//   el que más rápido la puede lastimar: hasta +NEAR_W, que se va a 0 a NEAR_RANGE px;
// - amenaza: el rival entero (vida + escudo) es el que más turnos le queda para tirarle: hasta +STRONG_W;
// - líder: el que más rondas ganó (si le saca ventaja a todos): +LEADER_W.
// El más débil pesa por su cuenta: matarlo suma KILL_BONUS (un rival menos que tira; antes 25 y solo en
// simulate, así que un tiro que mataba casi nunca llegaba a verificarse).
// Medido con 8 IA en Grande (40 rondas): con cercanía 0,3 y "amenaza = el que me tiene de blanco más
// cercano" las puntas y el que abre la ronda ganaban la mitad; con estos pesos el ganador queda
// repartido entre las posiciones.
const NEAR_W = 0.15
const NEAR_RANGE = 600
const STRONG_W = 0.3
const LEADER_W = 0.1
const DUTY_W = 0.15
const EDGE_W = 0.12
const KILL_BONUS = 40 // en puntos de daño (· 10 en el puntaje; simulate suma lo mismo por kill)
function priorities(actor: Player, targets: Player[]): Map<number, number> {
  const out = new Map<number, number>()
  if (targets.length < 2) {
    for (const t of targets) out.set(t.id, 1)
    return out
  }
  const topWins = Math.max(...targets.map((t) => t.roundsWon))
  const leaders = targets.filter((t) => t.roundsWon === topWins).length
  for (const t of targets) {
    let w = 1 + NEAR_W * Math.max(0, 1 - Math.abs(t.x - actor.x) / NEAR_RANGE)
    // v2.3: si la IA es el rival más cercano de t (nadie lo tiene más a mano), le toca a ella: +DUTY_W.
    // Sin esto, con 6 u 8 tanques los de las puntas tenían un solo vecino que les tirara mientras los del
    // medio recibían de los dos lados: la punta izquierda ganaba ~37% de las rondas de 6 en Mediano.
    const mine = Math.abs(t.x - actor.x)
    if (targets.every((o) => o === t || Math.abs(o.x - t.x) >= mine)) w += DUTY_W
    // v2.3: el de una punta (ningún tanque vivo más allá de él, contando a la IA) tiene la espalda cubierta
    // por el borde del mapa: pesa EDGE_W más
    if (actor.x > t.x ? targets.every((o) => o.x >= t.x) : targets.every((o) => o.x <= t.x)) w += EDGE_W
    w += (STRONG_W * Math.min(PLAYER_HP, t.hp + t.shield)) / PLAYER_HP
    if (topWins > 0 && leaders === 1 && t.roundsWon === topWins) w += LEADER_W
    out.set(t.id, w)
  }
  return out
}

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
  flowBudget = flowBudgetFor(state.terrain.w)
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
  const total = best.score - risk
  if (actor.fuel > 0 && (best.score < 1000 || wander || risk > 0)) {
    const steps = risk > 0 ? [-60, -40, -20, 20, 40, 60] : best.score < 1000 ? [-40, -20, 20, 40] : [-20, 20]
    // v5: se queda con la mejor posición de todas (antes, la primera que superaba por 60 a la actual, y
    // como las de la izquierda se prueban primero, ganaban los empates: otro sesgo hacia un lado)
    let top = total + 60
    for (const d of steps) {
      const moved = walk(state, d)
      if (!moved) continue
      const c = search(moved.state, weapons, false).best
      const mp = moved.state.players[moved.state.current]
      const score = c.score - lavaRisk(state, mp.y) - poolRisk(moved.state, mp)
      if (score > top) {
        best = c
        top = score
        move = moved.dx
      }
    }
  }

  // v2.3: sin tiro desde ningún lado y con la lava cortándole el camino hacia el rival más cercano:
  // camina hasta la orilla y tira Tierra a la lava de adelante, que se vuelve piedra (un tramo de puente
  // por turno); con el puente ya tendido (sin lava adelante), lo cruza. No en la fácil.
  if (best.score < 1000 && difficulty !== 'easy') {
    const b = bridgePlan(state, targets)
    if (b?.shot) {
      aiStats.bridges++
      best = { angle: b.shot.angle, power: b.shot.power, weapon: 'dirt', score: 0 }
      move = b.move
    } else if (b) {
      aiStats.crossings++
      best = search(b.state, weapons, false).best
      move = b.move
    }
  }

  // tapado y sin tiro: excavadora hacia el rival más cercano
  if (best.score < 1000 && best.weapon !== 'dirt' && move === 0 && here.blocked > 0.5 && actor.ammo.digger > 0) {
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

// Aplica 'move' hasta |dx| pixels. null si no pudo avanzar al menos 4. Nunca camina hacia un abismo:
// frena AI_ABYSS_MARGIN px antes del primer paso que la tiraría (Pulido v2: incluido el que la deja en
// una pendiente que la hace resbalar al abismo; por eso se simulan los pasos con move, que ya desliza).
// Tampoco se mete en la lava ni da un paso que la mate (caída). Como cada paso de move deja al tanque
// estable (si resbala, ya se deslizó), nunca se queda parada en una pendiente que la haga resbalar.
function walk(state: GameState, dx: number): { state: GameState; dx: number } | null {
  const id = state.players[state.current].id
  const dir = dx > 0 ? 1 : -1
  const want = Math.abs(dx)
  const states: GameState[] = [state]
  let s = state
  let limit = want
  // el margen solo hace falta mirarlo con un abismo al alcance (el paso, el margen y un deslizamiento)
  const t = state.terrain
  const x = state.players[state.current].x
  const reach = want + AI_ABYSS_MARGIN + TANK_HALF_W + SLIDE_MAX
  let pit = false
  if (t.pits) for (let k = 0; k <= reach && !pit; k++) pit = t.pits[Math.round(x + dir * k)] === 1
  for (let n = 0; n < want + (pit ? AI_ABYSS_MARGIN : 0); n++) {
    const r = applyCommand(s, { type: 'move', playerId: id, dir })
    if (r.state === s) break
    if (r.state.current !== s.current || r.state.phase !== 'aiming') {
      // este paso la mata: si es el abismo, guarda el margen
      const abyss = r.events.some((e) => e.type === 'death' && e.playerId === id && e.cause === 'abyss')
      limit = Math.min(limit, abyss ? n - AI_ABYSS_MARGIN : n)
      break
    }
    // v4: no se mete caminando en la lava (si ya estaba adentro, puede seguir para salir)
    if (inLava(r.state.terrain, r.state.players[r.state.current]) && !inLava(s.terrain, s.players[s.current])) {
      limit = Math.min(limit, n)
      break
    }
    s = r.state
    states.push(s)
  }
  const n = Math.min(limit, states.length - 1)
  if (n < 4) return null
  return { state: states[n], dx: dir * n }
}

// v2.3: medición para sim-check (no cambia la simulación): turnos en que la IA tendió un tramo de puente y
// turnos en que caminó por un puente ya tendido.
export const aiStats = { bridges: 0, crossings: 0 }

// v2.3: puente de Tierra sobre la lava. La Tierra no se derrite (lavaSolid) y lo que construye sobre la
// lava es piedra: cada tiro deja un montículo de piedra de ~2 · radio de ancho por el que se puede pasar.
// Si entre la IA y su rival más cercano hay lava de la grilla a menos de BRIDGE_SCAN px (después de
// caminar hasta la orilla con el combustible del turno), busca el tiro de Tierra que cae BRIDGE_AHEAD px
// adentro de la lava. null si no hay lava en el camino, no le queda Tierra o ningún tiro cae a menos de
// BRIDGE_TOL px de ese punto (o caería encima de ella misma).
const BRIDGE_SCAN = 320
const BRIDGE_AHEAD = 6
const BRIDGE_TOL = 10
const BRIDGE_CLEAR = TANK_HALF_W + WEAPONS.dirt.radius / 2 + 6 // más cerca, la Tierra (daña a medio radio) la lastima
function bridgePlan(state: GameState, targets: Player[]): { shot?: { angle: number; power: number }; move: number; state: GameState } | null {
  const actor = state.players[state.current]
  if (actor.ammo.dirt <= 0 || targets.length === 0) return null
  const goal = nearest(actor, targets)
  const dir: -1 | 1 = goal.x > actor.x ? 1 : -1
  const t = state.terrain
  // atajo: sin lava entre los dos (arriba de todo en alguna columna), nada que hacer
  let any = false
  for (let x = Math.round(actor.x); x !== Math.round(goal.x) && !any; x += dir) {
    const top = columnTop(t, x)
    any = top < t.h && t.front[top * t.w + x] === LAVA
  }
  if (!any) return null
  // hasta la orilla con el combustible del turno (walk frena antes de meterse en la lava)
  let moved = actor.fuel > 0 ? walk(state, dir * Math.ceil(actor.fuel)) : null
  let s = moved?.state ?? state
  let p = s.players[s.current]
  // la primera columna con lava arriba de todo (desde la altura del tanque) desde su centro hacia adelante
  // (la que le queda bajo las orugas también: el último tramo hasta la orilla)
  let lx = -1
  for (let d = 0; d <= BRIDGE_SCAN && lx < 0; d++) {
    const x = Math.round(p.x + dir * d)
    if (x < 0 || x >= t.w || (x - goal.x) * dir >= 0) break
    const top = columnTop(t, x, Math.max(0, p.y - 2 * TANK_H))
    if (top < t.h && t.front[top * t.w + x] === LAVA) lx = x
  }
  // sin lava adelante: el puente ya llega (o la cruzó); solo camina
  if (lx < 0) return moved ? { move: moved.dx, state: s } : null
  // el punto: BRIDGE_AHEAD px adentro de la lava, a ras de su superficie (el montículo empalma con la
  // orilla o con el tramo anterior). Si quedó más cerca que BRIDGE_CLEAR, camina solo hasta esa distancia.
  const ax = lx + dir * BRIDGE_AHEAD
  const ay = columnTop(t, lx, Math.max(0, p.y - 2 * TANK_H))
  if (Math.abs(ax - p.x) < BRIDGE_CLEAR) {
    const dx = Math.round(ax - dir * BRIDGE_CLEAR - actor.x)
    moved = Math.abs(dx) >= 4 && actor.fuel > 0 ? walk(state, dx) : null
    s = moved?.state ?? state
    p = s.players[s.current]
    if (Math.abs(ax - p.x) < BRIDGE_CLEAR) return null
  }
  const sky = skylineOf(s.terrain, s.players, s.props)
  let best = { angle: 0, power: 0, d: Infinity }
  const tryShot = (angle: number, power: number) => {
    const f = fly({ skyline: sky, terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle, power, wind: s.wind, lava: s.lava ?? undefined, lavaSolid: true })
    if (f.impact.kind !== 'terrain') return
    const d = Math.hypot(f.impact.x - ax, f.impact.y - ay)
    // que no le caiga encima (la Tierra daña a medio radio)
    if (Math.abs(f.impact.x - p.x) < BRIDGE_CLEAR) return
    if (d < best.d) best = { angle, power, d }
  }
  const k = mapScale(state)
  const a0 = dir > 0 ? 6 : 96
  for (let angle = a0; angle <= a0 + 78; angle += 4) for (let power = k > 1 ? 10 : 20; power <= 100; power += 4) tryShot(angle, power)
  if (best.d < 60) {
    const { angle: a1, power: p1 } = best
    for (let a = -3; a <= 3; a += 1) for (let pw = -3; pw <= 3; pw += 0.5) tryShot(clamp(a1 + a, 0, 180), clamp(p1 + pw, 10, 100))
  }
  if (best.d > BRIDGE_TOL) return null
  return { shot: { angle: best.angle, power: best.power }, move: moved?.dx ?? 0, state: s }
}

function search(state: GameState, weapons: WeaponId[], fine: boolean): Search {
  const actor = state.players[state.current]
  const targets = state.players.filter((p) => p.alive && p.id !== actor.id)
  const perWeapon = new Map<WeaponId, Candidate>()
  let best: Candidate = { angle: actor.angle, power: actor.power, weapon: weapons[0], score: -Infinity }
  let total = 0
  let blocked = 0
  const sky = skylineOf(state.terrain, state.players, state.props)
  const prio = priorities(actor, targets)
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
  // Pulido v2: rivales al borde de un abismo o de la lava: el tiro que cae pegado a su otro costado los
  // empuja adentro (se verifica con la simulación completa, que resuelve el empuje)
  const brinks = brinksOf(state.terrain, targets)
  const brinkAim = brinks.map(() => ({ angle: 0, power: 0, d: Infinity }))
  const consider = (angle: number, power: number) => {
    const r = estimate(state, actor, targets, weapons, angle, power, sky, ledges, prio)
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
      for (let i = 0; i < brinks.length; i++) {
        const d = Math.abs(r.at.x - brinks[i].x) + Math.abs(r.at.y - brinks[i].y)
        if (d < brinkAim[i].d) brinkAim[i] = { angle, power, d }
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
  for (let i = 0; i < brinks.length; i++) {
    const ba = brinkAim[i]
    if (ba.d >= 40) continue
    for (let a = -2; a <= 2; a += 1) for (let p = -1.5; p <= 1.5; p += 0.5) consider(clamp(ba.angle + a, 0, 180), clamp(ba.power + p, 10, 100))
  }
  // verificación con la simulación completa (racimo, rodadora y napalm no se estiman bien)
  const pool = [...perWeapon.values(), best, ...pushes]
  for (const ba of brinkAim) {
    if (ba.d >= 16) continue
    for (const id of BRINK_WEAPONS) if (weapons.includes(id)) pool.push({ angle: ba.angle, power: ba.power, weapon: id, score: 0 })
  }
  const lipWeapon: WeaponId = weapons.includes('heavy') ? 'heavy' : weapons[0]
  for (const la of lipAim) if (la.d < 16) pool.push({ angle: la.angle, power: la.power, weapon: lipWeapon, score: 0 })
  let verified: Candidate = { ...best, score: -Infinity }
  for (const c of pool) {
    const score = simulate(state, c, prio)
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
  prio?: Map<number, number>,
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
  const m = muzzle(actor.x, actor.y, angle, tankTilt(state.terrain, actor.x, actor.y))
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
      const hit = Math.min(t.hp + t.shield, d)
      if (hit > 0) dmg += hit * (prio?.get(t.id) ?? 1) + (d >= t.hp + t.shield ? KILL_BONUS : 0)
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
    const score = (dmg > 0 ? 1000 + dmg * 10 - self * SELF_WEIGHT - cost : -near - self * SELF_WEIGHT - cost * 0.01) + flatTie(angle)
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

function simulate(state: GameState, c: Candidate, prio?: Map<number, number>): number {
  const s = scratchState(state)
  const actor = s.players[s.current]
  actor.angle = c.angle
  actor.power = c.power
  const before = s.players.map((p) => ({ hp: p.hp, alive: p.alive, x: p.x, y: p.y }))
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
    dmg += (b.hp - p.hp) * (prio?.get(p.id) ?? 1)
    if (!p.alive) kills++
    else if (newlyInLava(state, s, p.id)) dmg += Math.min(p.hp + p.shield, AI_LAVA_HIT)
    for (const e of events) if (e.type === 'impact') near = Math.min(near, Math.hypot(p.x - e.x, p.y - TANK_H / 2 - e.y))
  }
  let self = before[actor.id].hp - actor.hp
  if (actor.alive && newlyInLava(state, s, actor.id)) self += AI_LAVA_HIT
  if (!actor.alive) return -1e5
  if (!Number.isFinite(near)) return -1e6
  // Pulido v2: el empuje que acerca a un rival a un abismo o a la lava suma (de a poco lo va llevando al
  // borde); el que acerca a la propia IA, resta el doble
  const mask = hazardMask(state.terrain)
  let drift = 0
  for (const p of s.players) {
    if (!p.alive || !before[p.id].alive || p.x === before[p.id].x) continue
    const d0 = hazardDist(mask, before[p.id].x, before[p.id].y)
    const d1 = hazardDist(mask, p.x, p.y)
    if (d1 >= d0) continue
    drift += p.id === actor.id ? -2 * (d0 - d1) * HAZARD_PULL : (d0 - d1) * HAZARD_PULL
  }
  const cost = costOf(state, c.weapon)
  return (dmg > 0 ? 1000 + dmg * 10 + kills * KILL_BONUS * 10 - self * SELF_WEIGHT - cost : -near - self * SELF_WEIGHT - cost * 0.01) + drift + flatTie(c.angle)
}

// Pulido v2: columnas peligrosas (abismo o lava arriba de todo) por grilla. Se calcula una vez por grilla
// real (la búsqueda la comparte; la grilla de trabajo de simulate no se usa para esto).
// v2.3: por columna, la fila desde la que es peligrosa: lava arriba de todo, 0 (siempre); abismo, la fila
// desde la que no hay nada hasta el fondo (la boca es peligrosa para un tanque con el piso por debajo de
// eso; una cornisa o un puente bajo el tanque, no); el resto, nunca (HAZARD_NONE).
const HAZARD_RANGE = 160
const HAZARD_PULL = 3 // puntos de puntaje por pixel que el empuje acerca a un rival al peligro
const HAZARD_NONE = 0x7fff
const hazardCache = new WeakMap<Terrain, Int16Array>()
function hazardMask(t: Terrain): Int16Array {
  const cached = hazardCache.get(t)
  if (cached) return cached
  const m = new Int16Array(t.w).fill(HAZARD_NONE)
  for (let x = 0; x < t.w; x++) {
    const top = columnTop(t, x)
    if (top < t.h && t.front[top * t.w + x] === LAVA) m[x] = 0
    else if (t.pits?.[x]) {
      let y = t.h
      while (y > 0 && t.front[(y - 1) * t.w + x] === 0) y--
      m[x] = y
    }
  }
  hazardCache.set(t, m)
  return m
}
// Distancia del borde de la caja del tanque con el piso en (x, y) al peligro más cercano (HAZARD_RANGE si no hay).
function hazardDist(m: Int16Array, x: number, y: number): number {
  const cx = Math.round(x)
  for (let d = 0; d < HAZARD_RANGE; d++) {
    const a = cx - TANK_HALF_W - d
    const b = cx + TANK_HALF_W - 1 + d
    if ((a >= 0 && m[a] <= y) || (b < m.length && m[b] <= y)) return d
  }
  return HAZARD_RANGE
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

// Pulido v2: rivales con un abismo o lava de la grilla a menos de un empujón de su costado. Por cada uno,
// el punto donde tiene que caer el tiro: pegado al otro costado de su caja, a la altura de las orugas.
const BRINK_REACH = KNOCKBACK_MAX + 8
const BRINK_WEAPONS: WeaponId[] = ['heavy', 'normal', 'nuke']
function brinksOf(t: Terrain, targets: Player[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const p of targets) {
    for (const side of [-1, 1] as const) {
      let hazard = false
      for (let d = TANK_HALF_W; d <= TANK_HALF_W + BRINK_REACH && !hazard; d += 2) {
        const x = Math.round(p.x + side * d)
        if (x < 0 || x >= t.w) break
        if (t.pits?.[x] && columnTop(t, x, Math.max(0, p.y - TANK_H)) >= t.h) hazard = true // v2.3: la boca, a su altura
        else {
          const top = columnTop(t, x, Math.max(0, p.y - TANK_H))
          if (top < t.h && t.front[top * t.w + x] === LAVA) hazard = true
        }
      }
      if (hazard) out.push({ x: p.x - side * (TANK_HALF_W + 3), y: p.y - 3 })
    }
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
// v5: cada flujo simulado cuesta más cuanto más ancho el mapa (en Grande ~17 ms) y con 8 tanques hay más
// bordes de pozo con un rival abajo: el tope baja con el cuadrado del ancho pasado Mediano (Grande: 4)
// para que el turno siga bajo 250 ms. Chico y Mediano quedan en AI_FLOW_BUDGET.
function flowBudgetFor(width: number): number {
  return Math.min(AI_FLOW_BUDGET, Math.round(AI_FLOW_BUDGET * (1600 / width) ** 2))
}

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
