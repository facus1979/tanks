// Modo demo (QA visual): el tiro de P1 se busca en una grilla y se valida en una copia del estado.
// Busca pegar en el suelo al costado de un rival (no encima) para que se vean el tanque y su tripulante.
import { applyCommand } from '../sim'
import type { ShotPlan } from '../sim'
import type { Flight, GameEvent, GameState, ImpactKind, WeaponId } from '../sim/types'

export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SIDE_IDEAL = 44
const CENTER_MIN = 30
// Alcance del racimo de fuego (fx.ts, radio 14) en el pico congelado: elipse sobre el impacto.
const FIRE_DY = -12
const FIRE_RX = 40
const FIRE_RY = 37

// Distancia normalizada de la elipse de fuego a la caja; < 1 es que la pisa.
function fireReach(hx: number, hy: number, x0: number, y0: number, x1: number, y1: number): number {
  const cx = hx
  const cy = hy + FIRE_DY
  const nx = Math.max(x0, Math.min(cx, x1))
  const ny = Math.max(y0, Math.min(cy, y1))
  return Math.hypot((nx - cx) / FIRE_RX, (ny - cy) / FIRE_RY)
}

export function pickDemoShot(state: GameState, seed: number, forced?: WeaponId): ShotPlan {
  const actor = state.players[state.current]
  const weapon = forced && (actor.ammo[forced] ?? 0) > 0 ? forced : demoWeapon(state)
  // con viento el impacto va del lado a sotavento: el fuego y el humo se alejan del tanque
  const side = Math.abs(state.wind) >= 2 ? Math.sign(state.wind) : seededRandom(seed * 977 + 7)() < 0.5 ? -1 : 1
  const sidePenalty = Math.abs(state.wind) >= 2 ? 20 : 6
  const scored: { plan: ShotPlan; score: number }[] = []
  const seen = new Set<string>()
  const consider = (angle: number, power: number) => {
    if (angle < 5 || angle > 175 || power < 20 || power > 100) return
    const key = `${angle}:${power}`
    if (seen.has(key)) return
    seen.add(key)
    const plan = { angle, power, weapon } as ShotPlan
    scored.push({ plan, score: evaluate(state, plan, side, sidePenalty) })
  }
  for (let angle = 14; angle <= 166; angle += 2) {
    for (let power = 30; power <= 100; power += 2) consider(angle, power)
  }
  // refina alrededor de los mejores: los huecos buenos a sotavento suelen ser angostos
  const top = [...scored].sort((a, b) => a.score - b.score).slice(0, 8)
  for (const { plan } of top) {
    for (let angle = plan.angle - 2; angle <= plan.angle + 2; angle++) {
      for (let power = plan.power - 2; power <= plan.power + 2; power++) consider(angle, power)
    }
  }
  let best: { plan: ShotPlan; score: number } | null = null
  for (const c of scored) if (!best || c.score < best.score) best = c
  return best?.plan ?? ({ angle: actor.angle, power: 60, weapon: 'normal' } as ShotPlan)
}

// Radio chico: la bola de fuego no tapa al tanque de al lado.
function demoWeapon(state: GameState): WeaponId {
  const actor = state.players[state.current]
  return (actor.ammo.normal ?? 1) > 0 ? 'normal' : 'heavy'
}

function evaluate(state: GameState, plan: ShotPlan, side: number, sidePenalty: number): number {
  const actor = state.players[state.current]
  try {
    let s = state
    if (actor.weapon !== plan.weapon) s = applyCommand(s, { type: 'selectWeapon', playerId: actor.id, weapon: plan.weapon }).state
    s = applyCommand(s, { type: 'aim', playerId: actor.id, angle: plan.angle, power: plan.power }).state
    const result = applyCommand(s, { type: 'fire', playerId: actor.id })
    const flights = result.flights ?? []
    const flight = flights[0]
    if (!flight || flight.path.length < 2) return 1e6
    // racimo y rodadora: el primer vuelo termina en el apogeo o al tocar el piso; cuentan las explosiones
    const blasts = result.events
      .filter((e): e is Extract<GameEvent, { type: 'impact' }> => e.type === 'impact' && e.source !== 'barrel')
      .sort((a, b) => a.t - b.t)
    const last = flights.reduce((a, b) => ((b.startT ?? 0) + b.path.length >= (a.startT ?? 0) + a.path.length ? b : a))
    if (blasts.length === 0 && last.impact.kind === 'out') return 1e5
    // con varias explosiones (racimo) se apunta con la del medio para que el racimo quede junto al rival
    const mid = [...blasts].sort((a, b) => a.x - b.x)[Math.floor(blasts.length / 2)]
    const hit = mid ? { x: mid.x, y: mid.y, kind: flightKindAt(flights, mid) } : last.impact
    if (hit.kind === 'out') return 1e5
    const rivals = state.players.filter((p) => p.alive && p.id !== actor.id)
    let dist = Infinity
    for (const r of rivals) {
      const dx = hit.x - r.x
      const adx = Math.abs(dx)
      const dy = Math.abs(hit.y - r.y)
      let d = Math.abs(adx - SIDE_IDEAL) + dy * 0.8
      if (Math.sign(dx) !== side) d += sidePenalty
      const after = result.state.players.find((q) => q.id === r.id)
      if (!after || !after.alive || Math.hypot(after.x - r.x, after.y - r.y) > 3) d += 80
      dist = Math.min(dist, d)
    }
    // ningún tanque (tampoco el que dispara) queda debajo del fuego
    let clash = 0
    for (const p of state.players) {
      if (!p.alive) continue
      const center = Math.hypot(hit.x - p.x, hit.y - (p.y - 10))
      if (center < CENTER_MIN) clash += 400 + (CENTER_MIN - center) * 20
      const crew = fireReach(hit.x, hit.y, p.x - 7, p.y - 34, p.x + 7, p.y - 18)
      if (crew < 1) clash += 300 + (1 - crew) * 600
      const hull = fireReach(hit.x, hit.y, p.x - 14, p.y - 20, p.x + 14, p.y)
      if (hull < 1) clash += (1 - hull) * 60
    }
    dist += clash
    let self = Math.hypot(hit.x - actor.x, hit.y - (actor.y - 10))
    for (const b of blasts) self = Math.min(self, Math.hypot(b.x - actor.x, b.y - (actor.y - 10)))
    // las otras bombitas tampoco pueden caer sobre un tanque
    for (const b of blasts) {
      if (b === mid) continue
      for (const p of state.players) {
        if (p.alive && Math.hypot(b.x - p.x, b.y - (p.y - 10)) < CENTER_MIN * 0.7) dist += 120
      }
    }
    let apex = Infinity
    for (const p of flight.path) apex = Math.min(apex, p.y)
    const arc = apex < Math.min(flight.path[0].y, hit.y) - 50
    return (
      dist +
      (hit.kind === 'terrain' ? 0 : 300) +
      (arc ? 0 : 150) +
      (self < 40 ? 500 : 0) +
      (apex < 0 ? 60 : 0)
    )
  } catch {
    return 1e6
  }
}

// Tipo del impacto del vuelo que termina en esa explosión (el más cercano a ella).
function flightKindAt(flights: Flight[], blast: { x: number; y: number }): ImpactKind {
  let kind: ImpactKind = 'terrain'
  let best = Infinity
  for (const f of flights) {
    const d = Math.hypot(f.impact.x - blast.x, f.impact.y - blast.y)
    if (d < best) {
      best = d
      kind = f.impact.kind
    }
  }
  return kind
}
