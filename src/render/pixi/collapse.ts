// v2.4: derrumbe (evento 'collapse'). La sesión aplica los parches a la grilla del frame en su momento; acá
// se mira qué cambió en la zona de los parches cada vez que cambia la grilla (contra una copia propia), así
// los efectos quedan sincronizados con lo que se ve aunque haya cámara lenta o hit-stop:
// - celdas que pasaron de aire a sólido: el frente de lo que cae (polvo hacia los costados, piedritas);
// - celdas que pasaron de sólido a aire: el borde de arriba (polvo que queda flotando);
// - sólido que entra donde había agua: salpicadura;
// - cuando la zona llega al último parche (o se acaba el tiempo): nube de polvo al asentarse.
import type { GameEvent, Terrain } from '../../sim/types'
import { DIRT, STONE, WATER } from '../../sim/types'
import type { Fx } from './fx'
import { solidCell } from './liquids'
import { Rng } from './raster'
import type { Rect } from './terrain'

type CollapseEvent = Extract<GameEvent, { type: 'collapse' }>

const SAMPLES = 24 // celdas de borde que se guardan por cambio de grilla (muestreo al azar)
const DUST_PER_CHANGE = 6 // tope de bocanadas de polvo por cambio de grilla y derrumbe
const TAIL = 1.5 // segundos de margen después del último parche antes de darlo por asentado

interface Job {
  ev: CollapseEvent
  rect: Rect // unión de los rectángulos de los parches
  rw: number
  grid: Uint8Array // copia de terrain.front en rect (lo último que se vio)
  age: number
  limit: number // edad tope: patches.length · dt + TAIL
  mats: number[] // celdas que se movieron por material (para el color)
  // zona de lo que llegó (frente de abajo), para la nube del final
  lx0: number
  lx1: number
  ly: number
  splashes: number
}

export class CollapseView {
  private jobs: Job[] = []
  private rng = new Rng(2410)
  private down: number[] = [] // x, y, material de las muestras del frente de abajo
  private up: number[] = [] // x, y, material de las muestras del borde de arriba
  private wet: number[] = [] // x, y de sólido que entró en el agua
  // último material que se derrumbó cerca de cada x (para el polvo del tanque aplastado)
  private recent: { x0: number; x1: number; mat: number; age: number }[] = []

  get active(): boolean {
    return this.jobs.length > 0
  }

  reset(): void {
    this.jobs = []
    this.recent = []
  }

  // Rectángulo que tocan los derrumbes en curso (para limitar el diff del pintor), o null.
  get rect(): Rect | null {
    let r: Rect | null = null
    for (const j of this.jobs) {
      const q = j.rect
      r = r ? { x0: Math.min(r.x0, q.x0), y0: Math.min(r.y0, q.y0), x1: Math.max(r.x1, q.x1), y1: Math.max(r.y1, q.y1) } : { ...q }
    }
    return r
  }

  start(ev: CollapseEvent, t: Terrain): void {
    if (!ev.patches.length) return
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of ev.patches) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x + p.w)
      y1 = Math.max(y1, p.y + p.h)
    }
    x0 = Math.max(0, x0)
    y0 = Math.max(0, y0)
    x1 = Math.min(t.w, x1)
    y1 = Math.min(t.h, y1)
    if (x1 <= x0 || y1 <= y0) return
    const rw = x1 - x0
    const grid = new Uint8Array(rw * (y1 - y0))
    // copia de la grilla que se ve ahora (si la sesión ya aplicó el primer parche, ese paso no da efectos)
    for (let y = y0; y < y1; y++) grid.set(t.front.subarray(y * t.w + x0, y * t.w + x1), (y - y0) * rw)
    this.jobs.push({ ev, rect: { x0, y0, x1, y1 }, rw, grid, age: 0, limit: ev.patches.length * ev.dt + TAIL, mats: [], lx0: Infinity, lx1: -Infinity, ly: -Infinity, splashes: 0 })
  }

  // Material derrumbado cerca de x: el de un derrumbe en curso o el más reciente (tierra si no hay ninguno).
  materialNear(x: number): number {
    for (const j of this.jobs) {
      if (x < j.rect.x0 - 30 || x > j.rect.x1 + 30) continue
      return (j.mats[STONE] ?? 0) > (j.mats[DIRT] ?? 0) ? STONE : DIRT
    }
    let best = DIRT
    let age = Infinity
    for (const r of this.recent) {
      if (x < r.x0 - 30 || x > r.x1 + 30 || r.age >= age) continue
      best = r.mat
      age = r.age
    }
    return best
  }

  // changed: la grilla cambió este frame. dt: segundos del frame (0 congelado). splash: salpicadura en el agua
  // (x de la columna y fila donde entró el sólido).
  update(fx: Fx, t: Terrain, changed: boolean, dt: number, splash: (x: number, y: number) => void): void {
    for (const r of this.recent) r.age += dt
    if (this.recent.length) this.recent = this.recent.filter((r) => r.age < 3)
    if (!this.jobs.length) return
    const live: Job[] = []
    for (const j of this.jobs) {
      j.age += dt
      if (changed) this.diff(fx, t, j, splash)
      if (j.age < j.limit && !(changed && this.done(t, j))) {
        live.push(j)
        continue
      }
      this.settle(fx, j)
    }
    this.jobs = live
  }

  // Compara la zona con la copia y dispara el polvo de los bordes y las piedritas.
  private diff(fx: Fx, t: Terrain, j: Job, splash: (x: number, y: number) => void): void {
    const { x0, y0, x1, y1 } = j.rect
    const rw = j.rw
    const g = j.grid
    const down = this.down
    const up = this.up
    const wet = this.wet
    down.length = 0
    up.length = 0
    wet.length = 0
    let nDown = 0
    let nUp = 0
    const rng = this.rng
    for (let y = y0; y < y1; y++) {
      const row = y * t.w
      const grow = (y - y0) * rw - x0
      for (let x = x0; x < x1; x++) {
        const nw = t.front[row + x]
        const old = g[grow + x]
        if (nw === old) continue
        g[grow + x] = nw
        const sNew = solidCell(nw)
        const sOld = solidCell(old)
        if (sNew === sOld) continue
        if (sNew) {
          // reservoir: muestras parejas aunque el frente sea largo
          nDown++
          j.mats[nw] = (j.mats[nw] ?? 0) + 1
          if (down.length < SAMPLES * 3) down.push(x, y, nw)
          else {
            const k = Math.floor(rng.next() * nDown)
            if (k < SAMPLES) {
              down[k * 3] = x
              down[k * 3 + 1] = y
              down[k * 3 + 2] = nw
            }
          }
          if (old === WATER && wet.length < 8) wet.push(x, y)
          if (x < j.lx0) j.lx0 = x
          if (x > j.lx1) j.lx1 = x
          if (y > j.ly) j.ly = y
        } else {
          nUp++
          if (up.length < SAMPLES * 3) up.push(x, y, old)
          else {
            const k = Math.floor(rng.next() * nUp)
            if (k < SAMPLES) {
              up[k * 3] = x
              up[k * 3 + 1] = y
              up[k * 3 + 2] = old
            }
          }
        }
      }
    }
    if (!nDown && !nUp) return
    // polvo: proporcional al largo de los bordes, con tope (un derrumbe grande no satura las partículas)
    const nd = Math.min(DUST_PER_CHANGE, Math.ceil(nDown / 30))
    for (let i = 0; i < nd && i * 3 < down.length; i++) {
      const k = Math.floor(rng.next() * (down.length / 3)) * 3
      fx.collapseDust(down[k], down[k + 1], down[k + 2], true)
    }
    const nu = Math.min(DUST_PER_CHANGE >> 1, Math.ceil(nUp / 50))
    for (let i = 0; i < nu && i * 3 < up.length; i++) {
      const k = Math.floor(rng.next() * (up.length / 3)) * 3
      fx.collapseDust(up[k], up[k + 1], up[k + 2], false)
    }
    // piedritas y terrones que se sueltan del frente y caen adelante del bloque
    const np = Math.min(3, Math.ceil(nDown / 60))
    for (let i = 0; i < np && i * 3 < down.length; i++) {
      if (rng.next() < 0.35) continue
      const k = Math.floor(rng.next() * (down.length / 3)) * 3
      fx.collapsePebble(down[k] + (rng.next() - 0.5) * 2, down[k + 1] + 1, down[k + 2], (rng.next() - 0.5) * 70, -(10 + rng.next() * 50))
    }
    // lo que entra en el agua salpica (pocas veces por derrumbe)
    for (let i = 0; i < wet.length && j.splashes < 6; i += 2) {
      if (rng.next() < 0.6) continue
      j.splashes++
      splash(wet[i], wet[i + 1])
    }
  }

  // ¿La zona ya quedó como el último parche? (el derrumbe terminó de aplicarse)
  private done(t: Terrain, j: Job): boolean {
    const p = j.ev.patches[j.ev.patches.length - 1]
    for (let yy = 0; yy < p.h; yy++) {
      const y = p.y + yy
      if (y < 0 || y >= t.h) continue
      for (let xx = 0; xx < p.w; xx++) {
        const x = p.x + xx
        if (x < 0 || x >= t.w) continue
        if (t.front[y * t.w + x] !== p.front[yy * p.w + xx]) return false
      }
    }
    return true
  }

  // Nube de polvo al asentarse, más grande según las celdas del evento.
  private settle(fx: Fx, j: Job): void {
    const mat = (j.mats[STONE] ?? 0) > (j.mats[DIRT] ?? 0) ? STONE : DIRT
    let x0 = j.lx0
    let x1 = j.lx1
    let y = j.ly
    if (!Number.isFinite(x0)) {
      // no se vio ningún cambio (por ejemplo, todo se aplicó antes del evento): la nube va en el último parche
      const p = j.ev.patches[j.ev.patches.length - 1]
      x0 = p.x
      x1 = p.x + p.w
      y = p.y + p.h - 1
    }
    fx.settleCloud(x0, x1, y, j.ev.cells, mat)
    this.recent.push({ x0, x1, mat, age: 0 })
  }
}
