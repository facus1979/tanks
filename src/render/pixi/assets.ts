// Carga public/assets/manifest.json (forma de ../manifest.ts). Todo lo que falte se reemplaza por arte de reserva.
import { Rectangle, Texture } from 'pixi.js'
import type { Biome, CrewId } from '../../sim/types'
import { BIOMES, CREWS, TANK_COLORS } from '../../sim/types'
import { VIEW_H, VIEW_W } from '../types'
import type { AssetManifest, Strip } from '../manifest'
import * as fb from './fallback'
import { bayer, mix } from './raster'

const DIR = 'assets/'

export interface Font {
  data: ImageData
  glyphW: number
  glyphH: number
  chars: string
}

export interface BiomePalette {
  grass: number[]
  moss: number
  rim: number
  ambient: number
}

export interface Art {
  bodies: Texture[]
  wreck: Texture
  barrels: Texture[][]
  treads: Texture[][] // frames de oruga por color; se superponen a las últimas filas del cuerpo
  barrelPivot: { x: number; y: number }
  pivotInBody: { x: number; y: number }
  crewInBody: { x: number; y: number }
  antennaInBody: { x: number; y: number }
  crews: Record<CrewId, Texture>
  materials: (ImageData | null)[]
  backgrounds: Record<Biome, { layers: Texture[]; fog: number; tint: number }>
  palette: Record<Biome, BiomePalette>
  props: {
    barrel: Texture
    crate: Texture
    ladderTile: Texture
    lamp: Texture
    flag: Texture[]
    windsock: Texture[]
    parachute: Texture
  }
  alert: Texture
  ask: Texture
  arrow: Texture
  font: Font | null
}

const tex = (c: HTMLCanvasElement): Texture => {
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}

// Image + onload (no Assets.load ni img.decode): así también resuelve en el Chrome headless de QA.
const images = new Map<string, Promise<HTMLCanvasElement | null>>()
function loadCanvas(file: string): Promise<HTMLCanvasElement | null> {
  let p = images.get(file)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        if (!img.naturalWidth) return resolve(null)
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0)
        resolve(c)
      }
      img.onerror = () => resolve(null)
      img.src = DIR + file
    })
    images.set(file, p)
  }
  return p
}

async function loadTexture(file: string | undefined): Promise<Texture | null> {
  if (!file) return null
  const c = await loadCanvas(file)
  return c ? tex(c) : null
}

async function loadPixels(file: string | undefined): Promise<ImageData | null> {
  if (!file) return null
  const c = await loadCanvas(file)
  const ctx = c?.getContext('2d', { willReadFrequently: true })
  return c && ctx ? ctx.getImageData(0, 0, c.width, c.height) : null
}

function slice(base: Texture, cellW: number, cellH: number, frames: number): Texture[] {
  const out: Texture[] = []
  const n = Math.max(1, Math.min(frames, Math.floor(base.width / cellW)))
  for (let i = 0; i < n; i++) out.push(new Texture({ source: base.source, frame: new Rectangle(i * cellW, 0, cellW, Math.min(cellH, base.height)) }))
  return out
}

async function loadStrip(strip: Strip | undefined): Promise<Texture[] | null> {
  if (!strip) return null
  const base = await loadTexture(strip.file)
  if (!base) return null
  return slice(base, strip.cell.w, strip.cell.h, strip.frames)
}

async function loadManifest(): Promise<Partial<AssetManifest> | null> {
  try {
    const res = await fetch(DIR + 'manifest.json', { cache: 'no-cache' })
    if (!res.ok) return null
    const json = (await res.json()) as Partial<AssetManifest>
    return json.version === 2 ? json : null
  } catch {
    return null
  }
}

function skyFallback(biome: Biome): HTMLCanvasElement {
  const stops = fb.BIOME_SKY[biome]
  const c = document.createElement('canvas')
  c.width = VIEW_W
  c.height = VIEW_H
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const img = ctx.createImageData(VIEW_W, VIEW_H)
  for (let y = 0; y < VIEW_H; y++) {
    for (let x = 0; x < VIEW_W; x++) {
      const t = Math.min(1, Math.floor((y / VIEW_H) * 22 + bayer(x, y)) / 22) * (stops.length - 1)
      const i0 = Math.min(stops.length - 2, Math.floor(t))
      const col = mix(stops[i0], stops[i0 + 1], t - i0)
      const i = (y * VIEW_W + x) * 4
      img.data[i] = (col >> 16) & 255
      img.data[i + 1] = (col >> 8) & 255
      img.data[i + 2] = col & 255
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export async function loadArt(): Promise<Art> {
  const m = (await loadManifest()) ?? {}
  const t = m.tank
  const fallbackBodies = TANK_COLORS.map((c, i) => fb.tankBody(i, c))

  const fallbackTreads = fb.treadFrames().map(tex)
  const [bodies, wreck, barrels, treads, crews, materials, backgrounds, props, ui] = await Promise.all([
    Promise.all([0, 1, 2, 3].map(async (i) => (await loadTexture(t?.bodies?.[i])) ?? tex(fallbackBodies[i]))),
    loadTexture(t?.wreck).then((x) => x ?? tex(fb.tankBody(1, 0x2a1a14, true))),
    Promise.all(
      [0, 1, 2, 3].map(async (i) => (await loadStrip(t?.barrels?.[i])) ?? slice(tex(fb.barrelStrip(i)), fb.BARREL_CELL, fb.BARREL_CELL, 19)),
    ),
    Promise.all([0, 1, 2, 3].map(async (i) => (await loadStrip(t?.treadFrames?.[i])) ?? fallbackTreads)),
    Promise.all(CREWS.map(async (c) => [c, (await loadTexture(m.crews?.[c]?.sprite)) ?? tex(fb.crewSprite(c))] as const)),
    Promise.all(
      Array.from({ length: 10 }, (_, id) => {
        const entry = (m.materials as Record<string, { file: string }> | undefined)?.[String(id)]
        return loadPixels(entry?.file)
      }),
    ),
    Promise.all(
      BIOMES.map(async (b) => {
        const def = m.backgrounds?.[b]
        const layers = def ? (await Promise.all(def.layers.map((f) => loadTexture(f)))).filter((x): x is Texture => !!x) : []
        if (layers.length === 0) layers.push(tex(skyFallback(b)))
        return [b, { layers, fog: def?.fog ?? fb.BIOME_PALETTE[b].ambient, tint: def?.tint ?? 0xffffff }] as const
      }),
    ),
    (async () => {
      const p = m.props
      const [barrel, crate, ladderTile, lamp, flag, windsock, parachute] = await Promise.all([
        loadTexture(p?.barrel),
        loadTexture(p?.crate),
        loadTexture(p?.ladderTile),
        loadTexture(p?.lamp),
        loadStrip(p?.flag),
        loadStrip(p?.windsock),
        loadTexture(p?.parachute),
      ])
      return {
        barrel: barrel ?? tex(fb.solid(10, 12, 0xd0362c)),
        crate: crate ?? tex(fb.solid(12, 12, 0x8a6a44)),
        ladderTile: ladderTile ?? tex(fb.gridCanvas8x4()),
        lamp: lamp ?? tex(fb.solid(3, 4, 0xfff6c8, 0x2a2a24)),
        flag: flag ?? [tex(fb.solid(18, 11, 0xc8302a))],
        windsock: windsock ?? [tex(fb.solid(14, 6, 0xf06a2a))],
        parachute: parachute ?? tex(fb.parachute()),
      }
    })(),
    (async () => {
      const u = m.ui
      const [alert, ask, arrow, font] = await Promise.all([
        loadTexture(u?.bubbleAlert),
        loadTexture(u?.bubbleAsk),
        loadTexture(u?.arrow),
        loadPixels(u?.font?.file),
      ])
      return {
        alert: alert ?? tex(fb.bubbleAlert()),
        ask: ask ?? tex(fb.bubbleAsk()),
        arrow: arrow ?? tex(fb.arrow()),
        font: font && u?.font ? { data: font, glyphW: u.font.glyphW, glyphH: u.font.glyphH, chars: u.font.chars } : null,
      }
    })(),
  ])

  const palette = Object.fromEntries(BIOMES.map((b) => [b, { ...fb.BIOME_PALETTE[b], ...(m.biomePalette?.[b] ?? {}) }])) as Record<Biome, BiomePalette>
  for (const b of BIOMES) if (!palette[b].grass || palette[b].grass.length === 0) palette[b].grass = fb.BIOME_PALETTE[b].grass

  return {
    bodies,
    wreck,
    barrels,
    treads,
    barrelPivot: t?.barrelPivot ?? fb.BARREL_PIVOT,
    pivotInBody: t?.pivotInBody ?? { x: 19, y: 3 },
    crewInBody: t?.crewInBody ?? { x: 8, y: -11 },
    antennaInBody: t?.antennaInBody ?? { x: 9, y: 0 },
    crews: Object.fromEntries(crews) as Record<CrewId, Texture>,
    materials,
    backgrounds: Object.fromEntries(backgrounds) as Art['backgrounds'],
    palette,
    props,
    alert: ui.alert,
    ask: ui.ask,
    arrow: ui.arrow,
    font: ui.font,
  }
}
