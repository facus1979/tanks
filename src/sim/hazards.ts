// v3: peligros que quedan en el mapa entre turnos (GameState.hazards): minas y charcos de ácido.
//
// Mina (arma 'mine'): queda clavada en el piso donde cae (si pega en un tanque, cae a sus pies). Explota (evento
// 'hazard' action 'trigger' + la explosión de WEAPONS.mine) cuando:
//   - un tanque cuya posición cambió (se movió, lo empujaron, se cayó, saltó o se teletransportó) queda a
//     menos de Hazard.radius (MINE_TRIGGER) px de la mina (distancia a su caja). Un tanque que ya estaba
//     adentro cuando la mina cayó no la dispara hasta que se mueva;
//   - la alcanza otra explosión (su centro a menos del radio de esa explosión);
//   - se le acaban los turnos (Hazard.turns = MINE_ROUNDS vueltas × tanques vivos al plantarla).
// La plata y las kills de lo que hace la mina son de su dueño (también si la pisa por un tiro de otro).
//
// Ácido (arma 'acid'): la explosión rompe piedra y metal (hard) y deja un charco en el fondo del cráter (salvo
// bajo el agua: se diluye). Al empezar el turno de un tanque con la caja a menos de Hazard.radius del charco, el
// ácido le hace ACID_DAMAGE (evento 'hazard' 'trigger' + 'damage'). Dura WEAPONS.acid.acid vueltas. Al secarse,
// 'hazard' 'expire'.
//
// Los dos se asientan si se les va el piso; caen al abismo o quedan bajo la lava: 'expire' (sin explotar).
import { blastFor, hurt, resolveBlast, tankDistance } from './physics'
import { columnGround, isPit, isSolid, liquidAt } from './terrain'
import { EARN, LAVA, WEAPONS, type GameEvent, type GameState, type Hazard, type Player } from './types'

export const MINE_TRIGGER = 14
export const MINE_ROUNDS = 3
export const ACID_DAMAGE = 10
// Segundos entre el fin del tiro y las explosiones de minas que dispara (empujones, caídas).
export const MINE_DELAY = 0.15
// Explosiones en cadena entre minas.
const MINE_CHAIN = 0.2

export function inHazard(p: { x: number; y: number }, h: Hazard): boolean {
  return tankDistance(p as Player, h.x, h.y) <= h.radius
}

export function nextHazardId(state: GameState): number {
  let id = 0
  for (const h of state.hazards) id = Math.max(id, h.id + 1)
  return id
}

// Planta un peligro y emite 'place'. x/y: punto de la superficie. Devuelve el peligro (o null si no hay piso).
export function placeHazard(state: GameState, kind: Hazard['kind'], ownerId: number, x: number, y: number, t: number, events: GameEvent[]): Hazard | null {
  const tr = state.terrain
  const ix = Math.round(x)
  if (ix < 0 || ix >= tr.w) return null
  const g = columnGround(tr, ix, Math.max(0, Math.floor(y)))
  if (g >= tr.h && isPit(tr, ix)) return null
  const alive = state.players.filter((p) => p.alive).length
  const rounds = kind === 'mine' ? MINE_ROUNDS : (WEAPONS.acid.acid ?? 2)
  const h: Hazard = {
    id: nextHazardId(state),
    kind,
    ownerId,
    x: ix,
    y: g,
    radius: kind === 'mine' ? MINE_TRIGGER : WEAPONS.acid.radius,
    turns: rounds * Math.max(1, alive),
  }
  if (underLava(state, h)) return null
  state.hazards.push(h)
  events.push({ type: 'hazard', action: 'place', hazard: { ...h }, t })
  return h
}

function underLava(state: GameState, h: Hazard): boolean {
  return (state.lava !== null && h.y > state.lava) || liquidAt(state.terrain, h.x, h.y - 1) === LAVA
}

// Plata y kills de lo que hizo un peligro (daño desde `before`): al dueño. Devuelve el daño hecho a cada tanque.
function credit(state: GameState, ownerId: number, before: { hp: number; alive: boolean }[], out?: Map<number, number>, killed?: Set<number>): number {
  let toOthers = 0
  let earned = 0
  const owner = state.players.find((p) => p.id === ownerId)
  for (const p of state.players) {
    const b = before[p.id]
    if (!b || !b.alive) continue
    const dmg = b.hp - (p.hp + p.shield)
    if (dmg <= 0) continue
    out?.set(p.id, (out.get(p.id) ?? 0) + dmg)
    if (p.id === ownerId) earned += dmg * EARN.selfDamage
    else {
      toOthers += dmg
      earned += dmg * EARN.perDamage
      if (!p.alive) {
        earned += EARN.kill
        if (owner) owner.kills += 1
        killed?.add(p.id)
      }
    }
  }
  state.earnings[ownerId] = (state.earnings[ownerId] ?? 0) + earned
  return toOthers
}

function lifeOf(state: GameState): { hp: number; alive: boolean }[] {
  return state.players.map((p) => ({ hp: p.hp + p.shield, alive: p.alive }))
}

// Explota una mina: la saca del mapa, 'trigger' y la explosión. Acredita al dueño.
export function detonate(state: GameState, h: Hazard, t: number, events: GameEvent[], dealt?: Map<number, number>, killed?: Set<number>): number {
  state.hazards = state.hazards.filter((o) => o !== h)
  events.push({ type: 'hazard', action: 'trigger', hazard: { ...h }, t })
  const before = lifeOf(state)
  events.push(...resolveBlast(state, blastFor('mine', h.x, h.y - 2, t)))
  return credit(state, h.ownerId, before, dealt, killed)
}

export interface MineReport {
  blasts: number // minas que explotaron
  toOthers: number // daño a tanques que no son el dueño de cada mina
  dealt: Map<number, number> // daño de las minas por tanque (fire lo descuenta de lo que se cobra el tirador)
  killed: Set<number> // tanques que mató una mina (la kill es del dueño de la mina)
}

// Minas que se disparan después de algo que movió tanques o hizo explosiones (desde events[from]).
// moved(p): la posición del tanque cambió desde antes de lo que se está resolviendo. skip: minas recién
// plantadas en este mismo tiro (no las dispara lo que pasó antes de que cayeran).
export function mineReactions(
  state: GameState,
  events: GameEvent[],
  from: number,
  moved: (p: Player) => boolean,
  t: number,
  skip: Set<number> = new Set(),
): MineReport {
  const report: MineReport = { blasts: 0, toOthers: 0, dealt: new Map(), killed: new Set() }
  let scan = from
  for (let guard = 0; guard < 16; guard++) {
    let hit: Hazard | null = null
    for (const h of state.hazards) {
      if (h.kind !== 'mine' || skip.has(h.id)) continue
      if (state.players.some((p) => p.alive && moved(p) && inHazard(p, h))) {
        hit = h
        break
      }
      for (let i = scan; i < events.length && !hit; i++) {
        const e = events[i]
        if (e.type === 'impact' && Math.hypot(e.x - h.x, e.y - h.y) <= e.radius) hit = h
      }
      if (hit) break
    }
    if (!hit) break
    scan = events.length
    report.toOthers += detonate(state, hit, t + report.blasts * MINE_CHAIN, events, report.dealt, report.killed)
    report.blasts++
  }
  return report
}

// Asienta los peligros (se les fue el piso: caen hasta el nuevo) y saca los que se perdieron.
export function settleHazards(state: GameState, events: GameEvent[], t: number): void {
  const tr = state.terrain
  const keep: Hazard[] = []
  for (const h of state.hazards) {
    if (!isSolid(tr, h.x, h.y)) {
      const g = columnGround(tr, h.x, h.y)
      if (g >= tr.h && isPit(tr, h.x)) {
        events.push({ type: 'hazard', action: 'expire', hazard: { ...h }, t })
        continue
      }
      h.y = g
    }
    if (underLava(state, h)) {
      events.push({ type: 'hazard', action: 'expire', hazard: { ...h }, t })
      continue
    }
    keep.push(h)
  }
  state.hazards = keep
}

// Cambio de turno: cada peligro pierde un turno; el ácido le hace daño al que empieza (next) si está adentro;
// las minas vencidas explotan y los charcos vencidos se secan. Devuelve cuántas minas explotaron.
export function tickHazards(state: GameState, events: GameEvent[], t: number, next: Player | undefined): number {
  if (state.hazards.length === 0) return 0
  for (const h of state.hazards) h.turns -= 1
  if (next?.alive) {
    for (const h of state.hazards) {
      if (h.kind !== 'acid' || !inHazard(next, h) || !next.alive) continue
      events.push({ type: 'hazard', action: 'trigger', hazard: { ...h }, t })
      const before = lifeOf(state)
      const mark = events.length
      hurt(next, ACID_DAMAGE, events)
      for (let i = mark; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'damage' || e.type === 'death' || e.type === 'shield') e.t = t
      }
      credit(state, h.ownerId, before)
    }
  }
  let blasts = 0
  for (const h of [...state.hazards]) {
    if (h.turns > 0 || !state.hazards.includes(h)) continue
    if (h.kind === 'acid') {
      state.hazards = state.hazards.filter((o) => o !== h)
      events.push({ type: 'hazard', action: 'expire', hazard: { ...h }, t })
    } else {
      detonate(state, h, t + blasts * MINE_CHAIN, events)
      blasts++
    }
  }
  return blasts
}
