// Hoja de revisión de F6-F8: retratos, íconos de armas y frames de oruga. Uso: node scripts/lookdev/sheet-f6f8.mjs
import fs from 'node:fs'
import { Canvas, TANK_W, TREAD_H } from './pixel.mjs'
import { portrait, treadStrip, tankBody, TREAD_FRAMES } from './characters.mjs'
import { weaponIconStrip } from './ui.mjs'

const cv = new Canvas(200, 100)
cv.rect(0, 0, cv.w, cv.h, 0x1c1614)
;['bandana', 'sarge', 'rookie', 'desert'].forEach((id, k) => {
  cv.rect(4 + k * 38, 4, 34, 34, 0x3a3230)
  cv.blit(portrait(id), 5 + k * 38, 5)
})
cv.blit(weaponIconStrip(), 4, 44)
// cuerpo del color 0 con cada frame de oruga encima, y las tiras de los otros colores
const cellOf = (s, f) => {
  const c = new Canvas(TANK_W, TREAD_H)
  for (let y = 0; y < TREAD_H; y++) for (let x = 0; x < TANK_W; x++) if (s.alpha(f * TANK_W + x, y)) c.put(x, y, s.get(f * TANK_W + x, y))
  return c
}
for (let f = 0; f < TREAD_FRAMES; f++) {
  const body = tankBody(0)
  body.blit(cellOf(treadStrip(0), f), 0, body.h - TREAD_H)
  cv.blit(body, 4 + f * 32, 60)
}
for (let i = 1; i < 4; i++) for (let f = 0; f < TREAD_FRAMES; f++) cv.blit(cellOf(treadStrip(i), f), 4 + f * 32, 76 + (i - 1) * 7)
fs.writeFileSync(new URL('../../preview/sheet-f6f8.png', import.meta.url), cv.scaledPng(6))
