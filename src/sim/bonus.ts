// v3 recompensas en la partida (BONUS, evento 'bonus') y cajas de botín que caen en paracaídas.
//
// Bonos que cobra el que dispara, al momento (se suman a Player.money y a GameState.earnings):
// - longshot: su proyectil pega directo en un rival que estaba a más de LONGSHOT_FRAC del ancho del mapa
//   (una vez por tiro, aunque el racimo pegue varias veces);
// - double: el tiro mata a dos o más rivales (uno solo, por el tiro);
// - abyss: por cada rival que el tiro tira al abismo; collapse: por cada rival que mata un derrumbe del tiro;
// - lava: por cada rival que el tiro mete en la lava (de la grilla o de la banda) y que la lava mata al
//   cerrar ese turno (la lava sola sigue sin dar plata ni kills: esto paga el empujón);
// - firstblood: el primer daño a un rival en la ronda (GameState.bonusFirstBlood);
// - loot / target: romper una caja de botín o destruir un objetivo pago del mapa.
// El cartel flotante va en x/y del evento (el rival, la caja o el objetivo) y en su t.
//
// Lo cobrado en bonos queda anotado aparte (bonusPaid, interno de sim: viaja en el estado serializado y en
// el hash, sin ser parte del contrato) para que endRound no lo vuelva a sumar: la plata de fin de ronda se
// calcula como antes con lo que no es bono, y earnings del 'roundover' lo incluye.
import { inLava } from './physics'
import { groundAt, columnGround, columnTop, isPit } from './terrain'
import { PROP_SIZE, liquidBelow } from './gen'
import { Rng, hashSeed } from './rng'
import {
  BONUS,
  LONGSHOT_FRAC,
  TANK_H,
  TANK_HALF_W,
  type BonusKind,
  type Flight,
  type GameEvent,
  type GameState,
  type Prop,
} from './types'

type WithBonus = GameState & { bonusPaid?: Record<number, number> }

// Bono ya cobrado en la ronda por este jugador.
export function bonusPaid(state: GameState, id: number): number {
  return (state as WithBonus).bonusPaid?.[id] ?? 0
}

// La ronda nueva arranca sin bonos cobrados.
export function resetBonus(state: GameState): void {
  delete (state as WithBonus).bonusPaid
  state.bonusFirstBlood = false
}

// Medición para sim-check (no cambia la simulación): bonos pagados por tipo y plata total.
export const bonusStats: { count: Record<string, number>; money: number; loot: number } = { count: {}, money: 0, loot: 0 }

export function payBonus(state: GameState, id: number, kind: BonusKind, x: number, y: number, t: number | undefined, events: GameEvent[]): void {
  const p = state.players.find((q) => q.id === id)
  if (!p) return
  const amount = BONUS[kind]
  p.money += amount
  state.earnings = { ...state.earnings, [id]: (state.earnings[id] ?? 0) + amount }
  const s = state as WithBonus
  s.bonusPaid = { ...(s.bonusPaid ?? {}), [id]: (s.bonusPaid?.[id] ?? 0) + amount }
  const e: GameEvent = { type: 'bonus', playerId: id, kind, amount, x: Math.round(x), y: Math.round(y) }
  if (t !== undefined) e.t = t
  events.push(e)
  bonusStats.count[kind] = (bonusStats.count[kind] ?? 0) + 1
  bonusStats.money += amount
}

export interface Before {
  hp: number
  alive: boolean
  x: number
  y: number
}

// Bonos de un tiro (todo menos 'lava', que se cobra al cerrar el turno: ver lavaBonus). before: vida
// (con escudo), si estaba vivo y dónde, antes del tiro, por id. Va después de resolver el tiro, el
// derrumbe y los líquidos, antes de cerrar el turno.
export function shotBonuses(state: GameState, shooterId: number, before: Before[], events: GameEvent[], flights: Flight[]): void {
  const shooter = state.players.find((p) => p.id === shooterId)
  if (!shooter) return
  const rivals = state.players.filter((p) => p.id !== shooterId && before[p.id]?.alive)
  const timeOf = (id: number, type: 'death' | 'damage') => {
    for (const e of events) if (e.type === type && e.playerId === id && e.t !== undefined) return e.t
    return undefined
  }
  // primera sangre: el primer daño (o escudo) a un rival en la ronda
  if (!state.bonusFirstBlood) {
    for (const e of events) {
      if ((e.type !== 'damage' && e.type !== 'shield') || e.playerId === shooterId) continue
      if (!rivals.some((p) => p.id === e.playerId) || (e.type === 'damage' && e.cause === 'lava')) continue
      const v = state.players.find((p) => p.id === e.playerId)!
      state.bonusFirstBlood = true
      payBonus(state, shooterId, 'firstblood', v.x, v.y - TANK_H, e.t, events)
      break
    }
    // tirarlo al abismo de una también es la primera sangre
    if (!state.bonusFirstBlood) {
      const fell = rivals.find((p) => !p.alive && events.some((e) => e.type === 'death' && e.playerId === p.id && e.cause === 'abyss'))
      if (fell) {
        state.bonusFirstBlood = true
        payBonus(state, shooterId, 'firstblood', before[fell.id].x, before[fell.id].y - TANK_H, timeOf(fell.id, 'death'), events)
      }
    }
  }
  // tiro largo: impacto directo en un rival lejos
  const far = LONGSHOT_FRAC * state.width
  let t0 = 0
  for (const f of flights) {
    const imp = f.impact
    const t = (f.startT ?? 0) + Math.max(0, f.path.length - 1) * (1 / 60)
    t0 = Math.max(t0, t)
    if (imp.kind !== 'tank' || imp.tankId === undefined || imp.tankId === shooterId) continue
    const b = before[imp.tankId]
    if (!b?.alive || Math.abs(b.x - before[shooterId].x) <= far) continue
    payBonus(state, shooterId, 'longshot', imp.x, imp.y - 10, t, events)
    break
  }
  // kills del tiro
  const killed = rivals.filter((p) => !p.alive)
  for (const p of killed) {
    const b = before[p.id]
    const death = events.find((e) => e.type === 'death' && e.playerId === p.id)
    if (death?.type === 'death' && death.cause === 'abyss') payBonus(state, shooterId, 'abyss', b.x, b.y - TANK_H, death.t, events)
    else {
      // lo mató un derrumbe: el último daño antes de la muerte fue de 'collapse'
      let last: GameEvent | undefined
      for (const e of events) {
        if (e === death) break
        if (e.type === 'damage' && e.playerId === p.id) last = e
      }
      if (last?.type === 'damage' && last.cause === 'collapse') payBonus(state, shooterId, 'collapse', p.x, p.y - TANK_H, last.t, events)
    }
  }
  if (killed.length >= 2) {
    const x = killed.reduce((a, p) => a + before[p.id].x, 0) / killed.length
    const y = Math.min(...killed.map((p) => before[p.id].y)) - TANK_H - 12
    payBonus(state, shooterId, 'double', x, y, Math.max(...killed.map((p) => timeOf(p.id, 'death') ?? 0)), events)
  }
  // botín y objetivos rotos por el tiro (una vez por utilería)
  const seen = new Set<number>()
  for (const e of events.slice()) {
    if (e.type !== 'prop' || !e.destroyed || (e.kind !== 'loot' && e.kind !== 'target') || seen.has(e.propId)) continue
    seen.add(e.propId)
    const size = PROP_SIZE[e.kind]
    payBonus(state, shooterId, e.kind, e.x + size.w / 2, e.y, e.t ?? t0, events)
  }
}

// Rivales que el tiro dejó en la lava (de la grilla o bajo la banda) y que no estaban antes. Se mira después
// del tiro; si la lava los mata al cerrar el turno, lavaBonus paga.
export function freshInLava(state: GameState, shooterId: number, before: Before[], wasInLava: boolean[]): Set<number> {
  const out = new Set<number>()
  for (const p of state.players) {
    if (p.id === shooterId || !p.alive || !before[p.id]?.alive || wasInLava[p.id]) continue
    if (inLava(state.terrain, p) || (state.lava !== null && p.y > state.lava)) out.add(p.id)
  }
  return out
}

export function lavaBonus(state: GameState, shooterId: number, fresh: Set<number>, events: GameEvent[], from: number): void {
  for (let i = from; i < events.length; i++) {
    const e = events[i]
    if (e.type !== 'death' || e.cause !== 'lava' || !fresh.has(e.playerId)) continue
    const p = state.players.find((q) => q.id === e.playerId)!
    payBonus(state, shooterId, 'lava', p.x, p.y - TANK_H, e.t, events)
  }
}

// ---------- cajas de botín ----------

// La primera cae al empezar el turno LOOT_FIRST · tanques + 1 (después de la primera vuelta) y después una
// cada LOOT_EVERY · tanques turnos, hasta LOOT_PER_ROUND por ronda. Cae en paracaídas en una x sorteada con la
// seed de la ronda y el turno (no toca el rng del estado: el viento no cambia), apoyada en el primer sólido
// desde el cielo, nunca encima ni al lado de un tanque, de otra utilería, de un líquido o de un abismo.
// Evento 'prop' con kind 'loot', destroyed false y un propId nuevo (el render la hace caer en paracaídas
// desde el cielo hasta x/y en t).
export const LOOT_FIRST = 1
export const LOOT_EVERY = 2
export const LOOT_PER_ROUND = 2
const LOOT_SALT = 0x6c0071
const LOOT_TRIES = 40
const LOOT_TANK_GAP = 24

export function maybeDropLoot(state: GameState, events: GameEvent[], t: number): void {
  const n = state.players.length
  const next = state.turn + 1
  const dropped = state.props.filter((p) => p.kind === 'loot').length
  if (dropped >= LOOT_PER_ROUND || next < LOOT_FIRST * n + 1 + dropped * LOOT_EVERY * n) return
  const rng = new Rng(hashSeed(state.seed ^ Math.imul(state.round, 0x9e3779b1) ^ Math.imul(next, 0x85ebca6b) ^ LOOT_SALT))
  const { w, h } = PROP_SIZE.loot
  const tr = state.terrain
  for (let k = 0; k < LOOT_TRIES; k++) {
    const x = rng.int(24, state.width - 24 - w)
    const top = groundAt(tr, x + w / 2, w / 2)
    if (top >= tr.h - 4 || top - h < 8) continue
    // apoyada en sólido parejo (sin líquido encima del piso ni abismo debajo)
    let ok = true
    for (let ix = x; ix < x + w && ok; ix++) {
      const g = columnGround(tr, ix)
      if (isPit(tr, ix) || columnTop(tr, ix) < g || g - top > 3 || liquidBelow(tr, ix, g)) ok = false
    }
    if (!ok) continue
    if (state.lava !== null && top >= state.lava - 6) continue
    if (state.players.some((p) => p.alive && x + w > p.x - TANK_HALF_W - LOOT_TANK_GAP && x < p.x + TANK_HALF_W + LOOT_TANK_GAP)) continue
    if (state.props.some((q) => q.alive && x + w + 4 > q.x && x - 4 < q.x + q.w && top - h - 4 < q.y + q.h && top + 4 > q.y)) continue
    const prop: Prop = { id: state.props.length, kind: 'loot', x, y: top - h, w, h, alive: true }
    state.props = [...state.props, prop]
    events.push({ type: 'prop', propId: prop.id, kind: 'loot', x: prop.x, y: prop.y, destroyed: false, t })
    bonusStats.loot++
    return
  }
}
