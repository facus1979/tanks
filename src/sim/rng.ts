export function hashSeed(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

export function nextRng(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) >>> 0
  const next = t
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return { value, state: next }
}

export function range(state: number, min: number, max: number): { value: number; state: number } {
  const roll = nextRng(state)
  return { value: min + roll.value * (max - min), state: roll.state }
}

export function irange(state: number, min: number, max: number): { value: number; state: number } {
  const roll = range(state, min, max + 1)
  return { value: Math.min(max, Math.floor(roll.value)), state: roll.state }
}

// Versión mutable para la generación y la IA. El estado se puede leer en `state`.
export class Rng {
  constructor(public state: number) {}
  next(): number {
    const r = nextRng(this.state)
    this.state = r.state
    return r.value
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }
  int(min: number, max: number): number {
    return Math.min(max, Math.floor(this.range(min, max + 1)))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
}

// Ruido por coordenada, sin estado: mismo (x, y, s) ⇒ mismo valor en [0, 1).
export function hash2(x: number, y: number, s = 0): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

export function noise1(x: number, scale: number, s: number): number {
  const t = x / scale
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return hash2(i, 0, s) * (1 - u) + hash2(i + 1, 0, s) * u
}
