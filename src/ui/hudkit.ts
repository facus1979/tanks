// Piezas de dibujo del HUD C (tablero Broforce): marcos, números grandes, barras por segmentos, dial de
// ángulo, chevrons de viento y botones táctiles de 22×22. Son las mismas piezas de la maqueta aprobada
// (scripts/lookdev/hud-proposals.mjs, propuesta C), pasadas a canvas 2D en coordenadas lógicas enteras.
import { OUT, clean, css, drawText, glyphFor, measure, type PixelFont } from './pixelfont'

export const DARK = 0x0e0a09
export const BRONZE = 0xc4a574
export const BRONZE_D = 0x7a6244 // remaches y biseles
export const GOLD = 0xffe27a
export const GREY = 0x9a8e80
export const SLOT_BG = 0x2a2220
export const INK = 0x1c1614
export const WHITE = 0xffffff
export const POW_LO = 0xe05a1c
export const POW_MID = 0xffa23a
export const FUEL = 0x3a9a3a
export const FUEL_HI = 0x9ae06a
export const FUEL_LOW = 0xd0362c
export const SHIELD = 0x2a5aa0
export const SHIELD_HI = 0x7ab8ff
export const WIND_SOFT = 0xbfe8ff
export const DEAD = 0x4a4440

// Lado de los botones táctiles: 22 lógicos = 44 px CSS con la escala típica ×2.
export const BTN = 22

export function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.fillStyle = css(c)
  ctx.fillRect(x, y, w, h)
}

export function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export function mul(c: number, k: number): number {
  const ch = (s: number) => Math.min(255, Math.round(((c >> s) & 255) * k))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// Marco del HUD: contorno, borde de color, fondo oscuro y la línea de bisel de arriba.
export function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, edge = BRONZE, fill = DARK): void {
  rect(ctx, x, y, w, h, OUT)
  rect(ctx, x + 1, y + 1, w - 2, h - 2, edge)
  rect(ctx, x + 2, y + 2, w - 4, h - 4, fill)
  rect(ctx, x + 2, y + 2, w - 4, 1, mix(fill, WHITE, 0.08))
}

// Separador vertical del tablero: canal oscuro de 2 px y filo de bronce.
export function divider(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  rect(ctx, x, y, 2, h, OUT)
  rect(ctx, x + 2, y, 1, h, BRONZE_D)
}

// Ancho de un texto ampliado ×sc (sin el contorno).
export function measureBig(font: PixelFont, str: string, sc: number): number {
  let w = 0
  for (const ch of clean(str)) {
    const g = glyphFor(font, ch) ?? glyphFor(font, '?')
    if (g) w += g.w + 1
  }
  return Math.max(0, w - 1) * sc
}

// Número grande: la fuente ampliada ×sc, contorno de 1 px, sombra abajo y la mitad de abajo un tono más
// oscura (el "metal" de las cifras de Broforce). Devuelve el ancho.
export function bigText(ctx: CanvasRenderingContext2D, font: PixelFont, str: string, x: number, y: number, color: number, sc: number): number {
  const cells: [number, number][] = []
  let cx = 0
  for (const ch of clean(str)) {
    const g = glyphFor(font, ch) ?? glyphFor(font, '?')
    if (!g) continue
    for (let gy = 0; gy < font.h; gy++) for (let gx = 0; gx < g.w; gx++) if (g.bits[gy * g.w + gx]) cells.push([cx + gx, gy])
    cx += g.w + 1
  }
  const low = Math.ceil(font.h * 0.6) // desde esta fila del glifo, el tono oscuro
  ctx.fillStyle = css(OUT)
  for (const [gx, gy] of cells) ctx.fillRect(x + gx * sc - 1, y + gy * sc - 1, sc + 2, sc + 3)
  const hi = css(color)
  const lo = css(mul(color, 0.82))
  for (const [gx, gy] of cells) {
    ctx.fillStyle = gy >= low ? lo : hi
    ctx.fillRect(x + gx * sc, y + gy * sc, sc, sc)
  }
  return Math.max(0, cx - 1) * sc
}

// Barra horizontal por segmentos (potencia, combustible, escudo). colors: [cuerpo, mitad de arriba, brillo].
export function segBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  v: number,
  [c0, c1, c2]: [number, number, number],
  segs = 0,
): void {
  rect(ctx, x, y, w, h, OUT)
  rect(ctx, x + 1, y + 1, w - 2, h - 2, SLOT_BG)
  const fill = Math.round((w - 2) * Math.max(0, Math.min(1, v)))
  if (fill > 0) {
    rect(ctx, x + 1, y + 1, fill, h - 2, c0)
    rect(ctx, x + 1, y + 1, fill, Math.max(1, Math.floor((h - 2) / 2)), c1)
    rect(ctx, x + 1, y + 1, fill, 1, c2)
  }
  for (let k = 1; k < segs; k++) rect(ctx, x + 1 + Math.round(((w - 2) * k) / segs), y + 1, 1, h - 2, OUT)
}

// Línea gruesa con contorno (la aguja del dial).
function needle(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c: number): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2)
  for (const [col, r] of [[OUT, 2], [c, 1]] as const) {
    ctx.fillStyle = css(col)
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n
      const y = y0 + ((y1 - y0) * i) / n
      ctx.fillRect(Math.round(x - r + 0.5), Math.round(y - r + 0.5), r * 2 - 1, r * 2 - 1)
    }
  }
}

// Dial de ángulo: medio círculo 0..180 con marcas cada 15 (largas cada 45), la cuña recorrida y la aguja.
// (cx, cy) es el centro del eje, sobre la base del medio círculo.
export function dial(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, angle: number, dim: boolean): void {
  const wedge = mix(INK, GOLD, dim ? 0.08 : 0.16)
  for (let y = cy - R - 2; y <= cy + 1; y++) {
    for (let x = cx - R - 2; x <= cx + R + 2; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d > R + 1.5) continue
      const a = (Math.atan2(cy - y, x - cx) * 180) / Math.PI
      let c = d > R + 0.5 ? OUT : d > R - 1 ? BRONZE_D : INK
      if (d <= R - 1 && a >= 0 && a <= angle && d > 3) c = wedge
      rect(ctx, x, y, 1, 1, c)
    }
  }
  for (let a = 0; a <= 180; a += 15) {
    const r = (a * Math.PI) / 180
    const long = a % 45 === 0
    for (let k = long ? 5 : 3; k >= 1; k--) {
      rect(ctx, Math.round(cx + Math.cos(r) * (R - k)), Math.round(cy - Math.sin(r) * (R - k)), 1, 1, long ? BRONZE : GREY)
    }
  }
  const r = (Math.max(0, Math.min(180, angle)) * Math.PI) / 180
  needle(ctx, cx, cy, cx + Math.cos(r) * (R - 2), cy - Math.sin(r) * (R - 2), dim ? mix(GOLD, GREY, 0.5) : GOLD)
  rect(ctx, cx - 2, cy - 2, 5, 3, OUT)
  rect(ctx, cx - 1, cy - 1, 3, 2, GREY)
}

// Chevron de viento 8×9 (k = contorno, w = color). Apunta a la derecha; se espeja para la izquierda.
const CHEV = ['kkk.....', 'kwwk....', '.kwwk...', '..kwwk..', '...kwwk.', '..kwwk..', '.kwwk...', 'kwwk....', 'kkk.....']
export const windColor = (w: number): number => (Math.abs(w) > 6.6 ? 0xff6a3a : Math.abs(w) > 3.3 ? GOLD : WIND_SOFT)

// Tres chevrons ×sc: se prenden 1, 2 o 3 según la fuerza, en la punta de la dirección del viento.
// Devuelve el ancho total.
export function windChevrons(ctx: CanvasRenderingContext2D, x: number, y: number, wind: number, sc = 2): number {
  const n = wind === 0 ? 0 : Math.min(3, Math.ceil(Math.abs(wind) / 3.4))
  const dir = wind < 0 ? -1 : 1
  const step = 6 * sc
  for (let k = 0; k < 3; k++) {
    const lit = dir > 0 ? k >= 3 - n : k < n
    const pal: Record<string, number> = { k: lit ? OUT : 0x241c18, w: lit ? windColor(wind) : 0x3a3028 }
    CHEV.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const c = pal[row[dir > 0 ? rx : row.length - 1 - rx]]
        if (c != null) rect(ctx, x + k * step + rx * sc, y + ry * sc, sc, sc, c)
      }
    })
  }
  return 2 * step + 8 * sc
}

// Botón táctil cuadrado: marco, fondo y la tecla de escritorio en la esquina de arriba a la derecha.
export function button(
  ctx: CanvasRenderingContext2D,
  font: PixelFont,
  x: number,
  y: number,
  s: number,
  { on = true, sel = false, key = '' }: { on?: boolean; sel?: boolean; key?: string } = {},
): void {
  rect(ctx, x, y, s, s, OUT)
  rect(ctx, x + 1, y + 1, s - 2, s - 2, sel ? GOLD : on ? 0x4a3c30 : SLOT_BG)
  rect(ctx, x + 2, y + 2, s - 4, s - 4, sel ? 0x3a2a18 : on ? SLOT_BG : 0x14100e)
  rect(ctx, x + 2, y + s - 3, s - 4, 1, sel ? mul(GOLD, 0.6) : 0x1a1412)
  if (key) {
    const kw = measure(font, key) + 3
    rect(ctx, x + s - kw - 1, y + 1, kw, font.h + 2, on ? (sel ? GOLD : BRONZE_D) : 0x3a3230)
    drawText(ctx, font, key, x + s - kw + 1, y + 2, DARK, null)
  }
}

// Triángulo ◀ ▶ de 6×11 dentro de un botón de mover.
export function moveArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: -1 | 1, c: number): void {
  for (let k = 0; k < 6; k++) rect(ctx, dir > 0 ? x + k : x + 5 - k, y + k, 1, 11 - 2 * k, c)
}
