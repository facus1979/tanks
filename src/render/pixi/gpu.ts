// v3 (rendimiento): texturas de GPU que se llenan directo desde bytes RGBA en memoria, subiendo solo el
// rectángulo que cambió.
// Antes el buffer de efectos (808×458) pasaba por putImageData a un canvas y de ahí se subía entero a la GPU en
// cada frame con algo dibujado, y cada trozo del terreno (256 × alto del mundo) se subía entero cada vez que se
// repintaba un pedacito (cráter, flujo de agua o lava). Ahora:
//  - RasterSource: textura del tamaño de un Raster (efectos, luces).
//  - Una textura puede ser una ventana de un buffer más ancho (stride/baseX): los trozos del terreno suben
//    directo desde los bytes del mundo, sin canvas.
//  - El subidor registrado en GlTextureSystem sube solo el rectángulo pendiente (rx0..rx1, ry0..ry1, en pixels
//    de la textura, inclusive); sin rectángulo sube todo. En WebGL 2 usa UNPACK_ROW_LENGTH / SKIP_PIXELS; en
//    WebGL 1 copia las filas del rectángulo a un buffer temporal.
import { BufferImageSource, Texture, type Renderer } from 'pixi.js'
import type { Raster } from './raster'

const RECT_UPLOAD = 'rasterRect'

interface GlTex {
  width: number
  height: number
  target: number
  format: number
  type: number
  internalFormat: number
}

// Fuente con un rectángulo pendiente de subir. bytes es el buffer completo (stride pixels por fila) y la
// textura es la ventana [baseX, baseX + width) × [0, height).
export class RectSource extends BufferImageSource {
  rx0 = 0
  ry0 = 0
  rx1 = -1
  ry1 = -1
  constructor(
    readonly bytes: Uint8Array,
    readonly stride: number,
    readonly baseX: number,
    width: number,
    height: number,
    premultiplied: boolean,
  ) {
    super({
      // la ventana entera solo hace falta para el subidor de Pixi por defecto (antes de instalar el nuestro)
      resource: stride === width ? bytes : new Uint8Array(width * height * 4),
      width,
      height,
      format: 'rgba8unorm',
      // el buffer de efectos guarda el color ya premultiplicado (Raster.premul): premultiplicar al subir costaba
      // más que la subida en sí (~6% del CPU en el celular emulado durante la nuke)
      alphaMode: premultiplied ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload',
      scaleMode: 'nearest',
      autoGenerateMipmaps: false,
    })
    if (rectReady) this.uploadMethodId = RECT_UPLOAD
  }

  // Suma un rectángulo (pixels de la textura, inclusive) a lo pendiente.
  addRect(x0: number, y0: number, x1: number, y1: number): void {
    x0 = Math.max(0, x0)
    y0 = Math.max(0, y0)
    x1 = Math.min(this.width - 1, x1)
    y1 = Math.min(this.height - 1, y1)
    if (x1 < x0 || y1 < y0) return
    if (this.rx1 < this.rx0) {
      this.rx0 = x0
      this.ry0 = y0
      this.rx1 = x1
      this.ry1 = y1
      return
    }
    this.rx0 = Math.min(this.rx0, x0)
    this.ry0 = Math.min(this.ry0, y0)
    this.rx1 = Math.max(this.rx1, x1)
    this.ry1 = Math.max(this.ry1, y1)
  }

  get pending(): boolean {
    return this.rx1 >= this.rx0
  }
}

// Compatibilidad con el nombre de la primera versión.
export type RasterSource = RectSource

let scratch = new Uint8Array(0)

const rectUploader = {
  id: RECT_UPLOAD,
  upload(source: RectSource, glTexture: GlTex, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    const W = source.width
    const H = source.height
    const target = glTexture.target
    if (glTexture.width !== W || glTexture.height !== H) {
      gl.texImage2D(target, 0, glTexture.internalFormat, W, H, 0, glTexture.format, glTexture.type, null)
      glTexture.width = W
      glTexture.height = H
      source.rx0 = 0
      source.ry0 = 0
      source.rx1 = W - 1
      source.ry1 = H - 1
    } else if (!source.pending) {
      source.rx0 = 0
      source.ry0 = 0
      source.rx1 = W - 1
      source.ry1 = H - 1
    }
    const x0 = source.rx0
    const y0 = source.ry0
    const w = source.rx1 - x0 + 1
    const h = source.ry1 - y0 + 1
    source.rx1 = -1 // subido: no queda nada pendiente
    source.ry1 = -1
    const S = source.stride
    const data = source.bytes
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, S)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, source.baseX + x0)
      gl.texSubImage2D(target, 0, x0, y0, w, h, glTexture.format, glTexture.type, data, y0 * S * 4)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
      return
    }
    // WebGL 1: filas del rectángulo a un buffer contiguo
    const n = w * h * 4
    if (scratch.length < n) scratch = new Uint8Array(n)
    const out = scratch.subarray(0, n)
    for (let y = 0; y < h; y++) {
      const from = ((y0 + y) * S + source.baseX + x0) * 4
      out.set(data.subarray(from, from + w * 4), y * w * 4)
    }
    gl.texSubImage2D(target, 0, x0, y0, w, h, glTexture.format, glTexture.type, out)
  },
}

let rectReady = false

// Registra el subidor en el renderer (WebGL). Con WebGPU no hace nada y las fuentes suben enteras.
// Hay que llamarla antes de crear las texturas (las de antes siguen con el subidor de Pixi).
export function installRasterUpload(renderer: Renderer): void {
  const sys = (renderer as unknown as { texture?: { _uploads?: Record<string, unknown> } }).texture
  if (sys?._uploads && !sys._uploads[RECT_UPLOAD]) sys._uploads[RECT_UPLOAD] = rectUploader
  rectReady = !!sys?._uploads
}

// ¿Se puede subir por rectángulos (y por lo tanto usar ventanas de un buffer más ancho)?
export function rectUploadReady(): boolean {
  return rectReady
}

export function rasterTexture(r: Raster): Texture<RectSource> {
  return new Texture({ source: new RectSource(r.bytes, r.w, 0, r.w, r.h, r.premul) })
}

// Textura que es la ventana [x0, x0 + w) × [0, h) de un buffer RGBA de stride pixels por fila (sin premultiplicar).
// Requiere el subidor instalado (rectUploadReady()).
export function windowTexture(bytes: Uint8Array, stride: number, x0: number, w: number, h: number): Texture<RectSource> {
  return new Texture({ source: new RectSource(bytes, stride, x0, w, h, false) })
}

// Sube la parte de la textura entre (x0, y0) y (x1, y1) inclusive (o toda sin el subidor instalado).
export function uploadRect(t: Texture<RectSource>, x0: number, y0: number, x1: number, y1: number): void {
  const s = t.source
  // la textura de efectos se crea antes que el renderer: se pasa al subidor por rectángulos en el primer uso
  if (rectReady) s.uploadMethodId = RECT_UPLOAD
  if (rectReady) {
    s.addRect(x0, y0, x1, y1)
    if (!s.pending) return
  }
  s.update()
}

// Textura fija hecha con un Raster (sube todo una vez).
export function bufferTexture(r: Raster): Texture {
  return rasterTexture(r)
}
