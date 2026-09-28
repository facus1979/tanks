// Genera public/assets/ y public/assets/manifest.json con la forma de src/render/manifest.ts (version 2).
// Todo el arte sale de scripts/lookdev/*.mjs, que comparte utilidades con la referencia (look-test.mjs).
// Uso: node scripts/paint-assets.mjs  → public/assets/** y hojas de revisión en preview/sheet-*.png
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Canvas, OUT, mix, makeRand, flatTarget, paintForestBackground, TANK_W, TANK_H, PIVOT, CREW_X, antenna, STRIPES, bayer, rnd, TREAD_H } from './lookdev/pixel.mjs'
import { tankBody, tankWreck, barrelGeometry, barrelStrip, treadStrip, crewSprite, portrait, BARREL_FRAMES, TREAD_FRAMES } from './lookdev/characters.mjs'
import * as TX from './lookdev/textures.mjs'
import { BIOME_PAINTERS, BIOME_BG, BIOME_PALETTE, BG_W, BG_H } from './lookdev/biomes.mjs'
import * as UI from './lookdev/ui.mjs'
import * as F10 from './lookdev/f10.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'public', 'assets')
const previewDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(previewDir, { recursive: true })

const written = []
function save(rel, cv) {
  const file = path.join(outDir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, cv.png())
  written.push(rel)
  return rel
}
const strip = (rel, cv, cell, frames) => {
  if (cv.w !== cell.w * frames || cv.h !== cell.h) throw new Error(`${rel}: tira de ${cv.w}×${cv.h}, esperaba ${cell.w * frames}×${cell.h}`)
  return { file: save(rel, cv), cell, frames }
}
const expectSize = (name, cv, w, h) => {
  if (cv.w !== w || cv.h !== h) throw new Error(`${name}: ${cv.w}×${cv.h}, esperaba ${w}×${h}`)
}

// Constantes que tienen que coincidir con src/sim/types.ts
const SIM = { TANK_W: 28, TANK_H: 20, PIVOT_X: 5, PIVOT_Y: 17, BARREL_LEN: 14 }
const CREWS = ['bandana', 'sarge', 'rookie', 'desert']
const BIOMES = ['forest', 'jungle', 'industrial']
const MATERIAL_IDS = { AIR: 0, DIRT: 1, STONE: 2, BRICK: 3, WOOD: 4, SLAT: 5, BEAM: 6, POST: 7, METAL: 8, BEDROCK: 9 }

if (TANK_W !== SIM.TANK_W || TANK_H !== SIM.TANK_H) throw new Error('el tanque no mide TANK_W × TANK_H')
if (PIVOT.x - TANK_W / 2 !== SIM.PIVOT_X || TANK_H - PIVOT.y !== SIM.PIVOT_Y) throw new Error('el pivote no coincide con PIVOT_X/PIVOT_Y')

// ---------- tanques ----------

const geo = barrelGeometry()
const bodies = []
const barrels = []
for (let i = 0; i < 4; i++) {
  const b = tankBody(i)
  expectSize(`cuerpo ${i}`, b, TANK_W, TANK_H)
  bodies.push(save(`tank/body-${i}.png`, b))
  barrels.push(strip(`tank/barrel-${i}.png`, barrelStrip(i, geo), geo.cell, BARREL_FRAMES))
}
const wreck = save('tank/wreck.png', tankWreck())
// orugas: una tira de 4 frames por color (orden de bodies); van en las últimas TREAD_H filas del cuerpo
const treadFrames = [0, 1, 2, 3].map((i) => strip(`tank/treads-${i}.png`, treadStrip(i), { w: TANK_W, h: TREAD_H }, TREAD_FRAMES))

const tank = {
  bodies,
  wreck,
  barrels,
  barrelPivot: geo.pivot,
  pivotInBody: { x: PIVOT.x, y: PIVOT.y },
  // el tripulante de 12×12 asoma 11 filas sobre el cuerpo: su última fila pisa la primera del casco
  crewInBody: { x: CREW_X, y: -11 },
  // base del mástil; el renderer lo dibuja 12 px hacia arriba con el banderín del color del jugador
  antennaInBody: { x: 9, y: 0 },
  treadFrames,
}

// ---------- tripulantes ----------

const crews = {}
for (const id of CREWS) {
  const s = crewSprite(id)
  const p = portrait(id)
  expectSize(`tripulante ${id}`, s, 12, 12)
  expectSize(`retrato ${id}`, p, 32, 32)
  crews[id] = { sprite: save(`crew/${id}.png`, s), portrait: save(`crew/${id}-portrait.png`, p) }
}

// ---------- materiales ----------

const TEXTURES = {
  AIR: TX.airTexture,
  DIRT: TX.dirtTexture,
  STONE: TX.stoneTexture,
  BRICK: TX.brickTexture,
  WOOD: TX.plankTexture,
  SLAT: TX.slatTexture,
  BEAM: TX.beamTexture,
  POST: TX.postTexture,
  METAL: TX.metalTexture,
  BEDROCK: TX.bedrockTexture,
}
const materials = {}
const textureCanvases = {}
for (const [name, id] of Object.entries(MATERIAL_IDS)) {
  const cv = TEXTURES[name]()
  textureCanvases[name] = cv
  materials[id] = { file: save(`materials/${name.toLowerCase()}.png`, cv), w: cv.w, h: cv.h }
}

// ---------- fondos ----------

const backgrounds = {}
const bgLayers = {}
for (const biome of BIOMES) {
  const layers = BIOME_PAINTERS[biome]()
  layers.forEach((L, i) => expectSize(`${biome} capa ${i}`, L, BG_W, BG_H))
  // la capa 0 es opaca
  for (let i = 3; i < layers[0].px.length; i += 4) if (layers[0].px[i] !== 255) throw new Error(`${biome}: el cielo tiene alfa`)
  bgLayers[biome] = layers
  backgrounds[biome] = { layers: layers.map((L, i) => save(`bg/${biome}-${i}.png`, L)), ...BIOME_BG[biome] }
}

function composite(layers) {
  const cv = new Canvas(BG_W, BG_H)
  for (const L of layers) cv.blit(L, 0, 0)
  return cv
}

// El bosque tiene que ser el fondo de la referencia pixel por pixel.
{
  const flat = new Canvas(BG_W, BG_H)
  const R = makeRand(42)
  paintForestBackground(flatTarget(flat), R.next)
  const comp = composite(bgLayers.forest)
  let diff = 0
  for (let i = 0; i < flat.px.length; i++) if (Math.abs(flat.px[i] - comp.px[i]) > 1) diff++
  if (diff) throw new Error(`el fondo del bosque difiere de la referencia en ${diff} canales`)
}

// ---------- utilería y UI ----------

const props = {
  barrel: save('props/barrel.png', UI.barrelProp()),
  crate: save('props/crate.png', UI.crateProp()),
  ladderTile: save('props/ladder.png', UI.ladderTile()),
  lamp: save('props/lamp.png', UI.lampProp()),
  flag: strip('props/flag.png', UI.flagStrip(), UI.FLAG_CELL, UI.FLAG_FRAMES),
  windsock: strip('props/windsock.png', UI.windsockStrip(), UI.SOCK_CELL, UI.SOCK_FRAMES),
  parachute: save('props/parachute.png', F10.parachuteProp()),
}

const fontCv = UI.fontStrip()
const ui = {
  bubbleAlert: save('ui/bubble-alert.png', UI.bubbleAlert()),
  bubbleAsk: save('ui/bubble-ask.png', UI.bubbleAsk()),
  tag: save('ui/tag.png', UI.tagBubble()),
  font: { file: save('ui/font.png', fontCv), glyphW: UI.GLYPH.w, glyphH: UI.GLYPH.h, chars: UI.FONT_CHARS },
  arrow: save('ui/arrow.png', UI.arrowUp()),
  pip: strip('ui/pip.png', UI.pipStrip(), { w: 4, h: 5 }, 2),
  weaponIcons: strip('ui/weapons.png', UI.weaponIconStrip(), { w: 12, h: 12 }, 8),
  itemIcons: strip('ui/items.png', F10.itemIconStrip(), { w: 12, h: 12 }, 5),
  logo: save('ui/logo.png', F10.logo()),
}

// ---------- manifiesto ----------

const manifest = { version: 2, tank, crews, materials, backgrounds, biomePalette: BIOME_PALETTE, props, ui }
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

// ---------- hojas de revisión ----------

const cellOf = (cv, s, f) => {
  const out = new Canvas(s.cell.w, s.cell.h)
  for (let y = 0; y < s.cell.h; y++)
    for (let x = 0; x < s.cell.w; x++) {
      const i = (y * cv.w + f * s.cell.w + x) * 4
      if (cv.px[i + 3]) out.put(x, y, (cv.px[i] << 16) | (cv.px[i + 1] << 8) | cv.px[i + 2], cv.px[i + 3] / 255)
    }
  return out
}

function label(cv, str, x, y) {
  for (const ch of str.toUpperCase()) {
    const i = UI.FONT_CHARS.indexOf(ch)
    if (i >= 0) cv.blit(cellOf(fontCv, { cell: UI.GLYPH }, i), x, y)
    x += UI.GLYPH.w
  }
}

// Arma un tanque como lo va a hacer el renderer: antena, cañón, cuerpo, tripulante; espejado si mira a la izquierda.
const barrelCanvases = [0, 1, 2, 3].map((i) => barrelStrip(i, geo))
const crewCanvases = Object.fromEntries(CREWS.map((id) => [id, crewSprite(id)]))
function assemble(cv, i, crew, x0, ground, angle) {
  const flip = angle > 90
  const local = flip ? 180 - angle : angle
  const f = Math.round(local / 5)
  const bodyTop = ground - TANK_H
  const t = new Canvas(TANK_W + 24, TANK_H + 24)
  const ox = 12
  const oy = 16
  antenna(t, ox + tank.antennaInBody.x, oy + tank.antennaInBody.y, STRIPES[i][1])
  t.blit(cellOf(barrelCanvases[i], barrels[i], f), ox + tank.pivotInBody.x - geo.pivot.x, oy + tank.pivotInBody.y - geo.pivot.y)
  t.blit(i < 0 ? tankWreck() : tankBody(i), ox, oy)
  t.blit(crewCanvases[crew], ox + tank.crewInBody.x, oy + tank.crewInBody.y)
  // espejado alrededor del centro del cuerpo
  cv.blit(t, flip ? x0 - (t.w - ox - TANK_W) : x0 - ox, bodyTop - oy, flip)
}

function sheetTanks() {
  const cv = new Canvas(250, 150)
  cv.rect(0, 0, cv.w, cv.h, 0xd9c3a4)
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) if (((x >> 3) + (y >> 3)) & 1) cv.put(x, y, 0xcfb898)
  label(cv, 'CUERPOS', 4, 3)
  for (let i = 0; i < 4; i++) cv.blit(tankBody(i), 4 + i * 32, 12)
  cv.blit(tankWreck(), 4 + 4 * 32, 12)
  label(cv, 'CANON 0-90', 4, 36)
  for (let i = 0; i < 4; i++) {
    const s = barrelCanvases[i]
    for (let f = 0; f < BARREL_FRAMES; f += 3) cv.blit(cellOf(s, barrels[i], f), 4 + i * 60 + (f / 3) * 8, 45)
  }
  label(cv, 'ARMADOS', 4, 66)
  const combos = [
    [0, 'bandana', 55],
    [1, 'sarge', 152],
    [2, 'rookie', 128],
    [3, 'desert', 140],
    [0, 'rookie', 90],
    [1, 'desert', 0],
    [2, 'bandana', 180],
  ]
  combos.forEach(([i, crew, a], k) => assemble(cv, i, crew, 8 + k * 34, 110, a))
  label(cv, 'TRIPULANTES', 4, 116)
  CREWS.forEach((id, k) => {
    cv.blit(crewCanvases[id], 4 + k * 16, 126)
    cv.blit(portrait(id), 76 + k * 36, 116)
  })
  fs.writeFileSync(path.join(previewDir, 'sheet-tanks.png'), cv.scaledPng(6))
}

function sheetMaterials() {
  const names = Object.keys(MATERIAL_IDS).filter((n) => n !== 'AIR')
  const tw = 300
  const th = 150
  const cols = 3
  const cv = new Canvas(cols * (tw + 8) + 8, Math.ceil(names.length / cols) * (th + 18) + 8)
  cv.rect(0, 0, cv.w, cv.h, 0x2a2420)
  names.forEach((n, k) => {
    const x0 = 8 + (k % cols) * (tw + 8)
    const y0 = 8 + Math.floor(k / cols) * (th + 18)
    const t = textureCanvases[n]
    // mosaico más grande que la textura para ver costuras y repetición
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) cv.put(x0 + x, y0 + 10 + y, t.get(x % t.w, y % t.h))
    label(cv, `${n} ${t.w}X${t.h}`, x0, y0)
    // marca del borde del tile
    for (let y = 0; y < th; y += 4) cv.put(x0 + t.w, y0 + 10 + y, 0xff00ff)
  })
  fs.writeFileSync(path.join(previewDir, 'sheet-materials.png'), cv.scaledPng(2))
}

// Escena mínima: fondo del bioma, suelo con textura y pasto de la paleta, tanques.
function sheetBiome(biome) {
  const cv = composite(bgLayers[biome])
  const pal = BIOME_PALETTE[biome]
  const dirt = textureCanvases.DIRT
  const stone = textureCanvases.STONE
  const surf = (x) => Math.round(372 + Math.sin(x / 70) * 10 + Math.sin(x / 23) * 3 - 40 * Math.exp(-(((x - 420) / 60) ** 2)))
  for (let x = 0; x < BG_W; x++) {
    const s = x < 180 ? 350 : surf(x)
    for (let y = s; y < BG_H; y++) {
      let c = x < 180 && y < 364 ? stone.get(x % stone.w, y % stone.h) : dirt.get(x % dirt.w, y % dirt.h)
      if (y === s) c = x < 180 ? mix(c, 0xa89e84, 0.3) : pal.rim
      cv.put(x, y, c)
    }
    if (rnd(x, 1, 81) > 0.5) {
      const h = 1 + Math.floor(rnd(x, 2, 82) * 4)
      for (let k = 1; k <= h; k++) cv.put(x, s - k, pal.grass[k === h ? 2 : k === 1 ? 0 : 1])
    }
    if (x < 180 && rnd(x, 3, 83) > 0.8) cv.put(x, s, pal.moss)
  }
  assemble(cv, 0, 'bandana', 80, 350, 55)
  assemble(cv, 2, 'rookie', 406, surf(420), 128)
  assemble(cv, 3, 'desert', 600, surf(614), 140)
  label(cv, biome, 6, 6)
  fs.writeFileSync(path.join(previewDir, `sheet-bg-${biome}.png`), cv.scaledPng(2))
  // tira con las capas por separado sobre damero
  const n = bgLayers[biome].length
  const strip = new Canvas(BG_W, BG_H * n)
  for (let i = 0; i < n; i++) {
    for (let y = 0; y < BG_H; y++) for (let x = 0; x < BG_W; x++) strip.put(x, i * BG_H + y, ((x >> 4) + (y >> 4)) & 1 ? 0x505050 : 0x606060)
    strip.blit(bgLayers[biome][i], 0, i * BG_H)
  }
  fs.writeFileSync(path.join(previewDir, `sheet-bg-${biome}-layers.png`), strip.png())
}

function sheetUi() {
  const cv = new Canvas(290, 168)
  cv.rect(0, 0, cv.w, cv.h, 0x6a7a8a)
  label(cv, 'UTILERIA', 4, 3)
  cv.blit(UI.barrelProp(), 4, 14)
  cv.blit(UI.crateProp(), 18, 14)
  for (let k = 0; k < 6; k++) cv.blit(UI.ladderTile(), 34, 12 + k * 4)
  cv.blit(UI.lampProp(), 46, 12)
  const fl = UI.flagStrip()
  for (let f = 0; f < UI.FLAG_FRAMES; f++) cv.blit(cellOf(fl, props.flag, f), 58 + f * 23, 2)
  const ws = UI.windsockStrip()
  label(cv, 'VIENTO -10 A 10', 4, 44)
  for (let f = 0; f < UI.SOCK_FRAMES; f++) cv.blit(cellOf(ws, props.windsock, f), 4 + f * 34, 52)
  label(cv, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 4, 86)
  label(cv, '0123456789 .,:!?-/%+', 4, 94)
  label(cv, 'UI', 4, 104)
  const uy = 112
  cv.blit(UI.bubbleAlert(), 4, uy)
  cv.blit(UI.bubbleAsk(), 18, uy)
  const tag = UI.tagBubble()
  const colors = [0x2f7ae0, 0xd0362c, 0xe2c13d, 0x3dbe5a]
  colors.forEach((c, k) => {
    const t = new Canvas(tag.w, tag.h)
    for (let y = 0; y < tag.h; y++)
      for (let x = 0; x < tag.w; x++)
        if (tag.alpha(x, y)) {
          const kk = (tag.get(x, y) & 255) / 255
          t.put(x, y, (Math.round(((c >> 16) & 255) * kk) << 16) | (Math.round(((c >> 8) & 255) * kk) << 8) | Math.round((c & 255) * kk))
        }
    cv.blit(t, 34 + k * 18, uy)
    label(cv, `P${k + 1}`, 34 + k * 18 + 3, uy + 3)
  })
  cv.blit(UI.arrowUp(), 110, uy + 2)
  const pip = UI.pipStrip()
  for (let k = 0; k < 6; k++) cv.blit(cellOf(pip, ui.pip, k < 4 ? 0 : 1), 124 + k * 6, uy + 4)
  const wi = UI.weaponIconStrip()
  for (let f = 0; f < 8; f++) cv.blit(cellOf(wi, ui.weaponIcons, f), 164 + f * 14, uy + 1)
  // paneles de HUD como los de la referencia, con el retrato de 32
  hudPanel(cv, 4, 128, 0x2f7ae0, 'BRODOZER', 'bandana', 5)
  hudPanel(cv, 150, 128, 0xd0362c, 'SARGE', 'sarge', 2)
  fs.writeFileSync(path.join(previewDir, 'sheet-ui.png'), cv.scaledPng(5))
}

function sheetF10() {
  const cv = new Canvas(330, 150)
  cv.rect(0, 0, cv.w, cv.h, 0x6a7a8a)
  for (let y = 0; y < 50; y++) for (let x = 0; x < 330; x++) cv.put(x, 100 + y, ((x >> 3) + (y >> 3)) & 1 ? 0x8ab0d0 : 0x94b8d8)
  cv.blit(F10.logo(), 5, 2)
  label(cv, 'ITEMS', 4, 102)
  const it = F10.itemIconStrip()
  for (let f = 0; f < 5; f++) cv.blit(cellOf(it, ui.itemIcons, f), 4 + f * 14, 111)
  cv.blit(F10.parachuteProp(), 90, 106)
  cv.blit(UI.crateProp(), 100, 122)
  fs.writeFileSync(path.join(previewDir, 'sheet-f10.png'), cv.scaledPng(3))
}

function hudPanel(cv, x, y, color, name, crew, pips) {
  cv.rect(x, y, 36, 36, OUT)
  cv.rect(x + 1, y + 1, 34, 34, color)
  cv.rect(x + 2, y + 2, 32, 32, 0x1c1614)
  for (let yy = 18; yy < 32; yy++) for (let xx = 0; xx < 32; xx++) if (bayer(xx, yy) < (yy - 18) / 14) cv.put(x + 2 + xx, y + 2 + yy, mix(0x1c1614, color, 0.3))
  cv.blit(portrait(crew), x + 2, y + 2)
  const bx = x + 35
  cv.rect(bx, y + 12, 78, 22, OUT)
  cv.rect(bx + 1, y + 13, 76, 20, color)
  cv.rect(bx + 2, y + 14, 74, 18, 0x0e0a09)
  label(cv, name, bx + 5, y + 16)
  const pip = UI.pipStrip()
  for (let i = 0; i < 6; i++) cv.blit(cellOf(pip, ui.pip, i < pips ? 0 : 1), bx + 5 + i * 7, y + 25)
}

sheetTanks()
sheetMaterials()
for (const b of BIOMES) sheetBiome(b)
sheetUi()
sheetF10()

console.log(`assets: ${written.length} archivos en public/assets, manifest v2; cañón ${geo.cell.w}×${geo.cell.h} pivote ${geo.pivot.x},${geo.pivot.y}`)
