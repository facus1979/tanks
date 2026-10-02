// Hoja de verificación de V5 (hasta 8 jugadores): los 8 retratos del HUD, los 8 tripulantes de 12×12 y los
// 8 tanques armados (antena con banderín, cañón, cuerpo, oruga y tripulante), todo a ×4. Abajo, los 8 juntos
// sobre cielo y pasto; aparte, preview/v5-crews-1x.png los muestra a ×2 para juzgar si se distinguen de lejos.
// Uso: node scripts/lookdev/v5-crews.mjs  → preview/v5-crews.png
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Canvas, OUT, mix, antenna, STRIPES, HULLS, TANK_W, TANK_H, TREAD_H, PIVOT, CREW_X } from './pixel.mjs'
import { tankBody, barrelGeometry, barrelStrip, treadStrip, crewSprite, portrait, BARREL_STEP } from './characters.mjs'
import * as UI from './ui.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const previewDir = path.join(root, 'preview')
fs.mkdirSync(previewDir, { recursive: true })

const CREWS = ['bandana', 'sarge', 'rookie', 'desert', 'commando', 'goggles', 'pilot', 'colonel']
const NAMES = ['BANDANA', 'SARGE', 'ROOKIE', 'DESERT', 'COMANDO', 'TANQUISTA', 'PILOTO', 'CORONEL']
const COLOR_NAMES = ['AZUL', 'ROJO', 'AMARILLO', 'VERDE', 'VIOLETA', 'NARANJA', 'TURQUESA', 'ROSA']
const N = 8

// recorta el frame f de una tira horizontal de celdas iguales
function cell(src, w, h, f) {
  const out = new Canvas(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * src.w + f * w + x) * 4
      if (src.px[i + 3]) out.put(x, y, (src.px[i] << 16) | (src.px[i + 1] << 8) | src.px[i + 2], src.px[i + 3] / 255)
    }
  return out
}

const font = UI.fontStrip()
function label(cv, str, x, y) {
  for (const ch of str.toUpperCase()) {
    const i = UI.FONT_CHARS.indexOf(ch)
    if (i >= 0) cv.blit(cell(font, UI.GLYPH.w, UI.GLYPH.h, i), x, y)
    x += UI.GLYPH.w
  }
}

// Tanque armado como lo hace el renderer (mismos offsets que el manifiesto): x0/ground = esquina del cuerpo y piso.
const geo = barrelGeometry()
function tank(cv, i, crew, x0, ground, angle) {
  const flip = angle > 90
  const local = flip ? 180 - angle : angle
  const t = new Canvas(TANK_W + 24, TANK_H + 24)
  const ox = 12
  const oy = 16
  antenna(t, ox + 9, oy, STRIPES[i][1])
  t.blit(cell(barrelStrip(i, geo), geo.cell.w, geo.cell.h, Math.round(local / BARREL_STEP)), ox + PIVOT.x - geo.pivot.x, oy + PIVOT.y - geo.pivot.y)
  t.blit(tankBody(i), ox, oy)
  t.blit(cell(treadStrip(i), TANK_W, TREAD_H, i % 4), ox, oy + TANK_H - TREAD_H)
  t.blit(crewSprite(crew), ox + CREW_X, oy - 11)
  cv.blit(t, flip ? x0 - (t.w - ox - TANK_W) : x0 - ox, ground - TANK_H - oy, flip)
}

const COLW = 58
const W = 8 + N * COLW
const H = 208
const cv = new Canvas(W, H)
cv.rect(0, 0, W, H, 0xd9c3a4)
for (let y = 0; y < 150; y++) for (let x = 0; x < W; x++) if (((x >> 3) + (y >> 3)) & 1) cv.put(x, y, 0xcfb898)

for (let i = 0; i < N; i++) {
  const x = 8 + i * COLW
  // marco del HUD con el color del jugador, como el retrato del tablero
  cv.rect(x - 1, 3, 36, 36, OUT)
  cv.rect(x, 4, 34, 34, STRIPES[i][1])
  cv.rect(x + 1, 5, 32, 32, 0x1c1614)
  cv.blit(portrait(CREWS[i]), x + 1, 5)
  label(cv, NAMES[i], x - 1, 42)
  cv.blit(crewSprite(CREWS[i]), x + 11, 52)
  // tanque mirando a la derecha y a la izquierda con su tripulante
  tank(cv, i, CREWS[i], x + 3, 100, 40)
  tank(cv, i, CREWS[i], x + 3, 136, 140)
  label(cv, COLOR_NAMES[i], x - 1, 140)
}

// Los 8 juntos sobre cielo y pasto, alternando hacia dónde miran.
const far = new Canvas(W, 58)
for (let y = 0; y < far.h; y++)
  for (let x = 0; x < W; x++) far.put(x, y, y < 40 ? mix(0x9cc8e8, 0xf0dfc8, y / 40) : y === 40 ? 0x6aa03a : 0x5a4030)
for (let i = 0; i < N; i++) tank(far, i, CREWS[i], 12 + i * COLW, 40, i % 2 ? 130 : 50)
cv.blit(far, 0, 150)

fs.writeFileSync(path.join(previewDir, 'v5-crews.png'), cv.scaledPng(4))

// Tira chica a ×2 (casi la escala del juego) para ver si los 8 se distinguen de lejos.
const strip = new Canvas(N * 34 + 4, 44)
for (let y = 0; y < strip.h; y++) for (let x = 0; x < strip.w; x++) strip.put(x, y, mix(0x9cc8e8, 0xf0dfc8, y / 44))
for (let i = 0; i < N; i++) tank(strip, i, CREWS[i], 4 + i * 34, 40, 50)
fs.writeFileSync(path.join(previewDir, 'v5-crews-1x.png'), strip.scaledPng(2))
console.log(`preview/v5-crews.png (${W * 4}×${H * 4}), cascos: ${HULLS.length}`)
