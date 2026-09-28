// Prueba de look: una escena estática 800×450 con el estilo buscado (Broforce + Scorched Earth).
// No es código del juego. Sirve para validar el enfoque de arte antes de refactorizar.
// Uso: node scripts/lookdev/look-test.mjs  → preview/look-test*.png
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Canvas, rgb, c8, mix, mul, hash, rnd, makeRand, bayer, noise1, FOG, OUT, flatTarget, paintForestBackground,
  stoneColor, brickColor, dirtColor, plankColor, slatColor, beamColor, postColor,
  BARREL, BARREL_PAL, crate as crateAt, ladder as ladderAt, windsock as windsockAt, flag as flagAt,
  TANK, TANK_W, TANK_H, TREAD_H, PIVOT, BARREL_LEN, CREW_W, CREW_X, tankPal, treads as treadsAt, barrel as barrelAt, antenna,
  CREW_BANDANA, CREW_SARGE, SKIN, BANDANA_PAL, SARGE_PAL, BUBBLE_ALERT, BUBBLE_ASK, text as textAt,
} from './pixel.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })

const W = 800
const H = 450
const cv = new Canvas(W, H)
const px = cv.px

const put = (x, y, c, a = 1) => cv.put(x, y, c, a)
const sprite = (rows, x0, y0, pal, flip = false) => cv.sprite(rows, x0, y0, pal, flip)
const spriteScaled = (rows, x0, y0, pal, s) => cv.spriteScaled(rows, x0, y0, pal, s)
const rect = (x, y, w, h, c, a = 1) => cv.rect(x, y, w, h, c, a)
const disc = (cx, cy, r, colorAt, a = 1) => cv.disc(cx, cy, r, colorAt, a)
const text = (str, x, y, c, shadow = OUT) => textAt(cv, str, x, y, c, shadow)
const crate = (x0, y0, s = 12) => crateAt(cv, x0, y0, s)
const ladder = (x0, y0, y1) => ladderAt(cv, x0, y0, y1)
const windsock = (x, ground, wind) => windsockAt(cv, x, ground, wind)
const flag = (x, ground) => flagAt(cv, x, ground)
const treads = (x0, y0) => treadsAt(cv, x0, y0)
const barrel = (px0, py0, angle, hull) => barrelAt(cv, px0, py0, angle, hull)

const R = makeRand(1337)
const rand = R.next

// ---------- 3. terreno: grilla de materiales por pixel ----------


const AIR = 0
const DIRT = 1
const STONE = 2
const BRICK = 3
const WOOD = 4
const SLAT = 5
const BEAM = 6
const POST = 7

const front = new Uint8Array(W * H)
const back = new Uint8Array(W * H)
const idx = (x, y) => y * W + x
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H
const F = (x, y) => (inside(x, y) ? front[idx(x, y)] : AIR)
const setF = (x, y, m) => inside(x, y) && (front[idx(x, y)] = m)
const setB = (x, y, m) => inside(x, y) && (back[idx(x, y)] = m)
const fill = (x0, y0, x1, y1, m, grid = front) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x, y)) grid[idx(x, y)] = m
}

// Perfil: plataforma de piedra, valle, cerro en el medio, otro valle, meseta con búnker y torre.
const PLAT_Y = 333
const PY = 317
const BX = 633
const TOWER_X = 700

function surface(x) {
  let v = 367 + (noise1(x, 70, 7) - 0.5) * 15 + (noise1(x, 17, 8) - 0.5) * 5
  v -= 90 * Math.exp(-(((x - 417) / 43) ** 2)) + 12 * Math.exp(-(((x - 385) / 12) ** 2))
  v -= 10 * Math.exp(-(((x - 508) / 25) ** 2))
  let y = v
  if (x < 192) y = PLAT_Y
  else if (x < 242) y = PLAT_Y + (v - PLAT_Y) * ((x - 192) / 50) + (noise1(x, 6, 3) - 0.5) * 3
  else if (x >= 583) y = PY
  else if (x >= 546) y = v + (PY - v) * ((x - 546) / 37)
  return Math.round(y)
}

const surf = []
// Cráteres viejos. El del tiro se agrega cuando se calcula la trayectoria.
const craters = [
  { x: 188, y: 336, r: 10 },
  { x: 377, y: 327, r: 8 },
  { x: 303, y: 367, r: 9 },
]

function buildTerrain() {
  for (let x = 0; x < W; x++) {
    const s = surface(x)
    surf[x] = s
    for (let y = s; y < H; y++) front[idx(x, y)] = DIRT
    if (x > 192 && x < 583 && rnd(x, 1) > 0.6) setF(x, s - 1, DIRT)
  }
  // plataforma de piedra a la izquierda, con bloques enterrados
  fill(14, PLAT_Y, 191, PLAT_Y + 13, STONE)
  fill(4, PLAT_Y, 14, PLAT_Y + 7, STONE)
  fill(100, PLAT_Y + 14, 146, PLAT_Y + 20, STONE)
  fill(33, PLAT_Y + 37, 58, PLAT_Y + 43, STONE)
  // piedras sueltas en el cerro
  fill(405, 297, 423, 303, STONE)
  // meseta derecha: tapa de piedra, búnker de ladrillo abajo
  fill(583, PY, W - 1, PY + 7, STONE)
  fill(BX, PY + 8, BX + 150, PY + 68, BRICK)
  fill(BX + 10, PY + 18, BX + 140, PY + 56, AIR)
  fill(BX, PY + 57, BX + 150, PY + 64, STONE)
  fill(BX + 22, PY, BX + 29, PY + 17, AIR)

  // cueva bajo el valle
  for (let y = 383; y < 417; y++) {
    for (let x = 262; x < 372; x++) {
      const cx = 317 + Math.sin(y / 5) * 5
      const r = 18 - Math.abs(y - 400) * 0.9 + (noise1(x + y * 3, 3, 9) - 0.5) * 3
      if (Math.abs(x - cx) * 0.9 < r * 1.8 && Math.abs(y - 400) < 12) setF(x, y, AIR)
    }
  }

  // la parte de atrás es lo que había antes de romper
  back.set(front)
  fill(BX + 10, PY + 18, BX + 140, PY + 56, BRICK, back)
  fill(BX + 22, PY, BX + 29, PY + 17, BRICK, back)
  for (let y = 383; y < 417; y++) for (let x = 262; x < 372; x++) if (F(x, y) === AIR) setB(x, y, DIRT)

  buildTower()
}

function carveCraters() {
  for (const c of craters) crater(c.x, c.y, c.r)
}

function buildTower() {
  const t = TOWER_X
  const b = PY - 250
  const posts = [t, t + 18, t + 38, t + 55]
  for (const x of posts) fill(x, b + 210, x + 3, b + 249, POST)
  fill(t - 12, b + 208, t + 64, b + 212, BEAM)
  fill(t, b + 220, t + 58, b + 249, WOOD)
  fill(t + 24, b + 230, t + 34, b + 249, AIR, front)
  fill(t + 24, b + 230, t + 34, b + 249, WOOD, back)
  fill(t, b + 220, t + 58, b + 223, BEAM)
  fill(t + 2, b + 168, t + 56, b + 207, SLAT)
  fill(t + 12, b + 178, t + 28, b + 192, AIR)
  fill(t + 12, b + 178, t + 28, b + 192, WOOD, back)
  fill(t - 4, b + 162, t + 62, b + 167, BEAM)
  for (const x of [t + 2, t + 54]) fill(x, b + 168, x + 2, b + 207, POST)
}

function crater(cx, cy, r) {
  for (let y = cy - r - 2; y <= cy + r + 2; y++) {
    for (let x = cx - r - 2; x <= cx + r + 2; x++) {
      const d = Math.hypot(x - cx, (y - cy) * 1.1) + (rnd(x, y, 5) - 0.5) * 2.2
      if (d < r) setF(x, y, AIR)
    }
  }
}

// ---------- texturas por material ----------

function materialColor(m, x, y) {
  switch (m) {
    case DIRT:
      return dirtColor(x, y)
    case STONE:
      return stoneColor(x, y)
    case BRICK:
      return brickColor(x, y)
    case WOOD:
      return plankColor(x, y)
    case SLAT:
      return slatColor(x, y)
    case BEAM: {
      let y0 = y
      while (F(x, y0 - 1) === BEAM) y0--
      return beamColor(x, y, y0)
    }
    case POST:
      return postColor(x - TOWER_X)
    default:
      return 0xff00ff
  }
}


function paintTerrainBack() {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = back[idx(x, y)]
      if (m === AIR || F(x, y) !== AIR) continue
      let c = mix(mul(materialColor(m, x, y), 0.3), 0x0e0806, 0.3)
      // oclusión: más oscuro cerca del techo sólido
      let occ = 0
      for (let k = 1; k <= 6; k++) if (F(x, y - k) !== AIR) occ = Math.max(occ, 1 - k / 7)
      for (let k = 1; k <= 3; k++) if (F(x - k, y) !== AIR || F(x + k, y) !== AIR) occ = Math.max(occ, (1 - k / 4) * 0.6)
      c = mix(c, 0x080504, occ * 0.7)
      for (const cr of craters) {
        const d = Math.hypot(x - cr.x, y - cr.y)
        if (d < cr.r + 2) c = mix(c, 0x0a0605, 0.35 + 0.35 * (1 - d / cr.r))
      }
      put(x, y, c)
    }
  }
}

const WOODISH = new Set([WOOD, SLAT, BEAM, POST])

function paintTerrainFront() {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = front[idx(x, y)]
      if (m === AIR) continue
      let c = materialColor(m, x, y)
      const up = F(x, y - 1) === AIR
      const down = F(x, y + 1) === AIR
      const left = F(x - 1, y) === AIR
      const right = F(x + 1, y) === AIR
      if (WOODISH.has(m) && (up || down || left || right)) {
        c = OUT
      } else if (m === DIRT) {
        if (up) c = rnd(x, y, 3) > 0.5 ? 0x46352a : 0x3a2c21
        else if (F(x, y - 2) === AIR) c = 0x2e2118
        else if (down) c = 0x100a07
        else if (left || right) c = mul(c, 0.7)
      } else {
        if (down) c = mul(c, 0.5)
        else if (left || right) c = mul(c, 0.72)
      }
      // chamuscado alrededor del cráter
      for (const cr of craters) {
        const d = Math.hypot(x - cr.x, y - cr.y)
        const band = 6
        if (d < cr.r + band) {
          const k = 1 - (d - cr.r) / band
          if (k > bayer(x, y) * 0.9) c = mix(c, 0x0c0706, Math.min(0.6, 0.2 + k * 0.45))
        }
      }
      // cara expuesta hacia un hueco (borde del cráter o cueva): canto claro
      const hole = (xx, yy) => F(xx, yy) === AIR && inside(xx, yy) && back[idx(xx, yy)] !== AIR
      if (!up && (hole(x, y - 1) || hole(x - 1, y) || hole(x + 1, y))) c = m === DIRT ? 0x4e3b2a : mix(c, 0xb0a68c, 0.35)
      else if (hole(x, y + 1)) c = 0x0a0605
      put(x, y, c)
    }
  }
}

// pastito seco, musgo y raíces colgando
function paintTufts() {
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H; y++) {
      const m = F(x, y)
      if (m === AIR) continue
      if (F(x, y - 1) === AIR && (m === DIRT || m === STONE)) {
        const r = rnd(x, y, 81)
        const nearCrater = craters.some((c) => Math.hypot(x - c.x, y - c.y) < c.r + 10)
        if (nearCrater) continue
        if (r > 0.55) {
          const h = 1 + Math.floor(rnd(x, y, 82) * (m === STONE ? 2 : 4))
          for (let k = 1; k <= h; k++) put(x, y - k, k === h ? 0x8a8456 : k === 1 ? 0x3d4a2c : 0x5d6640)
        }
        if (m === STONE && r > 0.8) put(x, y, 0x4d5a36)
      }
      if (m === DIRT && F(x, y + 1) === AIR && back[idx(x, y + 1)] !== AIR && rnd(x, y, 83) > 0.8) {
        const h = 1 + Math.floor(rnd(x, y, 84) * 4)
        for (let k = 1; k <= h; k++) put(x, y + k, k === h ? 0x1a110c : 0x2a1c13)
      }
    }
  }
}

// ---------- 5. tanques con tripulante ----------

function tank(cx, ground, opts) {
  const flip = opts.facing < 0
  const x0 = Math.round(cx - TANK_W / 2)
  const bodyTop = ground - TANK_H
  const pal = tankPal(opts.hull, opts.stripe)
  const fx = (x) => (flip ? x0 + TANK_W - 1 - x : x0 + x)

  // antena con banderín
  antenna(cv, fx(9), bodyTop, opts.stripe[1], flip)

  // cañón (detrás de la torreta)
  barrel(fx(PIVOT.x), bodyTop + PIVOT.y, opts.angle, opts.hull)

  sprite(TANK, x0, bodyTop, pal, flip)
  treads(x0, bodyTop + TANK.length)

  // tripulante asomado por la escotilla
  const crewX = flip ? x0 + TANK_W - CREW_X - CREW_W : x0 + CREW_X
  sprite(opts.crew, crewX, bodyTop - opts.crew.length + 1, { k: OUT, ...SKIN, ...opts.crewPal }, flip)
  return { bodyTop, x0 }
}

function muzzleOf(cx, ground, angle, facing) {
  const x0 = Math.round(cx - TANK_W / 2)
  const px0 = facing < 0 ? x0 + TANK_W - 1 - PIVOT.x : x0 + PIVOT.x
  const rad = (angle * Math.PI) / 180
  return { x: px0 + Math.cos(rad) * (BARREL_LEN + 3), y: ground - TANK_H + PIVOT.y - Math.sin(rad) * (BARREL_LEN + 3) }
}

// ---------- 6. tiro, explosión y partículas ----------

// Mismas reglas que src/sim: gravedad, viento, subpaso fijo. y crece hacia abajo acá.
const GRAVITY = 220
const WIND_ACCEL = 9
const SUBSTEP = 1 / 240

function flight(x, y, angle, speed, wind) {
  const rad = (angle * Math.PI) / 180
  let vx = Math.cos(rad) * speed
  let vy = Math.sin(rad) * speed
  const path = [{ x, y }]
  for (let n = 1; n < 240 * 12; n++) {
    vx += wind * WIND_ACCEL * SUBSTEP
    vy -= GRAVITY * SUBSTEP
    x += vx * SUBSTEP
    y -= vy * SUBSTEP
    if (n % 4 === 0) path.push({ x, y })
    if (x < -40 || x > W + 40 || y > H) return { path, hit: null }
    if (y >= 0 && F(Math.round(x), Math.round(y)) !== AIR) return { path, hit: { x: Math.round(x), y: Math.round(y) } }
  }
  return { path, hit: null }
}

// Busca la velocidad que hace caer el tiro en targetX, con ángulo fijo.
function solveSpeed(m, angle, wind, targetX) {
  let lo = 60
  let hi = 600
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const f = flight(m.x, m.y, angle, mid, wind)
    const lx = f.hit ? f.hit.x : f.path[f.path.length - 1].x
    if (lx < targetX) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function smokeTrail(path) {
  const n = path.length
  for (let i = 0; i < n; i += 2) {
    const t = i / (n - 1)
    const age = 1 - t
    const p = path[i]
    const r = 0.9 + age * 2.6 + rnd(i, 0, 5) * 1
    const a = 0.2 + (1 - age) * 0.6
    disc(p.x + age * age * 10, p.y - age * 4, r, (d) => (d > r - 1 ? 0xb8ada0 : 0xf7f2ea), a)
  }
}


function light(cx, cy, R, tint, k) {
  const [tr, tg, tb] = rgb(tint)
  for (let y = Math.max(0, cy - R); y < Math.min(H, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x < Math.min(W, cx + R); x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d >= R) continue
      const f = Math.floor((1 - d / R) ** 2 * 10 + bayer(x, y)) / 10
      if (f <= 0) continue
      const i = (y * W + x) * 4
      px[i] = c8(px[i] + tr * f * k)
      px[i + 1] = c8(px[i + 1] + tg * f * k)
      px[i + 2] = c8(px[i + 2] + tb * f * k)
    }
  }
}

const FIRE = [0xfffbe2, 0xffe27a, 0xffb43e, 0xf77a28, 0xd24a1c, 0x8a2814]
const SMOKE = [0xa89c90, 0x847869, 0x62564c, 0x463b34, 0x2e2622]

// Nube de círculos: primero todos los contornos, después todos los rellenos.
function cluster(circles, ramp, outline) {
  for (const c of circles) disc(c.x, c.y, c.r + 1, () => outline)
  for (const c of circles) {
    disc(c.x, c.y, c.r, (d, x, y) => {
      const lx = x - (c.x - c.r * 0.35)
      const ly = y - (c.y - c.r * 0.4)
      const t = Math.min(1, Math.hypot(lx, ly) / (c.r * 1.45)) * 0.62 + c.heat
      const i = Math.min(ramp.length - 1, Math.floor((t + (bayer(x, y) - 0.5) * 0.22) * ramp.length))
      return ramp[Math.max(0, i)]
    })
  }
}

function explosion(cx, cy) {
  R.seed = 99
  // columna de humo
  const smoke = []
  for (let i = 0; i < 14; i++) {
    const t = i / 13
    smoke.push({
      x: cx + (rand() - 0.5) * 26 * (0.5 + t) + t * 12,
      y: cy - 16 - t * 52 + (rand() - 0.5) * 8,
      r: 6 + rand() * 6 + t * 4,
      heat: 0.15 + rand() * 0.3,
    })
  }
  cluster(smoke.reverse(), SMOKE, 0x18120e)

  // bola de fuego en racimo
  const fire = []
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * 20
    fire.push({ x: cx + Math.cos(a) * d * 1.1, y: cy - 6 + Math.sin(a) * d * 0.8 - 6, r: 5 + rand() * 8, heat: 0.05 + d / 60 })
  }
  fire.push({ x: cx, y: cy - 8, r: 12, heat: -0.1 })
  fire.sort((a, b) => b.heat - a.heat)
  cluster(fire, FIRE, 0x3a1208)

  // núcleo blanco y bocanadas calientes arriba
  cluster(
    [
      { x: cx - 3, y: cy - 12, r: 8, heat: -0.35 },
      { x: cx + 6, y: cy - 6, r: 6, heat: -0.3 },
      { x: cx - 8, y: cy - 2, r: 5, heat: -0.2 },
    ],
    FIRE,
    0xffb43e,
  )
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI * (0.15 + rand() * 0.7)
    const d = 26 + rand() * 14
    const r = 2.5 + rand() * 3
    cluster([{ x: cx + Math.cos(a) * d, y: cy - 8 + Math.sin(a) * d * 0.9, r, heat: 0.1 + rand() * 0.3 }], FIRE, 0x3a1208)
  }

  // polvo al ras del piso
  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const d = 20 + rand() * 30
    const r = 3 + rand() * 4
    disc(cx + side * d, cy + 16 - rand() * 4, r, (dd) => (dd > r - 1 ? 0x6e5c48 : 0x9a8468), 0.8)
  }

  // escombros: pedazos irregulares del material destruido
  const DEBRIS = [0x2a1c13, 0x3c2e22, 0x54432f, 0x807761, 0x9a9078]
  for (let i = 0; i < 34; i++) {
    const a = -Math.PI * (0.05 + rand() * 0.9)
    const dist = 30 + rand() * 80
    const x = Math.round(cx + Math.cos(a) * dist)
    const y = Math.round(cy - 6 + Math.sin(a) * dist * 0.85 + (dist / 80) ** 2 * 18)
    const col = DEBRIS[Math.floor(rand() * DEBRIS.length)]
    const shape = [
      [[0, 0]],
      [[0, 0], [1, 0]],
      [[0, 0], [1, 0], [0, 1]],
      [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1]],
    ][Math.floor(rand() * 4)]
    for (let k = 2; k < 6; k++) put(x - Math.cos(a) * k * 1.6, y - Math.sin(a) * k * 1.6 + k * 0.5, 0x3a302a, 0.45 - k * 0.06)
    if (shape.length > 2) for (const [ox, oy] of shape) for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(x + ox + ex, y + oy + ey, OUT)
    for (const [ox, oy] of shape) put(x + ox, y + oy, col)
    if (shape.length > 2) put(x, y, mix(col, 0xffffff, 0.25))
  }
  // pedazos en llamas con humo curvo (como los cohetes de la referencia 2)
  const trails = [
    [-70, 70],
    [-40, 95],
    [35, 110],
    [-100, 40],
  ]
  for (const [dx, peak] of trails) {
    let lx = cx
    let ly = cy
    for (let t = 0.08; t < 1; t += 0.025) {
      const x = cx + dx * t
      const y = cy - 12 - Math.sin(t * Math.PI * 0.8) * peak + t * t * 22
      const r = 0.8 + t * 2.4
      disc(x, y, r, (d) => (d > r - 0.8 ? 0xc8beb2 : 0xf7f2ea), 0.25 + t * 0.6)
      lx = x
      ly = y
    }
    cluster([{ x: lx, y: ly, r: 1.6, heat: 0.05 }], FIRE, 0x3a1208)
  }
  // chispas
  for (let i = 0; i < 40; i++) {
    const a = -Math.PI * rand()
    const d = 18 + rand() * 75
    const x = cx + Math.cos(a) * d
    const y = cy - 8 + Math.sin(a) * d
    put(x, y, 0xfffbe2)
    put(x - Math.cos(a), y - Math.sin(a), 0xffc64a)
    put(x - Math.cos(a) * 2, y - Math.sin(a) * 2, 0xf77a28, 0.7)
  }
}

// ---------- 7. globos y HUD ----------

function tagBubble(label, cx, bottom, fill) {
  const w = label.length * 4 + 7
  const x0 = Math.round(cx - w / 2)
  const y0 = bottom - 14
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < w; x++) {
      const corner = (y === 0 || y === 10) && (x === 0 || x === w - 1)
      if (corner) continue
      const edge = y === 0 || y === 10 || x === 0 || x === w - 1
      put(x0 + x, y0 + y, edge ? OUT : y === 9 ? mul(fill, 0.7) : fill)
    }
  }
  sprite(['kwwwk', '.kwk.', '..k..'], Math.round(cx - 2), y0 + 10, { k: OUT, w: fill })
  text(label, x0 + 3, y0 + 3, 0xffffff)
}

function hudPanel(x, y, flip, color, name, crew, crewPal, pips) {
  const pw = 40
  const px0 = flip ? x - pw : x
  rect(px0, y, pw, 32, OUT)
  rect(px0 + 1, y + 1, pw - 2, 30, color)
  rect(px0 + 3, y + 3, pw - 6, 26, 0x1c1614)
  for (let yy = 0; yy < 26; yy++) for (let xx = 0; xx < pw - 6; xx++) if (yy > 16) put(px0 + 3 + xx, y + 3 + yy, mix(0x1c1614, color, 0.25))
  const rows = crew.slice(0, 12).map((r) => (flip ? [...r].reverse().join('') : r))
  spriteScaled(rows, px0 + 8, y + 4, { k: OUT, ...SKIN, ...crewPal }, 2)
  const bw = 78
  const bx = flip ? px0 - bw + 1 : px0 + pw - 1
  rect(bx, y + 10, bw, 22, OUT)
  rect(bx + 1, y + 11, bw - 2, 20, color)
  rect(bx + 2, y + 12, bw - 4, 18, 0x0e0a09)
  text(name, bx + 5, y + 14, 0xffffff)
  for (let i = 0; i < 6; i++) {
    const on = i < pips
    const sx = bx + 5 + i * 7
    sprite(['.kk.', 'kyyk', 'krrk', 'krrk', 'kkkk'], sx, y + 22, { k: OUT, y: on ? 0xffe27a : 0x3a3230, r: on ? 0xd0362c : 0x2a2220 })
  }
}

// ---------- composición ----------

R.seed = 42
paintForestBackground(flatTarget(cv), rand)
buildTerrain()

// El tiro sale del cañón del P1 y tiene que pasar por encima del cerro.
const P1 = { x: 92, ground: PLAT_Y, angle: 55 }
const WIND = 3
const TARGET_X = 563
const m0 = muzzleOf(P1.x, P1.ground, P1.angle, 1)
const speed = solveSpeed(m0, P1.angle, WIND, TARGET_X)
const shot = flight(m0.x, m0.y, P1.angle, speed, WIND)
const hit = shot.hit ?? { x: TARGET_X, y: surf[TARGET_X] }
const apex = Math.min(...shot.path.map((p) => p.y))
craters.push({ x: hit.x, y: hit.y + 4, r: 15 })
carveCraters()

paintTerrainBack()

// dentro del búnker: foco, cajas, barril, escalera
ladder(BX + 21, PY - 2, PY + 55)
crate(BX + 98, PY + 45)
crate(BX + 110, PY + 45)
crate(BX + 104, PY + 33)
sprite(BARREL, BX + 124, PY + 45, BARREL_PAL)
rect(BX + 60, PY + 18, 1, 4, 0x2a2a24)
light(BX + 60, PY + 24, 34, 0xffb04a, 0.55)
disc(BX + 60, PY + 23, 1.6, () => 0xfff6c8)

paintTerrainFront()
paintTufts()

ladder(TOWER_X - 12, PY - 42, PY - 1)
sprite(BARREL, 668, PY - 12, BARREL_PAL)
crate(775, PY - 12)
for (let x = TOWER_X + 14; x < TOWER_X + 28; x += 4) rect(x, PY - 72, 1, 15, 0x3a3226)
flag(20, PLAT_Y)
windsock(250, surf[250], WIND)

const groundUnder = (cx) => {
  let best = H
  for (let d = -TANK_W / 2 + 2; d <= TANK_W / 2 - 2; d += 4) {
    let y = 100
    while (F(cx + d, y) === AIR && y < H - 1) y++
    best = Math.min(best, y)
  }
  return best
}

smokeTrail(shot.path)
disc(m0.x + 3, m0.y - 3, 2.6, (d) => (d > 1.8 ? 0xb8ada0 : 0xf2ece2), 0.9)
disc(m0.x - 1, m0.y - 6, 1.8, (d) => (d > 1.1 ? 0xb8ada0 : 0xf2ece2), 0.7)

const ROOKIE_PAL = { b: 0x2a2a2a, B: 0x4a4a4a, g: 0x6a3a1a, G: 0xc89a4a, c: 0x6b3e1f, e: 0xff8a30, n: 0x3a4454 }
const DESERT_PAL = { H: 0x8a7650, J: 0xb09a6c, M: 0x8a8a84, n: 0x6a5a3a }
const P1_TANK = tank(P1.x, P1.ground, {
  facing: 1,
  angle: P1.angle,
  hull: { D: 0x2c341e, d: 0x434d2a, m: 0x5c6836, l: 0x7c8a48, h: 0xa2ae66 },
  stripe: [0x1f58b8, 0x3d8cf0],
  crew: CREW_BANDANA,
  crewPal: BANDANA_PAL,
})
for (let i = 0; i < 4; i++) put(P1_TANK.x0 + CREW_X + 11 + (i % 2), P1_TANK.bodyTop - 7 - i * 2, 0xe8e0d4, 0.85 - i * 0.16)

const hillX = 417
const hillG = groundUnder(hillX)
tank(hillX, hillG, {
  facing: -1,
  angle: 128,
  hull: { D: 0x2a3038, d: 0x3e4854, m: 0x56626e, l: 0x74808a, h: 0x9aa4ac },
  stripe: [0xa88a14, 0xe2c13d],
  crew: CREW_BANDANA,
  crewPal: ROOKIE_PAL,
})
const valX = 510
const valG = groundUnder(valX)
tank(valX, valG, {
  facing: -1,
  angle: 140,
  hull: { D: 0x3a2a30, d: 0x54404a, m: 0x705866, l: 0x8e7482, h: 0xb096a2 },
  stripe: [0x2a8a4a, 0x3dbe5a],
  crew: CREW_SARGE,
  crewPal: DESERT_PAL,
})
const plateX = 612
tank(plateX, PY, {
  facing: -1,
  angle: 152,
  hull: { D: 0x4a3a24, d: 0x6a5636, m: 0x8c7650, l: 0xae9468, h: 0xcdb488 },
  stripe: [0x9a1e1a, 0xe23d3d],
  crew: CREW_SARGE,
  crewPal: SARGE_PAL,
})

// terrones caídos alrededor del cráter
R.seed = 7
for (let i = 0; i < 20; i++) {
  const x = Math.round(hit.x + (rand() < 0.5 ? -1 : 1) * (18 + rand() * 30))
  let y = 100
  while (F(x, y) === AIR && y < H - 1) y++
  const col = [0x2a1c13, 0x3c2e22, 0x54432f][Math.floor(rand() * 3)]
  put(x, y - 1, col)
  if (rand() < 0.5) {
    put(x + 1, y - 1, col)
    put(x, y - 2, mix(col, 0xffffff, 0.15))
  }
}

light(hit.x, hit.y - 14, 66, 0xff8a3a, 0.4)
explosion(hit.x, hit.y - 8)

tagBubble('P1', P1.x, P1.ground - 32, 0x2f7ae0)
sprite(BUBBLE_ASK, hillX - 5, hillG - 45, { k: OUT, w: 0xffffff, s: 0xc8c8c8 })
sprite(BUBBLE_ALERT, plateX - 5, PY - 45, { k: OUT, w: 0xffffff, s: 0xc8c8c8 })

hudPanel(2, H - 34, false, 0x2f7ae0, 'BRODOZER', CREW_BANDANA, BANDANA_PAL, 5)
hudPanel(W - 2, H - 34, true, 0xd0362c, 'SARGE', CREW_SARGE, SARGE_PAL, 2)

console.log(`tiro: ángulo ${P1.angle}°, viento ${WIND}, velocidad ${speed.toFixed(1)} px/s → potencia ${(speed / 3.15).toFixed(0)} con POWER_SCALE 3.15`)
console.log(`impacto en (${hit.x}, ${hit.y}), altura máxima y=${apex.toFixed(0)} (cima del cerro y=${surf[417]})`)
const needV = Math.sqrt((W - 60) * GRAVITY)
console.log(`para cruzar ${W - 60} px en llano hace falta v=${needV.toFixed(0)} px/s → POWER_SCALE ${(needV / 100).toFixed(2)}; con eso este tiro es potencia ${(speed / (needV / 100)).toFixed(0)}`)


// ---------- salida ----------

fs.writeFileSync(path.join(outDir, 'look-test.png'), cv.scaledPng(1))
fs.writeFileSync(path.join(outDir, 'look-test-x3.png'), cv.scaledPng(3))
fs.writeFileSync(path.join(outDir, 'look-test-tanks-x6.png'), cv.scaledPng(6, 60, 280, 100, 60))
fs.writeFileSync(path.join(outDir, 'look-test-boom-x4.png'), cv.scaledPng(3, 380, 220, 300, 140))
console.log('look test ok')
