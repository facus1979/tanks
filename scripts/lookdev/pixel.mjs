// Utilidades de pixel art compartidas por look-test.mjs y paint-assets.mjs.
// Raster RGBA, color, ruido determinista, paletas, grillas de sprites y texturas por material.
import zlib from 'node:zlib'

// ---------- color ----------

export const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
export const c8 = (v) => Math.max(0, Math.min(255, Math.round(v)))
export const pack = (r, g, b) => (c8(r) << 16) | (c8(g) << 8) | c8(b)
export function mix(a, b, t) {
  const A = rgb(a)
  const B = rgb(b)
  return pack(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t)
}
export const mul = (c, k) => {
  const A = rgb(c)
  return pack(A[0] * k, A[1] * k, A[2] * k)
}

// ---------- ruido determinista ----------

export function hash(x, y, s = 0) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return (n ^ (n >>> 16)) >>> 0
}
export const rnd = (x, y, s = 0) => hash(x, y, s) / 4294967296

// mulberry32 con semilla reasignable (look-test la reinicia entre secciones)
export function makeRand(initial = 1337) {
  const r = { seed: initial }
  r.next = () => {
    r.seed = (r.seed + 0x6d2b79f5) >>> 0
    let t = r.seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return r
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
export const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

export function noise1(x, scale, s) {
  const t = x / scale
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return rnd(i, 0, s) * (1 - u) + rnd(i + 1, 0, s) * u
}

// ruido 1D periódico (período en celdas de `scale`) para fondos que no se repiten con costura
export function noiseLoop(x, scale, period, s) {
  const t = x / scale
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  const m = (k) => ((k % period) + period) % period
  return rnd(m(i), 0, s) * (1 - u) + rnd(m(i + 1), 0, s) * u
}

export function gradient(stops, t) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1]
      const [t1, b] = stops[i]
      return mix(a, b, (t - t0) / (t1 - t0))
    }
  }
  return stops[stops.length - 1][1]
}

// ---------- raster ----------

export class Canvas {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.px = new Uint8ClampedArray(w * h * 4)
  }
  put(x, y, c, a = 1) {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const px = this.px
    const i = (y * this.w + x) * 4
    const [r, g, b] = rgb(c)
    const da = px[i + 3]
    if (a >= 1) {
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = 255
    } else if (da === 255) {
      px[i] += (r - px[i]) * a
      px[i + 1] += (g - px[i + 1]) * a
      px[i + 2] += (b - px[i + 2]) * a
    } else if (a > 0) {
      const d = da / 255
      const oa = a + d * (1 - a)
      px[i] = (r * a + px[i] * d * (1 - a)) / oa
      px[i + 1] = (g * a + px[i + 1] * d * (1 - a)) / oa
      px[i + 2] = (b * a + px[i + 2] * d * (1 - a)) / oa
      px[i + 3] = oa * 255
    }
  }
  // tiñe solo lo que ya está pintado (no agrega alfa): niebla sobre capas transparentes
  tint(x, y, c, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return
    const px = this.px
    const i = (y * this.w + x) * 4
    if (px[i + 3] === 0) return
    const [r, g, b] = rgb(c)
    px[i] += (r - px[i]) * a
    px[i + 1] += (g - px[i + 1]) * a
    px[i + 2] += (b - px[i + 2]) * a
  }
  get(x, y) {
    const i = (y * this.w + x) * 4
    return (this.px[i] << 16) | (this.px[i + 1] << 8) | this.px[i + 2]
  }
  alpha(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0
    return this.px[(y * this.w + x) * 4 + 3]
  }
  clear(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.px.fill(0, (y * this.w + x) * 4, (y * this.w + x) * 4 + 4)
  }
  rect(x, y, w, h, c, a = 1) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, c, a)
  }
  line(x0, y0, x1, y1, c, width = 1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2)
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const x = x0 + (x1 - x0) * t
      const y = y0 + (y1 - y0) * t
      for (let w = 0; w < width; w++) this.put(Math.floor(x) + (w % 2), Math.floor(y) + Math.floor(w / 2), c)
    }
  }
  // Grilla de caracteres → pixels. '.' (o cualquier letra sin color en pal) es transparente.
  sprite(rows, x0, y0, pal, flip = false) {
    const w = Math.max(...rows.map((r) => r.length))
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = pal[row[x]]
        if (c === undefined) continue
        this.put(x0 + (flip ? w - 1 - x : x), y0 + y, c)
      }
    })
  }
  spriteScaled(rows, x0, y0, pal, s) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = pal[row[x]]
        if (c === undefined) continue
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) this.put(x0 + x * s + dx, y0 + y * s + dy, c)
      }
    })
  }
  disc(cx, cy, r, colorAt, a = 1) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d = Math.hypot(x - cx, y - cy)
        if (d <= r) this.put(x, y, colorAt(d, x, y), a)
      }
    }
  }
  haze(a, fog) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.put(x, y, fog, a)
  }
  // copia otro canvas encima (alfa 0 no pisa)
  blit(src, x0, y0, flip = false) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4
        const a = src.px[i + 3]
        if (!a) continue
        const c = (src.px[i] << 16) | (src.px[i + 1] << 8) | src.px[i + 2]
        this.put(x0 + (flip ? src.w - 1 - x : x), y0 + y, c, a / 255)
      }
    }
  }
  // contorno de 1 px alrededor de lo opaco
  outline(c) {
    const add = []
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.alpha(x, y)) continue
        if (this.alpha(x + 1, y) || this.alpha(x - 1, y) || this.alpha(x, y + 1) || this.alpha(x, y - 1)) add.push([x, y])
      }
    }
    for (const [x, y] of add) this.put(x, y, c)
  }
  png() {
    return encodePng(this.w, this.h, this.px)
  }
  // PNG ampliado con vecino más cercano, opcionalmente un recorte; alfa 0 → fondo
  scaledPng(s, x0 = 0, y0 = 0, w = this.w, h = this.h, opaque = true) {
    const out = new Uint8ClampedArray(w * s * h * s * 4)
    for (let y = 0; y < h * s; y++) {
      for (let x = 0; x < w * s; x++) {
        const i = ((y0 + Math.floor(y / s)) * this.w + x0 + Math.floor(x / s)) * 4
        const j = (y * w * s + x) * 4
        out[j] = this.px[i]
        out[j + 1] = this.px[i + 1]
        out[j + 2] = this.px[i + 2]
        out[j + 3] = opaque ? 255 : this.px[i + 3]
      }
    }
    return encodePng(w * s, h * s, out)
  }
}

// Canvas periódico en x (v2.3, capas de fondo con repeat 'wrap'): todo lo que se pinta fuera de [0, w) entra
// por el otro borde (x módulo w). Un árbol, una nube o un humo que cruza el borde derecho sigue en el izquierdo
// con los mismos pixels (el ruido por pixel usa la x sin envolver, así que no hay costura dentro del elemento),
// y la capa repetida una al lado de la otra empalma pixel a pixel. En y no envuelve.
export class WrapCanvas extends Canvas {
  wx(x) {
    const w = this.w
    return ((Math.round(x) % w) + w) % w
  }
  put(x, y, c, a = 1) {
    super.put(this.wx(x), y, c, a)
  }
  tint(x, y, c, a) {
    super.tint(this.wx(x), y, c, a)
  }
  get(x, y) {
    return super.get(this.wx(x), y)
  }
  alpha(x, y) {
    return super.alpha(this.wx(x), y)
  }
  clear(x, y) {
    super.clear(this.wx(x), y)
  }
}

// ---------- PNG ----------

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---------- paletas (sacadas de la referencia del bosque con niebla) ----------

export const FOG = 0xf0dfc8
export const OUT = 0x140e0a

// ---------- bosque: cielo, pinos y torre de agua ----------

// `target` expone layer(i) → Canvas y fog(alphaAt(x, y), color), que tiñe todo lo pintado hasta ahora.
// En look-test todas las capas son el mismo canvas; en paint-assets son capas separadas con alfa.
export function paintForestSky(cv) {
  const stops = [
    [0, 0xc4ad8e],
    [0.3, 0xd9c3a4],
    [0.62, 0xebd8bf],
    [0.85, 0xf3e4cf],
    [1, 0xf6e9d7],
  ]
  const { w: W, h: H } = cv
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = Math.floor((y / H) * 22 + bayer(x, y)) / 22
      let c = gradient(stops, Math.min(1, t))
      const d = Math.hypot(x - 583, (y - 92) * 1.2)
      const g = Math.max(0, 1 - d / 267)
      const gq = Math.floor(g * g * 8 + bayer(x + 1, y)) / 8
      c = mix(c, 0xfff7e8, gq * 0.75)
      cv.put(x, y, c)
    }
  }
}

export function pine(cv, cx, base, h, pal, s, bare = 0) {
  const top = base - h
  const cb = base - Math.round(h * (0.08 + bare))
  const ch = cb - top
  const tiers = Math.max(3, Math.round(ch / 14))
  const maxW = h * 0.23
  const tw = h > 110 ? 2 : 1
  for (let y = top + 3; y < base; y++) {
    for (let x = -tw + 1; x <= 0; x++) cv.put(cx + x, y, pal.trunk ?? pal.dark)
    if (tw > 1 && pal.light) cv.put(cx - tw + 1, y, mix(pal.trunk ?? pal.dark, pal.light, 0.4))
  }
  for (let y = top; y < cb; y++) {
    const u = (y - top) / ch
    const tv = (u * tiers) % 1
    const grow = 1 + u * maxW
    const hwL = grow * (0.3 + 0.7 * tv) + (rnd(y, 1, s) - 0.5) * 1.6
    const hwR = grow * (0.3 + 0.7 * tv) + (rnd(y, 2, s) - 0.5) * 1.6
    const l = Math.round(cx - hwL)
    const r = Math.round(cx + hwR)
    for (let x = l; x <= r; x++) {
      let c = pal.dark
      if (pal.light) {
        const rel = (x - l) / Math.max(1, r - l)
        const n = rnd(x, y, s)
        if (rel < 0.28 && tv < 0.75 && n > 0.3) c = pal.light
        else if (rel > 0.3 && rel < 0.6 && tv < 0.4 && n > 0.82) c = pal.light
        else if (pal.shade && (rel > 0.72 || tv > 0.85) && n > 0.35) c = pal.shade
      }
      cv.put(x, y, c)
    }
    // puntas caídas al final de cada piso
    if (tv > 0.88 && pal.light) {
      cv.put(l - 1, y + 1, pal.dark)
      cv.put(r + 1, y + 1, pal.shade ?? pal.dark)
    }
  }
}

export function waterTower(cv, x0, base, c, h = 150) {
  const top = base - h
  const legs = [x0, x0 + 34]
  for (let y = top + 30; y < base; y++) {
    const t = (y - top - 30) / (base - top - 30)
    const spread = Math.round(t * 8)
    cv.put(legs[0] - spread, y, c)
    cv.put(legs[0] - spread + 1, y, c)
    cv.put(legs[1] + spread, y, c)
    cv.put(legs[1] + spread + 1, y, c)
  }
  for (let k = 0; k < 5; k++) {
    const y0 = top + 32 + k * 24
    const y1 = y0 + 24
    const t0 = (y0 - top - 30) / (base - top - 30)
    const t1 = (y1 - top - 30) / (base - top - 30)
    cv.line(legs[0] - t0 * 8, y0, legs[1] + t1 * 8, y1, c)
    cv.line(legs[1] + t0 * 8, y0, legs[0] - t1 * 8, y1, c)
    cv.line(legs[0] - t0 * 8, y0, legs[1] + t0 * 8, y0, c)
  }
  cv.rect(x0 - 8, top + 4, 52, 26, c)
  for (let i = 0; i < 8; i++) cv.rect(x0 - 8 + i * 3, top + 4 - i, 52 - i * 6, 1, c)
  cv.rect(x0 + 16, top - 8, 2, 6, c)
}

// Fondo del bosque de la referencia. Capas: 0 cielo, 1 pinos lejanos, 2 torre + pinos medios,
// 3 pinos grises cercanos, 4 pinos verdes. rand con la semilla que dejó el llamador (42 en look-test).
//
// Con `periodic` (las capas del juego, v2.3) las capas 1 a 4 son periódicas en x con período W: el renderer las
// repite tal cual una al lado de la otra (repeat 'wrap') y el borde derecho empalma pixel a pixel con el
// izquierdo. Para eso las capas tienen que ser WrapCanvas (lo que cruza un borde entra por el otro) y los pinos
// se reparten en W justo (separación 32 / 40 / 50 en vez de 33 / 42 / 52, así la densidad es pareja también en
// la unión). Las tiradas de rand son las mismas que sin `periodic`: alturas y corrimientos de la referencia.
// El pino gigante va a x = GIANT_X: entra casi entero en pantalla y lo que sobra de su base asoma por el borde
// izquierdo, donde se funde con el pino chico de x = 25 (en la referencia está a 783 y su mitad derecha cae
// afuera de la pantalla; envuelta, esa mitad taparía medio borde izquierdo).
// El cielo (capa 0) no cambia: queda con repeat 'mirror' (parallax 0,04, solo se ven ~64 px de la copia).
export const GIANT_X = 750
export function paintForestBackground(target, rand, { periodic = false } = {}) {
  const W = target.w
  paintForestSky(target.layer(0))
  let L = target.layer(1)
  for (let i = 0; i < 25; i++) {
    const x = Math.round(i * (periodic ? W / 25 : 33) + rand() * 20)
    const h = 233 + rand() * 150
    pine(L, x, 417, h, { dark: 0xc8b193 }, 100 + i, rand() < 0.4 ? 0.3 : 0)
  }
  target.fog(() => 0.35, FOG)
  L = target.layer(2)
  waterTower(L, 75, 422, 0xb29c7e, 208)
  for (let i = 0; i < 20; i++) {
    const x = Math.round(20 + i * (periodic ? W / 20 : 42) + rand() * 18)
    const h = 175 + rand() * 125
    pine(L, x, 421, h, { dark: 0xa8957a }, 200 + i, rand() < 0.3 ? 0.35 : 0)
  }
  target.fog(() => 0.3, FOG)
  L = target.layer(3)
  for (let i = 0; i < 16; i++) {
    const x = Math.round(i * (periodic ? W / 16 : 52) + rand() * 24)
    const h = 125 + rand() * 92
    pine(L, x, 425, h, { dark: 0x7d7660, light: 0x8e8770 }, 300 + i)
  }
  target.fog(() => 0.18, FOG)
  // niebla de suelo entre capas
  target.fog((x, y) => (y < 242 ? 0 : Math.floor(Math.min(1, (y - 242) / 142) * 0.6 * 10 + bayer(x, y)) / 10), FOG)
  // capa cercana, pinos verdes oscuros
  L = target.layer(4)
  const near = [
    [25, 217],
    [218, 250],
    [265, 158],
    [310, 125],
    [492, 275],
    [535, 167],
    [587, 125],
    [periodic ? GIANT_X : 783, 467],
  ]
  near.forEach(([x, h], i) => pine(L, x, 437, h, { dark: 0x3c4a38, light: 0x5a6c4c, shade: 0x2c3629, trunk: 0x3a2e24 }, 400 + i))
  target.fog((x, y) => (y < 287 ? 0 : Math.floor(Math.min(1, (y - 287) / 108) * 0.35 * 8 + bayer(x, y)) / 8), FOG)
}

// Adaptador de una sola capa opaca (look-test).
export function flatTarget(cv) {
  return {
    w: cv.w,
    h: cv.h,
    layer: () => cv,
    fog(alphaAt, color) {
      for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) cv.put(x, y, color, alphaAt(x, y))
    },
  }
}

// ---------- texturas por material ----------

export const STONE_BASE = [0x807761, 0x776e59, 0x8a8169, 0x736a55]
export const BRICK_BASE = [0x6d3b2b, 0x78422f, 0x623426, 0x71402e]

// bloques en hileras con anchos variables (piedra de la referencia 3)
export function blockAt(x, y, rowH, widths, seedRow) {
  const row = Math.floor(y / rowH)
  const ly = y - row * rowH
  const off = hash(row, seedRow) % 23
  let pos = -off
  let k = hash(row, seedRow + 1) % widths.length
  while (pos + widths[k % widths.length] <= x) {
    pos += widths[k % widths.length]
    k++
  }
  return { row, ly, lx: x - pos, bw: widths[k % widths.length], id: k }
}

export function stoneShade(b, x, y) {
  if (b.ly === 6 || b.lx === b.bw - 1) return 0x3a3326
  const base = STONE_BASE[hash(b.row, b.id, 3) % STONE_BASE.length]
  if (b.ly === 0 || b.lx === 0) return mix(base, 0xa89e84, 0.55)
  if (b.ly === 5 || b.lx === b.bw - 2) return mix(base, 0x4a4334, 0.5)
  const n = rnd(x, y, 17)
  if (n > 0.93) return mix(base, 0x5a5242, 0.6)
  if (n < 0.05) return mix(base, 0xa89e84, 0.35)
  // grieta ocasional
  if (hash(b.row, b.id, 9) % 7 === 0 && b.lx === (b.ly + 3) % b.bw) return 0x4a4334
  return base
}
export const stoneColor = (x, y) => stoneShade(blockAt(x, y, 7, [14, 9, 17, 11, 15, 10, 19, 12], 11), x, y)

export function brickShade(b, x, y) {
  if (b.ly === 4 || b.lx === b.bw - 1) return 0x2a1712
  const base = BRICK_BASE[hash(b.row, b.id, 4) % BRICK_BASE.length]
  if (b.ly === 0) return mix(base, 0xa8664c, 0.45)
  if (b.ly === 3) return mix(base, 0x3e2019, 0.45)
  if (rnd(x, y, 23) > 0.92) return mix(base, 0x3e2019, 0.4)
  return base
}
export const brickColor = (x, y) => brickShade(blockAt(x, y, 5, [9, 9, 9, 9], 21), x, y)

export function dirtColor(x, y) {
  const cell = hash(x >> 1, y >> 1, 31) % 3
  let c = [0x1b120d, 0x20150f, 0x251912][cell]
  // piedritas
  const gx = Math.floor(x / 7)
  const gy = Math.floor(y / 6)
  const h = hash(gx, gy, 41)
  if (h % 4 === 0) {
    const ox = gx * 7 + ((h >> 4) % 4)
    const oy = gy * 6 + ((h >> 8) % 3)
    const dx = x - ox
    const dy = y - oy
    const size = 2 + ((h >> 12) % 2)
    if (dx >= 0 && dy >= 0 && dx < size && dy < 2) c = dx === 0 && dy === 0 ? 0x54432f : 0x3c2e22
    else if (dx >= 1 && dx <= size && dy === 2) c = 0x150d09
  }
  return c
}

export function plankColor(x, y) {
  const p = Math.floor(x / 5)
  const lx = x % 5
  if (lx === 4) return 0x1e140e
  const base = [0x4a3526, 0x523b2a, 0x44301f][hash(p, 0, 51) % 3]
  if (lx === 0) return mix(base, 0x7a5a3e, 0.4)
  if (rnd(p, y >> 2, 53) > 0.8 && lx === 2) return mix(base, 0x2a1c12, 0.5)
  if ((y + p * 7) % 13 === 0 && lx === 2) return 0x9a8a70
  return base
}

export function slatColor(x, y) {
  const s = Math.floor(y / 4)
  const ly = y % 4
  if (ly === 3) return 0x5a4a34
  const base = [0xa8966c, 0xb3a176, 0x9d8b62][hash(s, x >> 4, 61) % 3]
  if (ly === 0) return mix(base, 0xd4c496, 0.5)
  if (rnd(x >> 1, s, 63) > 0.86) return mix(base, 0x7a6a48, 0.5)
  if (x % 16 === 0) return 0x6a5a40
  return base
}

export function beamColor(x, y, y0) {
  const ly = y - y0
  const base = 0x5a4230
  if (ly === 0) return 0x7e6046
  if (rnd(x >> 2, y, 71) > 0.85) return 0x4a3424
  return base
}

export function postColor(x) {
  return [0x6e5038, 0x563e2c, 0x4a3424, 0x34261a][x % 4]
}

// ---------- utilería ----------

export const BARREL = [
  '.kkkkkkkk.',
  'kLRRRRRrrk',
  'kkkkkkkkkk',
  'kLRRRRRrrk',
  'kLRwwwwRrk',
  'kLwbwwbwrk',
  'kLwwwwwwrk',
  'kLRwbwbRrk',
  'kkkkkkkkkk',
  'kLRRRRRrrk',
  'kLRRRRRrrk',
  '.kkkkkkkk.',
]
export const BARREL_PAL = { k: OUT, L: 0xf07a5e, R: 0xd0362c, r: 0x8e1e1a, w: 0xf2ece2, b: 0x2a1614 }

export function crate(cv, x0, y0, s = 12) {
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const edge = x === 0 || y === 0 || x === s - 1 || y === s - 1
      const frame = x <= 2 || y <= 2 || x >= s - 3 || y >= s - 3
      let c = frame ? (x === 1 || y === 1 ? 0xb08a5a : 0x8a6a44) : y % 3 === 0 ? 0x2e2014 : 0x4a3624
      if (!frame && x === 3) c = 0x3a2a1c
      if (edge) c = OUT
      cv.put(x0 + x, y0 + y, c)
    }
  }
  for (const [x, y] of [
    [1, 1],
    [s - 2, 1],
    [1, s - 2],
    [s - 2, s - 2],
  ])
    cv.put(x0 + x, y0 + y, 0xc8b89a)
}

export function ladder(cv, x0, y0, y1) {
  for (let y = y0; y <= y1; y++) {
    cv.put(x0, y, OUT)
    cv.put(x0 + 1, y, 0x8a6a48)
    cv.put(x0 + 6, y, 0x6b5038)
    cv.put(x0 + 7, y, OUT)
    if ((y - y0) % 4 === 0) {
      for (let x = 2; x <= 5; x++) cv.put(x0 + x, y, 0x9a7a54)
      for (let x = 2; x <= 5; x++) cv.put(x0 + x, y + 1, 0x3a2a1c)
    }
  }
}

export function windsock(cv, x, ground, wind) {
  for (let y = ground - 26; y < ground; y++) {
    cv.put(x, y, 0x8a8a84)
    cv.put(x + 1, y, 0x4a4a46)
  }
  cv.put(x, ground - 27, 0xd0d0c8)
  const dir = Math.sign(wind)
  for (let i = 0; i < 14; i++) {
    const hh = 3 - Math.floor(i / 5)
    const droop = Math.floor(i * i * 0.012)
    const stripe = Math.floor(i / 3) % 2 === 0 ? 0xf06a2a : 0xf2ece2
    for (let k = -hh; k <= hh; k++) cv.put(x + 2 + i * dir, ground - 24 + k + droop, Math.abs(k) === hh ? OUT : stripe)
  }
}

// phase null = bandera quieta de la referencia; con fase, la onda viaja y el lado del mástil queda fijo
export function flag(cv, x, ground, phase = null) {
  for (let y = ground - 34; y < ground; y++) {
    cv.put(x, y, 0xb0b0a8)
    cv.put(x + 1, y, 0x5a5a56)
  }
  cv.rect(x - 1, ground - 36, 3, 2, 0xe2c13d)
  for (let y = 0; y < 11; y++) {
    for (let x2 = 0; x2 < 18; x2++) {
      const wave =
        phase === null ? Math.round(Math.sin(x2 / 3.2) * 1.2) : Math.round(Math.sin(x2 / 3.2 - phase) * 1.6 * Math.min(1, (x2 + 1) / 5))
      let c = y % 2 === 0 ? 0xc8302a : 0xf2ece2
      if (x2 < 8 && y < 6) c = (x2 + y) % 4 === 0 && y > 0 && y < 5 && x2 > 0 ? 0xf2ece2 : 0x2a4aa0
      if (phase !== null && Math.cos(x2 / 3.2 - phase) > 0.55) c = mul(c, 0.78)
      if (y === 0 || y === 10 || x2 === 17) c = OUT
      cv.put(x + 2 + x2, ground - 34 + y + wave, c)
    }
  }
}

// ---------- tanques con tripulante ----------

export const TANK_W = 28
const T = (off, s) => ('.'.repeat(off) + s).padEnd(TANK_W, '.')
const r_ = (c, n) => c.repeat(n)
// Torreta en columnas 7-20, casco de 28. Debajo van las orugas (6 filas).
export const TANK = [
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
]
export const TREAD_H = 6
export const WHEELS = 4
export const TANK_H = TANK.length + TREAD_H
export const PIVOT = { x: 19, y: 3 }
export const BARREL_LEN = 11
export const CREW_W = 12
export const CREW_X = 8

// Cascos y franjas en el orden de TANK_COLORS: los 4 de la referencia (azul, rojo, amarillo, verde) y los 4
// de v5 (violeta, naranja, turquesa, rosa). El casco no lleva el color del jugador (eso lo hacen la franja y el
// banderín), pero son 8 distintos para que cada tanque se reconozca de lejos aunque dos franjas se parezcan.
export const HULLS = [
  { D: 0x2c341e, d: 0x434d2a, m: 0x5c6836, l: 0x7c8a48, h: 0xa2ae66 }, // oliva
  { D: 0x4a3a24, d: 0x6a5636, m: 0x8c7650, l: 0xae9468, h: 0xcdb488 }, // desierto
  { D: 0x2a3038, d: 0x3e4854, m: 0x56626e, l: 0x74808a, h: 0x9aa4ac }, // gris
  { D: 0x3a2a30, d: 0x54404a, m: 0x705866, l: 0x8e7482, h: 0xb096a2 }, // malva
  // v5: invierno (gris claro casi blanco) bajo el violeta, azul marino bajo el naranja (complementarios),
  // óxido bajo el turquesa (lo separa del verde y el azul, que van sobre oliva y malva) y carbón bajo el rosa
  // (frío, para no confundirse con los restos quemados, que son marrón negruzco)
  { D: 0x4a5058, d: 0x6c747c, m: 0x949ca2, l: 0xb8bec2, h: 0xdce0e2 }, // invierno
  { D: 0x1a2436, d: 0x2a3850, m: 0x3a4c68, l: 0x546a8a, h: 0x7890b0 }, // marino
  { D: 0x3e1e14, d: 0x5c2e1e, m: 0x7c422c, l: 0x9e5a3c, h: 0xc07a56 }, // óxido
  { D: 0x121214, d: 0x1e1e20, m: 0x2c2c2e, l: 0x404042, h: 0x5e5e60 }, // carbón
]
export const STRIPES = [
  [0x1f58b8, 0x3d8cf0],
  [0x9a1e1a, 0xe23d3d],
  [0xa88a14, 0xe2c13d],
  [0x2a8a4a, 0x3dbe5a],
  // v5: el claro es el de TANK_COLORS; el oscuro, la sombra de la franja
  [0x6a2a9a, 0xa65ae0],
  [0xb0581a, 0xf0903a],
  [0x15888a, 0x3ad0c8],
  [0xa82a6a, 0xe85aa0],
]

export const tankPal = (hull, stripe) => ({ k: OUT, ...hull, R: stripe[1], r: stripe[0], y: 0xfff1a8, Y: 0xffffff, v: 0x2a2a24 })

export function treads(cv, x0, y0, phase = 0) {
  const h = TREAD_H
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < TANK_W; x++) {
      const outer = y === 0 || y === h - 1
      if (outer && (x < 2 || x > TANK_W - 3)) continue
      if ((y === 1 || y === h - 2) && (x < 1 || x > TANK_W - 2)) continue
      const edge = outer || x === 0 || x === TANK_W - 1 || ((y === 1 || y === h - 2) && (x === 1 || x === TANK_W - 2))
      let c = edge ? OUT : 0x2a221c
      if (!edge && (y === 1 || y === h - 2)) c = (x + (y === 1 ? phase : -phase) + 3) % 3 === 0 ? 0x16110e : 0x4a3e34
      cv.put(x0 + x, y0 + y, c)
    }
  }
  for (let i = 0; i < WHEELS; i++) {
    const wx = Math.round(4 + (i * (TANK_W - 9)) / (WHEELS - 1))
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = dx * dx + dy * dy
        if (d > 6) continue
        let c = d >= 4 ? OUT : d === 0 ? 0xb0a494 : 0x5a5046
        if (d > 0 && d < 4 && dx + dy < 0) c = 0x7a7064
        cv.put(x0 + wx + dx, y0 + Math.floor(TREAD_H / 2) + dy, c)
      }
    }
  }
}

export function barrel(cv, px0, py0, angle, hull) {
  const rad = (angle * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = -Math.sin(rad)
  const nx = -dy
  const ny = dx
  const cells = new Map()
  const len = BARREL_LEN
  const K = 4096
  for (let t = -2; t <= len + 3; t += 0.25) {
    const half = t > len ? 1.9 : 1.2
    for (let w = -half; w <= half; w += 0.25) {
      const x = Math.round(px0 + dx * t + nx * w)
      const y = Math.round(py0 + dy * t + ny * w)
      const key = y * K + x
      const kind = t > len ? 2 : 1
      if (!cells.has(key) || kind === 2) cells.set(key, { x, y, kind, side: w })
    }
  }
  for (const cell of cells.values()) {
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => !cells.has((cell.y + oy) * K + cell.x + ox))
    let c = edge ? OUT : cell.side < -0.4 ? hull.h : cell.side > 0.5 ? hull.d : hull.m
    if (!edge && cell.kind === 2) c = cell.side < 0 ? 0x6a6a60 : 0x3a3a34
    cv.put(cell.x, cell.y, c)
  }
}

export function antenna(cv, ax, bodyTop, color, flip = false) {
  for (let y = bodyTop - 12; y < bodyTop; y++) cv.put(ax, y, 0x3a3a34)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6 - y; x++) cv.put(ax - (flip ? -1 : 1) * (1 + x), bodyTop - 12 + y + (x > 3 ? 1 : 0), x === 5 - y || y === 3 ? OUT : color)
}

// ---------- tripulantes ----------

export const CREW_BANDANA = [
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
export const CREW_SARGE = [
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
export const SKIN = { s: 0xd8966c, S: 0xa2644a, T: 0x8a5a44, w: 0xf2ece2 }
export const BANDANA_PAL = { b: 0xc8302a, B: 0xf0604a, g: 0x141414, G: 0x8ab0d0, c: 0x6b3e1f, e: 0xff8a30, n: 0x4a4a38 }
export const SARGE_PAL = { H: 0x4a5a2a, J: 0x6e8040, M: 0x3a2214, n: 0x5a5030 }

// ---------- globos y fuente ----------

export const BUBBLE_ALERT = [
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

export const BUBBLE_ASK = [
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
export const BUBBLE_PAL = { k: OUT, w: 0xffffff, s: 0xc8c8c8 }

export const FONT = {
  A: ['.###.', '#...#', '#####', '#...#', '#...#'],
  B: ['####.', '#...#', '####.', '#...#', '####.'],
  D: ['####.', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '####.', '#....', '#####'],
  G: ['.####', '#....', '#..##', '#...#', '.####'],
  H: ['#...#', '#...#', '#####', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  L: ['#....', '#....', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '####.', '#....', '#....'],
  R: ['####.', '#...#', '####.', '#..#.', '#...#'],
  S: ['.####', '#....', '.###.', '....#', '####.'],
  V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
  Z: ['#####', '...#.', '..#..', '.#...', '#####'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  ' ': ['..', '..', '..', '..', '..'],
}

export function text(cv, str, x, y, c, shadow = OUT, font = FONT) {
  let cx = x
  for (const ch of str) {
    const g = font[ch]
    if (!g) continue
    for (let gy = 0; gy < g.length; gy++) {
      for (let gx = 0; gx < g[gy].length; gx++) {
        if (g[gy][gx] !== '#') continue
        cv.put(cx + gx + 1, y + gy + 1, shadow)
        cv.put(cx + gx, y + gy, c)
      }
    }
    cx += g[0].length + 1
  }
  return cx - x
}
