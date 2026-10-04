// Arte de reserva mientras public/assets no tenga todo: las mismas grillas del look-test, pintadas en canvas.
import type { Biome, CrewId } from '../../sim/types'
import { TANK_W } from '../../sim/types'
import { gridCanvas, mix, mul } from './raster'

export const OUT = 0x140e0a

const T = (off: number, s: string): string => ('.'.repeat(off) + s).padEnd(TANK_W, '.')
const r_ = (c: string, n: number): string => c.repeat(n)
const TANK_ROWS = [
  T(8, r_('k', 12)),
  T(7, 'k' + 'hh' + r_('l', 10) + 'k'),
  T(7, 'k' + 'hl' + r_('m', 10) + 'k'),
  T(7, 'k' + 'l' + r_('m', 8) + 'vdd' + 'k'),
  T(7, 'k' + 'l' + r_('R', 10) + 'd' + 'k'),
  T(7, 'k' + 'm' + r_('r', 10) + 'D' + 'k'),
  T(7, 'k' + r_('d', 11) + 'D' + 'k'),
  T(2, r_('k', 24)),
  T(1, 'k' + 'hhh' + r_('l', 21) + 'k'),
  T(0, 'k' + 'h' + 'l' + r_('m', 23) + 'd' + 'k'),
  T(0, 'k' + 'l' + r_('m', 22) + 'yY' + 'd' + 'k'),
  T(0, r_('k', 28)),
  T(0, 'k' + r_('dhddd', 5) + 'd' + 'k'),
  T(0, 'k' + r_('D', 26) + 'k'),
  // orugas simplificadas
  T(2, r_('k', 24)),
  T(1, 'k' + r_('tq', 12) + 't' + 'k'),
  T(0, 'k' + r_('ooOoooO', 3) + 'ooooO' + 'k'),
  T(0, 'k' + r_('ooOoooO', 3) + 'ooooO' + 'k'),
  T(1, 'k' + r_('tq', 12) + 't' + 'k'),
  T(2, r_('k', 24)),
]

export const HULLS = [
  { D: 0x2c341e, d: 0x434d2a, m: 0x5c6836, l: 0x7c8a48, h: 0xa2ae66 },
  { D: 0x4a3a24, d: 0x6a5636, m: 0x8c7650, l: 0xae9468, h: 0xcdb488 },
  { D: 0x2a3038, d: 0x3e4854, m: 0x56626e, l: 0x74808a, h: 0x9aa4ac },
  { D: 0x3a2a30, d: 0x54404a, m: 0x705866, l: 0x8e7482, h: 0xb096a2 },
]

export function tankBody(index: number, stripe: number, wreck = false): HTMLCanvasElement {
  let hull: Record<string, number> = HULLS[index % 4]
  if (wreck) hull = Object.fromEntries(Object.entries(HULLS[1]).map(([k, v]) => [k, mix(mul(v, 0.35), 0x1a1210, 0.4)]))
  const pal: Record<string, number> = {
    k: OUT,
    ...hull,
    R: wreck ? 0x2a1a14 : stripe,
    r: wreck ? 0x1e1410 : mul(stripe, 0.7),
    y: wreck ? 0x3a2a20 : 0xfff1a8,
    Y: wreck ? 0x2a2018 : 0xffffff,
    v: 0x2a2a24,
    t: 0x16110e,
    q: 0x4a3e34,
    o: 0x2a221c,
    O: 0x5a5046,
  }
  return gridCanvas(TANK_ROWS, pal)
}

// Tira de cañones como barrel() del look-test: 19 frames de 5°, pivote fijo.
export const BARREL_CELL = 40
export const BARREL_PIVOT = { x: 12, y: 27 }
export function barrelStrip(index: number, len = 11): HTMLCanvasElement {
  const hull = HULLS[index % 4]
  const c = document.createElement('canvas')
  c.width = BARREL_CELL * 19
  c.height = BARREL_CELL
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const img = ctx.createImageData(c.width, c.height)
  for (let f = 0; f < 19; f++) {
    const rad = (f * 5 * Math.PI) / 180
    const dx = Math.cos(rad)
    const dy = -Math.sin(rad)
    const nx = -dy
    const ny = dx
    const cells = new Map<number, { x: number; y: number; kind: number; side: number }>()
    const px0 = f * BARREL_CELL + BARREL_PIVOT.x
    const py0 = BARREL_PIVOT.y
    for (let t = -2; t <= len + 3; t += 0.25) {
      const half = t > len ? 1.9 : 1.2
      for (let w = -half; w <= half; w += 0.25) {
        const x = Math.round(px0 + dx * t + nx * w)
        const y = Math.round(py0 + dy * t + ny * w)
        const key = y * 4096 + x
        const kind = t > len ? 2 : 1
        if (!cells.has(key) || kind === 2) cells.set(key, { x, y, kind, side: w })
      }
    }
    for (const cell of cells.values()) {
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => !cells.has((cell.y + oy) * 4096 + cell.x + ox))
      let col = edge ? OUT : cell.side < -0.4 ? hull.h : cell.side > 0.5 ? hull.d : hull.m
      if (!edge && cell.kind === 2) col = cell.side < 0 ? 0x6a6a60 : 0x3a3a34
      if (cell.x < 0 || cell.y < 0 || cell.x >= c.width || cell.y >= c.height) continue
      const i = (cell.y * c.width + cell.x) * 4
      img.data[i] = (col >> 16) & 255
      img.data[i + 1] = (col >> 8) & 255
      img.data[i + 2] = col & 255
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

const CREW_BANDANA = [
  '...kkkkkk...',
  '..kbbbbbbk..',
  'kbkBbbbbbk..',
  '.kkssssssk..',
  '..kgggggGk..',
  '..ksssssSk..',
  '..kskwwkSkce',
  '..kTsTsTTk..',
  '...kTTTTk...',
  '.knnkkkknnk.',
  'knnnnnnnnnnk',
  'ksnnnnnnnnsk',
]
const CREW_SARGE = [
  '...kkkkkk...',
  '..kJHHHHHk..',
  '.kJHHHHHHHk.',
  'kkkkkkkkkkkk',
  '..kSSSSSSk..',
  '..kskssksk..',
  '..kssSSssk..',
  '.kMMMMMMMMk.',
  '.kMskkkksMk.',
  '.knnkkkknnk.',
  'knnnnnnnnnnk',
  'ksnnnnnnnnsk',
]
const SKIN = { s: 0xd8966c, S: 0xa2644a, T: 0x8a5a44, w: 0xf2ece2 }
const CREW_DEF: Record<CrewId, { rows: string[]; pal: Record<string, number> }> = {
  bandana: { rows: CREW_BANDANA, pal: { b: 0xc8302a, B: 0xf0604a, g: 0x141414, G: 0x8ab0d0, c: 0x6b3e1f, e: 0xff8a30, n: 0x4a4a38 } },
  sarge: { rows: CREW_SARGE, pal: { H: 0x4a5a2a, J: 0x6e8040, M: 0x3a2214, n: 0x5a5030 } },
  rookie: { rows: CREW_BANDANA, pal: { b: 0x2a2a2a, B: 0x4a4a4a, g: 0x6a3a1a, G: 0xc89a4a, c: 0x6b3e1f, e: 0xff8a30, n: 0x3a4454 } },
  desert: { rows: CREW_SARGE, pal: { H: 0x8a7650, J: 0xb09a6c, M: 0x8a8a84, n: 0x6a5a3a } },
  // v5: provisorios (variantes de color) hasta que el área arte pinte los tripulantes nuevos
  commando: { rows: CREW_BANDANA, pal: { b: 0x1a1a1a, B: 0x3a3a3a, g: 0x141414, G: 0x8ab0d0, c: 0x4a2c16, e: 0xff8a30, n: 0x2a3a2a } },
  goggles: { rows: CREW_SARGE, pal: { H: 0x5a3a22, J: 0x8a5a32, M: 0x3a2214, n: 0x4a4038 } },
  pilot: { rows: CREW_SARGE, pal: { H: 0x6a6e74, J: 0x9aa0a6, M: 0x6a3a1a, n: 0x3a4454 } },
  colonel: { rows: CREW_SARGE, pal: { H: 0x3a4a2a, J: 0x5a6e3a, M: 0xe8e4dc, n: 0x5a5030 } },
}
export function crewSprite(crew: CrewId): HTMLCanvasElement {
  const def = CREW_DEF[crew] ?? CREW_DEF.bandana
  return gridCanvas(def.rows, { k: OUT, ...SKIN, ...def.pal })
}

const BUBBLE_ALERT = [
  '.kkkkkkkkk.',
  'kwwwwwwwwwk',
  'kwwwwkkwwwk',
  'kwwwwkkwwwk',
  'kwwwwkkwwwk',
  'kwwwwkkwwwk',
  'kwwwwwwwwwk',
  'kwwwwkkwwwk',
  'kwwwwwwwwwk',
  'ksssssssssk',
  '.kkkkwkkkk.',
  '....kwk....',
  '....kk.....',
]
const BUBBLE_ASK = [
  '.kkkkkkkkk.',
  'kwwwwwwwwwk',
  'kwwwkkkwwwk',
  'kwwkkwkkwwk',
  'kwwwwwkkwwk',
  'kwwwwkkwwwk',
  'kwwwwkkwwwk',
  'kwwwwwwwwwk',
  'kwwwwkkwwwk',
  'ksssssssssk',
  '.kkkkwkkkk.',
  '....kwk....',
  '....kk.....',
]
const BUBBLE_PAL = { k: OUT, w: 0xffffff, s: 0xc8c8c8 }
export const bubbleAlert = (): HTMLCanvasElement => gridCanvas(BUBBLE_ALERT, BUBBLE_PAL)
export const bubbleAsk = (): HTMLCanvasElement => gridCanvas(BUBBLE_ASK, BUBBLE_PAL)

export const arrow = (): HTMLCanvasElement =>
  gridCanvas(['...k...', '..kwk..', '.kwwwk.', 'kwwwwwk', 'kkwwwkk', '.kwwwk.', '.kkkkk.'], { k: OUT, w: 0xfff1a8 })

export const GLYPHS: Record<string, string[]> = {
  P: ['####.', '#...#', '####.', '#....', '#....'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
}

export function solid(w: number, h: number, color: number, outline = OUT): HTMLCanvasElement {
  const rows: string[] = []
  for (let y = 0; y < h; y++) {
    let row = ''
    for (let x = 0; x < w; x++) row += x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 'k' : 'f'
    rows.push(row)
  }
  return gridCanvas(rows, { k: outline, f: color })
}

// Paleta de bioma de reserva (la del bosque sale del look-test).
export const BIOME_PALETTE: Record<Biome, { grass: number[]; moss: number; rim: number; ambient: number }> = {
  forest: { grass: [0x3d4a2c, 0x5d6640, 0x8a8456], moss: 0x4d5a36, rim: 0x46352a, ambient: 0xf0dfc8 },
  jungle: { grass: [0x24421e, 0x3a6a2a, 0x78a03c], moss: 0x3a6a2c, rim: 0x3e3020, ambient: 0xd6e6c0 },
  industrial: { grass: [0x4a3a28, 0x6a5234, 0x9a7a48], moss: 0x5a4a34, rim: 0x4a3626, ambient: 0xf0b888 },
  snow: { grass: [0xc8d4dc, 0xe4ecf0, 0xffffff], moss: 0xb8c8d0, rim: 0x6a7884, ambient: 0xe8f0f8 }, // v3 respaldo
}

export const BIOME_SKY: Record<Biome, number[]> = {
  forest: [0xc4ad8e, 0xd9c3a4, 0xebd8bf, 0xf6e9d7],
  jungle: [0x9ab89a, 0xb8d0a8, 0xd4e2c0, 0xe8f0d8],
  industrial: [0x6a4a5a, 0xb86a4a, 0xe8a060, 0xf6d49a],
  snow: [0x8aa0b8, 0xb0c4d8, 0xd4e0ec, 0xeef4fa], // v3 respaldo
}

// Colores de escombro por material (índice = Material).
export const DEBRIS_COLORS: number[][] = [
  [0x2a1c13],
  [0x2a1c13, 0x3c2e22, 0x54432f],
  [0x807761, 0x9a9078, 0x5a5242, 0x736a55],
  [0x6d3b2b, 0x78422f, 0xa8664c, 0x3e2019],
  [0x4a3526, 0x523b2a, 0x7a5a3e],
  [0xa8966c, 0xb3a176, 0x7a6a48],
  [0x5a4230, 0x7e6046, 0x4a3424],
  [0x6e5038, 0x563e2c, 0x4a3424],
  [0x8a8a84, 0x5a5a56, 0xb0b0a8],
  [0x2a2622, 0x3a3430],
]

// Color plano por material cuando falta la textura.
export const MATERIAL_FLAT = [0, 0x20150f, 0x807761, 0x6d3b2b, 0x4a3526, 0xa8966c, 0x5a4230, 0x6e5038, 0x7a7a74, 0x2a2622]

// Tramo de escalera 8×4 como ladder() del look-test.
export const gridCanvas8x4 = (): HTMLCanvasElement =>
  gridCanvas(['kLRRRRDk', 'kLrrrrDk', 'kL....Dk', 'kL....Dk'], { k: OUT, L: 0x8a6a48, D: 0x6b5038, R: 0x9a7a54, r: 0x3a2a1c })

// Orugas de reserva: 3 frames de las 6 filas de abajo del casco, con los eslabones corridos.
export const TREAD_H = 6
export function treadFrames(): HTMLCanvasElement[] {
  const pal = { k: OUT, t: 0x16110e, q: 0x4a3e34, o: 0x2a221c, O: 0x5a5046 }
  const links = (f: number): string => Array.from({ length: 25 }, (_, i) => (((i + f) % 3 + 3) % 3 === 0 ? 't' : 'q')).join('')
  return [0, 1, 2].map((f) =>
    gridCanvas(
      [
        T(2, r_('k', 24)),
        T(1, 'k' + links(f) + 'k'),
        T(0, 'k' + r_('ooOoooO', 3) + 'ooooO' + 'k'),
        T(0, 'k' + r_('ooOoooO', 3) + 'ooooO' + 'k'),
        T(1, 'k' + links(-f) + 'k'),
        T(2, r_('k', 24)),
      ],
      pal,
    ),
  )
}

// Paracaídas de reserva, 20×16: cúpula a rayas con el borde inferior en festón.
export function parachute(): HTMLCanvasElement {
  const w = 20
  const h = 16
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const put = (x: number, y: number, col: number): void => {
    ctx.fillStyle = `#${col.toString(16).padStart(6, '0')}`
    ctx.fillRect(x, y, 1, 1)
  }
  for (let y = 0; y < 12; y++) {
    const half = Math.round(Math.sqrt(Math.max(0, 1 - ((11 - y) / 12) ** 2)) * 10)
    for (let x = 10 - half; x < 10 + half; x++) {
      const edge = x === 10 - half || x === 10 + half - 1 || y === 0
      put(x, y, edge ? OUT : Math.floor((x + 1) / 4) % 2 === 0 ? 0xd0362c : 0xf2ece2)
    }
  }
  for (let x = 0; x < w; x++) if (x % 5 !== 2 && x % 5 !== 3) put(x, 12, OUT)
  return c
}
