// Fuente pixel dibujada en canvas. Usa manifest.ui.font si está; si no, una de respaldo 5×5.

export interface Glyph {
  w: number
  bits: Uint8Array // w × font.h, 1 = pixel encendido
}

export interface PixelFont {
  h: number
  glyphs: Map<string, Glyph>
}

export const OUT = 0x140e0a

const FALLBACK: Record<string, string[]> = {
  A: ['.###.', '#...#', '#####', '#...#', '#...#'],
  B: ['####.', '#...#', '####.', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '####.', '#....', '#####'],
  F: ['#####', '#....', '####.', '#....', '#....'],
  G: ['.####', '#....', '#..##', '#...#', '.####'],
  H: ['#...#', '#...#', '#####', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..###', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '###..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '####.', '#....', '#....'],
  Q: ['.###.', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '####.', '#..#.', '#...#'],
  S: ['.####', '#....', '.###.', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
  Z: ['#####', '...#.', '..#..', '.#...', '#####'],
  0: ['.###.', '#..##', '#.#.#', '##..#', '.###.'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['####.', '....#', '.###.', '#....', '#####'],
  3: ['####.', '....#', '.###.', '....#', '####.'],
  4: ['#...#', '#...#', '#####', '....#', '....#'],
  5: ['#####', '#....', '####.', '....#', '####.'],
  6: ['.###.', '#....', '####.', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '..#..'],
  8: ['.###.', '#...#', '.###.', '#...#', '.###.'],
  9: ['.###.', '#...#', '.####', '....#', '.###.'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['..', '..', '..', '.#', '#.'],
  ':': ['.', '#', '.', '#', '.'],
  '-': ['...', '...', '###', '...', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['###.', '...#', '.##.', '....', '.#..'],
  '/': ['....#', '...#.', '..#..', '.#...', '#....'],
  '%': ['#...#', '...#.', '..#..', '.#...', '#...#'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '°': ['###', '#.#', '###', '...', '...'],
  x: ['...', '#.#', '.#.', '#.#', '...'],
  ' ': ['..', '..', '..', '..', '..'],
}

export function fallbackFont(): PixelFont {
  const glyphs = new Map<string, Glyph>()
  for (const [ch, rows] of Object.entries(FALLBACK)) {
    const w = rows[0].length
    const bits = new Uint8Array(w * rows.length)
    rows.forEach((row, y) => {
      for (let x = 0; x < w; x++) bits[y * w + x] = row[x] === '#' ? 1 : 0
    })
    glyphs.set(ch, { w, bits })
  }
  return { h: 5, glyphs }
}

// Lee la tira de la fuente del manifiesto. Solo cuentan los pixels claros (la sombra
// de la tira la vuelve a poner drawText) y cada glifo se recorta a sus pixels.
// Los caracteres que la tira no trae salen de la fuente de respaldo.
export function fontFromImage(img: HTMLImageElement, glyphW: number, glyphH: number, chars: string): PixelFont | null {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || canvas.width === 0) return null
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const lit = (x: number, y: number) => {
    const i = (y * canvas.width + x) * 4
    return data[i + 3] > 127 && data[i] + data[i + 1] + data[i + 2] > 450
  }
  const found: { ch: string; x0: number; x1: number }[] = []
  let h = 0
  ;[...chars].forEach((ch, i) => {
    const cx = i * glyphW
    if (cx + glyphW > canvas.width) return
    let x0 = glyphW
    let x1 = -1
    for (let y = 0; y < glyphH; y++) {
      for (let x = 0; x < glyphW; x++) {
        if (!lit(cx + x, y)) continue
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        h = Math.max(h, y + 1)
      }
    }
    found.push({ ch, x0: cx + x0, x1: cx + x1 })
  })
  if (found.length === 0 || h === 0) return null
  const glyphs = new Map<string, Glyph>()
  for (const { ch, x0, x1 } of found) {
    if (x1 < 0) {
      glyphs.set(ch, { w: Math.max(2, Math.ceil(glyphW / 2)), bits: new Uint8Array(Math.max(2, Math.ceil(glyphW / 2)) * h) })
      continue
    }
    const w = x1 - x0 + 1
    const bits = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = lit(x0 + x, y) ? 1 : 0
    glyphs.set(ch, { w, bits })
  }
  const fb = fallbackFont()
  for (const [ch, g] of fb.glyphs) {
    if (glyphs.has(ch) || glyphs.has(ch.toUpperCase())) continue
    const bits = new Uint8Array(g.w * h)
    for (let y = 0; y < Math.min(h, fb.h); y++) for (let x = 0; x < g.w; x++) bits[y * g.w + x] = g.bits[y * g.w + x]
    glyphs.set(ch, { w: g.w, bits })
  }
  return { h, glyphs }
}

function glyphFor(font: PixelFont, ch: string): Glyph | undefined {
  return font.glyphs.get(ch) ?? font.glyphs.get(ch.toUpperCase()) ?? font.glyphs.get(ch.toLowerCase())
}

function clean(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function measure(font: PixelFont, str: string): number {
  let w = 0
  for (const ch of clean(str)) {
    const g = glyphFor(font, ch) ?? glyphFor(font, '?')
    if (g) w += g.w + 1
  }
  return Math.max(0, w - 1)
}

export function css(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
}

// Dibuja en coordenadas enteras del contexto. shadow: sombra de 1 px abajo a la derecha.
export function drawText(
  ctx: CanvasRenderingContext2D,
  font: PixelFont,
  str: string,
  x: number,
  y: number,
  color: number,
  shadow: number | null = OUT,
): number {
  let cx = Math.round(x)
  const y0 = Math.round(y)
  for (const ch of clean(str)) {
    const g = glyphFor(font, ch) ?? glyphFor(font, '?')
    if (!g) continue
    for (const [dx, dy, c] of shadow == null ? [[0, 0, color]] : [[1, 1, shadow], [0, 0, color]]) {
      ctx.fillStyle = css(c)
      for (let gy = 0; gy < font.h; gy++) {
        for (let gx = 0; gx < g.w; gx++) if (g.bits[gy * g.w + gx]) ctx.fillRect(cx + gx + dx, y0 + gy + dy, 1, 1)
      }
    }
    cx += g.w + 1
  }
  return cx - Math.round(x)
}

// Texto con contorno completo de 1 px (para títulos).
export function drawOutlined(
  ctx: CanvasRenderingContext2D,
  font: PixelFont,
  str: string,
  x: number,
  y: number,
  color: number,
  outline = OUT,
): number {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [1, 2], [0, 2], [-1, 2]]) {
    drawText(ctx, font, str, x + dx, y + dy, outline, null)
  }
  return drawText(ctx, font, str, x, y, color, null)
}
