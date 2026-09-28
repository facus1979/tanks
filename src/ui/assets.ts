// Assets de UI leídos de public/assets/manifest.json. Todo es opcional: si falta algo, la UI dibuja un respaldo.
import type { AssetManifest, Strip } from '../render/manifest'
import { CREWS, type CrewId } from '../sim/types'
import { fallbackFont, fontFromImage, type PixelFont } from './pixelfont'

export interface StripImage {
  img: HTMLImageElement
  w: number
  h: number
  frames: number
}

export interface UiAssets {
  font: PixelFont
  portraits: Partial<Record<CrewId, HTMLImageElement>>
  pip: StripImage | null
  weaponIcons: StripImage | null
  arrow: HTMLImageElement | null
}

const BASE = 'assets/'

let current: UiAssets = {
  font: fallbackFont(),
  portraits: {},
  pip: null,
  weaponIcons: null,
  arrow: null,
}
let loading: Promise<UiAssets> | null = null

export function uiAssets(): UiAssets {
  return current
}

export function loadUiAssets(): Promise<UiAssets> {
  if (!loading) loading = load()
  return loading
}

async function load(): Promise<UiAssets> {
  let manifest: Partial<AssetManifest> | null = null
  try {
    const res = await fetch(`${BASE}manifest.json`)
    if (res.ok) manifest = (await res.json()) as Partial<AssetManifest>
  } catch {
    manifest = null
  }
  const ui = manifest?.ui
  const crews = manifest?.crews
  const [fontImg, pip, icons, arrow, ...portraits] = await Promise.all([
    ui?.font?.file ? image(ui.font.file) : Promise.resolve(null),
    strip(ui?.pip),
    strip(ui?.weaponIcons),
    ui?.arrow ? image(ui.arrow) : Promise.resolve(null),
    ...CREWS.map((crew) => (crews?.[crew]?.portrait ? image(crews[crew].portrait) : Promise.resolve(null))),
  ])
  let font = current.font
  if (fontImg && ui?.font) {
    try {
      font = fontFromImage(fontImg, ui.font.glyphW, ui.font.glyphH, ui.font.chars) ?? font
    } catch {
      // canvas contaminado o tira inválida: queda la de respaldo
    }
  }
  const map: Partial<Record<CrewId, HTMLImageElement>> = {}
  CREWS.forEach((crew, i) => {
    const img = portraits[i] as HTMLImageElement | null
    if (img) map[crew] = img
  })
  current = { font, portraits: map, pip, weaponIcons: icons, arrow: arrow as HTMLImageElement | null }
  return current
}

async function strip(def: Strip | undefined): Promise<StripImage | null> {
  if (!def?.file || !def.cell) return null
  const img = await image(def.file)
  if (!img) return null
  return { img, w: def.cell.w, h: def.cell.h, frames: def.frames ?? 1 }
}

function image(file: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null)
    img.onerror = () => resolve(null)
    img.src = `${BASE}${file}`
  })
}
