// v3 (rendimiento): texturas de GPU que se llenan directo desde los bytes de un Raster, subiendo solo el
// rectángulo que cambió.
// Antes el buffer de efectos (808×458) pasaba por putImageData a un canvas y de ahí se subía entero a la GPU en
// cada frame con algo dibujado: en el celular emulado eran ~10-15% del CPU entre las dos cosas. Subir los bytes
// enteros con texSubImage2D tampoco alcanza (es 1,5 MB por frame con premultiplicado); con el rectángulo sucio
// (la caja de lo que se pintó este frame unida a la del anterior, que hay que borrar) se sube una fracción.
import { BufferImageSource, Texture, type Renderer } from 'pixi.js'
import type { Raster } from './raster'

const RECT_UPLOAD = 'rasterRect'

// Fuente con un rectángulo pendiente de subir (pixels, inclusive). Sin rectángulo sube todo.
export class RasterSource extends BufferImageSource {
  rx0 = 0
  ry0 = 0
  rx1 = -1
  ry1 = -1
  constructor(readonly raster: Raster) {
    super({
      resource: raster.bytes,
      width: raster.w,
      height: raster.h,
      format: 'rgba8unorm',
      // el buffer de efectos guarda el color ya premultiplicado (Raster.premul): premultiplicar al subir
      // costaba más que la subida en sí (~6% del CPU en el celular emulado durante la nuke)
      alphaMode: raster.premul ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload',
      scaleMode: 'nearest',
      autoGenerateMipmaps: false,
    })
  }
}

// Subidor para GlTextureSystem: la primera vez reserva la textura entera; después, texSubImage2D del rectángulo.
// En WebGL 2 recorta filas y columnas (UNPACK_ROW_LENGTH / SKIP); en WebGL 1, solo las filas.
const rectUploader = {
  id: RECT_UPLOAD,
  upload(source: RasterSource, glTexture: { width: number; height: number; target: number; format: number; type: number; internalFormat: number }, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    const W = source.width
    const H = source.height
    const target = glTexture.target
    if (glTexture.width !== W || glTexture.height !== H || source.rx1 < source.rx0) {
      if (glTexture.width === W && glTexture.height === H) gl.texSubImage2D(target, 0, 0, 0, W, H, glTexture.format, glTexture.type, source.resource as Uint8Array)
      else gl.texImage2D(target, 0, glTexture.internalFormat, W, H, 0, glTexture.format, glTexture.type, source.resource as Uint8Array)
      glTexture.width = W
      glTexture.height = H
      return
    }
    const data = source.resource as Uint8Array
    const y0 = source.ry0
    const h = source.ry1 - source.ry0 + 1
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      const x0 = source.rx0
      const w = source.rx1 - source.rx0 + 1
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0)
      gl.texSubImage2D(target, 0, x0, y0, w, h, glTexture.format, glTexture.type, data, y0 * W * 4)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    } else {
      gl.texSubImage2D(target, 0, 0, y0, W, h, glTexture.format, glTexture.type, data.subarray(y0 * W * 4, (y0 + h) * W * 4))
    }
  },
}

// Registra el subidor en el renderer (WebGL). Con WebGPU no hace nada y RasterSource sube entera.
export function installRasterUpload(renderer: Renderer): void {
  const sys = (renderer as unknown as { texture?: { _uploads?: Record<string, unknown> } }).texture
  if (sys?._uploads && !sys._uploads[RECT_UPLOAD]) sys._uploads[RECT_UPLOAD] = rectUploader
  rectReady = !!sys?._uploads
}
let rectReady = false

export function rasterTexture(r: Raster): Texture<RasterSource> {
  return new Texture({ source: new RasterSource(r) })
}

// Sube a la GPU la parte de la textura entre (x0, y0) y (x1, y1) inclusive (o toda si no hay subidor de
// rectángulos instalado).
export function uploadRect(t: Texture<RasterSource>, x0: number, y0: number, x1: number, y1: number): void {
  const s = t.source
  if (rectReady) {
    s.uploadMethodId = RECT_UPLOAD
    s.rx0 = Math.max(0, x0)
    s.ry0 = Math.max(0, y0)
    s.rx1 = Math.min(s.width - 1, x1)
    s.ry1 = Math.min(s.height - 1, y1)
    if (s.rx1 < s.rx0 || s.ry1 < s.ry0) return
  }
  s.update()
}

// Textura fija hecha con un Raster (sube todo una vez).
export function bufferTexture(r: Raster): Texture {
  return new Texture({ source: new RasterSource(r) })
}
