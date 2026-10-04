// v3 bioma nieve: reglas de la nieve blanda y del hielo para tanques.
//
// Nieve (SNOW): se rompe más fácil que la tierra (MATERIALS: toughness > 1) y se compacta bajo el tanque:
// al terminar cada turno, un tanque apoyado con toda la caja sobre nieve honda se hunde SNOW_SINK px (la
// nieve de debajo de sus orugas pasa a aire; la pared de fondo queda, así se ve la huella). Se hunde una sola vez por lugar:
// si al costado de la caja ya hay nieve más alta que su piso (está en su propia huella) no se hunde más.
// SNOW_SINK es mucho menos que MAX_CLIMB: el tanque sale de la huella caminando, nunca queda trabado.
//
// Hielo (ICE): sólido y resbaloso. Un tanque que se mueve o es empujado y termina sobre hielo sigue
// patinando en el mismo sentido (iceSkid) hasta ICE_SLIDE px de más, salvo que tenga el ancla
// (Player.anchored). Cada px fuera del hielo gasta ICE_OFF_COST del recorrido (la nieve y la tierra
// frenan enseguida) y subir gasta el doble por px de escalón. Patinando puede pasar un borde y caer (al
// abismo, a una grieta o al agua de un lago con la capa rota): la caída la resuelve después settleTank.
import { columnGround, columnTop, isSolid } from './terrain'
import { stepTank } from './slide'
import { PATH_DT } from './ballistics'
import {
  AIR,
  ICE,
  ICE_SLIDE,
  KNOCKBACK_MAX,
  SNOW,
  TANK_H,
  TANK_HALF_W,
  WATER,
  type GameEvent,
  type GameState,
  type Player,
  type Terrain,
  type Vec2,
} from './types'

export const SNOW_SINK = 3
// Para hundirse, la columna tiene que tener al menos SNOW_SINK + SNOW_SINK_FIRM filas sólidas desde el
// piso (si no, la nieve es una costra fina sobre un hueco y el tanque no la pisa).
const SNOW_SINK_FIRM = 2
const MIN_SUPPORT = 3 // como en physics
export const ICE_OFF_COST = 4
// Pixels por punto del path del patinazo (como el empuje).
const SKID_STEP = 2

// ---------- nieve ----------

// Cuánto se hundiría el tanque con el piso en (x, y): SNOW_SINK si apoya en nieve honda y todavía no está
// en su huella; 0 si no.
export function snowSinkAt(t: Terrain, x: number, y: number): number {
  if (y <= SNOW_SINK || y + SNOW_SINK + SNOW_SINK_FIRM >= t.h) return 0
  const cx = Math.round(x)
  const { w, front } = t
  // ya está en su huella: al costado de la caja hay nieve más alta que el piso
  for (const ix of [cx - TANK_HALF_W - 1, cx + TANK_HALF_W]) {
    if (ix >= 0 && ix < w && front[(y - 1) * w + ix] === SNOW) return 0
  }
  // todas las columnas de la caja: así el piso nuevo es parejo (una oruga a medio hundir quedaría mal apoyada)
  for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) if (ix < 0 || ix >= w || !sinkable(t, ix, y)) return 0
  return SNOW_SINK
}

function sinkable(t: Terrain, ix: number, y: number): boolean {
  const { w, front } = t
  for (let k = 0; k < SNOW_SINK; k++) if (front[(y + k) * w + ix] !== SNOW) return false
  for (let k = SNOW_SINK; k < SNOW_SINK + SNOW_SINK_FIRM; k++) if (!isSolid(t, ix, y + k)) return false
  return true
}

// Hunde al tanque con el piso en (x, y): pasa a aire las SNOW_SINK filas de nieve bajo las columnas de su
// caja que la sostienen (el back queda). Devuelve el piso nuevo (y si no se hundió). La usan el generador
// (los tanques nacen ya hundidos) y el fin de cada turno (compactSnow).
export function sinkIntoSnow(t: Terrain, x: number, y: number): number {
  if (snowSinkAt(t, x, y) <= 0) return y
  const cx = Math.round(x)
  const { w, front } = t
  for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) for (let k = 0; k < SNOW_SINK; k++) front[(y + k) * w + ix] = AIR
  // el piso nuevo: la primera fila con MIN_SUPPORT columnas sólidas (como tankFloor)
  for (let yy = y; yy < t.h; yy++) {
    let n = 0
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) if (isSolid(t, ix, yy)) n++
    if (n >= MIN_SUPPORT) return yy
  }
  return t.h
}

// Fin del turno: cada tanque vivo apoyado en nieve honda se hunde (evento 'fall' de SNOW_SINK px, sin daño,
// con t). own: la grilla del estado es propia (fire la clonó); si no (move la comparte con el estado
// anterior), se clona antes de tocarla.
export function compactSnow(state: GameState, events: GameEvent[], t: number, own: boolean): void {
  let cloned = own
  for (const p of state.players) {
    if (!p.alive || p.y >= state.terrain.h) continue
    if (snowSinkAt(state.terrain, p.x, p.y) <= 0) continue
    if (!cloned) {
      state.terrain = cloneGrid(state.terrain)
      cloned = true
    }
    const from = p.y
    p.y = sinkIntoSnow(state.terrain, p.x, p.y)
    if (p.y !== from) events.push({ type: 'fall', playerId: p.id, from, to: p.y, t })
  }
}

function cloneGrid(t: Terrain): Terrain {
  const c: Terrain = { w: t.w, h: t.h, front: t.front.slice(), back: t.back.slice() }
  if (t.pits) c.pits = t.pits.slice()
  return c
}

// ---------- hielo ----------

// El tanque con el piso en (x, y) está sobre hielo: al menos MIN_SUPPORT columnas de su caja con hielo en
// la fila del piso y el hielo es la mitad o más de lo que lo sostiene.
export function onIce(t: Terrain, x: number, y: number): boolean {
  if (y < 0 || y >= t.h) return false
  const cx = Math.round(x)
  const { w, front } = t
  let ice = 0
  let solid = 0
  for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) {
    if (ix < 0 || ix >= w) continue
    const m = front[y * w + ix]
    if (m === ICE) ice++
    if (isSolid(t, ix, y)) solid++
  }
  return ice >= MIN_SUPPORT && ice * 2 >= solid
}

// Patinazo: si el tanque quedó sobre hielo después de moverse o ser empujado hacia dir, sigue hasta
// ICE_SLIDE px (ver arriba). Emite 'slide' con cause 'ice' (con t si viene t). Devuelve el t en que termina
// (t si no patinó). Para en paredes, tanques, el borde del mapa o al pasar un borde (cae después).
export function iceSkid(
  state: GameState,
  p: Player,
  dir: -1 | 1,
  t: number | undefined,
  events: GameEvent[],
  tankFloorFn: (t: Terrain, x: number, y: number) => number,
): number | undefined {
  if (!p.alive || p.anchored || p.y >= state.terrain.h || !onIce(state.terrain, p.x, p.y)) return t
  const path: Vec2[] = [{ x: p.x, y: p.y }]
  let budget = ICE_SLIDE
  let moved = 0
  while (budget > 0) {
    const s = stepTank(state, p, p.x, p.y, dir, tankFloorFn)
    if (!s) break
    const up = Math.max(0, p.y - s.floor)
    p.x = s.x
    p.y = s.floor
    moved++
    if (moved % SKID_STEP === 0) path.push({ x: p.x, y: p.y })
    if (s.air) break // pasó un borde: cae después
    budget -= (onIce(state.terrain, p.x, p.y) ? 1 : ICE_OFF_COST) + 2 * up
  }
  if (moved === 0) return t
  const last = path[path.length - 1]
  if (last.x !== p.x || last.y !== p.y) path.push({ x: p.x, y: p.y })
  const e: GameEvent = { type: 'slide', playerId: p.id, cause: 'ice', path }
  if (t !== undefined) e.t = t
  events.push(e)
  return (t ?? 0) + (path.length - 1) * PATH_DT
}

// IA: riesgo de quedar parada sobre hielo cerca de un peligro (boca de abismo, agua sin hielo encima o una
// caída de más de ICE_DROP px). Un empujón más el patinazo la pueden llevar hasta ICE_RISK_RANGE px.
// Devuelve puntos de puntaje (0 si no está sobre hielo o no hay peligro al alcance).
const ICE_RISK_RANGE = ICE_SLIDE + KNOCKBACK_MAX + 8
const ICE_DROP = 40
export const ICE_RISK = 450
export function iceRisk(state: GameState, p: { x: number; y: number; anchored?: boolean }): number {
  const t = state.terrain
  if (p.anchored || p.y >= t.h || !onIce(t, p.x, p.y)) return 0
  const cx = Math.round(p.x)
  for (let d = 0; d < ICE_RISK_RANGE; d++) {
    for (const ix of [cx - TANK_HALF_W - d, cx + TANK_HALF_W - 1 + d]) {
      if (ix < 0 || ix >= t.w) continue
      const top = columnTop(t, ix, Math.max(0, p.y - TANK_H))
      const hole =
        (t.pits?.[ix] === 1 && columnGround(t, ix, Math.max(0, p.y - TANK_H)) >= t.h) ||
        (top < t.h && t.front[top * t.w + ix] === WATER) ||
        columnGround(t, ix, Math.max(0, p.y - TANK_H)) > p.y + ICE_DROP
      if (hole) return Math.round(ICE_RISK * (1 - d / ICE_RISK_RANGE))
    }
  }
  return 0
}
