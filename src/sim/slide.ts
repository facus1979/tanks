// Pulido v2: empuje de las explosiones y deslizamiento en pendientes.
//
// Las dos cosas mueven al tanque por el piso igual que un 'move' (stepTank), pero sin gastar
// combustible: sube escalones de hasta MAX_CLIMB, se frena contra paredes, techos bajos y otros
// tanques. Si en un paso el piso cae más de MAX_CLIMB (pasó un borde), el recorrido termina ahí y la
// caída la resuelve después settleTank (evento 'fall' a continuación del 'slide'). Un tanque que ya
// quedó sin piso (la explosión le voló el apoyo) no se empuja: cae.
import { columnGround, isSolid } from './terrain'
import { MAX_CLIMB, SLIDE_SLOPE, TANK_H, TANK_HALF_W, TANK_W, type GameEvent, type GameState, type Player, type Vec2 } from './types'
import { PATH_DT } from './ballistics'

// Pixels por punto del path (cada PATH_DT = 1/60 s): el empuje va a 120 px/s y el deslizamiento a 60 px/s.
export const BLAST_STEP = 2
export const SLOPE_STEP = 1
// Tope de recorrido de un deslizamiento por evento.
export const SLIDE_MAX = 160
// Columnas de cada borde de las orugas que se miran para medir la pendiente.
const EDGE_COLS = 3
// Hasta cuánto por debajo del piso se mira el borde bajo (una caída más honda cuenta como esta).
export const SLOPE_CAP = 6 * TANK_W // v2.2: por encima de SLIDE_SLOPE (3,75), así un tanque colgando de un borde siempre resbala

// Resultado de intentar un paso de 1 px: null si algo lo frena; si no, la y del piso nuevo
// (air = true si no hay piso a menos de MAX_CLIMB: el tanque sigue a su altura, por el aire).
export interface Step {
  x: number
  floor: number
  air: boolean
}

// Un paso de 1 px hacia dir desde (x, y) con las mismas reglas que 'move' (pared, techo, otros tanques).
// tankFloorFn: la búsqueda de piso de physics (se pasa para no crear un import circular).
export function stepTank(
  state: GameState,
  p: Player,
  x: number,
  y: number,
  dir: -1 | 1,
  tankFloorFn: (t: GameState['terrain'], x: number, y: number) => number,
): Step | null {
  const t = state.terrain
  const nx = x + dir
  if (nx < TANK_HALF_W || nx > state.width - TANK_HALF_W) return null
  const edge = dir > 0 ? nx + TANK_HALF_W - 1 : nx - TANK_HALF_W
  for (let yy = y - TANK_H; yy < y - MAX_CLIMB; yy++) if (isSolid(t, edge, yy)) return null
  let floor = tankFloorFn(t, nx, y - MAX_CLIMB)
  const air = floor > y + MAX_CLIMB
  if (air) floor = y
  // al subir, el techo tiene que dejar lugar
  for (let yy = floor - TANK_H; yy < y - TANK_H; yy++) {
    for (let xx = nx - TANK_HALF_W; xx < nx + TANK_HALF_W; xx++) if (isSolid(t, xx, yy)) return null
  }
  // no se mete dentro de otro tanque
  for (const q of state.players) {
    if (q.id === p.id || !q.alive) continue
    if (Math.abs(q.x - nx) < TANK_W && Math.abs(q.x - nx) < Math.abs(q.x - x) && Math.abs(q.y - floor) < TANK_H) return null
  }
  return { x: nx, floor, air }
}

// Pendiente bajo el tanque parado en (x, y): diferencia entre el piso de los dos bordes de las
// orugas (el más alto de las EDGE_COLS columnas de cada borde, buscando desde y - MAX_CLIMB, con
// tope SLOPE_CAP por debajo de y) dividida por TANK_W. Positiva: el borde derecho está más abajo.
export function slopeAt(state: GameState, x: number, y: number): number {
  const t = state.terrain
  const cx = Math.round(x)
  const edge = (from: number): number => {
    let best = y + SLOPE_CAP
    for (let i = 0; i < EDGE_COLS; i++) best = Math.min(best, columnGround(t, from + i, y - MAX_CLIMB))
    return Math.min(best, y + SLOPE_CAP)
  }
  const left = edge(cx - TANK_HALF_W)
  const right = edge(cx + TANK_HALF_W - EDGE_COLS)
  return (right - left) / TANK_W
}

// v2.3: vuelco al abismo. Un tanque con el centro sobre un abismo (columnas de abismo) y apoyado solo de
// un lado (ninguna columna del centro ni del otro lado tiene piso en la fila de las orugas o TIP_DEPTH px
// más abajo), con abismo también bajo el borde que cuelga, se vuelca hacia el vacío: se desliza hacia ese
// lado hasta quedar sin piso y cae. Antes se quedaba haciendo equilibrio con 3 columnas sobre la punta de
// una cornisa o sobre el borde redondeado de un labio. Fuera de los abismos no cambia nada.
// Devuelve el lado hacia el que se vuelca, o null.
export function tipDir(state: GameState, p: Player): -1 | 1 | null {
  const t = state.terrain
  if (!t.pits) return null
  const cx = Math.round(p.x)
  if (!t.pits[cx - 1] || !t.pits[cx]) return null
  // apoyo: columnas con piso en la fila de las orugas o hasta TIP_DEPTH más abajo (un labio redondeado)
  let left = 0
  let right = 0
  for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) {
    let solid = false
    for (let y = p.y; y <= p.y + TIP_DEPTH && !solid; y++) solid = isSolid(t, ix, y)
    if (!solid) continue
    if (ix < cx - 1) left++
    else if (ix > cx) right++
    else return null // el centro está apoyado
  }
  // hacia el lado sin apoyo tiene que haber abismo bajo el borde de las orugas
  if (left > 0 && right === 0 && t.pits[cx + TANK_HALF_W - 1]) return 1
  if (right > 0 && left === 0 && t.pits[cx - TANK_HALF_W]) return -1
  return null
}
const TIP_DEPTH = 2

// Recorre hasta `dist` px hacia dir paso a paso. Devuelve el path (piso cada `per` px, empezando por
// la posición inicial) o null si no se movió. Muta p.x / p.y. Para por pared, tanque, borde del mapa,
// al pasar un borde (queda sin piso: el último paso no cambia la y) o, si stopWhenFlat, cuando la
// pendiente ya no lo empuja hacia dir.
function travel(
  state: GameState,
  p: Player,
  dir: -1 | 1,
  dist: number,
  per: number,
  tankFloorFn: (t: GameState['terrain'], x: number, y: number) => number,
  stopWhenFlat: boolean,
): Vec2[] | null {
  const path: Vec2[] = [{ x: p.x, y: p.y }]
  let moved = 0
  for (let i = 0; i < dist; i++) {
    const s = stepTank(state, p, p.x, p.y, dir, tankFloorFn)
    if (!s) break
    p.x = s.x
    p.y = s.floor
    moved++
    if (moved % per === 0) path.push({ x: p.x, y: p.y })
    if (s.air) break // pasó el borde: desde acá cae
    if (stopWhenFlat && slopeAt(state, p.x, p.y) * dir <= SLIDE_SLOPE) break
  }
  if (moved === 0) return null
  const last = path[path.length - 1]
  if (last.x !== p.x || last.y !== p.y) path.push({ x: p.x, y: p.y })
  return path
}

// Empuje de una explosión: el tanque recorre `dist` px hacia dir. Emite 'slide' (cause 'blast') con t.
// Devuelve el t en que termina (o t si no se movió).
export function knock(
  state: GameState,
  p: Player,
  dir: -1 | 1,
  dist: number,
  t: number,
  events: GameEvent[],
  tankFloorFn: (t: GameState['terrain'], x: number, y: number) => number,
  cause: 'blast' | 'quake' | 'pull' = 'blast', // v3: sacudón del terremoto, atracción del agujero negro
): number {
  // sin piso a menos de MAX_CLIMB (le volaron el apoyo): no hay de dónde empujarlo, cae
  if (p.y >= state.terrain.h || tankFloorFn(state.terrain, p.x, p.y - MAX_CLIMB) > p.y + MAX_CLIMB) return t
  const path = travel(state, p, dir, dist, BLAST_STEP, tankFloorFn, false)
  if (!path) return t
  events.push({ type: 'slide', playerId: p.id, cause, path, t })
  return t + (path.length - 1) * PATH_DT
}

// Deslizamiento: si el piso del tanque es más empinado que SLIDE_SLOPE, baja hasta quedar estable
// (o hasta SLIDE_MAX px, o hasta quedar sin piso). Emite 'slide' (cause 'slope'); t opcional.
// Devuelve el t en que termina, o null si no se deslizó.
export function slideDown(
  state: GameState,
  p: Player,
  t: number | undefined,
  events: GameEvent[],
  tankFloorFn: (t: GameState['terrain'], x: number, y: number) => number,
): number | null {
  if (!p.alive || p.y >= state.terrain.h || p.anchored) return null // v3: anclado no resbala
  const s = slopeAt(state, p.x, p.y)
  // v2.3: vuelco al abismo (ver tipDir): el tanque se va hacia el vacío hasta quedar sin piso
  const tip = tipDir(state, p)
  if (Math.abs(s) <= SLIDE_SLOPE && !tip) return null
  const dir: -1 | 1 = tip ?? (s > 0 ? 1 : -1)
  const path = travel(state, p, dir, SLIDE_MAX, SLOPE_STEP, tankFloorFn, !tip)
  if (!path) return null
  const e: GameEvent = { type: 'slide', playerId: p.id, cause: 'slope', path }
  if (t !== undefined) e.t = t
  events.push(e)
  return (t ?? 0) + (path.length - 1) * PATH_DT
}
