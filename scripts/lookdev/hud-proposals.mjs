// Pulido v2: tres propuestas de HUD para que ángulo, potencia, viento y combustible se lean de un vistazo.
// Pinta la misma escena (mapa Grande, turno del jugador, 4 tanques) con cada propuesta y la versión
// Chico (sin minimapa ni flechas). No es código del juego: son maquetas para elegir una.
// Usa la misma fuente, íconos, pips y retratos que genera paint-assets (se arman acá desde lookdev).
// Uso: node scripts/lookdev/hud-proposals.mjs  → preview/hud-{a,b,c}.png, preview/hud-{a,b,c}-chico.png,
//      preview/hud-comparativa.png
//
// Táctil: en la escala típica ×2, 44 px CSS son 22 px lógicos. Todo lo que se toca (armas, ítems,
// mover ◀ ▶, minimapa) mide al menos 22×22 lógicos en las tres propuestas.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Canvas, OUT, mix, mul, TANK_W, TANK_H, PIVOT, CREW_BANDANA, CREW_SARGE, BANDANA_PAL, SARGE_PAL } from './pixel.mjs'
import * as UI from './ui.mjs'
import { itemIconStrip } from './f10.mjs'
import { portrait } from './characters.mjs'
import * as V2 from './v2-bigmap.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })

const VW = 800
const VH = 450

// ---------- paleta del HUD (la de src/ui/hud.ts) ----------

const DARK = 0x0e0a09
const BRONZE = 0xc4a574
const BRONZE_D = 0x7a6244 // remaches y biseles
const GOLD = 0xffe27a
const GREY = 0x9a8e80
const SLOT_BG = 0x2a2220
const INK = 0x1c1614
const WHITE = 0xffffff
const POW_LO = 0xe05a1c
const POW_MID = 0xffa23a
const FUEL = 0x3a9a3a
const FUEL_HI = 0x9ae06a
const FUEL_LOW = 0xd0362c
const SHIELD = 0x2a5aa0
const SHIELD_HI = 0x7ab8ff
const WIND_SOFT = 0xbfe8ff

// ---------- estado de la maqueta: turno de P1 (humano) ----------

const STATE = {
  angle: 34,
  power: 64,
  wind: 6, // −10..10; positivo = hacia la derecha
  fuel: 0.55, // 0..1 del combustible del turno
  weapon: 'heavy',
  ammoAll: { normal: 99, heavy: 2, dirt: 3, cluster: 0, napalm: 1, digger: 2, roller: 0, nuke: 1 },
  items: { shield: 1, parachute: 1, fuel: 2, repair: 0, tracer: 1 },
  round: '2/5',
  money: 1250,
}
const WEAPON_SLOTS = ['normal', 'heavy', 'dirt', 'cluster', 'napalm', 'digger', 'roller', 'nuke']
const WEAPON_NAMES = { normal: 'Normal', heavy: 'Pesada', dirt: 'Tierra', cluster: 'Racimo', napalm: 'Napalm', digger: 'Excavadora', roller: 'Rodadora', nuke: 'Nuke' }
const ITEM_ORDER = ['shield', 'parachute', 'fuel', 'repair', 'tracer']
const ITEM_KEYS = { shield: 'Q', fuel: 'F', repair: 'R', tracer: 'T' }

// los 4 tanques; hp 0..100, shield en HP de escudo (SHIELD_HP = 30)
const PLAYERS = [
  { n: 1, name: 'BANDANA', crew: CREW_BANDANA, pal: BANDANA_PAL, portrait: 'bandana', hull: 0, angle: STATE.angle, hp: 70, shield: 18, you: true, active: true },
  { n: 2, name: 'SARGE', crew: CREW_SARGE, pal: SARGE_PAL, portrait: 'sarge', hull: 1, angle: 140, hp: 100, shield: 0 },
  { n: 3, name: 'ROOKIE', crew: CREW_BANDANA, pal: V2.ROOKIE_PAL, portrait: 'rookie', hull: 2, angle: 150, hp: 45, shield: 0 },
  { n: 4, name: 'DESERT', crew: CREW_SARGE, pal: V2.DESERT_PAL, portrait: 'desert', hull: 3, angle: 130, hp: 20, shield: 0 },
]
const color = (p) => V2.STRIPES8[p.n - 1][1]

// Escenas: Grande (con minimapa, dos rivales fuera de cámara) y Chico (todo a la vista, sin minimapa).
// Chico se arma con el mismo recorte del mundo para que la comparación sea justa.
const CAM_X = 1060
const SCENES = {
  grande: { minimap: true, x: { 1: 1205, 2: 1500, 3: 1955, 4: 830 } },
  chico: { minimap: false, x: { 1: 1205, 2: 1500, 3: 1580, 4: 1330 } },
}

// ---------- fuente: la tira de paint-assets, recortada igual que fontFromImage ----------

const FONT_H = 5
const glyphs = new Map()
{
  const strip = UI.fontStrip()
  ;[...UI.FONT_CHARS].forEach((ch, i) => {
    let x0 = UI.GLYPH.w, x1 = -1
    const lit = (x, y) => strip.alpha(i * UI.GLYPH.w + x, y) && (strip.get(i * UI.GLYPH.w + x, y) & 0xff) > 150
    for (let y = 0; y < FONT_H; y++) for (let x = 0; x < UI.GLYPH.w; x++) if (lit(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x) }
    if (x1 < 0) { glyphs.set(ch, { w: 3, rows: ['...', '...', '...', '...', '...'] }); return }
    const rows = []
    for (let y = 0; y < FONT_H; y++) { let r = ''; for (let x = x0; x <= x1; x++) r += lit(x, y) ? '#' : '.'; rows.push(r) }
    glyphs.set(ch, { w: x1 - x0 + 1, rows })
  })
  // los que la tira no trae salen del respaldo de src/ui/pixelfont.ts (como en el juego)
  const FALLBACK = {
    '°': ['###', '#.#', '###', '...', '...'],
    '<': ['..#', '.#.', '#..', '.#.', '..#'],
    '>': ['#..', '.#.', '..#', '.#.', '#..'],
    x: ['...', '#.#', '.#.', '#.#', '...'],
    $: ['.####', '#.#..', '.###.', '..#.#', '####.'],
  }
  for (const [ch, rows] of Object.entries(FALLBACK)) glyphs.set(ch, { w: rows[0].length, rows })
}
const clean = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const glyph = (ch) => glyphs.get(ch) ?? glyphs.get(ch.toUpperCase()) ?? glyphs.get('?')

function measure(s, sc = 1) {
  let w = 0
  for (const ch of clean(s)) w += glyph(ch).w + 1
  return Math.max(0, w - 1) * sc
}

// Texto chico (escala 1) con la sombra de 1 px del juego. Devuelve el ancho.
function text(cv, s, x, y, c, sh = OUT) {
  let cx = x
  for (const ch of clean(s)) {
    const g = glyph(ch)
    for (const [dx, dy, col] of sh == null ? [[0, 0, c]] : [[1, 1, sh], [0, 0, c]]) {
      g.rows.forEach((row, gy) => { for (let gx = 0; gx < g.w; gx++) if (row[gx] === '#') cv.put(cx + gx + dx, y + gy + dy, col) })
    }
    cx += g.w + 1
  }
  return cx - x - 1
}

// Número grande: la misma fuente ampliada ×sc, contorno OUT de 1 px, sombra abajo y la mitad de abajo
// un tono más oscura (el "metal" de las cifras de Broforce). Devuelve el ancho.
function big(cv, s, x, y, c, sc = 2) {
  const cells = []
  let cx = 0
  for (const ch of clean(s)) {
    const g = glyph(ch)
    g.rows.forEach((row, gy) => { for (let gx = 0; gx < g.w; gx++) if (row[gx] === '#') cells.push([cx + gx, gy]) })
    cx += g.w + 1
  }
  for (const [gx, gy] of cells) cv.rect(x + gx * sc - 1, y + gy * sc - 1, sc + 2, sc + 3, OUT)
  for (const [gx, gy] of cells) cv.rect(x + gx * sc, y + gy * sc, sc, sc, gy >= 3 ? mul(c, 0.82) : c)
  return Math.max(0, cx - 1) * sc
}

const center = (s, x, w, sc = 1) => x + Math.floor((w - measure(s, sc)) / 2)

// ---------- piezas de arte reutilizadas ----------

const WEAPON_STRIP = UI.weaponIconStrip()
const ITEM_STRIP = itemIconStrip()
const PIP_STRIP = UI.pipStrip()
const SOCK = UI.windsockStrip()
const PORTRAITS = Object.fromEntries(['bandana', 'sarge', 'rookie', 'desert'].map((id) => [id, portrait(id)]))

// Copia la celda i de una tira (cw×ch) escalada ×sc; off = deshabilitada (gris y apagada).
function cell(cv, strip, cw, ch, i, x, y, { sc = 1, off = false, flip = false } = {}) {
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const sx = i * cw + (flip ? cw - 1 - xx : xx)
      const a = strip.alpha(sx, yy)
      if (!a) continue
      let c = strip.get(sx, yy)
      if (off) { const l = (((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11) | 0; c = mix((l << 16) | (l << 8) | l, DARK, 0.6) }
      cv.rect(x + xx * sc, y + yy * sc, sc, sc, c, a / 255)
    }
  }
}
const weaponIcon = (cv, id, x, y, o) => cell(cv, WEAPON_STRIP, 12, 12, WEAPON_SLOTS.indexOf(id), x, y, o)
const itemIcon = (cv, id, x, y, o) => cell(cv, ITEM_STRIP, 12, 12, ITEM_ORDER.indexOf(id), x, y, o)
const sockFrame = (wind) => Math.round(((wind + 10) / 20) * (UI.SOCK_FRAMES - 1))

// Marco del HUD: contorno, borde de color, fondo oscuro y la línea de bisel de arriba.
function panel(cv, x, y, w, h, edge = BRONZE, fill = DARK) {
  cv.rect(x, y, w, h, OUT)
  cv.rect(x + 1, y + 1, w - 2, h - 2, edge)
  cv.rect(x + 2, y + 2, w - 4, h - 4, fill)
  cv.rect(x + 2, y + 2, w - 4, 1, mix(fill, WHITE, 0.08))
}
function rivets(cv, x, y, w, h) {
  for (const [rx, ry] of [[x + 3, y + 3], [x + w - 5, y + 3], [x + 3, y + h - 5], [x + w - 5, y + h - 5]]) {
    cv.rect(rx, ry, 2, 2, BRONZE_D)
    cv.put(rx, ry, mix(BRONZE, WHITE, 0.4))
  }
}
// separador vertical con remache arriba y abajo (tablero C)
function divider(cv, x, y, h) {
  cv.rect(x, y, 2, h, OUT)
  cv.rect(x + 2, y, 1, h, BRONZE_D)
}

function pips(cv, x, y, hp, sc = 1) {
  const on = Math.ceil((Math.max(0, hp) / 100) * 6)
  for (let i = 0; i < 6; i++) cell(cv, PIP_STRIP, 4, 5, i < on ? 0 : 1, x + i * (4 * sc + 2 * sc), y, { sc })
  return 6 * 6 * sc - 2 * sc
}

// Barra horizontal por segmentos (potencia, combustible, escudo). colors: [abajo, medio, brillo].
function segBar(cv, x, y, w, h, v, [c0, c1, c2], { segs = 0, back = SLOT_BG } = {}) {
  cv.rect(x, y, w, h, OUT)
  cv.rect(x + 1, y + 1, w - 2, h - 2, back)
  const fill = Math.round((w - 2) * Math.max(0, Math.min(1, v)))
  if (fill > 0) {
    cv.rect(x + 1, y + 1, fill, h - 2, c0)
    cv.rect(x + 1, y + 1, fill, Math.max(1, Math.floor((h - 2) / 2)), c1)
    cv.rect(x + 1, y + 1, fill, 1, c2)
  }
  if (segs) for (let k = 1; k < segs; k++) cv.rect(x + 1 + Math.round(((w - 2) * k) / segs), y + 1, 1, h - 2, OUT)
}

// Barra vertical de potencia: se llena de abajo arriba del naranja al dorado, con rayas cada 25.
function powerColumn(cv, x, y, w, h, v) {
  cv.rect(x, y, w, h, OUT)
  cv.rect(x + 1, y + 1, w - 2, h - 2, SLOT_BG)
  const ih = h - 2
  const fill = Math.round((ih * v) / 100)
  for (let k = 0; k < fill; k++) {
    const t = k / ih
    const c = t < 0.5 ? mix(POW_LO, POW_MID, t * 2) : mix(POW_MID, GOLD, (t - 0.5) * 2)
    const yy = y + h - 2 - k
    cv.rect(x + 1, yy, w - 2, 1, (k + 1) % 4 === 0 ? mul(c, 0.7) : c)
    cv.put(x + 1, yy, mix(c, WHITE, 0.4))
  }
  if (fill > 0) cv.rect(x + 1, y + h - 1 - fill, w - 2, 1, WHITE)
  for (const q of [25, 50, 75]) {
    const yy = y + h - 1 - Math.round((ih * q) / 100)
    cv.rect(x - 2, yy, 2, 1, GREY)
  }
}

// Línea gruesa con contorno (agujas del ángulo).
function thick(cv, x0, y0, x1, y1, c, r = 1) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2)
  for (const [col, rr] of [[OUT, r + 1], [c, r]]) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n
      cv.rect(Math.round(x - rr + 0.5), Math.round(y - rr + 0.5), rr * 2 - 1 + (rr > 1 ? 0 : 0), rr * 2 - 1, col)
    }
  }
}

// Dial de ángulo: medio círculo 0..180 con marcas cada 15 y 45, la cuña recorrida y la aguja.
function dial(cv, cx, cy, R, angle) {
  for (let y = cy - R - 2; y <= cy + 1; y++) {
    for (let x = cx - R - 2; x <= cx + R + 2; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d > R + 1.5) continue
      const a = (Math.atan2(cy - y, x - cx) * 180) / Math.PI
      let c = d > R + 0.5 ? OUT : d > R - 1 ? BRONZE_D : INK
      // cuña de 0 al ángulo actual, tenue
      if (d <= R - 1 && a >= 0 && a <= angle && d > 3) c = mix(INK, GOLD, 0.16)
      cv.put(x, y, c)
    }
  }
  for (let a = 0; a <= 180; a += 15) {
    const r = (a * Math.PI) / 180
    const long = a % 45 === 0
    for (let k = long ? 5 : 3; k >= 1; k--) cv.put(Math.round(cx + Math.cos(r) * (R - k)), Math.round(cy - Math.sin(r) * (R - k)), long ? BRONZE : GREY)
  }
  const r = (angle * Math.PI) / 180
  thick(cv, cx, cy, cx + Math.cos(r) * (R - 2), cy - Math.sin(r) * (R - 2), GOLD, 1)
  cv.rect(cx - 2, cy - 2, 5, 3, OUT)
  cv.rect(cx - 1, cy - 1, 3, 2, GREY)
}

// Chevron de viento 8×9; lit = encendido (la fuerza se lee por cuántos de 3 se prenden).
const CHEV = ['kkk.....', 'kwwk....', '.kwwk...', '..kwwk..', '...kwwk.', '..kwwk..', '.kwwk...', 'kwwk....', 'kkk.....']
const windColor = (w) => (Math.abs(w) > 6.6 ? 0xff6a3a : Math.abs(w) > 3.3 ? GOLD : WIND_SOFT)
function windChevrons(cv, x, y, wind, sc = 2) {
  const n = wind === 0 ? 0 : Math.min(3, Math.ceil(Math.abs(wind) / 3.4))
  const dir = wind < 0 ? -1 : 1
  const step = 6 * sc
  for (let k = 0; k < 3; k++) {
    // los encendidos van en la punta de la dirección del viento
    const lit = dir > 0 ? k >= 3 - n : k < n
    const c = lit ? windColor(wind) : 0x3a3028
    const rows = dir > 0 ? CHEV : CHEV.map((r) => [...r].reverse().join(''))
    cv.spriteScaled(rows, x + k * step, y, { k: lit ? OUT : 0x241c18, w: c }, sc)
  }
  return 2 * step + 8 * sc
}

// Botón táctil cuadrado de 22 (44 px CSS a ×2): marco, contenido y tecla de escritorio en la esquina.
function button(cv, x, y, s = 22, { on = true, sel = false, key = '' } = {}) {
  cv.rect(x, y, s, s, OUT)
  cv.rect(x + 1, y + 1, s - 2, s - 2, sel ? GOLD : on ? 0x4a3c30 : 0x2a2220)
  cv.rect(x + 2, y + 2, s - 4, s - 4, sel ? 0x3a2a18 : on ? SLOT_BG : 0x14100e)
  cv.rect(x + 2, y + s - 3, s - 4, 1, sel ? mul(GOLD, 0.6) : 0x1a1412)
  if (key) {
    const kw = measure(key) + 3
    cv.rect(x + s - kw - 1, y + 1, kw, FONT_H + 2, on ? (sel ? GOLD : BRONZE_D) : 0x3a3230)
    text(cv, key, x + s - kw + 1, y + 2, DARK, null)
  }
}
// triángulo ◀ ▶ dentro de un botón de mover
function moveArrow(cv, x, y, dir, c = WHITE) {
  for (let k = 0; k < 6; k++) {
    const xx = dir > 0 ? x + k : x + 5 - k
    cv.rect(xx, y + k, 1, 11 - 2 * k, c)
  }
}
function moveButton(cv, x, y, dir, key, on = true) {
  button(cv, x, y, 22, { on, key })
  moveArrow(cv, x + 7 + (dir > 0 ? 1 : 0), y + 6, dir, on ? WHITE : GREY)
}

// Ranura de arma de 22×22: ícono, tecla 1-8 y munición.
function weaponSlot(cv, x, y, id, i) {
  const ammo = STATE.ammoAll[id] ?? 0
  const sel = id === STATE.weapon
  button(cv, x, y, 22, { on: ammo > 0, sel })
  // tecla arriba a la izquierda (chica y apagada), ícono corrido a la derecha, munición abajo
  text(cv, `${i + 1}`, x + 3, y + 3, sel ? GOLD : ammo > 0 ? GREY : 0x4a4440)
  weaponIcon(cv, id, x + 7, y + 3, { off: ammo <= 0 })
  if (ammo > 0 && ammo < 50) { const t = `${ammo}`; text(cv, t, x + 19 - measure(t), y + 15, WHITE) }
}
function weaponRow(cv, x, y, gap = 2) {
  WEAPON_SLOTS.forEach((id, i) => weaponSlot(cv, x + i * (22 + gap), y, id, i))
  return 8 * (22 + gap) - gap
}

// Ítem de 22×22 con cantidad y tecla.
function itemButton(cv, x, y, id) {
  const n = STATE.items[id] ?? 0
  const key = ITEM_KEYS[id] ?? ''
  button(cv, x, y, 22, { on: n > 0, key })
  itemIcon(cv, id, x + 3, y + 5, { off: n <= 0 })
  text(cv, `${n}`, x + 19 - measure(`${n}`), y + 15, n > 0 ? WHITE : 0x6a625a)
}

// Arriba a la izquierda: ronda y plata, y los ítems en fila (todos de 22). Devuelve la y de abajo.
function roundAndItems(cv, x = 3, y = 3) {
  const r = `RONDA ${STATE.round}`, m = `$${STATE.money}`
  const w = Math.max(measure(r), measure(m)) + 12
  panel(cv, x, y, w, 24)
  text(cv, r, x + 6, y + 5, GREY)
  text(cv, m, x + 6, y + 13, GOLD)
  let ix = x + w + 3
  for (const id of ITEM_ORDER) { itemButton(cv, ix, y + 1, id); ix += 24 }
  return y + 24
}

// Escudo: ícono, barra azul y número (SHIELD_HP = 30).
function shieldBar(cv, x, y, w, sh) {
  itemIcon(cv, 'shield', x, y - 3, { off: sh <= 0 })
  segBar(cv, x + 14, y, w - 14 - 14, 6, sh / 30, [SHIELD, SHIELD_HI, 0xd8ecff])
  text(cv, `${sh}`, x + w - measure(`${sh}`) - 1, y, sh > 0 ? SHIELD_HI : GREY)
}

// Retrato con marco del color del jugador.
function portraitBox(cv, p, x, y, s = 36, flip = false) {
  cv.rect(x, y, s, s, OUT)
  cv.rect(x + 1, y + 1, s - 2, s - 2, color(p))
  cv.rect(x + 2, y + 2, s - 4, s - 4, INK)
  const img = PORTRAITS[p.portrait]
  if (s >= 36) cv.blit(img, x + 2 + Math.floor((s - 36) / 2), y + 2 + Math.floor((s - 36) / 2), flip)
  else {
    // retrato a la mitad para las placas chicas (cada 2×2 → 1)
    for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 16; xx++) {
      const sx = flip ? 31 - xx * 2 : xx * 2
      if (img.alpha(sx, yy * 2)) cv.put(x + 2 + xx, y + 2 + yy, img.get(sx, yy * 2))
    }
  }
}

// Pestaña "VOS" sobre el retrato del humano.
function vosTab(cv, x, y) {
  panel(cv, x, y - 10, 24, 11, GOLD)
  text(cv, 'VOS', x + 4, y - 7, GOLD)
}

// Placa compacta de rival (como hoy): nombre, pips y retrato de 16. right = borde derecho.
function compactPlate(cv, p, right, y) {
  const bw = Math.max(46, measure(p.name) + 10)
  const bx = right - 19 - bw
  panel(cv, bx, y, bw, 20, color(p))
  text(cv, p.name, bx + 5, y + 4, WHITE)
  pips(cv, bx + 5, y + 11, p.hp)
  portraitBox(cv, p, bx + bw - 1, y, 20, true)
  const t = `P${p.n}`
  const tw = measure(t)
  cv.rect(right - tw - 3, y - 8, tw + 4, 8, OUT)
  text(cv, t, right - tw - 1, y - 7, color(p))
  return bx
}

// ---------- escena del mundo ----------

V2.paintProps()
V2.paintLiquids()
const FG_BASE = new Uint8ClampedArray(V2.fg.px)

// Arma la pantalla 800×450 de una escena: parallax, terreno, tanques, globos y guía de apuntado.
function worldScreen(scene) {
  V2.fg.px.set(FG_BASE)
  const tanks = PLAYERS.map((p) => ({ ...p, x: scene.x[p.n] }))
  for (const t of tanks) t.ground = V2.groundUnder(t.x)
  for (const t of tanks) V2.drawTank(t)
  const cv = new Canvas(VW, VH)
  const bgX = Math.round(CAM_X * 0.45)
  for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) cv.put(x, y, V2.bg.get(bgX + x, y))
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      const i = (y * V2.W + CAM_X + x) * 4
      const a = V2.fg.px[i + 3]
      if (a) cv.put(x, y, (V2.fg.px[i] << 16) | (V2.fg.px[i + 1] << 8) | V2.fg.px[i + 2], a / 255)
    }
  }
  V2.light(cv, 1683 - CAM_X, 386, 110, 0xff6a20, 0.32)
  for (const t of tanks) {
    t.sx = t.x - CAM_X
    t.visible = t.sx > 0 && t.sx < VW
    if (t.visible) V2.tag(cv, `P${t.n}`, t.sx, t.ground - 32, color(t))
  }
  // pivote del cañón del tanque del turno (en pantalla)
  const me = tanks[0]
  const x0 = Math.round(me.sx - TANK_W / 2)
  me.pivot = { x: x0 + PIVOT.x, y: me.ground - TANK_H + PIVOT.y }
  // guía de apuntado (Pulido v2): los primeros puntos de la trayectoria, sin trazador
  const rad = (STATE.angle * Math.PI) / 180
  const v = STATE.power * 5.4
  for (let k = 1; k <= 11; k++) {
    const t = k * 0.055
    const px = me.pivot.x + Math.cos(rad) * (13 + v * t) + 0.5 * STATE.wind * 4 * t * t
    const py = me.pivot.y - Math.sin(rad) * (13 + v * t) + 0.5 * 220 * t * t
    const a = 1 - k / 13
    cv.rect(Math.round(px) - 1, Math.round(py) - 1, 3, 3, OUT, a)
    cv.put(Math.round(px), Math.round(py), WHITE, a)
  }
  return { cv, tanks, me }
}

// ---------- minimapa y flechas (lo mismo en las tres; v2 ya lo definió) ----------

const MM_W = V2.W / 10
const MM_H = V2.H / 10
const MM_CELLS = (() => {
  const c = new Canvas(MM_W, MM_H)
  const AIR = V2.AIR
  for (let my = 0; my < MM_H; my++) {
    for (let mx = 0; mx < MM_W; mx++) {
      const count = {}
      for (let y = my * 10; y < my * 10 + 10; y++) for (let x = mx * 10; x < mx * 10 + 10; x++) { const m = V2.F(x, y); count[m] = (count[m] ?? 0) + 1 }
      let best = AIR, bn = 0
      for (const [m, n] of Object.entries(count)) if (+m !== AIR && n > bn) { best = +m; bn = n }
      let col
      if (bn < 35) col = mix(0x1e2a30, 0x2e3e44, my / MM_H)
      else col = { [V2.DIRT]: 0x6a4e36, [V2.STONE]: 0x8a8169, [V2.BRICK]: 0x9a5038, [V2.BEDROCK]: 0x3a3430, [V2.WATER]: 0x4a9ac8, [V2.LAVA]: 0xff7a2a }[best] ?? 0x8a6a40
      if (bn >= 35 && my > 0) {
        let above = 0
        for (let y = my * 10 - 10; y < my * 10; y++) for (let x = mx * 10; x < mx * 10 + 10; x++) if (V2.F(x, y) !== AIR) above++
        if (above < 35 && !V2.LIQUID.has(best)) col = mix(col, 0xd8c8a0, 0.45)
      }
      c.put(mx, my, col)
    }
  }
  return c
})()

function minimap(cv, tanks, ox = Math.round((VW - MM_W) / 2), oy = 6) {
  cv.rect(ox - 3, oy - 3, MM_W + 6, MM_H + 6, OUT)
  cv.rect(ox - 2, oy - 2, MM_W + 4, MM_H + 4, 0x6a5a48)
  cv.rect(ox - 1, oy - 1, MM_W + 2, MM_H + 2, OUT)
  cv.blit(MM_CELLS, ox, oy)
  const vx = ox + Math.round(CAM_X / 10), vw = VW / 10
  for (let x = vx; x < vx + vw; x++) { cv.put(x, oy - 1, WHITE); cv.put(x, oy + MM_H, WHITE) }
  for (let y = oy - 1; y <= oy + MM_H; y++) { cv.put(vx, y, WHITE); cv.put(vx + vw - 1, y, WHITE) }
  for (let y = oy; y < oy + MM_H; y++) for (let x = vx + 1; x < vx + vw - 1; x++) cv.put(x, y, WHITE, 0.12)
  for (const t of tanks) {
    const tx = ox + Math.round(t.x / 10), ty = oy + Math.round(t.ground / 10) - 2
    cv.rect(tx - 2, ty - 1, 5, 4, t.active ? WHITE : OUT)
    cv.rect(tx - 1, ty, 3, 2, color(t))
  }
  return { x: ox, y: oy, w: MM_W, h: MM_H, bottom: oy + MM_H + 3, left: ox - 3, right: ox + MM_W + 3 }
}

function edgeArrows(cv, tanks, top = 70, bottom = VH - 70) {
  for (const t of tanks) {
    if (t.visible) continue
    const side = t.sx < 0 ? -1 : 1
    const y = Math.max(top, Math.min(bottom, t.ground - 16))
    const x = side < 0 ? 3 : VW - 4
    for (let k = 0; k < 7; k++) for (let j = -k; j <= k; j++) cv.put(x - side * k, y + j, k === 6 || Math.abs(j) === k ? OUT : color(t))
    const label = `P${t.n}`
    text(cv, label, side < 0 ? x + 9 : x - 9 - measure(label), y - 2, WHITE)
  }
}

// cartel de estado centrado
function status(cv, s, y) {
  const w = measure(s)
  const x = Math.round((VW - w) / 2)
  cv.rect(x - 5, y, w + 10, FONT_H + 7, OUT)
  cv.rect(x - 4, y + 1, w + 8, FONT_H + 5, DARK)
  text(cv, s, x, y + 3, GOLD)
  return y + FONT_H + 7
}

// =====================================================================================
// A · CONSOLA DE PUNTERÍA abajo al centro
// Un solo bloque grande con los cinco datos del tiro en orden de uso: ÁNG (dial + número grande),
// POT (columna vertical + número), VIENTO (manga + chevrons + número), ARMA (ícono ×2 con ◀ ▶) y
// MOVER (◀ combustible ▶). Las placas quedan a los costados como hoy.
// =====================================================================================

function proposalA(scene) {
  const { cv, tanks } = worldScreen(scene)
  const me = tanks[0]
  roundAndItems(cv)
  let below = 6
  if (scene.minimap) { below = minimap(cv, tanks).bottom + 4; edgeArrows(cv, tanks, 40) }
  status(cv, 'TU TURNO', below)

  // placa del jugador: retrato, nombre, pips ×2 y escudo
  const py = VH - 2 - 46
  portraitBox(cv, me, 2, py + 10)
  vosTab(cv, 2, py + 10)
  panel(cv, 37, py, 112, 46, color(me))
  text(cv, me.name, 43, py + 5, WHITE)
  text(cv, 'P1', 149 - 5 - measure('P1'), py + 5, color(me))
  pips(cv, 43, py + 15, me.hp, 2)
  shieldBar(cv, 43, py + 33, 100, me.shield)

  // consola
  const cw = 482, ch = 74
  const cx0 = Math.round((VW - cw) / 2) - 4
  const cy0 = VH - 2 - ch
  panel(cv, cx0, cy0, cw, ch)
  rivets(cv, cx0, cy0, cw, ch)
  const label = (s, x, w) => text(cv, s, center(s, x, w), cy0 + 5, GREY)
  let x = cx0 + 4
  const sec = (w) => { const sx = x; x += w; if (x < cx0 + cw - 8) cv.rect(x, cy0 + 6, 1, ch - 12, 0x3a3028); return sx }

  // ÁNG: dial de medio círculo y número grande debajo
  let sx = sec(90)
  label('ANGULO', sx, 90)
  dial(cv, sx + 45, cy0 + 45, 30, STATE.angle)
  { const s = `${STATE.angle}°`; big(cv, s, center(s, sx, 90, 2), cy0 + 52, WHITE, 2) }

  // POT: columna vertical llena y número grande al lado
  sx = sec(74)
  label('POTENCIA', sx, 74)
  powerColumn(cv, sx + 12, cy0 + 14, 14, 54, STATE.power)
  big(cv, `${STATE.power}`, sx + 33, cy0 + 34, GOLD, 3)

  // VIENTO: la manga del juego (animada en el juego: 7 cuadros según la fuerza), chevrons y número
  sx = sec(96)
  label('VIENTO', sx, 96)
  cell(cv, SOCK, UI.SOCK_CELL.w, UI.SOCK_CELL.h, sockFrame(STATE.wind), sx + 2, cy0 + 11)
  big(cv, `${Math.abs(STATE.wind)}`, sx + 52, cy0 + 20, windColor(STATE.wind), 3)
  windChevrons(cv, sx + 18, cy0 + 47, STATE.wind, 2)

  // ARMA: ícono ×2, nombre y munición; ◀ ▶ (rueda de armas) para el táctil, teclas 1-8 en escritorio
  sx = sec(122)
  label('ARMA', sx, 122)
  moveButton(cv, sx + 4, cy0 + 22, -1, '')
  moveButton(cv, sx + 96, cy0 + 22, 1, '')
  cv.rect(sx + 34, cy0 + 15, 52, 34, OUT)
  cv.rect(sx + 35, cy0 + 16, 50, 32, GOLD)
  cv.rect(sx + 36, cy0 + 17, 48, 30, 0x3a2a18)
  weaponIcon(cv, STATE.weapon, sx + 48, cy0 + 20, { sc: 2 })
  const nm = WEAPON_NAMES[STATE.weapon].toUpperCase()
  text(cv, nm, center(nm, sx, 122), cy0 + 54, WHITE)
  const am = `x${STATE.ammoAll[STATE.weapon]}`
  text(cv, am, center(am, sx, 122), cy0 + 63, GOLD)
  // puntitos de las 8 armas: cuál está elegida y cuáles tienen munición
  WEAPON_SLOTS.forEach((id, i) => {
    const on = STATE.ammoAll[id] > 0
    cv.rect(sx + 36 + i * 6, cy0 + 50, 4, 2, id === STATE.weapon ? GOLD : on ? GREY : 0x3a3230)
  })

  // MOVER: ◀ combustible ▶ (los botones gastan lo que muestra la barra)
  sx = sec(94)
  label('COMBUST.', sx, 94)
  moveButton(cv, sx + 4, cy0 + 16, -1, 'A')
  moveButton(cv, sx + 68, cy0 + 16, 1, 'D')
  itemIcon(cv, 'fuel', sx + 35, cy0 + 21)
  const fuelCol = STATE.fuel < 0.25 ? [FUEL_LOW, 0xff7a5a, 0xffb0a0] : [FUEL, FUEL_HI, 0xd8ffb0]
  segBar(cv, sx + 4, cy0 + 44, 86, 10, STATE.fuel, fuelCol, { segs: 6 })
  { const s = `${Math.round(STATE.fuel * 100)}%`; text(cv, s, center(s, sx, 94), cy0 + 59, FUEL_HI) }

  // rivales a la derecha: el que tiene la placa grande y los demás apilados encima
  const others = tanks.slice(1)
  let ry = VH - 2 - 20
  for (const p of others) { compactPlate(cv, p, VW - 2, ry); ry -= 30 }
  return cv
}

// =====================================================================================
// B · EN EL TANQUE
// El ángulo y la potencia se dibujan en el mundo, alrededor del tanque del turno: arco graduado con
// la aguja y el número en la punta, y un medidor vertical al costado. El combustible es una barra bajo
// las orugas con ◀ ▶. El viento va grande arriba, pegado al minimapa. Abajo, la barra de armas entera.
// =====================================================================================

function proposalB(scene) {
  const { cv, tanks, me } = worldScreen(scene)
  const { x: px, y: py } = me.pivot

  // arco de 0 a 180 alrededor del cañón: puntos cada 5°, marcas cada 45° y la aguja dorada
  const R = 38
  for (let a = 0; a <= 180; a += 5) {
    const r = (a * Math.PI) / 180
    const x = Math.round(px + Math.cos(r) * R), y = Math.round(py - Math.sin(r) * R)
    if (a % 45 === 0) { cv.rect(x - 1, y - 1, 3, 3, OUT); cv.put(x, y, a <= STATE.angle ? GOLD : WHITE) }
    else if (Math.abs(a - STATE.angle) > 3) {
      // recorrido (0 → ángulo) en dorado; el resto, puntos claros con sombra para que se vean sobre el cielo
      cv.put(x + 1, y + 1, OUT, 0.8)
      cv.put(x, y, a <= STATE.angle ? GOLD : WHITE, a <= STATE.angle ? 1 : 0.75)
    }
  }
  const rad = (STATE.angle * Math.PI) / 180
  thick(cv, px + Math.cos(rad) * 16, py - Math.sin(rad) * 16, px + Math.cos(rad) * (R + 3), py - Math.sin(rad) * (R + 3), GOLD, 1)
  // número del ángulo en una pastilla en la punta de la aguja
  {
    const s = `${STATE.angle}°`
    const w = measure(s, 2) + 8
    const bx = Math.round(px + Math.cos(rad) * (R + 10)) - 2
    const by = Math.round(py - Math.sin(rad) * (R + 10)) - 12
    panel(cv, bx, by, w, 16, GOLD)
    big(cv, s, bx + 4, by + 3, WHITE, 2)
  }
  // potencia: medidor vertical al costado contrario al tiro, con el número arriba
  {
    const side = STATE.angle <= 90 ? -1 : 1
    const mx = Math.round(me.sx + side * 24) - 4
    const top = me.ground - 52
    powerColumn(cv, mx, top + 10, 9, 40, STATE.power)
    const s = `${STATE.power}`
    const w = measure(s) + 6
    panel(cv, mx + 4 - Math.round(w / 2) - 1, top - 2, w + 2, 11, BRONZE)
    text(cv, s, mx + 4 - Math.round(w / 2) + 3, top + 1, GOLD)
  }
  // combustible: barra bajo las orugas, con ◀ ▶ de mover a los lados
  {
    const by = me.ground + 3
    const bx = Math.round(me.sx - 17)
    segBar(cv, bx, by, 34, 6, STATE.fuel, [FUEL, FUEL_HI, 0xd8ffb0], { segs: 6 })
    moveArrow(cv, bx - 7, by - 2, -1, WHITE)
    moveArrow(cv, bx + 35, by - 2, 1, WHITE)
  }

  roundAndItems(cv)
  // viento grande: al lado del minimapa (Grande) o arriba al centro (Chico)
  let below = 6
  let wx
  if (scene.minimap) { const mm = minimap(cv, tanks); below = mm.bottom + 4; wx = mm.right + 4; edgeArrows(cv, tanks, 40) }
  else wx = Math.round((VW - 142) / 2)
  {
    const ww = 142, wh = 46, wy = 3
    panel(cv, wx, wy, ww, wh)
    rivets(cv, wx, wy, ww, wh)
    text(cv, 'VIENTO', wx + 40, wy + 5, GREY)
    cell(cv, SOCK, UI.SOCK_CELL.w, UI.SOCK_CELL.h, sockFrame(STATE.wind), wx + 3, wy + 13)
    windChevrons(cv, wx + 40, wy + 16, STATE.wind, 2)
    big(cv, `${Math.abs(STATE.wind)}`, wx + 108, wy + 14, windColor(STATE.wind), 3)
    if (!scene.minimap) below = wy + wh + 3
  }
  status(cv, 'TU TURNO', below)

  // placa del jugador con la lectura de respaldo del tiro (si la cámara se fue del tanque)
  const py0 = VH - 2 - 46
  portraitBox(cv, me, 2, py0 + 10)
  vosTab(cv, 2, py0 + 10)
  panel(cv, 37, py0, 112, 46, color(me))
  text(cv, me.name, 43, py0 + 5, WHITE)
  pips(cv, 43, py0 + 14, me.hp, 2)
  shieldBar(cv, 43, py0 + 27, 100, me.shield)
  text(cv, `ANG ${STATE.angle}  POT ${STATE.power}`, 43, py0 + 37, GOLD)

  // barra de armas entera, 8 ranuras de 22, con el nombre y la munición del arma arriba
  const bw = 8 * 24 - 2 + 8
  const bx = Math.round((VW - bw) / 2)
  const by = VH - 2 - 40
  panel(cv, bx, by, bw, 40)
  const nm = `${WEAPON_NAMES[STATE.weapon].toUpperCase()}  x${STATE.ammoAll[STATE.weapon]}`
  text(cv, nm, center(nm, bx, bw), by + 5, WHITE)
  weaponRow(cv, bx + 4, by + 14)

  const others = tanks.slice(1)
  let ry = VH - 2 - 20
  for (const p of others) { compactPlate(cv, p, VW - 2, ry); ry -= 30 }
  return cv
}

// =====================================================================================
// C · TABLERO BROFORCE a lo ancho, abajo
// Una franja de lado a lado con secciones remachadas: retrato y vida | ÁNG | POT | VIENTO | COMB |
// ARMAS. Todos los números del tiro en ×3. Los rivales suben arriba a la derecha.
// =====================================================================================

function proposalC(scene) {
  const { cv, tanks, me } = worldScreen(scene)
  roundAndItems(cv)
  let below = 6
  if (scene.minimap) { below = minimap(cv, tanks).bottom + 4; edgeArrows(cv, tanks, 40, VH - 90) }
  status(cv, 'TU TURNO', below)

  // rivales arriba a la derecha, en columna
  let ry = 12
  for (const p of tanks.slice(1)) { compactPlate(cv, p, VW - 3, ry); ry += 30 }

  // franja
  const h = 62
  const y0 = VH - h
  cv.rect(0, y0, VW, h, OUT)
  cv.rect(0, y0 + 1, VW, 2, BRONZE)
  cv.rect(0, y0 + 3, VW, 1, BRONZE_D)
  cv.rect(0, y0 + 4, VW, h - 4, DARK)
  for (let x = 6; x < VW; x += 40) { cv.rect(x, y0 + 1, 2, 2, BRONZE_D); cv.put(x, y0 + 1, mix(BRONZE, WHITE, 0.4)) }
  const top = y0 + 6
  const lab = (s, x) => text(cv, s, x, top + 1, GREY)

  // retrato, nombre, vida y escudo
  portraitBox(cv, me, 4, top + 2)
  cv.rect(4, top + 2, 36, 1, GOLD)
  text(cv, 'VOS', 4 + 18 - Math.floor(measure('VOS') / 2), top + 41, GOLD)
  text(cv, me.name, 46, top + 1, WHITE)
  pips(cv, 46, top + 11, me.hp, 2)
  shieldBar(cv, 46, top + 30, 92, me.shield)
  let x = 144
  divider(cv, x, top - 1, h - 8)
  x += 7

  // ÁNG: número ×3 y un cuarto de dial chico al lado
  lab('ANG', x)
  big(cv, `${STATE.angle}°`, x, top + 16, WHITE, 3)
  dial(cv, x + 62, top + 40, 18, STATE.angle)
  x += 86
  divider(cv, x, top - 1, h - 8)
  x += 7

  // POT: número ×3 y barra segmentada de 10
  lab('POT', x)
  big(cv, `${STATE.power}`, x, top + 12, GOLD, 3)
  segBar(cv, x, top + 36, 94, 11, STATE.power / 100, [POW_LO, POW_MID, GOLD], { segs: 10 })
  x += 100
  divider(cv, x, top - 1, h - 8)
  x += 7

  // VIENTO: chevrons ×2, número ×3 y la manga chica
  lab('VIENTO', x)
  cell(cv, SOCK, UI.SOCK_CELL.w, UI.SOCK_CELL.h, sockFrame(STATE.wind), x + 54, top - 2)
  windChevrons(cv, x, top + 31, STATE.wind, 2)
  big(cv, `${Math.abs(STATE.wind)}`, x + 2, top + 12, windColor(STATE.wind), 3)
  x += 92
  divider(cv, x, top - 1, h - 8)
  x += 7

  // COMB: ◀ ▶ grandes y la barra en el medio
  lab('COMB', x)
  itemIcon(cv, 'fuel', x + 30, top - 2)
  moveButton(cv, x, top + 26, -1, 'A')
  moveButton(cv, x + 70, top + 26, 1, 'D')
  segBar(cv, x, top + 12, 92, 10, STATE.fuel, [FUEL, FUEL_HI, 0xd8ffb0], { segs: 6 })
  { const s = `${Math.round(STATE.fuel * 100)}%`; text(cv, s, center(s, x + 22, 48), top + 34, FUEL_HI) }
  x += 98
  divider(cv, x, top - 1, h - 8)
  x += 6

  // ARMAS: nombre y munición arriba, las 8 ranuras de 22 abajo
  const nm = WEAPON_NAMES[STATE.weapon].toUpperCase()
  const w0 = text(cv, nm, x + 1, top + 1, WHITE)
  text(cv, `x${STATE.ammoAll[STATE.weapon]}`, x + w0 + 6, top + 1, GOLD)
  weaponRow(cv, x, top + 11, 2)
  return cv
}

// ---------- salida ----------

const PROPOSALS = [
  { id: 'a', name: 'A  CONSOLA DE PUNTERIA', fn: proposalA },
  { id: 'b', name: 'B  EN EL TANQUE', fn: proposalB },
  { id: 'c', name: 'C  TABLERO BROFORCE', fn: proposalC },
]

const shots = {}
for (const p of PROPOSALS) {
  const g = p.fn(SCENES.grande)
  const c = p.fn(SCENES.chico)
  shots[p.id] = { g, c }
  fs.writeFileSync(path.join(outDir, `hud-${p.id}.png`), g.scaledPng(2))
  fs.writeFileSync(path.join(outDir, `hud-${p.id}-chico.png`), c.scaledPng(2))
}

// Hoja comparativa a 1× (el tamaño lógico: si se lee acá, se lee en el juego): filas A/B/C,
// columnas Grande y Chico.
{
  const pad = 12, head = 30, rowHead = 22
  const sheet = new Canvas(pad * 3 + VW * 2, head + PROPOSALS.length * (rowHead + VH + pad) + pad)
  sheet.rect(0, 0, sheet.w, sheet.h, 0x1a1412)
  big(sheet, 'HUD V2  TRES PROPUESTAS', pad, 9, GOLD, 2)
  text(sheet, 'ESCALA 1:1 LOGICA. IZQUIERDA MAPA GRANDE CON MINIMAPA, DERECHA CHICO', pad + 280, 13, GREY)
  PROPOSALS.forEach((p, i) => {
    const y = head + i * (rowHead + VH + pad)
    big(sheet, p.name, pad, y + 4, WHITE, 2)
    for (const [k, cv] of [[0, shots[p.id].g], [1, shots[p.id].c]]) {
      const x = pad + k * (VW + pad)
      sheet.rect(x - 1, y + rowHead - 1, VW + 2, VH + 2, OUT)
      sheet.blit(cv, x, y + rowHead)
      text(sheet, k ? 'CHICO' : 'GRANDE', x + VW - 40, y + 8, GREY)
    }
  })
  fs.writeFileSync(path.join(outDir, 'hud-comparativa.png'), sheet.png())
}
console.log('hud proposals ok')
