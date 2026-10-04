// Resolución de un disparo según el arma: racimo, napalm, excavadora, rodadora y el resto.
// v3: teledirigido (guided.ts), rebotadora, láser, mina, terremoto, agujero negro, ácido y muro, y el deflector.
// Los tiempos (startT de los vuelos, t de los eventos) son siempre desde el disparo, también los del guiado.
import { PATH_DT, fly, muzzle, type FlightResult, type FlyOptions } from './ballistics'
import { GUIDE_TICKS, startGuided, steerGuided, type SteerResult } from './guided'
import { placeHazard } from './hazards'
import { blastFor, hurt, resolveBlast, submerged, type Blast } from './physics'
import { columnGround, columnTop, deform, isSolid, liquidAt, markDirty } from './terrain'
import { tankTilt } from './tilt'
import {
  AIR,
  BEDROCK,
  BRICK,
  ICE,
  LAVA,
  MATERIALS,
  METAL,
  STONE,
  SUBSTEP,
  TANK_H,
  TANK_HALF_W,
  WATER,
  WATER_DRAG,
  WEAPONS,
  physicsFor,
  type Flight,
  type GameEvent,
  type GameState,
  type GuidedState,
  type Player,
  type Vec2,
  type WeaponId,
} from './types'

export const CLUSTER_SPREAD = 26 // px/s de separación horizontal entre bombitas
export const NAPALM_SPREAD = 40 // px que corre el fuego hacia cada lado
export const NAPALM_DPS = 6 // daño por segundo de fuego (WEAPONS.napalm.burn segundos)
export const NAPALM_CHAR = 12 // radio que quema material inflamable alrededor del fuego
export const DIG_LENGTH = 80
export const DIG_RADIUS = 6
export const ROLL_MAX_T = 6
const ROLL_R = 3 // radio de la bola

// v3 rebotadora: al tocar el terreno explota chico (radio y daño del arma, estilo 'spark') y rebota con la
// normal del terreno conservando BOUNCE_KEEP de la velocidad; tras WeaponDef.bounces rebotes (o si pega en un
// tanque o en utilería, o queda con menos de BOUNCE_MIN_SPEED px/s) hace la explosión final: radio ×
// BOUNCE_FINAL_R, daño × BOUNCE_FINAL_D, estilo 'fire'.
export const BOUNCE_KEEP = 0.62
export const BOUNCE_MIN_SPEED = 45
export const BOUNCE_FINAL_R = 1.4
export const BOUNCE_FINAL_D = 1.5
// v3 láser: rayo recto desde la boca del cañón (sin gravedad ni viento) de hasta LASER_RANGE px. Atraviesa los
// materiales blandos (tierra, nieve, madera, tablas, vigas, postes) abriendo un agujero de LASER_BORE px de
// radio, hasta LASER_SOFT px de material en total; frena en piedra, ladrillo, metal, hielo y roca madre. Pega en
// el primer tanque (daño entero del arma) o barril/caja que cruza. Eventos 'beam' (uno por tramo) y el impacto
// (estilo 'laser', radio del arma) en LASER_TIME. El vuelo (flights) recorre el rayo en LASER_TIME.
export const LASER_RANGE = 380
export const LASER_SOFT = 44
export const LASER_BORE = 2
export const LASER_TIME = 0.1
const LASER_HARD = new Set<number>([STONE, BRICK, METAL, ICE, BEDROCK])
// v3 deflector: el proyectil que toca al tanque con el deflector sale hacia arriba y hacia atrás (60° sobre la
// horizontal, contra el sentido en que venía) con DEFLECT_KEEP de su velocidad, desde arriba de la caja; el
// deflector se gasta (evento 'deflect'). El láser se refleja igual.
export const DEFLECT_KEEP = 0.6
const DEFLECT_ANGLE = (60 * Math.PI) / 180

export interface ShotOutcome {
  flights: Flight[]
  events: GameEvent[]
  guided?: GuidedState // v3: el teledirigido llegó al apogeo y quedó para guiar (solo con pause)
}

// v3: opciones del teledirigido. pause: parar en el apogeo y devolver el estado del guiado (fire). Sin pause,
// se resuelve todo de una con steer (las correcciones; lo que falta es 0) y wobble (false: el modelo sin
// temblor con que planifica la IA).
export interface ShotOptions {
  pause?: boolean
  steer?: readonly number[]
  wobble?: boolean
}

export function toFlight(f: FlightResult, startT: number): Flight {
  const flight: Flight = { path: f.path, impact: f.impact, startT }
  if (f.splashes) flight.splashes = f.splashes // v4
  return flight
}

function flyBase(state: GameState, ownerId: number): FlyOptions {
  return { terrain: state.terrain, players: state.players, props: state.props, ownerId, angle: 0, power: 0, wind: state.wind, lava: state.lava ?? undefined }
}

// v3: el tanque del impacto tiene el deflector activo: lo gasta, emite 'deflect' y devuelve de dónde y con
// qué velocidad sigue el proyectil. null si no hay deflector.
function deflection(state: GameState, f: FlightResult, t: number, events: GameEvent[]): { origin: Vec2; velocity: Vec2 } | null {
  if (f.impact.kind !== 'tank') return null
  const p = state.players.find((q) => q.id === f.impact.tankId)
  if (!p || !p.alive || !p.deflector) return null
  p.deflector = false
  events.push({ type: 'deflect', playerId: p.id, x: f.impact.x, y: f.impact.y, t })
  const speed = Math.hypot(f.vel.x, f.vel.y) * DEFLECT_KEEP
  const side = Math.abs(f.vel.x) >= 4 ? -Math.sign(f.vel.x) : f.impact.x < p.x ? -1 : 1
  return {
    origin: { x: Math.min(p.x + TANK_HALF_W, Math.max(p.x - TANK_HALF_W, f.impact.x)), y: p.y - TANK_H - 3 },
    velocity: { x: side * speed * Math.cos(DEFLECT_ANGLE), y: -speed * Math.sin(DEFLECT_ANGLE) },
  }
}

// v3: un vuelo que puede tocar a un tanque con deflector: se desvía y sigue (otro tramo en flights). t0: tiempo
// (desde el disparo) en que arranca. Devuelve el último tramo con time = tiempo desde el DISPARO de su final.
export function flyDeflect(state: GameState, opts: FlyOptions, t0: number, flights: Flight[], events: GameEvent[]): FlightResult {
  let o = opts
  let t = t0
  for (let k = 0; ; k++) {
    const f = fly(o)
    flights.push(toFlight(f, t))
    const d = k < 3 ? deflection(state, f, t + f.time, events) : null
    if (!d) return { ...f, time: t + f.time }
    t += f.time
    o = { ...flyBase(state, o.ownerId), ...d, lavaSolid: o.lavaSolid }
  }
}

export function resolveShot(state: GameState, shooter: Player, weapon: WeaponId, opts: ShotOptions = {}): ShotOutcome {
  const w = WEAPONS[weapon]
  if (w.beam) return laser(state, shooter, weapon)
  const base: FlyOptions = {
    terrain: state.terrain,
    players: state.players,
    props: state.props,
    ownerId: shooter.id,
    angle: shooter.angle,
    power: shooter.power,
    wind: state.wind,
    lava: state.lava ?? undefined, // v2: lo que toca la lava se derrite sin explotar
    lavaSolid: w.terrain === 'build', // Pulido v2: salvo la Tierra, que construye ahí
  }
  const flights: Flight[] = []
  const events: GameEvent[] = []
  if (w.split) return cluster(state, shooter, weapon, flyDeflect(state, { ...base, stopAtApex: true }, 0, flights, events), flights, events)
  if (w.guided) {
    const up = flyDeflect(state, { ...base, stopAtApex: true }, 0, flights, events)
    if (!up.apex) return land(state, shooter, weapon, up, flights, events)
    const g = startGuided(state, shooter, up, up.time)
    if (opts.pause) return { flights, events, guided: g }
    const all = Array.from({ length: GUIDE_TICKS }, (_, k) => opts.steer?.[k] ?? 0)
    const r = steerGuided(state, g, all, opts.wobble ?? true)
    return land(state, shooter, weapon, afterSteer(state, g, r, flights, events), flights, events)
  }
  return land(state, shooter, weapon, flyDeflect(state, base, 0, flights, events), flights, events)
}

// v3: después de un tramo de guiado (r, que arrancó en g): si chocó, ese es el vuelo final (salvo deflector: se
// desvía y sigue libre); si se acabó el guiado, sigue en caída libre. Agrega los tramos a flights y devuelve el
// vuelo final con time desde el disparo. Solo se llama cuando el guiado terminó (r.hit o r.guided.guide = 0).
export function afterSteer(state: GameState, g: GuidedState, r: SteerResult, flights: Flight[], events: GameEvent[]): FlightResult {
  flights.push(toFlight(r.flight, g.t))
  const end = g.t + r.flight.time
  const from = r.hit ? deflection(state, r.flight, end, events) : { origin: { x: r.guided.x, y: r.guided.y }, velocity: { x: r.guided.vx, y: r.guided.vy } }
  if (!from) return { ...r.flight, time: end }
  return flyDeflect(state, { ...flyBase(state, g.ownerId), ...from }, end, flights, events)
}

// v3: lo que pasa cuando el proyectil termina su vuelo (f.time = desde el disparo), según el arma.
export function land(state: GameState, shooter: Player, weapon: WeaponId, f: FlightResult, flights: Flight[], events: GameEvent[]): ShotOutcome {
  const w = WEAPONS[weapon]
  if (f.impact.kind === 'out' || f.impact.kind === 'lava') return { flights, events }
  const { x, y, tankId } = f.impact
  if (w.rolls && f.impact.kind === 'terrain') return roll(state, shooter, weapon, f, flights, events)
  if (w.bounces) return bounce(state, shooter, weapon, f, flights, events)
  if (w.mine) {
    // la mina queda clavada en el piso (si pegó en un tanque, cae a sus pies: explota cuando se mueva)
    const p = tankId !== undefined ? state.players.find((q) => q.id === tankId) : undefined
    placeHazard(state, 'mine', shooter.id, x, p ? p.y - 4 : y - 3, f.time, events)
    return { flights, events }
  }
  const blast = blastFor(weapon, x, y, f.time, tankId, f.vel.x)
  const after = w.terrain === 'dig' ? (ev: GameEvent[]) => tunnel(state, f, ev) : w.burn ? (ev: GameEvent[]) => napalm(state, x, y, f.time, w.burn!, ev) : undefined
  events.push(...resolveBlast(state, blast, after))
  markWater(flights[flights.length - 1], blast)
  // v3 ácido: charco en el fondo del cráter (bajo el agua se diluye)
  if (w.acid && !blast.water) placeHazard(state, 'acid', shooter.id, x, y - blast.radius, f.time, events)
  return { flights, events }
}

// v2.4: Impact.water: el centro de la explosión de ese vuelo quedó sumergido (lo decide resolveBlast).
function markWater(f: Flight, b: Blast): void {
  if (b.water) f.impact = { ...f.impact, water: true }
}

// ---------- racimo ----------

function cluster(state: GameState, shooter: Player, weapon: WeaponId, main: FlightResult, flights: Flight[], events: GameEvent[]): ShotOutcome {
  const w = WEAPONS[weapon]
  if (!main.apex) {
    if (main.impact.kind === 'out' || main.impact.kind === 'lava') return { flights, events }
    const b = blastFor(weapon, main.impact.x, main.impact.y, main.time, main.impact.tankId, main.vel.x)
    events.push(...resolveBlast(state, b))
    markWater(flights[flights.length - 1], b)
    return { flights, events }
  }
  const n = w.split ?? 1
  const origin: Vec2 = { x: main.impact.x, y: main.impact.y }
  // cada bombita con su propio registro de vuelos (pueden desviarse en un deflector), ordenadas por llegada
  const bombs: { f: FlightResult; flights: Flight[]; events: GameEvent[] }[] = []
  for (let i = 0; i < n; i++) {
    const k = i - (n - 1) / 2
    const fl: Flight[] = []
    const ev: GameEvent[] = []
    const f = flyDeflect(state, { ...flyBase(state, shooter.id), origin, velocity: { x: main.vel.x + k * CLUSTER_SPREAD, y: -18 + Math.abs(k) * 6 } }, main.time, fl, ev)
    bombs.push({ f, flights: fl, events: ev })
  }
  const order = bombs.map((_, i) => i).sort((a, b) => bombs[a].f.time - bombs[b].f.time || a - b)
  for (const i of order) {
    const { f, flights: fl, events: ev } = bombs[i]
    flights.push(...fl)
    events.push(...ev)
    if (f.impact.kind === 'out' || f.impact.kind === 'lava') continue
    const tankId = f.impact.tankId !== undefined && state.players[f.impact.tankId]?.alive ? f.impact.tankId : undefined
    const b = blastFor(weapon, f.impact.x, f.impact.y, f.time, tankId, f.vel.x)
    events.push(...resolveBlast(state, b))
    markWater(flights[flights.length - 1], b)
  }
  return { flights, events }
}

// ---------- v3 rebotadora ----------

// Normal del terreno en (x, y): opuesta a la suma de las direcciones de las celdas sólidas cercanas.
function surfaceNormal(state: GameState, x: number, y: number): Vec2 {
  let sx = 0
  let sy = 0
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      if (dx * dx + dy * dy > 36 || !isSolid(state.terrain, x + dx, y + dy)) continue
      sx += dx
      sy += dy
    }
  }
  const len = Math.hypot(sx, sy)
  return len < 1e-6 ? { x: 0, y: -1 } : { x: -sx / len, y: -sy / len }
}

function bounce(state: GameState, shooter: Player, weapon: WeaponId, first: FlightResult, flights: Flight[], events: GameEvent[]): ShotOutcome {
  const w = WEAPONS[weapon]
  let f = first
  for (let k = 0; ; k++) {
    if (f.impact.kind === 'out' || f.impact.kind === 'lava') return { flights, events }
    // el rebote se calcula con el terreno de antes de la explosión
    const n = surfaceNormal(state, f.impact.x, f.impact.y)
    const dot = f.vel.x * n.x + f.vel.y * n.y
    let vx = (f.vel.x - 2 * dot * n.x) * BOUNCE_KEEP
    let vy = (f.vel.y - 2 * dot * n.y) * BOUNCE_KEEP
    const final = k >= (w.bounces ?? 0) || f.impact.kind !== 'terrain' || Math.hypot(vx, vy) < BOUNCE_MIN_SPEED
    const b = blastFor(weapon, f.impact.x, f.impact.y, f.time, f.impact.tankId, f.vel.x)
    if (final) {
      b.radius *= BOUNCE_FINAL_R
      b.damage *= BOUNCE_FINAL_D
      b.blast = 'fire'
    }
    events.push(...resolveBlast(state, b))
    markWater(flights[flights.length - 1], b)
    if (final) return { flights, events }
    // sale desde el punto del impacto, corrido hacia afuera hasta quedar en el aire
    let ox = f.impact.x
    let oy = f.impact.y
    for (let s = 0; s < 12 && isSolid(state.terrain, ox, oy); s++) {
      ox += n.x * 1.5
      oy += n.y * 1.5
    }
    if (vx * n.x + vy * n.y < 20) {
      vx += n.x * 20
      vy += n.y * 20
    }
    f = flyDeflect(state, { ...flyBase(state, shooter.id), origin: { x: ox, y: oy }, velocity: { x: vx, y: vy } }, f.time, flights, events)
  }
}

// ---------- v3 láser ----------

function laser(state: GameState, shooter: Player, weapon: WeaponId): ShotOutcome {
  const t = state.terrain
  const w = WEAPONS[weapon]
  const flights: Flight[] = []
  const events: GameEvent[] = []
  const rad = (shooter.angle * Math.PI) / 180
  let o = muzzle(shooter.x, shooter.y, shooter.angle, tankTilt(t, shooter.x, shooter.y))
  let dx = Math.cos(rad)
  let dy = -Math.sin(rad)
  let range = LASER_RANGE
  let soft = 0
  const bore: Vec2[] = []
  const skip = new Set<number>([shooter.id])
  let end: Vec2 = o
  let impact: Flight['impact'] = { kind: 'out', x: o.x, y: o.y }
  const segs: { a: Vec2; b: Vec2 }[] = []
  for (let seg = 0; seg < 3; seg++) {
    let x = o.x
    let y = o.y
    let hit: Flight['impact'] | null = null
    let deflectBy: Player | null = null
    let d = 0
    for (; d < range && !hit; d += 0.5) {
      x = o.x + dx * d
      y = o.y + dy * d
      if (x < 0 || x >= t.w || y < 0) {
        hit = { kind: 'out', x, y }
        break
      }
      if (y >= t.h) {
        hit = isSolid(t, x, y) ? { kind: 'terrain', x, y } : { kind: 'out', x, y }
        break
      }
      const p = state.players.find((q) => q.alive && !skip.has(q.id) && x >= q.x - TANK_HALF_W && x <= q.x + TANK_HALF_W && y >= q.y - TANK_H && y <= q.y)
      if (p) {
        if (p.deflector) deflectBy = p
        hit = { kind: 'tank', x, y, tankId: p.id }
        break
      }
      const prop = state.props.find((q) => q.alive && (q.kind === 'barrel' || q.kind === 'crate') && x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h)
      if (prop) {
        hit = { kind: 'prop', x, y, propId: prop.id }
        break
      }
      const m = t.front[Math.floor(y) * t.w + Math.floor(x)]
      if (m === AIR || MATERIALS[m]?.liquid) continue
      if (LASER_HARD.has(m) || soft >= LASER_SOFT) {
        hit = { kind: 'terrain', x, y }
        break
      }
      soft += 0.5
      if (bore.length === 0 || Math.hypot(bore[bore.length - 1].x - x, bore[bore.length - 1].y - y) >= 1) bore.push({ x, y })
    }
    range -= d
    end = { x, y }
    segs.push({ a: o, b: end })
    impact = hit ?? { kind: 'out', x, y }
    if (!deflectBy) break
    // deflector: el rayo sale hacia arriba y hacia atrás desde arriba de la caja
    deflectBy.deflector = false
    skip.add(deflectBy.id)
    events.push({ type: 'deflect', playerId: deflectBy.id, x, y, t: (LASER_TIME * (LASER_RANGE - range)) / LASER_RANGE })
    const side = dx > 0 ? -1 : 1
    const ux = side * 0.5
    const uy = -Math.max(0.85, Math.abs(dy))
    const len = Math.hypot(ux, uy)
    dx = ux / len
    dy = uy / len
    o = { x, y: deflectBy.y - TANK_H - 2 }
    impact = { kind: 'out', x, y }
  }
  // agujero en lo blando que atravesó
  const debris: Partial<Record<number, number>> = {}
  const r = LASER_BORE
  for (const b of bore) {
    for (let yy = Math.floor(b.y - r); yy <= Math.ceil(b.y + r); yy++) {
      for (let xx = Math.floor(b.x - r); xx <= Math.ceil(b.x + r); xx++) {
        if (xx < 0 || yy < 0 || xx >= t.w || yy >= t.h || (xx + 0.5 - b.x) ** 2 + (yy + 0.5 - b.y) ** 2 > r * r) continue
        const i = yy * t.w + xx
        const m = t.front[i]
        if (m === AIR || MATERIALS[m]?.liquid || LASER_HARD.has(m)) continue
        t.front[i] = AIR
        debris[m] = (debris[m] ?? 0) + 1
      }
    }
  }
  if (bore.length > 0) {
    const xs = bore.map((b) => b.x)
    const ys = bore.map((b) => b.y)
    markDirty(t, Math.min(...xs) - r - 1, Math.min(...ys) - r - 1, Math.max(...xs) + r + 1, Math.max(...ys) + r + 1)
  }
  // vuelo: recorre todos los tramos en LASER_TIME
  const total = segs.reduce((a, s) => a + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0) || 1
  const steps = Math.max(1, Math.round(LASER_TIME / PATH_DT))
  const path: Vec2[] = []
  for (let k = 0; k <= steps; k++) {
    let left = (total * k) / steps
    for (const s of segs) {
      const l = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
      if (left <= l || s === segs[segs.length - 1]) {
        const f = l > 0 ? Math.min(1, left / l) : 0
        path.push({ x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f })
        break
      }
      left -= l
    }
  }
  flights.push({ path, impact, startT: 0 })
  let tt = 0
  for (const s of segs) {
    events.push({ type: 'beam', x0: s.a.x, y0: s.a.y, x1: s.b.x, y1: s.b.y, t: tt })
    tt += (LASER_TIME * Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)) / total
  }
  if (impact.kind === 'out' || impact.kind === 'lava') {
    // sin impacto: el agujero igual se ve (escombros en el último tramo)
    if (bore.length > 0) events.push({ type: 'impact', x: end.x, y: end.y, weapon, blast: w.blast, radius: 0, t: LASER_TIME, debris, source: 'shot' })
    return { flights, events }
  }
  const blast = blastFor(weapon, impact.x, impact.y, LASER_TIME, impact.tankId, dx * 100)
  const ev = resolveBlast(state, blast)
  const first = ev[0]
  if (first?.type === 'impact') for (const k in debris) first.debris[Number(k)] = (first.debris[Number(k)] ?? 0) + (debris[Number(k)] ?? 0)
  events.push(...ev)
  markWater(flights[0], blast)
  return { flights, events }
}

// ---------- excavadora ----------

function tunnel(state: GameState, flight: FlightResult, events: GameEvent[]): void {
  const len = Math.hypot(flight.vel.x, flight.vel.y) || 1
  const dx = flight.vel.x / len
  const dy = flight.vel.y / len
  const impact = events[0]
  if (impact.type !== 'impact') return
  for (let d = 0; d <= DIG_LENGTH; d += 2) {
    const debris = deform(state.terrain, flight.impact.x + dx * d, flight.impact.y + dy * d, DIG_RADIUS, 'dig')
    for (const k in debris) {
      const m = Number(k)
      impact.debris[m] = (impact.debris[m] ?? 0) + (debris[m] ?? 0)
    }
  }
}

// ---------- napalm ----------

function surfaceFrom(state: GameState, x: number, y: number): number {
  return columnGround(state.terrain, x, y)
}

// Pulido v2: espesor de la capa de piedra flotante que deja el napalm sobre el agua.
export const NAPALM_CRUST = 4

// La primera fila de agua (la superficie) de la columna x, subiendo desde y mientras haya agua.
function waterTop(t: GameState['terrain'], x: number, y: number): number {
  let yy = Math.floor(y)
  while (yy > 0 && liquidAt(t, x, yy - 1) === WATER) yy--
  return yy
}

// Napalm. El fuego corre NAPALM_SPREAD px hacia cada lado por la superficie (cuesta arriba se agota antes,
// una pared lo frena), quema lo inflamable (front a aire, el back queda) y daña a los tanques que toca.
// Pulido v2: sobre el agua no se apaga: la superficie del agua alcanzada por el impacto (impacto
// sumergido o que cae sobre el agua) y por la corrida del fuego se vuelve una capa de piedra flotante de
// NAPALM_CRUST px (se puede cruzar con el tanque), con eventos 'steam'. La lava sigue frenando el fuego.
function napalm(state: GameState, ix: number, iy: number, t0: number, seconds: number, events: GameEvent[]): void {
  const t = state.terrain
  const cx = Math.round(ix)
  // superficie de una columna: la primera celda que no es aire (sólido o líquido) desde fromY
  const surface = (x: number, fromY: number) => columnTop(t, x, fromY)
  let start: number
  if (submerged(t, ix, iy)) {
    // impacto bajo el agua (o contra el lecho): el fuego arranca en la superficie de esa columna
    const wy = liquidAt(t, cx, iy) === WATER ? iy : liquidAt(t, cx, iy - 1) === WATER ? iy - 1 : -1
    start = wy >= 0 ? waterTop(t, cx, wy) : surface(cx, Math.floor(iy) - 8)
  } else start = surface(cx, Math.floor(iy) - 8)
  // v2.4: debajo de la superficie de la lava (la banda de muerte súbita, o lava de la grilla en la celda o
  // justo encima) el napalm no quema ni corre: la lava ya lo cubre, como al proyectil que se derrite al
  // tocarla. El fuego que corre tampoco baja a la banda ni la atraviesa.
  const band = state.lava ?? Infinity
  const underLava = (x: number, y: number) => y >= band || liquidAt(t, x, y) === LAVA || liquidAt(t, x, y - 1) === LAVA
  if (start >= t.h || underLava(cx, start)) return
  // burning: fuego sobre sólido; crust: columnas de agua cuya superficie se vuelve piedra
  const burning: Vec2[] = []
  const crust: { x: number; y: number; n: number }[] = []
  const mark = (x: number, y: number) => {
    if (liquidAt(t, x, y) === WATER) crust.push({ x, y, n: 0 })
    else burning.push({ x, y })
  }
  mark(cx, start)
  for (const dir of [-1, 1]) {
    let y = start
    let budget = NAPALM_SPREAD
    for (let x = cx + dir; budget > 0 && x >= 0 && x < t.w; x += dir) {
      if (isSolid(t, x, y - 6)) break // pared: el fuego no sube
      const g = surface(x, y - 5)
      if (g >= t.h || underLava(x, g)) break
      budget -= 1 + Math.max(0, y - g) // cuesta arriba se agota antes; cuesta abajo corre
      y = g
      mark(x, y)
    }
  }
  burning.sort((a, b) => a.x - b.x)
  crust.sort((a, b) => a.x - b.x)

  // agua alcanzada → piedra flotante (las NAPALM_CRUST primeras filas de agua de cada columna)
  for (const c of crust) {
    let n = 0
    for (let y = c.y; y < c.y + NAPALM_CRUST && y < t.h; y++) {
      if (t.front[y * t.w + c.x] !== WATER) break
      t.front[y * t.w + c.x] = STONE
      n++
    }
    markDirty(t, c.x - 1, c.y - 1, c.x + 1, c.y + NAPALM_CRUST)
    c.n = n
  }
  for (let i = 0; i < crust.length; i += 10) {
    const seg = crust.slice(i, i + 10)
    const mid = seg[Math.floor(seg.length / 2)]
    const n = seg.reduce((a, c) => a + c.n, 0)
    events.push({ type: 'steam', x: mid.x, y: mid.y, n, t: t0 + Math.abs(mid.x - cx) / 90 })
  }
  if (burning.length === 0) return

  // quema lo inflamable alrededor del fuego; el back queda (el render lo dibuja chamuscado)
  const r = NAPALM_CHAR
  for (let i = 0; i < burning.length; i += 3) {
    const p = burning[i]
    markDirty(t, p.x - r - 1, p.y - r - 1, p.x + r + 1, p.y + r + 1) // v4: lo quemado puede dejar correr un líquido
    for (let y = p.y - r; y <= p.y + r; y++) {
      if (y < 0 || y >= t.h || y >= band) continue // v2.4: bajo la banda de lava no quema
      for (let x = p.x - r; x <= p.x + r; x++) {
        if (x < 0 || x >= t.w || (x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue
        const idx = y * t.w + x
        const m = t.front[idx]
        if (m !== AIR && MATERIALS[m]?.flammable) t.front[idx] = AIR
      }
    }
  }

  // eventos 'burn' por tramos de 10 px contiguos, con el fuego avanzando desde el impacto
  for (let i = 0; i < burning.length; ) {
    let j = i + 1
    while (j < burning.length && j - i < 10 && burning[j].x === burning[j - 1].x + 1) j++
    const seg = burning.slice(i, j)
    const mid = seg[Math.floor(seg.length / 2)]
    events.push({ type: 'burn', x: seg[0].x, y: mid.y, w: seg.length, t: t0 + Math.abs(mid.x - cx) / 90 })
    i = j
  }

  const x0 = burning[0].x
  const x1 = burning[burning.length - 1].x
  for (const p of state.players) {
    if (!p.alive || p.x + TANK_HALF_W < x0 || p.x - TANK_HALF_W > x1) continue
    const near = burning.some((b) => Math.abs(b.x - p.x) <= TANK_HALF_W && b.y >= p.y - TANK_H - 4 && b.y <= p.y + 6)
    if (!near) continue
    const mark = events.length
    hurt(p, NAPALM_DPS * seconds, events)
    for (let i = mark; i < events.length; i++) {
      const e = events[i]
      if (e.type === 'damage' || e.type === 'death' || e.type === 'shield') e.t = t0 + 0.4
    }
  }
  for (const prop of state.props) {
    if (!prop.alive || prop.kind !== 'crate') continue
    if (prop.x + prop.w < x0 || prop.x > x1) continue
    prop.alive = false
    events.push({ type: 'prop', propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true, t: t0 + 0.3 })
  }
}

// ---------- rodadora ----------

function tankAt(state: GameState, x: number, y: number): Player | undefined {
  return state.players.find(
    (p) => p.alive && x >= p.x - TANK_HALF_W && x <= p.x + TANK_HALF_W && y >= p.y - TANK_H && y <= p.y,
  )
}

function roll(state: GameState, shooter: Player, weapon: WeaponId, flight: FlightResult, flights: Flight[], events: GameEvent[]): ShotOutcome {
  const t = state.terrain
  const gravity = physicsFor(t.w).gravity
  let x = flight.impact.x
  let y = surfaceFrom(state, Math.round(x), Math.floor(flight.impact.y) - 6) - ROLL_R
  const slopeAt = (px: number) => surfaceFrom(state, Math.round(px) + 2, y - 6) - surfaceFrom(state, Math.round(px) - 2, y - 6)
  let vx = flight.vel.x * 0.35
  if (Math.abs(vx) < 20) vx = slopeAt(x) !== 0 ? Math.sign(slopeAt(x)) * 20 : Math.sign(flight.vel.x || 1) * 20
  let vy = 0
  let air = false
  let time = 0
  let still = 0
  let n = 0
  let hit: Player | undefined
  const path: Vec2[] = [{ x, y }]
  const lava = state.lava ?? Infinity
  // v4: en el agua la bola frena como un proyectil (WATER_DRAG por segundo) y cada entrada salpica;
  // en la lava de la grilla se derrite como en la de muerte súbita
  let wet = liquidAt(t, x, y) === WATER
  const splashes: { x: number; y: number; t: number }[] = []
  const drag = WATER_DRAG ** SUBSTEP
  const push = (impact: Flight['impact']) => {
    const f: Flight = { path, impact, startT: flight.time }
    if (splashes.length > 0) f.splashes = splashes
    flights.push(f)
  }
  while (time < ROLL_MAX_T) {
    time += SUBSTEP
    n++
    if (wet) {
      vx *= drag
      vy *= drag
    }
    if (!air) {
      const s = slopeAt(x) / 4 // >0: baja hacia la derecha
      vx += (gravity * 0.9 * s) / Math.sqrt(1 + s * s) * SUBSTEP
      const fr = 70 * SUBSTEP
      vx = Math.abs(vx) <= fr ? 0 : vx - Math.sign(vx) * fr
      const nx = x + vx * SUBSTEP
      const g = surfaceFrom(state, Math.round(nx), y - 6)
      if (isSolid(t, nx, y - 6) || g < y + ROLL_R - 5) break // pared
      x = nx
      if (g > y + ROLL_R + 2) air = true
      else y = g - ROLL_R
      still = Math.abs(vx) < 4 ? still + SUBSTEP : 0
      if (still > 0.25) break
    } else {
      vy += gravity * SUBSTEP
      x += vx * SUBSTEP
      y += vy * SUBSTEP
      if (isSolid(t, x, y + ROLL_R)) {
        y = surfaceFrom(state, Math.round(x), y - 6) - ROLL_R
        vy = 0
        air = false
      }
    }
    if (x < -20 || x > t.w + 20 || y > t.h) {
      path.push({ x, y })
      push({ kind: 'out', x, y })
      return { flights, events }
    }
    if (y + ROLL_R >= lava || liquidAt(t, x, y) === LAVA || liquidAt(t, x, y + ROLL_R - 1) === LAVA) {
      // la bola rodó (o cayó) hasta la lava: se derrite sin explotar
      path.push({ x, y })
      push({ kind: 'lava', x, y })
      return { flights, events }
    }
    if (liquidAt(t, x, y) === WATER) {
      if (!wet) splashes.push({ x, y, t: time })
      wet = true
    } else wet = false
    hit = tankAt(state, x, y)
    if (hit && (hit.id !== shooter.id || time > 0.3)) break
    hit = undefined
    if (n % 4 === 0) path.push({ x, y })
  }
  path.push({ x, y })
  push(hit ? { kind: 'tank', x, y, tankId: hit.id } : { kind: 'terrain', x, y })
  const endT = flight.time + (path.length - 1) * PATH_DT
  const b = blastFor(weapon, x, y, endT, hit?.id, vx)
  events.push(...resolveBlast(state, b))
  markWater(flights[flights.length - 1], b)
  return { flights, events }
}
