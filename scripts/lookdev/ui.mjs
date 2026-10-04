// Utilería (barril, caja, escalera, foco, bandera, manga de viento) y UI (globos, tag, fuente, íconos).
import { Canvas, OUT, mul, BARREL, BARREL_PAL, crate, ladder, flag, BUBBLE_ALERT, BUBBLE_ASK, BUBBLE_PAL, FONT } from './pixel.mjs'

// ---------- utilería ----------

export function barrelProp() {
  const cv = new Canvas(10, 12)
  cv.sprite(BARREL, 0, 0, BARREL_PAL)
  return cv
}

export function crateProp() {
  const cv = new Canvas(12, 12)
  crate(cv, 0, 0)
  return cv
}

export function ladderTile() {
  const cv = new Canvas(8, 4)
  ladder(cv, 0, 0, 3)
  return cv
}

// foco colgante de búnker, 7×10; el halo lo pone el renderer
export function lampProp() {
  const cv = new Canvas(7, 10)
  cv.sprite(
    ['...k...', '...k...', '...k...', '..kkk..', '.kmmmk.', 'kmMMMdk', 'kkkkkkk', '.kyYyk.', '..kyk..', '...k...'],
    0,
    0,
    { k: OUT, m: 0x4a5a3a, M: 0x6a7a52, d: 0x2e3824, y: 0xffd070, Y: 0xfff6c8 },
  )
  return cv
}

export const FLAG_FRAMES = 6
export const FLAG_CELL = { w: 22, h: 38 }
export function flagStrip() {
  const cv = new Canvas(FLAG_CELL.w * FLAG_FRAMES, FLAG_CELL.h)
  for (let f = 0; f < FLAG_FRAMES; f++) flag(cv, f * FLAG_CELL.w + 1, FLAG_CELL.h, (f / FLAG_FRAMES) * Math.PI * 2)
  return cv
}

// Manga de viento: 7 frames para viento -10..10; el del medio cuelga. Mástil en la columna 16.
export const SOCK_FRAMES = 7
export const SOCK_CELL = { w: 33, h: 30 }
export function windsockStrip() {
  const { w: CW, h: CH } = SOCK_CELL
  const cv = new Canvas(CW * SOCK_FRAMES, CH)
  for (let f = 0; f < SOCK_FRAMES; f++) {
    const wind = -10 + (f * 20) / (SOCK_FRAMES - 1)
    const cell = new Canvas(CW, CH)
    const px = 16
    const ground = CH
    for (let y = ground - 26; y < ground; y++) {
      cell.put(px, y, 0x8a8a84)
      cell.put(px + 1, y, 0x4a4a46)
    }
    cell.put(px, ground - 27, 0xd0d0c8)
    const k = Math.abs(wind) / 10
    const dir = wind === 0 ? 1 : Math.sign(wind)
    // ángulo desde la vertical: colgando (≈10°) hasta horizontal con viento máximo
    const phi0 = ((10 + 80 * k) * Math.PI) / 180
    const ax = dir > 0 ? px + 2 : px - 1
    const ay = ground - 24
    const cells = new Map()
    let x = ax
    let y = ay
    let phi = phi0
    const L = 14
    for (let t = 0; t <= L; t += 0.25) {
      const hh = 3 - Math.floor(t / 5)
      const dx = Math.sin(phi) * dir
      const dy = Math.cos(phi)
      for (let s = -hh; s <= hh; s += 0.25) {
        const cx = Math.round(x - dy * s * dir)
        const cy = Math.round(y + dx * s * dir)
        const key = cy * 64 + cx
        cells.set(key, { x: cx, y: cy, t })
      }
      x += dx * 0.25
      y += dy * 0.25
      phi = Math.max(0.12, phi - (1 - k) * 0.012)
    }
    for (const c of cells.values()) {
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => !cells.has((c.y + oy) * 64 + c.x + ox))
      const stripe = Math.floor(c.t / 3) % 2 === 0 ? 0xf06a2a : 0xf2ece2
      cell.put(c.x, c.y, edge ? OUT : stripe)
    }
    cell.put(ax, ay - 1, 0x2a2a28)
    cv.blit(cell, f * CW, 0)
  }
  return cv
}

// ---------- globos ----------

export function bubble(rows) {
  const cv = new Canvas(11, 13)
  cv.sprite(rows, 0, 0, BUBBLE_PAL)
  return cv
}
export const bubbleAlert = () => bubble(BUBBLE_ALERT)
export const bubbleAsk = () => bubble(BUBBLE_ASK)

// Globo vacío para "P1".."P4": 15×13 (cuerpo de 11 px + pico). Blanco para que el renderer lo tiña.
export function tagBubble() {
  const w = 15
  const cv = new Canvas(w, 13)
  const fill = 0xffffff
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < w; x++) {
      if ((y === 0 || y === 10) && (x === 0 || x === w - 1)) continue
      const edge = y === 0 || y === 10 || x === 0 || x === w - 1
      cv.put(x, y, edge ? OUT : y === 9 ? mul(fill, 0.7) : fill)
    }
  }
  cv.sprite(['kwwwk', '.kwk.', '..k..'], 5, 10, { k: OUT, w: fill })
  return cv
}

// ---------- fuente pixel 5×5 con sombra ----------

const GLYPHS = {
  ...FONT,
  C: ['.####', '#....', '#....', '#....', '.####'],
  F: ['#####', '#....', '####.', '#....', '#....'],
  I: ['.###.', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '....#', '....#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '###..', '#..#.', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  Q: ['.###.', '#...#', '#.#.#', '#..#.', '.##.#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
  0: ['.###.', '#..##', '#.#.#', '##..#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '.###.'],
  2: ['####.', '....#', '.###.', '#....', '#####'],
  3: ['####.', '....#', '.###.', '....#', '####.'],
  4: ['#..#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '####.'],
  6: ['.###.', '#....', '####.', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '..#..'],
  8: ['.###.', '#...#', '.###.', '#...#', '.###.'],
  9: ['.###.', '#...#', '.####', '....#', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '..#..'],
  ',': ['.....', '.....', '.....', '..#..', '.#...'],
  ':': ['.....', '..#..', '.....', '..#..', '.....'],
  '!': ['..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '..##.', '.....', '..#..'],
  '-': ['.....', '.....', '.###.', '.....', '.....'],
  '/': ['....#', '...#.', '..#..', '.#...', '#....'],
  '%': ['#...#', '...#.', '..#..', '.#...', '#...#'],
  '+': ['.....', '..#..', '.###.', '..#..', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....'],
}
export const FONT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?-/%+ '
export const GLYPH = { w: 6, h: 6 }

// Una fila de celdas 6×6: glifo blanco de 5×5 y sombra oscura a +1,+1 (como el HUD de la referencia).
export function fontStrip() {
  const cv = new Canvas(GLYPH.w * FONT_CHARS.length, GLYPH.h)
  ;[...FONT_CHARS].forEach((ch, i) => {
    const gl = GLYPHS[ch]
    if (!gl) throw new Error(`falta el glifo ${ch}`)
    const pad = Math.floor((5 - gl[0].length) / 2)
    for (let y = 0; y < 5; y++) for (let x = 0; x < gl[y].length; x++) if (gl[y][x] === '#') cv.put(i * GLYPH.w + pad + x + 1, y + 1, OUT)
    for (let y = 0; y < 5; y++) for (let x = 0; x < gl[y].length; x++) if (gl[y][x] === '#') cv.put(i * GLYPH.w + pad + x, y, 0xffffff)
  })
  return cv
}

// ---------- flecha, pips e íconos ----------

export function arrowUp() {
  const cv = new Canvas(9, 9)
  cv.sprite(
    ['....k....', '...kwk...', '..kwwwk..', '.kwwwwsk.', 'kwwwwwwsk', 'kkkwwskkk', '..kwwsk..', '..kwssk..', '..kkkkk..'],
    0,
    0,
    { k: OUT, w: 0xffffff, s: 0xb8b8b8 },
  )
  return cv
}

export function pipStrip() {
  const cv = new Canvas(8, 5)
  const rows = ['.kk.', 'kyyk', 'krrk', 'krrk', 'kkkk']
  cv.sprite(rows, 0, 0, { k: OUT, y: 0xffe27a, r: 0xd0362c })
  cv.sprite(rows, 4, 0, { k: OUT, y: 0x3a3230, r: 0x2a2220 })
  return cv
}

// en el orden de WeaponId: normal, heavy, dirt, cluster, napalm, digger, roller, nuke
// Íconos 12×12 con luz arriba a la izquierda y contorno cerrado, legibles a escala 1 sobre el HUD oscuro.
const ICONS = [
  // normal: obús de punta de acero y vaina de latón
  [
    '.....kk.....',
    '....kLMk....',
    '...kLLMmk...',
    '...kLMMmk...',
    '...kRRRrk...',
    '...kWRRrk...',
    '...kWYyyk...',
    '...kYYyyk...',
    '...kYYyyk...',
    '...kyyyuk...',
    '...kkkkkk...',
    '............',
  ],
  // heavy: bombón negro con franja roja y aletas
  [
    '...kkkkkk...',
    '..kDDDDDDk..',
    '.kDWWDDDDdk.',
    '.kDWDDDDDdk.',
    '.kRRRRRRRrk.',
    '.kDDDDDDDdk.',
    '.kDDDDDDddk.',
    '..kddddddk..',
    '...kkkkkk...',
    '..kMkLMkMk..',
    '.kMMk..kMmk.',
    '.kkk....kkk.',
  ],
  // dirt: terrón con pasto y piedritas
  [
    '............',
    '...G..G..G..',
    '..GgGGgGGg..',
    '.kkkkkkkkkk.',
    'kBBbBbbbbbbk',
    'kBbbbcCbbbek',
    'kbbbbbbbbbek',
    'kbcCbbbbbeek',
    '.kbbbbbcCek.',
    '..kbbbbbeek.',
    '...kkkkkkk..',
    '............',
  ],
  // cluster: obús que se abre en tres bombitas con estela
  [
    '............',
    '..O..O..O...',
    '...Y.Y.Y....',
    '....kkk.....',
    '...kWRrk....',
    '...kRRrk....',
    '....kkk.....',
    '.kkk...kkk..',
    'kWRrk.kWRrk.',
    'kRRrk.kRRrk.',
    '.kkk...kkk..',
    '............',
  ],
  // napalm: gota de fuego con núcleo blanco
  [
    '.....k......',
    '....kYk.....',
    '....kYOk....',
    '...kYOOk....',
    '...kYOOOk...',
    '..kYOWWOOk..',
    '..kOWWWWOok.',
    '.kOWWWYWOok.',
    '.kOWWYYWOok.',
    '.kOOWWWOOok.',
    '..kooOOoook.',
    '...kkkkkkk..',
  ],
  // digger: mecha en espiral que tira tierra
  [
    '..kkkkkkkk..',
    '..kLLMMMmk..',
    '..kkkkkkkk..',
    '...kLMMmk...',
    '...kmLMMk...',
    '...kMmLMk...',
    '....kmLk....',
    '....kLmk....',
    '.....kk.....',
    '..c.......c.',
    '.c..b..b..c.',
    '....c..c....',
  ],
  // roller: rueda pesada con líneas de velocidad
  [
    '............',
    '....kkkk....',
    '..kkMMMMkk..',
    '.kMLMMMMMmk.',
    'skLMkkkkMmk.',
    'kMMkYyykMMmk',
    'kMMkyuukMMmk',
    'skMMkkkkMmk.',
    '.kMMMMMMmmk.',
    's.kkmmmmkk..',
    '....kkkk....',
    'SSSSSSSSSSSS',
  ],
  // nuke: hongo atómico
  [
    '..kkkkkkkk..',
    '.kOOYYYOOok.',
    'kOYYWWYYOOok',
    'kOYWWWWYOOok',
    '.kOOYYOOOok.',
    '..kkkOOkkk..',
    '....kYOk....',
    '....kYOk....',
    '...kOYOOk...',
    '..kOOYOOok..',
    '.kkkkkkkkkk.',
    '............',
  ],
  // ---- v3 (WEAPON_ORDER 9 a 16): guided, bouncer, laser, mine, quake, blackhole, acid, wall ----
  // guided: misil con la estela celeste que dobla en el aire (se dirige en la bajada)
  [
    '...AAAA.....',
    '..A....A....',
    '.A......A...',
    '.A.....AAA..',
    '........A...',
    '...kk.......',
    '...kMkkkkk..',
    '.kkkLLLLLRk.',
    'kYOkMMMMMRRk',
    '.kkkmmmmmrk.',
    '...kmkkkkk..',
    '...kk.......',
  ],
  // bouncer: bola verde que rebota, con un chispazo en cada pique
  [
    '........kkk.',
    '.......kWGGk',
    '.......kGGgk',
    '...ss..kGggk',
    '..s..s..kkk.',
    '.s....s.s...',
    '.s.....s....',
    's......s....',
    'Y.Y...Y.Y...',
    '.O.....O....',
    'Y.Y...Y.Y...',
    'SSSSSSSSSSSS',
  ],
  // laser: emisor con rayo rosa de núcleo blanco que pega del otro lado
  [
    '............',
    '..........Y.',
    '.kkkk....Y..',
    'kLMMmk.....Y',
    'kMkkmkPPPPPY',
    'kMLMmWWWWWWW',
    'kMkkmkPPPPPY',
    'kmmmmk.....Y',
    '.kkkk....Y..',
    '..........Y.',
    '............',
    '............',
  ],
  // mine: mina medio enterrada, con púas y luz roja
  [
    '............',
    '.....kk.....',
    '....kRWk....',
    '....kRRk....',
    '.k..kkkk..k.',
    '.kkkDDDDkkk.',
    '..kDWDDDDk..',
    '.kDDDDDDDdk.',
    'kDDDDDDDDddk',
    'kkkkkkkkkkkk',
    'SbSbbSbbSbbS',
    'bbbSbbbbSbbb',
  ],
  // quake: suelo partido en zigzag, escombros saltando y líneas de temblor
  [
    's..C....c..s',
    '.s...c.C..s.',
    's..c......s.',
    '...GgG.GGgG.',
    '.kkkkkk.kkkk',
    'kBBbbbkkBBbk',
    'kbbbbbbkkbbk',
    'kbCbbbkkbbek',
    'kbbbbkkbbCek',
    'kbbbbbkkbbek',
    'kbbbbkkbbeek',
    '.kkkkkkkkkk.',
  ],
  // blackhole: se pinta en blackholeIcon (disco negro con anillo violeta inclinado)
  null,
  // acid: frasco con líquido verde y burbujas, una gota que cae por afuera
  [
    '...kkkkkk...',
    '....kWsk....',
    '....kWsk..N.',
    '....kWsk..n.',
    '...kWNNsk...',
    '..kWNWNNnk..',
    '.kWNNNNWNnk.',
    '.kNNWNNNNnk.',
    'kNNNNNNNNNnk',
    'knNNNNWNNnnk',
    'knnnnnnnnnnk',
    '.kkkkkkkkkk.',
  ],
  // wall: muro alto de tierra que sube del piso (flecha) y frena un tiro (chispa)
  [
    '....kGGk....',
    '...kGgGgk...',
    '.Y.kBbbek...',
    'YYYkbbbekY..',
    '.Y.kBbbekOY.',
    '.Y.kbbCekY..',
    '.Y.kbbbek...',
    '...kbCbek...',
    '...kBbbek...',
    '...kbbbek...',
    '.kkkbbbekkk.',
    'SSSSSSSSSSSS',
  ],
]
const ICON_PAL = {
  k: OUT, W: 0xfffbe2, Y: 0xffe27a, y: 0xd2a238, u: 0x8a6420, R: 0xe0463a, r: 0x8e1e1a,
  L: 0xd0d6de, M: 0x8a929e, m: 0x4e5460, D: 0x50545c, d: 0x30323a,
  G: 0x8ad05a, g: 0x4a8a34, b: 0x5a3e28, B: 0x86603c, e: 0x33241a, c: 0xa89a7a, C: 0x6a604c,
  O: 0xf77a28, o: 0xb8401c, s: 0xd8d0c0, S: 0x4a3e34,
  // v3
  A: 0x7ad8f0, P: 0xff5ac8, N: 0x9cf04a, n: 0x4aa02a,
}

// Agujero negro: anillo de acreción elíptico (violeta, con brillo del lado de arriba) que pasa por detrás y por
// delante de un disco negro con borde violeta; motitas que caen hacia el centro.
function blackholeIcon(cv, x0) {
  const cx = 5.5
  const cy = 5.5
  const ring = (front) => {
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        // elipse inclinada: rotada ~-20°
        const dx = x - cx
        const dy = y - cy
        const u = dx * 0.94 + dy * 0.34
        const v = -dx * 0.34 + dy * 0.94
        const e = Math.hypot(u / 5.8, v / 2.1)
        if (e < 0.72 || e > 1.12) continue
        if (front !== v > 0) continue
        cv.put(x0 + x, y, e > 1.0 ? OUT : v < -0.6 ? 0xe6b0ff : u > 2 ? 0x6a2aa8 : 0xa65ae0)
      }
    }
  }
  ring(false)
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d < 2.4) cv.put(x0 + x, y, 0x08060c)
      else if (d < 3.3) cv.put(x0 + x, y, 0x3a1a5a)
    }
  }
  ring(true)
  for (const [x, y] of [[1, 1], [10, 10], [11, 2]]) cv.put(x0 + x, y, 0xe6b0ff)
}

export function weaponIconStrip() {
  const cv = new Canvas(12 * ICONS.length, 12)
  ICONS.forEach((rows, i) => {
    if (rows === null) return blackholeIcon(cv, i * 12)
    rows.forEach((r) => {
      if (r.length !== 12) throw new Error(`ícono ${i} con fila de ${r.length}`)
    })
    if (rows.length !== 12) throw new Error(`ícono ${i} con ${rows.length} filas`)
    cv.sprite(rows, i * 12, 0, ICON_PAL)
  })
  return cv
}
