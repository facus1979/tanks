// v4: flujo de líquidos. Autómata celular determinista (sin Math.random) sobre Terrain.front.
//
// Reglas de cada iteración, para cada celda de líquido de la zona activa, de abajo hacia arriba:
//   1. Reacciones con los 4 vecinos: agua que toca lava → la celda de lava se vuelve piedra y la de agua
//      se evapora (aire); lava que toca algo inflamable lo quema (front a aire, el back queda, como el
//      napalm). Si la celda cambió, no se mueve.
//   2. Cae: si abajo hay aire, baja hasta FALL[m] celdas. En una columna de abismo, lo que sale por
//      debajo de la grilla se pierde. Fuera de los abismos, debajo del mapa es roca madre.
//   3. Diagonal: si abajo está ocupado pero abajo a un costado y al costado hay aire, baja en diagonal.
//   4. Escurre: busca por su fila, hasta REACH[m] celdas de aire hacia cada lado, la caída más cercana
//      (una celda con aire abajo) y avanza hacia ella hasta SPEED[m] celdas. Sin caída a la vista, se
//      queda: por eso el sistema siempre se asienta (cada movimiento acerca la celda a una caída y cada
//      caída la baja) y la superficie queda plana a menos de una celda en tramos de REACH.
//   Los costados del mapa son paredes para el líquido.
// El lado que se prueba primero alterna con (x + y + iteración) para que no se vaya todo para un lado.
// Una celda que llegó en esta iteración no se vuelve a mover hasta la siguiente.
//
// Zona activa: solo se procesan las celdas encoladas (las que se movieron y sus vecinos que pueden
// moverse por eso). Una celda que no cambió no se vuelve a encolar: cuando la cola queda vacía, se
// asentó. Las semillas iniciales son las celdas de líquido de un rectángulo (o de todo el mapa) que
// tocan aire, el otro líquido o algo inflamable.
//
// Volumen: moverse lo conserva; las reacciones y el abismo solo lo bajan. Nada lo sube.
import { LIQUID, type Rect } from './terrain'
import { AIR, FLOW_FRAME_ITERS, FLOW_MAX_ITERS, LAVA, MATERIALS, STONE, WATER, type Terrain, type TerrainPatch } from './types'

// Celdas que cae, alcance de la búsqueda de caída y celdas que avanza de costado, por iteración.
// La lava es espesa: cae y corre más lento y deja la superficie menos pareja.
const FALL = new Uint8Array(256)
const REACH = new Uint8Array(256)
const SPEED = new Uint8Array(256)
FALL[WATER] = 3
REACH[WATER] = 48
SPEED[WATER] = 3
FALL[LAVA] = 2
REACH[LAVA] = 20
SPEED[LAVA] = 1
const MAX_REACH = 48

const FLAMMABLE = new Uint8Array(256)
for (const m of MATERIALS) if (m.flammable) FLAMMABLE[m.id] = 1

// Si no se asentó en FLOW_MAX_ITERS iteraciones animadas, sigue hasta FLOW_EXTRA_ITERS más sin
// animar (van todas al último parche) para que no quede líquido colgando en el aire; si ni así se
// asentó, lo que falte sigue en el próximo flujo (el de fire siembra desde todo el mapa).
export const FLOW_EXTRA_ITERS = 2 * FLOW_MAX_ITERS

export interface FlowOptions {
  // dónde buscar líquido que se pueda mover; null = todo el mapa
  seed: Rect | null
  // armar los parches para animar (fire); la IA no los necesita
  record: boolean
  // tope de iteraciones animadas (por defecto FLOW_MAX_ITERS)
  maxIters?: number
  // tope de iteraciones extra sin animar (por defecto FLOW_EXTRA_ITERS)
  extraIters?: number
}

// Vapor o quema acumulados en un cuadro (frame = índice del parche en que se ven, desde 1).
export interface FlowSteam {
  x: number
  y: number
  n: number // celdas de piedra que se formaron
  frame: number
}
export interface FlowBurn {
  x: number // franja [x, x + w)
  y: number
  w: number
  frame: number
}

export interface FlowReport {
  iters: number // iteraciones corridas
  settled: boolean // la cola quedó vacía
  changed: boolean // cambió alguna celda
  // record: parches[0] es el estado previo al flujo (después de los impactos) del rectángulo total que
  // cambia; después uno cada FLOW_FRAME_ITERS iteraciones con el rectángulo que cambió desde el anterior.
  // Aplicarlos en orden deja exactamente la grilla final. back nunca cambia (va igual en los parches).
  patches: TerrainPatch[]
  steam: FlowSteam[]
  burns: FlowBurn[]
  lost: { water: number; lava: number } // celdas que cayeron por un abismo
  touched: Rect | null // rectángulo total que cambió
  moves: number // celdas movidas (para medir)
}

// ---------- buffers reusados ----------
// Sellos por celda (un número de generación en vez de limpiar arreglos de megas en cada llamada).
let queued = new Uint32Array(0) // ya está en la cola de la iteración siguiente
let arrived = new Uint32Array(0) // llegó en esta iteración
let touchedAt = new Uint32Array(0) // ya cambió en esta llamada (para guardar su valor original)
let gen = 0

function ensure(n: number): void {
  if (queued.length >= n) return
  queued = new Uint32Array(n)
  arrived = new Uint32Array(n)
  touchedAt = new Uint32Array(n)
  gen = 0
}

function nextGen(): number {
  gen++
  if (gen === 0xffffffff) {
    queued.fill(0)
    arrived.fill(0)
    touchedAt.fill(0)
    gen = 1
  }
  return gen
}

class IntList {
  a = new Int32Array(1024)
  n = 0
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = v
  }
}

let listA = new IntList()
let listB = new IntList()
let sorted = new Int32Array(1024)
let rowCount = new Int32Array(0)

export function flowLiquids(t: Terrain, opts: FlowOptions): FlowReport {
  const { w, h, front } = t
  const pits = t.pits
  ensure(w * h)
  if (rowCount.length < h + 1) rowCount = new Int32Array(h + 1)
  const maxIters = opts.maxIters ?? FLOW_MAX_ITERS
  const extra = opts.extraIters ?? FLOW_EXTRA_ITERS
  const record = opts.record
  const report: FlowReport = {
    iters: 0,
    settled: true,
    changed: false,
    patches: [],
    steam: [],
    burns: [],
    lost: { water: 0, lava: 0 },
    touched: null,
    moves: 0,
  }

  // sello de esta llamada: touchedAt === callGen = la celda ya cambió (y su original está guardado)
  const callGen = nextGen()
  const origIdx: number[] = []
  const origVal: number[] = []
  // rectángulo total y el de la ventana del parche actual
  let tx0 = w
  let ty0 = h
  let tx1 = -1
  let ty1 = -1
  let wx0 = w
  let wy0 = h
  let wx1 = -1
  let wy1 = -1
  // vapor y quema de la ventana actual
  let sx = 0
  let sy = 0
  let sn = 0
  let bx0 = w
  let bx1 = -1
  let by = 0
  let bn = 0

  const set = (i: number, m: number) => {
    if (touchedAt[i] !== callGen) {
      touchedAt[i] = callGen
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

  let cur = listA
  let next = listB
  cur.n = 0
  next.n = 0
  let qGen = nextGen() // sello de la cola en armado
  let iterStamp = 0
  const enqueue = (i: number) => {
    if (queued[i] === qGen) return
    queued[i] = qGen
    next.push(i)
  }
  // encola los líquidos alrededor de una celda que quedó libre (los que pueden caer o escurrir ahí)
  const wake = (x: number, y: number) => {
    for (let dy = -1; dy <= 0; dy++) {
      const yy = y + dy
      if (yy < 0) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue
        const k = yy * w + xx
        if (LIQUID[front[k]]) enqueue(k)
      }
    }
    // por la misma fila: la celda libre puede destapar el camino de un líquido que estaba buscando
    // una caída más allá (a menos de REACH)
    scanRow(x, y)
    // si arriba no hay líquido que caiga (techo o aire), la celda libre es una caída nueva para los
    // líquidos de la fila de arriba que estén a menos de REACH por esa fila (debajo de un saliente)
    if (y > 0 && !LIQUID[front[(y - 1) * w + x]]) scanRow(x, y - 1)
    // la fila de abajo también: un líquido vecino del otro tipo o al lado de un hueco nuevo
    if (y + 1 < h) {
      for (let dx = -1; dx <= 1; dx += 2) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const k = (y + 1) * w + xx
        if (LIQUID[front[k]]) enqueue(k)
      }
    }
  }
  // encola el primer líquido hacia cada lado de x por la fila y (yendo por aire), si x está a su alcance
  function scanRow(x: number, y: number): void {
    const row = y * w
    for (let s = -1; s <= 1; s += 2) {
      for (let d = 1, xx = x + s; d <= MAX_REACH && xx >= 0 && xx < w; d++, xx += s) {
        const q = front[row + xx]
        if (LIQUID[q]) {
          if (d <= REACH[q]) enqueue(row + xx)
          break
        }
        if (q !== AIR) break
      }
    }
  }

  // ---- semillas ----
  const sx0 = opts.seed ? Math.max(0, opts.seed.x0 - 1) : 0
  const sy0 = opts.seed ? Math.max(0, opts.seed.y0 - 1) : 0
  const sx1 = opts.seed ? Math.min(w - 1, opts.seed.x1 + 1) : w - 1
  const sy1 = opts.seed ? Math.min(h - 1, opts.seed.y1 + 1) : h - 1
  if (!opts.seed && front.byteOffset % 4 === 0) {
    // todo el mapa, de a 4 celdas: solo metal (8), roca madre (9), agua (10) y lava (11) tienen el
    // bit 3 prendido, así que una palabra sin ese bit en ningún byte no tiene líquido
    const words = new Uint32Array(front.buffer, front.byteOffset, front.length >> 2)
    for (let k = 0; k < words.length; k++) {
      if ((words[k] & 0x08080808) === 0) continue
      for (let i = k << 2, e = i + 4; i < e; i++) {
        const m = front[i]
        if (!LIQUID[m]) continue
        const x = i % w
        if (restless(t, x, (i - x) / w, m)) enqueue(i)
      }
    }
    for (let i = words.length << 2; i < front.length; i++) {
      const m = front[i]
      if (!LIQUID[m]) continue
      const x = i % w
      if (restless(t, x, (i - x) / w, m)) enqueue(i)
    }
  } else for (let y = sy0; y <= sy1; y++) {
    const row = y * w
    for (let x = sx0; x <= sx1; x++) {
      const i = row + x
      const m = front[i]
      if (!LIQUID[m]) continue
      if (restless(t, x, y, m)) enqueue(i)
    }
  }

  // ---- iteraciones ----
  let iter = 0
  const limit = maxIters + extra
  let frame = 0
  const flushWindow = () => {
    if (wx1 < 0) return
    frame++
    if (sn > 0) report.steam.push({ x: sx / sn, y: sy / sn, n: sn, frame })
    if (bn > 0) report.burns.push({ x: bx0, y: Math.round(by / bn), w: bx1 - bx0 + 1, frame })
    sx = sy = sn = 0
    bx0 = w
    bx1 = -1
    by = bn = 0
    if (wx0 < tx0) tx0 = wx0
    if (wx1 > tx1) tx1 = wx1
    if (wy0 < ty0) ty0 = wy0
    if (wy1 > ty1) ty1 = wy1
    if (record) report.patches.push(patchOf(t, wx0, wy0, wx1, wy1))
    wx0 = w
    wy0 = h
    wx1 = wy1 = -1
  }

  while (next.n > 0 && iter < limit) {
    // la cola armada pasa a ser la de esta iteración
    const tmp = cur
    cur = next
    next = tmp
    next.n = 0
    const aGen = qGen // sello único de esta iteración: marca las celdas que llegan en ella
    iterStamp = aGen
    qGen = nextGen()
    iter++
    // de abajo hacia arriba (orden por fila con conteo; dentro de la fila, el de la cola)
    const n = cur.n
    if (sorted.length < n) sorted = new Int32Array(Math.max(n, sorted.length * 2))
    rowCount.fill(0, 0, h + 1)
    const src = cur.a
    for (let k = 0; k < n; k++) rowCount[h - 1 - ((src[k] / w) | 0)]++
    for (let r = 0, acc = 0; r <= h; r++) {
      const c = rowCount[r]
      rowCount[r] = acc
      acc += c
    }
    for (let k = 0; k < n; k++) {
      const v = src[k]
      sorted[rowCount[h - 1 - ((v / w) | 0)]++] = v
    }

    for (let k = 0; k < n; k++) {
      const i = sorted[k]
      const m = front[i]
      if (!LIQUID[m] || arrived[i] === aGen) continue
      const x = i % w
      const y = (i - x) / w

      // 1. reacciones
      const other = m === WATER ? LAVA : WATER
      let reacted = false
      for (let d = 0; d < 4; d++) {
        const xx = d === 0 ? x - 1 : d === 1 ? x + 1 : x
        const yy = d === 2 ? y - 1 : d === 3 ? y + 1 : y
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue
        const j = yy * w + xx
        const q = front[j]
        if (q === other) {
          // la lava se vuelve piedra; el agua se evapora
          const lavaCell = m === LAVA ? i : j
          const waterCell = m === LAVA ? j : i
          set(lavaCell, STONE)
          if (front[waterCell] === WATER) set(waterCell, AIR)
          const lx = lavaCell % w
          sx += lx
          sy += (lavaCell - lx) / w
          sn++
          wake(xx, yy)
          wake(x, y)
          reacted = true
          if (front[i] !== m) break
        } else if (m === LAVA && FLAMMABLE[q]) {
          set(j, AIR)
          if (xx < bx0) bx0 = xx
          if (xx > bx1) bx1 = xx
          by += yy
          bn++
          wake(xx, yy)
          enqueue(i)
          reacted = true
        }
      }
      if (reacted) {
        report.changed = true
        continue
      }

      // 2. cae
      if (y + 1 >= h) {
        if (pits && pits[x]) {
          set(i, AIR)
          if (m === WATER) report.lost.water++
          else report.lost.lava++
          wake(x, y)
          report.changed = true
        }
        continue
      }
      if (front[i + w] === AIR) {
        let ny = y + 1
        const fall = FALL[m]
        while (ny + 1 < h && ny - y < fall && front[(ny + 1) * w + x] === AIR) ny++
        move(i, ny * w + x, m, x, y)
        continue
      }
      const pref = (x + y + iter) & 1 ? 1 : -1
      // 3. diagonal
      let done = false
      for (let s = pref, tries = 0; tries < 2; tries++, s = -s) {
        const nx = x + s
        if (nx < 0 || nx >= w) continue
        if (front[y * w + nx] === AIR && front[(y + 1) * w + nx] === AIR) {
          move(i, (y + 1) * w + nx, m, x, y)
          done = true
          break
        }
      }
      if (done) continue
      // 4. escurre hacia la caída más cercana de su fila. Una celda de la superficie (aire arriba)
      // busca también a través del mismo líquido: así una meseta de líquido se nivela de una vez y no
      // de a una celda desde el borde (equivale a correr toda la fila un lugar).
      const reach = REACH[m]
      const top = y === 0 || front[i - w] === AIR
      let bestS = 0
      let bestD = reach + 1
      let bestThru = false
      for (let s = pref, tries = 0; tries < 2; tries++, s = -s) {
        let thru = false
        for (let d = 1; d <= reach && d < bestD; d++) {
          const nx = x + s * d
          if (nx < 0 || nx >= w) break
          const q = front[y * w + nx]
          if (q !== AIR) {
            if (top && q === m) {
              thru = true
              continue
            }
            break
          }
          const open = y + 1 >= h ? !!(pits && pits[nx]) : front[(y + 1) * w + nx] === AIR
          if (open) {
            bestS = s
            bestD = d
            bestThru = thru
            break
          }
        }
      }
      if (bestS !== 0) {
        if (bestThru) {
          // a través del líquido: aparece directo en la caída; las de la superficie del camino se
          // despiertan para seguir nivelando en la próxima iteración
          const nx = x + bestS * bestD
          move(i, y + 1 < h ? (y + 1) * w + nx : y * w + nx, m, x, y)
          for (let d = 1; d < bestD; d++) {
            const k = y * w + x + bestS * d
            if (front[k] === m && (y === 0 || front[k - w] === AIR)) enqueue(k)
          }
        } else {
          // si la caída está a su alcance en esta iteración, llega y cae una fila en el mismo paso
          const nx = x + bestS * Math.min(SPEED[m], bestD)
          move(i, bestD <= SPEED[m] && y + 1 < h ? (y + 1) * w + nx : y * w + nx, m, x, y)
        }
      }
    }

    // un parche cada FLOW_FRAME_ITERS iteraciones animadas; las extra van todas al último
    if (record && iter % FLOW_FRAME_ITERS === 0 && iter <= maxIters) flushWindow()
  }
  flushWindow()
  report.iters = iter
  report.settled = next.n === 0
  if (tx1 >= 0) {
    report.touched = { x0: tx0, y0: ty0, x1: tx1, y1: ty1 }
    report.changed = true
    if (record) {
      // parche 0: el rectángulo total como estaba antes del flujo
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
  } else report.changed = false
  return report

  function move(i: number, j: number, m: number, x: number, y: number): void {
    set(i, AIR)
    set(j, m)
    arrived[j] = iterStamp // no se vuelve a mover en esta iteración
    enqueue(j)
    wake(x, y)
    report.moves++
    report.changed = true
  }
}

// La celda de líquido (x, y) puede hacer algo: tiene aire abajo, al costado o en diagonal abajo, el
// otro líquido al lado o (lava) algo inflamable al lado.
function restless(t: Terrain, x: number, y: number, m: number): boolean {
  const { w, h, front } = t
  const other = m === WATER ? LAVA : WATER
  for (let dy = 0; dy <= 1; dy++) {
    const yy = y + dy
    if (yy >= h) {
      if (t.pits && t.pits[x]) return true
      continue
    }
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx
      if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue
      const q = front[yy * w + xx]
      if (q === AIR || q === other || (m === LAVA && FLAMMABLE[q])) return true
    }
  }
  if (y > 0) {
    const q = front[(y - 1) * w + x]
    if (q === other || (m === LAVA && FLAMMABLE[q])) return true
  }
  return false
}

export function patchOf(t: Terrain, x0: number, y0: number, x1: number, y1: number): TerrainPatch {
  const pw = x1 - x0 + 1
  const ph = y1 - y0 + 1
  const front = new Uint8Array(pw * ph)
  const back = new Uint8Array(pw * ph)
  for (let y = 0; y < ph; y++) {
    const src = (y0 + y) * t.w + x0
    front.set(t.front.subarray(src, src + pw), y * pw)
    back.set(t.back.subarray(src, src + pw), y * pw)
  }
  return { x: x0, y: y0, w: pw, h: ph, front, back }
}

// Aplica un parche sobre la grilla (para sim-check y para quien quiera reproducir el flujo).
export function applyPatch(t: Terrain, p: TerrainPatch): void {
  for (let y = 0; y < p.h; y++) {
    const dst = (p.y + y) * t.w + p.x
    t.front.set(p.front.subarray(y * p.w, (y + 1) * p.w), dst)
    t.back.set(p.back.subarray(y * p.w, (y + 1) * p.w), dst)
  }
}

// Celdas de cada líquido en la grilla (para sim-check).
export function liquidVolume(t: Terrain): { water: number; lava: number } {
  let water = 0
  let lava = 0
  const f = t.front
  for (let i = 0; i < f.length; i++) {
    const m = f[i]
    if (m === WATER) water++
    else if (m === LAVA) lava++
  }
  return { water, lava }
}
