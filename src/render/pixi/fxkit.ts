// v3 (render-armas): primitivas del sistema de partículas de Fx que usan los efectos de las armas e ítems
// nuevos (weapons-fx.ts, items-fx.ts, hazards.ts). Es el único gancho hacia los internos de fx.ts: si
// render-perf cambia cómo se guardan las partículas, alcanza con adaptar Fx.kit, no los efectos.
// Todo lo que se emite por acá entra en el mismo tope (MAX_PARTICLES) y en los mismos buffers que las
// explosiones de siempre: no suma buffers ni subidas de textura.

// Capas de las bolas: 0 humo, 1 fuego, 2 núcleo, 3 bocanadas, 4 destello (encima de todo).
export type KitLayer = 0 | 1 | 2 | 3 | 4

// Bola con rampa de color (fuego, humo, ácido...): ver Blob en fx.ts. ox/oy origen; dx/dy corrimiento que
// recorre con easeOut en `grow` segundos; vx/vy/ax/ay movimiento; r0→r1 radio; heat0 + heatV·t elige el
// color de la rampa (0 = el primero, 1 = el último); hold: segundos antes de achicarse (o desvanecerse si fade).
export interface KitBlob {
  layer: KitLayer
  ox: number
  oy: number
  r1: number
  life: number
  ramp: number[]
  outline: number
  dx?: number
  dy?: number
  vx?: number
  vy?: number
  ax?: number
  ay?: number
  r0?: number
  grow?: number
  hold?: number
  delay?: number
  heat0?: number
  heatV?: number
  cool?: number
  fade?: boolean
}

// Bocanada suave con alfa (polvo, vapor, humo tóxico): ver Soft en fx.ts.
export interface KitSoft {
  x0: number
  y0: number
  r0: number
  r1: number
  life: number
  inner: number
  edge: number
  a0: number
  vx?: number
  vy?: number
  ax?: number
  drag?: number
  keep?: number
  top?: boolean
  puff?: number
}

export interface FxKit {
  blob(b: KitBlob): void
  soft(s: KitSoft): void
  // chispa blanca-amarilla con estela (la de siempre)
  spark(x: number, y: number, vx: number, vy: number, life: number): void
  // escombro de un color que rebota en el terreno (shape 0..3: 1 a 5 pixels)
  debris(x: number, y: number, vx: number, vy: number, color: number, shape: number, life: number): void
  // luz aditiva en el buffer de luces (se apaga sola)
  light(x: number, y: number, R: number, tint: number, k: number, life: number): void
  // bola de fuego con columna de humo (la explosión base); s ~ radio/15, L alarga los tiempos
  fireball(x: number, y: number, s: number, L: number, debris: Partial<Record<number, number>>, amount: number, mini?: boolean): void
  // aplica el tope de partículas (llamarlo después de emitir mucho junto)
  cap(): void
}
