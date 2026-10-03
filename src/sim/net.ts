// Soporte de red: hash del estado (detectar desincronización) y serialización (snapshots).
import type { GameState } from './types'

const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)

// FNV-1a de 32 bits sobre palabras; las grillas van de a 4 bytes cuando están alineadas.
function mixWord(h: number, w: number): number {
  return Math.imul(h ^ w, 0x01000193) >>> 0
}

function mixNumber(h: number, n: number): number {
  f64[0] = n + 0 // normaliza -0
  return mixWord(mixWord(h, u32[0]), u32[1])
}

function mixString(h: number, s: string): number {
  h = mixWord(h, s.length)
  for (let i = 0; i < s.length; i++) h = mixWord(h, s.charCodeAt(i))
  return h
}

function mixBytes(h: number, a: Uint8Array): number {
  h = mixWord(h, a.length)
  let i = 0
  if (a.byteOffset % 4 === 0) {
    const words = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2)
    for (; i < words.length; i++) h = mixWord(h, words[i])
    i <<= 2
  }
  for (; i < a.length; i++) h = mixWord(h, a[i])
  return h
}

// Recorre el valor con las claves ordenadas: no depende del orden de inserción.
function mixValue(h: number, v: unknown): number {
  if (v === null || v === undefined) return mixWord(h, 0x11)
  switch (typeof v) {
    case 'number':
      return mixNumber(mixWord(h, 0x22), v)
    case 'boolean':
      return mixWord(h, v ? 0x33 : 0x34)
    case 'string':
      return mixString(mixWord(h, 0x44), v)
  }
  if (Array.isArray(v)) {
    h = mixWord(mixWord(h, 0x55), v.length)
    for (const x of v) h = mixValue(h, x)
    return h
  }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  h = mixWord(mixWord(h, 0x66), keys.length)
  for (const k of keys) h = mixValue(mixString(h, k), o[k])
  return h
}

export function hashState(state: GameState): number {
  const { terrain, ...rest } = state
  let h = 0x811c9dc5
  h = mixWord(mixWord(h, terrain.w), terrain.h)
  h = mixBytes(h, terrain.front)
  h = mixBytes(h, terrain.back)
  // v3: columnas de abismo. Sin pits (mapa Chico) el hash queda igual que antes.
  if (terrain.pits) h = mixBytes(mixWord(h, 0x77), terrain.pits)
  return mixValue(h, rest)
}

// ---------- snapshot ----------
//
// Formato v2 (v2.3, comprimido):
//   'T' 'K' | versión (u8 = 2) | largo del JSON (varint) | JSON (todo menos las grillas, con tw, th y
//   tp = 1 si hay pits) | front RLE | back RLE | pits RLE (solo si tp = 1)
// Cada grilla va por filas (y * w + x, como en memoria) en corridas: valor (u8) | largo (varint ≥ 1);
// las corridas siguen de una fila a la otra y suman exactamente w·h (pits: w). El terreno es casi
// todo franjas horizontales (cielo, capas de material, agua y lava con superficie plana), así que
// por filas da menos corridas que por columnas: ~3000–4000 por grilla en Grande a mitad de partida.
// varint: LEB128 sin signo (7 bits por byte, el bit alto = sigue).
//
// Formato v1 (hasta v2.2, crudo): u32 LE largo del JSON | JSON | front | back | pits. decodeState lo
// sigue aceptando: un v1 nunca empieza con 'T' 'K' 2 porque ese u32 daría un JSON de ~150 KB.
// El hash no depende del formato: hashState mira el estado, no los bytes.

export const SNAPSHOT_VERSION = 2
const MAGIC0 = 0x54 // 'T'
const MAGIC1 = 0x4b // 'K'

// Buffer de salida que crece de a duplicaciones.
class Writer {
  buf: Uint8Array
  pos = 0
  constructor(cap: number) {
    this.buf = new Uint8Array(cap)
  }
  private need(n: number): void {
    if (this.pos + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.pos + n) cap *= 2
    const b = new Uint8Array(cap)
    b.set(this.buf.subarray(0, this.pos))
    this.buf = b
  }
  byte(v: number): void {
    this.need(1)
    this.buf[this.pos++] = v
  }
  varint(v: number): void {
    this.need(5)
    while (v >= 0x80) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    this.buf[this.pos++] = v
  }
  bytes(a: Uint8Array): void {
    this.need(a.length)
    this.buf.set(a, this.pos)
    this.pos += a.length
  }
  // Corridas de la grilla entera. Reserva el peor caso de una vez (valor + varint de 5 por corrida
  // sería 6·n, pero una corrida de largo < 128 ocupa 2 bytes y una más larga cubre ≥ 128 celdas:
  // 2·n alcanza siempre) para que el lazo no tenga chequeos de capacidad.
  rle(a: Uint8Array): void {
    const n = a.length
    if (n === 0) return
    this.need(2 * n + 8)
    const buf = this.buf
    let pos = this.pos
    let i = 0
    while (i < n) {
      const v = a[i]
      let j = i + 1
      while (j < n && a[j] === v) j++
      buf[pos++] = v
      let len = j - i
      while (len >= 0x80) {
        buf[pos++] = (len & 0x7f) | 0x80
        len >>>= 7
      }
      buf[pos++] = len
      i = j
    }
    this.pos = pos
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

class Reader {
  pos: number
  constructor(
    private buf: Uint8Array,
    pos = 0,
  ) {
    this.pos = pos
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('snapshot inválido')
    return this.buf[this.pos++]
  }
  varint(): number {
    let v = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      v += (b & 0x7f) * 2 ** shift
      if (b < 0x80) return v
      shift += 7
      if (shift > 28) throw new Error('snapshot inválido')
    }
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('snapshot inválido')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  // Grilla de n celdas desde corridas; el total tiene que dar justo n.
  rle(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let i = 0
    while (i < n) {
      const v = this.byte()
      const len = this.varint()
      if (len < 1 || i + len > n) throw new Error('snapshot inválido')
      if (v !== 0) out.fill(v, i, i + len) // la grilla nueva ya está en 0 (aire)
      i += len
    }
    return out
  }
}

export function encodeState(state: GameState): Uint8Array {
  const { terrain, ...rest } = state
  const pits = terrain.pits
  const head = new TextEncoder().encode(JSON.stringify({ ...rest, tw: terrain.w, th: terrain.h, ...(pits ? { tp: 1 } : {}) }))
  const w = new Writer(head.length + 64 * 1024)
  w.byte(MAGIC0)
  w.byte(MAGIC1)
  w.byte(SNAPSHOT_VERSION)
  w.varint(head.length)
  w.bytes(head)
  w.rle(terrain.front)
  w.rle(terrain.back)
  if (pits) w.rle(pits)
  return w.done()
}

export function decodeState(bytes: Uint8Array): GameState {
  // Sin 'T' 'K' 2 al principio se lee como v1 (que valida largos y tira error si es basura).
  if (bytes.length >= 3 && bytes[0] === MAGIC0 && bytes[1] === MAGIC1 && bytes[2] === SNAPSHOT_VERSION) return decodeV2(bytes)
  return decodeV1(bytes)
}

function decodeV2(bytes: Uint8Array): GameState {
  const r = new Reader(bytes, 3)
  const len = r.varint()
  const { tw, th, tp, ...rest } = JSON.parse(new TextDecoder().decode(r.bytes(len)))
  const n = tw * th
  if (!(n > 0) || !Number.isInteger(n)) throw new Error('snapshot inválido')
  const front = r.rle(n)
  const back = r.rle(n)
  const terrain: GameState['terrain'] = { w: tw, h: th, front, back }
  if (tp === 1) terrain.pits = r.rle(tw)
  if (r.pos !== bytes.length) throw new Error('snapshot inválido')
  return { ...rest, terrain } as GameState
}

// v1 (crudo): u32 largo del JSON | JSON | front | back | pits (w bytes, solo si tp = 1).
function decodeV1(bytes: Uint8Array): GameState {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  const { tw, th, tp, ...rest } = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)))
  const n = tw * th
  const at = 4 + len
  const np = tp === 1 ? tw : 0
  if (!(n > 0) || bytes.length !== at + 2 * n + np) throw new Error('snapshot inválido')
  // copias propias: alineadas y sin depender del buffer de entrada
  const front = bytes.slice(at, at + n)
  const back = bytes.slice(at + n, at + 2 * n)
  const terrain: GameState['terrain'] = { w: tw, h: th, front, back }
  if (np > 0) terrain.pits = bytes.slice(at + 2 * n, at + 2 * n + np)
  return { ...rest, terrain } as GameState
}
