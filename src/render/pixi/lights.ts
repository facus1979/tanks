// v3 (rendimiento): luces de los efectos como sprites aditivos en la GPU.
// Antes cada luz sumaba su caída pixel por pixel en un buffer de CPU del tamaño de la pantalla (Raster.light),
// que después se subía entero a una textura: era lo más caro del frame en el celular (~16-18% del CPU con
// explosiones). Ahora cada luz es un sprite con una textura blanca de la caída ya cuantizada y dithereada
// (hecha una vez con el mismo Raster.light), teñida con `tint` y con alfa `k`: en mezcla aditiva el resultado
// es el mismo (tint · k · f por pixel, saturado en la pantalla) salvo redondeos de 1/255.
// La trama de Bayer depende de dónde cae el centro respecto de la grilla de 4×4 del buffer: para radios chicos
// hay una textura por fase (16), como los focos; para radios grandes se usa una sola fase (la trama queda
// corrida, no se nota en una luz grande) y el radio se redondea a pasos de 4 u 8 px para no rehacer texturas
// cuando la cámara hace zoom.
import { Container, Sprite, type Texture } from 'pixi.js'
import { bufferTexture } from './gpu'
import { Raster } from './raster'

const PHASED_R = 64 // hasta este radio (pixels del buffer) la textura respeta la fase de la trama
const BUDGET_PX = 3_000_000 // pixels de textura en caché (~12 MB de GPU); se desalojan las menos usadas

interface LightTex {
  tex: Texture
  px: number // corrimiento del centro dentro de la textura (fase en x e y)
  py: number
  R: number // radio con que se hizo la textura
  area: number
  used: number // último frame en que se usó
}

// Misma API que Raster para las luces (setView, clear, light, dirty), así el código de efectos no cambia:
// fx.light.light(x, y, R, tint, k) sigue andando.
export class LightLayer {
  readonly root = new Container()
  ox = 0
  oy = 0
  z = 1
  private sprites: Sprite[] = []
  private used = 0
  private frame = 0
  private cache = new Map<string, LightTex>()
  private cached = 0 // pixels en caché
  made = 0 // texturas hechas (contador de QA)

  constructor(
    readonly w: number,
    readonly h: number,
  ) {}

  setView(ox: number, oy: number, z: number): void {
    this.ox = ox
    this.oy = oy
    this.z = z
  }

  get dirty(): boolean {
    return this.used > 0
  }

  // Empieza un frame: las luces del frame anterior se apagan.
  clear(): void {
    this.used = 0
    this.frame++
  }

  // Igual que Raster.light (coordenadas de mundo, radio en pixels de mundo).
  light(cx: number, cy: number, R: number, tint: number, k: number): void {
    if (k <= 0 || R <= 0) return
    cx = Math.round((cx - this.ox) * this.z)
    cy = Math.round((cy - this.oy) * this.z)
    R = Math.round(R * this.z)
    if (R <= 0) return
    // fuera del buffer: no se ve (el buffer ya cubre la pantalla con margen)
    if (cx + R <= 0 || cy + R <= 0 || cx - R >= this.w || cy - R >= this.h) return
    let px = 0
    let py = 0
    if (R <= PHASED_R) {
      px = (cx - R) & 3
      py = (cy - R) & 3
    } else {
      const step = R > 200 ? 8 : 4
      R = Math.round(R / step) * step
    }
    const t = this.texture(R, px, py)
    let s = this.sprites[this.used]
    if (!s) {
      s = new Sprite(t.tex)
      s.blendMode = 'add'
      this.sprites.push(s)
      this.root.addChild(s)
    } else s.texture = t.tex
    this.used++
    s.visible = true
    s.position.set(cx - R - px, cy - R - py)
    s.tint = tint
    s.alpha = Math.min(1, k)
  }

  // Termina el frame: esconde los sprites que sobran y desaloja texturas viejas si la caché se pasó.
  finish(): void {
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].visible = false
    if (this.cached <= BUDGET_PX) return
    const old = [...this.cache].filter(([, e]) => e.used < this.frame).sort((a, b) => a[1].used - b[1].used)
    for (const [key, e] of old) {
      if (this.cached <= BUDGET_PX * 0.7) break
      e.tex.destroy(true)
      this.cache.delete(key)
      this.cached -= e.area
    }
  }

  private texture(R: number, px: number, py: number): LightTex {
    const key = `${R},${px},${py}`
    let e = this.cache.get(key)
    if (!e) {
      const side = 2 * R + 4
      const r = new Raster(side, side)
      r.light(R + px, R + py, R, 0xffffff, 1)
      e = { tex: bufferTexture(r), px, py, R, area: side * side, used: 0 }
      this.cache.set(key, e)
      this.cached += e.area
      this.made++
    }
    e.used = this.frame
    return e
  }

  reset(): void {
    this.clear()
    this.finish()
  }
}
