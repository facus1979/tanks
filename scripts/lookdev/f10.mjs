// F10-F11: íconos de ítems (12×12), paracaídas abierto y logo del título.
import { Canvas, OUT, mix, mul, bayer, rnd, TANK_W, TANK_H, PIVOT, HULLS, STRIPES, barrel, antenna } from './pixel.mjs'
import { tankBody } from './characters.mjs'

// ---------- íconos de ítems: escudo, paracaídas, bidón, botiquín, mira ----------

const ITEM_PAL = {
  k: OUT, W: 0xfffbe2, Y: 0xffe27a, y: 0xd2a238,
  A: 0x5aa0f0, a: 0x2f6ac0, n: 0x1c3a80,
  R: 0xe0463a, r: 0x8e1e1a, L: 0xf28a6e, S: 0xb0aa9a, s: 0x7a7468,
  O: 0xf77a28, B: 0x8a6a44,
}

const ITEM_ICONS = [
  // escudo: blindaje azul con cruz dorada
  [
    '.kkkkkkkkkk.',
    'kWAAAYaaaank',
    'kWAAAYaaaank',
    'kAYYYYYYYaak',
    'kAAAAYaaaank',
    'kAAAAYaaaank',
    '.kAAAYaaank.',
    '.kAAAYaaank.',
    '..kAAYaank..',
    '...kAYaak...',
    '....kaak....',
    '.....kk.....',
  ],
  // paracaídas: cúpula a rayas y cuerdas hacia la caja
  [
    '...kkkkkk...',
    '.kkRRWWRRkk.',
    'kRRRRWWRRRRk',
    'kRRRWWWWRRRk',
    'kkRkRWWRkRkk',
    'k.k.kRRk.k.k',
    '.k..k..k..k.',
    '..k..k..k.k.',
    '...k.k..k.k.',
    '....k....k..',
    '...kBBBBBk..',
    '...kkkkkkk..',
  ],
  // bidón de combustible rojo con tapa naranja y cruz estampada
  [
    '..kkkkkk.kk.',
    '.kRRRRRRkOOk',
    '.kkkkkkkkkk.',
    'kRLRRRRRRrk.',
    'kLRRRkRRRrk.',
    'kRRRkkkRRrk.',
    'kRRRRkRRRrk.',
    'kRRRRRRRRrk.',
    'kRkkkkkkRrk.',
    'kRRRRRRRRrk.',
    'krrrrrrrrrk.',
    '.kkkkkkkkkk.',
  ],
  // botiquín: maletín blanco con cruz roja
  [
    '...kkkkkk...',
    '...kSkkSk...',
    '.kkkkkkkkkk.',
    'kWWWWWWWWWSk',
    'kWWWWRRWWWSk',
    'kWWWWRRWWWSk',
    'kWWRRRRRRWSk',
    'kWWRRRRRRWSk',
    'kWWWWRRWWWSk',
    'kWWWWRRWWWSk',
    'kSSSSSSSSSSk',
    '.kkkkkkkkkk.',
  ],
]

export function itemIconStrip() {
  const cv = new Canvas(12 * 9, 12) // v3: 9 ítems en el orden de ITEM_ORDER
  ITEM_ICONS.forEach((rows, i) => {
    if (rows.length !== 12) throw new Error(`ítem ${i} con ${rows.length} filas`)
    rows.forEach((r) => {
      if (r.length !== 12) throw new Error(`ítem ${i} con fila de ${r.length}: ${r}`)
    })
    cv.sprite(rows, i * 12, 0, ITEM_PAL)
  })
  // mira del trazador: anillo verde, retícula roja, punto amarillo
  const x0 = 4 * 12
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const d = Math.hypot(x - 5.5, y - 5.5)
      const cross = (x === 5 || x === 6 || y === 5 || y === 6) && d > 1.8
      let c = null
      if (d < 1.6) c = 0xffe27a
      else if (cross && d < 6.2) c = d > 4 && d < 5.4 ? 0x8ad05a : 0xe0463a
      else if (d >= 4 && d < 5.4) c = 0x8ad05a
      else if (d >= 5.4 && d < 6.4) c = OUT
      else if (d < 4) c = 0x1c2a18
      if (c !== null) cv.put(x0 + x, y, c)
    }
  }
  // v3 (ITEM_ORDER 6 a 9): jetpack, teletransporte, ancla, deflector
  cv.sprite(JETPACK, 5 * 12, 0, ITEM_PAL)
  teleportIcon(cv, 6 * 12)
  cv.sprite(ANCHOR, 7 * 12, 0, ITEM_PAL)
  deflectorIcon(cv, 8 * 12)
  return cv
}

// jetpack: dos tubos rojos con correa, toberas y llamas
const JETPACK = [
  '..kkk..kkk..',
  '.kLRrkkLRrk.',
  '.kRRrkkRRrk.',
  '.kRRrSSRRrk.',
  '.kRRrkkRRrk.',
  '.kRRrkkRRrk.',
  '.kkkkkkkkkk.',
  '..kSk..kSk..',
  '..kYk..kYk..',
  '..YOY..YOY..',
  '...O....O...',
  '...O....O...',
]

// ancla de acero: argolla, cepo y uñas
const ANCHOR = [
  '....kkkk....',
  '...kSkkSk...',
  '....kSsk....',
  '..kkkSskkk..',
  '..kWSSSssk..',
  '..kkkSskkk..',
  '....kSsk....',
  'kk..kSsk..kk',
  'kSk.kSsk.ksk',
  '.kSkkSskksk.',
  '..kSSSssssk.',
  '...kkkkkkk..',
]

// teletransporte: plataforma con un haz celeste tramado que sube y destellos
function teleportIcon(cv, x0) {
  for (let y = 0; y < 10; y++) {
    for (let x = 1; x < 11; x++) {
      const d = Math.abs(x - 5.5)
      // más denso en el centro y abajo; núcleo blanco
      const k = (1 - d / 5) * (0.35 + (y / 10) * 0.65)
      if (d < 1) cv.put(x0 + x, y, y > 1 ? 0xffffff : 0xc8f4ff)
      else if (bayer(x, y) < k) cv.put(x0 + x, y, d < 3 ? 0xa8ecff : 0x5aa0f0)
    }
  }
  // plataforma: elipse con canto celeste encendido
  for (let y = 8; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const e = Math.hypot((x - 5.5) / 6, (y - 9.6) / 2.2)
      if (e > 1) continue
      cv.put(x0 + x, y, e > 0.8 || y === 11 ? OUT : y < 10 ? 0x7ad8f0 : 0x7a7468)
    }
  }
  for (const [x, y] of [[1, 1], [10, 3], [0, 5]]) {
    cv.put(x0 + x, y, 0xffffff)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (x + dx >= 0 && x + dx < 12) cv.put(x0 + x + dx, y + dy, 0x7ad8f0)
  }
}

// deflector: escudo curvo celeste (un arco que mira a la izquierda) y un tiro que rebota en él
function deflectorIcon(cv, x0) {
  // arco de radio 7 centrado afuera a la derecha
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const d = Math.hypot(x - 14, y - 5.5)
      if (d < 6.2 || d > 9.3) continue
      cv.put(x0 + x, y, d < 7 || d > 8.6 ? OUT : d < 7.7 ? 0xffffff : 0x5aa0f0)
    }
  }
  // tiro que entra desde abajo a la izquierda, pega y sale para arriba (punteado amarillo, punta roja)
  for (const [x, y] of [[0, 10], [1, 9], [3, 8], [4, 7]]) cv.put(x0 + x, y, 0xffe27a)
  for (const [x, y] of [[4, 4], [3, 3], [2, 2]]) cv.put(x0 + x, y, 0xffe27a)
  cv.put(x0 + 5, 5, 0xffffff)
  cv.put(x0 + 5, 6, 0xffe27a)
  cv.rect(x0, 0, 2, 2, 0xe0463a)
  cv.put(x0 + 2, 0, OUT)
  cv.put(x0, 2, OUT)
}

// ---------- paracaídas abierto 20×16 ----------

export function parachuteProp() {
  const W = 20
  const cv = new Canvas(W, 16)
  const DARK = [0x3a4a22, 0x6e8040, 0x8a9c56]
  const SAND = [0x9c8a5c, 0xd2c290, 0xeee0b0]
  for (let y = 1; y <= 9; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x - 9.5) / 10
      const ny = (9 - y) / 8.6
      if (nx * nx + ny * ny > 1) continue
      const panel = Math.floor(x / 4)
      // festón en el borde inferior: cada panel cuelga un pixel en el medio
      const mid = x % 4 === 1 || x % 4 === 2
      if (y === 9 && !mid) continue
      const pal = panel % 2 ? SAND : DARK
      // luz arriba a la izquierda, sombra abajo a la derecha, con dithering
      const t = (x / W) * 0.55 + ((y - 1) / 9) * 0.45
      let k = t < 0.28 ? 2 : t < 0.62 ? 1 : 0
      if (Math.abs(t - 0.28) < 0.06 && bayer(x, y) > 0.5) k = 1
      if (Math.abs(t - 0.62) < 0.06 && bayer(x, y) > 0.5) k = 0
      cv.put(x, y, pal[k])
    }
  }
  cv.outline(OUT)
  // cuerdas del festón al centro de abajo
  for (const sx of [1, 5, 9, 13, 17]) {
    const y0 = 10
    for (let y = y0; y <= 15; y++) {
      const x = Math.round(sx + ((9.5 - sx) * (y - y0)) / (15 - y0))
      if (cv.alpha(x, y) === 0) cv.put(x, y, 0x3a3020)
    }
  }
  cv.put(9, 15, 0x3a3020)
  cv.put(10, 15, 0x3a3020)
  return cv
}

// ---------- logo TANKS 320×96 ----------

const LW = 50
const LH = 54
const LETTERS = {
  T: { add: [[[0, 0], [50, 0], [50, 13], [32, 13], [32, 54], [18, 54], [18, 13], [0, 13]]] },
  A: {
    add: [[[0, 54], [16, 0], [34, 0], [50, 54], [36, 54], [33, 41], [17, 41], [14, 54]]],
    hole: [[[20, 28], [30, 28], [25, 12]]],
  },
  N: { add: [[[0, 0], [15, 0], [35, 32], [35, 0], [50, 0], [50, 54], [35, 54], [15, 22], [15, 54], [0, 54]]] },
  K: { add: [[[0, 0], [15, 0], [15, 20], [33, 0], [50, 0], [28, 26], [50, 54], [33, 54], [18, 34], [15, 37], [15, 54], [0, 54]]] },
  S: {
    add: [
      [[9, 0], [50, 0], [50, 15], [36, 15], [36, 13], [16, 13], [16, 19], [50, 19], [50, 54], [10, 54], [0, 44], [0, 39], [14, 39], [14, 41], [34, 41], [34, 35], [0, 35], [0, 9]],
    ],
  },
}

function inPoly(poly, x, y) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// tanque con cañón como lo arma el juego, con el color de casco i
function tankSprite(i, angle, flip) {
  const t = new Canvas(TANK_W + 24, TANK_H + 24)
  const ox = 12
  const oy = 16
  antenna(t, ox + 9, oy, STRIPES[i][1])
  barrel(t, ox + PIVOT.x, oy + PIVOT.y, angle, HULLS[i])
  t.blit(tankBody(i), ox, oy)
  const out = new Canvas(t.w, t.h)
  out.blit(t, 0, 0, flip)
  return { cv: out, ox: flip ? t.w - ox - TANK_W : ox, oy }
}

export function logo() {
  const W = 320
  const H = 96
  const cv = new Canvas(W, H)
  const at = (m, x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : m[y * W + x])

  // máscara de letras con inclinación
  const mask = new Uint8Array(W * H)
  const SHEAR = 0.14
  const GAP = 5
  const names = ['T', 'A', 'N', 'K', 'S']
  const total = names.length * LW + (names.length - 1) * GAP + Math.round(LH * SHEAR)
  const x0 = Math.round((W - total) / 2)
  const y0 = 5
  names.forEach((n, k) => {
    const L = LETTERS[n]
    const bx = x0 + k * (LW + GAP)
    for (let ly = 0; ly < LH; ly++) {
      const sh = Math.round((LH - ly) * SHEAR)
      for (let lx = 0; lx < LW; lx++) {
        const px = lx + 0.5
        const py = ly + 0.5
        if (!L.add.some((p) => inPoly(p, px, py))) continue
        if (L.hole && L.hole.some((p) => inPoly(p, px, py))) continue
        mask[(y0 + ly) * W + bx + lx + sh] = 1
      }
    }
  })
  const dilate = (src, r) => {
    const out = new Uint8Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (src[y * W + x]) {
          out[y * W + x] = 1
          continue
        }
        let hit = 0
        for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1 && at(src, x + dx, y + dy)) { hit = 1; break }
        out[y * W + x] = hit
      }
    return out
  }
  const outer = dilate(mask, 2)

  // 1. explosión detrás: bola de fuego con picos, contorno negro y dithering
  const cx = W / 2
  const cy = 36
  const burst = new Canvas(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 1.9
      const dy = y - cy
      const d = Math.hypot(dx, dy)
      const a = Math.atan2(dy, dx)
      const spikes = 1 + 0.22 * Math.sin(a * 9 + 0.7) + 0.12 * Math.sin(a * 17) + 0.1 * Math.sin(a * 5 + 2)
      const R = 42 * spikes
      if (d > R) continue
      const t = d / R
      const j = t + (bayer(x, y) - 0.5) * 0.16
      const c = j < 0.3 ? 0xfff1a8 : j < 0.55 ? 0xffc23a : j < 0.78 ? 0xf77a28 : j < 0.92 ? 0xc8401c : 0x6a2a1c
      burst.put(x, y, c)
    }
  }
  burst.outline(OUT)
  cv.blit(burst, 0, 0)

  // 2. suelo: franja de tierra con pasto abajo
  const gy = (x) => 84 + Math.round(Math.sin(x / 19) * 1.5 + Math.sin(x / 7) * 0.8)
  for (let x = 0; x < W; x++) {
    const s = gy(x)
    for (let y = s; y < H; y++) {
      let c = y === s ? 0x2f5a24 : y === s + 1 ? 0x24421c : y < s + 3 ? 0x4a3826 : 0x2a1c12
      if (y > s + 2 && ((x >> 1) + (y >> 1)) % 3 === 0) c = 0x3a2a1c
      cv.put(x, y, c)
    }
    if (rnd(x, 1, 91) > 0.55) cv.put(x, s - 1, 0x4a8a34)
  }

  // 3. sombra proyectada y contorno de letras
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (at(outer, x - 3, y - 4) && !at(outer, x, y)) cv.put(x, y, 0x140e0a, 0.7)
      if (at(outer, x, y)) cv.put(x, y, OUT)
    }

  // 4. cara: degradé fuego-metal con dithering, bisel y línea especular
  const BAND = [0xfff6c8, 0xffe27a, 0xf7b232, 0xe8762a, 0xc8401c, 0x8e1e1a]
  const eDist = (x, y) => {
    for (let e = 1; e <= 3; e++) {
      for (const [dx, dy] of [[e, 0], [-e, 0], [0, e], [0, -e]]) if (!at(mask, x + dx, y + dy)) return e
    }
    return 4
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!at(mask, x, y)) continue
      const t = (y - y0) / LH
      const g = t * (BAND.length - 1.4) + (bayer(x, y) - 0.5) * 0.9
      const i = Math.max(0, Math.min(BAND.length - 1, Math.round(g)))
      let c = BAND[i]
      const e = eDist(x, y)
      const upLeft = !at(mask, x - e, y) || !at(mask, x, y - e)
      const downRight = !at(mask, x + e, y) || !at(mask, x, y + e)
      if (e === 1 && upLeft) c = mix(c, 0xffffff, 0.75)
      else if (e === 2 && upLeft) c = mix(c, 0xffffff, 0.3)
      else if (e <= 2 && downRight) c = mul(c, e === 1 ? 0.45 : 0.68)
      else if (e === 3 && downRight) c = mul(c, 0.85)
      // brillo metálico: línea clara a un tercio de la altura
      if (y - y0 === 17 && e > 1) c = mix(c, 0xffffff, 0.35)
      cv.put(x, y, c)
    }
  }

  // 5. tanques a los lados sobre el suelo
  const place = (i, angle, flip, x, ground) => {
    const s = tankSprite(i, angle, flip)
    cv.blit(s.cv, x - s.ox, ground - TANK_H - s.oy)
  }
  place(0, 40, false, 22, gy(36) + 2)
  place(1, 35, true, 270, gy(284) + 2)

  return cv
}
