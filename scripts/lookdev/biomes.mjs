// Fondos por bioma en capas 800×450 con alfa, y paleta de terreno por bioma.
// forest reproduce la referencia aprobada; jungle e industrial siguen la misma receta (capas + niebla).
import { Canvas, mix, mul, rnd, hash, bayer, noise1, gradient, makeRand, FOG, paintForestBackground, waterTower } from './pixel.mjs'

export const BG_W = 800
export const BG_H = 450

// Capas separadas; fog() tiñe todo lo que ya está pintado, igual que haze() sobre el canvas plano.
export function layeredTarget(n, w = BG_W, h = BG_H) {
  const layers = Array.from({ length: n }, () => new Canvas(w, h))
  return {
    w,
    h,
    layers,
    layer: (i) => layers[i],
    fog(alphaAt, color) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = alphaAt(x, y)
          if (a <= 0) continue
          for (const L of layers) L.tint(x, y, color, a)
        }
      }
    },
  }
}

const groundFog = (y0, span, max, steps) => (x, y) => (y < y0 ? 0 : Math.floor(Math.min(1, (y - y0) / span) * max * steps + bayer(x, y)) / steps)
// bruma que se acumula hacia el horizonte: casi nada arriba, `max` desde y1 para abajo
const horizonFog = (y0, y1, max, steps = 10) => (x, y) => Math.floor(Math.max(0, Math.min(1, (y - y0) / (y1 - y0))) * max * steps + bayer(x, y)) / steps

function skyGradient(cv, stops, bands = 22) {
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const t = Math.floor((y / cv.h) * bands + bayer(x, y)) / bands
      cv.put(x, y, gradient(stops, Math.min(1, t)))
    }
  }
}

function glow(cv, cx, cy, R, color, k, sy = 1.2) {
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const d = Math.hypot(x - cx, (y - cy) * sy)
      const g = Math.max(0, 1 - d / R)
      if (g <= 0) continue
      const q = Math.floor(g * g * 8 + bayer(x + 1, y)) / 8
      if (q > 0) cv.put(x, y, mix(cv.get(x, y), color, q * k))
    }
  }
}

// nube pixel: gotas con base plana, luz arriba a la izquierda y panza sombreada
function cloud(cv, cx, cy, w, pal, s) {
  const blobs = []
  const n = Math.max(3, Math.round(w / 10))
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1)
    const r = (6 + rnd(i, 1, s) * 7) * (0.45 + 0.55 * Math.sin(u * Math.PI)) + 3
    blobs.push({ x: cx - w / 2 + u * w + (rnd(i, 2, s) - 0.5) * 6, y: cy - r * 0.55, r })
  }
  for (let y = Math.floor(cy - 30); y <= cy; y++) {
    for (let x = Math.floor(cx - w / 2 - 16); x <= cx + w / 2 + 16; x++) {
      let best = null
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y)
        if (d <= b.r && (!best || d / b.r < best.k)) best = { b, k: d / b.r }
      }
      if (!best) continue
      const { b } = best
      const lx = (x - (b.x - b.r * 0.35)) / b.r
      const ly = (y - (b.y - b.r * 0.45)) / b.r
      let c = pal.mid
      if (Math.hypot(lx, ly) < 0.55 && bayer(x, y) < 0.85) c = pal.light
      if (cy - y < 3 || (cy - y < 6 && bayer(x, y) > 0.45)) c = pal.dark
      cv.put(x, y, c)
    }
  }
}

// ---------- bosque ----------

export function forest() {
  const T = layeredTarget(5)
  const R = makeRand(42)
  paintForestBackground(T, R.next)
  return T.layers
}

// ---------- jungla ----------

// hoja alargada que sale de (x, y) con ángulo `ang`, ancho máximo a mitad del largo y caída por peso
function leaf(cv, x, y, ang, len, wmax, pal, droop = 0.25) {
  let px = x
  let py = y
  let a = ang
  const down = Math.PI / 2
  for (let i = 0; i <= len * 2; i++) {
    const u = i / (len * 2)
    const w = wmax * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.1)), 0.8)
    const nx = -Math.sin(a)
    const ny = Math.cos(a)
    for (let k = -w; k <= w; k += 0.5) {
      let c = pal.dark
      if (pal.light && k < -w + 1 && w > 0.8) c = pal.light
      else if (pal.shade && Math.abs(k) < 0.4 && u > 0.1) c = pal.shade
      cv.put(px + nx * k, py + ny * k, c)
    }
    px += Math.cos(a) * 0.5
    py += Math.sin(a) * 0.5
    // gira de a poco hacia abajo
    const diff = down - a
    a += Math.sign(Math.sin(diff)) * droop * 0.02 * (Math.cos(a) !== 0 ? 1 : 0)
  }
}

function palm(cv, x, base, h, lean, pal, s, fronds = 9, scale = 1) {
  let tx = x
  let ty = base - h
  for (let i = 0; i <= h; i++) {
    const t = i / h
    const px = x + lean * t * t * h * 0.35
    const py = base - i
    const w = t < 0.5 ? 3 : 2
    for (let k = 0; k < w; k++) {
      let c = pal.dark
      if (pal.light && k === 0) c = pal.light
      if (pal.shade && (i % 5 === 0 || k === w - 1)) c = pal.shade
      cv.put(Math.round(px) - 1 + k, py, c)
    }
    tx = px
    ty = py
  }
  for (let f = 0; f < fronds; f++) {
    const a0 = -Math.PI * (0.04 + (f / (fronds - 1)) * 0.92) + (rnd(f, 3, s) - 0.5) * 0.25
    const vertical = 1 - Math.abs(Math.cos(a0))
    const L = (h * 0.2 + 14) * scale * (1 - vertical * 0.4) * (0.85 + rnd(f, 4, s) * 0.3)
    const bendDir = Math.cos(a0) >= 0 ? 1 : -1
    let px = tx
    let py = ty
    let a = a0
    const steps = Math.round(L * 2)
    for (let i = 0; i < steps; i++) {
      const u = i / steps
      px += Math.cos(a) * 0.5
      py += Math.sin(a) * 0.5
      a += (bendDir * (0.7 + rnd(f, 6, s) * 0.5) * (0.4 + u * 1.2)) / steps
      const th = u < 0.4 ? 1 : 0
      for (let k = 0; k <= th; k++) cv.put(px, py + k, pal.dark)
      if (i % 2) continue
      // hojuelas a los dos lados, colgando
      const ll = (7 * scale + 2) * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.05 + 0.08)), 0.6) * (0.8 + rnd(i, f, s) * 0.4)
      for (const side of [-1, 1]) {
        const la = a + side * 1.1
        let lx = px
        let ly = py
        for (let k = 0; k < ll; k++) {
          const g = k / Math.max(1, ll)
          const dx = Math.cos(la) * (1 - g * 0.6)
          const dy = Math.sin(la) * (1 - g * 0.6) + g * 0.9
          const n = Math.hypot(dx, dy)
          lx += dx / n
          ly += dy / n
          const up = side === (bendDir > 0 ? -1 : 1)
          cv.put(lx, ly, up && pal.light && k < 2 ? pal.light : !up && pal.shade ? pal.shade : pal.dark)
        }
      }
    }
  }
  if (pal.shade) for (const [ox, oy] of [[-2, 2], [1, 2], [-1, 3], [0, 1]]) cv.put(tx + ox, ty + oy, pal.shade)
}

// copa de árbol de selva: racimo de bolas con luz arriba a la izquierda
function crown(cv, cx, cy, r, pal, s) {
  const blobs = [{ x: cx, y: cy, r }]
  for (let i = 0; i < 6; i++) {
    const a = rnd(i, 1, s) * Math.PI * 2
    const d = r * (0.4 + rnd(i, 2, s) * 0.5)
    blobs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.6, r: r * (0.45 + rnd(i, 3, s) * 0.35) })
  }
  for (const b of blobs) {
    for (let y = Math.floor(b.y - b.r - 1); y <= b.y + b.r + 1; y++) {
      for (let x = Math.floor(b.x - b.r - 1); x <= b.x + b.r + 1; x++) {
        const d = Math.hypot(x - b.x, y - b.y)
        // borde de hojitas: dientes irregulares
        if (d > b.r + (rnd(x >> 1, y >> 1, s) - 0.5) * 3) continue
        let c = pal.dark
        const lx = (x - (b.x - b.r * 0.4)) / b.r
        const ly = (y - (b.y - b.r * 0.5)) / b.r
        const lit = Math.hypot(lx, ly)
        if (pal.light && lit < 0.55 && bayer(x, y) < 0.75) c = pal.light
        else if (pal.shade && y > b.y + b.r * 0.3 && bayer(x, y) < 0.7) c = pal.shade
        cv.put(x, y, c)
      }
    }
  }
}

function liana(cv, x, y0, len, pal, s) {
  let px = x
  for (let i = 0; i < len; i++) {
    px = x + Math.sin(i / 14 + s) * 2.5
    cv.put(px, y0 + i, pal.dark)
    if (i % 16 === 8) leaf(cv, px, y0 + i, (hash(i, s, 31) & 1 ? 0.5 : 2.6), 4, 1.3, pal, 0.1)
  }
  leaf(cv, px, y0 + len, Math.PI / 2 + 0.3, 5, 1.6, pal, 0.1)
  leaf(cv, px, y0 + len, Math.PI / 2 - 0.4, 4, 1.4, pal, 0.1)
}

// liana colgando en curva entre dos puntos
function vine(cv, x0, y0, x1, y1, sag, pal, s) {
  const n = Math.ceil(Math.abs(x1 - x0) * 1.5)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = x0 + (x1 - x0) * t
    const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * sag
    cv.put(x, y, pal.dark)
    if (i % 22 === 11) leaf(cv, x, y, hash(i, s, 5) & 1 ? 1.1 : 2.0, 4, 1.3, pal, 0.1)
  }
}

function ridge(cv, y0, amp, scale, color, s, x0 = 0, x1 = cv.w) {
  for (let x = x0; x < x1; x++) {
    const top = Math.round(y0 - noise1(x, scale, s) * amp - noise1(x, scale / 4, s + 1) * amp * 0.25)
    for (let y = top; y < cv.h; y++) cv.put(x, y, color)
  }
}

// cortina de copas que cuelga del borde de arriba, con hojas largas colgando
function overhang(cv, pal, rand, s) {
  for (let x = -20; x < cv.w + 20; x += 14) {
    const depth = 8 + noise1(x, 90, s) * 30
    crown(cv, x + rand() * 10, depth - 8, 12 + rand() * 8, pal, s + x)
  }
  for (let x = -10; x < cv.w + 10; x += 9) {
    const depth = 10 + noise1(x, 90, s) * 30
    const n = 2 + Math.floor(rand() * 3)
    for (let k = 0; k < n; k++) leaf(cv, x + rand() * 8, depth + rand() * 6, Math.PI / 2 + (rand() - 0.5) * 1.3, 8 + rand() * 12, 2 + rand() * 1.5, pal, 0.2)
  }
}

// helechos y hojas anchas en el borde de abajo
function bush(cv, x, base, size, pal, rand) {
  const n = 7 + Math.floor(rand() * 4)
  for (let k = 0; k < n; k++) {
    const a = -Math.PI * (0.08 + (k / (n - 1)) * 0.84) + (rand() - 0.5) * 0.2
    leaf(cv, x + (rand() - 0.5) * size * 0.3, base, a, size * (0.6 + rand() * 0.5), 2.5 + size * 0.05, pal, 0.6)
  }
}

// pirámide escalonada en ruinas con templete arriba
function temple(cv, cx, base, w, tiers, th, pal) {
  for (let t = 0; t < tiers; t++) {
    const hw = Math.round(w / 2 - t * (w / 2 / (tiers + 1.5)))
    const y0 = base - (t + 1) * th
    for (let y = y0; y < y0 + th; y++) {
      for (let x = cx - hw; x <= cx + hw; x++) {
        // bordes mordidos
        if ((x === cx - hw || x === cx + hw) && rnd(x, y, 61) > 0.6) continue
        let c = x > cx + hw * 0.55 ? pal.shade : pal.dark
        if (y === y0) c = pal.light
        cv.put(x, y, c)
      }
    }
  }
  // escalinata central
  const top = base - tiers * th
  for (let y = top; y < base; y++) for (let x = cx - 3; x <= cx + 3; x++) if ((y - top) % 3 === 0) cv.put(x, y, pal.light)
  // templete con puerta
  cv.rect(cx - 9, top - 12, 19, 12, pal.dark)
  cv.rect(cx - 11, top - 14, 23, 3, pal.light)
  cv.rect(cx - 3, top - 9, 7, 9, pal.door)
  // raíces que trepan
  for (let k = 0; k < 5; k++) {
    let x = cx - w / 2 + 6 + k * (w / 5)
    for (let y = base - 2; y > base - th * (1 + (k % 3)); y--) {
      x += (rnd(k, y, 62) - 0.5) * 1.4
      cv.put(x, y, pal.vine)
    }
  }
}

// cascada que cae de un risco, con vapor en la base
function waterfall(cv, x, top, w, h, pal) {
  // risco
  for (let y = top - 6; y < top + h; y++) {
    const edge = Math.round(noise1(y, 20, 71) * 8)
    for (let xx = x - 26 - edge; xx < x + w + 22 + edge; xx++) {
      if (y < top && (xx < x - 18 + (top - y) * 2 || xx > x + w + 14 - (top - y) * 2)) continue
      cv.put(xx, y, xx < x || xx >= x + w ? (xx > x + w + 10 ? pal.rockShade : pal.rock) : pal.rock)
    }
  }
  // agua en hilos
  for (let y = top; y < top + h; y++) {
    for (let xx = x; xx < x + w; xx++) {
      const k = (xx * 5 + Math.floor((y + xx * 7) / 5)) % 4
      cv.put(xx, y, k === 0 ? pal.foam : k === 1 ? pal.water : pal.light)
    }
  }
  // vapor
  const cy = top + h
  for (let y = cy - 14; y < cy + 10; y++) {
    for (let xx = x - 30; xx < x + w + 30; xx++) {
      const d = Math.hypot((xx - x - w / 2) / (w / 2 + 26), (y - cy) / 12)
      if (d < 1 && bayer(xx, y) < (1 - d) * 1.4) cv.put(xx, y, pal.foam)
    }
  }
}

// ceiba de tronco alto con raíces tabulares
function kapok(cv, x, base, h, pal, s) {
  for (let y = base - h; y < base; y++) {
    const t = (base - y) / h
    const flare = t < 0.18 ? Math.round((0.18 - t) * 60) : 0
    const hw = 3 + flare
    for (let dx = -hw; dx <= hw; dx++) {
      let c = pal.dark
      if (dx === -hw || (dx < -1 && flare === 0 && y % 7 === 0)) c = pal.light
      if (dx > hw - 2) c = pal.shade
      if (flare && Math.abs(dx) > 3 && (dx + 64) % 5 === 0) c = pal.shade
      cv.put(x + dx, y, c)
    }
  }
  // ramas en paraguas
  for (const [dx, dy] of [[-26, -8], [24, -6], [-12, -14], [14, -16]]) cv.line(x, base - h + 16, x + dx, base - h + dy + 10, pal.dark, 2)
  crown(cv, x - 22, base - h, 16, pal, s)
  crown(cv, x + 22, base - h + 2, 15, pal, s + 1)
  crown(cv, x, base - h - 8, 20, pal, s + 2)
}

export function jungle() {
  const T = layeredTarget(5)
  const R = makeRand(77)
  const rand = R.next
  const sky = T.layer(0)
  skyGradient(sky, [
    [0, 0x3a78c0],
    [0.3, 0x5e9fd6],
    [0.55, 0x96c8e2],
    [0.75, 0xc4e2ea],
    [1, 0xdcefec],
  ])
  glow(sky, 620, 60, 300, 0xf4fbff, 0.5)
  const cpal = { light: 0xfbfdff, mid: 0xe6f2f8, dark: 0xb4cee2 }
  cloud(sky, 140, 92, 150, cpal, 1)
  cloud(sky, 430, 58, 90, cpal, 2)
  cloud(sky, 690, 128, 170, cpal, 3)
  cloud(sky, 300, 170, 70, { light: 0xeef6fa, mid: 0xd4e6f0, dark: 0xb0cce0 }, 4)

  // capa 1: sierra lejana con selva en la cresta
  let L = T.layer(1)
  const farC = 0x8cbac4
  ridge(L, 236, 70, 150, farC, 11)
  for (let i = 0; i < 40; i++) {
    const x = Math.round(i * 21 + rand() * 12)
    const top = 236 - noise1(x, 150, 11) * 70 - noise1(x, 150 / 4, 12) * 70 * 0.25
    crown(L, x, top + 4, 6 + rand() * 6, { dark: farC }, 50 + i)
  }
  for (let i = 0; i < 6; i++) palm(L, Math.round(60 + i * 140 + rand() * 60), 250, 50 + rand() * 30, (rand() - 0.5) * 0.6, { dark: farC }, 90 + i, 7, 0.6)
  temple(L, 540, 258, 140, 6, 10, { dark: 0x6a96a4, shade: 0x5e8a98, light: 0x8cb8c0, door: 0x46707e, vine: 0x5a8a7e })
  waterfall(L, 262, 176, 12, 92, { rock: 0x6e9aa8, rockShade: 0x608c9a, water: 0xcfeaf0, light: 0xb4dce6, foam: 0xf0fafa })
  T.fog(horizonFog(120, 330, 0.35), 0xcfe6e6)

  // capa 2: pared de selva media
  L = T.layer(2)
  const midPal = { dark: 0x5a8e92, light: 0x70a4a4, shade: 0x4c7e84 }
  for (let i = 0; i < 9; i++) {
    const x = Math.round(20 + i * 95 + rand() * 50)
    palm(L, x, 300, 110 + rand() * 60, (rand() - 0.5) * 0.9, midPal, 200 + i, 9, 0.8)
  }
  for (let i = 0; i < 36; i++) {
    const x = Math.round(i * 23 + rand() * 14)
    crown(L, x, 282 + rand() * 30, 14 + rand() * 12, midPal, 100 + i)
  }
  ridge(L, 306, 10, 40, midPal.dark, 12)
  T.fog(horizonFog(160, 340, 0.3), 0xcfe6e6)
  T.fog(groundFog(300, 120, 0.45, 10), 0xd8ecea)

  // capa 3: selva cercana, más oscura, con lianas entre copas
  L = T.layer(3)
  const nearPal = { dark: 0x30605c, light: 0x44786e, shade: 0x26504c }
  kapok(L, 110, 372, 170, nearPal, 610)
  kapok(L, 700, 372, 150, nearPal, 620)
  for (let i = 0; i < 6; i++) {
    const x = Math.round(60 + i * 140 + rand() * 60)
    palm(L, x, 370, 140 + rand() * 70, (rand() - 0.5) * 1.1, nearPal, 400 + i, 10, 1)
  }
  for (let i = 0; i < 24; i++) {
    const x = Math.round(i * 35 + rand() * 20)
    crown(L, x, 338 + rand() * 22, 18 + rand() * 12, nearPal, 300 + i)
  }
  ridge(L, 360, 8, 30, nearPal.dark, 13)
  for (let i = 0; i < 5; i++) {
    const x = Math.round(i * 170 + rand() * 60)
    vine(L, x, 318 + rand() * 20, x + 70 + rand() * 50, 320 + rand() * 20, 16 + rand() * 12, nearPal, i)
  }
  T.fog(horizonFog(200, 380, 0.14), 0xcfe6e6)
  T.fog(groundFog(340, 90, 0.4, 8), 0xd8ecea)

  // capa 4: marco cercano, techo de hojas, lianas y matas en los rincones
  L = T.layer(4)
  const fg = { dark: 0x1a3632, light: 0x2a4c44, shade: 0x122824 }
  overhang(L, fg, rand, 900)
  for (let i = 0; i < 11; i++) {
    const x = Math.round(30 + i * 72 + rand() * 30)
    liana(L, x, 20, Math.round(50 + rand() * 150), fg, 700 + i)
  }
  vine(L, 40, 30, 300, 36, 46, fg, 1)
  vine(L, 500, 26, 770, 34, 54, fg, 2)
  palm(L, 14, 452, 280, 0.45, fg, 500, 10, 1.4)
  palm(L, 790, 452, 300, -0.4, fg, 501, 10, 1.4)
  bush(L, 60, 452, 60, fg, rand)
  bush(L, 745, 452, 66, fg, rand)
  T.fog(groundFog(380, 70, 0.28, 8), 0xd8ecea)
  return T.layers
}

// ---------- atardecer industrial ----------

function chimney(cv, x, base, h, w, pal) {
  for (let y = base - h; y < base; y++) {
    const t = (y - (base - h)) / h
    const hw = Math.round(w / 2 + t * 2)
    for (let dx = -hw; dx <= hw; dx++) cv.put(x + dx, y, dx === hw && pal.light ? pal.light : pal.dark)
  }
  for (const k of [3, 7]) for (let dx = -w / 2 - 1; dx <= w / 2 + 1; dx++) cv.put(x + dx, base - h + k, pal.band ?? pal.dark)
  for (let dx = -w / 2 - 1; dx <= w / 2 + 1; dx++) cv.put(x + dx, base - h, pal.band ?? pal.dark)
  if (pal.lamp) {
    cv.put(x, base - h - 2, pal.lamp)
    cv.put(x, base - h - 1, pal.band ?? pal.dark)
  }
}

// columna de humo que sale de (x, y) y se va con el viento hacia la derecha
function smoke(cv, x, y, n, pal, s) {
  const puffs = []
  let cx = x
  let cy = y
  for (let i = 0; i < n; i++) {
    const t = i / n
    puffs.push({ x: cx, y: cy, r: 3 + t * 13 + rnd(i, 1, s) * 3, t })
    cx += 4 + t * 7 + (rnd(i, 2, s) - 0.3) * 4
    cy -= 5 - t * 3.2 + (rnd(i, 3, s) - 0.5) * 3
  }
  for (const p of puffs.reverse()) {
    for (let yy = Math.floor(p.y - p.r); yy <= p.y + p.r; yy++) {
      for (let xx = Math.floor(p.x - p.r); xx <= p.x + p.r; xx++) {
        const d = Math.hypot(xx - p.x, (yy - p.y) * 1.15)
        if (d > p.r) continue
        if (p.t > 0.55 && bayer(xx, yy) < (p.t - 0.55) * 1.9) continue
        const lx = (xx - (p.x - p.r * 0.3)) / p.r
        const ly = (yy - (p.y - p.r * 0.45)) / p.r
        let c = pal.mid
        if (Math.hypot(lx, ly) < 0.5) c = pal.light
        else if (yy > p.y + p.r * 0.35) c = pal.dark
        cv.put(xx, yy, c)
      }
    }
  }
}

function coolingTower(cv, x, base, h, w, color, light) {
  for (let y = base - h; y < base; y++) {
    const t = (y - (base - h)) / h
    const hw = Math.round(w * (0.34 + 0.55 * (t - 0.66) ** 2))
    for (let dx = -hw; dx <= hw; dx++) cv.put(x + dx, y, light && dx > hw - 3 ? light : color)
  }
  for (let dx = -Math.round(w * 0.4); dx <= w * 0.4; dx++) cv.put(x + dx, base - h, light ?? color)
}

function factory(cv, x, base, w, h, pal, s, windows = true) {
  cv.rect(x, base - h, w, h + 60, pal.dark)
  const teeth = Math.max(2, Math.round(w / 16))
  const tw = w / teeth
  for (let i = 0; i < teeth; i++) {
    for (let k = 0; k < tw; k++) {
      const hh = Math.round((k / tw) * 8)
      for (let y = 0; y < hh; y++) cv.put(x + i * tw + k, base - h - y, pal.dark)
    }
    if (pal.light) for (let y = 0; y < 8; y++) cv.put(x + (i + 1) * tw - 1, base - h - y, pal.light)
  }
  if (windows && pal.win) {
    for (let wy = base - h + 6; wy < base - 4; wy += 8) {
      for (let wx = x + 4; wx < x + w - 5; wx += 7) {
        if (hash(wx, wy, s) % 3 === 0) continue
        cv.rect(wx, wy, 3, 4, hash(wx, wy, s + 1) % 4 === 0 ? pal.winOff ?? pal.dark : pal.win)
      }
    }
  }
}

function scaffold(cv, x, base, w, h, color) {
  for (let px = x; px <= x + w; px += 12) for (let y = base - h; y < base; y++) cv.put(px, y, color)
  for (let y = base - h; y <= base; y += 14) {
    for (let px = x; px <= x + w; px++) cv.put(px, y, color)
    for (let px = x; px < x + w; px += 12) cv.line(px, y, px + 12, Math.min(base, y + 14), color)
  }
  // tablones
  for (let y = base - h + 14; y < base; y += 28) cv.rect(x - 2, y - 1, w + 5, 2, color)
}

function crane(cv, x, base, h, jib, color) {
  for (let y = base - h; y < base; y++) {
    cv.put(x, y, color)
    cv.put(x + 5, y, color)
    if ((y - base) % 6 === 0) cv.line(x, y, x + 5, y + 6, color)
  }
  const jy = base - h
  const dir = Math.sign(jib)
  const a = Math.min(x - 20 * dir, x + jib)
  const b = Math.max(x - 20 * dir, x + jib)
  for (let px = a; px < b; px++) {
    cv.put(px, jy, color)
    cv.put(px, jy + 4, color)
    if ((px - x) % 6 === 0) cv.line(px, jy, px + 6, jy + 4, color)
  }
  cv.rect(x - 20 * dir - 5, jy - 1, 10, 8, color)
  cv.rect(x, jy - 10, 6, 10, color)
  cv.line(x + 3, jy - 10, x + jib - 4 * dir, jy, color)
  cv.line(x + 3, jy - 10, x - 20 * dir, jy, color)
  const hx = x + Math.round(jib * 0.7)
  for (let y = jy + 4; y < jy + 44; y++) cv.put(hx, y, color)
  cv.rect(hx - 2, jy + 44, 5, 3, color)
}

// cartel sobre patas
function billboard(cv, x, y, w, h, pal, kind) {
  for (const lx of [x + 4, x + w - 5]) for (let yy = y + h; yy < y + h + 60; yy++) cv.put(lx, yy, pal.frame)
  cv.rect(x, y, w, h, pal.frame)
  cv.rect(x + 2, y + 2, w - 4, h - 4, pal.bg)
  const cx = Math.round(x + w / 2)
  const cy = Math.round(y + h / 2)
  if (kind === 'tank') {
    cv.rect(cx - 12, cy + 1, 24, 5, pal.ink)
    cv.rect(cx - 6, cy - 4, 12, 5, pal.ink)
    cv.line(cx + 4, cy - 2, cx + 16, cy - 9, pal.ink, 2)
    for (let i = 0; i < 4; i++) cv.rect(cx - 11 + i * 6, cy + 6, 4, 3, pal.ink)
    for (let i = 0; i < 3; i++) cv.rect(x + 5 + i * 5, y + 4, 3, 3, pal.hi)
  } else {
    // calavera de peligro con bandas
    for (let k = 0; k < w - 4; k++) if ((k >> 2) % 2 === 0) cv.rect(x + 2 + k, y + 2, 1, 3, pal.ink), cv.rect(x + 2 + k, y + h - 5, 1, 3, pal.ink)
    cv.sprite(
      ['..kkkkk..', '.kkkkkkk.', 'kkkkkkkkk', 'kk..k..kk', 'kk..k..kk', 'kkkkkkkkk', '.kkk.kkk.', '..k.k.k..', '..kkkkk..'],
      cx - 4,
      cy - 4,
      { k: pal.ink },
    )
  }
  for (let i = 0; i < 3; i++) cv.put(x + 6 + i * ((w - 12) / 2), y - 1, pal.lamp ?? pal.frame)
}

function tankFarm(cv, x, base, r, h, pal) {
  for (let y = base - h; y < base; y++) for (let dx = -r; dx <= r; dx++) cv.put(x + dx, y, dx > r - 2 && pal.light ? pal.light : pal.dark)
  for (let dx = -r; dx <= r; dx++) {
    const cap = Math.round(Math.sqrt(Math.max(0, 1 - (dx / r) ** 2)) * 5)
    for (let y = 0; y < cap; y++) cv.put(x + dx, base - h - y, pal.dark)
    if (pal.rim) cv.put(x + dx, base - h - cap, pal.rim)
  }
  for (let y = base - h + 6; y < base; y += 9) for (let dx = -r; dx <= r; dx++) cv.put(x + dx, y, pal.band ?? pal.dark)
  // escalera caracol
  for (let y = base - h; y < base; y++) cv.put(x - r + 3 + Math.round(((y - base + h) / h) * (2 * r - 6)), y, pal.band ?? pal.dark)
}

function pipe(cv, x0, x1, y, th, pal) {
  for (let x = x0; x <= x1; x++) {
    for (let k = 0; k < th; k++) cv.put(x, y + k, k === 0 && pal.rim ? pal.rim : pal.dark)
    if ((x - x0) % 40 === 0) for (let k = -1; k <= th; k++) cv.put(x, y + k, pal.dark), cv.put(x + 1, y + k, pal.dark)
  }
}

function fence(cv, x0, x1, base, h, color) {
  for (let x = x0; x <= x1; x++) {
    if ((x - x0) % 20 === 0) for (let y = base - h - 3; y < base; y++) cv.put(x, y, color)
    cv.put(x, base - h, color)
    for (let y = base - h; y < base; y++) if ((x + y) % 4 === 0 || (x - y + 400) % 4 === 0) cv.put(x, y, color)
  }
  for (let x = x0; x <= x1; x++) if (x % 3 === 0) cv.put(x, base - h - 4 + (x % 6 === 0 ? 1 : 0), color)
}

// torre de alta tensión en celosía
function pylon(cv, x, base, h, color, rim) {
  const top = base - h
  for (let y = top; y < base; y++) {
    const t = (y - top) / h
    const hw = Math.round(3 + t * t * 22)
    cv.put(x - hw, y, color)
    cv.put(x + hw, y, rim && y % 2 === 0 ? rim : color)
    if ((y - top) % 16 === 0) {
      const t2 = Math.min(1, (y - top + 16) / h)
      const hw2 = Math.round(3 + t2 * t2 * 22)
      cv.line(x - hw, y, x + hw2, y + 16, color)
      cv.line(x + hw, y, x - hw2, y + 16, color)
      for (let dx = -hw; dx <= hw; dx++) cv.put(x + dx, y, color)
    }
  }
  for (const [yy, w] of [[top + 10, 26], [top + 30, 32], [top + 50, 22]]) {
    for (let dx = -w; dx <= w; dx++) cv.put(x + dx, yy, color), cv.put(x + dx, yy + 1, color)
    for (const s of [-1, 1]) for (let k = 2; k < 7; k++) cv.put(x + s * w, yy + k, color)
  }
  return [[x - 26, top + 16], [x + 26, top + 16], [x - 32, top + 36], [x + 32, top + 36]]
}

// zepelín con góndola y ventanillas
function blimp(cv, cx, cy, c, rim) {
  for (let y = cy - 10; y <= cy + 10; y++)
    for (let x = cx - 44; x <= cx + 44; x++) {
      const d = ((x - cx) / 44) ** 2 + ((y - cy) / 10) ** 2
      if (d <= 1) cv.put(x, y, y < cy - 5 && d > 0.55 ? rim : c)
    }
  // aletas
  for (const s of [-1, 1]) for (let k = 0; k < 8; k++) for (let j = 0; j <= k; j++) cv.put(cx - 44 + k, cy + s * (4 + j), c)
  cv.rect(cx - 8, cy + 10, 18, 4, c)
  for (let x = cx - 20; x < cx + 20; x += 5) cv.rect(x, cy - 2, 3, 3, 0xf8c050)
}

export function industrial() {
  const T = layeredTarget(5)
  const R = makeRand(1945)
  const rand = R.next
  const sky = T.layer(0)
  skyGradient(sky, [
    [0, 0x3a1430],
    [0.18, 0x7a2432],
    [0.4, 0xc4482a],
    [0.6, 0xec8434],
    [0.76, 0xf8b850],
    [1, 0xfde496],
  ])
  glow(sky, 540, 300, 340, 0xffe8a0, 0.55)
  // sol retro con franjas
  const sx = 540
  const sy = 292
  for (let y = sy - 50; y <= sy + 50; y++) {
    for (let x = sx - 50; x <= sx + 50; x++) {
      const d = Math.hypot(x - sx, y - sy)
      if (d > 50) continue
      const dy = y - sy
      if (dy > 4 && y % 8 < Math.min(6, 1 + dy / 9)) continue
      sky.put(x, y, mix(0xfff6c0, 0xffc050, Math.max(0, dy + 20) / 70))
    }
  }
  // nubes largas
  for (let i = 0; i < 10; i++) {
    const y = Math.round(50 + i * 24 + rand() * 12)
    const x = Math.round(rand() * 800)
    const w = Math.round(80 + rand() * 200)
    const c = y < 150 ? 0x9a3038 : y < 220 ? 0xd05a34 : 0xf49a4a
    for (let k = 0; k < w; k++) {
      const hh = Math.round(Math.sin((k / w) * Math.PI) * 3)
      for (let j = 0; j < hh; j++) sky.put((x + k) % 800, y + j, j === hh - 1 ? mul(c, 0.82) : j === 0 ? mix(c, 0xffe0a0, 0.3) : c)
    }
  }

  // capa 1: ciudad industrial lejana
  let L = T.layer(1)
  const far = 0xd4785a
  for (let i = 0; i < 18; i++) {
    const x = Math.round(i * 48 + rand() * 20 - 20)
    factory(L, x, 356, 30 + Math.round(rand() * 40), 20 + Math.round(rand() * 44), { dark: far }, i, false)
  }
  for (let i = 0; i < 9; i++) chimney(L, Math.round(20 + i * 95 + rand() * 40), 356, 70 + rand() * 70, 5, { dark: far })
  coolingTower(L, 700, 360, 96, 46, far)
  coolingTower(L, 150, 360, 74, 38, far)
  waterTower(L, 372, 360, far, 118)
  blimp(L, 250, 118, 0x6a2a34, 0xa84a42)
  for (const [bx, by] of [[430, 150], [442, 144], [452, 152], [466, 140], [478, 147]]) L.sprite(['k...k', '.k.k.'], bx, by, { k: 0x4a1a24 })
  T.fog(horizonFog(150, 360, 0.3), 0xf0a868)

  // capa 2: fábricas medias con chimeneas humeantes
  L = T.layer(2)
  const mid = { dark: 0x8a3628, light: 0xc8603c, band: 0x6a2820, win: 0xf8c050, winOff: 0x6a2820, lamp: 0xff5a3a }
  const stacks = [80, 250, 410, 610, 745].map((x) => ({ x, h: Math.round(150 + rand() * 70) }))
  stacks.forEach(({ x, h }, i) => smoke(L, x, 385 - h - 2, 22, { dark: 0x7a4e48, mid: 0x9a6a5c, light: 0xc89276 }, i + 3))
  for (let i = 0; i < 10; i++) {
    const x = Math.round(i * 86 + rand() * 30 - 20)
    factory(L, x, 385, 50 + Math.round(rand() * 40), 30 + Math.round(rand() * 34), mid, 10 + i)
  }
  stacks.forEach(({ x, h }) => chimney(L, x, 385, h, 8, mid))
  coolingTower(L, 520, 392, 124, 54, mid.dark, mid.light)
  T.fog(horizonFog(200, 390, 0.16), 0xf0a868)
  T.fog(groundFog(320, 110, 0.4, 10), 0xf8b868)

  // capa 3: andamios, grúas, carteles y tanques
  L = T.layer(3)
  const near = 0x541c1a
  scaffold(L, 20, 420, 96, 130, near)
  scaffold(L, 560, 420, 72, 100, near)
  crane(L, 330, 420, 220, 150, near)
  crane(L, 700, 420, 176, -130, near)
  billboard(L, 150, 300, 64, 34, { frame: near, bg: 0x8a3a28, ink: 0x3e1410, hi: 0xf0c060, lamp: 0xffe27a }, 'tank')
  billboard(L, 440, 290, 44, 36, { frame: near, bg: 0xe0a83a, ink: 0x3e1410, hi: 0xffd070, lamp: 0xffe27a }, 'skull')
  tankFarm(L, 250, 425, 20, 48, { dark: near, band: 0x421412, rim: 0xc05a34 })
  tankFarm(L, 640, 425, 16, 40, { dark: near, band: 0x421412, rim: 0xc05a34 })
  for (let x = 0; x < 800; x++) for (let y = 412; y < 450; y++) L.put(x, y, near)
  T.fog(horizonFog(260, 420, 0.08), 0xf0a868)
  T.fog(groundFog(360, 80, 0.36, 8), 0xf8b868)

  // capa 4: siluetas cercanas con canto de luz naranja
  L = T.layer(4)
  const fg = { dark: 0x2a1210, rim: 0xd8683a, light: 0x5a2418, band: 0x1c0c0a }
  const arms = pylon(L, 120, 452, 250, fg.dark, fg.light)
  // cables al borde derecho
  for (const [ax, ay] of arms.slice(1, 2)) {
    for (let x = ax; x < 800; x++) {
      const t = (x - ax) / (800 - ax)
      L.put(x, ay + 6 + Math.sin(t * Math.PI) * 40 - t * 30, fg.dark)
    }
  }
  for (let x = 0; x < arms[0][0]; x++) L.put(x, arms[0][1] + 6 + Math.sin((x / arms[0][0]) * Math.PI) * 10, fg.dark)
  // puente de caños sobre pilares
  for (const x of [560, 660, 760]) {
    for (let y = 300; y < 452; y++) for (let k = 0; k < 4; k++) L.put(x + k, y, k === 3 ? fg.light : fg.dark)
    for (let dx = -8; dx <= 11; dx++) L.put(x + dx, 300, fg.dark), L.put(x + dx, 301, fg.dark)
  }
  pipe(L, 540, 800, 290, 6, fg)
  pipe(L, 540, 800, 282, 4, fg)
  tankFarm(L, 40, 452, 34, 60, fg)
  chimney(L, 790, 452, 300, 12, { dark: fg.dark, light: fg.light, band: fg.band, lamp: 0xff4a2a })
  fence(L, 300, 520, 452, 20, fg.dark)
  T.fog(groundFog(400, 60, 0.28, 8), 0xf8b868)
  return T.layers
}

export const BIOME_PAINTERS = { forest, jungle, industrial }

// fog: color de la niebla/polvo del bioma; tint: luz que el renderer puede usar para teñir humo y partículas.
export const BIOME_BG = {
  forest: { fog: FOG, tint: 0xfff2e2 },
  jungle: { fog: 0xcfe6e6, tint: 0xeaf6ff },
  industrial: { fog: 0xf0a868, tint: 0xffcc98 },
}

// grass: [base, medio, punta] de los pastitos; moss: piedra con musgo; rim: canto de tierra al aire; ambient: luz sobre el terreno.
export const BIOME_PALETTE = {
  forest: { grass: [0x3d4a2c, 0x5d6640, 0x8a8456], moss: 0x4d5a36, rim: 0x46352a, ambient: 0xffffff },
  jungle: { grass: [0x24502a, 0x3a7434, 0x6aa84a], moss: 0x3a6a2e, rim: 0x40302a, ambient: 0xe8f4f4 },
  industrial: { grass: [0x4a3a24, 0x6a5430, 0x9a7a44], moss: 0x5a4a2a, rim: 0x4e3626, ambient: 0xffe6cc },
}
