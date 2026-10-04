// v3: utilería nueva. Caja de botín (cae en paracaídas), objetivos pagos por bioma, mina y misil teledirigido.
// Todo con contorno OUT de 1 px y luz arriba a la izquierda, como barril y caja.
import { Canvas, OUT, mix, mul, rnd } from './pixel.mjs'

// ---------- caja de botín 14×12 ----------
// Cofre verde oliva con herrajes dorados y un "$" grande: se distingue de la caja común (madera marrón,
// 12×12) por color, tamaño y el signo.
export const LOOT_W = 14
export const LOOT_H = 12
export function lootProp() {
  const cv = new Canvas(LOOT_W, LOOT_H)
  const W = LOOT_W
  const H = LOOT_H
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1
      // esquinas redondeadas
      if ((x === 0 || x === W - 1) && (y === 0 || y === H - 1)) continue
      let c = x < 3 ? 0x5e8a3a : x > W - 4 ? 0x2e4a22 : 0x46703a
      // tapa: las 4 filas de arriba un poco más claras, con su canto
      if (y <= 3) c = mix(c, 0x8ab05a, 0.25)
      if (y === 4) c = 0x1e3016
      // herrajes dorados en las esquinas
      const corner = (x <= 2 || x >= W - 3) && (y <= 2 || y >= H - 3)
      if (corner) c = x + y < 4 || (x <= 2 && y <= 2 && x + y < 3) ? 0xfff0a0 : 0xd2a238
      if (edge) c = OUT
      cv.put(x, y, c)
    }
  }
  // "$" de 5×7 centrado, dorado con sombra
  const S = ['..Y..', '.YYYY', 'Y.Y..', '.YYY.', '..Y.Y', 'YYYY.', '..Y..']
  S.forEach((row, j) => {
    for (let i = 0; i < 5; i++) {
      if (row[i] !== 'Y') continue
      cv.put(5 + i, 3 + j + 1, 0x7a5a14)
      cv.put(4 + i, 3 + j, j < 3 ? 0xffe27a : 0xe2b23d)
    }
  })
  // brillo de la tapa
  cv.put(3, 1, 0xd8f0a8)
  cv.put(4, 1, 0xb8d888)
  return cv
}

// ---------- objetivos pagos 32×20, uno por bioma ----------
export const TARGET_W = 32
export const TARGET_H = 20

const shadeBox = (cv, x, y, w, h, base, light, dark) => {
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) cv.put(x + i, y + j, i === 0 || j === 0 ? light : i === w - 1 || j === h - 1 ? dark : base)
}

function wheel(cv, cx, cy) {
  for (let y = -3; y <= 3; y++)
    for (let x = -3; x <= 3; x++) {
      const d = Math.hypot(x, y)
      if (d > 3.4) continue
      cv.put(cx + x, cy + y, d > 2.5 ? OUT : d < 1.2 ? 0x8a929e : d < 2 ? 0x30323a : 0x24262c)
    }
  cv.put(cx - 1, cy - 1, 0xb8c0ca)
}

// bosque: camión militar con caja de lona, cabina a la derecha, estrella blanca
function truck(cv) {
  // lona: techo redondeado
  for (let y = 2; y < 13; y++)
    for (let x = 1; x < 20; x++) {
      if (y === 2 && (x < 3 || x > 17)) continue
      let c = 0x6e7a42
      if (y <= 3) c = 0x8a9656
      if ((x - 1) % 6 === 0) c = 0x56602e // aros de la lona
      if (x >= 18) c = 0x4a5428
      cv.put(x, y, c)
    }
  // cabina
  shadeBox(cv, 20, 5, 9, 8, 0x5e6a36, 0x7e8a4c, 0x3e4822)
  cv.rect(21, 6, 4, 3, 0x9ac8e0) // parabrisas
  cv.put(21, 6, 0xe0f4ff)
  cv.rect(28, 9, 3, 4, 0x4a5428) // trompa
  cv.put(30, 10, 0xffe27a) // faro
  // chasis
  cv.rect(1, 13, 30, 2, 0x2a2c24)
  // estrella blanca en la lona
  const st = ['..W..', 'WWWWW', '.WWW.', '.W.W.']
  st.forEach((r, j) => [...r].forEach((ch, i) => ch === 'W' && cv.put(8 + i, 6 + j, 0xf2ece2)))
  wheel(cv, 6, 16)
  wheel(cv, 13, 16)
  wheel(cv, 25, 16)
}

// jungla: depósito de suministros bajo una carpa de camuflaje, con cajones y un bidón
function depot(cv) {
  // carpa: dos aguas
  for (let y = 1; y < 15; y++) {
    const hw = Math.round(3 + (y - 1) * 1.05)
    for (let x = 16 - hw; x <= 16 + hw; x++) {
      if (x < 1 || x > 30) continue
      const camo = rnd(x >> 1, y >> 1, 501)
      let c = camo < 0.35 ? 0x3a5a2a : camo < 0.7 ? 0x56763a : 0x6e6a3a
      if (x > 16) c = mul(c, 0.82)
      if (x === 16) c = 0x2a3e1e
      cv.put(x, y, c)
    }
  }
  // boca abierta de la carpa con cajones adentro
  for (let y = 7; y < 18; y++) {
    const hw = Math.round((y - 7) * 0.6)
    for (let x = 16 - hw; x <= 16 + hw; x++) cv.put(x, y, 0x1a2414)
  }
  shadeBox(cv, 12, 13, 6, 5, 0x8a6a44, 0xb08a5a, 0x5a4428)
  shadeBox(cv, 17, 14, 5, 4, 0x8a6a44, 0xb08a5a, 0x5a4428)
  // cajones afuera, a la izquierda
  shadeBox(cv, 1, 12, 7, 6, 0x8a6a44, 0xb08a5a, 0x5a4428)
  shadeBox(cv, 2, 8, 5, 4, 0x8a6a44, 0xb08a5a, 0x5a4428)
  cv.rect(3, 14, 3, 2, 0xf2ece2) // etiqueta
  // bidón rojo a la derecha
  shadeBox(cv, 25, 11, 5, 7, 0xd0362c, 0xf07a5e, 0x8e1e1a)
  cv.rect(25, 13, 5, 1, 0x8e1e1a)
  // vientos de la carpa
  cv.line(2, 18, 6, 9, 0x2a2014)
  cv.line(30, 18, 26, 9, 0x2a2014)
  cv.rect(0, 18, 32, 1, 0x3a2a1c)
}

// industrial: tanque de combustible horizontal sobre patas, con franjas de peligro y llama pintada
function fuelTank(cv) {
  for (let y = 2; y < 14; y++)
    for (let x = 1; x < 31; x++) {
      // extremos redondeados
      const ey = (y - 7.5) / 6
      const ex = x < 5 ? (5 - x) / 4 : x > 26 ? (x - 26) / 4 : 0
      if (ex * ex + ey * ey > 1) continue
      let c = 0xd8d4cc
      if (y <= 4) c = 0xf2f0ea
      if (y >= 11) c = 0x9a968e
      if (y === 12 || y === 13) c = 0x7a766e
      cv.put(x, y, c)
    }
  // franjas amarillas y negras
  for (let x = 6; x < 26; x++) {
    const k = ((x >> 1) & 1) === 0
    cv.put(x, 9, k ? 0xe2c13d : 0x2a2622)
    cv.put(x, 10, k ? 0x2a2622 : 0xe2c13d)
  }
  // rombo rojo de inflamable con llama
  const d = ['..R..', '.RYR.', 'RYWYR', '.RYR.', '..R..']
  d.forEach((r, j) => [...r].forEach((ch, i) => ch !== '.' && cv.put(14 + i, 3 + j, ch === 'R' ? 0xd0362c : ch === 'Y' ? 0xffb03a : 0xfff6c8)))
  // escotilla y caño
  cv.rect(7, 1, 4, 2, 0x7a766e)
  cv.rect(26, 0, 2, 3, 0x5a5a5a)
  // patas
  for (const lx of [6, 24]) {
    cv.rect(lx, 14, 2, 5, 0x4a4a4a)
    cv.rect(lx - 1, 18, 4, 1, 0x2a2a2a)
  }
}

// nieve: contenedor rojo con nervaduras, nieve encima y carámbanos
function container(cv) {
  shadeBox(cv, 1, 5, 30, 14, 0xb03a2a, 0xd8584a, 0x6e1e18)
  for (let x = 3; x < 30; x += 3) for (let y = 6; y < 18; y++) cv.put(x, y, 0x8a2a20)
  // puertas a la derecha con trabas
  cv.rect(23, 6, 1, 12, 0x5a1812)
  for (const tx of [25, 28]) for (let y = 7; y < 17; y++) cv.put(tx, y, 0xc8c0b0)
  // número de serie
  cv.rect(5, 8, 7, 2, 0xf2ece2)
  // nieve encima, más gruesa al medio, que se derrama por los costados
  for (let x = 0; x < 32; x++) {
    const h = Math.round(2 + Math.sin(((x + 2) / 34) * Math.PI) * 3 + (rnd(x, 0, 502) - 0.5) * 1.4)
    for (let k = 0; k < h; k++) cv.put(x, 5 - k, k === h - 1 ? 0xffffff : x > 22 ? 0xb4c4e2 : 0xe6eef8)
  }
  // carámbanos
  for (const [x, l] of [[4, 2], [9, 3], [17, 2], [22, 3], [28, 2]]) for (let k = 0; k < l; k++) cv.put(x, 6 + k, k === l - 1 ? 0xb4dcf2 : 0xe4f6ff)
}

const TARGETS = { forest: truck, jungle: depot, industrial: fuelTank, snow: container }

export function targetProp(biome) {
  const cv = new Canvas(TARGET_W, TARGET_H)
  TARGETS[biome](cv)
  // contorno exterior en lo que quedó pintado (sin tapar lo de adentro)
  cv.outline(OUT)
  return cv
}

// ---------- mina 10×6, 2 frames: luz apagada / prendida ----------
export const MINE_CELL = { w: 10, h: 6 }
export const MINE_FRAMES = 2
export function mineStrip() {
  const cv = new Canvas(MINE_CELL.w * MINE_FRAMES, MINE_CELL.h)
  const rows = ['....kk....', '...kLk....', '.k.kkkk.k.', '.kkDWDDkk.', 'kDDDDDDDdk', 'kkkkkkkkkk']
  for (let f = 0; f < MINE_FRAMES; f++) {
    const on = f === 1
    cv.sprite(rows, f * MINE_CELL.w, 0, { k: OUT, D: 0x56603a, d: 0x343a22, W: 0x8a9456, L: on ? 0xff4a3a : 0x6a1e1a })
    if (on) cv.put(f * MINE_CELL.w + 5, 1, 0xffd0c0)
  }
  return cv
}

// ---------- misil teledirigido 10×4 mirando a la derecha ----------
export function missileProp() {
  const cv = new Canvas(10, 4)
  cv.sprite(['.kk.kkkk..', 'YkMkLLLLRk', 'OkMkMMMMrk', '.kk.kkkk..'], 0, 0, {
    k: OUT,
    L: 0xd0d6de,
    M: 0x8a929e,
    R: 0xe0463a,
    r: 0x8e1e1a,
    Y: 0xffe27a,
    O: 0xf77a28,
  })
  return cv
}
