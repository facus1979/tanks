// Tanques, cañones, tripulantes y retratos. Grillas y paletas del look-test aprobado.
import {
  Canvas, OUT, mix, mul, hash, rnd, TANK, TANK_W, TANK_H, TREAD_H, PIVOT, HULLS, STRIPES, tankPal, treads, barrel,
  CREW_BANDANA, CREW_SARGE, SKIN, BANDANA_PAL, SARGE_PAL,
} from './pixel.mjs'

// ---------- tanque ----------

export function tankBody(i) {
  const cv = new Canvas(TANK_W, TANK_H)
  cv.sprite(TANK, 0, 0, tankPal(HULLS[i], STRIPES[i]))
  treads(cv, 0, TANK.length)
  return cv
}

const WRECK_HULL = { D: 0x141110, d: 0x201b18, m: 0x2e2621, l: 0x40352d, h: 0x54463a }
const WRECK_STRIPE = [0x2a1a14, 0x3e261a]

export function tankWreck() {
  const cv = new Canvas(TANK_W, TANK_H)
  // cañón partido colgando hacia adelante
  const stub = [
    [20, 2], [21, 2], [22, 3], [23, 3], [24, 4], [25, 4],
    [20, 3], [21, 3], [22, 4], [23, 4], [24, 5], [25, 5],
  ]
  for (const [x, y] of stub) cv.put(x, y, WRECK_HULL.m)
  cv.put(26, 5, 0x3a3a34)
  cv.put(26, 6, 0x24221e)
  cv.outline(OUT)
  cv.sprite(TANK, 0, 0, { ...tankPal(WRECK_HULL, WRECK_STRIPE), y: 0x5a3a20, Y: 0x7a4a24, v: 0x0a0806 })
  treads(cv, 0, TANK.length)
  // tapa de la torreta arrancada: borde irregular
  for (const [x, y] of [[11, 0], [12, 0], [13, 0], [14, 0], [15, 0], [12, 1], [13, 1], [14, 1]]) cv.clear(x, y)
  for (const [x, y] of [[10, 0], [16, 0], [11, 1], [15, 1], [12, 2], [13, 2], [14, 2]]) cv.put(x, y, OUT)
  for (const [x, y] of [[13, 1], [12, 1], [14, 1]]) cv.put(x, y, 0x0a0605)
  // hollín, chapa levantada y brasas
  for (let y = 0; y < TANK.length; y++) {
    for (let x = 0; x < TANK_W; x++) {
      if (!cv.alpha(x, y) || cv.get(x, y) === OUT) continue
      const n = rnd(x, y, 601)
      if (n > 0.8) cv.put(x, y, mul(cv.get(x, y), 0.6))
      else if (n < 0.06) cv.put(x, y, mix(cv.get(x, y), 0x7a6a5a, 0.35))
    }
  }
  const embers = [[9, 4, 0xf77a28], [16, 5, 0xffb43e], [5, 9, 0xd24a1c], [22, 10, 0xf77a28], [13, 9, 0xffe27a], [18, 3, 0xd24a1c]]
  for (const [x, y, c] of embers) cv.put(x, y, c)
  // una rueda suelta
  cv.put(23, 17, 0x1a1512)
  cv.put(24, 17, 0x1a1512)
  return cv
}

// Tiras de cañón: 19 frames, 0..90° en pasos de 5°. Calcula la celda mínima que entra en todos los ángulos.
export const BARREL_FRAMES = 19
export const BARREL_STEP = 5

export function barrelGeometry() {
  const big = new Canvas(64, 64)
  for (let f = 0; f < BARREL_FRAMES; f++) barrel(big, 32, 32, f * BARREL_STEP, HULLS[0])
  let x0 = 64
  let y0 = 64
  let x1 = 0
  let y1 = 0
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      if (big.alpha(x, y)) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
  return { cell: { w: x1 - x0 + 1, h: y1 - y0 + 1 }, pivot: { x: 32 - x0, y: 32 - y0 } }
}

export function barrelStrip(i, geo) {
  const cv = new Canvas(geo.cell.w * BARREL_FRAMES, geo.cell.h)
  for (let f = 0; f < BARREL_FRAMES; f++) {
    const cell = new Canvas(geo.cell.w, geo.cell.h)
    barrel(cell, geo.pivot.x, geo.pivot.y, f * BARREL_STEP, HULLS[i])
    cv.blit(cell, f * geo.cell.w, 0)
  }
  return cv
}

// Orugas animadas: 4 frames por color. Eslabones con paso de 4 px (arriba avanzan, abajo retroceden),
// ruedas con buje que gira y rayos del color del casco. Frame f+1 = el tanque avanzó 1 px a la derecha.
export const TREAD_FRAMES = 4

function treadFrame(cv, x0, hull, f) {
  const h = TREAD_H
  const link = { groove: 0x16110e, pin: 0x6a5e52, plate: 0x4a3e34, back: 0x2a221c }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < TANK_W; x++) {
      const outer = y === 0 || y === h - 1
      if (outer && (x < 2 || x > TANK_W - 3)) continue
      if ((y === 1 || y === h - 2) && (x < 1 || x > TANK_W - 2)) continue
      const edge = outer || x === 0 || x === TANK_W - 1 || ((y === 1 || y === h - 2) && (x === 1 || x === TANK_W - 2))
      let c = edge ? OUT : link.back
      if (!edge && (y === 1 || y === h - 2)) {
        const k = (((y === 1 ? x - f : x + f) % 4) + 4) % 4
        c = k === 0 ? link.groove : k === 1 ? link.pin : link.plate
        if (y === h - 2 && k !== 0) c = mul(c, 0.8)
      }
      // tacos que asoman por los extremos redondeados
      if (edge && !outer && (y === 2 || y === 3)) {
        const k = (((x === 0 ? y + f : y - f) % 4) + 4) % 4
        if (k === 0) c = link.plate
      }
      cv.put(x0 + x, y, c)
    }
  }
  // buje que gira en sentido horario al avanzar
  const bolt = [[-1, -1], [1, -1], [1, 1], [-1, 1]][f % 4]
  for (let i = 0; i < 4; i++) {
    const wx = Math.round(4 + (i * (TANK_W - 9)) / 3)
    const wy = Math.floor(h / 2)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = dx * dx + dy * dy
        if (d > 6) continue
        let c = d >= 4 ? OUT : mix(0x5a5046, hull.d, 0.35)
        if (d > 0 && d < 4 && dx + dy < 0) c = mix(0x7a7064, hull.l, 0.3)
        if (d === 0) c = 0x2a221c
        if (dx === bolt[0] && dy === bolt[1]) c = mix(0xd8ccb8, hull.h, 0.25)
        cv.put(x0 + wx + dx, wy + dy, c)
      }
    }
  }
}

export function treadStrip(i) {
  const cv = new Canvas(TANK_W * TREAD_FRAMES, TREAD_H)
  for (let f = 0; f < TREAD_FRAMES; f++) treadFrame(cv, f * TANK_W, HULLS[i], f)
  return cv
}

// ---------- tripulantes 12×12 ----------

const CREW_ROOKIE = [
  '.....kk.....',
  '....kPPk....',
  '..kkqQqQkk..',
  '.kqQqQqQqQk.',
  '.kYyYyYyYyk.',
  '.hksksskSkh.',
  '..ksfssfSk..',
  '..kswwwwSk..',
  '...kssSSk...',
  '.knnkkkknnk.',
  'knnnnnnnnnnk',
  'ksnnnZnnnnsk',
]
const CREW_DESERT = [
  '...kkkkkk...',
  '..kJHHJHHk..',
  '.kHJHHrHJHk.',
  '.kHHJHHJHHk.',
  '.kkJHHJHHkk.',
  '..kBkSSkBk..',
  '..ksssssSk..',
  '..kBBssBBk..',
  '..kBBBBBBk..',
  '.knkBBBBknk.',
  'knnnkBBknnnk',
  'ksnnnnnnnnsk',
]
const ROOKIE_PAL = {
  s: 0xeab08a, S: 0xb87656, q: 0x3a5a8a, Q: 0x4f78b0, P: 0xf2ece2, Y: 0x2c4670, y: 0x3a5a8a,
  h: 0xe07a2a, f: 0xb0603c, n: 0x3a4454, Z: 0xb0b8c0,
}
const DESERT_PAL = { s: 0xb8784e, S: 0x8a5236, H: 0xe8dcc0, J: 0xb4a482, r: 0xc8302a, B: 0x241810, n: 0x8a7650 }

export const CREW_DEFS = {
  bandana: { rows: CREW_BANDANA, pal: BANDANA_PAL },
  sarge: { rows: CREW_SARGE, pal: SARGE_PAL },
  rookie: { rows: CREW_ROOKIE, pal: ROOKIE_PAL },
  desert: { rows: CREW_DESERT, pal: DESERT_PAL },
}

export function crewSprite(id) {
  const d = CREW_DEFS[id]
  const cv = new Canvas(12, 12)
  cv.sprite(d.rows, 0, 0, { k: OUT, ...SKIN, ...d.pal })
  return cv
}

// ---------- retratos 32×32 ----------

const HEAD = {}
HEAD[3] = [12, 19]
HEAD[4] = [10, 21]
HEAD[5] = [9, 22]
for (let y = 6; y <= 20; y++) HEAD[y] = [8, 23]
HEAD[21] = [9, 22]
HEAD[22] = [9, 22]
HEAD[23] = [10, 21]
HEAD[24] = [11, 20]
HEAD[25] = [12, 19]
const TORSO = { 26: [7, 24], 27: [4, 27], 28: [2, 29], 29: [1, 30], 30: [1, 30], 31: [1, 30] }

export const inHead = (x, y) => HEAD[y] && x >= HEAD[y][0] && x <= HEAD[y][1]

function portraitBase(skin, shirt) {
  const cv = new Canvas(32, 32)
  for (const [ys, [l, r]] of Object.entries(TORSO)) {
    const y = +ys
    for (let x = l; x <= r; x++) {
      const rel = (x - l) / (r - l)
      cv.put(x, y, rel < 0.22 ? shirt.m : rel > 0.74 ? shirt.N : shirt.n)
    }
  }
  for (let y = 21; y <= 27; y++) for (let x = 12; x <= 19; x++) cv.put(x, y, x > 17 ? skin.T : skin.S)
  // orejas
  for (let y = 12; y <= 17; y++) {
    cv.put(6, y, y === 12 || y === 17 ? skin.s : skin.l)
    cv.put(7, y, skin.S)
    cv.put(24, y, skin.S)
    cv.put(25, y, y === 12 || y === 17 ? skin.S : skin.T)
  }
  for (const [ys, [l, r]] of Object.entries(HEAD)) {
    const y = +ys
    for (let x = l; x <= r; x++) {
      let c = skin.s
      if (x - l <= 1 && y >= 6 && y <= 20) c = skin.l
      if (r - x <= 2) c = skin.S
      if (r - x === 0 && y >= 14) c = skin.T
      if (y >= 24) c = skin.S
      cv.put(x, y, c)
    }
  }
  // pómulo y sombra bajo la mandíbula
  for (let y = 17; y <= 19; y++) cv.put(21, y, skin.S)
  for (let x = 12; x <= 19; x++) cv.put(x, 26, skin.T)
  return cv
}

const g = (cv, rows, x0, y0, pal) => cv.sprite(rows, x0, y0, { k: OUT, ...pal })

function stubble(cv, skin, y0, dens = 0.55) {
  for (let y = y0; y <= 25; y++)
    for (let x = 8; x <= 23; x++) if (inHead(x, y) && rnd(x, y, 701) > dens && cv.get(x, y) !== OUT) cv.put(x, y, skin.T)
}

// sombra que proyecta el ala del casco/pañuelo sobre la frente
function castShadow(cv, y, skin, rows = 1) {
  for (let yy = y; yy < y + rows; yy++)
    for (let x = 8; x <= 23; x++) {
      const c = cv.get(x, yy)
      if (inHead(x, yy) && (c === skin.s || c === skin.l)) cv.put(x, yy, yy === y ? skin.S : mix(skin.s, skin.S, 0.5))
    }
}

// casquete con sombreado: filas {y: [l, r]}, luz arriba a la izquierda
function dome(cv, rows, pal) {
  const ys = Object.keys(rows).map(Number)
  const last = Math.max(...ys)
  for (const y of ys) {
    const [l, r] = rows[y]
    for (let x = l; x <= r; x++) {
      const rel = (x - l) / Math.max(1, r - l)
      let c = pal.mid
      if (rel < 0.3 && y < last - 1) c = pal.light
      if (rel > 0.75 || y === last) c = pal.dark
      cv.put(x, y, c)
    }
  }
}

function portraitBandana() {
  const skin = { s: 0xd8966c, l: 0xecb48c, S: 0xa2644a, T: 0x7a4a34 }
  const cv = portraitBase(skin, { m: 0x62624a, n: 0x4a4a38, N: 0x34342a })
  // canana cruzada con balas
  for (let x = 4; x <= 27; x++) {
    const y = 26 + Math.round(((x - 4) * 5) / 23)
    cv.put(x, y, 0x5a3a20)
    cv.put(x, y + 1, 0x3a2414)
    if (x % 3 === 0 && x > 5 && x < 26) {
      cv.put(x, y - 1, 0xe2c13d)
      cv.put(x, y, 0xa88a14)
    }
  }
  const band = { light: 0xf0604a, mid: 0xc8302a, dark: 0x8a1e1a }
  dome(cv, { 1: [11, 20], 2: [9, 22], 3: [8, 23], 4: [7, 24], 5: [7, 24], 6: [7, 24], 7: [7, 24], 8: [7, 24] }, band)
  for (let x = 8; x <= 23; x++) cv.put(x, 9, OUT)
  castShadow(cv, 10, skin, 2)
  // pliegues y nudo con puntas al viento
  g(cv, ['...r....r', '....r....r'], 11, 4, { r: band.dark })
  g(cv, ['...BB', '.bBbb', 'bbrbr', 'bb.rb', 'b...b', '....r'], 1, 5, { b: band.mid, B: band.light, r: band.dark })
  // lentes espejados
  g(
    cv,
    ['kkkkkkkkkkkkkkkk', 'kHGgggk..kHGgggk', 'kGggggk..kGggggk', '.kgggk....kgggk.', '..kkk......kkk..'],
    8,
    11,
    { g: 0x141414, G: 0x8ab0d0, H: 0xd8ecf8 },
  )
  g(cv, ['.S.', '.S.', 'lSS', 'STS'], 15, 16, { ...skin })
  stubble(cv, skin, 20)
  g(cv, ['.....k', 'kkkkk.', '.SSS..'], 11, 20, skin)
  g(cv, ['l.', '.l', '.l'], 20, 16, { l: 0xf0c0a0 })
  // puro
  g(cv, ['ccccccCe', 'CCCCCCCe'], 17, 20, { c: 0x7a4a26, C: 0x4a2a14, e: 0xff8a30 })
  cv.put(25, 20, 0xffe27a)
  cv.outline(OUT)
  // humo del puro, encima del contorno
  for (const [x, y, a] of [[25, 18, 0.8], [26, 17, 0.7], [26, 16, 0.6], [25, 15, 0.5], [26, 14, 0.4], [27, 13, 0.3]]) cv.put(x, y, 0xe8e0d4, a)
  return cv
}

function portraitSarge() {
  const skin = { s: 0xd8966c, l: 0xecb48c, S: 0xa2644a, T: 0x7a4a34 }
  const cv = portraitBase(skin, { m: 0x6e6440, n: 0x5a5030, N: 0x3e3820 })
  // cuello de la camisa y chapitas
  g(cv, ['kmmk....kmmk', '.kmmk..kmmk.', '..kk....kk..'], 10, 26, { m: 0x6e6440 })
  g(cv, ['w', 'W'], 15, 29, { w: 0xd0d0c8, W: 0x8a8a84 })
  const helm = { light: 0x6e8040, mid: 0x4a5a2a, dark: 0x323e1c }
  dome(cv, { 0: [12, 19], 1: [9, 22], 2: [8, 23], 3: [7, 24], 4: [7, 24], 5: [6, 25], 6: [6, 25], 7: [6, 25], 8: [6, 25] }, helm)
  // red del casco
  for (let y = 2; y <= 7; y++) for (let x = 7; x <= 24; x++) if ((x + y) % 4 === 0 && rnd(x, y, 7) > 0.3) cv.put(x, y, 0x3a4820)
  for (let x = 4; x <= 27; x++) cv.put(x, 9, x < 7 || x > 24 ? helm.dark : OUT)
  for (let x = 5; x <= 26; x++) cv.put(x, 10, 0x262e14)
  castShadow(cv, 11, skin, 2)
  for (let y = 11; y <= 22; y++) {
    const [l, r] = HEAD[y]
    cv.put(l, y, 0x3a4820)
    cv.put(r, y, 0x262e14)
  }
  cv.put(9, 23, 0xa88a14)
  cv.put(22, 23, 0xa88a14)
  // cejas de enojo, ojos entrecerrados y cicatriz
  g(cv, ['MM.....', 'MMMMM..', '..MMMM.'], 9, 11, { M: 0x3a2214 })
  g(cv, ['.....MM', '..MMMMM', '.MMMM..'], 16, 11, { M: 0x3a2214 })
  g(cv, ['SSSS', 'kwek'], 10, 13, { ...skin, w: 0xf2ece2, e: 0x2a1c14 })
  g(cv, ['SSSS', 'kewk'], 18, 13, { ...skin, w: 0xf2ece2, e: 0x2a1c14 })
  g(cv, ['l', '.l', '.l', '..l'], 12, 11, { l: 0xf0c0a0 })
  g(cv, ['.S.', '.S.', '.SS', 'lSS', 'TST'], 15, 15, skin)
  stubble(cv, skin, 21, 0.6)
  // bigote
  g(cv, ['..bbbbbbbb..', '.MMMMMMMMMM.', 'MMMMkkkkMMMM', 'MM........MM'], 10, 19, { M: 0x3a2214, b: 0x5a3a24 })
  g(cv, ['kkkk'], 14, 22, {})
  cv.put(16, 24, skin.T)
  cv.outline(OUT)
  return cv
}

function portraitRookie() {
  const skin = { s: 0xeab08a, l: 0xf8c8a0, S: 0xc07a58, T: 0x9a5a40 }
  const cv = portraitBase(skin, { m: 0x4e5a6e, n: 0x3a4454, N: 0x2a3240 })
  // capucha y cierre
  g(cv, ['.hhhk....khhh.', 'hhhk......khhh'], 9, 26, { h: 0x4e5a6e })
  for (let y = 27; y <= 31; y++) cv.put(16, y, y % 2 ? 0xb0b8c0 : 0x6a7280)
  // mechones
  g(cv, ['.HH', 'hHh', 'hh.', 'h..'], 5, 9, { h: 0xc8621e, H: 0xf0a050 })
  g(cv, ['HH.', 'hHh', '.hh', '..h'], 24, 9, { h: 0xc8621e, H: 0xf0a050 })
  const cap = { light: 0x5c88c0, mid: 0x3a5a8a, dark: 0x2a4068 }
  dome(cv, { 2: [11, 20], 3: [9, 22], 4: [8, 23], 5: [7, 24], 6: [7, 24], 7: [7, 24] }, cap)
  for (let x = 7; x <= 24; x++) {
    cv.put(x, 8, x % 2 ? 0x2a4068 : 0x3a5a8a)
    cv.put(x, 9, x % 2 ? 0x2a4068 : 0x3a5a8a)
  }
  for (let x = 8; x <= 23; x++) cv.put(x, 10, OUT)
  castShadow(cv, 11, skin)
  g(cv, ['.pP.', 'pPPP', 'pPPp', '.pp.'], 14, 0, { P: 0xf2ece2, p: 0xc0b8ac })
  g(cv, ['hhHhh'], 10, 11, { h: 0xc8621e, H: 0xf0a050 })
  // ojos grandes, cejas levantadas
  g(cv, ['hhh.', '....', 'kkkk', 'wEkw', 'wwww'], 10, 11, { h: 0xc8621e, w: 0xf8f4ee, E: 0x3a7ad0 })
  g(cv, ['.hhh', '....', 'kkkk', 'wEkw', 'wwww'], 18, 11, { h: 0xc8621e, w: 0xf8f4ee, E: 0x3a7ad0 })
  g(cv, ['S', 'S', 'TT'], 16, 16, skin)
  for (const [x, y] of [[10, 17], [12, 17], [11, 18], [13, 18], [19, 18], [21, 17], [20, 18]]) cv.put(x, y, 0xc06a44)
  // sonrisa con dientes
  g(cv, ['k........k', '.kkkkkkkk.', '.kwwwwwwk.', '..kkkkkk..'], 11, 19, { w: 0xf8f4ee })
  cv.outline(OUT)
  g(cv, ['.w.', 'wbw', 'bBb', '.b.'], 25, 11, { w: 0xf8fcff, b: 0x8ac8f0, B: 0x4a8ad0 })
  return cv
}

function portraitDesert() {
  const skin = { s: 0xb8784e, l: 0xd08e62, S: 0x8a5236, T: 0x6a3a24 }
  const cv = portraitBase(skin, { m: 0xb09a6c, n: 0x8a7650, N: 0x5a4a30 })
  // barba grande: mejillas, mandíbula y sobre el pecho
  const beard = (x, y) => {
    if (y >= 26 && y <= 30) {
      const hw = 6 - (y - 26)
      return x >= 16 - hw && x <= 15 + hw
    }
    if (!inHead(x, y) && !(y >= 21 && y <= 27 && x >= 12 && x <= 19)) return false
    return y >= 20 || (y >= 16 && (x <= 10 || x >= 21))
  }
  for (let y = 15; y <= 31; y++) {
    for (let x = 4; x <= 27; x++) {
      if (!beard(x, y)) continue
      const n = rnd(x, y, 801)
      let c = 0x241810
      if ((x + y * 3) % 5 === 0 && n > 0.2) c = 0x3e2a1c
      if (x < 13 && n > 0.6) c = 0x4a3424
      cv.put(x, y, c)
    }
  }
  // pañuelo que cae del turbante sobre el hombro
  g(cv, ['JJ', 'HJ', 'HHJ', 'HHJ', '.HHJ', '.HHJ', '..HJ'], 3, 13, { H: 0xe8dcc0, J: 0xb4a482 })
  // turbante con vueltas en diagonal
  const rows = { 0: [12, 19], 1: [9, 22], 2: [7, 24], 3: [6, 25], 4: [6, 25], 5: [6, 25], 6: [6, 25], 7: [6, 25], 8: [6, 25], 9: [7, 24], 10: [7, 24] }
  for (const [ys, [l, r]] of Object.entries(rows)) {
    const y = +ys
    for (let x = l; x <= r; x++) {
      const rel = (x - l) / (r - l)
      const fold = (x + y * 2) % 7
      let c = 0xe8dcc0
      if (fold === 0) c = 0x8a7a5a
      else if (fold === 1 || rel > 0.78) c = 0xb4a482
      else if (rel < 0.25 && fold > 3) c = 0xfaf2e0
      if (y === 10) c = 0x8a7a5a
      cv.put(x, y, c)
    }
  }
  g(cv, ['.y.', 'yry', 'yRy', '.y.'], 15, 3, { y: 0xe2c13d, r: 0xc8302a, R: 0xff8a70 })
  for (let x = 8; x <= 23; x++) cv.put(x, 11, OUT)
  castShadow(cv, 12, skin, 2)
  // cejas pesadas y mirada dura
  g(cv, ['BB....', '.BBBBB'], 9, 12, { B: 0x1a100a })
  g(cv, ['....BB', 'BBBBB.'], 17, 12, { B: 0x1a100a })
  g(cv, ['SSSS', 'kwek'], 10, 14, { ...skin, w: 0xe8e0d0, e: 0x2a1408 })
  g(cv, ['SSSS', 'kewk'], 18, 14, { ...skin, w: 0xe8e0d0, e: 0x2a1408 })
  g(cv, ['.S', '.S', '.S', 'lSS', 'TSST'], 15, 15, skin)
  // bigote y boca
  g(cv, ['.bbbbbbbbb.', 'BBBBBBBBBBB', 'BB.kkkkk.BB'], 10, 19, { B: 0x1a100a, b: 0x3e2a1c })
  cv.outline(OUT)
  g(cv, ['.y', 'y.', '.Y'], 5, 17, { y: 0xe2c13d, Y: 0xfff1a8 })
  return cv
}

const PORTRAITS = { bandana: portraitBandana, sarge: portraitSarge, rookie: portraitRookie, desert: portraitDesert }
export const portrait = (id) => PORTRAITS[id]()

export { PIVOT, TANK_W, TANK_H, HULLS, STRIPES, hash }
