// Resolución de un impacto: terreno, daño, utilería, barriles en cadena, caída y aplastamiento.
import { deform, hasLiquid, isPit, isSolid, liquidAt, solidRunUp } from './terrain'
import {
  FALL_DAMAGE,
  LAVA,
  TANK_H,
  TANK_HALF_W,
  TANK_W,
  WATER,
  WATER_BLAST_SCALE,
  WEAPONS,
  type BlastStyle,
  type GameEvent,
  type GameState,
  type Player,
  type Prop,
  type Terrain,
  type WeaponId,
} from './types'

export const BARREL_RADIUS = 18
export const BARREL_DAMAGE = 30
export const CHAIN_DELAY = 0.18
export const CRUSH_DEPTH = 8
export const CRUSH_DAMAGE = 2 // por pixel pasado de CRUSH_DEPTH
export const MIN_SUPPORT = 3 // columnas sólidas que sostienen al tanque
// v3: un tanque que cae a un abismo termina ABYSS_DROP px por debajo del borde inferior del mapa
// (fall.to = h + ABYSS_DROP): el render lo anima cayendo hasta perderse de vista.
export const ABYSS_DROP = 60

export interface Blast {
  x: number
  y: number
  radius: number
  damage: number
  weapon: WeaponId
  blast: BlastStyle
  terrain: 'destroy' | 'build' | 'dig'
  t: number
  directTank?: number
  source?: 'shot' | 'barrel'
}

// Distancia del punto a la caja del tanque (0 si está adentro).
export function tankDistance(p: Player, x: number, y: number): number {
  const dx = Math.max(p.x - TANK_HALF_W - x, 0, x - (p.x + TANK_HALF_W))
  const dy = Math.max(p.y - TANK_H - y, 0, y - p.y)
  return Math.hypot(dx, dy)
}

export function blastDamage(p: Player, b: { x: number; y: number; radius: number; damage: number; terrain: string }): number {
  const d = tankDistance(p, b.x, b.y)
  const reach = b.terrain === 'build' ? b.radius * 0.5 : b.radius
  if (d > reach) return 0
  return b.damage * (1 - d / (reach + 1))
}

function propDistance(p: Prop, x: number, y: number): number {
  const dx = Math.max(p.x - x, 0, x - (p.x + p.w - 1))
  const dy = Math.max(p.y - y, 0, y - (p.y + p.h - 1))
  return Math.hypot(dx, dy)
}

// El escudo absorbe primero.
export function hurt(p: Player, raw: number, events: GameEvent[]): void {
  let total = Math.round(raw)
  if (!p.alive || total <= 0) return
  if (p.shield > 0) {
    const absorbed = Math.min(p.shield, total)
    p.shield -= absorbed
    total -= absorbed
    events.push({ type: 'shield', playerId: p.id, absorbed, left: p.shield })
  }
  const amount = Math.min(p.hp, total)
  if (amount <= 0) return
  p.hp -= amount
  events.push({ type: 'damage', playerId: p.id, amount, hp: p.hp })
  if (p.hp <= 0) {
    p.alive = false
    events.push({ type: 'death', playerId: p.id })
  }
}

// Resuelve la explosión inicial y todo lo que desencadena. Devuelve los eventos en orden.
// after corre antes de asentar tanques y utilería (napalm, túnel de la excavadora).
export function resolveBlast(state: GameState, first: Blast, after?: (events: GameEvent[]) => void): GameEvent[] {
  const events: GameEvent[] = []
  const coverBefore = state.players.map((p) => cover(state.terrain, p))
  const queue: Blast[] = [first]
  while (queue.length > 0) {
    const b = queue.shift()!
    // v4: explosión con el centro sumergido: radio de terreno y de daño × WATER_BLAST_SCALE
    if (submerged(state.terrain, b.x, b.y)) b.radius *= WATER_BLAST_SCALE
    const debris = deform(state.terrain, b.x, b.y, b.radius, b.terrain)
    events.push({
      type: 'impact',
      x: b.x,
      y: b.y,
      weapon: b.weapon,
      blast: b.blast,
      radius: b.radius,
      t: b.t,
      debris,
      source: b.source ?? 'shot',
    })
    const mark = events.length
    for (const p of state.players) {
      if (!p.alive) continue
      const amount = p.id === b.directTank ? b.damage : blastDamage(p, b)
      if (amount > 0) hurt(p, amount, events)
    }
    for (const prop of state.props) {
      if (!prop.alive) continue
      const d = propDistance(prop, b.x, b.y)
      const breaks = prop.kind === 'barrel' || prop.kind === 'crate' ? d <= b.radius : d <= b.radius * 0.6
      if (!breaks) continue
      prop.alive = false
      events.push({ type: 'prop', propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true })
      if (prop.kind === 'barrel') {
        queue.push({
          x: prop.x + prop.w / 2,
          y: prop.y + prop.h / 2,
          radius: BARREL_RADIUS,
          damage: BARREL_DAMAGE,
          weapon: 'normal',
          blast: 'fire',
          terrain: 'destroy',
          t: b.t + CHAIN_DELAY,
          source: 'barrel',
        })
      }
    }
    for (let i = mark; i < events.length; i++) {
      const e = events[i]
      if (e.type === 'damage' || e.type === 'death' || e.type === 'prop' || e.type === 'shield') e.t = b.t
    }
  }
  after?.(events)
  settleProps(state, events)
  settleTanks(state, coverBefore, events)
  return events
}

// v4: el punto (x, y) está bajo el agua: la celda o alguna de sus 4 vecinas es agua. Las vecinas
// cuentan porque el impacto contra el lecho de un lago queda en la primera celda sólida, justo debajo
// del agua.
export function submerged(t: Terrain, x: number, y: number): boolean {
  return (
    liquidAt(t, x, y) === WATER ||
    liquidAt(t, x, y - 1) === WATER ||
    liquidAt(t, x - 1, y) === WATER ||
    liquidAt(t, x + 1, y) === WATER ||
    liquidAt(t, x, y + 1) === WATER
  )
}

// v4: un tanque con el piso en floor quedó en el agua: hay al menos WATER_FALL_CELLS celdas de agua
// en su caja (unas 3 filas de hondo a lo ancho). Así una caída al agua no hace daño (fall.water).
export const WATER_FALL_CELLS = 3 * TANK_W
export function inWater(t: Terrain, x: number, floor: number): boolean {
  const cx = Math.round(x)
  let n = 0
  const { w, front } = t
  for (let y = Math.max(0, floor - TANK_H); y < Math.min(t.h, floor); y++) {
    for (let ix = Math.max(0, cx - TANK_HALF_W); ix < Math.min(w, cx + TANK_HALF_W); ix++) {
      if (front[y * w + ix] === WATER && ++n >= WATER_FALL_CELLS) return true
    }
  }
  return false
}

// v4: el tanque tiene alguna celda de lava bajo o dentro de su caja (columnas [x - 14, x + 14),
// filas [y - TANK_H, y]): la lava lo quema al empezar cada turno.
export function inLava(t: Terrain, p: { x: number; y: number }): boolean {
  const cx = Math.round(p.x)
  return hasLiquid(t, LAVA, cx - TANK_HALF_W, p.y - TANK_H, cx + TANK_HALF_W, p.y + 1)
}

function cover(t: Terrain, p: Player): number {
  return solidRunUp(t, p.x, p.y - TANK_H, 64)
}

function solidPropAt(props: Prop[], self: Prop, x: number, y: number): boolean {
  for (const o of props) {
    if (o === self || !o.alive || (o.kind !== 'barrel' && o.kind !== 'crate')) continue
    if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) return true
  }
  return false
}

function rowSupported(state: GameState, prop: Prop, y: number): boolean {
  for (let x = prop.x; x < prop.x + prop.w; x++) {
    if (isSolid(state.terrain, x, y) || solidPropAt(state.props, prop, x, y)) return true
  }
  return false
}

export function propSupported(state: GameState, prop: Prop): boolean {
  const t = state.terrain
  switch (prop.kind) {
    case 'barrel':
    case 'crate':
      return rowSupported(state, prop, prop.y + prop.h)
    case 'lamp':
      for (let x = prop.x; x < prop.x + prop.w; x++) if (isSolid(t, x, prop.y - 1)) return true
      return false
    case 'flag':
    case 'windsock':
      return isSolid(t, prop.x, prop.y + prop.h) || isSolid(t, prop.x + 1, prop.y + prop.h)
    case 'ladder':
      for (let y = prop.y; y <= prop.y + prop.h; y++) {
        if (isSolid(t, prop.x - 1, y) || isSolid(t, prop.x + prop.w, y)) return true
        if (y === prop.y + prop.h) for (let x = prop.x; x < prop.x + prop.w; x++) if (isSolid(t, x, y)) return true
      }
      return false
  }
}

function settleProps(state: GameState, events: GameEvent[]): void {
  // de abajo hacia arriba, para que las pilas caigan juntas
  const order = state.props.filter((p) => p.alive).sort((a, b) => b.y + b.h - (a.y + a.h) || a.id - b.id)
  for (const prop of order) {
    if (propSupported(state, prop)) continue
    if (prop.kind !== 'barrel' && prop.kind !== 'crate') {
      prop.alive = false
      events.push({ type: 'prop', propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true })
      continue
    }
    let y = prop.y
    while (y + prop.h < state.terrain.h && !rowSupported(state, prop, y + prop.h)) {
      y++
      prop.y = y
    }
    // v3: llegó al fondo sin apoyo = cayó a un abismo y se pierde
    const lost = !rowSupported(state, prop, prop.y + prop.h)
    if (lost) prop.alive = false
    events.push({ type: 'prop', propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: lost })
  }
  burnCrates(state, events)
}

// v4: una caja (madera) con lava en su caja o justo debajo se quema. Los barriles se hunden sin explotar.
function burnCrates(state: GameState, events: GameEvent[]): void {
  for (const prop of state.props) {
    if (!prop.alive || prop.kind !== 'crate') continue
    if (!hasLiquid(state.terrain, LAVA, prop.x, prop.y, prop.x + prop.w, prop.y + prop.h + 1)) continue
    prop.alive = false
    events.push({ type: 'prop', propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true })
  }
}

// v4: después del flujo (la lava quemó madera, el agua y la lava hicieron piedra) se asientan de nuevo
// utilería y tanques. Sin aplastamiento: el flujo no tapa a nadie con tierra. Los eventos nuevos van en t.
export function settleAfterFlow(state: GameState, events: GameEvent[], t: number): void {
  const mark = events.length
  settleProps(state, events)
  settleTanks(
    state,
    state.players.map(() => Infinity),
    events,
  )
  for (let i = mark; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'prop' || e.type === 'fall' || e.type === 'damage' || e.type === 'death' || e.type === 'shield') e.t = t
  }
}

// v3: el tanque en x quedó sin ningún piso (tankFloor dio el borde del mapa) y tiene columnas de
// abismo debajo: cae y se pierde. Sin pits nunca pasa (debajo del mapa es roca madre).
export function overAbyss(t: Terrain, x: number, floor: number): boolean {
  if (floor < t.h || !t.pits) return false
  const cx = Math.round(x)
  for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) if (isPit(t, ix)) return true
  return false
}

// v3: el tanque cae al abismo. Eventos fall (to = h + ABYSS_DROP) y, si estaba vivo, death con
// cause 'abyss'. Sin daño de caída (la vida queda en 0 sin evento damage) y el paracaídas no lo salva
// ni se gasta. La plata la resuelve fire: si lo tiró el tiro de otro cuenta como kill (sin plata por daño).
export function dropIntoAbyss(t: Terrain, p: Player, events: GameEvent[]): void {
  const from = p.y
  p.y = t.h + ABYSS_DROP
  events.push({ type: 'fall', playerId: p.id, from, to: p.y })
  if (!p.alive) return
  p.alive = false
  p.hp = 0
  events.push({ type: 'death', playerId: p.id, cause: 'abyss' })
}

// Fila de apoyo del tanque buscando desde y hacia abajo.
export function tankFloor(t: Terrain, x: number, y: number): number {
  const cx = Math.round(x)
  for (let yy = Math.max(0, Math.floor(y)); yy < t.h; yy++) {
    let n = 0
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) if (isSolid(t, ix, yy)) n++
    if (n >= MIN_SUPPORT) return yy
  }
  return t.h
}

function settleTanks(state: GameState, coverBefore: number[], events: GameEvent[]): void {
  for (const p of state.players) {
    const floor = tankFloor(state.terrain, p.x, p.y)
    if (p.y < state.terrain.h && overAbyss(state.terrain, p.x, floor)) {
      dropIntoAbyss(state.terrain, p, events)
      continue
    }
    if (floor > p.y) {
      const from = p.y
      p.y = floor
      const drop = floor - from
      // v4: cayó al agua: sin daño de caída y sin gastar el paracaídas
      if (inWater(state.terrain, p.x, floor)) {
        events.push({ type: 'fall', playerId: p.id, from, to: floor, water: true })
        continue
      }
      const harmful = p.alive && drop > 2 && Math.round(drop * FALL_DAMAGE) > 0
      if (harmful && p.items.parachute > 0) {
        p.items.parachute -= 1
        events.push({ type: 'fall', playerId: p.id, from, to: floor, parachute: true })
        continue
      }
      events.push({ type: 'fall', playerId: p.id, from, to: floor })
      if (harmful) hurt(p, drop * FALL_DAMAGE, events)
    }
  }
  state.players.forEach((p, i) => {
    if (!p.alive) return
    const depth = cover(state.terrain, p)
    if (depth > CRUSH_DEPTH && depth > coverBefore[i]) hurt(p, (depth - CRUSH_DEPTH) * CRUSH_DAMAGE, events)
  })
}

export function blastFor(weapon: WeaponId, x: number, y: number, t: number, directTank?: number): Blast {
  const w = WEAPONS[weapon]
  return { x, y, radius: w.radius, damage: w.damage, weapon, blast: w.blast, terrain: w.terrain, t, directTank }
}
