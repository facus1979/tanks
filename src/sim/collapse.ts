// v2.4: derrumbe. Después de cada fire que rompió terreno, los terrones sueltos caen y se asientan.
//
// Qué se cae: los componentes de tierra o piedra (conexión por los 8 vecinos, a través de cualquier sólido)
// que quedaron sin apoyo. Un componente está apoyado si toca, sin cortar:
//   - roca madre o una estructura (ladrillo, madera, tabla, viga, poste, metal: las estructuras no se caen
//     en este juego, así que sostienen lo que tienen pegado);
//   - la última fila del mapa fuera de un abismo (debajo es roca madre);
//   - o si es grande: la búsqueda se corta a COLLAPSE_BUDGET celdas y lo que llega a ese tamaño se toma por
//     apoyado. Así la búsqueda es barata (no recorre medio mapa por cada tiro) y los salientes unidos al
//     terreno (cornisas, techos de cuevas, puentes de v2.3) nunca se caen: son parte de la masa del terreno.
//     Un terrón suelto de más de COLLAPSE_BUDGET celdas (unos 63 × 63 px) se queda donde está: con los radios
//     de las armas (la nuke es 60) no pasa en la práctica.
// Solo se miran los componentes que tocan el rectángulo sucio del tiro (lo que el tiro cambió): lo que ya
// estaba flotando en el mapa (napalm sobre el agua, piedra sobre la lava) no se toca.
//
// Cómo cae: por columnas, como en los juegos de artillería clásicos. Cada celda suelta baja (1 px por
// iteración al principio, acelerando hasta COLLAPSE_MAX_SPEED) hasta apoyarse en algo que no se está
// cayendo. De abajo hacia arriba, así las de una columna se apilan en orden y conservan el material.
//   - Agua: la celda se hunde cambiando de lugar con el agua (1 px por iteración); el agua queda arriba y
//     el flujo la reparte después.
//   - Lava de la grilla: la tierra se vuelve piedra y se apoya sobre la lava (no la desplaza).
//   - Lava de muerte súbita (band): la tierra que pasa la superficie se vuelve piedra y sigue cayendo.
//   - Abismo: lo que sale por debajo de la grilla en una columna de abismo se pierde.
//   - Los tanques no frenan la caída: la tierra los tapa (como el arma Tierra) y aplasta (ver collapseCrush).
//
// Determinista: orden fijo (fila de abajo hacia arriba, dentro de la fila de izquierda a derecha), sin rng.
// Parches para animar como el flujo: patches[0] es el rectángulo total como estaba antes del derrumbe, luego
// uno cada COLLAPSE_FRAME_ITERS iteraciones con lo que cambió; aplicarlos en orden deja la grilla final.
import { LIQUID, markDirty, SOLID, type Rect } from './terrain'
import { patchOf } from './flow'
import { AIR, DIRT, LAVA, STONE, WATER, type Terrain, type TerrainPatch } from './types'

export const COLLAPSE_BUDGET = 4000
export const COLLAPSE_MAX_SPEED = 4
export const COLLAPSE_FRAME_ITERS = 2
// Tope de iteraciones animadas; las que sigan (hasta COLLAPSE_EXTRA_ITERS) van todas al último parche.
export const COLLAPSE_MAX_ITERS = 240
export const COLLAPSE_EXTRA_ITERS = 2000

export interface CollapseOptions {
  seed: Rect | null // rectángulo sucio del tiro; null = nada que mirar
  record: boolean // armar los parches (fire); la IA no los necesita
  band?: number // y de la superficie de la lava de muerte súbita (GameState.lava)
}

// Una celda que cayó: dónde terminó y cuánto bajó (para el aplastamiento).
export interface CollapseLanding {
  i: number
  drop: number
}

export interface CollapseReport {
  changed: boolean
  cells: number // celdas que se cayeron (incluidas las perdidas en un abismo)
  lost: number // cayeron por un abismo
  stone: number // tierra que se volvió piedra (lava)
  iters: number
  patches: TerrainPatch[]
  landed: CollapseLanding[]
  touched: Rect | null
}

// ---------- buffers reusados (sellos por celda, como en flow.ts) ----------
let seen = new Uint32Array(0) // ya se clasificó en esta llamada
let comp = new Int32Array(0) // índice del componente de la celda (válido si seen === sello)
let falling = new Uint32Array(0) // la celda tiene un terrón cayendo (sello de la llamada)
let touchedAt = new Uint32Array(0)
let gen = 0
let stack = new Int32Array(4096)

function ensure(n: number): void {
  if (seen.length >= n) return
  seen = new Uint32Array(n)
  comp = new Int32Array(n)
  falling = new Uint32Array(n)
  touchedAt = new Uint32Array(n)
  gen = 0
}

function nextGen(): number {
  gen++
  if (gen === 0xffffffff) {
    seen.fill(0)
    falling.fill(0)
    touchedAt.fill(0)
    gen = 1
  }
  return gen
}

const ANCHOR = new Uint8Array(256) // sólidos que sostienen: todo lo que no es tierra ni piedra
for (let m = 1; m < 256; m++) if (SOLID[m] && m !== DIRT && m !== STONE) ANCHOR[m] = 1

// Medición (para sim-check; no afecta la simulación).
export const collapseStats = { calls: 0, collapses: 0, ms: 0, worst: 0, cells: 0 }

export function collapseTerrain(t: Terrain, opts: CollapseOptions): CollapseReport {
  const report: CollapseReport = { changed: false, cells: 0, lost: 0, stone: 0, iters: 0, patches: [], landed: [], touched: null }
  const seed = opts.seed
  if (!seed) return report
  const { w, h, front } = t
  const pits = t.pits
  ensure(w * h)
  const call = nextGen()

  // ---- 1. componentes sueltos que tocan el rectángulo sucio (más un px de borde) ----
  const loose: number[] = [] // celdas de componentes sin apoyo
  const anchored: boolean[] = [] // por componente
  const x0 = Math.max(0, seed.x0 - 1)
  const x1 = Math.min(w - 1, seed.x1 + 1)
  const y0 = Math.max(0, seed.y0 - 1)
  const y1 = Math.min(h - 1, seed.y1 + 1)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x
      const m = front[i]
      if ((m !== DIRT && m !== STONE) || seen[i] === call) continue
      const id = anchored.length
      const cells = flood(i, id)
      anchored.push(cells === null)
      if (cells) for (const c of cells) loose.push(c)
    }
  }
  if (loose.length === 0) return report

  // flood: recorre el componente de i. Devuelve sus celdas si está suelto, null si está apoyado.
  function flood(start: number, id: number): number[] | null {
    const cells: number[] = []
    let sp = 0
    stack[sp++] = start
    seen[start] = call
    comp[start] = id
    let ok = false
    // tocó una celda de una búsqueda anterior: esa búsqueda se cortó por apoyada (si hubiera estado suelta
    // la habría recorrido entera, y esta celda sería parte de ella), así que este componente también
    let old = false
    while (sp > 0) {
      const i = stack[--sp]
      cells.push(i)
      const x = i % w
      const y = (i - x) / w
      // piedra apoyada sobre un líquido: flota (la costra del napalm sobre el agua, la tierra que ya cayó a la
      // lava y se hizo piedra); lo que cae de arriba sí se hunde en el agua (ver la caída)
      const floats = front[i] === STONE && y < h - 1 && LIQUID[front[i + w]] === 1
      if (old || floats || ANCHOR[front[i]] || (y === h - 1 && !(pits && pits[x])) || cells.length > COLLAPSE_BUDGET) {
        ok = true
        break
      }
      // vecinos sólidos
      // 8 vecinos: un terrón que toca en diagonal sigue pegado (si no, los bordes desparejos de las cuevas y
      // los cráteres soltaban migas de 1-3 px en cada tiro)
      if (x > 0) {
        push(i - 1)
        if (y > 0) push(i - w - 1)
        if (y < h - 1) push(i + w - 1)
      }
      if (x < w - 1) {
        push(i + 1)
        if (y > 0) push(i - w + 1)
        if (y < h - 1) push(i + w + 1)
      }
      if (y > 0) push(i - w)
      if (y < h - 1) push(i + w)
    }
    // apoyado: todo lo visto (también lo que quedó en la pila) queda marcado con este componente, así otra
    // búsqueda que lo toque sabe que está apoyada (ver old)
    return ok ? null : cells
    function push(j: number): void {
      if (!SOLID[front[j]]) return
      if (seen[j] === call) {
        if (comp[j] !== id) old = true
        return
      }
      seen[j] = call
      comp[j] = id
      if (sp >= stack.length) {
        const b = new Int32Array(stack.length * 2)
        b.set(stack)
        stack = b
      }
      stack[sp++] = j
    }
  }

  // ---- 2. caída por columnas ----
  // de abajo hacia arriba y, en cada fila, de izquierda a derecha (orden fijo)
  loose.sort((a, b) => {
    const ya = (a / w) | 0
    const yb = (b / w) | 0
    return yb - ya || a - b
  })
  const n = loose.length
  const pos = Int32Array.from(loose) // dónde está cada terrón (-1: ya se apoyó o se perdió)
  const startY = new Int32Array(n)
  for (let k = 0; k < n; k++) {
    startY[k] = (pos[k] / w) | 0
    falling[pos[k]] = call
  }
  report.cells = n
  const band = opts.band ?? Infinity
  const origIdx: number[] = []
  const origVal: number[] = []
  let wx0 = w
  let wy0 = h
  let wx1 = -1
  let wy1 = -1
  let tx0 = w
  let ty0 = h
  let tx1 = -1
  let ty1 = -1
  const set = (i: number, m: number) => {
    if (touchedAt[i] !== call) {
      touchedAt[i] = call
      origIdx.push(i)
      origVal.push(front[i])
    }
    front[i] = m
    const x = i % w
    const y = (i - x) / w
    if (x < wx0) wx0 = x
    if (x > wx1) wx1 = x
    if (y < wy0) wy0 = y
    if (y > wy1) wy1 = y
  }
  const flush = () => {
    if (wx1 < 0) return
    if (wx0 < tx0) tx0 = wx0
    if (wx1 > tx1) tx1 = wx1
    if (wy0 < ty0) ty0 = wy0
    if (wy1 > ty1) ty1 = wy1
    if (opts.record) report.patches.push(patchOf(t, wx0, wy0, wx1, wy1))
    wx0 = w
    wy0 = h
    wx1 = wy1 = -1
  }
  const land = (k: number) => {
    const i = pos[k]
    falling[i] = 0
    pos[k] = -1
    const drop = ((i / w) | 0) - startY[k]
    if (drop > 0) report.landed.push({ i, drop })
  }

  let active = n
  let iter = 0
  const limit = COLLAPSE_MAX_ITERS + COLLAPSE_EXTRA_ITERS
  while (active > 0 && iter < limit) {
    iter++
    const speed = Math.min(COLLAPSE_MAX_SPEED, 1 + ((iter - 1) >> 2))
    for (let k = 0; k < n; k++) {
      let i = pos[k]
      if (i < 0) continue
      const x = i % w
      for (let s = 0; s < speed; s++) {
        const y = (i - x) / w
        if (y + 1 >= h) {
          if (pits && pits[x]) {
            // al abismo: se pierde
            set(i, AIR)
            falling[i] = 0
            pos[k] = -1
            report.lost++
            active--
          } else {
            land(k)
            active--
          }
          break
        }
        const j = i + w
        const below = front[j]
        if (below === AIR) {
          let m = front[i]
          if (m === DIRT && y + 1 >= band) {
            m = STONE // pasó la superficie de la lava de muerte súbita
            report.stone++
          }
          set(i, AIR)
          set(j, m)
          falling[i] = 0
          falling[j] = call
          i = j
          pos[k] = j
          continue
        }
        if (below === WATER) {
          // se hunde de a 1 px por iteración: cambia de lugar con el agua
          const m = front[i]
          set(i, WATER)
          set(j, m)
          falling[i] = 0
          falling[j] = call
          pos[k] = j
          break
        }
        if (below === LAVA) {
          if (front[i] === DIRT) {
            set(i, STONE)
            report.stone++
          }
          land(k)
          active--
          break
        }
        // sólido: si es otro terrón que todavía cae, espera; si no, se apoya
        if (falling[j] !== call) {
          land(k)
          active--
        }
        break
      }
    }
    if (iter % COLLAPSE_FRAME_ITERS === 0 && iter <= COLLAPSE_MAX_ITERS) flush()
  }
  // lo que no terminó de caer en el tope (no debería pasar: 2240 iteraciones a 4 px son 8000 px) queda donde está
  for (let k = 0; k < n; k++) if (pos[k] >= 0) {
    falling[pos[k]] = 0
    land(k)
  }
  flush()
  report.iters = iter
  if (tx1 < 0) return report
  report.changed = true
  report.touched = { x0: tx0, y0: ty0, x1: tx1, y1: ty1 }
  markDirty(t, tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1) // el flujo arranca también desde lo que cayó (agua desplazada)
  if (opts.record) {
    const p0 = patchOf(t, tx0, ty0, tx1, ty1)
    const pw = p0.w
    for (let k = 0; k < origIdx.length; k++) {
      const i = origIdx[k]
      const x = i % w
      const y = (i - x) / w
      p0.front[(y - ty0) * pw + (x - tx0)] = origVal[k]
    }
    report.patches.unshift(p0)
  }
  return report
}
