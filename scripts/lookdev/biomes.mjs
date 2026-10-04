// Fondos por bioma en capas 800×450 con alfa, y paleta de terreno por bioma.
// forest reproduce la referencia aprobada; jungle e industrial siguen la misma receta (capas + niebla).
//
// Repetición a lo ancho (v2.3): cada capa dice en el manifiesto cómo se repite (BIOME_REPEAT, repeat por capa):
// - 'wrap' (capas 1 a 4 de los tres biomas): la capa repetida tal cual, una al lado de la otra. Son periódicas:
//   se pintan sobre WrapCanvas (lo que cruza un borde entra por el otro, con los mismos pixels), los elementos
//   repetidos se reparten en 800 justo (i · 800 / n), el ruido de las crestas es noiseLoop con período entero
//   y la niebla depende solo de y y de bayer (período 4). Nada se espeja: los humos van todos para el mismo
//   lado, las palmeras se inclinan como quieran y ningún hito queda doble en una unión.
// - 'mirror' (el cielo, capa 0): copia y copia espejada, como en v2. Con parallax 0,04 de la copia se ven a lo
//   sumo ~64 px en Grande, y el espejo empalma sin costura el degradé, el resplandor y el sol, que no son
//   periódicos (pintarlos periódicos movería el resplandor del bosque de la referencia).
// Lo que se ve en Chico (una pantalla) es la capa entera de 0 a 800: lo que asoma por un borde aparece del otro
// lado de la pantalla, así que lo grande se ubica entero adentro o cruzando poco el borde.
import { WrapCanvas, mix, mul, rnd, hash, bayer, noise1, noiseLoop, gradient, makeRand, FOG, paintForestBackground, waterTower } from './pixel.mjs'

export const BG_W = 800
export const BG_H = 450

// ruido 1D periódico en BG_W: la escala se ajusta a la más cercana que entra un número entero de veces en
// BG_W (150 → 160, 40 → 40, 90 → 88,9), así la cresta o el borde de copas empalman en la unión
const pnoise = (x, scale, s) => {
  const period = Math.max(1, Math.round(BG_W / scale))
  return noiseLoop(x, BG_W / period, period, s)
}
// n posiciones repartidas en BG_W justo (separación BG_W / n), para que la densidad siga pareja en la unión
const spread = (i, n) => (i * BG_W) / n

// Capas separadas; fog() tiñe todo lo que ya está pintado, igual que haze() sobre el canvas plano.
export function layeredTarget(n, w = BG_W, h = BG_H) {
  // WrapCanvas: las capas periódicas se pintan envolviendo en x; el cielo se pinta adentro de [0, w) y no se entera
  const layers = Array.from({ length: n }, () => new WrapCanvas(w, h))
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
  paintForestBackground(T, R.next, { periodic: true })
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
    const top = Math.round(y0 - pnoise(x, scale, s) * amp - pnoise(x, scale / 4, s + 1) * amp * 0.25)
    for (let y = top; y < cv.h; y++) cv.put(x, y, color)
  }
}

// cortina de copas que cuelga del borde de arriba, con hojas largas colgando
function overhang(cv, pal, rand, s) {
  // periódica: 57 copas y 89 matas de hojas repartidas en el ancho justo (el canvas envuelve lo que sobra)
  for (let i = 0; i < 57; i++) {
    const x = Math.round(spread(i, 57))
    const depth = 8 + pnoise(x, 90, s) * 30
    crown(cv, x + rand() * 10, depth - 8, 12 + rand() * 8, pal, s + x)
  }
  for (let i = 0; i < 89; i++) {
    const x = Math.round(spread(i, 89))
    const depth = 10 + pnoise(x, 90, s) * 30
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

  // capa 1: sierra lejana con selva en la cresta (cresta periódica: pnoise con escala 160)
  let L = T.layer(1)
  const farC = 0x8cbac4
  ridge(L, 236, 70, 150, farC, 11)
  for (let i = 0; i < 40; i++) {
    const x = Math.round(spread(i, 40) + rand() * 12)
    const top = 236 - pnoise(x, 150, 11) * 70 - pnoise(x, 150 / 4, 12) * 70 * 0.25
    crown(L, x, top + 4, 6 + rand() * 6, { dark: farC }, 50 + i)
  }
  for (let i = 0; i < 6; i++) {
    const x = Math.round(60 + spread(i, 6) + rand() * 60)
    const h = 50 + rand() * 30
    palm(L, x, 250, h, (rand() - 0.5) * 0.6, { dark: farC }, 90 + i, 7, 0.6)
  }
  // la pirámide a x = 180 y la cascada entera a x = 760 (antes centrada en el borde para que el espejo la
  // completara); con 'wrap' cada una aparece una vez cada 800 px de capa, sin reflejo
  temple(L, 180, 258, 140, 6, 10, { dark: 0x6a96a4, shade: 0x5e8a98, light: 0x8cb8c0, door: 0x46707e, vine: 0x5a8a7e })
  waterfall(L, 760, 176, 12, 92, { rock: 0x6e9aa8, rockShade: 0x608c9a, water: 0xcfeaf0, light: 0xb4dce6, foam: 0xf0fafa })
  T.fog(horizonFog(120, 330, 0.35), 0xcfe6e6)

  // capa 2: pared de selva media; las palmeras se inclinan cada una a su lado y las que cruzan un borde
  // siguen del otro (WrapCanvas)
  L = T.layer(2)
  const midPal = { dark: 0x5a8e92, light: 0x70a4a4, shade: 0x4c7e84 }
  for (let i = 0; i < 9; i++) {
    const x = Math.round(20 + spread(i, 9) + rand() * 50)
    const h = 110 + rand() * 60
    palm(L, x, 300, h, (rand() - 0.5) * 0.9, midPal, 200 + i, 9, 0.8)
  }
  for (let i = 0; i < 36; i++) {
    const x = Math.round(spread(i, 36) + rand() * 14)
    crown(L, x, 282 + rand() * 30, 14 + rand() * 12, midPal, 100 + i)
  }
  ridge(L, 306, 10, 40, midPal.dark, 12)
  T.fog(horizonFog(160, 340, 0.3), 0xcfe6e6)
  T.fog(groundFog(300, 120, 0.45, 10), 0xd8ecea)

  // capa 3: selva cercana, más oscura, con lianas entre copas
  L = T.layer(3)
  const nearPal = { dark: 0x30605c, light: 0x44786e, shade: 0x26504c }
  // ceibas enteras en 300 y 758 (la de la derecha antes iba centrada en el borde): en Chico se ven como antes
  kapok(L, 300, 372, 170, nearPal, 610)
  kapok(L, 758, 372, 150, nearPal, 620)
  for (let i = 0; i < 6; i++) {
    const x = Math.round(60 + spread(i, 6) + rand() * 60)
    const h = 140 + rand() * 70
    palm(L, x, 370, h, (rand() - 0.5) * 1.1, nearPal, 400 + i, 10, 1)
  }
  for (let i = 0; i < 24; i++) {
    const x = Math.round(spread(i, 24) + rand() * 20)
    crown(L, x, 338 + rand() * 22, 18 + rand() * 12, nearPal, 300 + i)
  }
  ridge(L, 360, 8, 30, nearPal.dark, 13)
  // lianas entre copas: la que pasa el borde derecho sigue en el izquierdo
  for (let i = 0; i < 5; i++) {
    const x = Math.round(spread(i, 5) + rand() * 60)
    const y0 = 318 + rand() * 20
    const x1 = x + 70 + rand() * 50
    const y1 = 320 + rand() * 20
    vine(L, x, y0, x1, y1, 16 + rand() * 12, nearPal, i)
  }
  T.fog(horizonFog(200, 380, 0.14), 0xcfe6e6)
  T.fog(groundFog(340, 90, 0.4, 8), 0xd8ecea)

  // capa 4: marco cercano, techo de hojas, lianas y matas en los rincones
  L = T.layer(4)
  const fg = { dark: 0x1a3632, light: 0x2a4c44, shade: 0x122824 }
  overhang(L, fg, rand, 900)
  for (let i = 0; i < 11; i++) {
    const x = Math.round(30 + spread(i, 11) + rand() * 30)
    liana(L, x, 20, Math.round(50 + rand() * 150), fg, 700 + i)
  }
  // lianas colgadas del techo de hojas: una termina en x = 800 y la otra nace en x = 0 a la misma altura,
  // así en la unión la curva sigue (escondida entre las copas)
  vine(L, 0, 30, 300, 36, 46, fg, 1)
  vine(L, 500, 26, BG_W, 30, 54, fg, 2)
  // marco: dos palmeras que se inclinan hacia adentro, la izquierda entera a x = 200 y la derecha a x = 770
  // (las puntas de sus hojas asoman por el borde izquierdo entre las copas del techo), y una mata en el rincón
  // que el canvas parte entre los dos bordes (en Chico se ve como las dos matas de antes)
  palm(L, 200, 452, 280, 0.35, fg, 500, 10, 1.4)
  palm(L, 770, 452, 300, -0.3, fg, 501, 10, 1.4)
  bush(L, 0, 452, 64, fg, rand)
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

// columna de humo que sale de (x, y) y se va con el viento hacia la derecha, `drift` veces lo de antes.
// v2.3: con las capas periódicas ('wrap') no hay copia espejada, así que todos los humos derivan hacia el
// mismo lado (0,6: inclinados sin acostarse sobre el zepelín); el que pasa el borde derecho sigue en el izquierdo.
function smoke(cv, x, y, n, pal, s, drift = 1) {
  const puffs = []
  let cx = x
  let cy = y
  for (let i = 0; i < n; i++) {
    const t = i / n
    puffs.push({ x: cx, y: cy, r: 3 + t * 13 + rnd(i, 1, s) * 3, t })
    cx += drift * (4 + t * 7) + (rnd(i, 2, s) - 0.5) * 4 * Math.min(1, drift + 0.5)
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
    const x0 = Math.round(rand() * 800)
    const w = Math.round(80 + rand() * 200)
    const x = Math.max(4, Math.min(BG_W - 4 - w, x0))
    const c = y < 150 ? 0x9a3038 : y < 220 ? 0xd05a34 : 0xf49a4a
    for (let k = 0; k < w; k++) {
      const hh = Math.round(Math.sin((k / w) * Math.PI) * 3)
      for (let j = 0; j < hh; j++) sky.put(x + k, y + j, j === hh - 1 ? mul(c, 0.82) : j === 0 ? mix(c, 0xffe0a0, 0.3) : c)
    }
  }

  // capa 1: ciudad industrial lejana
  let L = T.layer(1)
  const far = 0xd4785a
  for (let i = 0; i < 18; i++) {
    const x = Math.round(spread(i, 18) + rand() * 20 - 20)
    factory(L, x, 356, 30 + Math.round(rand() * 40), 20 + Math.round(rand() * 44), { dark: far }, i, false)
  }
  for (let i = 0; i < 9; i++) chimney(L, Math.round(20 + spread(i, 9) + rand() * 40), 356, 70 + rand() * 70, 5, { dark: far })
  // la torre de enfriamiento grande entera a x = 720 (antes centrada en el borde); la chica y el tanque de
  // agua a la izquierda
  coolingTower(L, 720, 360, 96, 46, far)
  coolingTower(L, 150, 360, 74, 38, far)
  waterTower(L, 230, 360, far, 118)
  blimp(L, 250, 118, 0x6a2a34, 0xa84a42)
  for (const [bx, by] of [[430, 150], [442, 144], [452, 152], [466, 140], [478, 147]]) L.sprite(['k...k', '.k.k.'], bx, by, { k: 0x4a1a24 })
  T.fog(horizonFog(150, 360, 0.3), 0xf0a868)

  // capa 2: fábricas medias con chimeneas humeantes
  L = T.layer(2)
  const mid = { dark: 0x8a3628, light: 0xc8603c, band: 0x6a2820, win: 0xf8c050, winOff: 0x6a2820, lamp: 0xff5a3a }
  // cinco chimeneas cada 160 px; los humos derivan todos a la derecha y el de la última cruza el borde y
  // entra por la izquierda (en Chico parece venir de una chimenea fuera de cuadro)
  const stacks = [130, 290, 450, 610, 770].map((x) => ({ x, h: Math.round(150 + rand() * 70) }))
  stacks.forEach(({ x, h }, i) => smoke(L, x, 385 - h - 2, 22, { dark: 0x7a4e48, mid: 0x9a6a5c, light: 0xc89276 }, i + 3, 0.6))
  for (let i = 0; i < 10; i++) {
    const x = Math.round(spread(i, 10) + rand() * 30 - 20)
    factory(L, x, 385, 50 + Math.round(rand() * 40), 30 + Math.round(rand() * 34), mid, 10 + i)
  }
  stacks.forEach(({ x, h }) => chimney(L, x, 385, h, 8, mid))
  // torre de enfriamiento entera pegada al borde izquierdo, con el canto de luz del sol
  coolingTower(L, 40, 392, 124, 54, mid.dark, mid.light)
  T.fog(horizonFog(200, 390, 0.16), 0xf0a868)
  T.fog(groundFog(320, 110, 0.4, 10), 0xf8b868)

  // capa 3: andamios, grúas, carteles y tanques
  L = T.layer(3)
  const near = 0x541c1a
  // nada cruza los bordes: grúas a 330 y 600, andamios, carteles y tanques adentro; el piso es una franja pareja
  scaffold(L, 150, 420, 84, 130, near)
  scaffold(L, 690, 420, 72, 100, near)
  crane(L, 330, 420, 220, 150, near)
  crane(L, 600, 420, 176, -130, near)
  billboard(L, 244, 300, 64, 34, { frame: near, bg: 0x8a3a28, ink: 0x3e1410, hi: 0xf0c060, lamp: 0xffe27a }, 'tank')
  billboard(L, 440, 290, 44, 36, { frame: near, bg: 0xe0a83a, ink: 0x3e1410, hi: 0xffd070, lamp: 0xffe27a }, 'skull')
  tankFarm(L, 84, 425, 20, 48, { dark: near, band: 0x421412, rim: 0xc05a34 })
  tankFarm(L, 650, 425, 16, 40, { dark: near, band: 0x421412, rim: 0xc05a34 })
  for (let x = 0; x < 800; x++) for (let y = 412; y < 450; y++) L.put(x, y, near)
  T.fog(horizonFog(260, 420, 0.08), 0xf0a868)
  T.fog(groundFog(360, 80, 0.36, 8), 0xf8b868)

  // capa 4: siluetas cercanas con canto de luz naranja
  L = T.layer(4)
  const fg = { dark: 0x2a1210, rim: 0xd8683a, light: 0x5a2418, band: 0x1c0c0a }
  // torre de alta tensión entera a x = 60 y cables que salen de sus brazos derechos, cuelgan a lo ancho de la
  // capa y llegan a los brazos izquierdos de la misma torre 800 px después (cruzan el borde: la torre de al
  // lado en la repetición 'wrap')
  const PYLON_X = 60
  const arms = pylon(L, PYLON_X, 452, 250, fg.dark, fg.light)
  for (const [[ax, ay], [bx], sag] of [
    [arms[1], arms[0], 64],
    [arms[3], arms[2], 52],
  ]) {
    const span = bx + BG_W - ax
    for (let x = ax; x <= ax + span; x++) L.put(x, ay + 6 + Math.sin(((x - ax) / span) * Math.PI) * sag, fg.dark)
  }
  // puente de caños sobre pilares; termina con brida sobre el último pilar (antes seguía hasta el borde y el
  // espejo lo continuaba)
  for (const x of [550, 650, 750]) {
    for (let y = 300; y < 452; y++) for (let k = 0; k < 4; k++) L.put(x + k, y, k === 3 ? fg.light : fg.dark)
    for (let dx = -8; dx <= 11; dx++) L.put(x + dx, 300, fg.dark), L.put(x + dx, 301, fg.dark)
  }
  pipe(L, 540, 760, 290, 6, fg)
  pipe(L, 540, 760, 282, 4, fg)
  for (const [y, th] of [[290, 6], [282, 4]]) for (let k = -1; k <= th; k++) L.put(760, y + k, fg.dark), L.put(761, y + k, fg.dark)
  tankFarm(L, 220, 452, 34, 60, fg)
  // chimenea grande entera a x = 782 (antes centrada en el borde derecho)
  chimney(L, 782, 452, 300, 12, { dark: fg.dark, light: fg.light, band: fg.band, lamp: 0xff4a2a })
  fence(L, 300, 520, 452, 20, fg.dark)
  T.fog(groundFog(400, 60, 0.28, 8), 0xf8b868)
  return T.layers
}

// ---------- v3: nieve (atardecer azul y rosado) ----------
//
// Misma receta que los otros: cielo opaco en 'mirror' y cuatro capas periódicas en 'wrap' pintadas sobre
// WrapCanvas. El sol queda bajo, a la izquierda: los faldeos que miran a la izquierda y el lado izquierdo de
// los pinos van con luz rosada; los otros, en sombra azul.

// distancia con signo de x a x0 en la capa periódica (−400 .. 400): las montañas se evalúan con esto, así un
// pico cerca del borde sigue del otro lado
const wdx = (x, x0) => ((((x - x0) % BG_W) + BG_W * 1.5) % BG_W) - BG_W / 2

// Cordillera nevada. peaks: [{ x, h, k }] (k = pendiente). Cada columna toma el pico que la tapa más alto;
// arriba de la línea de nieve (snow px bajo la cumbre, con borde mordido) va nieve, abajo roca, y del lado de
// la sombra unas canaletas diagonales de nieve bajan por la roca.
function range(cv, base, peaks, pal, s, snow = 40) {
  for (let x = 0; x < BG_W; x++) {
    let top = 1e9
    let best = null
    let bdx = 0
    for (const p of peaks) {
      const dx = wdx(x, p.x)
      const t = base - p.h + Math.abs(dx) * p.k
      if (t < top) {
        top = t
        best = p
        bdx = dx
      }
    }
    // cresta mordida: detalle periódico chico encima de la recta
    top = Math.round(top + (pnoise(x, 14, s) - 0.5) * 6 + (pnoise(x, 5, s + 1) - 0.5) * 2)
    const lit = bdx < 0
    const peakY = base - best.h
    for (let y = top; y < cv.h; y++) {
      const below = y - peakY
      const edge = snow + (pnoise(x, 9, s + 2) - 0.5) * 22 + Math.abs(bdx) * 0.15
      let c
      if (below < edge) c = lit ? pal.snow : pal.snowShade
      else {
        c = lit ? pal.rock : pal.rockShade
        // canaletas de nieve que bajan por la roca siguiendo la pendiente: solo algunas (una de cada tres, de
        // largo distinto) y más en la cara en sombra, para que no quede un rayado parejo
        const g = y - peakY + Math.abs(bdx) * 0.8 + pnoise(x, 20, s + 3) * 10
        const gi = Math.floor(g / 13)
        const gh = hash(gi, best.x, s)
        const len = 12 + (gh >> 4) % 50
        if (gh % (lit ? 4 : 2) === 0 && g - gi * 13 < (lit ? 1.5 : 2.5) && below < edge + len && rnd(x, y, s) > 0.25) c = lit ? pal.snow : pal.snowShade
      }
      // canto de luz en la cresta del lado del sol
      if (lit && y - top < 1) c = pal.rim ?? c
      cv.put(x, y, c)
    }
  }
}

// Pino cargado de nieve: la silueta de pine() (pisos que se ensanchan hacia abajo) con nieve sobre cada piso
// (la parte de arriba del piso y el canto de afuera), copo en la punta y terrones colgando de las puntas.
function snowPine(cv, cx, base, h, pal, s) {
  const top = base - h
  const cb = base - Math.round(h * 0.08)
  const ch = cb - top
  const tiers = Math.max(3, Math.round(ch / 13))
  const maxW = h * 0.24
  const tw = h > 110 ? 2 : 1
  for (let y = top + 3; y < base; y++) for (let x = -tw + 1; x <= 0; x++) cv.put(cx + x, y, pal.trunk ?? pal.dark)
  for (let y = top; y < cb; y++) {
    const u = (y - top) / ch
    const tv = (u * tiers) % 1
    const grow = 1 + u * maxW
    const hwL = grow * (0.3 + 0.7 * tv) + (rnd(y, 1, s) - 0.5) * 1.6
    const hwR = grow * (0.3 + 0.7 * tv) + (rnd(y, 2, s) - 0.5) * 1.6
    const l = Math.round(cx - hwL)
    const r = Math.round(cx + hwR)
    for (let x = l; x <= r; x++) {
      const rel = (x - l) / Math.max(1, r - l)
      const n = rnd(x, y, s)
      let c = pal.dark
      if (pal.light && rel < 0.25 && tv > 0.4 && n > 0.45) c = pal.light
      else if (pal.shade && rel > 0.72 && n > 0.35) c = pal.shade
      // nieve en terrones sobre cada piso (no una franja pareja: cada tramo de 3 px del piso tiene su propia
      // altura de nieve, y alguno queda sin nieve), copo en la punta y cantos de afuera nevados
      const tier = Math.floor(u * tiers)
      const clump = rnd(Math.floor((x - cx + 64) / 3), tier, s + 7)
      const depth = clump < 0.2 ? 0 : 0.12 + clump * 0.26
      const cap = tv < depth + (n - 0.5) * 0.08 || u < 0.05
      const rimL = x - l < 2 && tv < 0.6 && clump > 0.3
      const rimR = r - x < 1 && tv < 0.4 && clump > 0.5
      if (cap || rimL || rimR) c = rel < 0.6 ? pal.snow : pal.snowShade
      cv.put(x, y, c)
    }
    // terrones de nieve colgando de las puntas de cada piso
    if (tv > 0.86) {
      cv.put(l - 1, y + 1, pal.snow)
      cv.put(r + 1, y + 1, pal.snowShade)
      if (rnd(y, 3, s) > 0.5) cv.put(l - 1, y + 2, pal.snowShade)
    }
  }
}

// Observatorio en la loma: tambor con cúpula de ranura abierta, puerta con luz y una antena de celosía con
// plato y luz roja de balizamiento.
function observatory(cv, cx, base, pal) {
  // tambor
  for (let y = base - 26; y < base; y++) {
    for (let x = cx - 18; x <= cx + 18; x++) {
      let c = x < cx - 10 ? pal.light : x > cx + 12 ? pal.shade : pal.dark
      if ((y - base) % 7 === 0) c = pal.shade
      cv.put(x, y, c)
    }
  }
  // cornisa con nieve
  for (let x = cx - 20; x <= cx + 20; x++) cv.put(x, base - 27, pal.snow), cv.put(x, base - 26, x > cx + 10 ? pal.snowShade : pal.snow)
  // cúpula
  const R = 17
  const dy0 = base - 27
  for (let y = dy0 - R; y <= dy0; y++) {
    for (let x = cx - R; x <= cx + R; x++) {
      const d = Math.hypot(x - cx, (y - dy0) * 1.05)
      if (d > R) continue
      let c = x - cx < -4 ? pal.snow : x - cx > 6 ? pal.snowShade : mix(pal.snow, pal.snowShade, 0.5)
      // ranura abierta con el telescopio asomando
      if (x >= cx - 2 && x <= cx + 2 && y < dy0 - 3) c = pal.slot
      cv.put(x, y, c)
    }
  }
  cv.line(cx, dy0 - 8, cx + 9, dy0 - 22, pal.dark, 2)
  // ventanitas iluminadas y puerta
  for (const wx of [cx - 13, cx - 3, cx + 7]) cv.rect(wx, base - 19, 3, 4, pal.win)
  cv.rect(cx - 2, base - 9, 5, 9, pal.win)
  cv.rect(cx - 2, base - 9, 5, 1, pal.dark)
}

function mast(cv, x, base, h, pal) {
  const top = base - h
  for (let y = top; y < base; y++) {
    const hw = Math.round(2 + ((y - top) / h) * 6)
    cv.put(x - hw, y, pal.dark)
    cv.put(x + hw, y, pal.dark)
    if ((y - top) % 8 === 0) {
      const hw2 = Math.round(2 + ((y + 8 - top) / h) * 6)
      cv.line(x - hw, y, x + hw2, y + 8, pal.dark)
      cv.line(x + hw, y, x - hw2, y + 8, pal.dark)
      for (let dx = -hw; dx <= hw; dx++) cv.put(x + dx, y, pal.dark)
      // nieve sobre cada travesaño
      for (let dx = -hw; dx <= hw - 1; dx++) cv.put(x + dx, y - 1, pal.snow)
    }
  }
  // plato parabólico mirando arriba a la izquierda
  const py = top + 22
  for (let k = -7; k <= 7; k++) {
    const d = Math.round((k * k) / 12)
    cv.put(x - 6 - d, py + k, pal.dark)
    cv.put(x - 5 - d, py + k, k < 0 ? pal.snow : pal.dark)
  }
  cv.line(x - 4, py, x, py, pal.dark)
  // luz de baliza
  cv.put(x, top - 2, pal.beacon)
  cv.put(x, top - 1, pal.dark)
  cv.put(x - 1, top - 2, mix(pal.beacon, pal.dark, 0.5))
  cv.put(x + 1, top - 2, mix(pal.beacon, pal.dark, 0.5))
}

// loma nevada: cresta periódica con lado de luz claro
function snowBank(cv, y0, amp, scale, pal, s) {
  for (let x = 0; x < BG_W; x++) {
    const top = Math.round(y0 - pnoise(x, scale, s) * amp - pnoise(x, scale / 4, s + 1) * amp * 0.25)
    const slope = pnoise(x + 3, scale, s) - pnoise(x - 3, scale, s)
    for (let y = top; y < cv.h; y++) {
      let c = y - top < 2 ? pal.snow : slope > 0 ? mix(pal.snow, pal.snowShade, 0.35) : pal.snowShade
      if (y - top > 10 && bayer(x, y) < Math.min(0.9, (y - top - 10) / 40)) c = pal.deep ?? pal.snowShade
      cv.put(x, y, c)
    }
  }
}

export function snow() {
  const T = layeredTarget(5)
  const R = makeRand(1912)
  const rand = R.next
  const sky = T.layer(0)
  skyGradient(sky, [
    // el rosado arranca alto: de y ≈ 130 para abajo lo tapa la cordillera
    [0, 0x32448a],
    [0.14, 0x5464a8],
    [0.28, 0x948ec6],
    [0.38, 0xd6a8cc],
    [0.5, 0xf4c0c4],
    [1, 0xfde0cc],
  ])
  // sol bajo a la izquierda, apoyado en un valle de la cordillera (la de atrás le tapa la parte de abajo)
  const SX = 215
  const SY = 176
  glow(sky, SX, SY, 360, 0xffe8d4, 0.6)
  sky.disc(SX, SY, 19, (d) => (d < 13 ? 0xfffaee : 0xffecd8))
  // estrellas solo arriba de todo (las primeras de la noche)
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < BG_W; x++) {
      // cada vez menos hacia abajo, y más tenues
      if (rnd(x, y, 1913) > 0.9975 + (y / 80) * 0.002) sky.put(x, y, mix(sky.get(x, y), 0xf4f0ff, 0.7 - y / 160))
    }
  }
  // nubes largas, lavanda arriba y rosadas con el canto de abajo encendido cerca del horizonte
  for (let i = 0; i < 9; i++) {
    const y = Math.round(70 + i * 22 + rand() * 10)
    const w = Math.round(70 + rand() * 180)
    const x = Math.max(4, Math.min(BG_W - 4 - w, Math.round(rand() * 800)))
    // más claras que el cielo que tienen atrás: el sol bajo las ilumina desde abajo
    const c = y < 130 ? 0x8288c4 : y < 190 ? 0xc0a2cc : 0xf2b8c4
    for (let k = 0; k < w; k++) {
      const hh = Math.round(Math.sin((k / w) * Math.PI) * 3)
      for (let j = 0; j < hh; j++) sky.put(x + k, y + j, j === hh - 1 ? mix(c, 0xffe4d8, 0.6) : j === 0 ? mul(c, 0.94) : c)
    }
  }

  // capa 1: dos cordilleras nevadas; la de atrás más pálida
  let L = T.layer(1)
  const backPeaks = Array.from({ length: 7 }, (_, i) => ({ x: Math.round(spread(i, 7) + 40 + rand() * 50), h: 110 + rand() * 60, k: 0.75 + rand() * 0.35 }))
  range(L, 300, backPeaks, { snow: 0xd8cce4, snowShade: 0xa4a8d0, rock: 0x9a9ccc, rockShade: 0x8a90c0, rim: 0xf4dce4 }, 31, 46)
  const mainPeaks = Array.from({ length: 5 }, (_, i) => ({ x: Math.round(spread(i, 5) + rand() * 60), h: 120 + rand() * 80, k: 0.95 + rand() * 0.4 }))
  // el pico alto (el hito lejano) a x = 470
  mainPeaks.push({ x: 470, h: 214, k: 1.05 })
  range(L, 318, mainPeaks, { snow: 0xf2e2ec, snowShade: 0x9aa2d0, rock: 0x7a7eb4, rockShade: 0x5e66a0, rim: 0xffeef0 }, 37, 52)
  T.fog(horizonFog(160, 330, 0.35), 0xd6dcf0)

  // capa 2: loma con el observatorio y la antena, pinos medios
  L = T.layer(2)
  const midPal = { dark: 0x4e5a8a, light: 0x62709e, shade: 0x444e7c, trunk: 0x40486e, snow: 0xc4cce8, snowShade: 0x96a2cc }
  snowBank(L, 336, 22, 160, { snow: 0xc8d0ea, snowShade: 0xa4aed4, deep: 0x96a0c8 }, 41)
  // lomita bajo el observatorio
  for (let x = 490; x < 650; x++) {
    const top = Math.round(312 + ((x - 570) / 80) ** 2 * 30)
    for (let y = top; y < 360; y++) L.put(x, y, y - top < 2 ? 0xd4dcf2 : x > 576 ? 0xa4aed4 : 0xbcc6e6)
  }
  observatory(L, 556, 314, { dark: 0x5a6492, light: 0x7480aa, shade: 0x48527e, snow: 0xd4dcf2, snowShade: 0xa0aad2, slot: 0x2a3054, win: 0xffd890 })
  mast(L, 612, 318, 118, { dark: 0x4a5482, snow: 0xc8d0ec, beacon: 0xff4a4a })
  for (let i = 0; i < 12; i++) {
    const x = Math.round(spread(i, 12) + rand() * 30)
    // la loma del observatorio queda despejada
    if (Math.abs(wdx(x, 580)) < 70) continue
    const h = 70 + rand() * 70
    snowPine(L, x, 352 + Math.round(rand() * 10), h, midPal, 200 + i)
  }
  T.fog(horizonFog(180, 380, 0.4), 0xd6dcf0)
  T.fog(groundFog(310, 110, 0.5, 10), 0xdee4f4)

  // capa 3: pinos cercanos cargados de nieve sobre un banco de nieve
  L = T.layer(3)
  const nearPal = { dark: 0x2e3a62, light: 0x3e4c76, shade: 0x262f54, trunk: 0x2a2c48, snow: 0xdce4f6, snowShade: 0xa6b4dc }
  for (let i = 0; i < 9; i++) {
    const x = Math.round(spread(i, 9) + rand() * 40)
    const h = 110 + rand() * 90
    // en Chico el observatorio (capa 2, x ≈ 556) queda a la vista
    if (Math.abs(wdx(x, 570)) < 50) continue
    snowPine(L, x, 404, h, nearPal, 300 + i)
  }
  snowBank(L, 402, 14, 100, { snow: 0xe2e8f8, snowShade: 0xb4c0e2, deep: 0xa0acd6 }, 43)
  T.fog(horizonFog(220, 420, 0.2), 0xd6dcf0)
  T.fog(groundFog(360, 80, 0.36, 8), 0xdee4f4)

  // capa 4: marco de pinos oscuros con mucha nieve, como el bosque (el gigante a 750, entero en pantalla)
  L = T.layer(4)
  const fg = { dark: 0x182238, light: 0x26344e, shade: 0x111a2c, trunk: 0x1e1c2a, snow: 0xeef3fc, snowShade: 0xa8b6d6 }
  for (const [x, h] of [
    [30, 210],
    [212, 246],
    [262, 150],
    [496, 270],
    [540, 160],
    [592, 120],
    [750, 430],
  ])
    snowPine(L, x, 440, h, fg, 400 + x)
  T.fog(groundFog(390, 60, 0.3, 8), 0xdee4f4)
  return T.layers
}

export const BIOME_PAINTERS = { forest, jungle, industrial, snow }

// v2.3: repeat por capa para el manifiesto (contrato en src/render/manifest.ts). El cielo queda en 'mirror'
// (degradé, resplandor y sol no son periódicos y con parallax 0,04 casi no se ve la copia); las capas 1 a 4,
// periódicas, en 'wrap'.
const REPEAT_5 = ['mirror', 'wrap', 'wrap', 'wrap', 'wrap']
export const BIOME_REPEAT = { forest: REPEAT_5, jungle: REPEAT_5, industrial: REPEAT_5, snow: REPEAT_5 }

// fog: color de la niebla/polvo del bioma; tint: luz que el renderer puede usar para teñir humo y partículas.
export const BIOME_BG = {
  forest: { fog: FOG, tint: 0xfff2e2 },
  jungle: { fog: 0xcfe6e6, tint: 0xeaf6ff },
  industrial: { fog: 0xf0a868, tint: 0xffcc98 },
  snow: { fog: 0xdee4f4, tint: 0xeef2ff },
}

// grass: [base, medio, punta] de los pastitos; moss: piedra con musgo; rim: canto de tierra al aire; ambient: luz sobre el terreno.
export const BIOME_PALETTE = {
  forest: { grass: [0x3d4a2c, 0x5d6640, 0x8a8456], moss: 0x4d5a36, rim: 0x46352a, ambient: 0xffffff },
  jungle: { grass: [0x24502a, 0x3a7434, 0x6aa84a], moss: 0x3a6a2e, rim: 0x40302a, ambient: 0xe8f4f4 },
  industrial: { grass: [0x4a3a24, 0x6a5430, 0x9a7a44], moss: 0x5a4a2a, rim: 0x4e3626, ambient: 0xffe6cc },
  // v3 nieve: el "pasto" es el borde de nieve (celeste en la base, blanco en la punta), la piedra con escarcha y
  // un canto azulado; luz fría
  snow: { grass: [0x9cb4d8, 0xcad8ee, 0xf6faff], moss: 0xc4d4ea, rim: 0x5a6680, ambient: 0xe6ecff },
}
