// Texturas de material repetibles (tile = x % w, y % h), con el mismo sombreado que look-test.
// Cada función devuelve un Canvas opaco cuyo borde derecho continúa en el izquierdo y el de abajo en el de arriba.
import { Canvas, hash, rnd, mix, mul, stoneShade, brickShade, dirtColor, plankColor, slatColor, postColor } from './pixel.mjs'

const wrap = (v, n) => ((v % n) + n) % n

function paint(w, h, colorAt) {
  const cv = new Canvas(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cv.put(x, y, colorAt(x, y))
  return cv
}

// Hileras de bloques que cierran justo en `w`: la última pieza absorbe el resto.
function rowLayout(w, row, widths, seedRow) {
  const out = []
  let pos = 0
  let k = hash(row, seedRow + 1) % widths.length
  while (pos < w) {
    let bw = widths[k % widths.length]
    if (w - pos - bw < Math.min(...widths) - 1) bw = w - pos
    out.push({ start: pos, bw, id: k })
    pos += bw
    k++
  }
  return { blocks: out, off: hash(row, seedRow) % w }
}

function blockTile(w, rowH, widths, seedRow) {
  const rows = new Map()
  return (x, y) => {
    const row = Math.floor(y / rowH)
    if (!rows.has(row)) rows.set(row, rowLayout(w, row, widths, seedRow))
    const { blocks, off } = rows.get(row)
    const u = wrap(x + off, w)
    const b = blocks.find((q) => u >= q.start && u < q.start + q.bw)
    return { row, ly: y - row * rowH, lx: u - b.start, bw: b.bw, id: b.id }
  }
}

export function stoneTexture(w = 256, h = 126) {
  const at = blockTile(w, 7, [14, 9, 17, 11, 15, 10, 19, 12], 11)
  return paint(w, h, (x, y) => stoneShade(at(x, y), x, y))
}

export function brickTexture(w = 252, h = 120) {
  const rows = h / 5
  return paint(w, h, (x, y) => {
    const row = Math.floor(y / 5)
    // aparejo corrido: media pieza de corrimiento, con un poco de desorden por hilera
    const off = (row % 2) * 4 + (hash(row % rows, 21) % 3)
    const u = wrap(x + off, w)
    const b = { row, ly: y - row * 5, lx: u % 9, bw: 9, id: Math.floor(u / 9) }
    let c = brickShade(b, x, y)
    // ladrillos gastados: una esquina rota de vez en cuando
    if (hash(b.row, b.id, 27) % 11 === 0 && b.lx >= 6 && b.ly <= 1 && b.lx !== 8 && b.ly !== 4) c = 0x2a1712
    return c
  })
}

export function dirtTexture(w = 252, h = 132) {
  return paint(w, h, (x, y) => {
    let c = dirtColor(x, y)
    // vetas más oscuras y raicitas muy de vez en cuando
    const vx = Math.floor(x / 21)
    const vy = Math.floor(y / 11)
    const v = hash(vx, vy, 91)
    if (v % 9 === 0) {
      const lx = x - vx * 21
      const ly = y - vy * 11
      const path = 3 + ((v >> 5) % 5) + Math.round(Math.sin(lx / 3) * 1.2)
      if (ly === path && lx > 2 && lx < 18) c = 0x120b08
      if (ly === path - 1 && lx > 4 && lx < 16 && (lx & 1)) c = mix(c, 0x2e2118, 0.5)
    }
    return c
  })
}

export function plankTexture(w = 260, h = 104) {
  return paint(w, h, (x, y) => {
    let c = plankColor(x, y)
    const lx = x % 5
    const p = Math.floor(x / 5)
    // veta vertical y nudos
    if (lx > 0 && lx < 4 && rnd(x, y >> 1, 55) > 0.9) c = mul(c, 0.86)
    const kn = hash(p, Math.floor(y / 26), 57)
    if (kn % 5 === 0 && lx >= 1 && lx <= 3) {
      const ky = (kn >> 4) % 26
      const d = Math.abs((y % 26) - ky)
      if (d === 0 && lx === 2) c = 0x22170f
      else if (d <= 1) c = mix(c, 0x2a1c12, 0.35)
    }
    return c
  })
}

export function slatTexture(w = 256, h = 128) {
  return paint(w, h, (x, y) => {
    let c = slatColor(x, y)
    // clavos en las uniones
    if (x % 16 === 1 && y % 4 === 1) c = 0x5a4a34
    return c
  })
}

export function beamTexture(w = 256, h = 65) {
  return paint(w, h, (x, y) => {
    let c = 0x5a4230
    if (rnd(x >> 2, y, 71) > 0.85) c = 0x4a3424
    else if (rnd(x >> 3, y, 72) > 0.9) c = 0x684c38
    // cantos: cada 5 filas una línea clara y una oscura, como vigas apiladas
    const ly = y % 5
    if (ly === 0) c = mix(c, 0x7e6046, 0.6)
    if (ly === 4) c = mix(c, 0x2e2016, 0.55)
    // pernos
    if (x % 32 === 6 && ly === 2) c = 0x2a1c12
    if (x % 32 === 5 && ly === 1) c = 0x9a8a70
    return c
  })
}

export function postTexture(w = 128, h = 128) {
  return paint(w, h, (x, y) => {
    let c = postColor(x)
    if (rnd(x, y >> 2, 75) > 0.88) c = mul(c, 0.82)
    const col = Math.floor(x / 4)
    const kn = hash(col, Math.floor(y / 32), 77)
    if (kn % 4 === 0 && y % 32 === (kn >> 4) % 32 && x % 4 === 1) c = 0x241810
    return c
  })
}

export function metalTexture(w = 256, h = 128) {
  const PW = 32
  const PH = 16
  return paint(w, h, (x, y) => {
    const row = Math.floor(y / PH)
    const u = wrap(x + (row % 2) * 16, w)
    const col = Math.floor(u / PW)
    const lx = u % PW
    const ly = y % PH
    const tone = hash(col, row % (h / PH), 81) % 3
    let c = [0x5a6068, 0x545a62, 0x60666e][tone]
    // brillo cepillado en diagonal
    if (((lx + ly * 2 + col * 7) % 23) < 2 && rnd(u, y, 82) > 0.3) c = mix(c, 0x8a929a, 0.35)
    if (rnd(u, y, 83) > 0.95) c = mix(c, 0x3a3e44, 0.5)
    // óxido cerca del borde de abajo
    if (ly >= PH - 5 && rnd(u >> 1, y >> 1, 84) > 0.8 && hash(col, row, 85) % 3 === 0) c = mix(c, 0x7a4a2a, 0.55)
    if (lx === PW - 1 || ly === PH - 1) return 0x1a1c20
    if (lx === 0 || ly === 0) return mix(c, 0x9aa2aa, 0.55)
    if (lx === PW - 2 || ly === PH - 2) return mix(c, 0x2a2e34, 0.6)
    // remaches en las esquinas y a mitad del lado
    const rv = (rx, ry) => lx === rx && ly === ry
    const rivets = [
      [3, 3],
      [PW - 5, 3],
      [3, PH - 5],
      [PW - 5, PH - 5],
      [15, 3],
      [15, PH - 5],
    ]
    for (const [rx, ry] of rivets) {
      if (rv(rx, ry)) return 0xc8d0d6
      if (rv(rx + 1, ry) || rv(rx, ry + 1)) return 0x8a929a
      if (rv(rx + 1, ry + 1)) return 0x24272c
    }
    return c
  })
}

// Roca madre: celdas de Voronoi periódicas, piedras oscuras con grietas negras.
export function bedrockTexture(w = 256, h = 128) {
  const S = 16
  const gw = w / S
  const gh = h / S
  const pt = (gx, gy) => {
    const hx = wrap(gx, gw)
    const hy = wrap(gy, gh)
    const q = hash(hx, hy, 95)
    return { x: gx * S + 3 + (q % (S - 6)), y: gy * S + 3 + ((q >> 8) % (S - 6)), id: hx + hy * gw }
  }
  return paint(w, h, (x, y) => {
    const gx = Math.floor(x / S)
    const gy = Math.floor(y / S)
    let d1 = 1e9
    let d2 = 1e9
    let best = null
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const p = pt(gx + i, gy + j)
        const d = Math.hypot(x - p.x, (y - p.y) * 1.25)
        if (d < d1) {
          d2 = d1
          d1 = d
          best = p
        } else if (d < d2) d2 = d
      }
    }
    if (d2 - d1 < 1.3) return 0x0a090c
    const base = [0x26232a, 0x2c2930, 0x221f25, 0x302c33][hash(best.id, 0, 96) % 4]
    let c = base
    const ry = y - best.y
    const rx = x - best.x
    if (d2 - d1 < 2.6 && ry > 0) c = mix(base, 0x121015, 0.6)
    else if (d2 - d1 < 2.6 && ry < 0) c = mix(base, 0x4a4650, 0.45)
    else if (rx < -2 && ry < -2 && d1 < 7) c = mix(base, 0x3c3842, 0.5)
    if (rnd(x, y, 97) > 0.94) c = mix(c, 0x1a181d, 0.6)
    if (rnd(x, y, 98) > 0.985) c = 0x4e4a54
    return c
  })
}

export function airTexture() {
  return new Canvas(8, 8)
}
