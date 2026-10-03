// Tira de verificación de fondos v2.3 (repeat por capa). Descartable: no es código del juego.
// Reemplaza a v3-bg-strip.mjs, que siempre espejaba.
// Lee public/assets/manifest.json y public/assets/bg/<bioma>-0..4.png y compone cada bioma a lo ancho de
// 2400 px respetando backgrounds[bioma].repeat: 'wrap' = la capa tal cual una al lado de la otra, 'mirror' (o
// sin repeat) = alternando copia y copia espejada como en v2. Sin parallax: las uniones de todas las capas
// caen juntas en x = 800 y x = 1600, que es el peor caso para mirarlas.
// Uso: node scripts/lookdev/v23-bg-strip.mjs [--layers] [--chico]
//   → preview/v23-bg-<bioma>.png (2400×450, con marquitas rojas arriba en las uniones)
//   → con --layers, además preview/v23-bg-<bioma>-layers.png (cada capa sola sobre gris, una debajo de otra)
//   → con --chico, además preview/v23-chico-<bioma>.png (la pantalla de Chico: las capas de 0 a 800 compuestas)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Canvas } from './pixel.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const assets = path.join(root, 'public', 'assets')
const outDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })

const STRIP_W = 2400
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'))
const withLayers = process.argv.includes('--layers')
const withChico = process.argv.includes('--chico')

// Decodificador mínimo: solo PNG RGBA de 8 bits sin entrelazado (lo que escribe encodePng), con los 5 filtros.
function decodePng(file) {
  const buf = fs.readFileSync(file)
  let p = 8
  let w = 0
  let h = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${file}: se esperaba RGBA 8 bits sin entrelazado`)
    } else if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const cv = new Canvas(w, h)
  const stride = w * 4
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= 4 ? cur[i - 4] : 0
      const b = prev[i]
      const c = i >= 4 ? prev[i - 4] : 0
      let v = x
      if (f === 1) v = x + a
      else if (f === 2) v = x + b
      else if (f === 3) v = x + ((a + b) >> 1)
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      cur[i] = v & 255
    }
    cv.px.set(cur, y * stride)
    prev.set(cur)
  }
  return cv
}

// Copia la capa repetida a lo ancho como el renderer: con 'wrap' todas las copias derechas; con 'mirror' el
// tile k va espejado si k es impar.
function tileInto(dst, L, mode, y0 = 0) {
  for (let k = 0; k * L.w < dst.w; k++) dst.blit(L, k * L.w, y0, mode !== 'wrap' && (k & 1) === 1)
}

for (const [biome, bg] of Object.entries(manifest.backgrounds)) {
  const layers = bg.layers.map((f) => decodePng(path.join(assets, f)))
  const modes = layers.map((_, i) => bg.repeat?.[i] ?? 'mirror')
  const H = layers[0].h
  const strip = new Canvas(STRIP_W, H)
  layers.forEach((L, i) => tileInto(strip, L, modes[i]))
  // marquitas en las uniones (solo 4 px arriba, para no tapar nada)
  for (let x = layers[0].w; x < STRIP_W; x += layers[0].w) for (let y = 0; y < 4; y++) strip.put(x - 1, y, 0xff0000), strip.put(x, y, 0xff0000)
  fs.writeFileSync(path.join(outDir, `v23-bg-${biome}.png`), strip.png())
  console.log(`preview/v23-bg-${biome}.png  repeat: ${modes.join(' ')}`)
  if (withLayers) {
    const sheet = new Canvas(STRIP_W, H * layers.length)
    sheet.rect(0, 0, STRIP_W, H * layers.length, 0x808080)
    layers.forEach((L, i) => tileInto(sheet, L, modes[i], i * H))
    fs.writeFileSync(path.join(outDir, `v23-bg-${biome}-layers.png`), sheet.png())
    console.log(`preview/v23-bg-${biome}-layers.png`)
  }
  if (withChico) {
    const chico = new Canvas(layers[0].w, H)
    for (const L of layers) chico.blit(L, 0, 0)
    fs.writeFileSync(path.join(outDir, `v23-chico-${biome}.png`), chico.png())
    console.log(`preview/v23-chico-${biome}.png`)
  }
}
