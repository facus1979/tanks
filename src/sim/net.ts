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
  return mixValue(h, rest)
}

// Formato: u32 largo del JSON | JSON (todo menos las grillas) | front | back.
export function encodeState(state: GameState): Uint8Array {
  const { terrain, ...rest } = state
  const head = new TextEncoder().encode(JSON.stringify({ ...rest, tw: terrain.w, th: terrain.h }))
  const out = new Uint8Array(4 + head.length + terrain.front.length + terrain.back.length)
  new DataView(out.buffer).setUint32(0, head.length, true)
  out.set(head, 4)
  out.set(terrain.front, 4 + head.length)
  out.set(terrain.back, 4 + head.length + terrain.front.length)
  return out
}

export function decodeState(bytes: Uint8Array): GameState {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  const { tw, th, ...rest } = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)))
  const n = tw * th
  const at = 4 + len
  if (!(n > 0) || bytes.length !== at + 2 * n) throw new Error('snapshot inválido')
  // copias propias: alineadas y sin depender del buffer de entrada
  const front = bytes.slice(at, at + n)
  const back = bytes.slice(at + n, at + 2 * n)
  return { ...rest, terrain: { w: tw, h: th, front, back } } as GameState
}
