// Minimapa del HUD (v2): el mundo entero a escala 1/10 arriba al centro, y las flechas en los bordes
// hacia los tanques vivos que quedan fuera de la vista. Referencia: scripts/lookdev/v2-bigmap.mjs.
import { AIR, BEDROCK, BRICK, DIRT, MATERIALS, METAL, STONE, type Terrain } from '../sim/types'
import { VIEW_H, VIEW_W } from '../render/types'
import { OUT, css, drawText, measure, type PixelFont } from './pixelfont'
import type { MinimapModel } from './types'

export const MM_SCALE = 10 // 1 px de minimapa = 10×10 de mundo
export const MM_TOP = 6 // y del mapa dentro del HUD (el marco ocupa 3 px alrededor)
export const MM_FRAME = 3
export const MM_TOUCH = 6 // margen táctil alrededor del minimapa, en px lógicos

// Agua y lava llegan en V4 como materiales de la grilla. Se buscan por nombre para no depender
// de un id que todavía no existe; si no están, quedan en -1 y nunca coinciden.
const WATER = MATERIALS.find((m) => m.name === 'agua')?.id ?? -1
const LAVA = MATERIALS.find((m) => m.name === 'lava')?.id ?? -1

const SKY_TOP = 0x1e2a30
const SKY_BOTTOM = 0x2e3e44
const EDGE = 0xd8c8a0 // borde superior del terreno, más claro
const COLORS: Record<number, number> = {
  [DIRT]: 0x6a4e36,
  [STONE]: 0x8a8169,
  [BRICK]: 0x9a5038,
  [METAL]: 0x7a8088,
  [BEDROCK]: 0x3a3430,
}
const WATER_COLOR = 0x4a9ac8
const LAVA_COLOR = 0xff7a2a
const LAVA_SURFACE = 0xffc46a // fila de arriba de la lava de muerte súbita, más clara
const WOODISH = 0x8a6a40 // madera, tabla, viga, poste y cualquier material sin color propio
const PROJECTILE = 0xfff1a8
const FULL = 35 // de 100 pixels de una celda, cuántos sólidos hacen falta para pintarla

export interface MinimapLayout {
  x: number // esquina del mapa (sin marco) en la pantalla lógica
  y: number
  w: number
  h: number
  worldW: number
  worldH: number
}

export function minimapLayout(terrain: Terrain): MinimapLayout {
  const w = Math.ceil(terrain.w / MM_SCALE)
  const h = Math.ceil(terrain.h / MM_SCALE)
  return { x: Math.round((VIEW_W - w) / 2), y: MM_TOP, w, h, worldW: terrain.w, worldH: terrain.h }
}

// Reducción del terreno a una imagen de w/10 × h/10: material dominante por celda. Cacheada por
// grilla y versión; solo se rehace cuando cambia terrainVersion (o llega otra grilla).
export class MinimapTerrain {
  private canvas: HTMLCanvasElement | null = null
  private terrain: Terrain | null = null
  private version = Number.NaN

  image(terrain: Terrain, version: number): HTMLCanvasElement | null {
    if (this.canvas && this.terrain === terrain && this.version === version) return this.canvas
    this.terrain = terrain
    this.version = version
    this.canvas = reduce(terrain, this.canvas)
    return this.canvas
  }
}

function reduce(t: Terrain, reuse: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const cols = Math.ceil(t.w / MM_SCALE)
  const rows = Math.ceil(t.h / MM_SCALE)
  const NM = 32
  const counts = new Uint16Array(cols * rows * NM)
  const front = t.front
  for (let y = 0; y < t.h; y++) {
    const rowBase = Math.floor(y / MM_SCALE) * cols
    const line = y * t.w
    for (let x = 0; x < t.w; x++) {
      const m = front[line + x]
      if (m === AIR) continue
      counts[(rowBase + Math.floor(x / MM_SCALE)) * NM + (m < NM ? m : NM - 1)]++
    }
  }
  const total = new Uint16Array(cols * rows)
  const best = new Int16Array(cols * rows)
  for (let c = 0; c < cols * rows; c++) {
    let sum = 0
    let bm = AIR
    let bn = 0
    for (let m = 1; m < NM; m++) {
      const n = counts[c * NM + m]
      sum += n
      if (n > bn) {
        bn = n
        bm = m
      }
    }
    total[c] = sum
    best[c] = bm
  }
  const canvas = reuse ?? document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(cols, rows)
  const px = img.data
  for (let my = 0; my < rows; my++) {
    const sky = mix(SKY_TOP, SKY_BOTTOM, my / rows)
    for (let mx = 0; mx < cols; mx++) {
      const c = my * cols + mx
      let color = sky
      if (total[c] >= FULL) {
        const m = best[c]
        const liquid = m === WATER || m === LAVA
        color = m === WATER ? WATER_COLOR : m === LAVA ? LAVA_COLOR : (COLORS[m] ?? WOODISH)
        if (!liquid && my > 0 && total[c - cols] < FULL) color = mix(color, EDGE, 0.45)
      }
      const i = c * 4
      px[i] = (color >> 16) & 255
      px[i + 1] = (color >> 8) & 255
      px[i + 2] = color & 255
      px[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

// Dibuja marco, terreno, viewport, impactos, proyectiles y tanques. blink: fase del titileo del turno.
export function drawMinimap(ctx: CanvasRenderingContext2D, L: MinimapLayout, model: MinimapModel, terrain: HTMLCanvasElement | null, blink: boolean): void {
  const { x: ox, y: oy, w, h } = L
  rect(ctx, ox - 3, oy - 3, w + 6, h + 6, OUT)
  rect(ctx, ox - 2, oy - 2, w + 4, h + 4, 0x6a5a48)
  rect(ctx, ox - 1, oy - 1, w + 2, h + 2, OUT)
  if (terrain) ctx.drawImage(terrain, ox, oy)
  else rect(ctx, ox, oy, w, h, SKY_TOP)

  // lava de muerte súbita: banda de ancho completo desde su superficie hasta el fondo, por encima de la
  // silueta del terreno y por debajo del viewport, los impactos y los tanques
  if (model.lava != null && Number.isFinite(model.lava)) {
    const ly = clamp(oy + Math.round(model.lava / MM_SCALE), oy, oy + h)
    if (ly < oy + h) {
      rect(ctx, ox, ly, w, oy + h - ly, LAVA_COLOR)
      rect(ctx, ox, ly, w, 1, LAVA_SURFACE)
    }
  }

  // viewport: rectángulo blanco con un velo leve adentro
  const v = model.view
  const vx0 = clamp(ox + Math.round(v.x / MM_SCALE), ox - 1, ox + w)
  const vx1 = clamp(ox + Math.round((v.x + v.w) / MM_SCALE) - 1, ox - 1, ox + w)
  const vy0 = clamp(oy + Math.round(v.y / MM_SCALE) - 1, oy - 1, oy + h)
  const vy1 = clamp(oy + Math.round((v.y + v.h) / MM_SCALE), oy - 1, oy + h)
  if (vx1 > vx0 && vy1 > vy0) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(vx0 + 1, vy0 + 1, vx1 - vx0 - 1, vy1 - vy0 - 1)
    rect(ctx, vx0, vy0, vx1 - vx0 + 1, 1, 0xffffff)
    rect(ctx, vx0, vy1, vx1 - vx0 + 1, 1, 0xffffff)
    rect(ctx, vx0, vy0, 1, vy1 - vy0 + 1, 0xffffff)
    rect(ctx, vx1, vy0, 1, vy1 - vy0 + 1, 0xffffff)
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(ox - 1, oy - 1, w + 2, h + 2)
  ctx.clip()
  const at = (wx: number, wy: number): [number, number] => [ox + Math.round(wx / MM_SCALE), oy + Math.round(wy / MM_SCALE)]
  // último impacto de cada jugador: cruz de su color
  for (const imp of model.lastImpacts) {
    const [ix, iy] = at(imp.x, imp.y)
    for (const [dx, dy] of [[-1, -1], [1, 1], [-1, 1], [1, -1], [0, 0]]) rect(ctx, ix + dx, iy + dy, 1, 1, imp.color)
  }
  // proyectiles en vuelo
  for (const p of model.projectiles) {
    const [px, py] = at(p.x, p.y)
    rect(ctx, px, py, 1, 1, PROJECTILE)
  }
  // tanques: los muertos primero (×), el del turno al final para que quede arriba
  const tanks = [...model.tanks].sort((a, b) => Number(a.alive) - Number(b.alive) || Number(a.current) - Number(b.current))
  for (const t of tanks) {
    const [cx, gy] = at(t.x, t.y)
    const tx = clamp(cx, ox + 2, ox + w - 3)
    if (!t.alive) {
      const ty = clamp(gy - 2, oy + 1, oy + h - 2)
      for (const [dx, dy] of [[-1, -1], [1, 1], [-1, 1], [1, -1], [0, 0]]) {
        rect(ctx, tx + dx, ty + dy + 1, 1, 1, OUT)
        rect(ctx, tx + dx, ty + dy, 1, 1, mix(t.color, 0x9a8e80, 0.35))
      }
      continue
    }
    const ty = clamp(gy - 2, oy + 1, oy + h - 3)
    rect(ctx, tx - 2, ty - 1, 5, 4, t.current && blink ? 0xffffff : OUT)
    rect(ctx, tx - 1, ty, 3, 2, t.color)
  }
  ctx.restore()
}

export interface ArrowLimits {
  leftTop: number // y mínima del centro de las flechas de cada lado (debajo de los paneles de arriba)
  rightTop: number
  bottom: number
}

// Flechas en los bordes izquierdo y derecho hacia los tanques vivos fuera de la vista, a la altura del
// tanque mapeada a pantalla, con la etiqueta Pn (n = id + 1).
export function drawEdgeArrows(ctx: CanvasRenderingContext2D, font: PixelFont, model: MinimapModel, lim: ArrowLimits): void {
  const v = model.view
  const sy = VIEW_H / Math.max(1, v.h)
  const sides: { side: -1 | 1; list: { y: number; color: number; label: string }[] }[] = [
    { side: -1, list: [] },
    { side: 1, list: [] },
  ]
  for (const t of model.tanks) {
    if (!t.alive) continue
    const side = t.x < v.x ? 0 : t.x > v.x + v.w ? 1 : -1
    if (side < 0) continue
    sides[side].list.push({ y: (t.y - 16 - v.y) * sy, color: t.color, label: `P${t.id + 1}` })
  }
  const gap = Math.max(14, font.h + 8)
  for (const { side, list } of sides) {
    if (!list.length) continue
    const top = side < 0 ? lim.leftTop : lim.rightTop
    list.sort((a, b) => a.y - b.y)
    // separa las que se pisan; si se pasan del fondo, las corre hacia arriba
    let prev = -Infinity
    for (const a of list) {
      a.y = Math.round(clamp(Math.max(a.y, prev + gap), top, lim.bottom))
      prev = a.y
    }
    for (let i = list.length - 2; i >= 0; i--) list[i].y = Math.min(list[i].y, list[i + 1].y - gap)
    for (const a of list) {
      const x = side < 0 ? 3 : VIEW_W - 4
      for (let k = 0; k <= 6; k++) {
        const cx = x - side * k
        if (k === 6) {
          rect(ctx, cx, a.y - k, 1, 2 * k + 1, OUT)
          continue
        }
        rect(ctx, cx, a.y - k, 1, 2 * k + 1, a.color)
        rect(ctx, cx, a.y - k, 1, 1, OUT)
        rect(ctx, cx, a.y + k, 1, 1, OUT)
      }
      const lw = measure(font, a.label)
      const lx = side < 0 ? x + 9 : x - 9 - lw
      drawText(ctx, font, a.label, lx, a.y - Math.floor(font.h / 2), 0xffffff)
    }
  }
}

// Punto de la pantalla lógica → mundo, si cae sobre el minimapa o su margen táctil.
export function minimapPoint(L: MinimapLayout, lx: number, ly: number): { x: number; y: number } | null {
  if (lx < L.x - MM_TOUCH || lx > L.x + L.w + MM_TOUCH || ly < L.y - MM_TOUCH || ly > L.y + L.h + MM_TOUCH) return null
  return {
    x: clamp((lx - L.x) * MM_SCALE, 0, L.worldW),
    y: clamp((ly - L.y) * MM_SCALE, 0, L.worldH),
  }
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.fillStyle = css(c)
  ctx.fillRect(x, y, w, h)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}
